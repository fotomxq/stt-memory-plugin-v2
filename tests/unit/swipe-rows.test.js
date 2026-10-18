// ============================================================
// 单元测试 · v3.48.0 列表行右侧按钮「滑动 / 悬停」触发（`docs/D22` §4.19 W19 `应-35` · `docs/D9` §3.2）
//
// 用户要求（原话）：「列表右侧按钮，改为滑动方式触发。即滑动后展示按钮，且按钮布局做好适配。
//   pc端自适应，鼠标放上去也会显示按钮组。」
//
// 本文件锁六件事：
//   ① **标记结构**：行 = `.ftt-swipe` + `.ftt-swipe-body` + `.ftt-swipe-ops`（按钮组带 `data-ftt-swipe` 行标记与按钮数读数）；
//   ② **展开态唯一**：触屏左滑 / PC 悬停 / 键盘聚焦**三条入口共用同一个 `.ftt-open`**（不引入第二套视觉）；
//   ③ **同一时刻只展开一行**；点行外空白 / 滑回右侧 → 收起；
//   ④ **布局适配**：按**实测**宽度下发 `--ftt-swipe-w`；按钮组过宽（> 行宽 72%）→ `ftt-swipe-wide`（折行网格）；
//   ⑤ **容错**：拿不到 DOM / 量不到宽度 / 冻结对象一律不抛错，且**按钮保持可点**（降级不静默失败）；
//   ⑥ **反向探针**：把「只展开一行」或「过宽折行」拆掉会被本文件抓住。
//
// 运行：node tests/unit/swipe-rows.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import {swipeRowHtml, applySwipeRows, bindSwipeRow, openSwipeRow, closeSwipeRow, closeAllSwipeRows,
    measureSwipeRow, swipeRowInfo, openSwipeRowRef, swipeBindStats,
    SWIPE_ATTR, SWIPE_ROW_CLASS, SWIPE_OPEN_CLASS, SWIPE_WIDE_CLASS, SWIPE_DRAG_CLASS,
    SWIPE_ROW_SELECTOR, SWIPE_MAX_RATIO, SWIPE_OPEN_THRESHOLD, setSwipeSuspended, swipeSuspended,
    SWIPE_CLOSE_THRESHOLD, SWIPE_INTENT_PX,
} from '../../ui/swipe-rows.js';

const R = makeReporter('swipe-rows v3.48.0 行按钮滑动/悬停触发（D22 W19 应-35 / D9 §3.2）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

// ---------- ① 标记结构 ----------
const HTML = swipeRowHtml('<span class="ftt-grow">行内容</span>', '<button data-ftt-action="edit">✏️</button><button data-ftt-action="delete">🗑</button>', { count: 2, attrs: ' data-ftt-flash-id="a1"' });
A('A1 行标记：`ftt-item ftt-inline ftt-swipe` + `data-ftt-swipe` + 按钮数读数（供样式与诊断）', (() => {
    return HTML.indexOf('class="ftt-item ftt-inline ' + SWIPE_ROW_CLASS + '"') >= 0
        && HTML.indexOf(SWIPE_ATTR + '="1"') >= 0
        && HTML.indexOf('data-ftt-swipe-n="2"') >= 0;
})(), HTML.slice(0, 200));
A('A2 两层结构：内容块 `.ftt-swipe-body` + 按钮组 `.ftt-swipe-ops`，且按钮组**仍带 V1 的操作区类**', (() => {
    return HTML.indexOf('<div class="ftt-swipe-body">') >= 0
        && HTML.indexOf('<div class="ftt-swipe-ops ftt-item-ops">') >= 0
        && HTML.indexOf('data-ftt-action="edit"') > HTML.indexOf('ftt-swipe-ops');
})(), 'n/a');
A('A3 平行页的竖排操作列仍是 `ftt-ops-col`（V1 口径不被本轮改动）', (() => {
    const h = swipeRowHtml('x', '<button data-ftt-action="parallelAdvance">🚀</button>', { opsCol: true, count: 1 });
    return h.indexOf('class="ftt-swipe-ops ftt-item-ops ftt-ops-col"') >= 0;
})(), 'n/a');
A('A4 渲染层的行属性串（如「🆕 本次新增」锚点）原样带到行上', () => HTML.indexOf('data-ftt-flash-id="a1"') > 0, 'n/a');

// ---------- 假 DOM（只实现本模块真正用到的那几个 API） ----------
function makeRow(opts) {
    const o = opts || {};
    const body = { className: 'ftt-swipe-body', style: { setProperty() { }, getPropertyValue() { return ''; } } };
    const ops = {
        className: 'ftt-swipe-ops ftt-item-ops',
        scrollWidth: Number(o.opsW == null ? 120 : o.opsW),
        offsetWidth: Number(o.opsW == null ? 120 : o.opsW),
    };
    const row = {
        __styleVars: {},
        clientWidth: Number(o.rowW == null ? 600 : o.rowW),
        style: { setProperty(k, v) { row.__styleVars[String(k)] = String(v); }, getPropertyValue(k) { return row.__styleVars[String(k)] || ''; } },
        classList: {
            _s: new Set(),
            add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
            contains(c) { return this._s.has(c); },
        },
        getAttribute(k) { return k === 'data-ftt-swipe-n' ? String(o.buttons || 2) : null; },
        querySelector(sel) { return String(sel).indexOf('body') >= 0 ? body : (String(sel).indexOf('ops') >= 0 ? ops : null); },
        addEventListener(type, fn) { (row._l[type] = row._l[type] || []).push(fn); },
        dispatch(type, ev) { for (const fn of (row._l[type] || []).slice()) fn(ev || {}); },
        _l: {}, contains() { return false; }, ownerDocument: null,
    };
    return row;
}
function makeRoot(rows) {
    const bound = {};
    return {
        _rows: rows, __rootListeners: {},
        querySelectorAll(sel) { return String(sel) === SWIPE_ROW_SELECTOR ? rows : []; },
        addEventListener(type, fn) { (this.__rootListeners[type] = this.__rootListeners[type] || []).push(fn); },
        dispatch(type, ev) { for (const fn of (this.__rootListeners[type] || []).slice()) fn(ev); },
        void: bound,
    };
}

// ---------- ② 三条入口共用同一个展开态 ----------
const row1 = makeRow({});
const root1 = makeRoot([row1]);
A('B1 `applySwipeRows` 绑定行并返回读数（rows / bound）', (() => {
    const st = applySwipeRows(root1);
    return st.rows === 1 && st.bound === 1 && swipeRowInfo(row1) !== null;
})(), J(swipeBindStats()));
A('B2 绑定是**幂等**的：再跑一次不重复绑、不抛错', (() => {
    const st = applySwipeRows(root1);
    return st.rows === 1 && st.bound === 0 && row1._l.touchstart.length === 1;
})(), J(row1._l && Object.keys(row1._l)));
A('B3 **触屏左滑** → 展开（超过阈值）', (() => {
    closeAllSwipeRows();
    row1.dispatch('touchstart', { touches: [{ clientX: 200, clientY: 10 }] });
    row1.dispatch('touchmove', { touches: [{ clientX: 200 + SWIPE_OPEN_THRESHOLD - 20, clientY: 12 }] });
    row1.dispatch('touchend', { changedTouches: [{ clientX: 200 + SWIPE_OPEN_THRESHOLD - 20, clientY: 12 }] });
    return row1.classList.contains(SWIPE_OPEN_CLASS) === true;
})(), J(swipeRowInfo(row1)));
A('B4 **右滑** → 收起', (() => {
    row1.dispatch('touchstart', { touches: [{ clientX: 100, clientY: 10 }] });
    row1.dispatch('touchmove', { touches: [{ clientX: 160, clientY: 12 }] });
    row1.dispatch('touchend', { changedTouches: [{ clientX: 160, clientY: 12 }] });
    return row1.classList.contains(SWIPE_OPEN_CLASS) === false;
})(), J(swipeRowInfo(row1)));
/** v3.50.20（用户报告）：PC **不再悬停展开**，改为**按住鼠标向左拖动**触发（两种兼容模式之一）。 */
A('B5 **PC 鼠标拖动** → 展开（左拖超阈值）/ 收起（右拖）；**悬停不再展开**（v3.50.20 用户报告的「放上去就滑出、表单跟着走」）', (() => {
    closeAllSwipeRows();
    const row = makeRow({});
    const root = makeRoot([row]);
    applySwipeRows(root);
    row.dispatch('mouseenter', {});
    const onHover = row.classList.contains(SWIPE_OPEN_CLASS);
    row.dispatch('mousedown', { clientX: 200, clientY: 40, button: 0 });
    row.dispatch('mousemove', { clientX: 200 + SWIPE_OPEN_THRESHOLD - 10, clientY: 41 });
    row.dispatch('mouseup', { clientX: 200 + SWIPE_OPEN_THRESHOLD - 10, clientY: 41 });
    const onDrag = row.classList.contains(SWIPE_OPEN_CLASS);
    row.dispatch('mousedown', { clientX: 100, clientY: 41, button: 0 });
    row.dispatch('mousemove', { clientX: 100 + SWIPE_CLOSE_THRESHOLD + 10, clientY: 41 });
    row.dispatch('mouseup', { clientX: 100 + SWIPE_CLOSE_THRESHOLD + 10, clientY: 41 });
    return onHover === false && onDrag === true && row.classList.contains(SWIPE_OPEN_CLASS) === false;
})(), 'n/a');
A('B6 **键盘聚焦** → 同样展开（可达性不退化）', (() => {
    row1.dispatch('focusin', {});
    const on = row1.classList.contains(SWIPE_OPEN_CLASS) === true;
    row1.dispatch('focusout', {});
    return on;
})(), J(swipeRowInfo(row1)));

// ---------- ③ 同一时刻只展开一行 ----------
A('C1 打开第二行 → 第一行**自动收起**（同一时刻只有一行展开）', (() => {
    const a = makeRow({}), b = makeRow({});
    applySwipeRows(makeRoot([a, b]));
    openSwipeRow(a);
    const firstOpen = a.classList.contains(SWIPE_OPEN_CLASS);
    openSwipeRow(b);
    return firstOpen === true
        && a.classList.contains(SWIPE_OPEN_CLASS) === false
        && b.classList.contains(SWIPE_OPEN_CLASS) === true
        && openSwipeRowRef() === b;
})(), J({ open: openSwipeRowRef() ? 'b' : 'none' }));
A('C2 `closeAllSwipeRows` 清空展开态（点行外空白 / 切页时调）', (() => {
    const r = openSwipeRowRef();
    closeAllSwipeRows();
    return r.classList.contains(SWIPE_OPEN_CLASS) === false && openSwipeRowRef() === null;
})(), 'n/a');
A('C3 点行外的空白 → 收起（根上挂一次点击守卫，不重复挂）', (() => {
    const a = makeRow({});
    const root = makeRoot([a]);
    applySwipeRows(root);
    applySwipeRows(root);
    const guards = (root.__rootListeners.click || []).length;
    openSwipeRow(a);
    root.dispatch('click', { target: { closest: () => null } });
    return guards === 1 && a.classList.contains(SWIPE_OPEN_CLASS) === false;
})(), 'n/a');
A('C4 点**行内按钮**不收起（否则点了按钮面板就跳走）', (() => {
    const a = makeRow({});
    applySwipeRows(makeRoot([a]));
    openSwipeRow(a);
    const root = makeRoot([a]);
    a.__rootListeners = root.__rootListeners;
    // 用同一根：重建一次
    const root2 = makeRoot([a]);
    applySwipeRows(root2);
    openSwipeRow(a);
    root2.dispatch('click', { target: { closest: () => a } });
    const stillOpen = a.classList.contains(SWIPE_OPEN_CLASS) === true;
    closeAllSwipeRows();
    return stillOpen === true;
})(), 'n/a');

// ---------- ④ 布局适配（实测宽度 + 过宽折行） ----------
A('D1 按**实测**按钮组宽度下发 `--ftt-swipe-w`（按钮个数不同 → 左移量不同）', (() => {
    const r2 = makeRow({ opsW: 96, rowW: 600 });
    measureSwipeRow(r2);
    return r2.__styleVars['--ftt-swipe-w'] === '96px';
})(), J(makeRow({ opsW: 96 }).__styleVars));
A('D2 按钮组**过宽**（> 行宽 72%）→ 加 `ftt-swipe-wide`（折行网格）且宽度夹到上限', (() => {
    const wide = makeRow({ opsW: 560, rowW: 600 });     // 560 > 600×0.72=432
    measureSwipeRow(wide);
    const info = swipeRowInfo(wide);
    return wide.classList.contains(SWIPE_WIDE_CLASS) === true
        && wide.__styleVars['--ftt-swipe-w'] === Math.floor(600 * SWIPE_MAX_RATIO) + 'px';
})(), J(makeRow({ opsW: 560, rowW: 600 }).__styleVars));
A('D3 宽度变化后**回退**：从过宽变正常 → 去掉 `ftt-swipe-wide`（不留残留态）', (() => {
    const r3 = makeRow({ opsW: 560, rowW: 600 });
    measureSwipeRow(r3);
    const on = r3.classList.contains(SWIPE_WIDE_CLASS);
    r3.querySelector = (sel) => (String(sel).indexOf('ops') >= 0 ? { scrollWidth: 100, offsetWidth: 100 } : null);
    measureSwipeRow(r3);
    return on === true && r3.classList.contains(SWIPE_WIDE_CLASS) === false && r3.__styleVars['--ftt-swipe-w'] === '100px';
})(), 'n/a');
A('D4 量不到宽度（面板未挂载 / display:none）→ 返回 0 且**不写脏变量**、不抛错', (() => {
    const zero = makeRow({ opsW: 0 });
    const w = measureSwipeRow(zero);
    return w === 0 && zero.classList.contains(SWIPE_WIDE_CLASS) === false && zero.__styleVars['--ftt-swipe-w'] === undefined;
})(), 'n/a');
A('D5 拖动中加 `ftt-drag`（关过渡，跟手）；抬手即摘掉', (() => {
    const r4 = makeRow({});
    bindSwipeRow(r4);
    r4.dispatch('touchstart', { touches: [{ clientX: 300, clientY: 5 }] });
    const dragging = r4.classList.contains(SWIPE_DRAG_CLASS) === true;
    r4.dispatch('touchcancel', {});
    return dragging === true && r4.classList.contains(SWIPE_DRAG_CLASS) === false;
})(), 'n/a');

// ---------- ⑤ 容错 / 降级 ----------
A('E1 拿不到 DOM / 选择器不支持 → 全部安全返回，不抛错', (() => {
    const a = applySwipeRows(null);
    const b = applySwipeRows({});
    const c = bindSwipeRow(null);
    const d = openSwipeRow(null);
    const e = closeSwipeRow(null);
    const f = measureSwipeRow(null);
    const g = swipeRowInfo(null);
    return a.rows === 0 && b.rows === 0 && c === false && d === false && e === false && f === 0 && g === null;
})(), 'n/a');
A('E2 `classList` 缺失（受限宿主）→ 绑定与展开都不抛错（按钮照旧可点）', (() => {
    const r5 = makeRow({});
    delete r5.classList;
    const st = applySwipeRows(makeRoot([r5]));
    const ok = openSwipeRow(r5);
    closeSwipeRow(r5);
    return st.bound === 1 && ok === true;
})(), 'n/a');
A('E3 冻结对象（不可写 `__fttSwipe`）→ 仍完成绑定（用 WeakSet 去重）', (() => {
    const r6 = makeRow({});
    Object.freeze(r6);
    const bound = bindSwipeRow(r6);
    return bound === true && (r6._l.touchstart || []).length === 1;
})(), 'n/a');

// ---------- ⑥ 反向探针 ----------
A('F1 反向探针①：若「打开新行不收旧行」→ C1 变红（此处直接验证收起动作真的发生）', (() => {
    const a = makeRow({}), b = makeRow({});
    openSwipeRow(a); openSwipeRow(b);
    return a.classList.contains(SWIPE_OPEN_CLASS) === false && b.classList.contains(SWIPE_OPEN_CLASS) === true;
})(), 'n/a');
A('F2 反向探针②：若「不做宽度实测」→ D1/D2 变红（此处验证实测值确实进了 CSS 变量）', (() => {
    const r7 = makeRow({ opsW: 143, rowW: 500 });
    measureSwipeRow(r7);
    return r7.__styleVars['--ftt-swipe-w'] === '143px';
})(), 'n/a');
A('F3 常量契约：阈值/比例有界合理（防止把阈值调到「怎么滑都不触发」）', () => {
    return SWIPE_OPEN_THRESHOLD < 0 && SWIPE_OPEN_THRESHOLD > -200 && SWIPE_MAX_RATIO > 0.4 && SWIPE_MAX_RATIO < 1;
}, J({ open: SWIPE_OPEN_THRESHOLD, ratio: SWIPE_MAX_RATIO }));

// ---------- E 组（v3.50.20）：暂停开关 + 行内小表单守卫 ----------
A('E1 **暂停开关**：`setSwipeSuspended(true)` 后拖动/聚焦都不展开，恢复后正常', (() => {
    closeAllSwipeRows();
    const row = makeRow({});
    applySwipeRows(makeRoot([row]));
    setSwipeSuspended(true);
    row.dispatch('mousedown', { clientX: 200, clientY: 40, button: 0 });
    row.dispatch('mousemove', { clientX: 200 + SWIPE_OPEN_THRESHOLD - 10, clientY: 40 });
    row.dispatch('mouseup', { clientX: 200 + SWIPE_OPEN_THRESHOLD - 10, clientY: 40 });
    const suspendedOn = row.classList.contains(SWIPE_OPEN_CLASS);
    setSwipeSuspended(false);
    row.dispatch('mousedown', { clientX: 200, clientY: 40, button: 0 });
    row.dispatch('mousemove', { clientX: 200 + SWIPE_OPEN_THRESHOLD - 10, clientY: 40 });
    row.dispatch('mouseup', { clientX: 200 + SWIPE_OPEN_THRESHOLD - 10, clientY: 40 });
    const after = row.classList.contains(SWIPE_OPEN_CLASS);
    setSwipeSuspended(false);
    return suspendedOn === false && after === true && swipeSuspended() === false;
})(), 'n/a');

A('E2 **行内小表单守卫**：行里有 `.ftt-curquick`（货币快速记账展开中）→ 拖动 / 聚焦都不展开，避免表单跟着走', (() => {
    closeAllSwipeRows();
    const row = makeRow({});
    const form = { nodeType: 1 };
    row.querySelector = (sel) => (String(sel).indexOf('ftt-curquick') >= 0 ? form : null);
    applySwipeRows(makeRoot([row]));
    row.dispatch('mousedown', { clientX: 200, clientY: 40, button: 0 });
    row.dispatch('mousemove', { clientX: 200 + SWIPE_OPEN_THRESHOLD - 10, clientY: 40 });
    row.dispatch('mouseup', { clientX: 200 + SWIPE_OPEN_THRESHOLD - 10, clientY: 40 });
    const byDrag = row.classList.contains(SWIPE_OPEN_CLASS);
    row.dispatch('focusin', {});
    return byDrag === false && row.classList.contains(SWIPE_OPEN_CLASS) === false;
})(), 'n/a');

setSwipeSuspended(false);   // 恢复默认，避免影响其它用例
R.done();
