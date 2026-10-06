// 并发批次回归：同一 IndexedDB 被两个（及多个）已打开的连接同时写入不同批次时，
// 提交回执必须与随后重开后可恢复、可查询的数据一致——
//   · 两个批次均 committed：重开必须得到健康的完整根，各批次新键都可查询
//     （此场景因串行化重基通常推进到第 3 代）；
//   · 竞争导致无法同时完成：至多一个 committed，另一个必须是
//     待恢复（OTHER_BATCH_PENDING）/ 冲突（CONCURRENT_COMMIT_CONFLICT）等可重试结果；
//   · 任何 committed 回执都不得对应丢失键或无法闭合的发布根。
// 运行：node --test（经 verify/run-all.mjs 由 Compose 验收链路调起）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from './fake-idb.mjs';
import { IDBStore } from '../site/src/store.mjs';
import { Engine } from '../site/src/engine.mjs';

// node:test 同文件用例并发运行，垫片按库名隔离；全局只安装一次。
installFakeIndexedDB();

// 落败批次允许的可重试/待恢复边界
const RETRYABLE_CODES = new Set(['OTHER_BATCH_PENDING', 'CONCURRENT_COMMIT_CONFLICT']);

async function openEngine(db) {
  const store = await IDBStore.open(db);
  const engine = new Engine(store);
  const report = await engine.open();
  return { store, engine, report };
}

test('并发批次回执与重开视图一致：双提交则两键俱在，否则唯一提交加可重试回执', async () => {
  const DB = 'track-idb-concurrent-ab';

  // 从空库建立包含键 1、2、3 的索引
  const c1 = await openEngine(DB);
  assert.equal(c1.report.conclusion, 'FRESH');
  await c1.engine.initialize([[1, '一'], [2, '二'], [3, '三']]);

  // 第二连接保持打开并读取同一个已发布根；此刻两连接都未观察到提交意图
  const c2 = await openEngine(DB);
  assert.equal(c2.report.conclusion, 'INTACT');
  assert.equal(c2.engine.state.gen, 1);
  assert.equal(c1.engine.state.gen, 1);

  // 实际并发执行两项插入：批次 A 的键 10 与批次 B 的键 20
  const [ra, rb] = await Promise.all([
    c1.engine.submitBatch([{ op: 'insert', key: 10, value: '十' }], 'batch-A'),
    c2.engine.submitBatch([{ op: 'insert', key: 20, value: '廿' }], 'batch-B'),
  ]);

  const committed = [ra, rb].filter((r) => r.status === 'committed');
  const others = [ra, rb].filter((r) => r.status !== 'committed');

  if (committed.length === 2) {
    // 双提交：两个回执不得同属一代（串行化推进，通常到第 3 代）
    assert.notEqual(ra.gen, rb.gen, '两个 committed 回执不得同属一代');
    assert.deepEqual([ra.gen, rb.gen].sort((x, y) => x - y), [2, 3]);
  } else {
    // 未能双提交：仅一个成功，另一个必须是待恢复 / 冲突 / 可重试的明确结果
    assert.equal(committed.length, 1, '竞争场景至多一个批次可以提交');
    assert.equal(others.length, 1);
    const loser = others[0];
    assert.ok(
      (loser.status === 'rejected' && RETRYABLE_CODES.has(loser.code)) || loser.status === 'interrupted',
      `落败批次须为待恢复/冲突/可重试结果，实际: ${JSON.stringify(loser)}`,
    );
  }

  // 第三个连接重新打开同一数据库，核验恢复结论与叶序列
  const c3 = await openEngine(DB);
  assert.notEqual(c3.report.conclusion, 'PUBLISHED_ROOT_UNHEALTHY',
    `重开不得出现无法闭合的发布根：${c3.report.detail}`);
  assert.equal(c3.report.conclusion, 'INTACT', '两批次均已终局，重开应无未完成批次');

  const snap = c3.engine.snapshot();
  assert.deepEqual(snap.badReferences, [], '发布根的子页引用必须全部闭合');
  assert.ok(snap.audit.pass, `分裂审计须通过: ${JSON.stringify(snap.audit)}`);
  assert.ok(snap.gen >= Math.max(ra.gen ?? 0, rb.gen ?? 0), '已发布代次不得落后于任何 committed 回执');

  // 核心不变量：committed 回执的键必须可查询；未 committed 的键不得混入视图
  if (ra.status === 'committed') assert.equal(c3.engine.lookup(10)?.value, '十', '批次 A 已 committed，键 10 必须可查询');
  else assert.equal(c3.engine.lookup(10), null, '批次 A 未 committed，键 10 不得出现在可查询视图');
  if (rb.status === 'committed') assert.equal(c3.engine.lookup(20)?.value, '廿', '批次 B 已 committed，键 20 必须可查询');
  else assert.equal(c3.engine.lookup(20), null, '批次 B 未 committed，键 20 不得出现在可查询视图');

  if (committed.length === 2) {
    assert.deepEqual(snap.leafSequence.map((x) => x.key), [1, 2, 3, 10, 20],
      '双提交后叶序列必须同时含键 10 与键 20');
    assert.equal(snap.gen, 3, '双提交因串行化重基推进到第 3 代');
    assert.equal(snap.keyCount, 5);
  } else {
    assert.equal(snap.keyCount, 4, '仅一个批次提交：三键初始态加一个新键');
    assert.equal(snap.gen, 2);
  }

  // 存储中不得残留已发布根不可达的页（在途孤儿已由提交回收或重开复核清除）
  const stored = await c3.store.allPageIds();
  assert.equal(stored.length, snap.reachablePages, '不得残留不可达页');

  await c1.store.close();
  await c2.store.close();
  await c3.store.close();
});

test('并发插入同一键：串行化为一次提交加一次精确拒绝，重开健康且键恰好一次', async () => {
  const DB = 'track-idb-concurrent-same-key';
  const c1 = await openEngine(DB);
  await c1.engine.initialize([[1, '一'], [2, '二'], [3, '三']]);
  const c2 = await openEngine(DB);

  const [ra, rb] = await Promise.all([
    c1.engine.submitBatch([{ op: 'insert', key: 10, value: '十' }], 'same-A'),
    c2.engine.submitBatch([{ op: 'insert', key: 10, value: '拾' }], 'same-B'),
  ]);

  // 串行化：先胜者提交，重基后的落败者撞上 INSERT_EXISTS（键已存在）
  const outcomes = [ra, rb].map((r) => (r.status === 'committed' ? 'committed' : r.code));
  assert.deepEqual([...outcomes].sort(), ['INSERT_EXISTS', 'committed']);

  const c3 = await openEngine(DB);
  assert.equal(c3.report.conclusion, 'INTACT');
  const snap = c3.engine.snapshot();
  assert.ok(snap.audit.pass);
  assert.deepEqual(snap.leafSequence.map((x) => x.key), [1, 2, 3, 10]);
  assert.equal(snap.leafSequence.filter((x) => x.key === 10).length, 1, '键 10 恰好出现一次');
  assert.equal(snap.gen, 2);

  await c1.store.close();
  await c2.store.close();
  await c3.store.close();
});

test('提交途中被并发重开复核发布同一新根：回执仍是 committed 且视图健康', async () => {
  const DB = 'track-idb-concurrent-recover-publish';
  const c1 = await openEngine(DB);
  await c1.engine.initialize([[1, '一'], [2, '二'], [3, '三']]);

  // 在 c1 的意图落盘后、根切换前，模拟另一连接的重开复核介入（仅补丁 c1 的连接）
  const realTransact = c1.store.transact.bind(c1.store);
  let txCalls = 0;
  c1.store.transact = async (fn) => {
    txCalls++;
    if (txCalls === 2) {
      // 另一连接打开：recover 凭完整证据发布同一新根并清理意图
      const bystander = await openEngine(DB);
      assert.equal(bystander.report.conclusion, 'NEW_ROOT_PUBLISHED');
      await bystander.store.close();
    }
    return realTransact(fn);
  };

  const r = await c1.engine.submitBatch([{ op: 'insert', key: 10, value: '十' }], 'raced-by-recover');
  assert.equal(r.status, 'committed', '恢复流程已发布同一新根，本批次视同提交成功');
  assert.equal(r.gen, 2);

  const c3 = await openEngine(DB);
  assert.equal(c3.report.conclusion, 'INTACT');
  assert.equal(c3.engine.lookup(10)?.value, '十');
  assert.ok(c3.engine.snapshot().audit.pass);
  await c1.store.close();
  await c3.store.close();
});

test('提交途中意图被并发重开复核回滚：不回放 committed，给出终局回执', async () => {
  const DB = 'track-idb-concurrent-recover-rollback';
  const c1 = await openEngine(DB);
  await c1.engine.initialize([[1, '一'], [2, '二'], [3, '三']]);

  const realTransact = c1.store.transact.bind(c1.store);
  let txCalls = 0;
  c1.store.transact = async (fn) => {
    txCalls++;
    if (txCalls === 2) {
      // 另一连接打开前弄丢一个新页：recover 判定证据不完整，回滚本批次意图
      const intent = await c1.store.get('intent');
      await c1.store.delete('page:' + intent.pageIds[0]);
      const bystander = await openEngine(DB);
      assert.equal(bystander.report.conclusion, 'OLD_ROOT_RETAINED');
      await bystander.store.close();
    }
    return realTransact(fn);
  };

  const r = await c1.engine.submitBatch([{ op: 'insert', key: 10, value: '十' }], 'rolled-mid-commit');
  assert.notEqual(r.status, 'committed', '意图已被回滚，绝不允许再报 committed');
  assert.equal(r.status, 'rolled-back', '重读后回放到恢复流程固化的回滚回执');

  const c3 = await openEngine(DB);
  assert.equal(c3.report.conclusion, 'INTACT');
  assert.equal(c3.engine.lookup(10), null, '被回滚的批次不得留下可查询的键');
  assert.equal(c3.engine.snapshot().gen, 1);
  await c1.store.close();
  await c3.store.close();
});

test('四连接并发异键插入：全部串行化提交，代次严格递增，重开后全部键可查询', async () => {
  const DB = 'track-idb-concurrent-many';
  const c0 = await openEngine(DB);
  await c0.engine.initialize([[1, '一'], [2, '二'], [3, '三']]);
  await c0.store.close();

  // 四个已打开的连接同读 gen 1 已发布根，并发提交四个不同批次
  const conns = await Promise.all([1, 2, 3, 4].map(() => openEngine(DB)));
  const keys = [10, 20, 30, 40];
  const receipts = await Promise.all(conns.map(({ engine }, i) =>
    engine.submitBatch([{ op: 'insert', key: keys[i], value: `值${keys[i]}` }], `multi-${i}`)));

  // 重试预算充足时全部提交；committed 回执的代次必须是 2..5 的一个排列（严格串行）
  for (const r of receipts) assert.equal(r.status, 'committed', `回执须为 committed: ${JSON.stringify(r)}`);
  assert.deepEqual(receipts.map((r) => r.gen).sort((x, y) => x - y), [2, 3, 4, 5]);

  const c3 = await openEngine(DB);
  assert.equal(c3.report.conclusion, 'INTACT');
  const snap = c3.engine.snapshot();
  assert.ok(snap.audit.pass);
  assert.equal(snap.gen, 5);
  assert.deepEqual(snap.leafSequence.map((x) => x.key), [1, 2, 3, 10, 20, 30, 40]);
  for (const k of keys) assert.equal(c3.engine.lookup(k)?.value, `值${k}`);

  await Promise.all(conns.map(({ store }) => store.close()));
  await c3.store.close();
});
