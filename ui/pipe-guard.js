// ============================================================
// ui/pipe-guard.js —— **管道请求守门**（v3.46.4，`docs/D22` `应-31`）
//
// 用户要求（原话）：「上一个版本修复的内容，如果发起管道请求操作，应该有弹窗提示。核对相关按钮是否存在
//   排重点击的机制，避免用户反复点击触发。」
//   裁决（本轮）：① 弹窗形式 = **开工弹窗提示**（沿用仓内既有 `panelNotify('info', '…开始…')` 惯例，不加二次确认）；
//                ② 覆盖面 = **全部管道请求类动作**统一纳入。
//
// 为什么需要它（核对结论，本轮实测）：
//   · 会发 AI 请求的动作**只检查共享的 `aiBusy()`**（那是「摘要 / 提取 / 同步在途」的忙位，**不含自己这次请求**），
//     于是**连点两下 → 两次检查都为假 → 真的发两次 AI 请求**（重复烧 token）；
//   · 尤其 `runResumeRepair` 此前**连 `aiBusy()` 都没有**；
//   · 在途期间按钮**不会 `disabled`** → 用户看不出「已经点过了」，视觉上鼓励继续点。
//
// 本模块提供三件事（`docs/D9` §10 **U15** 的三条口径）：
//   ① **同动作排重**：同一动作上一次未结束前，再点**一律挡下**（不是静默忽略：写提示行 + 弹一次 warning）；
//   ② **开工弹窗提示**：登记的管道动作**真正开工时**弹一条 `🔄 <动作>：已发起 AI 请求（管道请求）…`；
//      —— 已经自带「开始…」提示的动作（如 `summary` / `summaryFloor`）标 `selfNotice`，**不重复弹**；
//   ③ **在途禁用**：渲染时给在途动作的按钮注入 `disabled`，让用户**看得见**「现在点不动」。
//
// 三条不变量（都被单测锁住）：
//   · **排重按「动作名」**（不是全局串行）：同一按钮防连点，不同按钮仍可并行（与 `aiBusy()` 的分工不变）；
//   · **一定会释放**：释放点在 `panelAction` 的统一收尾（`finalizePanelAction`），**成功 / 失败 / 异常 / 早退**都过；
//   · **安全阀**：万一某次请求卡死（或释放点被绕过），超过 `PIPE_MAX_MS` 自动放行并**如实计数** ——
//     绝不把按钮永久锁死（与 `docs/D22` `技-1` 的落盘守门同一套哲学：宁可放行，也不静默卡死）。
//
// **不在册的两个动作（有意）**：`summary` / `summaryFloor` —— 它们**本来就有自己的在途闸**，且 `summaryFloor`
//   是**按楼层**判重（比本表的「按动作名」更细），并且**开工提示本就自己弹**。并入统一守门＝用更粗的粒度
//   覆盖更细的（实测会把第二次点击的拒因文案改写 → smoke BJ1 变红），故**不并入**，只在文档里写明分工。
// ============================================================

/** 同一次请求最长允许占用多久；超过即自动放行（并计数），避免按钮永久点不动 */
export const PIPE_MAX_MS = 300000;    // 5 分钟

/**
 * **管道请求类动作登记表**（`docs/D9` §10 U15 的固定清单）。
 *   `label` = 开工提示里的动作名（面向用户的中文）；
 *   `selfNotice: true` = 该动作**自己**已经弹过「开始…」提示（如 `panelNotify('info','AI 摘要：开始分析…')`），
 *     本模块**只做排重与禁用、不再补弹**，避免同一次点击弹两条。
 */
export const PIPE_ACTIONS = Object.freeze({
    // ── 写库（提取 / 摘要）──
    //   **`summary` / `summaryFloor` 故意不在册**（v3.46.4 实测后修正，见本文件头部与 `docs/D37` §3.5）：
    //   这两个动作**本来就有自己的在途闸**，且 `summaryFloor` 的是**按楼层**判重（`ui/panel.js#singleFloorBusyState`），
    //   比本表的「按动作名」**更细** —— 并入统一守门＝用更粗的粒度覆盖更细的（smoke BJ1 立刻变红：
    //   第二次点击的拒因文案被本表改写）。两件事它们都已具备：① 开工提示本就自己弹
    //   （`AI 摘要：开始分析…` / `第 N 楼：开始分析…`）；② 重复点击本就被自己的机制拒（提示更准）。
    plotSegmentSummarySel: { label: '分段总结' },
    // ── 自动修复族（全部走窄契约 AI）──
    repair: { label: '自动修复' },
    characterRepair: { label: '修复角色' },
    resumeRepair: { label: '补全 / 修复履历' },
    stateRepair: { label: '修复状态' },
    memoryRepair: { label: '修复记忆关联' },
    conceptRepair: { label: '修复概念' },
    sceneRepair: { label: '修复场景' },
    itemRepair: { label: '修复物品' },
    planSuspRepair: { label: '修复计划 / 悬念' },
    // ── 压缩 / 合并 ──
    atomCompactNow: { label: 'AI 压缩情节' },
    atomMergeSummary: { label: 'AI 合并情节摘要' },
    // ── 平行事件 / 推演 ──
    parallelAdvance: { label: '平行事件推进' },
    parallelAdvanceAll: { label: '平行事件全部推进' },
    parallelCustomRun: { label: '自定义推演', selfNotice: true },
    parallelWeaveNow: { label: '推演世界' },
    // ── 三域联动 / 货币融合 ──
    triLinkBuild: { label: '联动构建（三域）' },
    currencyMergePick: { label: 'AI 融合货币' },
    resumeBatchRun: { label: '批量完善履历（一次请求一批角色）' },
    // ── NSFW / 时钟 ──
    nsfwSoften: { label: 'NSFW 弱化' },
    nsfwAnalyze: { label: 'NSFW 分析' },
    clockRepair: { label: '日期时间修复' },
    // ── 通道连通性 / 向量层测试（也是**真实网络请求**）──
    apiTest: { label: '通道连通性测试' },
    apiModels: { label: '拉取模型列表' },
    testLayer: { label: '向量层测试' },
});

/** 登记表条目数（文档 / 测试对账用；`summary` / `summaryFloor` 因**自带更细的在途闸**不在册） */
export const PIPE_ACTION_COUNT = Object.keys(PIPE_ACTIONS).length;

/** 动作是否登记为管道请求（登记表查询） */
export function isPipeAction(action) {
    return Object.prototype.hasOwnProperty.call(PIPE_ACTIONS, String(action || ''));
}
/** 动作的展示名（未登记 → 用动作名兜底，保证提示不空） */
export function pipeLabel(action) {
    const a = String(action || '');
    const e = PIPE_ACTIONS[a];
    return (e && e.label) || a;
}

/** 在途表：动作名 → 开始时刻 */
const inflight = new Map();
/** 安全阀触发计数（如实统计，供调试与测试读取） */
let timeouts = 0;

/** 是否在途（渲染禁用态 / 调试 / 测试用） */
export function pipeBusy(action) { return inflight.has(String(action || '')); }
/** 当前在途的动作列表（调试 / 测试用） */
export function pipeInflightList() {
    const now = Date.now();
    return [...inflight.entries()].map(([a, at]) => ({ action: a, at: at, ms: now - at }));
}
/** 守门状态快照（调试 / 测试用） */
export function pipeGuardState() {
    return { inflight: pipeInflightList(), timeouts: timeouts, maxMs: PIPE_MAX_MS, registered: Object.keys(PIPE_ACTIONS).length };
}

/**
 * 开工提示文案（`docs/D9` §7 **U7**：进行中用 `🔄`）。只对**登记的**管道动作产出；其余返回空串。
 * @returns {string} 空串 = 不需要（未登记 / 该动作自带开工提示）
 */
export function pipeNoticeOf(action) {
    const a = String(action || '');
    const e = PIPE_ACTIONS[a];
    if (!e || e.selfNotice) return '';
    return '🔄 ' + e.label + '：已发起 AI 请求（管道请求），等待返回…';
}

/**
 * **进闸**：`panelAction` 开头调用。
 * @returns {{ok:boolean, reason?:string, note?:string, notice?:string, pipe:boolean}}
 *   `ok:false` → 调用方应**直接拒绝本次动作**（已写提示文案 `note`）；
 *   `ok:true`  → 已登记在途；`notice` 非空时应弹一次开工提示。
 */
export function pipeEnter(action) {
    const a = String(action || '');
    const pipe = isPipeAction(a);
    if (!pipe) return { ok: true, pipe: false, notice: '' };     // 非管道动作：完全不介入（零开销）
    const now = Date.now();
    const at = inflight.get(a);
    if (at !== undefined) {
        // 在途：安全阀先判（超时 → 放行本次，并如实计数）
        if (now - at > PIPE_MAX_MS) {
            timeouts += 1;
            inflight.set(a, now);
            return { ok: true, pipe: true, notice: '🔄 ' + pipeLabel(a) + '：上一次请求已超时 ' + Math.round((now - at) / 1000) + 's（已放行本次）' };
        }
        const label = pipeLabel(a);
        return {
            ok: false, pipe: true, reason: 'in-flight',
            note: label + '：上一次请求还在进行中（已挡下本次重复点击）',
            notice: '⚠️ ' + label + '：上一次请求还在进行中，已挡下本次重复点击',
        };
    }
    inflight.set(a, now);
    return { ok: true, pipe: true, notice: pipeNoticeOf(a) };
}

/** **出闸**：`finalizePanelAction` 调用（成功 / 失败 / 异常 / 早退都要到这里） */
export function pipeLeave(action) {
    const a = String(action || '');
    if (inflight.has(a)) { inflight.delete(a); return true; }
    return false;
}

/**
 * 渲染期**在途禁用**：给在途动作的按钮注入 `disabled`（让用户看得见「现在点不动」）。
 *   口径：只改**带 `data-ftt-action="<在途动作>"` 且是 `<button`** 的标签；一个动作用在途一次。
 *   注：真正的安全保证在 `pipeEnter`（点击仍会被挡），此处只是**视觉反馈**（纯字符串处理，失败返回原串）。
 * @param {string} html 面板 HTML
 */
export function pipeDisableInFlightHtml(html) {
    let s = String(html == null ? '' : html);
    if (!inflight.size) return s;
    try {
        for (const a of inflight.keys()) {
            // 只对「还没写 disabled」的按钮注入；`<a>` 不动（原生 disabled 对我不生效，且点击仍由 pipeEnter 挡）
            const re = new RegExp('(<button[^>]*data-ftt-action="' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '")', 'g');
            s = s.replace(re, '$1 disabled');
        }
    } catch (e) { /* 字符串处理失败不影响渲染 */ }
    return s;
}

/** 复位（面板 teardown / 测试用）：清空在途表与计数 */
export function pipeGuardReset() {
    inflight.clear();
    timeouts = 0;
    return pipeGuardState();
}
