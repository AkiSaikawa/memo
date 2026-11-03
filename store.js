'use strict';

// 保存先は GitHub の非公開リポジトリ。IndexedDB は、読み込んだメモの控えと、まだ送れていない変更を置く場所。

const idb = (() => {
  let opening;
  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const req = indexedDB.open('memo-app', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return opening;
  }
  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  return {
    get: key => run('readonly', s => s.get(key)),
    set: (key, value) => run('readwrite', s => s.put(value, key)),
    del: key => run('readwrite', s => s.delete(key)),
    keys: prefix => run('readonly', s => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿'))),
    async destroy() {
      if (opening) (await opening.catch(() => null))?.close();
      opening = null;
      await new Promise(resolve => {
        const req = indexedDB.deleteDatabase('memo-app');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    },
  };
})();

class GitHubStore {
  constructor({ owner, repo, token }) {
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.id = `gh:${owner}/${repo}`;
    this.shas = new Map();       // path -> 最後に見たファイルの sha(上書き時に必要)
    this.queue = Promise.resolve(); // 書き込みは 1 本ずつ順番に送る
    this.onUnauthorized = null;     // 鍵が無効になったときに呼ぶ
  }

  static headers(token, accept = 'application/vnd.github+json') {
    return { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  }

  static async check({ owner, repo, token }) {
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers: GitHubStore.headers(token), cache: 'no-store' });
    if (res.status === 401) throw new Error('鍵が正しくないか、期限が切れています。');
    if (res.status === 404) throw new Error('リポジトリが見つかりません。名前と、鍵に付けた権限を確かめてください。');
    if (!res.ok) throw await httpError(res);
    const info = await res.json();
    if (info.permissions && !info.permissions.push) throw new Error('この鍵には書き込みの権限がありません(Contents を Read and write に)。');
  }

  url(path) {
    const p = path.split('/').map(encodeURIComponent).join('/');
    return `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${p}`;
  }

  async request(path, { method = 'GET', body, accept } = {}) {
    const res = await fetch(this.url(path), { method, body, headers: GitHubStore.headers(this.token, accept), cache: 'no-store' });
    if (res.status === 401) this.onUnauthorized?.();
    return res;
  }

  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async readJSON(path) {
    const res = await this.request(path);
    if (res.status === 404) { this.shas.delete(path); return null; }
    if (!res.ok) throw await httpError(res);
    const meta = await res.json();
    let text;
    if (meta.encoding === 'base64' && meta.content) {
      text = b64ToText(meta.content);
    } else {
      // 1MB を超えるファイルは中身が付いてこないので、生データで取り直す
      const raw = await this.request(path, { accept: 'application/vnd.github.raw' });
      if (!raw.ok) throw await httpError(raw);
      text = await raw.text();
    }
    this.shas.set(path, meta.sha);
    return { data: JSON.parse(text), sha: meta.sha };
  }

  writeJSON(path, data, message) {
    return this.serial(() => this.put(path, textToB64(JSON.stringify(data, null, 1)), message || `update ${path}`));
  }

  async putBlob(path, blob, message) {
    const content = await blobToB64(blob);
    for (let i = 0; ; i++) {
      try {
        return await this.serial(() => this.put(path, content, message || `add ${path}`));
      } catch (e) {
        if (!e.conflict || i >= 2) throw e;
      }
    }
  }

  async put(path, content, message) {
    const body = { message, content };
    const sha = this.shas.get(path);
    if (sha) body.sha = sha;
    const res = await this.request(path, { method: 'PUT', body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) {
      const e = await httpError(res);
      e.conflict = true;
      throw e;
    }
    if (!res.ok) throw await httpError(res);
    const json = await res.json();
    this.shas.set(path, json.content.sha);
  }

  async list(dir) {
    const res = await this.request(dir);
    if (res.status === 404) return [];
    if (!res.ok) throw await httpError(res);
    const json = await res.json();
    return Array.isArray(json) ? json.map(item => item.name) : [];
  }

  async getBlob(path) {
    const res = await this.request(path, { accept: 'application/vnd.github.raw' });
    if (!res.ok) throw await httpError(res);
    return res.blob();
  }
}

async function httpError(res) {
  let detail = '';
  try { detail = (await res.json()).message || ''; } catch { /* 本文なし */ }
  const e = new Error(`GitHub ${res.status}${detail ? ': ' + detail : ''}`);
  e.status = res.status;
  return e;
}

function textToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64ToText(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
