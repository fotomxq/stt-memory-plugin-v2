// ============================================================
// ui/snapshots.js —— 快照链界面（V1 数据管理/调试页的快照区块）
// 动作与 V1 同名：`snapCreate`（立即建根）/ `snapRestore`（回滚）/ `snapDelete`（删单个）/ `snapConsolidate`（整理：多根合并 + 超限并入根）
//   / `snapshotClear`（清空全部快照，**不动记忆本体**）；列表展示：类型 / 时间 / 条目数 / 基线。
// 口径：内核快照函数逐字移植（core/snapshots.js），本模块只做渲染与动作转发（可在无 DOM 环境完整测）。
// ============================================================
import { state } from '../core/model/runtime.js';
import { snapshotCreateFull, snapshotConsolidate, snapshotRestore, snapshotClear, snapshotStats, SNAP_CAP } from '../core/snapshots.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = esc;

/** 快照列表（按时间序） */
function snaps() { try { return Array.isArray(state.snapStore) ? state.snapStore : []; } catch (e) { return []; } }

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
                + '<button class="ftt-btn ftt-sm" data-ftt-action="snapRestore" data-ftt-snap-id="' + attr(s.id) + '" title="回滚到该快照时刻">↩ 还原</button>'
                + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="snapDelete" data-ftt-snap-id="' + attr(s.id) + '" title="删除该快照（不影响记忆本体）">🗑</button></div>';
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
 * @param {string} action snapCreate | snapRestore | snapDelete | snapConsolidate | snapshotClear | snapStats
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
        } else if (a === 'snapConsolidate') { result = Object.assign({ ok: true, action: a }, snapshotConsolidate()); }
        else if (a === 'snapshotClear') { snapshotClear(); result = { ok: true, action: a, cleared: true }; }
        else if (a === 'snapStats') { result = { ok: true, action: a, stats: snapshotStats() }; }
        else result = { ok: false, action: a, reason: 'unknown-action' };
    } catch (e) { result = { ok: false, action: a, reason: 'error', error: String((e && e.message) || e) }; }
    return Object.assign(result, { html: snapshotSectionHtml() });
}
