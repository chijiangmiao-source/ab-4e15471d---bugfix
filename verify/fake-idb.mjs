// 极简 IndexedDB 垫片：仅实现站点 IDBStore 用到的 API 面，
// 供 Node 下验证浏览器适配层与引擎的端到端协作（含单事务 putMany）。
// 非完整实现，不追求规范边角语义。
//
// 并发语义（与真实 IndexedDB 对齐，提交租约正确性依赖之）：
//   同一对象库上的事务按创建顺序 FIFO 串行执行、运行到完成，事务之间不交错；
//   一个事务内的请求在其“开始”后依次落盘，无在途请求且空闲一个 tick 后才发
//   complete，因此 get 的 onsuccess 里再 put 也仍在同一事务内原子生效。

const tick = () => new Promise((res) => setTimeout(res, 0));

class FakeObjectStore {
  constructor(map, tx) { this.map = map; this.tx = tx; }
  get(key) {
    return this.tx.request(() => (this.map.has(key) ? structuredClone(this.map.get(key)) : undefined));
  }
  put(value, key) {
    return this.tx.request(() => { this.map.set(key, structuredClone(value)); return key; });
  }
  delete(key) {
    return this.tx.request(() => { this.map.delete(key); return undefined; });
  }
  getAllKeys() {
    return this.tx.request(() => [...this.map.keys()]);
  }
}

class FakeTransaction {
  constructor(map, startGate, finishGate) {
    this.map = map;
    this._start = startGate;
    this._finish = finishGate; // { done() }
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._pending = 0;
    this._aborted = false;
    this._checkScheduled = false;
  }
  objectStore(_name) { return new FakeObjectStore(this.map, this); }

  // 在本事务开始后执行 work；事务中止则丢弃效果。pending 计数驱动 complete。
  request(work) {
    const r = { onsuccess: null, onerror: null, result: undefined, error: null };
    this._pending++;
    this._start
      .then(tick)
      .then(() => {
        if (this._aborted) return;
        try {
          r.result = work();
          r.onsuccess?.({ target: r });
        } catch (e) {
          r.error = e;
          r.onerror?.({ target: r });
        }
      })
      .then(() => {
        this._pending--;
        this._scheduleCompleteCheck();
      });
    return r;
  }

  _scheduleCompleteCheck() {
    if (this._checkScheduled) return;
    this._checkScheduled = true;
    tick().then(() => {
      this._checkScheduled = false;
      if (this._aborted) return;
      if (this._pending === 0) {
        this._aborted = true; // 终结，拒绝后续请求
        this.oncomplete?.({ target: this });
        this._finish.done();
      }
    });
  }

  // 真实 IDB：中止事务丢弃其全部写效果。垫片中请求效果即时作用于共享 map，
  // 这里的用例（租约 / 根 CAS）在 abort 前不产生任何 put，故无需回滚数据。
  abort() {
    if (this._aborted) return;
    this._aborted = true;
    this._pending = 0;
    tick().then(() => {
      this.onabort?.({ target: this });
      this._finish.done();
    });
  }
}

class FakeDB {
  constructor(maps) {
    this.maps = maps;
    this.objectStoreNames = { contains: (n) => maps.has(n) };
    // 每个对象库一条 FIFO 事务链：后建事务等前一事务 complete/abort 后才开始
    this._chains = new Map();
  }
  createObjectStore(name) { this.maps.set(name, new Map()); return {}; }
  transaction(storeNames) {
    const name = Array.isArray(storeNames) ? storeNames[0] : storeNames;
    let begin;
    const startGate = new Promise((res) => { begin = res; });
    let end;
    const finishGate = new Promise((res) => { end = res; });
    const prev = this._chains.get(name) ?? Promise.resolve();
    this._chains.set(name, prev.then(() => finishGate));
    prev.then(() => begin());
    return new FakeTransaction(this.maps.get(name), startGate, { done: end });
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
    deleteDatabase: (name) => {
      const r = { onsuccess: null, onerror: null, result: undefined, error: null };
      tick().then(() => { databases.delete(name); r.onsuccess?.({ target: r }); });
      return r;
    },
  };
  globalThis.indexedDB = factory;
  return factory;
}
