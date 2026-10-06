// 并发批次回归：两个已打开连接在提交前都读取同一已发布根，随后并发提交
// 不同批次（A 插 10、B 插 20）。第三个连接重开核验回执与可恢复数据一致：
//   一、双提交成功：重开为健康完整根，10 与 20 都可查询（推进到第 3 代）；
//   二、竞争只允许一个提交：另一个必须是“待恢复 / 冲突 / 可重试”边界，
//      且重开健康；该批次随后可在新根上重试成功。
// 运行：node --test verify/concurrency.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from './fake-idb.mjs';
import { IDBStore } from '../site/src/store.mjs';
import { Engine } from '../site/src/engine.mjs';

installFakeIndexedDB();

let dbSeq = 0;
const newDbName = () => `track-conc-${++dbSeq}-${Date.now().toString(36)}`;

// 建立“键 1、2、3”的初始索引，返回已打开的连接 1 与保持打开的连接 2。
async function setupTwoConnections(dbName) {
  const store1 = await IDBStore.open(dbName);
  const e1 = new Engine(store1);
  const boot1 = await e1.open();
  assert.equal(boot1.conclusion, 'FRESH');
  await e1.initialize([[1, '一'], [2, '二'], [3, '三']]);

  // 第二个连接在并发提交前即打开，并读取同一已发布根（gen 1）
  const store2 = await IDBStore.open(dbName);
  const e2 = new Engine(store2);
  const boot2 = await e2.open();
  assert.equal(boot2.conclusion, 'INTACT');
  assert.equal(boot2.gen, 1);
  return { store1, e1, store2, e2 };
}

// 第三个连接：全新打开，执行重开复核并返回引擎与结论
async function reopenThird(dbName) {
  const store = await IDBStore.open(dbName);
  const engine = new Engine(store);
  const report = await engine.open();
  return { store, engine, report };
}

// 另一结果必须落在“待恢复 / 冲突 / 可重试”边界，绝不允许是伪装成功的 committed
function assertPendingConflictOrRetryable(r, label) {
  assert.ok(r, label + ' 应有回执');
  assert.notEqual(r.status, 'committed', label + ' 不得返回 committed');
  const ok =
    r.status === 'retryable' && ['LEASE_BUSY', 'ROOT_ADVANCED'].includes(r.code) ||
    r.status === 'rejected' && ['OTHER_BATCH_PENDING', 'CONFLICT_BATCH_CONTENT'].includes(r.code) ||
    r.status === 'interrupted';
  assert.ok(ok, `${label} 应是待恢复/冲突/可重试边界，实得 ${JSON.stringify(r)}`);
}

async function assertHealthyComplete(engine, report, expectedKeys) {
  assert.notEqual(report.conclusion, 'PUBLISHED_ROOT_UNHEALTHY',
    '重开不得得到不健康发布根：' + report.detail);
  const snap = engine.snapshot();
  assert.equal(snap.badReferences.length, 0, '子页引用必须全部闭合');
  assert.ok(snap.ordered, '叶序列必须严格有序');
  assert.ok(snap.allKeysOnce, '每键必须恰好出现一次');
  assert.deepEqual(snap.leafSequence.map((x) => x.key), expectedKeys);
  for (const k of expectedKeys) assert.notEqual(engine.lookup(k), null, `键 ${k} 必须可查询`);
}

test('并发两批次双提交成功：回执可重开核验为健康完整根，10 与 20 均可查询（推进到 gen 3）', async () => {
  const dbName = newDbName();
  const { store1, e1, store2, e2 } = await setupTwoConnections(dbName);

  // 两连接在提交前都只观察到 gen 1；现在实际并发执行两项插入
  const [rA, rB] = await Promise.all([
    e1.submitBatch([{ op: 'insert', key: 10, value: '十' }], 'batch-A'),
    e2.submitBatch([{ op: 'insert', key: 20, value: '二十' }], 'batch-B'),
  ]);

  const committed = [rA, rB].filter((r) => r.status === 'committed');
  assert.equal(committed.length, 2, '本场景两批次都应成功提交');
  const gens = committed.map((r) => r.gen).sort((a, b) => a - b);
  assert.deepEqual(gens, [2, 3], '两批顺序推进到第 2、3 代，而非都谎报 gen 2');
  assert.notEqual(rA.rootId, rB.rootId, '两代根标识应不同');

  // 第三个连接重开：恢复结论健康，叶序列含全部键且引用闭合
  const { engine: e3, report } = await reopenThird(dbName);
  assert.equal(report.conclusion, 'INTACT');
  assert.equal(report.gen, 3);
  await assertHealthyComplete(e3, report, [1, 2, 3, 10, 20]);

  // 两张提交回执都能在重开后回放，且不再改根
  const replayA = await e3.submitBatch([{ op: 'insert', key: 10, value: '十' }], 'batch-A');
  assert.equal(replayA.replayed, true);
  const replayB = await e3.submitBatch([{ op: 'insert', key: 20, value: '二十' }], 'batch-B');
  assert.equal(replayB.replayed, true);
  assert.equal(e3.snapshot().gen, 3, '回执回放不推进代次');

  store1.close(); store2.close();
});

test('竞争只允许一个提交：另一批次为可重试边界、根仍健康，重试后两键齐全', async () => {
  const dbName = newDbName();
  const { store1, e1, store2, e2 } = await setupTwoConnections(dbName);

  // 让连接 1 的新页落盘变慢，制造真实的持约重叠窗口；连接 2 等待窗口很短，
  // 在连接 1 完成前拿不到租约 -> 明确返回可重试，而不是谎报 committed。
  const slow = new SlowPageStore(store1, 30);
  const slowEngine = new Engine(slow, { leaseTtlMs: 60_000, leaseWaitMs: 25_000 });
  await slowEngine.open();

  const contender = new Engine(store2, { leaseTtlMs: 60_000, leaseWaitMs: 80 });
  const [rSlow, rContender] = await Promise.all([
    slowEngine.submitBatch([{ op: 'insert', key: 10, value: '十' }], 'batch-A'),
    contender.submitBatch([{ op: 'insert', key: 20, value: '二十' }], 'batch-B'),
  ]);

  const results = [rSlow, rContender];
  const committed = results.filter((r) => r.status === 'committed');
  const nonCommitted = results.filter((r) => r.status !== 'committed');
  assert.equal(committed.length, 1, '恰好一个批次提交');
  assert.equal(nonCommitted.length, 1, '另一个批次不得提交');
  assertPendingConflictOrRetryable(nonCommitted[0], '竞争失败批次');
  assert.equal(committed[0].gen, 2, '唯一成功批次推进到 gen 2');

  // 第三个连接重开：发布根健康、引用闭合，仅含已提交那一批的新键
  const { engine: e3, report } = await reopenThird(dbName);
  assert.equal(report.conclusion, 'INTACT');
  assert.equal(report.gen, 2);
  const committedKey = committed[0].batchId === 'batch-A' ? 10 : 20;
  const missingKey = committedKey === 10 ? 20 : 10;
  await assertHealthyComplete(e3, report, [1, 2, 3, committedKey]);
  assert.equal(e3.lookup(missingKey), null, '未提交批次的键不得出现');

  // 失败批次在新根上用同一批次标识重试 -> 成功并推进到 gen 3，两键齐全
  const retry = await e3.submitBatch(
    [{ op: 'insert', key: missingKey, value: missingKey === 10 ? '十' : '二十' }],
    nonCommitted[0].batchId,
  );
  assert.equal(retry.status, 'committed', '可重试边界上的批次重试应成功');
  assert.equal(retry.gen, 3);
  const { engine: e4, report: report4 } = await reopenThird(dbName);
  assert.equal(report4.conclusion, 'INTACT');
  await assertHealthyComplete(e4, report4, [1, 2, 3, 10, 20]);

  store1.close(); store2.close();
});

test('任意 committed 回执都对应可闭合发布根：多轮交错并发后重开始终健康无丢键', async () => {
  const dbName = newDbName();
  const { store1, e1, store2, e2 } = await setupTwoConnections(dbName);
  const keySets = [
    [[10, '十'], [11, '十一']],
    [[20, '二十'], [21, '廿一']],
    [[30, '三十'], [31, '卅一']],
    [[40, '四十'], [41, '四一']],
  ];
  let batchNo = 0;
  // 两个连接交替发起、但每轮内部真正并发
  for (let round = 0; round < keySets.length; round += 2) {
    const makeEdits = (pairs) => pairs.map(([k, v]) => ({ op: 'insert', key: k, value: v }));
    const [ra, rb] = await Promise.all([
      e1.submitBatch(makeEdits(keySets[round]), `batch-${++batchNo}`),
      e2.submitBatch(makeEdits(keySets[round + 1]), `batch-${++batchNo}`),
    ]);
    for (const r of [ra, rb]) {
      if (r.status !== 'committed') {
        // 极端调度下个别批次可重试：在下一轮前于新根补做
        const pairs = r.batchId === ra.batchId ? keySets[round] : keySets[round + 1];
        const again = await e1.submitBatch(makeEdits(pairs), r.batchId);
        assert.equal(again.status, 'committed');
      }
    }
  }

  const { engine: e3, report } = await reopenThird(dbName);
  assert.equal(report.conclusion, 'INTACT');
  await assertHealthyComplete(e3, report, [1, 2, 3, 10, 11, 20, 21, 30, 31, 40, 41]);
  assert.equal(report.gen, 5, '初始 gen 1 + 四个批次 -> gen 5');

  store1.close(); store2.close();
});

// 仅对 page:* 写入施加延迟的存储装饰器，用于确定性制造“持约中”的并发窗口
class SlowPageStore {
  constructor(inner, delayMs) { this.inner = inner; this.delayMs = delayMs; }
  get(key) { return this.inner.get(key); }
  allPageIds() { return this.inner.allPageIds(); }
  delete(key) { return this.inner.delete(key); }
  putMany(entries) { return this.inner.putMany(entries); }
  acquireCommitLease(h, ttl, now) { return this.inner.acquireCommitLease(h, ttl, now); }
  releaseCommitLease(h) { return this.inner.releaseCommitLease(h); }
  commitRootIf(expected, entries) { return this.inner.commitRootIf(expected, entries); }
  close() { return this.inner.close(); }
  async put(key, value) {
    if (typeof key === 'string' && key.startsWith('page:')) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    return this.inner.put(key, value);
  }
}
