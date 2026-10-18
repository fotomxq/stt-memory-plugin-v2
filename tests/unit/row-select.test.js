// ============================================================
// 单元测试 · v3.50.16：**多选模式改「点行即选」**
//   用户原话：「各大类清单带有多选功能的设计进行调整，启动多选模式后，不需要勾选按钮，
//            而是改为点击即加入选择。提高UI交互的便利性。」
//
// 口径（`ui/row-select.js`）：
//   · 多选模式下**不再渲染 `<input type="checkbox">`**（行本身即选择控件）；
//   · 点行 = 切换选择；点行内**按钮 / 链接 / 输入** = 执行原动作（不抢选择）；
//   · 选中态 = 行样式 `.ftt-sel-on` + 行首**只读**记号 `☑/☐`（不是控件）；
//   · 键盘 Enter / Space 等价于点行；`sync()` 局部同步工具行按钮（不整页重绘）。
//
// 运行：node tests/unit/row-select.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setChatHooks, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setTimerHooks, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    ROW_SEL_ATTR, ROW_ON_CLASS, ROW_MARK_CLASS, ROW_INTERACTIVE,
    rowSelectMarkHtml, rowSelectAttrs, rowSelectClick, rowSelectKeydown, rowSelectFrom, rowSelectHitInteractive,
} from '../../ui/row-select.js';

const R = makeReporter('row-select v3.50.16：多选模式「点行即选」（不要勾选按钮）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
setChatHooks({ dbgLog: () => undefined });
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
setScopeKey('sel16'); setLastMessageId(3);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
setTimerHooks({ set: () => 0, clear: () => 0 });
setNotifyHooks({ toast: () => undefined });
setKernelState(emptyState());

/** 造一个最小可用的「行」DOM 桩（含 classList / querySelector / getAttribute / parentNode） */
function mkRow(kind, id, opts) {
    const o = opts || {};
    const children = [];
    const make = (tag) => ({
        tagName: String(tag).toUpperCase(),
        textContent: '',
        attrs: {},
        classList: { _s: new Set(o.on ? [ROW_ON_CLASS] : []), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        parentNode: null, parentElement: null,
        querySelector(sel) { return (sel === '.' + ROW_MARK_CLASS) ? mark : null; },
        addEventListener() { },
        closest() { return null; },
    });
    const row = make('div');
    row.attrs[ROW_SEL_ATTR] = kind;
    row.attrs['data-ftt-id'] = id;
    const mark = make('span');
    mark.className = ROW_MARK_CLASS;
    mark.textContent = o.on ? '☑' : '☐';
    const btn = make('button');
    btn.parentNode = row;
    children.push(mark, btn);
    row.children = children;
    return { row: row, mark: mark, btn: btn };
}

// ---------- A 组：标记层（不要勾选按钮） ----------
A('A1 **不再输出复选框**：`rowSelectMarkHtml(on)` 是**只读记号**（`☑`/`☐` 的 span + `aria-hidden`），不含 `<input`', (() => {
    const a = rowSelectMarkHtml(true), b = rowSelectMarkHtml(false);
    return a.indexOf('<input') < 0 && b.indexOf('<input') < 0
        && a.indexOf('☑') >= 0 && b.indexOf('☐') >= 0
        && a.indexOf(ROW_MARK_CLASS) >= 0 && a.indexOf('aria-hidden="true"') >= 0;
})(), 'n/a');

A('A2 **panel.js 已接线（最小改动）**：导入新模块 · 两处清单渲染改用记号/行属性 · **不再拼复选框** · 交互委托收在模块里（面板一行 bindRowSelect）', (() => {
    const src = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8');
    const mod = readFileSync(join(ROOT, 'ui', 'row-select.js'), 'utf8');
    return src.indexOf("from './row-select.js'") >= 0
        && src.indexOf('rowSelectMarkHtml(') >= 0
        && src.indexOf('rowSelectAttrs(') >= 0
        && src.indexOf('bindRowSelect(el,') >= 0
        && src.indexOf('data-ftt-select="') < 0      // 多选复选框的渲染标记已整体移除
        && mod.indexOf('export function bindRowSelect') >= 0
        && src.indexOf('rowSelectClick(e,') >= 0        // click 复用既有动作分发入口（不新增监听）
        && mod.indexOf("addEventListener('keydown'") >= 0;
})(), 'n/a');
A('A3 行属性：`rowSelectAttrs(kind,id,on)` 带标记 + id + `tabindex="0"`，选中时带 `.ftt-sel-on` 类；空值不产生属性', (() => {
    const on = rowSelectAttrs('memories', 'm1', true);
    const off = rowSelectAttrs('memories', 'm2', false);
    return on.indexOf(ROW_SEL_ATTR + '="memories"') >= 0 && on.indexOf('data-ftt-id="m1"') >= 0
        && on.indexOf(ROW_ON_CLASS) >= 0 && on.indexOf('tabindex="0"') >= 0
        && off.indexOf(ROW_ON_CLASS) < 0
        && rowSelectAttrs('', 'x', true) === '' && rowSelectAttrs('k', '', true) === '';
})(), () => J(rowSelectAttrs('memories', 'm1', true)));

// ---------- B 组：点行即选 ----------
A('B1 **点行 = 加入选择**：命中行 → 集合加 id、行打 `.ftt-sel-on`、记号变 `☑`、并调用 `sync()`（局部同步按钮）', (() => {
    const { row, mark } = mkRow('memories', 'm1', { on: false });
    const set = new Set();
    let synced = 0;
    const hit = rowSelectClick({ target: row }, { getSel: () => set, sync: () => { synced += 1; } });
    return hit === 'memories' && set.has('m1') && row.classList.contains(ROW_ON_CLASS)
        && mark.textContent === '☑' && synced === 1;
})(), 'n/a');

A('B2 **再点 = 移出选择**（切换语义）', (() => {
    const { row, mark } = mkRow('memories', 'm1', { on: true });
    const set = new Set(['m1']);
    rowSelectClick({ target: row }, { getSel: () => set });
    return !set.has('m1') && !row.classList.contains(ROW_ON_CLASS) && mark.textContent === '☐';
})(), 'n/a');

A('B3 **点行内按钮不抢**：目标落在 button / a / input 上 → 不切换选择（返回空串，原动作照旧执行）', (() => {
    const { row, btn } = mkRow('memories', 'm1', { on: false });
    const set = new Set();
    const hitBtn = rowSelectClick({ target: btn }, { getSel: () => set });
    return hitBtn === '' && set.size === 0
        && rowSelectHitInteractive(btn) === true
        && rowSelectHitInteractive(row) === false
        // 选择器清单里三类可交互控件齐备
        && ROW_INTERACTIVE.indexOf('button') >= 0 && ROW_INTERACTIVE.indexOf('input') >= 0 && ROW_INTERACTIVE.indexOf('[data-ftt-action]') >= 0;
})(), 'n/a');

A('B4 **点空白/非行目标不动作**：没有 `data-ftt-selrow` 的节点 → 返回空串，集合不变', (() => {
    const plain = { tagName: 'DIV', getAttribute: () => null, parentNode: null };
    const set = new Set();
    return rowSelectClick({ target: plain }, { getSel: () => set }) === '' && set.size === 0;
})(), 'n/a');

A('B5 **键盘可达**：行上 Enter / Space 等价于点选（并 `preventDefault` 防滚动）', (() => {
    const { row } = mkRow('atoms', 'a1', { on: false });
    const set = new Set();
    let prevented = 0;
    const hit = rowSelectKeydown({ key: 'Enter', target: row, preventDefault: () => { prevented += 1; } }, { getSel: () => set });
    const hit2 = rowSelectKeydown({ key: 'x', target: row }, { getSel: () => set });
    return hit === 'atoms' && set.has('a1') && prevented === 1 && hit2 === '';
})(), 'n/a');

// ---------- C 组：从目标向上找行 ----------
A('C1 `rowSelectFrom` 从行内子节点向上找到行（≤8 层），且不越过非行祖先', (() => {
    const { row, mark } = mkRow('items', 'i1', { on: false });
    mark.parentNode = row;
    const near = rowSelectFrom(mark);
    const far = { tagName: 'SPAN', getAttribute: () => null, parentNode: null };
    return near === row && rowSelectFrom(far) === null;
})(), 'n/a');

A('C2 降级安全：DOM 能力缺失（无 classList / querySelector）时**仍更新集合**，不抛错', (() => {
    const row = { getAttribute: (k) => (k === ROW_SEL_ATTR ? 'plans' : (k === 'data-ftt-id' ? 'p1' : null)), tagName: 'DIV' };
    const set = new Set();
    const hit = rowSelectClick({ target: row }, { getSel: () => set });
    return hit === 'plans' && set.has('p1');
})(), 'n/a');

R.done();
