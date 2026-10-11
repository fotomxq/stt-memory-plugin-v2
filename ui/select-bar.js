// ============================================================
// ui/select-bar.js —— **工具行里「依赖勾选」的按钮**（v3.43.1，修复轮）
//
// 用户报告（原话）：「修正各大类的多选设计，当直接选择对应选项后，顶部的删除等按钮无效。
//   必须选择全选才能激活，请修复该问题。」
//
// 根因（事实登记 `docs/D17` U182 · 设计稿 `docs/D19` §2 **K14** / §3.6 `应-24`）：
//   `data-ftt-select` 复选框的 `change` 分支**只更新内存集合**（`ui/panel.js#ps.sel[kind]`），
//   既不重绘也不做局部同步 → 工具行按钮的 `disabled` 与「（N）」计数**停留在本次渲染时的快照**上。
//   没有勾选时渲染出来的按钮带 `disabled`，之后无论怎么勾都不会变；
//   只有「全选」是 `data-ftt-action` 动作（走 `panelAction` → 整页重绘）才能把它激活 ——
//   这正是用户看到的「必须选择全选才能激活」。
//
// 本模块是这类按钮「文案 + 可用态」的**唯一来源**：渲染侧（`ui/panel.js` 的列表页 / 状态页、
//   `ui/scene-tree.js` 的场景树）与勾选后的**局部同步**（`syncSelectButtons`）共用同一张表，
//   从结构上杜绝「两处各写一份文案 → 再次漂移」。
//
// 为什么是**局部同步**而不是整页重绘（`docs/D9` §5.2 第 5 条）：
//   勾选是**高频**动作；面板单次重绘要重建渲染期上下文（行索引 `buildRowCtx`），
//   300 行列表里连勾 20 条就是 20 次整页重绘 —— 只为改两个按钮的 `disabled` 与计数不值得。
//   本模块只改这两个按钮的 `disabled` / `textContent`，**不碰**列表、不重建索引、不动滚动位置。
//
// 新增一个「依赖勾选」的按钮时：把动作名登记进 `SELECT_DEP_LABELS`（文案函数），
//   渲染侧用 `selectDepButtonState()` 取文案与可用态 —— 登记一处即同时获得勾选同步能力。
// ============================================================

/**
 * 依赖勾选的工具行按钮：动作名 → 文案函数（入参 = 当前勾选数）。
 * **唯一事实源**：渲染与勾选同步都从这里取文案，禁止在渲染处再写一份字面量。
 */
export const SELECT_DEP_LABELS = {
    bulkDelete: (n) => '🗑 删除选中（' + n + '）',
    atomMergeSummary: (n) => '🧷 情节总结（' + n + '）',
    plotSegmentSummarySel: (n) => '🧩 分段总结（' + n + '）',
};

/** 勾选数归一：非有限数 / 负数 / 非数字一律当 0（防御坏入参，不抛异常） */
function normSize(size) {
    const n = (typeof size === 'number') ? size : Number(size);
    return (Number.isFinite(n) && n > 0) ? Math.floor(n) : 0;
}

/**
 * 该动作的按钮在「勾选 `size` 项」时应有的文案与可用态。
 * @param {string} action `data-ftt-action` 的动作名
 * @param {number} size 当前勾选数
 * @returns {{text:string, disabled:boolean}|null} 未登记的动作为 `null`（= 该按钮不依赖勾选）
 */
export function selectDepButtonState(action, size) {
    const make = SELECT_DEP_LABELS[String(action == null ? '' : action)];
    if (typeof make !== 'function') return null;
    const n = normSize(size);
    return { text: make(n), disabled: n === 0 };
}

/**
 * 渲染侧便利函数：返回既有 markup 需要的两段 —— `disabled` 属性（含前导空格 / 空串）与按钮文案。
 * 属性顺序与既有 markup 完全一致，保证 DOM 结构与类名不变（`docs/D19` §5 **R4**）。
 * @param {string} action
 * @param {number} size
 * @returns {{attr:string, text:string, disabled:boolean}}
 */
export function selectDepButtonParts(action, size) {
    const st = selectDepButtonState(action, size) || { text: '', disabled: true };
    return { attr: st.disabled ? ' disabled' : '', text: st.text, disabled: st.disabled };
}

/**
 * 勾选后**局部同步**工具行按钮（`disabled` + 计数文案）—— 不整页重绘。
 *
 * 逐按钮按**它自己的** `data-kind` 取勾选数：因此一次调用能同时覆盖列表页 / 状态页 / 场景树
 *   （同一个 `el.addEventListener('change')` 委托里，事件源可能来自任意一个页面）。
 *
 * @param {{querySelectorAll?:Function}} root 面板根节点（无 `querySelectorAll` 的环境直接返回 0）
 * @param {(kind:string)=>number} sizeOf 取某维度当前勾选数的函数（由 `ui/panel.js` 注入 `selOf`）
 * @returns {number} 实际更新的按钮数（0 = 本次渲染里没有这类按钮 / 环境不支持）
 */
export function syncSelectButtons(root, sizeOf) {
    if (!root || typeof root.querySelectorAll !== 'function' || typeof sizeOf !== 'function') return 0;
    let nodes = [];
    try { nodes = Array.prototype.slice.call(root.querySelectorAll('[data-ftt-action]')); } catch (e) { return 0; }
    let n = 0;
    for (const btn of nodes) {
        const ds = (btn && btn.dataset) || {};
        let size = 0;
        try { size = sizeOf(String(ds.kind || '')); } catch (e) { size = 0; }
        const st = selectDepButtonState(ds.fttAction, size);
        if (!st) continue;                       // 不依赖勾选的按钮：一律不碰
        try {
            btn.disabled = st.disabled;
            if (String(btn.textContent == null ? '' : btn.textContent) !== st.text) btn.textContent = st.text;
            n += 1;
        } catch (e) { /* 单个按钮同步失败不影响其余（DOM 被换掉的竞态） */ }
    }
    return n;
}
