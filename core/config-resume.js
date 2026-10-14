// ============================================================
// core/config-resume.js —— **角色履历**的默认配置键（v3.49.1 由 `core/config.js` 外移）
//
// 为什么外移：同 `core/config-character.js`（`core/config.js` 的单体体量棘轮）。**键、值、注释逐字不变**。
// 口径：设计稿 `docs/D26`（§3.2 / §3.3 / §3.4 / §6）—— 履历是角色档案内的第 9 区块；
//   「上限 30 条 + 重要性 × 剧情时间 的遗弃 + ≤60 字凝练 + 历史/同人预填」四项都可配置；
//   算法唯一源 = `core/resume.js`（纯内核），本组键只提供口径，不重复实现算法。
// ============================================================

/** 履历默认键（由 `core/config.js#defaultCfg` 原位置展开） */
export const RESUME_DEFAULTS = Object.freeze({
    // ==================== v3.45.5：角色履历（`snapshots[].resume`，`docs/D22` W4 `数-19`/`数-20`/`数-21`） ====================
    // 设计稿 `docs/D26`（§3.2 / §3.3 / §3.4 / §6 决策记录）：履历是角色档案内的第 9 区块，
    //   「上限 30 条 + 重要性 × 剧情时间 的遗弃 + ≤60 字凝练 + 历史/同人预填」四项都可配置。
    //   算法唯一源：`core/resume.js`（纯内核）；本组键只提供口径，不重复实现算法。
    snapshotResumeEnabled: true,        // 履历总开关（关 = 不读不写、界面隐藏区块；`docs/D26` §3.5）
    snapshotResumeMax: 30,              // 单角色履历条数上限（**软阈值**：≤ 上限从不自动遗弃，仅超限时清算；`docs/D26` Q3）
    snapshotResumeTriggerRatio: 0.8,    // 「接近上限」预警比例（达到 上限×比例 起在体检/面板提示；**不触发删除**，见 `core/resume.js` 头注）
    snapshotResumeImmune: 0.7,          // 重要性免疫阈值（≥ 该值的条目不参与自动遗弃；`docs/D26` §3.3）
    snapshotResumeSummaryMax: 60,       // 凝练目标长度（单条简述 ≤ 该字数；`docs/D26` Q4，幂等）
    snapshotResumeCanonFill: true,      // 历史 / 同人人物「剧情前」履历预填开关（`docs/D26` §3.4；上界 = 剧情当下）
});
