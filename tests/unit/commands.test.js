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
R.assert('C2 registerSlashCommand 注册 /ftt', (() => {
    const ok = registerSlashCommand(() => ({ host: true }));
    return ok === true && Array.isArray(host.ctx.commands) && host.ctx.commands.length === 1
        && host.ctx.commands[0].name === 'ftt' && typeof host.ctx.commands[0].callback === 'function'
        && String(host.ctx.commands[0].callback()).indexOf(VERSION) >= 0;
})(), host.ctx.commands);
R.assert('C3 registerMacros 走新宏系统', (() => {
    const ok = registerMacros(() => ({ host: true }));
    const names = (host.ctx.macrosRegistered || []).map(x => x.name);
    return ok === true && names.indexOf('fttVersion') >= 0 && names.indexOf('fttStatus') >= 0;
})(), host.ctx.macrosRegistered);

const bare = makeHost({ noSlash: true, noMacros: true });
setContextProvider(() => bare.ctx);
R.assert('C4 缺命令/宏能力时返回 false 而不抛异常', registerSlashCommand(() => ({})) === false && registerMacros(() => ({})) === false, '');

setContextProvider(() => makeHost().ctx);
R.assert('C5 buildSnapshot 结构完整（版本/宿主/14 维/九事件）', (() => {
    const s = buildSnapshot();
    return s.version === VERSION && s.moduleName === MODULE_NAME && s.host === true
        && s.dimensions.length === 14 && s.hostEvents.length === 9 && !!s.probe && !!s.settings;
})(), buildSnapshot().dimensions.length);
R.assert('C6 installDevtools 暴露 window.FTT（快照函数可用）', (() => {
    const ok = installDevtools();
    const F = globalThis.FTT;
    return ok === true && !!F && F.version === VERSION && typeof F.snapshot === 'function' && F.snapshot().version === VERSION;
})(), typeof globalThis.FTT);
R.assert('C7 uninstallDevtools 清理', uninstallDevtools() === true && globalThis.FTT === undefined, typeof globalThis.FTT);

resetContextProvider();
R.done();
