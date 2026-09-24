// ============================================================
// ui/snapshots.js —— 快照链界面（V1 数据管理/调试页的快照区块）
// 动作与 V1 同名：`snapCreate`（立即建根）/ `snapInspect`→`snapshotInspect`（查看快照内容）/ `snapRestore`（回滚）/ `snapDelete`（删单个）
//   / `snapConsolidate`（整理：多根合并 + 超限并入根）/ `snapshotClear`（清空全部快照，**不动记忆本体**）；列表展示：类型 / 时间 / 条目数 / 基线。
//   注：V1 `snapshotInspect` 用 `alert()` 弹出清单；V2 无阻塞弹窗，改为**行内展开**（信息内容与 V1 一致：类别 · 摘要 60 字截断）。
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

/** 快照区块 HTML（统计 + 工具行 + 列表） */
export function snapshotSectionHtml() {
    const st = snapshotStats();
    const list = snaps();
    const rows = list.length
        ? list.map((s) => {
            const n = Object.keys(s.atoms || {}).length;
            const del = Object.keys(s.deleted || {}).length;
            return '<div class="ftt-item ftt-inline"><span class="ftt-grow"><b>' + (s.kind === 'root' ? '🌱 根快照' : '➕ 增量') + '</b> '
                + '<span class="ftt-muted">' + esc(String(s.id).slice(0, 22)) + ' · ' + esc(String(s.ts || '')) + ' · ' + n + ' 条'
                + (del ? (' · 删除账本 ' + del) : '') + (s.baseId ? (' · 基线 ' + esc(String(s.baseId).slice(0, 12))) : '') + '</span></span>'
                + '<button class="ftt-btn ftt-sm" data-ftt-action="snapshotInspect" data-ftt-snap-id="' + attr(s.id) + '" title="查看该快照备份的原子">🔍</button>'
                + '<button class="ftt-btn ftt-sm" data-ftt-action="snapRestore" data-ftt-snap-id="' + attr(s.id) + '" title="回滚到该快照时刻">↩ 还原</button>'
                + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="snapDelete" data-ftt-snap-id="' + attr(s.id) + '" title="删除该快照（不影响记忆本体）">🗑</button></div>'
                + (String(inspectId) === String(s.id) ? inspectHtml(s) : '');
        }).join('')
        : '<div class="ftt-empty">（暂无快照；保存时自动建立根快照，之后按防抖写入增量）</div>';
    return [
        '<h4 class="ftt-h4-inline">🧬 快照链 <span class="ftt-muted">共 ' + st.total + '（根 ' + st.root + ' / 增量 ' + st.incr + '）· 覆盖 ' + st.covered + ' 条 · 上限 ' + SNAP_CAP + '</span></h4>',
        '<div class="ftt-hint">根快照 = 全量基线；增量 = 变更补全。回滚按「该快照及之前所有快照」的时间线并集重建，且**尊重删除账本**（不会复活已删条目）。</div>',
        '<div class="ftt-row">',
        '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="snapCreate">🌱 立即建根快照</button>',
        '<button class="ftt-btn ftt-sm" data-ftt-action="snapConsolidate" title="多根合并为一个；总量超上限时把最早 15 个增量并入根">🧹 整理（并入根）</button>',
        '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="snapshotClear" title="清空全部快照（不动记忆本体）">🗑 清空快照</button>',
        '</div>',
        rows,
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
