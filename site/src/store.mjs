// 持久化对象库。记录类型：
//   root   单例 { _id:'root', rootId, gen }
//   page   { _id:'page:'+id, ...page }
//   intent { _id:'intent', batchId, gen, rootId, editDigest, pageIds, createdAt }
// 写顺序约束由 engine.mjs 保证：先新页 -> 再意图 -> 最后切根。
// 多连接并发由 transact(fn) 保证：意图落盘与根切换的条件判定与写入同事务原子完成
// （真实 IndexedDB 中同一 objectStore 的 readwrite 事务相互排他）。

export const STORE = 'kv';

export function openIDB(dbName = 'track-exchange') {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function reqP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IDBStore {
  constructor(db) { this.db = db; }
  static async open(dbName) { return new IDBStore(await openIDB(dbName)); }
  async get(key) { return reqP(tx(this.db, 'readonly').get(key)); }
  async put(key, value) { return reqP(tx(this.db, 'readwrite').put(value, key)); }
  // 同一事务内原子写入多条——根切换点必须单事务
  async putMany(entries) {
    await new Promise((resolve, reject) => {
      const t = this.db.transaction(STORE, 'readwrite');
      const s = t.objectStore(STORE);
      for (const [key, value] of entries) s.put(value, key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('事务中止'));
    });
  }
  async delete(key) { return reqP(tx(this.db, 'readwrite').delete(key)); }
  async allPageIds() {
    const all = await reqP(tx(this.db, 'readonly').getAllKeys());
    return all.filter((k) => typeof k === 'string' && k.startsWith('page:'));
  }
  // 单事务读-改-写：fn 收到绑定同一事务的 { get, put, delete }，
  // 其判定与写入随事务整体原子生效——并发连接的条件提交（CAS）赖此串行化。
  async transact(fn) {
    const t = this.db.transaction(STORE, 'readwrite');
    const s = t.objectStore(STORE);
    const api = {
      get: (k) => reqP(s.get(k)),
      put: (k, v) => reqP(s.put(v, k)),
      delete: (k) => reqP(s.delete(k)),
    };
    let result;
    try {
      result = await fn(api);
    } catch (e) {
      try { t.abort(); } catch { /* 事务可能已完结 */ }
      throw e;
    }
    await new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('事务中止'));
    });
    return result;
  }
  async close() { this.db.close(); }
}

export class MemoryStore {
  constructor(map = new Map()) { this.map = map; }
  async get(key) { return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined; }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
  async putMany(entries) {
    for (const [key, value] of entries) this.map.set(key, structuredClone(value));
  }
  async delete(key) { this.map.delete(key); }
  async allPageIds() { return [...this.map.keys()].filter((k) => k.startsWith('page:')); }
  // 单进程内无宏任务让渡，fn 的判定与写入天然不被其他连接交错
  async transact(fn) {
    return fn({
      get: (k) => this.get(k),
      put: (k, v) => this.put(k, v),
      delete: (k) => this.delete(k),
    });
  }
  async close() {}
  export() { return new Map([...this.map].map(([k, v]) => [k, structuredClone(v)])); }
}
