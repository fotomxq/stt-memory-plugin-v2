// ============================================================
// 单元测试 · host/st-api（上下文访问、能力探测、角色作用域）
// ============================================================
import { makeReporter, makeHost } from '../harness/st-mock.js';
import { setContextProvider, resetContextProvider, getCtx, hasHost, safeCall, probeCapabilities, ownManifest, currentCharScope } from '../../host/st-api.js';

const R = makeReporter('host-st-api 宿主适配');

// 1) 无宿主：所有函数必须安全降级
resetContextProvider();
R.assert('A1 无宿主：hasHost=false 且 getCtx=null', hasHost() === false && getCtx() === null, '');
R.assert('A2 无宿主：probe 报 context 缺失且不抛异常', (() => {
    const p = probeCapabilities();
    return p.ok === false && p.need.context === false && Array.isArray(p.missing) && p.missing.length > 0;
})(), '');
R.assert('A3 无宿主：safeCall 返回 missing 而不抛异常', (() => {
    const r = safeCall('setExtensionPrompt', 'k');
    return r.ok === false && String(r.reason).indexOf('missing') === 0;
})(), '');
R.assert('A4 无宿主：ownManifest=null、currentCharScope=default', ownManifest('x') === null && currentCharScope() === 'default', currentCharScope());

// 2) 完整宿主：探测应基本全绿
const host = makeHost();
setContextProvider(() => host.ctx);
R.assert('A5 完整宿主：hasHost=true 且必需能力无缺失', hasHost() === true && probeCapabilities().ok === true && probeCapabilities().missingRequired.length === 0, probeCapabilities().missingRequired);
R.assert('A5b 探测区分必需/可选（可选缺失不影响 ok）', (() => {
    const p = probeCapabilities();
    return Array.isArray(p.missingOptional) && p.missingOptional.length === 0 && p.missing.length === p.missingRequired.length + p.missingOptional.length;
})(), probeCapabilities());
R.assert('A6 完整宿主：ownManifest 返回版本', (() => {
    const m = ownManifest('third-party/ftt-memory-v2');
    return !!m && m.version === '2.0.0';
})(), '');
R.assert('A7 safeCall 成功路径返回值', safeCall('getWorldInfoNames').value.length === 1, safeCall('getWorldInfoNames'));
R.assert('A8 currentCharScope 稳定且带 char: 前缀（同角色两次一致）', (() => {
    const a = currentCharScope(), b = currentCharScope();
    return a === b && a.indexOf('char:') === 0 && a.length === 13;
})(), currentCharScope());
R.assert('A9 角色切换 → 作用域变化', (() => {
    const before = currentCharScope();
    host.ctx.name2 = '角色乙';
    const after = currentCharScope();
    host.ctx.name2 = '角色甲';
    return before !== after;
})(), '');

// 3) 缺能力宿主：缺失清单精确
const bare = makeHost({ noEventSource: true, noInject: true, noTemplate: true, noSlash: true, noMacros: true });
setContextProvider(() => bare.ctx);
R.assert('A10 缺能力宿主：missing 精确列出缺失项', (() => {
    const p = probeCapabilities();
    const m = p.missing.join(',');
    return p.ok === false && p.missingRequired.join(',').indexOf('eventSource') >= 0
        && p.missingRequired.join(',').indexOf('setExtensionPrompt') >= 0
        && p.missingOptional.join(',').indexOf('renderExtensionTemplateAsync') >= 0
        && p.missingOptional.join(',').indexOf('SlashCommandParser') >= 0
        && p.missingOptional.join(',').indexOf('macros') >= 0;
})(), probeCapabilities().missing);
R.assert('A11 上下文提供者抛异常时不崩溃', (() => {
    setContextProvider(() => { throw new Error('boom'); });
    const r = hasHost() === false && getCtx() === null;
    resetContextProvider();
    return r;
})(), '');

resetContextProvider();
R.assert('A12 resetContextProvider 恢复默认（无宿主）', hasHost() === false, '');
R.done();
