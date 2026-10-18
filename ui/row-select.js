// ============================================================
// ui/row-select.js —— **列表行「点选」交互**（v3.50.16，用户要求）
//
// 用户原话：「各大类清单带有多选功能的设计进行调整，启动多选模式后，不需要勾选按钮，
//   而是改为点击即加入选择。提高UI交互的便利性。」
//
// 口径：
//   · **多选模式下不再渲染复选框**（`<input type="checkbox">`）—— 行本身就是选择控件；
//   · 点行 = 加入/移出选择（切换）；点行内**按钮 / 链接 / 输入**等可交互控件 **不触发**选择（照旧执行原动作）；
//   · 选中态用**行样式**表达（`.ftt-sel-on` + 左侧色条 + 轻微高亮），并保留一个**只读**的
//     `☑ / ☐` 记号（`aria-hidden`，不是控件 —— 用户不点它，只用来「一眼看出这条选没选」）；
//   · 键盘可达：行 `tabindex="0"` + `Enter/Space` 等价于点行（不牺牲可达性）；
//   · 降级：拿不到 DOM（桩环境 / 受限宿主）时一律不报错 —— 标记仍是普通行，只是不响应点选。
//
// 为什么单独成模块（`docs/05` §5 **C11** + 体量棘轮）：`ui/panel.js` 贴上限，本交互整体落新模块，
//   面板只留「渲染助手两个调用点 + 委托钩子一行」。
// ============================================================

/** 行上的点选标记属性（渲染层写、委托层读；`panel-audit` L5 要求它有真实读者） */
export const ROW_SEL_ATTR = 'data-ftt-selrow';
/** 选中态类名（行） */
export const ROW_ON_CLASS = 'ftt-sel-on';
/** 行首那条「☑/☐」记号的类名（**只读**视觉，不是控件） */
export const ROW_MARK_CLASS = 'ftt-selmark';

/** 行内**不**触发点选的控件选择器（点它们 = 执行原动作） */
export const ROW_INTERACTIVE = 'button,a,input,select,textarea,label,[data-ftt-action],[contenteditable="true"]';

/**
 * 行首记号 HTML（多选模式下放在行内容最前面）。
 *   **不是 `input`** —— 用户要求的正是「不要勾选按钮」；这个记号只表示状态，点击由整行承担。
 * @param {boolean} on 是否已选中
 * @returns {string}
 */
export function rowSelectMarkHtml(on) {
    return '<span class="' + ROW_MARK_CLASS + '" aria-hidden="true" title="点击整行即可选中 / 取消">' + (on ? '☑' : '☐') + '</span>';
}

/**
 * 行属性串（拼进 `swipeRowHtml(..., {attrs})`）。
 * @param {string} kind 维度键
 * @param {string} id 条目 id
 * @param {boolean} on 是否已选中
 * @returns {string} 形如 ` data-ftt-selrow="memories" data-ftt-id="m1" class="ftt-sel-on"`
 */
export function rowSelectAttrs(kind, id, on) {
    const k = String(kind == null ? '' : kind), i = String(id == null ? '' : id);
    if (!k || !i) return '';
    return ' ' + ROW_SEL_ATTR + '="' + k.replace(/"/g, '&quot;') + '" data-ftt-id="' + i.replace(/"/g, '&quot;') + '"'
        + (on ? (' class="' + ROW_ON_CLASS + '"') : '') + ' tabindex="0"';
}

/** 从事件目标向上找「可点选的行」 */
export function rowSelectFrom(target) {
    let node = target;
    for (let depth = 0; node && depth < 8; depth++) {
        try {
            if (node.getAttribute && node.getAttribute(ROW_SEL_ATTR) != null) return node;
        } catch (e) { /* 忽略：非元素节点 */ }
        node = node.parentNode || node.parentElement || null;
    }
    return null;
}

/** 事件目标是否落在行内可交互控件上（点这些不切换选择） */
export function rowSelectHitInteractive(target) {
    let node = target;
    for (let depth = 0; node && depth < 8; depth++) {
        try {
            const tag = String((node.tagName || '')).toUpperCase();
            if (/^(BUTTON|A|INPUT|SELECT|TEXTAREA|LABEL)$/.test(tag)) return true;
            if (node.getAttribute && (node.getAttribute('contenteditable') === 'true')) return true;
        } catch (e) { /* 忽略 */ }
        node = node.parentNode || node.parentElement || null;
    }
    return false;
}

/**
 * 处理一次点击：命中「可点选的行」且不是可交互控件 → 切换选择。
 *
 * @param {Event} e 点击事件
 * @param {{getSel:(kind:string)=>Set<string>, sync?:()=>void, render?:()=>void}} api
 *   `getSel(kind)` 取该维度的已选集（`Set`）；`sync()` 供调用方局部同步按钮（不整页重绘）
 * @returns {string} 切到的维度键（未命中返回空串；便于调用方判断是否已消费该点击）
 */
export function rowSelectClick(e, api) {
    try {
        const t = e && (e.target || e.srcElement);
        if (!t) return '';
        if (rowSelectHitInteractive(t)) return '';
        const row = rowSelectFrom(t);
        if (!row) return '';
        const kind = String(row.getAttribute(ROW_SEL_ATTR) || '');
        const id = String(row.getAttribute('data-ftt-id') || '');
        if (!kind || !id) return '';
        const set = api && typeof api.getSel === 'function' ? api.getSel(kind) : null;
        if (!set) return '';
        const on = !set.has(id);
        if (on) set.add(id); else set.delete(id);
        // ① 行样式与记号：**就地**更新（不整页重绘 —— 点选是高频动作）
        try {
            if (row.classList) {
                if (on) row.classList.add(ROW_ON_CLASS); else row.classList.remove(ROW_ON_CLASS);
            }
            const mark = row.querySelector ? row.querySelector('.' + ROW_MARK_CLASS) : null;
            if (mark) mark.textContent = on ? '☑' : '☐';
        } catch (err) { /* 忽略：DOM 能力缺失时只改集合 */ }
        // ② 工具行按钮的 disabled / 计数局部同步
        if (api && typeof api.sync === 'function') { try { api.sync(); } catch (err) { /* 忽略 */ } }
        return kind;
    } catch (err) { return ''; }
}

/** 键盘：行上的 Enter / Space 等价于点选（可达性） */
export function rowSelectKeydown(e, api) {
    try {
        const key = String((e && e.key) || '');
        if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return '';
        const row = rowSelectFrom(e && (e.target || e.srcElement));
        if (!row) return '';
        if (e.preventDefault) e.preventDefault();
        return rowSelectClick(e, api);
    } catch (err) { return ''; }
}

/**
 * **一次性接线**（面板只调这一行）：在容器上挂 **capture 阶段** 的 click / keydown 委托。
 *
 *   · 用 **capture** 而不是 bubble：面板另有「动作分发」的冒泡 click 监听（注册更早），
 *     同相位就会**先**跑到动作分发、行内空白处点击被当成未知动作；capture 保证点选优先。
 *   · 命中点选时 stopPropagation（该次点击已被消费，不再进入动作分发）。
 *   · 幂等：同一容器重复调用只挂一套监听（面板每次重绘都会调）。
 *
 * @param {Element} el 面板容器
 * @param {{getSel:(kind:string)=>Set<string>, sync?:()=>void}} api 同 rowSelectClick
 * @returns {boolean} 是否本次完成接线（已挂过 → false）
 */
export function bindRowSelect(el, api) {
    try {
        if (!el || typeof el.addEventListener !== 'function') return false;
        if (el.__fttRowSelect) return false;
        try { el.__fttRowSelect = true; } catch (e) { /* 冻结对象 → 仍继续 */ }
        const consume = (e) => {
            const kind = rowSelectClick(e, api);
            if (kind && e && typeof e.stopPropagation === 'function') { try { e.stopPropagation(); } catch (err) { /* 忽略 */ } }
            return kind;
        };
        // **只挂 keydown**：click 走面板既有的「动作分发」入口（那里已经 preventDefault + stopPropagation 一次），
        //   再单独挂一个 click 监听会多一层监听器（冒烟 AO2 正是按「监听器数 = 各 listener 都阻止默认」断言的）。
        el.addEventListener('keydown', (e) => { try { rowSelectKeydown(e, api); } catch (err) { /* 忽略 */ } }, true);
        return true;
    } catch (e) { return false; }
}
