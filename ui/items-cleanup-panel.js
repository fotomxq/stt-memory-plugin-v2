// ============================================================
// ui/items-cleanup-panel.js —— **物品页：清理未关注角色的物品**（v3.52.2 W34 `应-54`）
//
// 用户要求：「物品新增按钮，可清理未关注角色的物品。注意清理前，需先排查询问用户，
//   列出即将清理掉的物品清单，然后确认后再删除。」
//
// 交互（**两步式，先预览清单再确认**）：
//   ① 工具栏「🧹 清理未关注角色的物品」→ 展开**只读预览**（逐条清单 + 按归属分组 + 保留/未归属统计）；
//   ② 预览里「确认清理」走**危险动作二次确认**（`DANGER_ACTION_PROMPTS['itemsCleanupApply']`）→ 落库（逐条墓碑）。
// 状态位在本模块（`open`），与 `currencyRepair` 同口径；面板只做 3 行接线。
// ============================================================
import { itemsCleanupPlan, applyItemsCleanup } from '../core/items-cleanup.js';
import { previewCardHtml } from './preview-card.js';

let cleanupOpen = false;
let lastPlan = null;

/** 预览面板开关态（测试 / 调试用） */
export function itemsCleanupState() { return { open: cleanupOpen, total: lastPlan ? lastPlan.total : 0 }; }
/** 开 / 关预览（关闭即丢弃计划，不写任何数据） */
export function setItemsCleanupOpen(v) { cleanupOpen = v === true; if (!cleanupOpen) lastPlan = null; return cleanupOpen; }

/** 物品页工具行按钮（只在物品页出现） */
export function itemsCleanupBarHtml() {
    return '<button class="ftt-btn ftt-sm" data-ftt-action="itemsCleanup" title="列出「未关注角色」名下、即将被清理的物品（先预览，确认后才删除；未归属物品不动）">🧹 清理未关注角色的物品</button>';
}

/** 预览面板（未打开 → 空串） */
export function itemsCleanupPanelHtml() {
    if (!cleanupOpen) return '';
    const plan = itemsCleanupPlan();
    lastPlan = plan;
    if (!plan.total) {
        return '<div class="ftt-editor ftt-preview-card" data-ftt-items-cleanup>'
            + '<div class="ftt-preview-title">🧹 清理未关注角色的物品</div>'
            + '<div class="ftt-preview-summary">' + plan.note + '</div>'
            + '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="itemsCleanupClose">关闭</button></div></div>';
    }
    const rows = plan.items.map((it) => ({
        op: 'del',
        before: it.name + (it.owner ? ('（' + it.owner + (it.inferred ? '·推断' : '') + '）') : ''),
        after: '',
        note: [it.qty ? ('×' + it.qty) : '', it.location ? ('@' + it.location) : '', it.carried ? '' : '未携带'].filter(Boolean).join(' '),
    }));
    const groups = plan.byOwner.map((g) => g.owner + '×' + g.count).join('、');
    return '<div data-ftt-items-cleanup>'
        + previewCardHtml({
            title: '🧹 清理未关注角色的物品',
            summary: '将删除 ' + plan.total + ' 件（' + groups + '）；属于关注角色 / 主角的 ' + plan.kept + ' 件保留，未归属的 ' + plan.unowned + ' 件不动'
                + (plan.inferred ? ('；其中 ' + plan.inferred + ' 件按「位置是角色名且随身携带」推断归属（标「推断」）') : '') + '。',
            badge: '预览 · 未删除',
            sections: [{ label: '① 将清理的物品清单', rows: rows }],
            footer: '确认后会逐条写入删除记录（跨端不会复活）；建议先导出备份。',
        })
        + '<div class="ftt-row"><button class="ftt-btn ftt-primary" data-ftt-action="itemsCleanupApply" title="按上面的清单删除（会再次弹确认框）">✅ 确认清理</button>'
        + '<button class="ftt-btn" data-ftt-action="itemsCleanupClose">取消</button></div></div>';
}

/** 面板动作统一入口（返回统一结果结构；`itemsCleanup*` 三类动作共用） */
export function itemsCleanupAction(action) {
    const a = String(action || '');
    if (a === 'itemsCleanup') { setItemsCleanupOpen(true); return { ok: true, note: '清理预览：已列出清单，确认前不会删除任何数据' }; }
    if (a === 'itemsCleanupClose') { setItemsCleanupOpen(false); return { ok: true, note: '清理预览已关闭（数据未改动）' }; }
    if (a === 'itemsCleanupApply') {
        const r = applyItemsCleanup(lastPlan);
        setItemsCleanupOpen(false);
        return Object.assign({ ok: r.ok, removed: r.removed, failed: r.failed }, { note: r.note });
    }
    return { ok: false, err: 'unknown-action', note: '未知清理动作' };
}
