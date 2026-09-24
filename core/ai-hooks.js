// ============================================================
// core/ai-hooks.js —— AI 调用 / 投喂文本 / 长任务占用的**共用注入钩子**
// 目的：多个 AI 管线（时钟正则生成与修复、内容弱化 NSFW、后续修复域）共用同一套宿主接线，
//   内核保持零宿主依赖（不直连网络、不读宿主聊天、不感知任务管线）。
// 宿主接线见 `index.js`：`callAi` → ST `generateRaw`；`feedText` → `host/floors.js`；`busy` → `host/extract.js#extractBusy`。
// ============================================================
let hooks = {
    /** AI 调用：入参为 V1 口径的 messages 数组，返回 { ok, text } 或字符串 */
    callAi: async () => ({ ok: false, error: 'AI 调用未接线' }),
    /** 投喂文本：最近 N 楼（V1 `buildFeedFloorText`） */
    feedText: () => '',
    /** 长任务占用判定（摘要/提取/同步在途 → 拒绝本次 AI 管线） */
    busy: () => false,
};
/** 注入钩子（合并式；返回值即当前生效钩子，可用于「快照后再恢复」） */
export function setAiHooks(next) { hooks = Object.assign({}, hooks, next || {}); return hooks; }
/** 当前钩子（只读快照） */
export function aiHooks() { return Object.assign({}, hooks); }
/** 调用 AI 并归一为纯文本（失败/异常 → 空串） */
export async function aiCallText(messages, label) {
    try {
        const r = await hooks.callAi(messages, { label });
        if (r && typeof r === 'object') return r.ok === false ? '' : String(r.text == null ? '' : r.text);
        return String(r == null ? '' : r);
    } catch (e) { return ''; }
}
/** 取投喂文本（异常 → 空串） */
export function aiFeedText(maxFloors) {
    try { return String(hooks.feedText(maxFloors) || ''); } catch (e) { return ''; }
}
/** 长任务是否占用（异常 → 不占用） */
export function aiBusy() {
    try { return !!hooks.busy(); } catch (e) { return false; }
}
