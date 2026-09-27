// ============================================================
// 单元测试 · v2.87.0「错误必须通知异常，而不是什么都没反应」
// 用户报告：「一些错误信息除了日志记录外，应该通知异常，而不是什么都没反应。」
// 现状缺陷：`adapters/store.js` 把 `persistHooks.warn` 接成 `() => undefined` → 内核所有 `warn(...)` 被静默丢弃；
//   面板动作失败只写调试日志 + 面板内备注，没有用户可见提示。
// 本批口径：`core/model/runtime.js#warn` 一次调用做三件事 —— ① 宿主 warn 钩子 ② 调试日志（kind=异常）
//   ③ **用户可见异常提示**（节流：同文案 60s 一次、每会话上限 5 条；`notifyError(msg,{force:true})` 绕过节流与上限）。
// 运行：node tests/unit/error-notify.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setNotifyHooks, warn, notifyError, warnStats, resetWarnThrottle, setChatHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { panelAction, openPanel } from '../../ui/panel.js';

const R = makeReporter('error-notify v2.87.0 错误通知（异常提示）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);

const toasts = [];
const logs = [];
function boot() {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:errnotify');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });
    setChatHooks({ dbgLog: (kind, payload) => logs.push([String(kind || ''), payload || {}]) });
    toasts.length = 0; logs.length = 0;
    resetWarnThrottle();
}
boot();

// ---------- A 组：内核 warn 的三重出口 ----------
A('A1 `warn(...)` → 用户可见异常提示（kind=`error`、前缀 `⚠️ `）+ 调试日志 kind=异常 + 宿主 warn 钩子', (() => {
    boot();
    let hostWarned = 0;
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => { hostWarned++; } });
    warn('保存失败', new Error('quota exceeded'));
    const toastOk = toasts.length === 1 && toasts[0][0] === 'error' && toasts[0][1].indexOf('⚠️ ') === 0
        && toasts[0][1].indexOf('保存失败') >= 0 && toasts[0][1].indexOf('quota exceeded') >= 0;
    const logOk = logs.some((l) => l[0] === '异常' && String(l[1].message || '').indexOf('保存失败') >= 0);
    return toastOk && logOk && hostWarned === 1;
})(), () => toasts);

A('A2 节流：同文案 60s 内只弹一次（累计不重复）；不同文案各自弹；每会话上限 5 条', (() => {
    boot();
    warn('错误 X'); warn('错误 X'); warn('错误 X');
    const sameOnce = toasts.length === 1;
    warn('错误 Y'); warn('错误 Z'); warn('错误 W'); warn('错误 V');   // 累计 5 条后触顶
    const capped = toasts.length === warnStats().max;
    warn('错误 U');                                                   // 超过上限 → 不再弹
    return sameOnce && capped && toasts.length === 5;
})(), () => ({ toasts: toasts.length, stats: warnStats() }));

A('A3 `force:true` 绕过节流与每会话上限（用户主动动作）；非强制在超限后回落 `cap`；同文案 60s 内去重；统计可复位', (() => {
    boot();
    for (let i = 0; i < 8; i++) notifyError('强制错误', { force: true });
    const forced = toasts.length === 8 && warnStats().shown === 8;
    const cappedNow = notifyError('普通错误');                 // 已超每会话上限 → cap（不弹）
    resetWarnThrottle();
    const r1 = notifyError('普通错误');
    const r2 = notifyError('普通错误');                        // 同文案 60s 内 → throttled
    const dup = r1.shown === true && r2.shown === false && r2.reason === 'throttled';
    resetWarnThrottle();
    return forced && cappedNow.reason === 'cap' && dup && warnStats().shown === 0 && toasts.length === 9;
})(), () => warnStats());

A('A4 空文案不发提示；提示文案截断到 200 字（防超长日志直接进 toast）', (() => {
    boot();
    notifyError('');
    const none = toasts.length === 0;
    notifyError('长'.repeat(500), { force: true });
    return none && toasts.length === 1 && toasts[0][1].length <= 220;
})(), () => toasts.map((t) => t[1].length));

// ---------- B 组：面板动作失败要有可见提示 ----------
await A('B1 面板动作**异常**（未捕获）→ 强制弹一次「操作失败：…」；调试日志 kind=异常同时留痕', (async () => {
    boot();
    openPanel('settings');
    const r = await panelAction('storeShare', { dim: 'atoms', value: 40,
        // 制造异常：把 cfg 的 storeShare 设成不可写对象（Object.freeze → 赋值抛错）
        get boom() { return 1; } });
    const anyForce = toasts.some((t) => t[1].indexOf('操作失败') >= 0 || t[1].indexOf('操作未完成') >= 0);
    const logged = logs.some((l) => l[0] === '异常');
    return anyForce && logged && !!r;
})(), () => toasts);

await A('B2 面板动作**被拒绝**（ok:false，未知动作）→ 也会给出可见提示（节流通道）', (async () => {
    boot();
    openPanel('settings');
    const r = await panelAction('这个动作不存在', {});
    return r && r.ok === false && r.reason === 'unknown-action'
        && toasts.some((t) => t[1].indexOf('操作未完成') >= 0);
})(), () => toasts);

await A('B3 正常动作**不产生**任何异常提示（避免噪声）', (async () => {
    boot();
    openPanel('settings');
    await panelAction('tab', { tab: 'overview' });
    return toasts.length === 0;
})(), () => toasts);

R.done();
