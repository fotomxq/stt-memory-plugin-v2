// ============================================================
// 单元测试 · host/inject + adapters/settings（注入通道与配置持久化）
// ============================================================
import { makeReporter, makeHost } from '../harness/st-mock.js';
import { setContextProvider, resetContextProvider } from '../../host/st-api.js';
import { setInject, clearInject, readInject, injectAvailable, DEFAULT_INJECT_OPTS } from '../../host/inject.js';
import { getSettings, saveSettings, resetSettings, setSetting, DEFAULT_SETTINGS } from '../../adapters/settings.js';
import { MODULE_NAME, INJECT_ID, VERSION, PROMPT_POSITION } from '../../core/constants.js';

const R = makeReporter('inject+settings 注入与配置');

const host = makeHost();
setContextProvider(() => host.ctx);

R.assert('S1 注入可用性判定', injectAvailable() === true, '');
R.assert('S2 写入注入：键唯一 + 默认位置/深度/角色正确', (() => {
    const r = setInject('记忆正文');
    const p = host.ctx.extensionPrompts[INJECT_ID];
    return r.ok === true && r.length === 4 && !!p && p.value === '记忆正文'
        && p.position === PROMPT_POSITION.IN_PROMPT && p.depth === 0 && p.scan === false && p.role === 0;
})(), host.ctx.extensionPrompts);
R.assert('S3 自定义位置/深度/角色透传', (() => {
    setInject('x', { position: PROMPT_POSITION.IN_CHAT, depth: 4, scan: true, role: 1 });
    const p = host.ctx.extensionPrompts[INJECT_ID];
    return p.position === 1 && p.depth === 4 && p.scan === true && p.role === 1;
})(), host.ctx.extensionPrompts[INJECT_ID]);
R.assert('S4 readInject 读回正文长度', (() => {
    setInject('abcd');
    return readInject() === 'abcd' && readInject().length === 4;
})(), readInject());
R.assert('S5 clearInject 显式置空（不留残留注入）', (() => {
    clearInject();
    return readInject() === '' && host.ctx.extensionPrompts[INJECT_ID].value === '';
})(), readInject());
R.assert('S6 默认参数对象冻结（防止被外部改写）', Object.isFrozen(DEFAULT_INJECT_OPTS) === true, '');

R.assert('S7 配置初始化：默认键补齐 + 自动保存一次', (() => {
    host.ctx.saveSettingsCount = 0;
    const s = getSettings();
    return Object.keys(DEFAULT_SETTINGS).every(k => s[k] !== undefined)
        && s.version === VERSION && host.ctx.saveSettingsCount >= 1;
})(), { keys: Object.keys(host.ctx.extensionSettings[MODULE_NAME] || {}), saves: host.ctx.saveSettingsCount });
R.assert('S8 用户值不被默认值覆盖', (() => {
    host.ctx.extensionSettings[MODULE_NAME].charBudget = 777;
    const s = getSettings();
    return s.charBudget === 777;
})(), getSettings().charBudget);
R.assert('S9 setSetting 写入已知键 / 拒绝未知键', (() => {
    const ok1 = setSetting('enabled', false) && getSettings().enabled === false;
    const ok2 = setSetting('不存在的键', 1);
    setSetting('enabled', true);
    return ok1 === true && ok2 === false;
})(), '');
R.assert('S10 resetSettings 只重置已知键（保留未知键）', (() => {
    host.ctx.extensionSettings[MODULE_NAME].futureKey = 'keep-me';
    host.ctx.extensionSettings[MODULE_NAME].charBudget = 5;
    resetSettings();
    const s = getSettings();
    return s.charBudget === DEFAULT_SETTINGS.charBudget && s.futureKey === 'keep-me';
})(), host.ctx.extensionSettings[MODULE_NAME]);
R.assert('S11 无宿主时配置函数安全降级', (() => {
    resetContextProvider();
    const s = getSettings();
    const saved = saveSettings();
    const injected = setInject('x');
    setContextProvider(() => host.ctx);
    return s.enabled === DEFAULT_SETTINGS.enabled && saved === false && injected.ok === false && String(injected.reason).indexOf('missing') >= 0;
})(), '');

// v2.94.0 修复回归：三个「运行时账本」键此前**不在 DEFAULT_SETTINGS**，而 `setSetting` 拒绝未知键 →
//   写人工确认项 / 管线耗时样本 / 删楼账本的调用**静默失败**（只活在内存里，重开面板即清空）。
R.assert('S11 v2.94.0 回归：运行时账本键（syncConflicts / pipelineEta / floorTrimLog）在册且**真的能落盘**', (() => {
    const known = ['syncConflicts', 'pipelineEta', 'floorTrimLog'].map((k) => Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k));
    const w1 = setSetting('syncConflicts', [{ id: 'x', kind: '删楼' }]);
    const w2 = setSetting('pipelineEta', { 摘要: [1200, 900] });
    const w3 = setSetting('floorTrimLog', { slot: 1, items: [{ keep: 10 }] });
    const s = getSettings();
    return known.every(Boolean) && w1 === true && w2 === true && w3 === true
        && Array.isArray(s.syncConflicts) && s.syncConflicts.length === 1 && s.syncConflicts[0].kind === '删楼'
        && s.pipelineEta && s.pipelineEta['摘要'].length === 2
        && s.floorTrimLog && s.floorTrimLog.slot === 1;
})(), () => JSON.stringify({ s: getSettings().syncConflicts, e: getSettings().pipelineEta, t: getSettings().floorTrimLog }));

R.assert('S12 v2.94.0 回归：对象/数组默认值**深拷贝**（不与冻结的 DEFAULT_SETTINGS 共享引用 → 首次写入不抛错）', (() => {
    delete host.ctx.extensionSettings[MODULE_NAME].syncConflicts;
    const a = getSettings().syncConflicts;
    a.push({ id: 'y' });                                   // 若共享冻结引用，这里会抛 TypeError（ESM 严格模式）
    const b = setSetting('syncConflicts', a) && getSettings().syncConflicts.length === 1;
    return b === true && DEFAULT_SETTINGS.syncConflicts.length === 0;
})(), '');

resetContextProvider();
R.done();
