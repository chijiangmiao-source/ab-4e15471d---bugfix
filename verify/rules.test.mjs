// 规则测试：一次有效分裂、各持久化阶段中断恢复、冲突重传、
// 以及各类拒绝原因（重复键 / 删除不存在键 / 损坏摘要 / 无法闭合引用）。
// 运行：node --test（Node 20 内置测试运行器，零依赖）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, CRASH_POINTS, snapshotOf, auditKeys } from '../site/src/engine.mjs';
import { MemoryStore } from '../site/src/store.mjs';
import { digestPage } from '../site/src/digest.mjs';

async function freshDb(entries) {
  const store = new MemoryStore();
  const engine = new Engine(store);
  await engine.open();
  await engine.initialize(entries ?? [
    [10, '航点十'], [20, '航点廿'], [30, '卅'], [40, '四十'],
    [50, '五十'], [60, '六十'], [70, '七十'],
  ]);
  return { store, engine };
}

async function reopenEngine(store) {
  const engine = new Engine(store);
  const report = await engine.open();
  return { engine, report };
}

// ---------- 一、一次有效分裂 ----------

test('有效分裂：跨叶分裂与根提升后所有键仍恰好一次出现', async () => {
  const { engine } = await freshDb();
  const before = engine.snapshot();
  assert.equal(before.gen, 1);
  assert.ok(before.internalCount >= 1, '7 键应已产生至少一次分裂（存在内部页）');
  assert.ok(before.allKeysOnce, '初始树按键有序且无重复');

  const edits = [
    { op: 'insert', key: 5, value: '五' },
    { op: 'insert', key: 15, value: '十五' },
    { op: 'insert', key: 25, value: '廿五' },
    { op: 'insert', key: 35, value: '卅五' },
    { op: 'insert', key: 65, value: '六十五' },
    { op: 'insert', key: 75, value: '七十五' },
    { op: 'update', key: 40, value: '四十-改' },
  ];
  const receipt = await engine.submitBatch(edits, 'batch-split');
  assert.equal(receipt.status, 'committed');
  assert.equal(receipt.replayed, false);

  const snap = engine.snapshot();
  assert.equal(snap.gen, 2);
  assert.ok(snap.internalCount >= 1);
  // 每个叶页至多 3 键，内部页至多 4 子
  for (const p of snap.pages) {
    if (p.type === 'leaf') assert.ok(p.keys.length <= 3);
    else {
      assert.ok(p.children.length <= 4);
      assert.ok(p.children.length >= 2);
    }
  }
  const expected = new Set([10, 20, 30, 40, 50, 60, 70, 5, 15, 25, 35, 65, 75]);
  const audit = auditKeys(snap, expected);
  assert.deepEqual(audit, {
    pass: true, expectedCount: 13, actualCount: 13,
    missing: [], extra: [], dupes: [], ordered: true,
  });
  assert.equal(engine.lookup(40).value, '四十-改');
  assert.equal(engine.lookup(5).value, '五');
});

test('有效分裂的直证：插入使单叶 4 键时对称分裂为两个 2 键叶', async () => {
  const store = new MemoryStore();
  const engine = new Engine(store);
  await engine.open();
  await engine.initialize([[1, 'a'], [2, 'b'], [3, 'c']]);
  let snap = engine.snapshot();
  assert.equal(snap.leafCount, 1);
  assert.deepEqual(snap.leafSequence.map((x) => x.key), [1, 2, 3]);

  await engine.submitBatch([{ op: 'insert', key: 4, value: 'd' }], 'b');
  snap = engine.snapshot();
  assert.equal(snap.leafCount, 2);
  assert.equal(snap.internalCount, 1, '根提升为内部页');
  assert.deepEqual(snap.leafSequence.map((x) => x.key), [1, 2, 3, 4]);
  assert.deepEqual(snap.pages.find((p) => p.type === 'internal').keys, [3]);
  assert.ok(snap.allKeysOnce);
});

// ---------- 二、各阶段中断恢复 ----------

test('中断于新页写入途中：重开停在旧根，半写入页不进入可查询视图', async () => {
  const { store, engine } = await freshDb();
  const oldRoot = engine.state.rootId;
  const ack = await engine.submitBatch(
    [{ op: 'insert', key: 5, value: '五' }, { op: 'insert', key: 15, value: '十五' }],
    'crash-during-pages', CRASH_POINTS.DURING_PAGES,
  );
  assert.equal(ack.status, 'interrupted');
  assert.equal(ack.stage, 'PAGES');
  assert.equal(engine.state.rootId, oldRoot, '内存视图仍是旧根');

  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'INTACT');
  assert.equal(e2.state.rootId, oldRoot, '重开后发布根仍是旧根');
  assert.equal(e2.snapshot().gen, 1);
  assert.equal(e2.lookup(5), null);

  const snap = e2.snapshot();
  // 存储中不存在任何已发布根不可达的页
  const stored = await store.allPageIds();
  assert.equal(stored.length, snap.reachablePages, '半写入孤儿已被清除');
  assert.equal(await store.get('intent'), undefined);
});

test('中断于新页全部写完、意图留下前：重开停在旧根', async () => {
  const { store, engine } = await freshDb();
  const oldRoot = engine.state.rootId;
  await engine.submitBatch(
    [{ op: 'insert', key: 5, value: '五' }, { op: 'insert', key: 55, value: '五五' }],
    'crash-after-pages', CRASH_POINTS.AFTER_PAGES,
  );
  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'INTACT');
  assert.equal(e2.state.rootId, oldRoot);
  assert.equal(e2.lookup(55), null);
  const stored = await store.allPageIds();
  assert.equal(stored.length, e2.snapshot().reachablePages);
});

test('中断于意图之后、根切换之前且证据完整：重开发布可完整遍历的新根', async () => {
  const { store, engine } = await freshDb();
  const oldRoot = engine.state.rootId;
  await engine.submitBatch(
    [{ op: 'insert', key: 5, value: '五' }, { op: 'delete', key: 30 }],
    'crash-after-intent', CRASH_POINTS.AFTER_INTENT,
  );
  assert.equal(engine.state.rootId, oldRoot, '断电瞬间查询视图仍是旧根');

  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'NEW_ROOT_PUBLISHED');
  assert.equal(e2.snapshot().gen, 2);
  assert.notEqual(e2.state.rootId, oldRoot);
  const snap = e2.snapshot();
  assert.equal(snap.badReferences.length, 0, '新树引用全部闭合');
  assert.ok(snap.allKeysOnce);
  assert.equal(e2.lookup(5).value, '五');
  assert.equal(e2.lookup(30), null);
  // 发布同时固化了提交回执，意图已清理
  const receipt = await store.get('receipt:crash-after-intent');
  assert.equal(receipt.status, 'committed');
  assert.equal(await store.get('intent'), undefined);
});

test('中断于意图之后但新页缺失：重开保留旧根并记录回滚原因', async () => {
  const { store, engine } = await freshDb();
  const oldRoot = engine.state.rootId;
  await engine.submitBatch(
    [{ op: 'insert', key: 5, value: '五' }, { op: 'insert', key: 6, value: '六' }],
    'crash-missing-page', CRASH_POINTS.AFTER_INTENT,
  );
  // 模拟半写入：删除意图清单中的一个新页（选旧根不可达的）
  const intent = await store.get('intent');
  const oldReach = new Set((await store.allPageIds()).map((k) => k.slice(5)));
  const victim = intent.pageIds.find((id) => !engine.state.pages.has(id));
  assert.ok(victim, '应当至少存在一个新批次页');
  await store.delete('page:' + victim);
  assert.equal(oldReach.size, (await store.allPageIds()).length + 1);

  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'OLD_ROOT_RETAINED');
  assert.match(report.detail, /证据不完整|缺失/);
  assert.equal(e2.state.rootId, oldRoot);
  assert.equal(e2.snapshot().gen, 1);
  assert.equal(e2.lookup(5), null);
  const receipt = await store.get('receipt:crash-missing-page');
  assert.equal(receipt.status, 'rolled-back');
  assert.match(receipt.reason, /缺失/);
  // 存储页与旧根可达页一致，无孤儿混入
  const stored = await store.allPageIds();
  assert.equal(stored.length, e2.snapshot().reachablePages);
});

test('中断于意图之后且页摘要损坏：重开保留旧根并指明摘要损坏', async () => {
  const { store, engine } = await freshDb();
  const oldRoot = engine.state.rootId;
  await engine.submitBatch(
    [{ op: 'insert', key: 5, value: '五' }, { op: 'insert', key: 8, value: '八' }],
    'crash-corrupt-page', CRASH_POINTS.AFTER_INTENT,
  );
  const intent = await store.get('intent');
  const victim = intent.pageIds.find((id) => !engine.state.pages.has(id));
  const page = await store.get('page:' + victim);
  const corrupted = { ...page, values: page.values?.map ? page.values.map(() => '被篡改') : page.values };
  // 故意不重算 digest，制造摘要不符
  await store.put('page:' + victim, corrupted);

  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'OLD_ROOT_RETAINED');
  assert.match(report.detail, /摘要/);
  assert.equal(e2.state.rootId, oldRoot);
  assert.equal(e2.lookup(5), null);
  assert.equal((await store.get('receipt:crash-corrupt-page')).status, 'rolled-back');
});

test('中断于根切换之后、意图清理之前：重开确认新根已发布，仅补清理', async () => {
  const { store, engine } = await freshDb();
  const oldRoot = engine.state.rootId;
  await engine.submitBatch(
    [{ op: 'insert', key: 5, value: '五' }],
    'crash-after-root', CRASH_POINTS.AFTER_ROOT,
  );
  // 断电进程在根切换后立即中断：持久化已提交，但崩溃回执不再更新内存视图

  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'NEW_ROOT_PUBLISHED');
  assert.equal(e2.snapshot().gen, 2);
  assert.notEqual(e2.state.rootId, oldRoot, '重开后发布的是新根');
  assert.equal(e2.lookup(5).value, '五');
  assert.equal(await store.get('intent'), undefined);
  const stored = await store.allPageIds();
  assert.equal(stored.length, e2.snapshot().reachablePages, '旧版本页被回收');
});

test('任意阶段中断都不会产生“半新半旧”视图：四个注入点逐一核验', async () => {
  const points = [
    CRASH_POINTS.DURING_PAGES,
    CRASH_POINTS.AFTER_PAGES,
    CRASH_POINTS.AFTER_INTENT,
    CRASH_POINTS.AFTER_ROOT,
  ];
  for (const point of points) {
    const store = new MemoryStore();
    const engine = new Engine(store);
    await engine.open();
    await engine.initialize([[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]);
    const oldRoot = engine.state.rootId;
    await engine.submitBatch([{ op: 'insert', key: 9, value: 'nine' }], 'bx-' + point, point);
    const { engine: e2 } = await reopenEngine(store);
    const snap = e2.snapshot();
    assert.ok(snap.allKeysOnce, point + ' 恢复后键仍恰好一次');
    const hasNine = e2.lookup(9) !== null;
    if (point === CRASH_POINTS.AFTER_INTENT || point === CRASH_POINTS.AFTER_ROOT) {
      assert.ok(hasNine, point + ' 应为完整新根');
      assert.equal(snap.gen, 2);
    } else {
      assert.ok(!hasNine, point + ' 应为旧根');
      assert.equal(e2.state.rootId, oldRoot);
      assert.equal(snap.gen, 1);
    }
  }
});

// ---------- 三、冲突重传与回执回放 ----------

test('相同批次标识与等价编辑重试：回放原回执且不再次改变根', async () => {
  const { engine } = await freshDb();
  const edits = [{ op: 'insert', key: 88, value: '八十八' }];
  const r1 = await engine.submitBatch(edits, 'dup-ok');
  assert.equal(r1.status, 'committed');
  assert.equal(r1.replayed, false);
  const rootAfter = engine.state.rootId;

  const r2 = await engine.submitBatch(edits, 'dup-ok');
  assert.equal(r2.status, 'committed');
  assert.equal(r2.replayed, true);
  assert.equal(r2.rootId, r1.rootId);
  assert.equal(engine.state.rootId, rootAfter);
  assert.equal(engine.snapshot().gen, 2, '代次不前进');

  // 等价编辑：操作名大小写、键的字符串形式不同，归一化后相同
  const r3 = await engine.submitBatch(
    [{ op: 'INSERT', key: '88', value: '八十八' }], 'dup-ok',
  );
  assert.equal(r3.replayed, true);
  assert.equal(engine.snapshot().gen, 2);
});

test('相同批次标识但内容不同：冲突拒绝、给出原因且根不变', async () => {
  const { engine } = await freshDb();
  const rootBefore = engine.state.rootId;
  await engine.submitBatch([{ op: 'insert', key: 88, value: '八十八' }], 'same-id');
  const rootAfterCommit = engine.state.rootId;
  const rej = await engine.submitBatch([{ op: 'insert', key: 99, value: '九十九' }], 'same-id');
  assert.equal(rej.status, 'rejected');
  assert.equal(rej.code, 'CONFLICT_BATCH_CONTENT');
  assert.match(rej.reason, /不同内容/);
  assert.equal(engine.state.rootId, rootAfterCommit, '冲突重传不改变已发布根');
  assert.equal(engine.lookup(99), null);
  assert.equal(engine.lookup(88).value, '八十八');
  assert.notEqual(rootBefore, rootAfterCommit);

  // 删除/更新混排也算不同内容
  const rej2 = await engine.submitBatch([{ op: 'delete', key: 88 }], 'same-id');
  assert.equal(rej2.code, 'CONFLICT_BATCH_CONTENT');
});

test('中断后用相同批次等价编辑重试：完成提交并给出提交回执', async () => {
  const { store, engine } = await freshDb();
  const edits = [{ op: 'insert', key: 77, value: '七十七' }];
  await engine.submitBatch(edits, 'retry-after-crash', CRASH_POINTS.DURING_PAGES);
  const { engine: e2 } = await reopenEngine(store);
  const r = await e2.submitBatch(edits, 'retry-after-crash');
  assert.equal(r.status, 'committed');
  assert.equal(e2.lookup(77).value, '七十七');
  // 再重放仍是原回执
  const r2 = await e2.submitBatch(edits, 'retry-after-crash');
  assert.equal(r2.replayed, true);
});

test('批次已终局回滚（证据不完整）后，同 id 等价编辑重传回放回滚回执；要重做须用新批次标识', async () => {
  const { store, engine } = await freshDb();
  const edits = [{ op: 'insert', key: 5, value: '五' }, { op: 'insert', key: 6, value: '六' }];
  await engine.submitBatch(edits, 'rolled-id', CRASH_POINTS.AFTER_INTENT);
  const intent = await store.get('intent');
  await store.delete('page:' + intent.pageIds[0]);
  const { engine: e2 } = await reopenEngine(store);
  assert.equal(e2.lookup(5), null);

  // 同 id + 等价内容：回放“回滚”这一原回执，而不是重新提交
  const replay = await e2.submitBatch(edits, 'rolled-id');
  assert.equal(replay.status, 'rolled-back');
  assert.equal(replay.replayed, true);
  assert.equal(e2.lookup(5), null, '根仍未改变');

  // 审查员要重做该编辑，换一个新批次标识即可正常提交
  const redo = await e2.submitBatch(edits, 'rolled-id-repaired');
  assert.equal(redo.status, 'committed');
  assert.equal(e2.lookup(5).value, '五');
});

// ---------- 四、规则拒绝：不改已发布根 ----------

test('插入重复键被拒绝且根不变', async () => {
  const { engine } = await freshDb();
  const root = engine.state.rootId;
  const r = await engine.submitBatch([{ op: 'insert', key: 30, value: 'x' }], 'dup-key');
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'INSERT_EXISTS');
  assert.equal(engine.state.rootId, root);
  assert.equal(engine.lookup(30).value, '卅');
});

test('批次内对同一键重复插入被精确拒绝；插入后再更新同键合法', async () => {
  const { engine } = await freshDb();
  const root = engine.state.rootId;
  const r = await engine.submitBatch([
    { op: 'insert', key: 100, value: 'a' },
    { op: 'insert', key: 100, value: 'b' },
  ], 'dup-in-batch');
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'INSERT_EXISTS');
  assert.match(r.reason, /已存在/);
  assert.equal(engine.state.rootId, root);
  assert.equal(engine.lookup(100), null, '整批拒绝，前一操作也不落库');

  // 顺序脚本：先插入后更新同键应提交
  const ok = await engine.submitBatch([
    { op: 'insert', key: 101, value: 'a' },
    { op: 'update', key: 101, value: 'b' },
    { op: 'insert', key: 102, value: 'c' },
  ], 'seq-same-key');
  assert.equal(ok.status, 'committed');
  assert.equal(engine.lookup(101).value, 'b');
});

test('删除不存在的键被拒绝', async () => {
  const { engine } = await freshDb();
  const root = engine.state.rootId;
  const r = await engine.submitBatch([{ op: 'delete', key: 999 }], 'del-missing');
  assert.equal(r.code, 'DELETE_MISSING');
  assert.equal(engine.state.rootId, root);
});

test('更新不存在的键被拒绝', async () => {
  const { engine } = await freshDb();
  const r = await engine.submitBatch([{ op: 'update', key: 999, value: 'x' }], 'upd-missing');
  assert.equal(r.code, 'UPDATE_MISSING');
});

test('录入与批次的数量、标识、操作类型、键型校验', async () => {
  const store = new MemoryStore();
  let engine = new Engine(store);
  await engine.open();
  await assert.rejects(
    () => engine.initialize(Array.from({ length: 25 }, (_, i) => [i, 'v'])),
    /至多 24/,
  );
  await engine.initialize([[1, 'a'], [2, 'b']]);

  const cases = [
    { edits: [], id: 'empty', match: /不能为空/ },
    { edits: Array.from({ length: 13 }, (_, i) => ({ op: 'insert', key: 100 + i, value: 'v' })), id: 'too-many', match: /至多 12/ },
    { edits: [{ op: 'frobnicate', key: 5 }], id: 'bad-op', match: /未知操作/ },
    { edits: [{ op: 'insert', key: 1.5, value: 'v' }], id: 'float-key', match: /整数/ },
    { edits: [{ op: 'insert', key: 5, value: 'v' }], id: '', match: /批次标识/ },
  ];
  for (const c of cases) {
    const root = engine.state.rootId;
    const r = await engine.submitBatch(c.edits, c.id);
    assert.equal(r.status, 'rejected', c.id + ' 应拒绝');
    assert.match(r.reason, c.match);
    assert.equal(engine.state.rootId, root, c.id + ' 根不变');
  }
});

test('初始录入重复键被拒绝', async () => {
  const store = new MemoryStore();
  const engine = new Engine(store);
  await engine.open();
  await assert.rejects(
    () => engine.initialize([[1, 'a'], [1, 'b']]),
    /重复/,
  );
});

// ---------- 五、损坏页摘要与无法闭合的引用 ----------

test('已发布页摘要损坏：恢复报告不健康，任何批次不得改变根', async () => {
  const { store, engine } = await freshDb();
  const root = engine.state.rootId;
  const page = await store.get('page:' + root);
  // 篡改内容但保留旧 digest
  const tampered = page.type === 'leaf'
    ? { ...page, values: page.values.map(() => '损坏') }
    : { ...page, keys: page.keys.map((k) => k + 100000) };
  await store.put('page:' + root, tampered);

  const e2 = new Engine(store);
  const report = await e2.open();
  assert.equal(report.conclusion, 'PUBLISHED_ROOT_UNHEALTHY');
  assert.match(report.detail, /摘要/);
  assert.equal(e2.state.rootId, root, '根指针原样冻结');

  const r = await e2.submitBatch([{ op: 'insert', key: 1, value: 'x' }], 'against-corrupt');
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'CORRUPT_DIGEST');
  const rootRec = await store.get('root');
  assert.equal(rootRec.rootId, root);
});

test('无法闭合的子页引用：恢复识别为不健康且不切换根', async () => {
  const { store, engine } = await freshDb();
  const root = engine.state.rootId;
  const page = await store.get('page:' + root);
  assert.equal(page.type, 'internal');
  // 指向不存在的子页，并重算 digest 使摘要本身合法——证明引用闭合被独立校验
  const tampered = { ...page, children: ['p-deadbeefdeadbeef'] };
  tampered.digest = digestPage(tampered);
  await store.put('page:' + root, tampered);

  const e2 = new Engine(store);
  const report = await e2.open();
  assert.equal(report.conclusion, 'PUBLISHED_ROOT_UNHEALTHY');
  assert.match(report.detail, /无法闭合|闭合/);
  const r = await e2.submitBatch([{ op: 'insert', key: 1, value: 'x' }], 'against-broken');
  assert.equal(r.code, 'BROKEN_REFERENCE');
  assert.equal((await store.get('root')).rootId, root);
});

test('新页内容寻址：等价重试写入同一批页 id，旧页不被覆盖', async () => {
  const { store, engine } = await freshDb();
  const oldPages = new Set((await store.allPageIds()));
  const r1 = await engine.submitBatch([{ op: 'insert', key: 91, value: '九一' }], 'idempotent');
  const ids1 = new Set((await store.allPageIds()).filter((k) => !oldPages.has(k)));
  // 新库再来一遍相同操作
  const store2 = new MemoryStore();
  const e2 = new Engine(store2);
  await e2.open();
  await e2.initialize([
    [10, '航点十'], [20, '航点廿'], [30, '卅'], [40, '四十'],
    [50, '五十'], [60, '六十'], [70, '七十'],
  ]);
  await e2.submitBatch([{ op: 'insert', key: 91, value: '九一' }], 'idempotent');
  const ids2 = new Set([...new Set((await store2.allPageIds()).filter((k) => !oldPages.has(k)))]);
  // 两个库生成的新页 id 完全一致（内容寻址），重放覆盖等价于空操作
  assert.deepEqual([...ids1].sort(), [...ids2].sort());
  assert.ok(r1.status === 'committed');
});

// 视图结构自检：快照字段完整，可供结果页展示
test('删空全部键后再插入并重开：空叶保持闭合、审计仍通过', async () => {
  const { store, engine } = await freshDb();
  let r = await engine.submitBatch(
    [10, 20, 30].map((k) => ({ op: 'delete', key: k })), 'd1');
  assert.equal(r.status, 'committed');
  r = await engine.submitBatch(
    [40, 50, 60, 70].map((k) => ({ op: 'delete', key: k })), 'd2');
  assert.equal(r.status, 'committed');
  assert.equal(engine.snapshot().keyCount, 0);
  assert.equal(engine.snapshot().audit.pass, true);

  r = await engine.submitBatch([{ op: 'insert', key: 42, value: '答' }], 'reborn');
  assert.equal(r.status, 'committed');
  assert.equal(engine.lookup(42).value, '答');
  assert.equal(engine.snapshot().audit.pass, true);

  const { engine: e2, report } = await reopenEngine(store);
  assert.equal(report.conclusion, 'INTACT');
  assert.equal(e2.lookup(42).value, '答');
  assert.equal(e2.snapshot().audit.pass, true);
});

// 视图结构自检：快照字段完整，可供结果页展示
test('结果视图包含根代次、可达页、有序叶序列与恢复结论', async () => {
  const { engine } = await freshDb();
  const snap = snapshotOf(engine.state.pages, engine.state.rootId, engine.state.gen, engine.lastRecovery);
  assert.equal(typeof snap.gen, 'number');
  assert.equal(snap.reachablePages, snap.pages.length);
  assert.equal(snap.leafSequence.length, 7);
  assert.deepEqual(snap.leafSequence.map((x) => x.key), [10, 20, 30, 40, 50, 60, 70]);
  for (const p of snap.pages) assert.match(p.digest, /^[0-9a-f]{16}$/);
});
