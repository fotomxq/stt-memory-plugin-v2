// ============================================================
// ui/resume-repair.js —— 角色页「📜 补全 / 修复履历」的**动作实现**
//   （v3.46.4 由 `ui/panel.js` 内联分支外移；原落地：v3.45.5，`docs/D22` W4 `应-19` ②，设计稿 `docs/D26` §3.5）
//
// 为什么外移（`docs/05-开发指南.md` §5 **C11**：新功能落新模块，`panel.js` 只留**必要接线**）：
//   `ui/panel.js` 受 `docs/D22` W5 `技-14` **单体文件体量棘轮**约束，v3.46.3 时已到 4019 / 上限 4023（**仅剩 4 行**）；
//   本轮（v3.46.4）要在调度层加「管道请求守门」，故把这段 ~24 行的内联分支搬到本模块，**腾出体量**而不是上调基线。
//
// 口径（与搬家前**逐字一致**，只把 `setNote(...)` 改成**返回 `note`** 由面板统一写提示）：
//   针对**该个体**：机械段（排序 / 去重 / 遗弃 / 凝练，零 AI）→ 需要时窄契约 AI（补全 + 凝练）→ 复核
//   （原作人物补「剧情前」履历的硬护栏）→ **如实回报四类计数与跳过原因**。
//   入参：`id`（行内按钮的 `data-ftt-id`，由通用分发透传）优先；缺失时按 `name` 兜底。
// ============================================================
import { state } from '../core/model/runtime.js';
import { runResumeRepair } from '../core/character-repair.js';

/**
 * 执行「📜 补全 / 修复履历」。
 * @param {{id?:string, name?:string}} [p] 行内按钮的入参（`id` 优先，`name` 兜底）
 * @returns {Promise<{ok:boolean, note:string, resumeRepair:object, added:number}>} `note` 由调用方写进面板提示行
 */
export async function resumeRepairAction(p) {
    const pay = p || {};
    const snapId = String(pay.id || '');
    const target = (state.snapshots || []).find((x) => x && String(x.id) === snapId)
        || (state.snapshots || []).find((x) => x && String(x.name) === String(pay.name || ''));
    const r = await runResumeRepair(target ? String(target.name) : '', {});
    const parts = [];
    if (r.ok === false) {
        parts.push(r.reason === 'disabled' ? '履历功能已关闭（可在 设定 → 投喂范围 打开「履历」）'
            : (r.reason === 'no-role' ? '找不到该角色档案' : ('失败：' + String(r.reason || ''))));
    } else {
        parts.push('新增 ' + Number(r.added || 0) + ' 条');
        parts.push('凝练 ' + Number(r.condensed || 0) + ' 条');
        parts.push('遗弃 ' + Number(r.dropped || 0) + ' 条');
        if (Number(r.rejected || 0)) parts.push('拒收 ' + Number(r.rejected) + ' 条（晚于当前剧情日期，未写入）');
        if (r.aiSkipped === 'busy') parts.push('AI 正忙，本轮只做了整理');
        else if (r.aiSkipped === 'error') parts.push('AI 调用失败，本轮只做了整理');
        else if (r.aiSkipped === 'no-ai') parts.push('未调用 AI（只整理）');
        parts.push('现有 ' + Number(r.total || 0) + ' / ' + Number(r.max || 0) + ' 条');
    }
    return { ok: r.ok !== false, note: '履历：' + parts.join('；'), resumeRepair: r, added: r.added || 0 };
}
