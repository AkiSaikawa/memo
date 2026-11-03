'use strict';

// 保存の形(GitHub の非公開リポジトリの中):
//   channels.json                    … チャンネル一覧と並び順
//   messages/<チャンネル>/<年-月>.json … その月のメモ
//   images/<年>/<月>/<id>.webp        … 貼った画像(縮小済み)
// このプログラムは公開されるので、チャンネル名などの中身はここに書かない。

const DEFAULT_CHANNELS = [{ id: 'memo', emoji: '📝', name: 'メモ' }];
const DEFAULT_REPO = { owner: 'AkiSaikawa', repo: 'memo-data' };
const CHANNELS_PATH = 'channels.json';
const CONFIG_KEY = 'memo.config';
const IMAGE_MAX_SIDE = 1600;
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

const state = {
  store: null,
  persist: true,        // false: 共用 PC モード。メモの控えをブラウザに残さない
  channels: [],
  current: null,
  months: new Map(),    // path -> その月のメモ(削除済みも含む)
  monthList: new Map(), // チャンネル -> ['2026-11', '2026-10', ...] 新しい順
  loaded: new Map(),    // チャンネル -> 新しい方から何か月分読んだか
  ready: new Set(),
  dirty: new Set(),
  revs: new Map(),
  flushTimer: null,
  flushing: false,
  attachments: [],
  editing: null,
  sending: false,
  loadingOlder: false,
  stick: true,
  hideDone: localStorage.getItem('memo.hideDone') === '1',
};

const $ = sel => document.querySelector(sel);

// ---------- 小物 ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function pad(n) { return String(n).padStart(2, '0'); }
function monthOf(t) { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function dayOf(t) { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtTime(t) { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtDay(t) { const d = new Date(t); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${'日月火水木金土'[d.getDay()]})`; }
function fmtStamp(t) {
  const d = new Date(t);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}(${'日月火水木金土'[d.getDay()]}) ${fmtTime(t)}`;
}
function fmtSize(n) { return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`; }
function monthPath(ch, m) { return `messages/${ch}/${m}.json`; }
function channelOfPath(path) { return path.split('/')[1]; }
function channelById(id) { return state.channels.find(c => c.id === id); }
function el(tag, cls, text) { const e = document.createElement(tag); e.className = cls; if (text) e.textContent = text; return e; }
function cacheKey(path) { return `cache:${state.store.id}:${path}`; }
function pendingKey(path) { return `pending:${state.store.id}:${path}`; }
function imageKey(path) { return `img:${state.store.id}:${path}`; }
function cacheGet(key) { return state.persist ? idb.get(key) : Promise.resolve(undefined); }
function cacheSet(key, value) { if (state.persist) idb.set(key, value).catch(() => {}); }
function autosize(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, innerHeight * 0.4) + 'px'; }
function canHover() { return matchMedia('(hover: hover)').matches; }
function setStatus(sel, text, kind) {
  const s = $(sel);
  s.textContent = text;
  s.className = 'status' + (kind ? ' ' + kind : '');
}

// ---------- ログイン情報 ----------
// 「覚えておく」なら localStorage、そうでなければ sessionStorage(タブを閉じると消える)に置く。

function loadConfig() {
  for (const storage of [sessionStorage, localStorage]) {
    try {
      const cfg = JSON.parse(storage.getItem(CONFIG_KEY));
      if (cfg?.token) return { ...cfg, remember: storage === localStorage };
    } catch { /* 壊れていたら無視 */ }
  }
  return null;
}

function saveConfig({ owner, repo, token }, remember) {
  clearConfig();
  (remember ? localStorage : sessionStorage).setItem(CONFIG_KEY, JSON.stringify({ owner, repo, token }));
  localStorage.setItem('memo.repo', JSON.stringify({ owner, repo }));
}

function clearConfig() {
  localStorage.removeItem(CONFIG_KEY);
  sessionStorage.removeItem(CONFIG_KEY);
}

function backToLogin(message) {
  clearConfig();
  sessionStorage.setItem('memo.loginMessage', message || '');
  location.reload();
}

async function logout() {
  if (state.dirty.size && !confirm('まだ GitHub に送れていない変更があります。ログアウトすると、その変更は消えます。')) return;
  clearConfig();
  localStorage.removeItem('memo.last');
  await idb.destroy().catch(() => {});
  location.reload();
}

// ---------- データ ----------

function mergeMessages(a, b) {
  const byId = new Map();
  for (const m of [...a, ...b]) {
    const prev = byId.get(m.id);
    if (!prev || (m.updatedAt || 0) > (prev.updatedAt || 0)) byId.set(m.id, m);
  }
  return [...byId.values()].sort((x, y) => x.createdAt - y.createdAt);
}

function mergeMonth(path, messages) {
  state.months.set(path, mergeMessages(state.months.get(path) || [], messages || []));
}

function fileData(path) {
  return path === CHANNELS_PATH
    ? { version: 1, channels: state.channels }
    : { version: 1, messages: state.months.get(path) || [] };
}

function visibleMessages(ch) {
  const prefix = `messages/${ch}/`;
  let out = [];
  for (const [path, msgs] of state.months) if (path.startsWith(prefix)) out = out.concat(msgs);
  out = out.filter(m => !m.deleted).sort((a, b) => a.createdAt - b.createdAt);
  if (channelById(ch)?.todo && state.hideDone) out = out.filter(m => !m.done);
  return out;
}

function addMessage(ch, msg) {
  const month = monthOf(msg.createdAt);
  const path = monthPath(ch, month);
  state.months.set(path, [...(state.months.get(path) || []), msg]);
  const list = state.monthList.get(ch) || [];
  if (!list.includes(month)) {
    state.monthList.set(ch, [month, ...list].sort().reverse());
    state.loaded.set(ch, (state.loaded.get(ch) || 0) + 1);
  }
  markDirty(path);
}

function findMessage(id) {
  for (const [path, msgs] of state.months) {
    const i = msgs.findIndex(m => m.id === id);
    if (i >= 0) return { path, msgs, i };
  }
  return null;
}

function updateMessage(id, patch) {
  const found = findMessage(id);
  if (!found) return;
  const next = [...found.msgs];
  next[found.i] = { ...found.msgs[found.i], ...patch, updatedAt: Date.now() };
  state.months.set(found.path, next);
  markDirty(found.path);
}

// ---------- 保存(書いたらすぐ手元に控え、少し待ってまとめて送る) ----------

function markDirty(path) {
  state.dirty.add(path);
  state.revs.set(path, (state.revs.get(path) || 0) + 1);
  // 送れていない変更は、共用 PC モードでも消えないよう控えておく(送れたら消す)
  idb.set(pendingKey(path), fileData(path)).catch(console.error);
  cacheSet(cacheKey(path), fileData(path));
  setSync('pending');
  scheduleFlush(1200);
}

function scheduleFlush(ms) {
  clearTimeout(state.flushTimer);
  state.flushTimer = setTimeout(flush, ms);
}

async function flush() {
  if (state.flushing) return scheduleFlush(500);
  state.flushing = true;
  let failed = null;
  for (const path of [...state.dirty]) {
    state.dirty.delete(path);
    const rev = state.revs.get(path);
    try {
      await writeMerged(path);
      if (state.revs.get(path) === rev) await idb.del(pendingKey(path));
    } catch (e) {
      state.dirty.add(path);
      failed = e;
      break;
    }
  }
  state.flushing = false;
  if (failed) { setSync('error', failed); scheduleFlush(15000); }
  else if (state.dirty.size) scheduleFlush(300);
  else setSync('ok');
}

async function writeMerged(path) {
  for (let i = 0; i < 4; i++) {
    try {
      return await state.store.writeJSON(path, fileData(path), commitMessage(path));
    } catch (e) {
      if (!e.conflict) throw e;
      // 別の PC が先に書いていた。向こうの内容と合わせてから書き直す
      const r = await state.store.readJSON(path);
      if (r && path !== CHANNELS_PATH) {
        mergeMonth(path, r.data.messages);
        if (channelOfPath(path) === state.current) renderMessages();
      }
    }
  }
  throw new Error('保存がほかの変更とぶつかりました');
}

function commitMessage(path) {
  return path === CHANNELS_PATH ? 'チャンネルを更新' : `メモ: ${path.slice('messages/'.length, -'.json'.length)}`;
}

async function restorePending() {
  const prefix = `pending:${state.store.id}:`;
  for (const key of await idb.keys(prefix)) {
    const path = key.slice(prefix.length);
    const data = await idb.get(key);
    if (!data) continue;
    if (path === CHANNELS_PATH) state.channels = data.channels;
    else mergeMonth(path, data.messages);
    state.dirty.add(path);
  }
  if (state.dirty.size) { setSync('pending'); scheduleFlush(500); }
}

function setSync(kind, err) {
  const box = $('#sync-status');
  const text = { ok: '同期済み', pending: '保存中…', error: '未同期 — 自動でやり直します' }[kind];
  box.innerHTML = `<span class="dot ${kind}"></span>${text}`;
  box.title = err ? String(err.message || err) : '';
}

// ---------- 読み込み ----------

async function loadChannels() {
  const cached = await cacheGet(cacheKey(CHANNELS_PATH));
  if (cached) state.channels = cached.channels;
  try {
    const r = await state.store.readJSON(CHANNELS_PATH);
    if (r) {
      state.channels = r.data.channels;
      cacheSet(cacheKey(CHANNELS_PATH), r.data);
    } else if (!cached) {
      state.channels = DEFAULT_CHANNELS.map(c => ({ ...c }));
      markDirty(CHANNELS_PATH);
    }
  } catch (e) {
    setSync('error', e);
  }
  if (!state.channels.length) state.channels = DEFAULT_CHANNELS.map(c => ({ ...c }));
}

async function listMonths(ch, fromCache) {
  const key = cacheKey(`messages/${ch}/`);
  let names;
  if (fromCache) {
    names = await cacheGet(key);
    if (!names) return false;
  } else {
    names = await state.store.list(`messages/${ch}`);
    cacheSet(key, names);
  }
  const months = new Set(names.filter(n => /^\d{4}-\d{2}\.json$/.test(n)).map(n => n.slice(0, 7)));
  const prefix = `messages/${ch}/`;
  for (const path of state.months.keys()) if (path.startsWith(prefix)) months.add(path.slice(prefix.length, -5));
  state.monthList.set(ch, [...months].sort().reverse());
  return true;
}

async function loadMonth(ch, month, fromCache) {
  const path = monthPath(ch, month);
  if (fromCache) {
    const cached = await cacheGet(cacheKey(path));
    if (cached) mergeMonth(path, cached.messages);
    return;
  }
  const r = await state.store.readJSON(path);
  if (r) {
    mergeMonth(path, r.data.messages);
    cacheSet(cacheKey(path), fileData(path));
  }
}

async function loadInitial(ch, fromCache) {
  if (!(await listMonths(ch, fromCache))) return;
  const months = state.monthList.get(ch);
  let n = Math.min(Math.max(state.loaded.get(ch) || 0, 1), months.length);
  for (let i = 0; i < n; i++) await loadMonth(ch, months[i], fromCache);
  while (n < months.length && n < 4 && visibleMessages(ch).length < 30) await loadMonth(ch, months[n++], fromCache);
  state.loaded.set(ch, n);
}

async function loadOlder() {
  const ch = state.current;
  const months = state.monthList.get(ch) || [];
  const n = state.loaded.get(ch) || 0;
  if (state.loadingOlder || n >= months.length) return;
  state.loadingOlder = true;
  try {
    await loadMonth(ch, months[n], false);
    state.loaded.set(ch, n + 1);
  } catch (e) {
    setSync('error', e);
  }
  state.loadingOlder = false;
  if (state.current === ch) renderMessages({ keepScroll: true });
}

let lastRefresh = 0;
async function refresh() {
  if (document.hidden || Date.now() - lastRefresh < 10000) return;
  lastRefresh = Date.now();
  const ch = state.current;
  try {
    const r = await state.store.readJSON(CHANNELS_PATH);
    if (r && !state.dirty.has(CHANNELS_PATH)) {
      state.channels = r.data.channels;
      cacheSet(cacheKey(CHANNELS_PATH), r.data);
      renderChannels();
      renderHeader();
    }
    await listMonths(ch, false);
    const newest = state.monthList.get(ch)?.[0];
    if (newest) await loadMonth(ch, newest, false);
    if (state.current === ch) renderMessages();
    if (!state.dirty.size) setSync('ok');
  } catch (e) {
    setSync('error', e);
  }
}

// ---------- 画像 ----------

async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const toBlob = (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));
  let blob = await toBlob('image/webp', 0.82);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.85);
  // 元から小さい画像(GIF アニメなど)はそのまま使う
  if (scale === 1 && file.size <= blob.size && /^image\/(jpeg|webp|png|gif)$/.test(file.type)) blob = file;
  return { blob, w, h };
}

const imageUrls = new Map();
function imageURL(path) {
  if (!imageUrls.has(path)) {
    const p = (async () => {
      let blob = await cacheGet(imageKey(path));
      if (!blob) {
        blob = await state.store.getBlob(path);
        cacheSet(imageKey(path), blob);
      }
      return URL.createObjectURL(blob);
    })();
    p.catch(() => imageUrls.delete(path));
    imageUrls.set(path, p);
  }
  return imageUrls.get(path);
}

async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const img = await compressImage(f);
      state.attachments.push({ ...img, url: URL.createObjectURL(img.blob), original: f.size });
    } catch {
      alert(`画像を読み込めませんでした: ${f.name}`);
    }
  }
  renderAttachments();
  $('#input').focus();
}

function renderAttachments() {
  $('#attachments').innerHTML = state.attachments.map((a, i) =>
    `<div class="att"><img src="${a.url}" alt=""><button type="button" data-i="${i}" aria-label="外す">×</button>` +
    `<span class="size">${fmtSize(a.original)} → ${fmtSize(a.blob.size)}</span></div>`).join('');
}

function clearAttachments() {
  for (const a of state.attachments) URL.revokeObjectURL(a.url);
  state.attachments = [];
  renderAttachments();
}

// ---------- 本文の表示 ----------

function trimUrl(url) { return url.replace(/[)\]}.,;:!?、。」』）]+$/u, ''); }

function renderText(src) {
  const slots = [];
  const slot = html => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src.replace(/```(?:[\w+-]*\n)?([\s\S]*?)```\n?/g, (_, code) => slot(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => slot(`<code>${esc(code)}</code>`));
  s = s.replace(URL_RE, raw => {
    const url = trimUrl(raw);
    return slot(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`) + esc(raw.slice(url.length));
  });
  s = esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  const lines = s.split('\n');
  let out = '';
  lines.forEach((line, i) => {
    let html = line;
    let block = false;
    const h = line.match(/^(#{1,3}) (.*)$/);
    if (h) { html = `<span class="h${h[1].length}">${h[2]}</span>`; block = true; }
    else if (line.startsWith('&gt; ')) { html = `<span class="quote">${line.slice(5)}</span>`; block = true; }
    else if (/^[-*] /.test(line)) html = '• ' + line.slice(2);
    out += html + (i < lines.length - 1 && !block ? '\n' : '');
  });
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]);
}

function youTubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'music.youtube.com') {
      id = u.pathname === '/watch' ? u.searchParams.get('v') : u.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1];
    }
    return id && /^[\w-]{6,20}$/.test(id) ? id : null;
  } catch { return null; }
}

function xPostId(url) {
  try {
    const u = new URL(url);
    if (!/^(www\.|mobile\.)?(x|twitter)\.com$/.test(u.hostname)) return null;
    return u.pathname.match(/^\/[^/]+\/status\/(\d{1,25})/)?.[1] || null;
  } catch { return null; }
}

// X のポストは X 公式の埋め込みページを iframe で出す。
// X のスクリプトをこのページで動かすと鍵に手が届いてしまうので、別枠(iframe)に閉じ込める。
function xEmbed(id, url) {
  const box = el('div', 'xpost');
  const frame = document.createElement('iframe');
  frame.src = `https://platform.twitter.com/embed/Tweet.html?id=${id}&theme=dark&dnt=true&lang=ja`;
  frame.title = 'X のポスト';
  frame.loading = 'lazy';
  frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('scrolling', 'no');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  const link = el('a', 'xpost-link', 'X で開く ↗');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  box.append(frame, link);
  return box;
}

function appendEmbeds(body, text) {
  if (!text) return;
  const plain = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
  const seen = new Set();
  const box = el('div', 'embeds');
  for (const raw of plain.match(URL_RE) || []) {
    const url = trimUrl(raw);
    if (seen.has(url) || seen.size >= 4) continue;
    seen.add(url);
    const yt = youTubeId(url);
    if (yt) {
      const card = el('div', 'yt');
      card.dataset.yt = yt;
      card.innerHTML = `<img src="https://i.ytimg.com/vi/${yt}/hqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="play">▶</span>`;
      box.appendChild(card);
      continue;
    }
    const x = xPostId(url);
    if (x) box.appendChild(xEmbed(x, url));
  }
  if (box.children.length) body.appendChild(box);
}

// X の埋め込みが「この高さにして」と送ってくるので、その iframe の高さを合わせる
window.addEventListener('message', e => {
  if (e.origin !== 'https://platform.twitter.com') return;
  let data = e.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
  const embed = data?.['twttr.embed'];
  if (embed?.method !== 'twttr.private.resize') return;
  const height = Number(embed.params?.[0]?.height);
  if (!(height > 0 && height < 5000)) return;
  for (const frame of document.querySelectorAll('.xpost iframe')) {
    if (frame.contentWindow === e.source) frame.style.height = Math.ceil(height) + 'px';
  }
});

// ---------- 画面 ----------

function renderChannels() {
  $('#channel-list').innerHTML = state.channels.map(c =>
    `<a class="chan${c.id === state.current ? ' active' : ''}" href="#${esc(c.id)}" draggable="true" data-id="${esc(c.id)}">` +
    `<span class="chan-emoji">${esc(c.emoji || '#')}</span><span class="chan-name">${esc(c.name)}</span>` +
    '<button type="button" class="chan-edit" title="名前の変更・削除" aria-label="チャンネルを編集">⚙</button></a>').join('');
}

function renderHeader() {
  const c = channelById(state.current);
  if (!c) return;
  $('#chan-emoji').textContent = c.emoji || '#';
  $('#chan-name').textContent = c.name;
  document.title = `${c.name} - メモ`;
  $('#input').placeholder = `${c.emoji || '#'} ${c.name} にメモする`;
  const hide = $('#btn-hide-done');
  hide.hidden = !c.todo;
  hide.classList.toggle('on', state.hideDone);
  hide.textContent = state.hideDone ? '完了を表示' : '完了を隠す';
}

function defaultDesc(todo) {
  return todo ? 'やることを送って、終わったら ✅ を付けましょう。' : '思いついたことを、どんどん送ってください。';
}

function welcomeEl(c) {
  const box = el('div', 'welcome');
  box.innerHTML = `<div class="welcome-icon">${esc(c.emoji || '#')}</div><h2>${esc(c.name)}</h2>` +
    `<p>${esc(c.desc || defaultDesc(c.todo))}</p>`;
  return box;
}

function messageEl(m, c) {
  const box = el('div', 'msg' + (m.done ? ' done' : '') + (state.editing === m.id ? ' editing' : ''));
  box.dataset.id = m.id;
  let html = c.todo ? `<input type="checkbox" class="msg-check" aria-label="完了"${m.done ? ' checked' : ''}>` : '';
  html += `<div class="msg-body"><div class="msg-meta"><time>${fmtStamp(m.createdAt)}</time>` +
    (m.editedAt ? `<span class="edited" title="編集: ${fmtStamp(m.editedAt)}">(編集済)</span>` : '') + '</div>';
  if (state.editing === m.id) {
    html += `<div class="msg-edit"><textarea rows="1">${esc(m.text)}</textarea><div class="hint">Enter で保存 / Esc でやめる / 空にすると削除</div></div>`;
  } else if (m.text) {
    html += `<div class="msg-text">${renderText(m.text)}</div>`;
  }
  if (m.images?.length) {
    html += '<div class="msg-images">' + m.images.map(img =>
      `<img data-path="${esc(img.path)}"${img.w ? ` width="${Number(img.w)}" height="${Number(img.h)}"` : ''} alt="">`).join('') + '</div>';
  }
  html += '</div><div class="msg-actions"><button type="button" data-act="edit" title="編集">✎</button>' +
    '<button type="button" data-act="delete" class="del" title="削除">🗑</button></div>';
  box.innerHTML = html;
  if (state.editing !== m.id) appendEmbeds(box.querySelector('.msg-body'), m.text);
  box.querySelectorAll('img[data-path]').forEach(img => {
    imageURL(img.dataset.path).then(url => { img.src = url; }).catch(() => img.classList.add('broken'));
  });
  return box;
}

// 変わったメモだけ作り直す(再生中の動画や X の埋め込みを消さないため)
function renderMessages(opts = {}) {
  const c = channelById(state.current);
  if (!c) return;
  const scroller = $('#messages');
  const feed = $('#feed');
  const prevHeight = scroller.scrollHeight;
  const prevTop = scroller.scrollTop;
  const old = new Map([...feed.children].map(node => [node.dataset.key, node]));
  const want = [];
  const keep = (key, ver, make) => {
    const node = old.get(key);
    if (node && node.dataset.ver === ver) return want.push(node);
    const fresh = make();
    fresh.dataset.key = key;
    fresh.dataset.ver = ver;
    want.push(fresh);
  };

  const hasOlder = (state.loaded.get(c.id) || 0) < (state.monthList.get(c.id) || []).length;
  if (hasOlder) keep('older', '', () => el('button', 'older', '↑ 古いメモを読み込む'));
  else keep('welcome', `${c.emoji}|${c.name}|${c.desc || ''}|${c.todo ? 1 : 0}`, () => welcomeEl(c));

  let lastDay = '';
  for (const m of visibleMessages(c.id)) {
    const day = dayOf(m.createdAt);
    if (day !== lastDay) {
      keep('d' + day, '', () => el('div', 'day', fmtDay(m.createdAt)));
      lastDay = day;
    }
    keep('m' + m.id, `${m.updatedAt}|${state.editing === m.id ? 1 : 0}|${c.todo ? 1 : 0}`, () => messageEl(m, c));
  }

  let cur = feed.firstChild;
  for (const node of want) {
    if (node === cur) cur = cur.nextSibling;
    else feed.insertBefore(node, cur);
  }
  while (cur) { const next = cur.nextSibling; cur.remove(); cur = next; }

  if (opts.keepScroll) {
    scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
  } else if (opts.toBottom || state.stick) {
    scroller.scrollTop = scroller.scrollHeight;
    state.stick = true;
  }
}

async function openChannel(id) {
  const ch = channelById(id) ? id : state.channels[0]?.id;
  if (!ch) return;
  const switched = state.current !== ch;
  state.current = ch;
  if (switched) state.editing = null;
  localStorage.setItem('memo.last', ch);
  if (location.hash !== '#' + ch) history.replaceState(null, '', '#' + ch);
  document.body.classList.remove('side-open');
  renderChannels();
  renderHeader();
  if (switched) $('#feed').replaceChildren();
  renderMessages({ toBottom: true });
  if (canHover()) $('#input').focus();

  if (!state.ready.has(ch)) {
    await loadInitial(ch, true).catch(() => {});
    if (state.current === ch) renderMessages({ toBottom: switched });
  }
  try {
    await loadInitial(ch, false);
    state.ready.add(ch);
    if (!state.dirty.size) setSync('ok');
  } catch (e) {
    setSync('error', e);
  }
  if (state.current === ch) renderMessages({ toBottom: switched });
}

// ---------- 操作 ----------

async function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (state.sending || (!text && !state.attachments.length)) return;
  const ch = state.current;
  state.sending = true;
  $('#btn-send').disabled = true;
  try {
    const now = Date.now();
    const id = newId();
    const [y, mo] = monthOf(now).split('-');
    const images = [];
    for (const [i, a] of state.attachments.entries()) {
      const ext = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' }[a.blob.type] || 'img';
      const path = `images/${y}/${mo}/${id}-${i + 1}.${ext}`;
      await state.store.putBlob(path, a.blob, `画像: ${path.slice('images/'.length)}`);
      cacheSet(imageKey(path), a.blob);
      images.push({ path, w: a.w, h: a.h });
    }
    addMessage(ch, { id, text, images, createdAt: now, updatedAt: now });
    input.value = '';
    autosize(input);
    clearAttachments();
    if (state.current === ch) renderMessages({ toBottom: true });
  } catch (e) {
    alert(`送信できませんでした。\n${e.message}`);
  } finally {
    state.sending = false;
    $('#btn-send').disabled = false;
  }
}

function startEdit(id) {
  state.editing = id;
  renderMessages();
  const t = document.querySelector(`.msg[data-id="${CSS.escape(id)}"] .msg-edit textarea`);
  if (!t) return;
  autosize(t);
  t.focus();
  t.setSelectionRange(t.value.length, t.value.length);
}

function finishEdit(id, text) {
  const found = findMessage(id);
  state.editing = null;
  if (found && text !== null) {
    const m = found.msgs[found.i];
    const trimmed = text.trim();
    if (!trimmed && !m.images?.length) {
      if (confirm('このメモを削除しますか?')) updateMessage(id, { deleted: true, text: '', images: [] });
    } else if (trimmed !== m.text) {
      updateMessage(id, { text: trimmed, editedAt: Date.now() });
    }
  }
  renderMessages();
  $('#input').focus();
}

function deleteMessage(id) {
  if (!confirm('このメモを削除しますか?')) return;
  updateMessage(id, { deleted: true, text: '', images: [] });
  renderMessages();
}

let editingChannel = null;
function openChannelDialog(id) {
  const c = id ? channelById(id) : null;
  const f = $('#form-channel');
  editingChannel = id;
  $('#dlg-channel-title').textContent = c ? 'チャンネルを編集' : 'チャンネルを追加';
  f.emoji.value = c?.emoji || '💬';
  f.chname.value = c?.name || '';
  f.desc.value = c?.desc || '';
  f.desc.placeholder = defaultDesc(c?.todo);
  f.todo.checked = !!c?.todo;
  $('#btn-chan-delete').hidden = !c;
  $('#dlg-channel').showModal();
  f.chname.focus();
}

function openAccount() {
  $('#account-info').textContent =
    `${state.store.owner}/${state.store.repo} に保存しています。` +
    (state.persist ? '鍵はこのブラウザに覚えています。' : '共用 PC モードです(タブを閉じると鍵が消えます)。');
  $('#dlg-account').showModal();
}

function hasFiles(e) { return [...(e.dataTransfer?.types || [])].includes('Files'); }

function bindEvents() {
  const input = $('#input');
  const scroller = $('#messages');
  const feed = $('#feed');

  $('#composer').addEventListener('submit', e => { e.preventDefault(); send(); });
  input.addEventListener('input', () => autosize(input));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp' && !input.value) {
      const last = visibleMessages(state.current).at(-1);
      if (last) { e.preventDefault(); startEdit(last.id); }
    }
  });
  input.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    addFiles(files);
  });
  $('#file-input').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
  $('#attachments').addEventListener('click', e => {
    const i = e.target.closest('button')?.dataset.i;
    if (i === undefined) return;
    URL.revokeObjectURL(state.attachments[i].url);
    state.attachments.splice(Number(i), 1);
    renderAttachments();
  });

  scroller.addEventListener('scroll', () => {
    state.stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    if (scroller.scrollTop < 200) loadOlder();
  }, { passive: true });
  // 画像や埋め込みがあとから読み込まれて高さが変わっても、一番下を見ていたら一番下に留まる
  new ResizeObserver(() => { if (state.stick) scroller.scrollTop = scroller.scrollHeight; }).observe(feed);

  feed.addEventListener('click', e => {
    const t = e.target;
    const yt = t.closest('.yt');
    if (yt && !yt.querySelector('iframe')) {
      const frame = document.createElement('iframe');
      frame.src = `https://www.youtube-nocookie.com/embed/${yt.dataset.yt}?autoplay=1&rel=0`;
      frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      frame.allowFullscreen = true;
      yt.replaceChildren(frame);
      return;
    }
    if (t.matches('.msg-images img') && t.src) {
      $('#lightbox img').src = t.src;
      $('#lightbox').hidden = false;
      return;
    }
    if (t.closest('.older')) { loadOlder(); return; }
    const msg = t.closest('.msg');
    if (!msg) return;
    const id = msg.dataset.id;
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'edit') startEdit(id);
    else if (act === 'delete') deleteMessage(id);
    else if (t.matches('.msg-check')) { updateMessage(id, { done: t.checked }); renderMessages(); }
    else if (!canHover() && !t.closest('a, textarea, iframe, .xpost')) {
      feed.querySelectorAll('.msg.sel').forEach(x => { if (x !== msg) x.classList.remove('sel'); });
      msg.classList.toggle('sel');
    }
  });
  feed.addEventListener('keydown', e => {
    if (!e.target.matches('.msg-edit textarea')) return;
    const id = e.target.closest('.msg').dataset.id;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); finishEdit(id, e.target.value); }
    else if (e.key === 'Escape') { e.preventDefault(); finishEdit(id, null); }
  });
  feed.addEventListener('input', e => { if (e.target.matches('.msg-edit textarea')) autosize(e.target); });

  $('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#lightbox').hidden = true; });

  // 画像のドラッグ&ドロップ
  const main = $('#main');
  let depth = 0;
  main.addEventListener('dragenter', e => { if (!hasFiles(e)) return; depth++; $('#drop-overlay').hidden = false; });
  main.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; $('#drop-overlay').hidden = true; } });
  main.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  main.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('#drop-overlay').hidden = true;
    addFiles([...e.dataTransfer.files]);
  });

  // チャンネルの編集と並べ替え
  const nav = $('#channel-list');
  let dragId = null;
  nav.addEventListener('click', e => {
    const btn = e.target.closest('.chan-edit');
    if (!btn) return;
    e.preventDefault();
    openChannelDialog(btn.closest('.chan').dataset.id);
  });
  nav.addEventListener('contextmenu', e => {
    const a = e.target.closest('.chan');
    if (!a) return;
    e.preventDefault();
    openChannelDialog(a.dataset.id);
  });
  const clearMarks = () => nav.querySelectorAll('.drag-before, .drag-after').forEach(a => a.classList.remove('drag-before', 'drag-after'));
  nav.addEventListener('dragstart', e => {
    const a = e.target.closest('.chan');
    if (!a) return;
    dragId = a.dataset.id;
    a.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  nav.addEventListener('dragover', e => {
    const a = e.target.closest('.chan');
    if (!dragId || !a) return;
    e.preventDefault();
    clearMarks();
    const rect = a.getBoundingClientRect();
    a.classList.add(e.clientY > rect.top + rect.height / 2 ? 'drag-after' : 'drag-before');
  });
  nav.addEventListener('drop', e => {
    const a = e.target.closest('.chan');
    if (!dragId) return;
    e.preventDefault();
    if (a && a.dataset.id !== dragId) {
      const moving = channelById(dragId);
      const rest = state.channels.filter(c => c.id !== dragId);
      const at = rest.findIndex(c => c.id === a.dataset.id) + (a.classList.contains('drag-after') ? 1 : 0);
      rest.splice(at, 0, moving);
      state.channels = rest;
      markDirty(CHANNELS_PATH);
    }
    dragId = null;
    renderChannels();
  });
  nav.addEventListener('dragend', () => { dragId = null; renderChannels(); });

  // ヘッダー・サイドバー
  $('#btn-menu').addEventListener('click', () => document.body.classList.toggle('side-open'));
  $('#scrim').addEventListener('click', () => document.body.classList.remove('side-open'));
  $('#btn-hide-done').addEventListener('click', () => {
    state.hideDone = !state.hideDone;
    localStorage.setItem('memo.hideDone', state.hideDone ? '1' : '0');
    renderHeader();
    renderMessages();
  });
  $('#btn-chan-edit').addEventListener('click', () => openChannelDialog(state.current));
  $('#btn-add-channel').addEventListener('click', () => openChannelDialog(null));
  $('#btn-account').addEventListener('click', openAccount);
  $('#sync-status').addEventListener('click', openAccount);

  // チャンネルのダイアログ
  $('#form-channel').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    const name = f.chname.value.trim();
    if (!name) return;
    const data = { emoji: f.emoji.value.trim() || '#', name, desc: f.desc.value.trim(), todo: f.todo.checked };
    let target = editingChannel;
    if (target) {
      state.channels = state.channels.map(c => (c.id === target ? { ...c, ...data } : c));
    } else {
      target = 'c' + newId();
      state.channels = [...state.channels, { id: target, ...data }];
    }
    markDirty(CHANNELS_PATH);
    $('#dlg-channel').close();
    openChannel(target);
  });
  $('#btn-chan-cancel').addEventListener('click', () => $('#dlg-channel').close());
  $('#btn-chan-delete').addEventListener('click', () => {
    const c = channelById(editingChannel);
    if (!c || !confirm(`「${c.name}」チャンネルを削除しますか?\n(書いたメモのデータは保存先に残ります)`)) return;
    state.channels = state.channels.filter(x => x.id !== c.id);
    markDirty(CHANNELS_PATH);
    $('#dlg-channel').close();
    openChannel(state.current === c.id ? state.channels[0]?.id : state.current);
  });

  // 保存先・ログアウト
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-account-close').addEventListener('click', () => $('#dlg-account').close());

  // ダイアログの外側(暗いところ)をクリックしたら閉じる。中で押して外で離したときは閉じない
  for (const dlg of document.querySelectorAll('dialog')) {
    const outside = e => {
      const r = dlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let downOutside = false;
    dlg.addEventListener('pointerdown', e => { downOutside = e.target === dlg && outside(e); });
    dlg.addEventListener('click', e => { if (downOutside && e.target === dlg && outside(e)) dlg.close(); });
  }

  window.addEventListener('hashchange', () => openChannel(decodeURIComponent(location.hash.slice(1))));
}

// ---------- 起動 ----------

function showLogin() {
  const f = $('#form-login');
  let last = null;
  try { last = JSON.parse(localStorage.getItem('memo.repo')); } catch { /* なし */ }
  f.owner.value = last?.owner || DEFAULT_REPO.owner;
  f.repo.value = last?.repo || DEFAULT_REPO.repo;
  const message = sessionStorage.getItem('memo.loginMessage');
  sessionStorage.removeItem('memo.loginMessage');
  setStatus('#login-status', message || '', message ? 'err' : '');
  $('#login').hidden = false;
  f.token.focus();

  f.addEventListener('submit', async e => {
    e.preventDefault();
    const cfg = { owner: f.owner.value.trim(), repo: f.repo.value.trim(), token: f.token.value.trim() };
    if (!cfg.token) return setStatus('#login-status', '鍵を入れてください。', 'err');
    setStatus('#login-status', '確認しています…');
    try {
      await GitHubStore.check(cfg);
    } catch (err) {
      return setStatus('#login-status', err.message, 'err');
    }
    const remember = f.remember.checked;
    saveConfig(cfg, remember);
    f.token.value = '';
    startApp(new GitHubStore(cfg), remember);
  });
}

async function startApp(store, persist) {
  state.store = store;
  state.persist = persist;
  store.onUnauthorized = () => backToLogin('鍵が使えなくなっています(期限切れなど)。もう一度ログインしてください。');
  $('#login').hidden = true;
  $('#app').hidden = false;
  bindEvents();
  setSync('ok');
  await loadChannels();
  await restorePending();
  await openChannel(decodeURIComponent(location.hash.slice(1)) || localStorage.getItem('memo.last'));

  setInterval(refresh, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('online', () => scheduleFlush(300));
  window.addEventListener('beforeunload', e => {
    if (state.dirty.size) { e.preventDefault(); e.returnValue = ''; }
  });
}

const savedConfig = loadConfig();
if (savedConfig) startApp(new GitHubStore(savedConfig), savedConfig.remember);
else showLogin();
