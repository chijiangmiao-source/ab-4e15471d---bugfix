// 三阶段写时复制批次引擎：
//   阶段1 PAGES  先持久化全部新页（带代次 gen 与摘要 digest，内容寻址幂等）
//   阶段2 INTENT 再留下批次意图（batchId / editDigest / 新根 / 页清单）
//   阶段3 COMMIT 原子切换根指针并固化回执；随后清理意图
// 崩溃重开时只看持久化证据：
//   意图缺失              -> 查询视图停在旧根，半写入页是不可达孤儿
//   意图存在且新树可闭合  -> 发布新根（根可完整遍历）
//   意图存在但页缺失/损坏 -> 保留旧根，剔除未竟意图与孤儿页，给出原因

import {
  applyEdits, buildTree, closure, orderedLeaves, RuleError, ORDER,
} from './bptree.mjs';
import { fnv1a64, stableStringify, verifyDigest } from './digest.mjs';
import { K_COMMIT_LOCK } from './store.mjs';

export const CRASH_POINTS = Object.freeze({
  NONE: 'none',
  DURING_PAGES: 'during-pages',
  AFTER_PAGES: 'after-pages',
  AFTER_INTENT: 'after-intent',
  AFTER_ROOT: 'after-root', // 根已切换、回执已固化，尚未清理意图
});

// 跨连接提交租约：把“写新页 → 意图 → 切根 → 回收”串行化为临界区。
// TTL 只在持约连接真正死亡（断电/杀进程）后生效，由重开复核或等待方回收；
// 正常提交远短于 TTL。等待超时后给调用方“可重试”结论而非任何半状态。
const COMMIT_LOCK_TTL_MS = 20_000;
const LEASE_WAIT_MS = 25_000;
const LEASE_POLL_MS = 25;

const K_ROOT = 'root';
const K_INTENT = 'intent';
const K_RECEIPT = (id) => 'receipt:' + id;
const K_PAGE = (id) => 'page:' + id;

export const MAX_INITIAL = 24;
export const MAX_EDITS = 12;
export const MAX_TEXT = 200;
export const MAX_BATCH_ID = 64;

export function canonicalEdits(edits) {
  return edits.map((e) => {
    const op = String(e.op ?? '').toLowerCase();
    const out = { op, key: Number(e.key) };
    if (op === 'insert' || op === 'update') out.value = String(e.value ?? '');
    return out;
  });
}

export function editDigestOf(edits) {
  return fnv1a64(stableStringify(canonicalEdits(edits)));
}

// 顺序脚本作用在已提交键集合上的结果（applyEdits 全成功后才使用）
function keysAfter(keySet, edits) {
  const next = new Set(keySet);
  for (const e of edits) {
    if (e.op === 'insert') next.add(e.key);
    else if (e.op === 'delete') next.delete(e.key);
  }
  return next;
}

// 校验前也要给回执一个摘要：对无法归一化的输入退化为原始串摘要
function safeEditDigest(edits) {
  try {
    return editDigestOf(edits);
  } catch {
    return fnv1a64(stableStringify(edits ?? null));
  }
}

// 同步校验：抛 RuleError 即拒绝，拒绝绝不产生任何写入
function validateRequest({ batchId, edits }) {
  if (typeof batchId !== 'string' || !batchId.trim() || batchId.length > MAX_BATCH_ID) {
    throw new RuleError('BAD_BATCH_ID', `批次标识须为 1..${MAX_BATCH_ID} 个字符的非空文本`);
  }
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_EDITS) {
    throw new RuleError('BAD_EDIT_COUNT', `每批至多 ${MAX_EDITS} 项插入/更新/删除，且不能为空`);
  }
  for (const e of edits) {
    const op = String(e.op ?? '').toLowerCase();
    if (!['insert', 'update', 'delete'].includes(op)) {
      throw new RuleError('UNKNOWN_OP', `未知操作类型: ${e.op}`);
    }
    const key = Number(e.key);
    if (!Number.isInteger(key)) throw new RuleError('BAD_KEY', `键必须为整数: ${e.key}`);
    // 注意：批次是顺序脚本，允许“先插入后更新/删除”同一键；
    // 真正的重复插入（键在执行点已存在）由树精确判为 INSERT_EXISTS。
    if (op === 'insert' || op === 'update') {
      const v = e.value ?? '';
      if (typeof v !== 'string') throw new RuleError('BAD_VALUE', `键 ${key} 的载荷必须是短文本`);
      if (v.length > MAX_TEXT) throw new RuleError('BAD_VALUE', `键 ${key} 的载荷超过 ${MAX_TEXT} 字`);
    }
  }
}

function validateInitial(entries) {
  if (entries.length > MAX_INITIAL) {
    throw new RuleError('BAD_ENTRY_COUNT', `初始航点至多 ${MAX_INITIAL} 个`);
  }
  const seen = new Set();
  for (const [key, value] of entries) {
    if (!Number.isInteger(key)) throw new RuleError('BAD_KEY', `键必须为整数: ${key}`);
    if (seen.has(key)) throw new RuleError('DUPLICATE_KEY', `初始键 ${key} 重复`);
    seen.add(key);
    if (typeof value !== 'string' || value.length > MAX_TEXT) {
      throw new RuleError('BAD_VALUE', `键 ${key} 的载荷须为不超过 ${MAX_TEXT} 字的文本`);
    }
  }
}
function MAX_TEXT_TEXT_HINT() { return MAX_TEXT; }

export class Engine {
  constructor(store, {
    now = () => new Date().toISOString(),
    nowMs = () => Date.now(),
    leaseTtlMs = COMMIT_LOCK_TTL_MS,
    leaseWaitMs = LEASE_WAIT_MS,
  } = {}) {
    this.store = store;
    this.now = now;
    this.nowMs = nowMs;
    this.leaseTtlMs = leaseTtlMs;
    this.leaseWaitMs = leaseWaitMs;
    this.state = null; // { rootId, gen, pages:Map, receipt? }
  }

  // 打开并执行断电重开复核，返回恢复结论；引擎状态在 this.state / this.lastRecovery
  async open() {
    const report = await this.recover();
    return report;
  }

  async loadPages(rootId) {
    const src = new Map();
    const collect = async (id) => {
      if (id == null || src.has(id)) return;
      const p = await this.store.get(K_PAGE(id));
      if (!p) throw new RuleError('BROKEN_REFERENCE', `无法闭合的子页引用: ${id}`);
      src.set(id, p);
      if (p.type === 'internal') for (const c of p.children) await collect(c);
    };
    await collect(rootId);
    return src;
  }

  async abandonIntent(payload, reason) {
    await this.store.delete(K_INTENT);
    await this.store.put(K_RECEIPT(payload.batchId), {
      batchId: payload.batchId, editDigest: payload.editDigest, status: 'rolled-back',
      gen: payload.gen, reason, createdAt: this.now(),
    });
  }

  // 持约等待：租约把整段三阶段提交（含新页写入与旧页回收）跨连接串行化。
  // 他连接持约通常毫秒级完成，故等待方轮询到即可续跑；唯有持约者真正死亡
  // （租约超过 TTL 未续）才由过期判定回收。waitMs 内仍拿不到则返回 false。
  async acquireLease(holder, { waitMs = this.leaseWaitMs } = {}) {
    const deadline = this.nowMs() + waitMs;
    for (;;) {
      const r = await this.store.acquireCommitLease(holder, this.leaseTtlMs, this.nowMs());
      if (r.ok) return true;
      if (this.nowMs() >= deadline) return false;
      await new Promise((res) => setTimeout(res, LEASE_POLL_MS));
    }
  }

  async releaseLease(holder) {
    try { await this.store.releaseCommitLease(holder); } catch { /* 释放是尽力而为 */ }
  }

  // 从持久化读取当前已发布根的完整快照（持约期间调用：此刻无并发提交者）。
  // 发布根本身缺页/摘要损坏时返回 unhealthy 标记，调用方据此拒绝改根。
  async loadPublished() {
    const rootRec = await this.store.get(K_ROOT);
    if (!rootRec) {
      return { rootRec: null, state: { rootId: null, gen: 0, pages: new Map(), keySet: new Set(), corrupt: [], loadProblems: [] } };
    }
    const pages = new Map();
    const loadProblems = [];
    try {
      const m = await this.loadPages(rootRec.rootId);
      for (const [id, p] of m) pages.set(id, p);
    } catch (e) {
      loadProblems.push(e.message);
    }
    const corrupt = [];
    for (const p of pages.values()) {
      if (!verifyDigest(p)) corrupt.push(`已发布页 ${p.id} 摘要不匹配`);
    }
    return {
      rootRec,
      state: {
        rootId: rootRec.rootId, gen: rootRec.gen, pages,
        keySet: new Set(rootRec.keys ?? []), corrupt, loadProblems,
      },
    };
  }

  async recover() {
    // 重开复核与提交互斥：先取提交租约（他连接在途提交通常毫秒级结束；
    // 其真正死亡时租约在 TTL 后可被回收）。持约期间的一切发布/回收都安全。
    const holder = leaseHolder('recover');
    if (!(await this.acquireLease(holder))) {
      return this.recoverReadOnly('另一连接正在提交批次，本轮仅做只读复核：不发布新根、不回收页，请稍后重开');
    }
    try {
      return await this.recoverLocked();
    } finally {
      await this.releaseLease(holder);
    }
  }

  // 他连接持约且 TTL 内未结束时的只读复核：只依据已发布根给结论，不做任何写入
  async recoverReadOnly(note) {
    const { rootRec, state } = await this.loadPublished();
    this.state = state;
    if (!rootRec) {
      this.state.empty = true;
      return this.recoveryReport('FRESH', '空库，尚无已发布根');
    }
    if (state.loadProblems.length || state.corrupt.length) {
      return this.recoveryReport('PUBLISHED_ROOT_UNHEALTHY',
        `已发布根（代次 ${rootRec.gen}）健康检查失败：${[...state.loadProblems, ...state.corrupt].join('；')}。冻结于该根。${note}`);
    }
    return this.recoveryReport('INTACT', `未发现未完成批次，查询视图即已发布根。${note}`);
  }

  // 调用方已持有提交租约
  async recoverLocked() {
    const rootRec = await this.store.get(K_ROOT);
    const intent = await this.store.get(K_INTENT);

    if (!rootRec) {
      // 全新库
      this.state = { rootId: null, gen: 0, pages: new Map(), keySet: new Set(), empty: true, corrupt: [] };
      if (intent) await this.abandonIntent(intent, '无已发布根却存在意图，丢弃');
      return this.recoveryReport('FRESH', '空库，尚无已发布根');
    }

    const pages = new Map();
    const loadProblems = [];
    try {
      const m = await this.loadPages(rootRec.rootId);
      for (const [id, p] of m) pages.set(id, p);
    } catch (e) {
      loadProblems.push(e.message);
    }
    const corrupt = [];
    for (const p of pages.values()) {
      if (!verifyDigest(p)) corrupt.push(`已发布页 ${p.id} 摘要不匹配`);
    }
    const keySet = new Set(rootRec.keys ?? []);
    this.state = { rootId: rootRec.rootId, gen: rootRec.gen, pages, keySet, corrupt, loadProblems };

    let report;
    if (loadProblems.length || corrupt.length) {
      // 已发布根自身不可信：绝不自动改写，批次操作一律拒绝直到人工处理
      report = this.recoveryReport('PUBLISHED_ROOT_UNHEALTHY',
        `已发布根（代次 ${rootRec.gen}）健康检查失败：${[...loadProblems, ...corrupt].join('；')}。冻结于该根，不发布任何新根`);
      if (intent) await this.abandonIntent(intent, '已发布根不健康，未竟意图不予执行');
    } else if (!intent) {
      report = this.recoveryReport('INTACT', '未发现未完成批次，查询视图即已发布根');
      await this.gcUnreachable(pages); // 上次断电在新页阶段留下的半写入孤儿
    } else if (intent.rootId === rootRec.rootId || intent.gen === rootRec.gen) {
      // 根已切换后在清理前断电
      await this.store.delete(K_INTENT);
      await this.gcUnreachable(pages);
      report = this.recoveryReport('NEW_ROOT_PUBLISHED',
        `批次 ${intent.batchId} 的根指针已切换（代次 ${intent.gen}），仅补完清理；新树可完整遍历`);
    } else {
      report = await this.resolvePending(intent);
    }
    return report;
  }

  // 意图存在但根尚未切换：凭证据决定发布新根或退回旧根
  async resolvePending(intent) {
    const problems = [];
    const newPages = new Map(this.state.pages);
    for (const id of intent.pageIds) {
      const p = await this.store.get(K_PAGE(id));
      if (!p) { problems.push(`新页 ${id} 缺失（半写入）`); continue; }
      if (!verifyDigest(p)) { problems.push(`新页 ${id} 摘要损坏`); continue; }
      newPages.set(id, p);
    }
    let closureOk = true;
    if (problems.length === 0) {
      const w = { get: (id) => newPages.get(id) ?? null, out: new Map() };
      try {
        closure(w, intent.rootId);
      } catch (e) {
        closureOk = false;
        problems.push(e.message);
      }
    }

    if (problems.length === 0 && closureOk) {
      // 证据完整：根指针（含键集合）与提交回执在同一事务原子发布；
      // 调用方持提交租约，基准根在此期间不可能移动，CAS 再做一道防线。
      const receipt = await this.store.get(K_RECEIPT(intent.batchId));
      const writes = [[K_ROOT, {
        _id: K_ROOT, rootId: intent.rootId, gen: intent.gen,
        keys: [...(intent.keys ?? [])].sort((a, b) => a - b),
      }]];
      if (!receipt || receipt.gen !== intent.gen) {
        writes.push([K_RECEIPT(intent.batchId), committedReceipt(intent, this.now())]);
      }
      const cas = await this.store.commitRootIf(
        { rootId: this.state.rootId, gen: this.state.gen }, writes);
      if (!cas.ok) {
        // 理论上持约不会发生：保守退回，不发布、不回收，交下轮重开判定
        return this.recoveryReport('OLD_ROOT_RETAINED',
          `批次 ${intent.batchId} 发布时根基准已被他连接推进，本次不发布，请再次重开复核`);
      }
      await this.store.delete(K_INTENT);
      this.state = {
        rootId: intent.rootId, gen: intent.gen, pages: newPages,
        keySet: new Set(intent.keys ?? []), corrupt: [], loadProblems: [],
      };
      await this.gcUnreachable(newPages, intent.rootId);
      return this.recoveryReport('NEW_ROOT_PUBLISHED',
        `批次 ${intent.batchId} 的新页与意图均完整，发布代次 ${intent.gen} 新根，新树可从根完整遍历，旧版本页已不可查询`);
    }

    // 证据不足：退回旧根，清理该批次孤儿页与未竟意图（根指针从未改变）
    await this.store.delete(K_INTENT);
    await this.gcUnreachable(this.state.pages);
    await this.store.put(K_RECEIPT(intent.batchId), {
      batchId: intent.batchId, editDigest: intent.editDigest, status: 'rolled-back',
      gen: intent.gen, reason: problems.join('；'), createdAt: this.now(),
    });
    return this.recoveryReport('OLD_ROOT_RETAINED',
      `批次 ${intent.batchId} 持久化证据不完整（${problems.join('；')}），保留代次 ${this.state.gen} 旧根，半写入页不进入查询视图`);
  }

  recoveryReport(conclusion, detail) {
    const report = { conclusion, detail, at: this.now(), gen: this.state?.gen ?? 0 };
    this.lastRecovery = report;
    return report;
  }

  async initialize(entriesInput) {
    const entries = entriesInput.map(([k, v]) => [Number(k), String(v ?? '')]);
    validateInitial(entries);
    const holder = leaseHolder('init');
    if (!(await this.acquireLease(holder))) {
      throw new RuleError('LEASE_BUSY', '另一连接正在提交批次，初始录入未能取得提交租约，请稍后重试');
    }
    try {
      const existing = await this.store.get(K_ROOT);
      if (existing) {
        throw new RuleError('ALREADY_INITIALIZED', '索引已初始化，不能重复录入初始航点');
      }
      const gen = 1;
      const { rootId, pages: pageMap } = buildTree(gen, entries);
      const keys = entries.map(([k]) => k);
      // 先全部新页，最后在同一临界区切根——与批次同一套写时复制纪律
      for (const p of pageMap.values()) await this.store.put(K_PAGE(p.id), p);
      const cas = await this.store.commitRootIf({ rootId: null, gen: 0 }, [
        [K_ROOT, { _id: K_ROOT, rootId, gen, keys }],
      ]);
      if (!cas.ok) throw new RuleError('ALREADY_INITIALIZED', '索引已被另一连接初始化，不能重复录入初始航点');
      this.state = { rootId, gen, pages: pageMap, keySet: new Set(keys), corrupt: [], loadProblems: [] };
      return this.snapshot();
    } finally {
      await this.releaseLease(holder);
    }
  }

  // 清理指定根不可达的存储页（半写入孤儿 / 旧版本页），返回回收页数
  async gcUnreachable(keepPages, rootId = this.state.rootId) {
    const w = { get: (id) => keepPages.get(id) ?? null, out: new Map() };
    const keep = closure(w, rootId);
    const stored = await this.store.allPageIds();
    let removed = 0;
    for (const pk of stored) {
      const id = pk.slice(5);
      if (!keep.has(id)) {
        await this.store.delete(pk);
        removed++;
      }
    }
    return removed;
  }

  // 提交（或重试）一个批次。crashAt 用于复核演练断电中断。
  // 所有规则违反一律以 rejected 回执返回且不写任何页，绝不抛异常给调用方。
  //
  // 跨连接并发：整段三阶段提交在持久化“提交租约”临界区内完成；持约后重读
  // 当前已发布根作为基准（rebase），因此前一批先落盘后，本批会基于新根重算
  // 并推进到下一代（两批都可 committed，如 gen 2 与 gen 3）。切根再用根指针
  // CAS 兜底，保证 committed 回执必对应可闭合、可完整遍历的发布状态。
  async submitBatch(rawEdits, batchId, crashAt = CRASH_POINTS.NONE) {
    const editDigest = safeEditDigest(rawEdits);
    try {
      validateRequest({ batchId, edits: rawEdits });
    } catch (e) {
      if (e instanceof RuleError) return rejectReceipt(batchId, editDigest, e.code, e.message);
      throw e;
    }
    const edits = canonicalEdits(rawEdits);

    const holder = leaseHolder('submit:' + batchId);
    if (!(await this.acquireLease(holder))) {
      // 他连接持约超过等待窗口仍未完成（真实崩溃由 TTL 回收，此处只可能是长事务）：
      // 给出明确的“待恢复/可重试”结论，绝不基于可能过期的内存视图改根。
      return retryReceipt(batchId, editDigest, 'LEASE_BUSY',
        '另一连接的提交临界区长时间未结束，本批未写入；请重开复核后用同一批次标识重试');
    }

    try {
      // 同批次重传（持约后再判定，避免与在途提交竞态）：
      // 等价编辑 -> 回放原回执；内容不同 -> 冲突拒绝
      const prior = await this.store.get(K_RECEIPT(batchId));
      if (prior) {
        if (prior.editDigest !== editDigest) {
          return rejectReceipt(batchId, editDigest, 'CONFLICT_BATCH_CONTENT',
            `批次标识 ${batchId} 已用于不同内容的编辑（原摘要 ${prior.editDigest}），拒绝改写历史`);
        }
        return { ...prior, replayed: true };
      }

      // 以持久化中的当前已发布根为唯一基准（而非可能过期的连接内存视图）
      const { state: base } = await this.loadPublished();
      this.state = base;
      if (base.corrupt?.length || base.loadProblems?.length) {
        const e = base.corrupt.length
          ? new RuleError('CORRUPT_DIGEST', base.corrupt.join('；'))
          : new RuleError('BROKEN_REFERENCE', base.loadProblems.join('；'));
        return rejectReceipt(batchId, editDigest, e.code, e.message);
      }

      const intent = await this.store.get(K_INTENT);
      if (intent && intent.batchId !== batchId) {
        return rejectReceipt(batchId, editDigest, 'OTHER_BATCH_PENDING',
          `尚有批次 ${intent.batchId} 未完成恢复判定，请先重开复核`);
      }
      // intent.batchId === batchId：上次同批次中断、尚无回执的续做，
      // 下面走正常三阶段；内容寻址使新页幂等覆盖。

      const baseRootId = base.rootId;
      const baseGen = base.gen;
      const gen = baseGen + 1;
      let result;
      try {
        result = applyEdits(base.pages, baseRootId, gen, edits);
      } catch (e) {
        if (e instanceof RuleError) return rejectReceipt(batchId, editDigest, e.code, e.message);
        throw e;
      }
      // applyEdits 成功即代表全部编辑有效；计算提交后的已发布键集合（与根同事务落盘）
      const nextKeys = [...keysAfter(base.keySet ?? new Set(), edits)].sort((a, b) => a - b);

      const newPages = [...result.pages.values()];
      const intentRec = {
        batchId, editDigest, gen, rootId: result.rootId, keys: nextKeys,
        pageIds: newPages.map((p) => p.id), createdAt: this.now(),
      };

      // 阶段 1：逐页持久化（崩溃可留下部分半写入页）
      for (let i = 0; i < newPages.length; i++) {
        await this.store.put(K_PAGE(newPages[i].id), newPages[i]);
        if (crashAt === CRASH_POINTS.DURING_PAGES && i === 0) {
          return await this.interrupt(holder, crashAck(batchId, editDigest, gen, 'PAGES',
            `断电于新页写入途中：${i + 1}/${newPages.length} 页已落盘，无意图、根未切换`));
        }
      }
      if (crashAt === CRASH_POINTS.AFTER_PAGES) {
        return await this.interrupt(holder, crashAck(batchId, editDigest, gen, 'PAGES',
          `断电于新页全部写入后、意图留下前：${newPages.length} 页成为旧根不可达的孤儿候选`));
      }

      // 阶段 2：留下批次意图
      await this.store.put(K_INTENT, intentRec);
      if (crashAt === CRASH_POINTS.AFTER_INTENT) {
        return await this.interrupt(holder, crashAck(batchId, editDigest, gen, 'INTENT',
          '断电于意图持久化后、根切换前：重开时凭页与意图证据决定发布或退回'));
      }

      // 阶段 3：单事务 CAS——仅当根指针仍停在本批基准根时，才原子写入根与回执。
      const cas = await this.store.commitRootIf(
        { rootId: baseRootId, gen: baseGen },
        [
          [K_ROOT, { _id: K_ROOT, rootId: result.rootId, gen, keys: nextKeys }],
          [K_RECEIPT(batchId), committedReceipt(intentRec, this.now())],
        ],
      );
      if (!cas.ok) {
        // 持约下理论上不会发生：保守处理为可重试冲突，绝不覆盖他连接已发布的根。
        await this.store.delete(K_INTENT);
        const fresh = await this.loadPublished();
        this.state = fresh.state;
        if (fresh.state.rootId != null) await this.gcUnreachable(fresh.state.pages, fresh.state.rootId);
        return retryReceipt(batchId, editDigest, 'ROOT_ADVANCED',
          `提交瞬间根基准已被他连接推进到代次 ${fresh.state.gen}，本批未改根；请基于新根重试`);
      }
      if (crashAt === CRASH_POINTS.AFTER_ROOT) {
        return await this.interrupt(holder, crashAck(batchId, editDigest, gen, 'COMMIT',
          '断电于根切换后、意图清理前：新根已经是可查询视图，重开仅补清理'));
      }
      await this.store.delete(K_INTENT);
      // 回收旧版本页：新根不可达的页一律清除，任何时刻可查询视图只含当前根
      const combined = this.allPagesAfter(base, result);
      await this.gcUnreachable(combined, result.rootId);

      this.state = { rootId: result.rootId, gen, pages: combined, keySet: new Set(nextKeys), corrupt: [], loadProblems: [] };
      return { ...committedReceipt(intentRec, this.now()), replayed: false };
    } finally {
      await this.releaseLease(holder);
    }
  }

  // 模拟断电：进程死亡后不再持有租约，故释放租约记录，其余持久化证据原样保留。
  async interrupt(holder, ack) {
    await this.releaseLease(holder);
    return ack;
  }

  allPagesAfter(base, result) {
    const all = new Map(base.pages);
    for (const [id, p] of result.pages) all.set(id, p);
    const w = { get: (id) => all.get(id) ?? null, out: new Map() };
    const keep = closure(w, result.rootId);
    for (const id of [...all.keys()]) if (!keep.has(id)) all.delete(id);
    return all;
  }

  lookup(key) {
    let id = this.state.rootId;
    while (id) {
      const p = this.state.pages.get(id);
      if (!p) throw new RuleError('BROKEN_REFERENCE', `查询遇无法闭合的引用: ${id}`);
      if (p.type === 'leaf') {
        const i = p.keys.indexOf(key);
        return i < 0 ? null : { key, value: p.values[i], pageId: id };
      }
      let i = 0;
      while (i < p.keys.length && key >= p.keys[i]) i++;
      id = p.children[i];
    }
    return null;
  }

  snapshot() {
    const snap = snapshotOf(this.state.pages, this.state.rootId, this.state.gen, this.lastRecovery);
    if (this.state.keySet) snap.audit = auditKeys(snap, this.state.keySet);
    return snap;
  }
}

function committedReceipt(intent, at) {
  return {
    batchId: intent.batchId, editDigest: intent.editDigest, status: 'committed',
    gen: intent.gen, rootId: intent.rootId, committedAt: at,
  };
}

function rejectReceipt(batchId, editDigest, code, reason) {
  return { batchId, editDigest, status: 'rejected', code, reason, replayed: false };
}

// 可重试边界：本批未改根、未产生已发布状态，调用方可在重开复核后用同一批次标识重试
function retryReceipt(batchId, editDigest, code, reason) {
  return { batchId, editDigest, status: 'retryable', code, reason, replayed: false };
}

function crashAck(batchId, editDigest, gen, stage, note) {
  return { batchId, editDigest, status: 'interrupted', gen, stage, note, replayed: false };
}

// 每次临界区一个唯一持约标识（同一连接上的并发提交也互为不同持约者）
let leaseSeq = 0;
function leaseHolder(kind) {
  leaseSeq += 1;
  return `${kind}#${leaseSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- 只读视图：根代次、可达页、有序叶序列、键恰好一次校验 ----

export function snapshotOf(pages, rootId, gen, recovery = null) {
  const pageList = [];
  const leafOrder = [];
  let reachable = 0;
  let internalCount = 0;
  let leafCount = 0;
  let badRefs = [];

  if (rootId) {
    const seen = new Set();
    const walk = (id, depth) => {
      if (seen.has(id)) return;
      seen.add(id);
      const p = pages.get(id);
      if (!p) { badRefs.push(id); return; }
      reachable++;
      if (p.type === 'internal') {
        internalCount++;
        pageList.push({ id: p.id, type: 'internal', gen: p.gen, depth, keys: [...p.keys], children: [...p.children], digest: p.digest });
        for (const c of p.children) walk(c, depth + 1);
      } else {
        leafCount++;
        pageList.push({ id: p.id, type: 'leaf', gen: p.gen, depth, keys: [...p.keys], values: [...p.values], digest: p.digest });
      }
    };
    walk(rootId, 0);
    // 按键有序的叶序列：沿树结构按子节点顺序中序遍历（B 树序即键序）
    if (badRefs.length === 0) {
      for (const p of orderedLeaves(pages, rootId)) {
        for (let i = 0; i < p.keys.length; i++) {
          leafOrder.push({ key: p.keys[i], value: p.values[i], pageId: p.id });
        }
      }
    }
  }

  const keys = leafOrder.map((x) => x.key);
  const sorted = keys.every((k, i) => i === 0 || keys[i - 1] < k);
  const unique = new Set(keys).size === keys.length;
  return {
    order: ORDER,
    rootId,
    gen,
    reachablePages: reachable,
    internalCount,
    leafCount,
    pages: pageList.sort((a, b) => (a.depth - b.depth) || a.id.localeCompare(b.id)),
    leafSequence: leafOrder,
    keyCount: keys.length,
    ordered: sorted,
    allKeysOnce: sorted && unique,
    badReferences: badRefs,
    recovery,
  };
}

// 对照期望键集合核验“分裂后所有键仍恰好一次”
export function auditKeys(snapshot, expectedKeys) {
  const got = snapshot.leafSequence.map((x) => x.key);
  const exp = [...expectedKeys].sort((a, b) => a - b);
  const missing = exp.filter((k) => !got.includes(k));
  const extra = got.filter((k) => !expectedKeys.has(k));
  const dupes = got.filter((k, i) => got.indexOf(k) !== i);
  return {
    pass: snapshot.allKeysOnce && missing.length === 0 && extra.length === 0 && dupes.length === 0,
    expectedCount: expectedKeys.size,
    actualCount: got.length,
    missing, extra, dupes,
    ordered: snapshot.ordered,
  };
}

export { RuleError, ORDER };
