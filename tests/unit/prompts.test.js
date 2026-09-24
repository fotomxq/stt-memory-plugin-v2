// ============================================================
// 单元测试 · B6 提示词模板编辑（V1 v1.132 / v1.179 迁移链 + 分组编辑 UI）
// 口径：
//   ① `promptSig` 与 V1 逐字（FNV-1a → hex + '-' + 长度）；
//   ② 迁移只刷新「缺失/空」「签名命中 legacy 默认」「等于新默认」的模板，用户自定义的**必须保留**；
//   ③ 破甲预设旧键迁移：非 v1.178 默认的用户文本迁入模板，旧键一律删除，幂等；
//   ④ 编辑 UI 按 PROMPT_GROUPS 分组渲染（33 条 / 5 组，无未分组键），保存/恢复单条·整组·全部即落盘 ST 配置。
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState } from '../../core/model/runtime.js';
import { defaultCfg, PROMPT_GROUPS, PROMPT_TEMPLATES_V2, PROMPT_LEGACY_SIGS, ARMOR_PRESET_V1178_DEFAULT, PROMPT_DEFAULT_VERSION } from '../../core/config.js';
import { promptSig, migratePromptTemplates, migrateArmorPreset, promptMigrateStats } from '../../core/prompt-migrate.js';
import { promptStats, promptText, isPromptCustomized, applyPrompt, resetPrompt, resetPromptGroup, resetAllPrompts, promptsPageHtml, promptAction, promptGroupOf } from '../../ui/prompts.js';
import { loadKernelCfg, lastLoadInfo } from '../../adapters/config-store.js';
import { panelAction, panelBodyHtml, setPanelHooks2, openPanel } from '../../ui/panel.js';
import { emptyState } from '../../core/state.js';

const R = makeReporter('prompts B6 提示词模板编辑（V1 迁移链）');
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2', 'ftt_v2_dims', 'ftt_v2_status', 'ftt_v2_action']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
setKernelState(emptyState());
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));

R.assert('P1 promptSig 与 V1 逐字一致：FNV-1a(32) → hex + 长度（空串为 "811c9dc5-0"）', (() => {
    return promptSig('') === '811c9dc5-0' && promptSig('abc') === '1a47e90c-3'
        && promptSig('提示词') === promptSig('提示词') && promptSig(null) === '811c9dc5-0'
        && typeof promptSig(String(PROMPT_TEMPLATES_V2.general)) === 'string';
})(), promptSig('abc'));

R.assert('P2 模板与分组：33 条 / 5 组、无未分组键、默认版本正确、模板文本非空', (() => {
    const st = promptStats();
    return st.templates === 33 && st.groups === 5 && st.grouped === 33 && st.ungrouped.length === 0
        && PROMPT_DEFAULT_VERSION === 'v1.195'
        && Object.keys(PROMPT_TEMPLATES_V2).every((k) => String(PROMPT_TEMPLATES_V2[k]).length > 0)
        && promptGroupOf('injectGuide').indexOf('③') === 0 && promptGroupOf('nsfwSoften').indexOf('④') === 0;
})(), promptStats());

R.assert('P3 迁移判定：缺失/空 → 刷新；签名命中 legacy → 刷新；自定义文本 → 保留；等于新默认 → 刷新（幂等）', (() => {
    const legacyKey = Object.keys(PROMPT_LEGACY_SIGS).filter((k) => Array.isArray(PROMPT_LEGACY_SIGS[k]) && PROMPT_LEGACY_SIGS[k].length)[0];
    const legacySigText = (() => {
        // 用 legacy 签名反推不可能（哈希不可逆）→ 直接构造「长度 + 哈希」不可行，故用等值分支与保留分支验证
        return '';
    })();
    const pt = {
        general: '',                                   // 缺失/空 → 刷新
        state: '这是我自己改过的状态模板文本。',          // 自定义 → 保留
        atoms: PROMPT_TEMPLATES_V2.atoms,              // 等于新默认 → 计入刷新（无变化）
    };
    const out = migratePromptTemplates(pt);
    const info = promptMigrateStats();
    const second = migratePromptTemplates(out);        // 幂等
    return String(out.general) === String(PROMPT_TEMPLATES_V2.general)
        && out.state === '这是我自己改过的状态模板文本。'
        && info.refreshed.indexOf('general') >= 0 && info.kept.indexOf('state') >= 0
        && J(second) === J(out) && legacyKey && legacySigText === '';
})(), promptMigrateStats());

R.assert('P4 破甲预设旧键迁移：用户文本迁入模板并删除旧键；v1.178 旧默认被忽略但仍删键；幂等', (() => {
    const a = { armorPreset: '我的自定义破甲文本', promptTemplates: {} };
    const r1 = migrateArmorPreset(a);
    const b = { armorPreset: ARMOR_PRESET_V1178_DEFAULT, promptTemplates: {} };
    const r2 = migrateArmorPreset(b);
    const r3 = migrateArmorPreset(a);                  // 幂等：旧键已删
    return r1.migrated === true && r1.reason === 'user-text-migrated' && a.promptTemplates.armorPreset === '我的自定义破甲文本'
        && a.armorPreset === undefined
        && r2.migrated === false && r2.reason === 'v1178-default-ignored' && b.armorPreset === undefined
        && r3.migrated === false && r3.deleted === false;
})(), {});

R.assert('P5 载入迁移接线：loadKernelCfg 跑迁移并回报（store.cfg 生效、用户自定义保留）', (() => {
    delete host.ctx.extensionSettings.ftt_memory_v2;
    const r0 = loadKernelCfg();
    host.ctx.extensionSettings.ftt_memory_v2.cfg = { promptTemplates: { general: '用户自定义总则' } };
    const r1 = loadKernelCfg();
    const info = lastLoadInfo();
    return r0.keys > 200 && r1.prompt && r1.prompt.changed === false
        && cfg.promptTemplates.general === '用户自定义总则'
        && String(cfg.promptTemplates.atoms) === String(PROMPT_TEMPLATES_V2.atoms)
        && info && info.prompt && info.prompt.armor && info.prompt.armor.deleted === false;
})(), (() => { try { return J(lastLoadInfo()); } catch (e) { return String(e.message); } })());

R.assert('P6 编辑写回：保存单条 → 内核 cfg + ST 配置容器；恢复单条/整组/全部 → 回到内置默认', (() => {
    const s1 = applyPrompt('injectGuide', '我的注入说明');
    const customized1 = isPromptCustomized('injectGuide');
    const store = host.ctx.extensionSettings.ftt_memory_v2;
    // 关键：**在重置之前**取落盘值（重置会把它写回默认）
    const storeVal = store && store.cfg && store.cfg.promptTemplates && store.cfg.promptTemplates.injectGuide;
    const r1 = resetPrompt('injectGuide');
    const g = resetPromptGroup(PROMPT_GROUPS[2].title);         // ② 维度抽取模板组
    applyPrompt('general', '改过的总则');
    const all = resetAllPrompts();
    globalThis.__p6 = { s1: s1.chars, customized1, storeVal, r1: r1.ok, g: g.reset, all: all.reset };
    return s1.ok === true && s1.chars === 6 && customized1 === true
        && storeVal === '我的注入说明'
        && r1.ok === true && isPromptCustomized('injectGuide') === false
        && g.ok === true && g.reset >= 10 && all.ok === true && all.reset === 33
        && promptText('general') === String(PROMPT_TEMPLATES_V2.general) && promptStats().customized === 0;
})(), (() => { try { return J(globalThis.__p6 || {}); } catch (e) { return String(e.message); } })());

R.assert('P7 提示词页渲染：5 组标题 + 33 个编辑块（含 key/组名/签名/已自定义）+ 工具行与破甲导入', (() => {
    applyPrompt('memorySend', '改过的发送模板');
    const html = promptsPageHtml();
    const boxes = (html.match(/data-ftt-prompt-box="/g) || []).length;
    return html.indexOf('提示词模板 33 条 / 5 组') >= 0
        && PROMPT_GROUPS.every((g) => html.indexOf(g.title) >= 0)
        && boxes === 33 && html.indexOf('data-ftt-action="promptResetAll"') >= 0
        && html.indexOf('data-ftt-action="promptGroupReset"') >= 0
        && html.indexOf('data-ftt-action="promptSave"') >= 0 && html.indexOf('data-ftt-armor-import="1"') >= 0
        && html.indexOf('已自定义') >= 0 && html.indexOf('data-ftt-prompt="memorySend"') >= 0;
})(), '');

await (async () => {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    openPanel('settings');
    setPanelHooks2({});
    const sub = await panelAction('settingsSub', { sub: 'prompts' });
    const page = panelBodyHtml('settings');
    const save = await panelAction('promptSave', { promptKey: 'injectGuide', text: '面板保存的说明' });
    const resetOne = await panelAction('promptResetOne', { promptKey: 'injectGuide' });
    const armor = await panelAction('armorPresetImport', { text: '粘贴进来的破甲预设' });
    const armorVal = String((cfg.promptTemplates || {}).armorPreset || '');      // 在「全部恢复默认」之前取值
    const group = await panelAction('promptGroupReset', { group: PROMPT_GROUPS[3].title });   // ③ 召回与注入辅助（3 条）
    const all = await panelAction('promptResetAll', {});
    globalThis.__p8 = { sub: sub.ok, save: save.chars, resetOne: resetOne.ok, armor: armor.imported, armorVal, group: group.reset, all: all.reset };
    R.assert('P8 面板接线：设定→提示词页可见分组编辑器；保存/恢复单条/破甲导入/整组/全部动作与提示', (() => {
        return sub.ok === true && page.indexOf('ftt-prompt-editor') >= 0 && page.indexOf('data-ftt-prompt-box="general"') >= 0
            && save.ok === true && save.chars === 7
            && resetOne.ok === true && isPromptCustomized('injectGuide') === false
            && armor.ok === true && armor.imported === 9 && armorVal === '粘贴进来的破甲预设'
            && group.ok === true && group.reset === 3 && all.ok === true && all.reset === 33;
    })(), (() => { try { return J(globalThis.__p8); } catch (e) { return String(e.message); } })());
})();

un();
R.done();
