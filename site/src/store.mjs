// 持久化对象库。记录类型：
//   root   单例 { _id:'root', rootId, gen }
//   page   { _id:'page:'+id, ...page }
//   intent { _id:'intent', batchId, gen, rootId, editDigest, pageIds, createdAt }
//   commit-lock 单例提交租约 { holder, ts }：跨连接串行化“切根 + 回执”临界区
// 写顺序约束由 engine.mjs 保证：先新页 -> 再意图 -> 最后在租约内条件切根。
//
// 并发正确性依赖两个原语：
//   acquireCommitLease / releaseCommitLease —— 持久化互斥租约（带 TTL，崩溃可恢复）；
//   commitRootIf(expected, entries) —— 单事务“仅当根指针仍是期望基准时才写入”，
//   相当于对根指针的比较并交换（CAS），杜绝两个连接各自基于同一旧根双双提交。

export const STORE = 'kv';
export const K_COMMIT_LOCK = 'commit-lock';

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

  // 取得提交租约：无锁、自己已持有、或他连接租约已过期（崩溃残留）时成功。
  // 失败返回 { ok:false, code:'lease-held', holder }，调用方应重读根后重试或放弃。
  async acquireCommitLease(holder, ttlMs, nowMs) {
    return await new Promise((resolve, reject) => {
      const t = this.db.transaction(STORE, 'readwrite');
      const s = t.objectStore(STORE);
      const gr = s.get(K_COMMIT_LOCK);
      let heldBy = null;
      gr.onsuccess = () => {
        const cur = gr.result;
        if (cur && cur.holder !== holder && nowMs - Number(cur.ts) < ttlMs) {
          heldBy = cur.holder;
          t.abort(); // 不写入，事务整体回滚
          return;
        }
        s.put({ holder, ts: nowMs }, K_COMMIT_LOCK);
      };
      gr.onerror = () => { heldBy = null; t.abort(); };
      t.oncomplete = () => resolve({ ok: true });
      t.onabort = () => {
        if (heldBy != null) resolve({ ok: false, code: 'lease-held', holder: heldBy });
        else reject(t.error || new Error('租约事务中止'));
      };
      t.onerror = () => reject(t.error);
    });
  }

  // 仅当租约确属本批次时释放（绝不误清他连接的租约）
  async releaseCommitLease(holder) {
    await new Promise((resolve) => {
      const t = this.db.transaction(STORE, 'readwrite');
      const s = t.objectStore(STORE);
      const gr = s.get(K_COMMIT_LOCK);
      gr.onsuccess = () => {
        if (gr.result && gr.result.holder === holder) s.delete(K_COMMIT_LOCK);
      };
      // 释放是尽力而为：任何异常都不影响已完成的提交结论
      t.oncomplete = () => resolve();
      t.onabort = () => resolve();
      t.onerror = () => resolve();
    });
  }

  // 单事务 CAS：仅当持久化根指针仍是 expected（{ rootId, gen }，gen=0 表示空库）
  // 时才原子写入 entries（根记录 + 提交回执）；否则整体回滚并返回当前根。
  async commitRootIf(expected, entries) {
    return await new Promise((resolve, reject) => {
      const t = this.db.transaction(STORE, 'readwrite');
      const s = t.objectStore(STORE);
      const gr = s.get('root');
      let decided = false; // 已判定基准不匹配（current 可能合法为 null）
      let current = null;
      gr.onsuccess = () => {
        const cur = gr.result;
        const matches = expected.gen === 0
          ? cur == null
          : cur != null && cur.rootId === expected.rootId && cur.gen === expected.gen;
        if (!matches) {
          decided = true;
          current = cur ?? null;
          t.abort();
          return;
        }
        for (const [key, value] of entries) s.put(value, key);
      };
      gr.onerror = () => t.abort();
      t.oncomplete = () => resolve({ ok: true });
      t.onabort = () => {
        if (decided) resolve({ ok: false, code: 'root-moved', current });
        else reject(t.error || new Error('根切换事务中止'));
      };
      t.onerror = () => reject(t.error);
    });
  }
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

  async acquireCommitLease(holder, ttlMs, nowMs) {
    const cur = this.map.get(K_COMMIT_LOCK);
    if (cur && cur.holder !== holder && nowMs - Number(cur.ts) < ttlMs) {
      return { ok: false, code: 'lease-held', holder: cur.holder };
    }
    this.map.set(K_COMMIT_LOCK, { holder, ts: nowMs });
    return { ok: true };
  }

  async releaseCommitLease(holder) {
    const cur = this.map.get(K_COMMIT_LOCK);
    if (cur && cur.holder === holder) this.map.delete(K_COMMIT_LOCK);
  }

  async commitRootIf(expected, entries) {
    const cur = this.map.get('root');
    const matches = expected.gen === 0
      ? cur == null
      : cur != null && cur.rootId === expected.rootId && cur.gen === expected.gen;
    if (!matches) return { ok: false, code: 'root-moved', current: cur ? structuredClone(cur) : null };
    for (const [key, value] of entries) this.map.set(key, structuredClone(value));
    return { ok: true };
  }
}
