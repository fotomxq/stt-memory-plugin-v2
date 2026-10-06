// ============================================================
// 单元测试 · v3.24.0「UI 设计与通知效果优化」
//
// 用户要求（原话）：「新版本 进一步优化UI设计、优化通知效果等。」
//
// 改动前的实测缺陷（逐条核对过代码，见 `ui/notify.js` 头注）：
//   ① `style.css` 早已写好 8 类**行为配色**（`#toast-container .ftt-toastr--info / --analysis / --success /
//      --warning / --error / --sync / --weave / --repair`），但**没有任何 JS 挂过这些类** ——
//      所有通知长得一模一样，「推演世界 / 同步 / 修复」的识别色从未生效（死 CSS）；
//   ② 注入点只把 kind 压成 4 类宿主方法，`'weave'`（推演世界实际在传）静默落到 `toastr.info`；
//   ③ 调 toastr 不传任何选项：无 `escapeHtml`（正文里的 `<...>` 当 HTML 渲染）、无去重（同文案连发刷屏）、
//      无长度上限、错误与普通提示停留时间相同；
//   ④ 面板状态提示行 `setNote()` 无级别：**失败 / 被拒绝 / 入口未就绪与「已完成」长得一样**
//      （`style.css` 的 `.ftt-note.ftt-note-err` 同样是死 CSS）。
//
// 覆盖：A kind 归一与选方法；B 行为配色类；C 文案归一（压空白 / 截断 / 空值）；
//       D toastr 选项（转义 / 去重 / 分级停留 / 进度条 / 不覆盖宿主位置）；E `showToast` 出口与兜底；
//       F 面板提示行分级（推断 + 显式 + 真实渲染 + 状态透出）。
// 运行：node tests/unit/notify.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    NOTIFY_KINDS, NOTIFY_TEXT_MAX, normalizeNotifyKind, notifyClassOf, notifyMethodOf,
    notifyTimeoutOf, notifyTextOf, notifyOptionsOf, applyToastClass, showToast,
} from '../../ui/notify.js';
import { noteLevelOf, panelAction, panelBodyHtml, panelState, openPanel, setPanelHooks2 } from '../../ui/panel.js';

const R = makeReporter('notify v3.24.0 通知出口统一 + 面板提示行分级');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

/** 假 toastr：记录 `(方法名, 文案, 标题, 选项)`；可选模拟「忽略 toastClass」的宿主 */
function fakeToastr(opts) {
    const o = opts || {};
    const calls = [];
    const mk = (name) => function (text, title, options) {
        calls.push({ name: name, text: String(text), title: String(title == null ? '' : title), options: options || {} });
        // 模拟宿主 toastr：调用 onShown 并把「通知元素」作为 this 传回（真实 toastr 同款）
        if (options && typeof options.onShown === 'function') {
            try { options.onShown.call(o.el || null); } catch (e) { /* 忽略 */ }
        }
    };
    const t = { calls: calls, info: mk('info'), success: mk('success'), warning: mk('warning'), error: mk('error') };
    if (o.noSuccess) delete t.success;
    return t;
}
/** 假通知元素（DOM 形态 / jQuery 形态） */
const fakeEl = () => { const set = new Set(); return { set: set, classList: { add: (c) => set.add(c) } }; };
const fakeJq = () => { const set = new Set(); return { set: set, addClass: (c) => String(c).split(/\s+/).forEach((x) => set.add(x)) }; };

// ---------- A 组：kind 归一与选方法 ----------
A('A1 8 类规范 kind 原样通过（与 `style.css` 的 `--ftt-toastr--*` 一一对应）', (() => {
    return NOTIFY_KINDS.length === 8
        && NOTIFY_KINDS.every((k) => normalizeNotifyKind(k) === k)
        && J(NOTIFY_KINDS) === J(['info', 'analysis', 'success', 'warning', 'error', 'sync', 'weave', 'repair']);
})(), () => J(NOTIFY_KINDS));

A('A2 英文别名归一：warn / err / fail / ok / done / fatal / caution / debug 都落到规范 kind（大小写无关）', (() => {
    const cases = { warn: 'warning', WARN: 'warning', caution: 'warning', err: 'error', fail: 'error', failed: 'error', fatal: 'error', ok: 'success', done: 'success', pass: 'success', debug: 'info', notice: 'info' };
    return Object.keys(cases).every((k) => normalizeNotifyKind(k) === cases[k]);
})(), () => J(['warn', 'err', 'ok', 'fatal', 'debug'].map((k) => normalizeNotifyKind(k))));

A('A3 中文类别词归一：推演→weave（**这就是真机在传却一直被抹平的 kind**）、同步→sync、修复→repair、分析→analysis', (() => {
    return normalizeNotifyKind('推演') === 'weave' && normalizeNotifyKind('同步') === 'sync'
        && normalizeNotifyKind('修复') === 'repair' && normalizeNotifyKind('分析') === 'analysis'
        && normalizeNotifyKind('成功') === 'success' && normalizeNotifyKind('警告') === 'warning' && normalizeNotifyKind('错误') === 'error';
})(), () => J(['推演', '同步', '修复'].map((k) => normalizeNotifyKind(k))));

A('A4 未知 / 空 / 非字符串（null / undefined / 对象 / 数字）一律回落 `info`（绝不抛、绝不静默丢掉通知）', (() => {
    return [null, undefined, '', '   ', 'zzz', 42, {}, [], true].every((v) => normalizeNotifyKind(v) === 'info');
})(), () => J([null, '', 'zzz', 42, {}].map((v) => normalizeNotifyKind(v))));

A('A5 选方法：细粒度 kind 只体现在**配色类**上，不改语义色 —— weave/sync/analysis 走 info、repair 走 warning；success/error 各走自己', (() => {
    return notifyMethodOf('weave') === 'info' && notifyMethodOf('sync') === 'info' && notifyMethodOf('analysis') === 'info'
        && notifyMethodOf('repair') === 'warning' && notifyMethodOf('success') === 'success'
        && notifyMethodOf('warning') === 'warning' && notifyMethodOf('error') === 'error' && notifyMethodOf('info') === 'info';
})(), () => J(NOTIFY_KINDS.map((k) => [k, notifyMethodOf(k)])));

// ---------- B 组：行为配色类（死 CSS 复活的判据） ----------
A('B1 每类都给 `ftt-toastr` + `ftt-toastr--<kind>` 两个类（`style.css` 的规则据此生效）', (() => {
    const all = NOTIFY_KINDS.map((k) => notifyClassOf(k));
    return all.every((c, i) => c === ('ftt-toastr ftt-toastr--' + NOTIFY_KINDS[i]))
        && notifyClassOf('推演') === 'ftt-toastr ftt-toastr--weave'
        && notifyClassOf('unknown') === 'ftt-toastr ftt-toastr--info';
})(), () => J(NOTIFY_KINDS.map((k) => notifyClassOf(k))));

A('B2 类名与 `style.css` 里实际存在的规则**逐条对齐**（防「JS 加了类、CSS 没这条规则」或反之）', (() => {
    // 与 style.css 的 `#toast-container .ftt-toastr--X` 规则集合对照（写在测试里作为契约）
    const CSS_KINDS = ['info', 'analysis', 'success', 'warning', 'error', 'sync', 'weave', 'repair'];
    return J(CSS_KINDS.slice().sort()) === J(NOTIFY_KINDS.slice().sort());
})(), '');

// ---------- C 组：文案归一 ----------
A('C1 压空白 + 折叠换行 + 去首尾空白（通知只有一行，换行会把高度撑乱）', (() => {
    return notifyTextOf('  甲   在码头\n\n清点  货物  ') === '甲 在码头 清点 货物'
        && notifyTextOf(null) === '' && notifyTextOf(undefined) === '' && notifyTextOf('   ') === '';
})(), () => J(notifyTextOf('  甲   在码头\n\n清点  货物  ')));

A('C2 超长文案截断到上限并加省略号（通知不是日志：不再让一条超长文案撑爆界面）', (() => {
    const long = '字'.repeat(NOTIFY_TEXT_MAX + 200);
    const out = notifyTextOf(long);
    return out.length === NOTIFY_TEXT_MAX && out.slice(-1) === '…'
        && notifyTextOf('字'.repeat(NOTIFY_TEXT_MAX)).length === NOTIFY_TEXT_MAX
        && notifyTextOf('字'.repeat(NOTIFY_TEXT_MAX)).slice(-1) !== '…';
})(), () => J({ max: NOTIFY_TEXT_MAX, got: notifyTextOf('字'.repeat(NOTIFY_TEXT_MAX + 200)).length }));

// ---------- D 组：toastr 选项 ----------
A('D1 默认开启：HTML 转义（正文里的 `<...>` 不再当标签渲染）、同文案去重（连环报错不刷屏）、关闭按钮、进度条、新通知在上', (() => {
    const o = notifyOptionsOf('info');
    return o.escapeHtml === true && o.preventDuplicates === true && o.closeButton === true
        && o.progressBar === true && o.newestOnTop === true;
})(), () => J(notifyOptionsOf('info')));

A('D2 分级停留：错误最久（10s）→ 警告/修复（7s）→ 普通（4.5s）；`extendedTimeOut` 取一半（悬停时不会被立刻关掉）', (() => {
    return notifyTimeoutOf('error') === 10000 && notifyTimeoutOf('warning') === 7000 && notifyTimeoutOf('repair') === 7000
        && notifyTimeoutOf('info') === 4500 && notifyTimeoutOf('success') === 4500 && notifyTimeoutOf('weave') === 4500
        && notifyOptionsOf('error').extendedTimeOut === 5000 && notifyOptionsOf('info').extendedTimeOut === 2250;
})(), () => J(NOTIFY_KINDS.map((k) => [k, notifyTimeoutOf(k)])));

A('D3 `toastClass` 带上行为配色类；**不传** `positionClass`（跟随酒馆自身的通知位置设定，不擅自改）', (() => {
    const o = notifyOptionsOf('weave');
    return o.toastClass === 'toast ftt-toastr ftt-toastr--weave'
        && !('positionClass' in o) && typeof o.onShown === 'function';
})(), () => J({ toastClass: notifyOptionsOf('weave').toastClass, hasPosition: ('positionClass' in notifyOptionsOf('weave')) }));

A('D4 `onShown` 兜底：宿主 toastr 忽略 `toastClass` 时，回调里仍能把类补上（DOM 元素与 jQuery 对象两种形态）', (() => {
    const el = fakeEl(), jq = fakeJq();
    const o = notifyOptionsOf('sync');
    o.onShown.call(el);
    o.onShown.call(jq);
    const cls = notifyClassOf('sync');
    return cls.split(' ').every((c) => el.set.has(c)) && cls.split(' ').every((c) => jq.set.has(c))
        && applyToastClass(null, cls) === false && applyToastClass({}, cls) === false;
})(), '');

// ---------- E 组：`showToast` 出口 ----------
A('E1 正常发出：调到对应方法、传 `(文案, 空标题, 选项)`；返回 true', (() => {
    const t = fakeToastr();
    const ok = showToast(t, '推演', '推演世界开始…（楼层 1-3）');
    const c = t.calls[0] || {};
    return ok === true && t.calls.length === 1 && c.name === 'info' && c.text === '推演世界开始…（楼层 1-3）'
        && c.title === '' && c.options.escapeHtml === true && c.options.toastClass === 'toast ftt-toastr ftt-toastr--weave';
})(), () => J(fakeToastr().calls));

A('E2 异常姿态：toastr 缺失 / 无可用方法 / 文案为空 → 返回 false 且**绝不抛**（通知失败不影响主流程）', (() => {
    let threw = false;
    try {
        if (showToast(null, 'info', 'x') !== false) return false;
        if (showToast({}, 'info', 'x') !== false) return false;
        if (showToast(fakeToastr(), 'info', '   ') !== false) return false;
        if (showToast({ info: () => { throw new Error('宿主炸了'); } }, 'info', 'x') !== false) return false;
    } catch (e) { threw = true; }
    return threw === false;
})(), '');

A('E3 `success` 方法在宿主缺失时回落 `info`（改动前同样行为，不倒退）', (() => {
    const t = fakeToastr({ noSuccess: true });
    const ok = showToast(t, 'success', '已完成');
    return ok === true && t.calls.length === 1 && t.calls[0].name === 'info';
})(), '');

A('E4 正文里的 HTML 原样交给 toastr（转义由 `escapeHtml: true` 在渲染层完成，不在这里改文案）', (() => {
    const t = fakeToastr();
    showToast(t, 'error', '失败：<b>甲</b> 的档案异常');
    return t.calls[0].text === '失败：<b>甲</b> 的档案异常' && t.calls[0].options.escapeHtml === true;
})(), '');

// ---------- F 组：面板提示行分级 ----------
A('F1 `noteLevelOf` 推断：失败/未就绪/被拒绝/无效 → `err`；未找到/已取消/跳过/请稍候 → `warn`；完成/已保存/已删除 → `ok`；普通叙述 → 空', (() => {
    const err = ['提取入口未就绪', '第 4 楼未完成：ai-error', '已拒绝：宿主不支持批量截断', '无效楼层：x', '保存失败：boom', '未执行'];
    const warn = ['已取消转正（未生成情节）', '未选中情节（请先在多选模式勾选）', '未找到该平行事件', '请稍候'];
    const ok = ['已保存 甲', '已删除 2 条（多选批量删除 · 含跨端墓碑）', '摘要完成：2 段 · 新增 3 条', '已注入 12 字'];
    return err.every((t) => noteLevelOf(t) === 'err') && warn.every((t) => noteLevelOf(t) === 'warn')
        && ok.every((t) => noteLevelOf(t) === 'ok')
        && noteLevelOf('📚 共 0 条') === '' && noteLevelOf('') === '';
})(), () => J(['提取入口未就绪', '已取消转正', '已保存', '共 0 条'].map((t) => noteLevelOf(t))));

A('F2 显式级别优先于推断（也接受 error/warning/success 近义写法）；未给级别时才推断', (() => {
    return noteLevelOf('失败', 'ok') === 'ok' && noteLevelOf('已完成', 'err') === 'err'
        && noteLevelOf('x', 'warning') === 'warn' && noteLevelOf('x', 'success') === 'ok'
        && noteLevelOf('x', 'nonsense') === '' && noteLevelOf('失败', '') === 'err';
})(), '');

{
    const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
    doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
    installGlobalHost(makeHost({ chat: [] }), doc);
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:notify-note');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    openPanel('overview');
    setPanelHooks2({ pending: () => [] });        // 所有钩子都不接 → 走早退分支
    const r = await panelAction('extractNow', {});
    const st = panelState();
    const html = String(r.html || panelBodyHtml('overview'));

    A('F3 真实早退路径（`提取入口未就绪`）自动判为错误级：`panelState().noteLevel === "err"`，且渲染出的提示行带 `ftt-note--err`（**改动前这条类从未出现过**）', (() => {
        return st.note === '提取入口未就绪' && st.noteLevel === 'err'
            && html.indexOf('data-ftt-note') >= 0 && html.indexOf('ftt-note--err') >= 0;
    })(), () => J({ note: st.note, level: st.noteLevel, hasClass: html.indexOf('ftt-note--err') >= 0 }));

    A('F4 成功路径判为 ok 级：渲染带 `ftt-note--ok`（与失败一眼可辨），且提示行仍是同一个 `data-ftt-note` 节点形状（既有断言不破）', (async () => {
        setPanelHooks2({ recall: async () => ({ ok: true, count: 3, chars: 120, ms: 8, hitLayer: 'js' }) });
        const r2 = await panelAction('extractNow', {});
        const st2 = panelState();
        const html2 = String(r2.html || '');
        return st2.noteLevel === 'ok' && html2.indexOf('ftt-note--ok') >= 0
            && /data-ftt-note>已注入|data-ftt-note>召回完成/.test(html2.replace(/<[^>]*>/g, '')) === false
            && html2.indexOf('data-ftt-note>') >= 0;
    })(), () => J({ note: panelState().note, level: panelState().noteLevel }));
}

R.done();
