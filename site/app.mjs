// 浏览器端控制层：连接 IndexedDB 与引擎，渲染录入、批次、断电演练与结果页。
import { Engine, CRASH_POINTS } from './src/engine.mjs';
import { IDBStore } from './src/store.mjs';

const $ = (id) => document.getElementById(id);
const els = {};
for (const id of [
  'recovery-banner', 'init-card', 'init-input', 'init-count', 'btn-init', 'btn-sample',
  'batch-card', 'batch-id', 'edit-table', 'edit-count', 'btn-add-edit', 'crash-point',
  'btn-submit', 'btn-reopen', 'btn-lookup', 'lookup-key', 'btn-reset',
  'receipt-out', 'r-gen', 'r-pages', 'r-kinds', 'r-keys', 'r-order-badge', 'r-once-badge',
  'r-rootid', 'audit-out', 'leafseq', 'pages-out',
]) els[id] = $(id);

let engine = null;
const DB_NAME = 'track-exchange-v1';

// ---------- 启动（本身就是一次重开复核） ----------

async function boot() {
  const store = await IDBStore.open(DB_NAME);
  engine = new Engine(store);
  const report = await engine.open();
  showRecovery(report);
  syncEditRows(1);
  if (engine.state?.rootId != null) {
    els['batch-id'].value = 'batch-' + Date.now().toString(36);
  }
  render();
  if (engine.state?.rootId == null) {
    els['init-input'].value = '10,航点十\n20,航点廿\n30,卅\n40,四十\n50,五十\n60,六十\n70,七十';
    recountInit();
  }
}

// ---------- 恢复横幅 ----------

const BANNER_CLASS = {
  FRESH: 'fresh',
  INTACT: 'intact',
  NEW_ROOT_PUBLISHED: 'new',
  OLD_ROOT_RETAINED: 'old',
  PUBLISHED_ROOT_UNHEALTHY: 'unhealthy',
};
const BANNER_TITLE = {
  FRESH: '空库',
  INTACT: '复核通过',
  NEW_ROOT_PUBLISHED: '发布完整新根',
  OLD_ROOT_RETAINED: '保留旧根',
  PUBLISHED_ROOT_UNHEALTHY: '已发布根不健康',
};

function showRecovery(report) {
  if (!report) { els['recovery-banner'].classList.add('hidden'); return; }
  const b = els['recovery-banner'];
  b.className = 'banner ' + (BANNER_CLASS[report.conclusion] ?? 'fresh');
  b.innerHTML = `<span class="banner-title">${BANNER_TITLE[report.conclusion] ?? report.conclusion}</span>` +
    `代次 ${report.gen} · ${escapeHtml(report.detail)}` +
    ` <span style="opacity:.6">（${report.at}）</span>`;
}

// ---------- 初始录入 ----------

function parseInit() {
  const lines = els['init-input'].value.split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.map((line) => {
    const idx = line.indexOf(',');
    const keyRaw = idx < 0 ? line : line.slice(0, idx);
    const value = idx < 0 ? '' : line.slice(idx + 1);
    return [Number(keyRaw.trim()), value.trim()];
  });
}

function recountInit() {
  const entries = parseInit();
  els['init-count'].textContent = entries.length;
  els['init-count'].style.color = entries.length > 24 ? 'var(--bad)' : '';
}

els['init-input'].addEventListener('input', recountInit);
els['btn-sample'].addEventListener('click', () => {
  els['init-input'].value = '10,航点十\n20,航点廿\n30,卅\n40,四十\n50,五十\n60,六十\n70,七十';
  recountInit();
});

els['btn-init'].addEventListener('click', async () => {
  let entries;
  try {
    entries = parseInit();
    for (const [k] of entries) {
      if (!Number.isInteger(k)) throw new Error('存在非整数键，请检查每行应为 “键,载荷”');
    }
    await engine.initialize(entries);
    showReceipt({ status: 'initialized', gen: 1, count: entries.length });
    els['batch-id'].value = 'batch-' + Date.now().toString(36);
    render();
  } catch (e) {
    showReceipt({ status: 'rejected', code: e.code ?? 'BAD_INPUT', reason: e.message });
  }
});

// ---------- 批次编辑表 ----------

function editRows() {
  return [...els['edit-table'].querySelectorAll('tbody tr')].map((tr) => ({
    op: tr.querySelector('.sel-op').value,
    key: tr.querySelector('.inp-key').value,
    value: tr.querySelector('.inp-value').value,
  }));
}

function setEditRows(rows) {
  const tbody = els['edit-table'].querySelector('tbody');
  tbody.innerHTML = '';
  for (const r of rows) tbody.appendChild(makeRow(r));
  recountEdits();
}

function syncEditRows(want) {
  const have = els['edit-table'].querySelectorAll('tbody tr').length;
  if (!have) setEditRows(Array.from({ length: want }, () => ({ op: 'insert', key: '', value: '' })));
}

function makeRow({ op = 'insert', key = '', value = '' } = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>
      <select class="sel-op">
        <option value="insert" class="op-insert">插入</option>
        <option value="update" class="op-update">更新</option>
        <option value="delete" class="op-delete">删除</option>
      </select>
    </td>
    <td><input class="inp-key" type="number" step="1" placeholder="整数键" /></td>
    <td><input class="inp-value" type="text" maxlength="200" placeholder="短文本（删除可留空）" /></td>
    <td><button class="btn-mini ghost" type="button">✕</button></td>`;
  tr.querySelector('.sel-op').value = op;
  tr.querySelector('.inp-key').value = key;
  tr.querySelector('.inp-value').value = value;
  tr.querySelector('button').addEventListener('click', () => { tr.remove(); recountEdits(); });
  tr.querySelector('.sel-op').addEventListener('change', () => {
    tr.querySelector('.inp-value').disabled = tr.querySelector('.sel-op').value === 'delete';
  });
  return tr;
}

function recountEdits() {
  const n = els['edit-table'].querySelectorAll('tbody tr').length;
  els['edit-count'].textContent = n;
  els['edit-count'].style.color = n > 12 ? 'var(--bad)' : '';
}

els['btn-add-edit'].addEventListener('click', () => {
  const n = els['edit-table'].querySelectorAll('tbody tr').length;
  if (n >= 12) { flashReceipt('每批至多 12 项'); return; }
  els['edit-table'].querySelector('tbody').appendChild(makeRow());
  recountEdits();
});

// ---------- 提交 / 重开 / 查询 / 抹库 ----------

function collectEdits() {
  return editRows()
    .filter((r) => r.key !== '' && r.key !== null && Number.isFinite(Number(r.key)))
    .map((r) => {
      const e = { op: r.op, key: Number(r.key) };
      if (r.op !== 'delete') e.value = r.value;
      return e;
    });
}

els['btn-submit'].addEventListener('click', async () => {
  const batchId = els['batch-id'].value.trim();
  const edits = collectEdits();
  const crashAt = els['crash-point'].value;
  const receipt = await engine.submitBatch(edits, batchId, crashAt);
  showReceipt(receipt);
  if (receipt.status === 'interrupted') {
    // 真实演练：直接模拟“进程死亡”，要求审查员点重开复核（或刷新页面）
    bannerInterrupt(receipt);
  }
  render();
});

els['btn-reopen'].addEventListener('click', async () => {
  const report = await engine.recover();
  showRecovery(report);
  showReceipt({ status: 'reopened', ...report });
  render();
});

els['btn-lookup'].addEventListener('click', () => {
  const k = Number(els['lookup-key'].value);
  if (!Number.isInteger(k)) { flashReceipt('请输入整数查询键'); return; }
  try {
    const hit = engine.lookup(k);
    showReceipt(hit
      ? { lookup: k, found: true, value: hit.value, pageId: hit.pageId }
      : { lookup: k, found: false });
  } catch (e) {
    showReceipt({ status: 'rejected', code: e.code, reason: e.message });
  }
});

els['btn-reset'].addEventListener('click', async () => {
  if (!confirm('确定抹除整个 IndexedDB 航迹库并重头开始？')) return;
  await engine.store.close();
  await new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = res; r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('删除被阻塞'));
  });
  location.reload();
});

function bannerInterrupt(receipt) {
  const b = els['recovery-banner'];
  b.className = 'banner old';
  b.innerHTML = `<span class="banner-title">⚡ 已模拟断电中断</span>阶段 ${receipt.stage} · ${escapeHtml(receipt.note)}。` +
    `此刻持久化状态未定，请点击「断电后重开复核」（或刷新页面）查看恢复结论。`;
}

function flashReceipt(msg) { showReceipt({ status: 'note', reason: msg }); }

function showReceipt(obj) {
  els['receipt-out'].textContent = JSON.stringify(obj, null, 2);
}

// ---------- 结果页渲染 ----------

function render() {
  const initialized = engine.state?.rootId != null;
  els['btn-init'].disabled = initialized;
  els['init-input'].disabled = initialized;
  els['btn-submit'].disabled = !initialized;
  if (!initialized) {
    ['r-gen', 'r-pages', 'r-kinds', 'r-keys'].forEach((k) => (els[k].textContent = '—'));
    els['r-rootid'].textContent = '尚未建立索引';
    els['leafseq'].innerHTML = '<div class="empty-hint">录入初始航点后展示。</div>';
    els['pages-out'].innerHTML = '<div class="empty-hint">尚无页。</div>';
    els['audit-out'].innerHTML = '<div class="empty-hint">尚无审计结果。</div>';
    setBadge('r-order-badge', false, '—');
    setBadge('r-once-badge', false, '—');
    return;
  }
  const snap = engine.snapshot();
  els['r-gen'].textContent = snap.gen;
  els['r-pages'].textContent = snap.reachablePages;
  els['r-kinds'].textContent = `${snap.internalCount} / ${snap.leafCount}`;
  els['r-keys'].textContent = snap.keyCount;
  els['r-rootid'].textContent = snap.rootId;
  setBadge('r-order-badge', snap.ordered, snap.ordered ? '严格递增' : '失序');
  setBadge('r-once-badge', snap.allKeysOnce, snap.allKeysOnce ? '是' : '否');
  renderAudit(snap);
  renderLeafSequence(snap);
  renderPages(snap);
}

function setBadge(id, ok, text) {
  const b = els[id];
  b.classList.toggle('ok', !!ok && text !== '—');
  b.classList.toggle('fail', !ok && text !== '—');
  b.querySelector('strong').textContent = text;
}

function renderAudit(snap) {
  const a = snap.audit;
  if (!a) { els['audit-out'].innerHTML = ''; return; }
  const chip = (k) => `<span class="chip bad-chip">${escapeHtml(String(k))}</span>`;
  const lines = [];
  lines.push(['pass', a.pass ? '✔' : '✘',
    a.pass
      ? `分裂审计通过：期望 ${a.expectedCount} 键，叶序实得 ${a.actualCount} 键，全部严格有序且每键恰好出现一次。`
      : `审计未通过：期望 ${a.expectedCount} 键，实得 ${a.actualCount} 键。`]);
  if (!a.ordered) lines.push(['fail', '✘', '叶序列并非严格按键递增。']);
  if (a.dupes.length) lines.push(['fail', '✘', `重复出现的键：${a.dupes.map(chip).join('')}`]);
  if (a.missing.length) lines.push(['fail', '✘', `丢失的键：${a.missing.map(chip).join('')}`]);
  if (a.extra.length) lines.push(['fail', '✘', `多余的键：${a.extra.map(chip).join('')}`]);
  if (snap.badReferences.length) {
    lines.push(['fail', '✘', `无法闭合的子页引用：${snap.badReferences.map(chip).join('')}`]);
  }
  els['audit-out'].innerHTML = lines
    .map(([cls, mark, text]) => `<div class="line ${cls}"><span class="mark">${mark}</span><span>${text}</span></div>`)
    .join('');
}

function renderLeafSequence(snap) {
  // 按叶页分组（snap.leafSequence 每项带 pageId），交替底色
  const groups = [];
  for (const item of snap.leafSequence) {
    let g = groups[groups.length - 1];
    if (!g || g.pageId !== item.pageId) { g = { pageId: item.pageId, items: [] }; groups.push(g); }
    g.items.push(item);
  }
  if (!groups.length) {
    els['leafseq'].innerHTML = '<div class="empty-hint">空树（无键）。</div>';
    return;
  }
  els['leafseq'].innerHTML = groups.map((g, i) => {
    const short = g.pageId.slice(0, 10);
    const cells = g.items.map((it) =>
      `<div class="kv"><div class="k">${it.key}</div><div class="v">${escapeHtml(it.value)}</div></div>`).join('');
    const arrow = i < groups.length - 1 ? '<span class="leaf-arrow">→</span>' : '';
    return `<span class="leaf-block ${i % 2 ? 'b' : 'a'}"><span class="leaf-head">叶 ${short}… · ${g.items.length} 键</span>` +
      `<span class="cells">${cells}</span></span>${arrow}`;
  }).join('');
}

function renderPages(snap) {
  els['pages-out'].innerHTML = snap.pages.map((p) => {
    if (p.type === 'leaf') {
      const cells = p.keys.map((k, i) =>
        `<span class="kv" style="display:inline-block;padding:2px 8px"><b>${k}</b>=${escapeHtml(p.values[i])}</span>`).join('');
      return `<div class="page-box leaf">
        <div class="page-head"><span class="tag">叶页</span><span>代次 ${p.gen} · 深 ${p.depth} · ${p.keys.length} 键</span>
        <span class="pdigest">digest ${p.digest}</span><span class="pid">${p.id}</span></div>
        <div class="page-body">${cells || '<span style="color:var(--muted)">（空叶）</span>'}</div></div>`;
    }
    const layout = [];
    for (let i = 0; i < p.children.length; i++) {
      layout.push(`<span class="child-ref" title="子页引用">${p.children[i].slice(0, 10)}…</span>`);
      if (i < p.keys.length) layout.push(`<span class="arrow">◀</span><span class="sep">[${p.keys[i]}]</span><span class="arrow">▶</span>`);
    }
    return `<div class="page-box internal">
      <div class="page-head"><span class="tag">内部页</span><span>代次 ${p.gen} · 深 ${p.depth} · ${p.children.length} 子 / ${p.keys.length} 分隔键</span>
      <span class="pdigest">digest ${p.digest}</span><span class="pid">${p.id}</span></div>
      <div class="page-body">${layout.join('')}</div></div>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot().catch((e) => {
  els['recovery-banner'].className = 'banner unhealthy';
  els['recovery-banner'].innerHTML = `<span class="banner-title">启动失败</span>${escapeHtml(e.stack || e.message)}`;
});
