// ============================================================
// ui/snapshots.js —— 快照链界面（V1 数据管理/调试页的快照区块）
// 动作与 V1 同名：`snapCreate`（立即建根）/ `snapInspect`→`snapshotInspect`（查看快照内容）/ `snapRestore`（回滚）/ `snapDelete`（删单个）
//   / `snapConsolidate`（整理：多根合并 + 超限并入根）/ `snapshotClear`（清空全部快照，**不动记忆本体**）。
//   注：V1 `snapshotInspect` 用 `alert()` 弹出清单；V2 无阻塞弹窗，改为**行内展开**（信息内容与 V1 一致：类别 · 摘要 60 字截断）。
// v2.54.0（用户要求「展示信息**仅为统计信息**，而不是具体明细；核对该内容的一致性」）：
//   数据管理页默认只渲染**统计行**（`snapshotStatText()`：条数/根/增量/可还原原子/删除台账/占用/上限）+ 三个动作；
//   逐条明细（🔍 查看 / ↩ 还原 / 🗑 删除）收进默认折叠的「🔧 高级」details，统计与明细同源（都从 `state.snapStore` 现算）。
// 口径：内核快照函数逐字移植（core/snapshots.js），本模块只做渲染与动作转发（可在无 DOM 环境完整测）。
// ============================================================
import { state } from '../core/model/runtime.js';
import { snapshotCreateFull, snapshotConsolidate, snapshotRestore, snapshotClear, snapshotStats, SNAP_CAP } from '../core/snapshots.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = esc;

/** 快照列表（按时间序） */
function snaps() { try { return Array.isArray(state.snapStore) ? state.snapStore : []; } catch (e) { return []; } }

/** 快照内容查看：当前展开的快照 id（'' = 未展开） */
let inspectId = '';
/** 类别中文名（V1 `snapshotInspect` 内的同名映射） */
const CAT_CN = { atoms: '情节', currentStates: '状态', snapshots: '角色', memories: '记忆', items: '物品', currencies: '货币', plans: '计划', suspense: '悬念', scenes: '场景', concepts: '概念', parallels: '平行' };
/** 摘要字段优先级（V1 原样）：text → content → title → name → value → pathStr */
function briefOf(a) { return String((a && (a.text || a.content || a.title || a.name || a.value || a.pathStr)) || ''); }
/**
 * 快照内容清单（V1 `snapshotInspect` 的清单口径）。
 * @param {string} id 快照 id
 * @returns {Array<{id:string,cat:string,catLabel:string,brief:string}>|null} 快照不存在 → null
 */
export function snapshotInspectItems(id) {
    const hit = snaps().filter((s) => s && String(s.id) === String(id))[0];
    if (!hit) return null;
    const map = hit.atoms || {};
    return Object.keys(map).map((aid) => {
        const a = map[aid] || {};
        const cat = String(a.__cat || '');
        return { id: aid, cat, catLabel: CAT_CN[cat] || cat, brief: briefOf(a).slice(0, 60) };
    });
}
/** 是否正在展开某快照的内容 */
export function snapshotInspectState() { return inspectId; }
/** 行内展开块（V1 `alert` 的等价呈现；上限 300 行防超大快照卡顿） */
function inspectHtml(s) {
    const items = snapshotInspectItems(s.id) || [];
    const body = items.length
        ? items.slice(0, 300).map((x) => '<div class="ftt-hint ftt-pipe-line">' + esc(x.catLabel) + ' · ' + esc(x.brief) + '</div>').join('')
        : '<div class="ftt-hint ftt-pipe-line">（空）</div>';
    const more = items.length > 300 ? ('<div class="ftt-hint">（其余 ' + (items.length - 300) + ' 条已省略）</div>') : '';
    return '<div class="ftt-editor" data-ftt-snap-inspect="' + attr(s.id) + '">'
        + '<div class="ftt-hint">🔍 快照 ' + esc(String(s.id).slice(0, 18)) + '…（' + (s.kind === 'root' ? '根·全量' : '增量') + ' ' + esc(String(s.ts || '')) + '）'
        + '· 包含 ' + items.length + ' 条原子：</div>'
        + body + more + '</div>';
}

/** 字节数（真实 UTF-8 字节；无 TextEncoder 时退化为字符数） */
function byteLen(s) { try { if (typeof TextEncoder === 'function') return new TextEncoder().encode(String(s)).length; } catch (e) { /* 退化 */ } return String(s == null ? '' : s).length; }

/** 人类可读大小（统计行用；1 位小数） */
export function fmtBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
}

/**
 * 快照链**统计**（v2.54.0：数据管理页只展示统计，不铺明细）。
 * 口径：与「是否可还原」同源 —— total/root/incr/deleted 取 `snapshotStats()`（读取前先整理），
 *   `covered` = 各快照 `atomsHashes` 键并集（可回滚覆盖到的原子数），
 *   `bytes` = 快照链（root+增量）序列化后的真实 UTF-8 字节数。
 * @returns {{total:number,root:number,incr:number,covered:number,deleted:number,bytes:number,cap:number}}
 */
export function snapshotSummary() {
    const st = snapshotStats();
    const list = snaps();
    const bytes = (() => { try { return byteLen(JSON.stringify(list)); } catch (e) { return 0; } })();
    return { total: st.total, root: st.root, incr: st.incr, covered: st.covered, deleted: st.deleted, bytes: bytes, cap: SNAP_CAP };
}

/** 统计行文本（单一来源，页面上别处不再各算一份） */
export function snapshotStatText() {
    const s = snapshotSummary();
    return '共 ' + s.total + ' 条（根 ' + s.root + ' · 增量 ' + s.incr + '）· 可还原原子 ' + s.covered + ' 条 · 删除台账 '
        + s.deleted + ' 条 · 占用 ' + fmtBytes(s.bytes) + ' · 上限 ' + s.cap + ' 条';
}

/** 单条快照明细行（含查看/还原/删除） */
function snapRowHtml(s) {
    const n = Object.keys(s.atoms || {}).length;
    const del = Object.keys(s.deleted || {}).length;
    return '<div class="ftt-item ftt-inline"><span class="ftt-grow"><b>' + (s.kind === 'root' ? '🌱 根快照' : '➕ 增量') + '</b> '
        + '<span class="ftt-muted">' + esc(String(s.id).slice(0, 22)) + ' · ' + esc(String(s.ts || '')) + ' · ' + n + ' 条'
        + (del ? (' · 删除台账 ' + del) : '') + (s.baseId ? (' · 基线 ' + esc(String(s.baseId).slice(0, 12))) : '') + '</span></span>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="snapshotInspect" data-ftt-snap-id="' + attr(s.id) + '" title="查看该快照备份的原子">🔍</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="snapRestore" data-ftt-snap-id="' + attr(s.id) + '" title="用该快照及其之前的快照重建数据（不会复活已删条目）">↩ 还原</button>'
        + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="snapDelete" data-ftt-snap-id="' + attr(s.id) + '" title="删除该快照（不影响记忆本体）">🗑</button></div>'
        + (String(inspectId) === String(s.id) ? inspectHtml(s) : '');
}

/**
 * 快照区块 HTML（v2.54.0：**只有统计 + 动作**；逐条明细收进默认折叠的「高级」区）。
 * 用户要求：「展示信息仅为统计信息，而不是具体明细」。
 */
export function snapshotSectionHtml() {
    const list = snaps();
    const detail = list.length
        ? '<details class="ftt-details" data-ftt-snap-details' + (inspectId ? ' open' : '') + '>'
            + '<summary class="ftt-hint">🔧 高级：快照明细与还原（' + list.length + ' 条）</summary>'
            + '<div class="ftt-hint">还原 = 用该快照及其之前的快照重建数据；已删条目不会被复活。</div>'
            + list.slice().reverse().map(snapRowHtml).join('\n')
            + '</details>'
        : '';
    return [
        '<h4 class="ftt-h4-inline">🧬 快照链 <span class="ftt-muted" data-ftt-snap-stat>' + esc(snapshotStatText()) + '</span></h4>',
        '<div class="ftt-hint">保存时自动做的本地备份，用于回滚到某个时刻；清空快照不影响记忆本体。</div>',
        '<div class="ftt-row">',
        '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="snapCreate" title="立即把当前全部原子备份成一份全量快照">📸 立即建根快照</button>',
        '<button class="ftt-btn ftt-sm" data-ftt-action="snapConsolidate" title="多个根合并为一个；总量超上限时把最早 15 个增量并入根">🧹 整理快照链</button>',
        '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="snapshotClear" title="删除全部快照（不删除任何记忆条目）">🗑 清空快照</button>',
        '</div>',
        list.length ? '' : '<div class="ftt-empty">（暂无快照；首次保存会建立根快照）</div>',
        detail,
    ].join('\n');
}

/**
 * 快照动作（唯一入口）。
 * @param {string} action snapCreate | snapshotInspect（查看内容）| snapRestore | snapDelete | snapConsolidate | snapshotClear | snapStats
 */
export function snapshotAction(action, payload) {
    const p = payload || {};
    const a = String(action || '');
    let result = { ok: true, action: a };
    try {
        if (a === 'snapCreate') { const s = snapshotCreateFull(); result = { ok: !!s, action: a, id: s ? s.id : '', reason: s ? '' : '无原子（不建空根）' }; }
        else if (a === 'snapRestore') { result = Object.assign({ action: a }, snapshotRestore(String(p.id || p.snapId || ''))); }
        else if (a === 'snapDelete') {
            const id = String(p.id || p.snapId || '');
            const arr = snaps();
            const hit = arr.filter((s) => s && String(s.id) === id)[0];
            if (!hit) result = { ok: false, action: a, reason: 'not-found' };
            else { state.snapStore = arr.filter((s) => s && String(s.id) !== id); result = { ok: true, action: a, deleted: id }; }
        } else if (a === 'snapshotInspect') {
            // 查看快照内容（V1 同名动作；V1 用 `alert()`，V2 改为行内展开/再点收起）
            const id = String(p.id || p.snapId || '');
            const hit = snaps().filter((s) => s && String(s.id) === id)[0];
            if (!hit) result = { ok: false, action: a, reason: 'not-found' };
            else {
                inspectId = (String(inspectId) === id) ? '' : id;
                result = { ok: true, action: a, id: inspectId, items: snapshotInspectItems(id) || [] };
            }
        } else if (a === 'snapConsolidate') { result = Object.assign({ ok: true, action: a }, snapshotConsolidate()); }
        else if (a === 'snapshotClear') { snapshotClear(); inspectId = ''; result = { ok: true, action: a, cleared: true }; }
        else if (a === 'snapStats') { result = { ok: true, action: a, stats: snapshotStats() }; }
        else result = { ok: false, action: a, reason: 'unknown-action' };
    } catch (e) { result = { ok: false, action: a, reason: 'error', error: String((e && e.message) || e) }; }
    return Object.assign(result, { html: snapshotSectionHtml() });
}
