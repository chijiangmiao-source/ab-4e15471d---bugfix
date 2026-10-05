// 持久化对象库。记录类型：
//   root   单例 { _id:'root', rootId, gen }
//   page   { _id:'page:'+id, ...page }
//   intent { _id:'intent', batchId, gen, rootId, editDigest, pageIds, createdAt }
// 写顺序约束由 engine.mjs 保证：先新页 -> 再意图 -> 最后切根。

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
  async close() {}
  export() { return new Map([...this.map].map(([k, v]) => [k, structuredClone(v)])); }
}
