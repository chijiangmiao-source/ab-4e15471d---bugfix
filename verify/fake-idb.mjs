// 极简 IndexedDB 垫片：仅实现站点 IDBStore 用到的 API 面，
// 供 Node 下验证浏览器适配层与引擎的端到端协作（含单事务 putMany 与条件事务）。
// 非完整实现，不追求规范边角语义；但同一数据库同时只激活一个事务，
// 与真实 IndexedDB 中 readwrite 事务相互排他的串行语义一致——
// “读-改-写”条件事务（并发提交 CAS）因此具备与浏览器一致的原子性。

const tick = () => new Promise((res) => setTimeout(res, 0));

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

class FakeObjectStore {
  constructor(tx) { this.tx = tx; }
  get(key) {
    return this.tx._enqueue(() => {
      const v = this.tx.map.get(key);
      return v === undefined ? undefined : structuredClone(v);
    });
  }
  put(value, key) {
    return this.tx._enqueue(() => { this.tx.map.set(key, structuredClone(value)); return key; });
  }
  delete(key) {
    return this.tx._enqueue(() => { this.tx.map.delete(key); return undefined; });
  }
  getAllKeys() {
    return this.tx._enqueue(() => [...this.tx.map.keys()]);
  }
}

// 事务：请求按排入顺序逐个执行（各占 1 tick）；全部完成且微任务续体中
// 无新请求排入时事务完结（对应真实 IDB 的自动提交），随后激活下一个排队事务。
class FakeTransaction {
  constructor(db, map) {
    this.db = db;
    this.map = map;
    this.queue = [];
    this.pending = 0;
    this.active = false;
    this.finished = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
  }
  objectStore(_name) { return new FakeObjectStore(this); }
  _enqueue(work) {
    const r = { onsuccess: null, onerror: null, result: undefined, error: null };
    this.queue.push({ work, r });
    this.pending++;
    this._pump();
    return r;
  }
  _pump() {
    if (!this.active || this.finished || this._running) return;
    const item = this.queue.shift();
    if (!item) { this._settle(); return; }
    this._running = true;
    tick().then(() => {
      this._running = false;
      try {
        item.r.result = item.work();
        item.r.onsuccess?.({ target: item.r });
      } catch (e) {
        item.r.error = e;
        this.error = this.error ?? e;
        item.r.onerror?.({ target: item.r });
      }
      this.pending--;
      this._pump();
      this._settle();
    });
  }
  // 无在途请求时，待微任务续体（可能排入后续请求）全部 drain 后，在下一 tick 判定完结——
  // 与真实 IDB 一致：complete 以任务形式派发，调用方总能先注册 oncomplete。
  _settle() {
    if (this.finished || this.pending > 0 || this.queue.length > 0) return;
    tick().then(() => {
      if (this.finished || this.pending > 0 || this.queue.length > 0) return;
      this.finished = true;
      if (this.error) this.onabort?.({ target: this });
      else this.oncomplete?.({ target: this });
      this.db._release(this);
    });
  }
  abort() {
    if (this.finished) return;
    this.finished = true;
    this.queue.length = 0;
    this.onabort?.({ target: this });
    this.db._release(this);
  }
}

class FakeDB {
  constructor(maps) {
    this.maps = maps;
    this.objectStoreNames = { contains: (n) => maps.has(n) };
    this._txQueue = [];
    this._activeTx = null;
  }
  createObjectStore(name) { this.maps.set(name, new Map()); return {}; }
  transaction(storeNames) {
    const name = Array.isArray(storeNames) ? storeNames[0] : storeNames;
    const tx = new FakeTransaction(this, this.maps.get(name));
    this._txQueue.push(tx);
    this._pumpTx();
    return tx;
  }
  _pumpTx() {
    if (this._activeTx || !this._txQueue.length) return;
    this._activeTx = this._txQueue.shift();
    this._activeTx.active = true;
    this._activeTx._pump();
  }
  _release(tx) {
    if (this._activeTx === tx) {
      this._activeTx = null;
      this._pumpTx();
    }
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
