// ============================================================
// 单元测试 · ui/commands + devtools（命令/宏/调试导出）
// ============================================================
import { makeReporter, makeHost } from '../harness/st-mock.js';
import { setContextProvider, resetContextProvider } from '../../host/st-api.js';
import { statusText, registerSlashCommand, registerMacros } from '../../ui/commands.js';
import { buildSnapshot, installDevtools, uninstallDevtools } from '../../devtools.js';
import { VERSION, MODULE_NAME } from '../../core/constants.js';

const R = makeReporter('ui-commands+devtools 命令与调试');

const host = makeHost();
setContextProvider(() => host.ctx);

R.assert('C1 statusText 含版本与宿主状态', (() => {
    const t = statusText({ host: true, probe: { missing: [] }, bind: { bound: ['A'], missing: [] }, interceptor: { calls: 3, lastType: 'normal' } });
    return t.indexOf(VERSION) >= 0 && t.indexOf('宿主：已连接') >= 0 && t.indexOf('能力探测：全部可用') >= 0 && t.indexOf('拦截器调用：3') >= 0;
})(), statusText({ host: true }));
// v2.42.0：命令回调统一包了一层追踪（`tracedCommand`）→ 变为 async，须 await 其返回值
// v3.45.4（`docs/D22` W10）：新增 `/ftt-readonly`（`技-41` ⑥ 只读清单，与桥白名单同源）与
//   `/ftt-perf`（`技-40` 性能与卡顿，与桥方法 `ftt.perf*` **同名同源**）→ 注册命令数 1 → 3。
const C2 = await (async () => {
    const ok = registerSlashCommand(() => ({ host: true }));
    const cmd = (host.ctx.commands || [])[0] || {};
    const out = (typeof cmd.callback === 'function') ? await cmd.callback() : '';
    const names = (host.ctx.commands || []).map((c) => String(c.name));
    const ro = (host.ctx.commands || []).find((c) => c.name === 'ftt-readonly') || {};
    const roOut = (typeof ro.callback === 'function') ? await ro.callback(null, '') : '';
    const perf = (host.ctx.commands || []).find((c) => c.name === 'ftt-perf') || {};
    const perfOut = (typeof perf.callback === 'function') ? await perf.callback(null, '') : '';
    return ok === true && Array.isArray(host.ctx.commands) && host.ctx.commands.length === 3
        && cmd.name === 'ftt' && typeof cmd.callback === 'function'
        && String(out).indexOf(VERSION) >= 0
        && names.indexOf('ftt-readonly') >= 0 && names.indexOf('ftt-perf') >= 0
        // 只读清单必须**显式**列出清空型动作（Q4 裁决：清空型不进桥、只在面板 / 命令里走二次确认）
        && String(roOut).indexOf('只读清单') >= 0 && String(roOut).indexOf('清空型') >= 0
        && String(perfOut).indexOf('性能与卡顿') >= 0;
})();
R.assert('C2 registerSlashCommand 注册 /ftt + /ftt-readonly + /ftt-perf（回调经追踪包装，await 后返回文本；只读清单与性能读数可用）', C2, host.ctx.commands);
R.assert('C3 registerMacros 走新宏系统', (() => {
    const ok = registerMacros(() => ({ host: true }));
    const names = (host.ctx.macrosRegistered || []).map(x => x.name);
    return ok === true && names.indexOf('fttVersion') >= 0 && names.indexOf('fttStatus') >= 0;
})(), host.ctx.macrosRegistered);

const bare = makeHost({ noSlash: true, noMacros: true });
setContextProvider(() => bare.ctx);
R.assert('C4 缺命令/宏能力时返回 false 而不抛异常', registerSlashCommand(() => ({})) === false && registerMacros(() => ({})) === false, '');

setContextProvider(() => makeHost().ctx);
R.assert('C5 buildSnapshot 结构完整（版本/宿主/17 维/九事件）', (() => {
    const s = buildSnapshot();
    return s.version === VERSION && s.moduleName === MODULE_NAME && s.host === true
        && s.dimensions.length === 17 && s.hostEvents.length === 9   /* v3.47.0（+maps）；v3.51.0（W32）：+ledger/+deals（17 维） */ && !!s.probe && !!s.settings;
})(), buildSnapshot().dimensions.length);
R.assert('C6 installDevtools 暴露 window.FTT（快照函数可用）', (() => {
    const ok = installDevtools();
    const F = globalThis.FTT;
    return ok === true && !!F && F.version === VERSION && typeof F.snapshot === 'function' && F.snapshot().version === VERSION;
})(), typeof globalThis.FTT);
R.assert('C7 uninstallDevtools 清理', uninstallDevtools() === true && globalThis.FTT === undefined, typeof globalThis.FTT);

resetContextProvider();
R.done();
