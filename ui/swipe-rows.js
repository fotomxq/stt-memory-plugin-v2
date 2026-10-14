// ============================================================
// ui/swipe-rows.js —— **列表行右侧按钮：滑动 / 悬停触发**（v3.48.0，`docs/D22` §4.19 W19 `应-35` · `docs/D9` §3.2）
//
// 用户要求（原话）：「列表右侧按钮，改为滑动方式触发。即滑动后展示按钮，且按钮布局做好适配。
//   pc端自适应，鼠标放上去也会显示按钮组。」
//
// 口径（三端一致，一份状态机）：
//   · **手机 / 触屏**：手指在行上**左滑** → 行内容左移、右侧按钮组滑出；右滑（或点别处）→ 收起；
//   · **PC（悬停）**：鼠标移到行上即展开按钮组（同一套展开态，不引入第二套视觉）；
//   · **键盘**：行内控件获得焦点即展开（`:focus-within` 同款语义，保证可达性不退化）；
//   · **同一时刻只展开一行**（打开新的即收起旧的），点页面其它地方全部收起；
//   · **布局适配**：按钮组宽度**实测**（`--ftt-swipe-w`）后决定行内容左移多少；
//     按钮组本身按 `flex-wrap` 折行，且不超过行宽的 72% —— 超过则整组改为**两行/多行网格**（`ftt-swipe-wide`）。
//
// 为什么单独成模块（`docs/05` §5 **C11** + 体量棘轮 `scripts/check-file-size.js`）：
//   `ui/panel.js` 已贴上限，本功能的**标记与行为**整体落新模块，面板只留「调用渲染助手 + 一次绑定」。
//
// 降级：拿不到 DOM（桩环境 / 受限宿主）时**一律不报错**——标记仍是普通行，按钮照旧可点（只是不折行隐藏）。
// ============================================================

/** 行标记属性（渲染层写、绑定层读；`panel-audit` L5 的「委托属性」判据要求它有真实读者） */
export const SWIPE_ATTR = 'data-ftt-swipe';
/** 展开态类名（行） */
export const SWIPE_ROW_CLASS = 'ftt-swipe';
/** 展开态类名（开） */
export const SWIPE_OPEN_CLASS = 'ftt-open';
/** 拖动中（关掉过渡动画，跟手） */
export const SWIPE_DRAG_CLASS = 'ftt-drag';
/** 按钮组过宽 → 折行网格 */
export const SWIPE_WIDE_CLASS = 'ftt-swipe-wide';
/** 按钮组最多占行宽的百分比（超过即折行） */
export const SWIPE_MAX_RATIO = 0.72;
/** 触发「展开」的水平位移阈值（px；负 = 左滑） */
export const SWIPE_OPEN_THRESHOLD = -26;
/** 触发「收起」的水平位移阈值（px） */
export const SWIPE_CLOSE_THRESHOLD = 22;
/** 判定为「横向手势」的最小位移（px；小于它视为点击/纵向滚动） */
export const SWIPE_INTENT_PX = 10;

/** 行选择器（诊断 / 测试共用；**字面写出** —— `panel-audit` 的委托属性判据要求标记有可查的读者） */
export const SWIPE_ROW_SELECTOR = '.ftt-swipe[data-ftt-swipe]';

/**
 * **行标记**（列表行统一走这里，保证「内容块 + 按钮组」两层结构一致）。
 *
 * ```html
 * <div class="ftt-item ftt-inline ftt-swipe" data-ftt-swipe="1" data-ftt-swipe-n="3" [额外属性]>
 *   <div class="ftt-swipe-body">…勾选框 / 行内容…</div>
 *   <div class="ftt-swipe-ops ftt-item-ops[ ftt-ops-col]">…按钮…</div>
 * </div>
 * ```
 * @param {string} bodyHtml 行内容（含多选勾选框）
 * @param {string} opsHtml 右侧按钮（**不含** `.ftt-item-ops` 外壳 —— 由本函数统一加）
 * @param {{attrs?:string, opsCol?:boolean, count?:number}} [opts]
 *   `attrs` = 行上的额外属性串（如「🆕 本次新增」的定位锚点）· `opsCol` = 竖排操作列（平行页 V1 口径）· `count` = 按钮数（只读读数）
 * @returns {string} 行 HTML
 */
export function swipeRowHtml(bodyHtml, opsHtml, opts) {
    const o = opts || {};
    const attrs = String(o.attrs == null ? '' : o.attrs);
    const n = Number.isFinite(Number(o.count)) ? Number(o.count) : 0;
    const opsCls = 'ftt-swipe-ops ftt-item-ops' + (o.opsCol ? ' ftt-ops-col' : '');
    return '<div class="ftt-item ftt-inline ' + SWIPE_ROW_CLASS + '" ' + SWIPE_ATTR + '="1"'
        + (n > 0 ? (' data-ftt-swipe-n="' + n + '"') : '')
        + attrs + '>'
        + '<div class="ftt-swipe-body">' + String(bodyHtml == null ? '' : bodyHtml) + '</div>'
        + '<div class="' + opsCls + '">' + String(opsHtml == null ? '' : opsHtml) + '</div>'
        + '</div>';
}

/** 行内结构读数（只读；诊断与测试用） */
export function swipeRowInfo(row) {
    try {
        if (!row || typeof row.querySelector !== 'function') return null;
        const body = row.querySelector('.ftt-swipe-body');
        const ops = row.querySelector('.ftt-swipe-ops');
        const n = Number(row.getAttribute && row.getAttribute('data-ftt-swipe-n')) || 0;
        return {
            hasBody: !!body, hasOps: !!ops, buttons: n,
            open: !!(row.classList && row.classList.contains && row.classList.contains(SWIPE_OPEN_CLASS)),
            wide: !!(row.classList && row.classList.contains && row.classList.contains(SWIPE_WIDE_CLASS)),
            width: Number(String((row.style && row.style.getPropertyValue && row.style.getPropertyValue('--ftt-swipe-w')) || '0').replace('px', '')) || 0,
        };
    } catch (e) { return null; }
}

// ==================== 绑定（DOM 侧；全部容错） ====================

/** 当前展开的行（同一时刻只允许一行 —— 打开新的即收起旧的） */
let openRow = null;
/** 绑定标记（幂等：同一行只绑一次手势） */
const BOUND = new WeakSet ? new WeakSet() : null;
/** 最近一次绑定的读数（诊断 / 测试） */
let lastStats = { rows: 0, bound: 0, measured: 0, wide: 0 };

/** 绑定读数（只读） */
export function swipeBindStats() { return Object.assign({}, lastStats); }

/** 取行的样式对象（桩环境可能没有） */
function styleOf(row) { try { return row && row.style ? row.style : null; } catch (e) { return null; } }

/** 取行的类名操作（桩环境可能没有 `classList`） */
function classOp(row, name, on) {
    try {
        if (row && row.classList && typeof row.classList.add === 'function') { row.classList[on ? 'add' : 'remove'](name); return true; }
    } catch (e) { /* 忽略 */ }
    return false;
}
function hasClass(row, name) {
    try { return !!(row && row.classList && typeof row.classList.contains === 'function' && row.classList.contains(name)); } catch (e) { return false; }
}

/**
 * **实测按钮组宽度**并下发 `--ftt-swipe-w`（布局适配的核心：按钮个数 / 文案不同 → 左移量不同）。
 * 过宽（> 行宽 × `SWIPE_MAX_RATIO`）→ 加 `ftt-swipe-wide`（按钮组折行成网格，不吃掉整行）。
 * @returns {number} 实测宽度（px；量不到 = 0，调用方据此跳过展开动画但**不报错**）
 */
export function measureSwipeRow(row) {
    try {
        const ops = (row && typeof row.querySelector === 'function') ? row.querySelector('.ftt-swipe-ops') : null;
        if (!ops) return 0;
        const rowW = Number(row.clientWidth) || Number(row.offsetWidth) || 0;
        const opsW = Number(ops.scrollWidth) || Number(ops.offsetWidth) || 0;
        if (!opsW) return 0;                                        // 面板未挂载 / display:none → 交给下一次（悬停 / 触摸 / 聚焦）
        const cap = rowW > 0 ? Math.floor(rowW * SWIPE_MAX_RATIO) : opsW;
        const wide = opsW > cap;
        classOp(row, SWIPE_WIDE_CLASS, wide);
        const w = wide ? cap : opsW;
        const st = styleOf(row);
        if (st && typeof st.setProperty === 'function') st.setProperty('--ftt-swipe-w', w + 'px');
        lastStats.measured += 1;
        if (wide) lastStats.wide += 1;
        return w;
    } catch (e) { return 0; }
}

/** 展开一行（先收起旧行；宽度量不到也照样展开 —— CSS 有兜底） */
export function openSwipeRow(row) {
    if (!row) return false;
    try {
        if (openRow && openRow !== row) closeSwipeRow(openRow);
        measureSwipeRow(row);
        classOp(row, SWIPE_OPEN_CLASS, true);
        openRow = row;
        return true;
    } catch (e) { return false; }
}

/** 收起一行（只对当前展开的那行生效，避免误清别的行） */
export function closeSwipeRow(row) {
    try {
        if (!row) return false;
        classOp(row, SWIPE_OPEN_CLASS, false);
        classOp(row, SWIPE_DRAG_CLASS, false);
        if (openRow === row) openRow = null;
        return true;
    } catch (e) { return false; }
}

/** 收起全部（切页 / 点空白处调用） */
export function closeAllSwipeRows() { return closeSwipeRow(openRow); }

/** 当前展开的行（只读；测试用） */
export function openSwipeRowRef() { return openRow; }

/** 事件工具（桩环境的 listener 形如 `{ target, ... }` 也可能只有纯对象） */
function evPoint(e) {
    try {
        const t = e && e.touches && e.touches[0] ? e.touches[0] : (e && e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : e);
        return { x: Number(t && t.clientX) || 0, y: Number(t && t.clientY) || 0 };
    } catch (err) { return { x: 0, y: 0 }; }
}
function on(el, type, fn, opts) { try { if (el && typeof el.addEventListener === 'function') el.addEventListener(type, fn, opts); } catch (e) { /* 忽略 */ } }

/**
 * **绑一行**（幂等；触屏手势 + 悬停 + 聚焦三条入口共用一套展开态）。
 * @returns {boolean} 是否本次完成绑定（已绑过 → false）
 */
export function bindSwipeRow(row) {
    if (!row) return false;
    try {
        if (BOUND && BOUND.has(row)) { measureSwipeRow(row); return false; }
        if (BOUND) BOUND.add(row);
    } catch (e) { /* WeakSet 不可用 → 允许重复绑定（下面用 `__fttSwipe` 兜底） */ }
    if (row.__fttSwipe) { measureSwipeRow(row); return false; }
    try { row.__fttSwipe = true; } catch (e) { /* 冻结对象 → 仍继续绑 */ }
    let x0 = 0, y0 = 0, dragging = false, horiz = false;
    on(row, 'touchstart', (e) => {
        const p = evPoint(e); x0 = p.x; y0 = p.y; dragging = true; horiz = false;
        classOp(row, SWIPE_DRAG_CLASS, true);
        measureSwipeRow(row);                                        // 首次触摸补测（面板可能刚挂载）
    }, { passive: true });
    on(row, 'touchmove', (e) => {
        if (!dragging) return;
        const p = evPoint(e), dx = p.x - x0, dy = p.y - y0;
        if (!horiz) { if (Math.abs(dx) < SWIPE_INTENT_PX) return; if (Math.abs(dx) < Math.abs(dy)) { dragging = false; return; } horiz = true; }
        // 跟手：只做「从当前展开态再拉」的位移，不越过按钮组宽度
        const base = hasClass(row, SWIPE_OPEN_CLASS) ? -1 : 0;
        const st = styleOf(row);
        if (st && typeof st.setProperty === 'function' && base === 0 && dx < 0) st.setProperty('--ftt-swipe-w', Math.min(Math.abs(dx), 160) + 'px');
    }, { passive: true });
    on(row, 'touchend', (e) => {
        if (!dragging) { classOp(row, SWIPE_DRAG_CLASS, false); return; }
        const p = evPoint(e), dx = p.x - x0;
        dragging = false; classOp(row, SWIPE_DRAG_CLASS, false);
        if (!horiz) return;                                          // 没形成横向手势 → 交给点击
        if (dx <= SWIPE_OPEN_THRESHOLD) openSwipeRow(row);
        else if (dx >= SWIPE_CLOSE_THRESHOLD) closeSwipeRow(row);
        else measureSwipeRow(row);                                   // 位移不够 → 回到原状（重新量一次宽度）
    }, { passive: true });
    on(row, 'touchcancel', () => { dragging = false; classOp(row, SWIPE_DRAG_CLASS, false); measureSwipeRow(row); }, { passive: true });
    // PC：悬停即展开（用户要求「鼠标放上去也会显示按钮组」）；焦点进入同理（键盘可达性不退化）
    on(row, 'mouseenter', () => { openSwipeRow(row); });
    on(row, 'mouseleave', () => { if (!hasFocusInside(row)) closeSwipeRow(row); });
    on(row, 'focusin', () => { openSwipeRow(row); });
    on(row, 'focusout', () => { setTimeout(() => { if (!hasFocusInside(row)) closeSwipeRow(row); }, 0); });
    measureSwipeRow(row);
    return true;
}

/** 行内是否还有焦点（收起前要问一句，避免把键盘用户正在操作的按钮收走） */
function hasFocusInside(row) {
    try {
        const doc = row.ownerDocument || (typeof document !== 'undefined' ? document : null);
        const active = doc && doc.activeElement;
        if (!active || !row.contains) return false;
        return row === active || row.contains(active);
    } catch (e) { return false; }
}

/**
 * **渲染后绑定整块**（面板每次重绘后调一次；在 `root` 内找所有行）。
 * 幂等：已绑过的行只补测宽度；同时挂一次「点空白处收起」（挂在根上，不重复挂）。
 * @param {object} root 浮层 / 面板根元素
 * @returns {{rows:number, bound:number}}
 */
export function applySwipeRows(root) {
    const out = { rows: 0, bound: 0 };
    try {
        lastStats = { rows: 0, bound: 0, measured: 0, wide: 0 };
        if (!root || typeof root.querySelectorAll !== 'function') return out;
        const rows = root.querySelectorAll(SWIPE_ROW_SELECTOR) || [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            out.rows += 1;
            if (bindSwipeRow(row)) out.bound += 1;
        }
        lastStats.rows = out.rows; lastStats.bound = out.bound;
        // 守卫**只在真的有滑动行时**才挂（空页 / 无行页面不引入任何监听 —— 保持点击链路纯净）
        if (out.rows > 0 && !root.__fttSwipeGuard) {
            root.__fttSwipeGuard = true;
            on(root, 'click', (e) => {
                try {
                    const t = e && e.target;
                    const inside = t && typeof t.closest === 'function' ? t.closest(SWIPE_ROW_SELECTOR) : null;
                    if (!inside || !hasClass(inside, SWIPE_OPEN_CLASS)) closeAllSwipeRows();
                } catch (err) { /* 忽略 */ }
            });
        }
        return out;
    } catch (e) { return out; }
}
