// 极简 IndexedDB 垫片：仅实现站点 IDBStore 用到的 API 面，
// 供 Node 下验证浏览器适配层与引擎的端到端协作（含单事务 putMany）。
// 非完整实现，不追求规范边角语义。

const tick = () => new Promise((res) => setTimeout(res, 0));

class FakeObjectStore {
  constructor(map) { this.map = map; }
  get(key) {
    return makeRequest(() => (this.map.has(key) ? structuredClone(this.map.get(key)) : undefined));
  }
  put(value, key) {
    return makeRequest(() => { this.map.set(key, structuredClone(value)); return key; });
  }
  delete(key) {
    return makeRequest(() => { this.map.delete(key); return undefined; });
  }
  getAllKeys() {
    return makeRequest(() => [...this.map.keys()]);
  }
}

function makeRequest(work) {
  const r = { onsuccess: null, onerror: null, result: undefined, error: null };
  tick().then(() => {
    try {
      r.result = work();
      r.onsuccess?.({ target: r });
    } catch (e) {
      r.error = e;
      r.onerror?.({ target: r });
    }
  });
  return r;
}

class FakeTransaction {
  constructor(map) {
    this.map = map;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    // 真实 IDB 中 complete 事件在本事务全部请求完成后触发；
    // 请求在同 tick 内排入（各占 1 tick），双 tick 后再发 complete。
    tick().then(tick).then(() => this.oncomplete?.({ target: this }));
  }
  objectStore(_name) { return new FakeObjectStore(this.map); }
}

class FakeDB {
  constructor(maps) {
    this.maps = maps;
    this.objectStoreNames = { contains: (n) => maps.has(n) };
  }
  createObjectStore(name) { this.maps.set(name, new Map()); return {}; }
  transaction(storeNames) {
    const name = Array.isArray(storeNames) ? storeNames[0] : storeNames;
    return new FakeTransaction(this.maps.get(name));
  }
  close() {}
}

const databases = new Map();

function openRequest(name) {
  const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: undefined, error: null };
  tick().then(async () => {
    try {
      let db = databases.get(name);
      if (!db) {
        const maps = new Map([['kv', new Map()]]);
        db = new FakeDB(maps);
        databases.set(name, db);
        req.result = db;
        await tick();
        req.onupgradeneeded?.({ target: req });
      }
      req.result = db;
      await tick();
      req.onsuccess?.({ target: req });
    } catch (e) {
      req.error = e;
      req.onerror?.({ target: req, error: e });
    }
  });
  return req;
}

export function installFakeIndexedDB() {
  databases.clear();
  const factory = {
    open: (name) => openRequest(name),
    deleteDatabase: (name) => makeRequest(() => { databases.delete(name); return undefined; }),
  };
  globalThis.indexedDB = factory;
  return factory;
}
