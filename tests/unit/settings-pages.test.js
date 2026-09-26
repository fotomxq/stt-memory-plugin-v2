// ============================================================
// 单元测试 · B4 设定 14 组子页（V1 对齐）
// 口径：页顺序/标签与 V1 `subTabs` 一致；控件表由 V1 源码自动提取（105 项），键必须能在配置里找到；
//   渲染为 V1 同款结构（`.ftt-field` / `.ftt-switch` / `data-ftt-cfg`）；写回内核 cfg 并持久化 ST 配置。
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    SETTINGS_TABS, SETTINGS_CONTROLS, settingsPageHtml, settingsSubTabsHtml,
    applySettingsControl, readControl, settingsPagesInfo, settingsControlHtml,
} from '../../ui/settings-pages.js';
import { panelAction, panelBodyHtml, panelState, setPanelHooks2, openPanel } from '../../ui/panel.js';
import { dimCap } from '../../core/model/scalars.js';

const R = makeReporter('settings-pages B4 设定子页（V1 对齐）');
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
setKernelState(emptyState());

R.assert('P1 子页与 V1 同名同序（14 组）', (() => {
    const want = ['base:基础', 'feed:投喂范围', 'api:API', 'analyze:分析记忆', 'safety:内容弱化', 'extract:提取记忆', 'forget:遗忘', 'rumors:传言', 'parallels:平行', 'prompts:提示词', 'storage:存储', 'debug:调试', 'data:数据管理', 'about:关于'];
    const got = SETTINGS_TABS.map((t) => t.id + ':' + t.label);
    return J(got) === J(want) && settingsSubTabsHtml('base').indexOf('ftt-subtab ftt-on') >= 0;
})(), SETTINGS_TABS.map((t) => t.id));

R.assert('P2 控件表：共 173 项（v2.51.0 删除 10 个废弃时钟设定后），逐页数量与 V1 提取一致（时钟键除外）', (() => {
    const info = settingsPagesInfo();
    const m = {};
    info.pages.forEach((p) => { m[p.id] = p.controls; });
    // v2.51.0 时钟改版：基础页删除 10 个废弃时钟设定 → 总数 183 → 173、base 21 → 11
    return info.totalControls === 173 && m.base === 11 && m.feed === 37 && m.analyze === 5 && m.extract === 34
        && m.forget === 28 && m.rumors === 14 && m.parallels === 7 && m.prompts === 6 && m.storage === 26 && m.debug === 5;   // v2.42.0：调试页 +4（级别/交互/宿主/详细）
})(), settingsPagesInfo());

R.assert('P2b 存储页控件与 V1 手写页逐一对应：墓碑天数 / 原生通道 / 世界书 8 项 / 流量门控（顶层键 syncTrafficGuard）', (() => {
    const keys = SETTINGS_CONTROLS.storage.map((c) => String(c.key));
    const want = ['storage.deletedKeepDays', 'storage.tauriNative', 'storage.worldbookName', 'storage.worldbookMode',
        'storage.worldbookScanDepth', 'storage.worldbookPosition', 'storage.worldbookDepth', 'storage.worldbookProbability',
        'storage.worldbookSticky', 'storage.worldbookCooldown', 'storage.worldbookDelay', 'storage.worldbookMaxBytes', 'syncTrafficGuard'];
    return want.every((k) => keys.indexOf(k) >= 0)
        && settingsControlHtml(SETTINGS_CONTROLS.storage.find((c) => c.key === 'storage.tauriNative')).indexOf('<select') >= 0
        && settingsControlHtml(SETTINGS_CONTROLS.storage.find((c) => c.key === 'storage.tauriNative')).indexOf('自动（检测到 TauriTavern 即切换）') >= 0;
})(), () => SETTINGS_CONTROLS.storage.map((c) => c.key));

R.assert('P2c 质检维护页补齐 V1 手写块的 22 个控件：键与标签按 V1 原样、顺序与 V1 源码一致', (() => {
    const want = [
        ['conceptRepairSim', '概念修复相关性阈值（0.1-0.95，默认 0.45）'],
        ['conceptRepairMaxClusters', '概念修复每次核对组数（1-20，默认 3）'],
        ['conceptRepairMaxItems', '概念修复每次提交条数上限（2-120，默认 24）'],
        ['conceptRepairMaxClusterSize', '概念相关组规模上限（2-40，默认 8）'],
        ['memoryRepairSim', '记忆修复相关性阈值（0.1-0.95，默认 0.45）'],
        ['memoryRepairMaxClusters', '记忆修复每次核对组数（1-20，默认 3）'],
        ['memoryRepairMaxItems', '记忆修复每次提交条数上限（2-120，默认 24）'],
        ['memoryRepairMaxClusterSize', '记忆相关组规模上限（2-40，默认 8）'],
        ['suspenseRepairSim', '悬念修复相关性阈值（0.1-0.95，默认 0.45）'],
        ['suspenseRepairMaxClusters', '悬念修复每次核对组数（1-20，默认 3）'],
        ['suspenseRepairMaxItems', '悬念修复每次提交条数上限（2-120，默认 24）'],
        ['suspenseRepairMaxClusterSize', '悬念相关组规模上限（2-40，默认 8）'],
        ['itemRepairSim', '物品修复相关性阈值（0.1-0.95，默认 0.45）'],
        ['itemRepairMaxClusters', '物品修复每次核对组数（1-20，默认 3）'],
        ['itemRepairMaxItems', '物品修复每次提交条数上限（2-120，默认 24）'],
        ['itemRepairMaxClusterSize', '物品相关组规模上限（2-40，默认 8）'],
        ['itemLowUsesRatio', '低调用清理·比例（默认 0.05）'],
        ['itemLowUsesMinItems', '低调用清理·物品数门槛（默认 100）'],
        ['itemLowUsesMinAvg', '低调用清理·平均调用门槛（默认 5）'],
        ['itemLowUsesMinFloors', '低调用清理·楼层门槛（默认 200；0=不生效）'],
        ['itemLowUsesEveryFloors', '低调用清理·清扫间隔（默认 40 楼；0=不限制）'],
        ['itemLowUsesMaxDelete', '低调用清理·每轮最多删除（默认 1）'],
    ];
    const feed = SETTINGS_CONTROLS.feed.map((c) => [String(c.key), String(c.label)]);
    const tail = feed.slice(feed.length - want.length);
    // 每个键在配置里的默认值与 V1 默认一致（阈值 0.45 / 组数 3 / 条数 24 / 组规模 8 / 比例 0.05 / 门槛 100 / 均值 5 / 楼层 200 / 间隔 40 / 删除 1）
    const defs = { conceptRepairSim: 0.45, memoryRepairSim: 0.45, suspenseRepairSim: 0.45, itemRepairSim: 0.45,
        conceptRepairMaxClusters: 3, memoryRepairMaxClusters: 3, suspenseRepairMaxClusters: 3, itemRepairMaxClusters: 3,
        conceptRepairMaxItems: 24, memoryRepairMaxItems: 24, suspenseRepairMaxItems: 24, itemRepairMaxItems: 24,
        conceptRepairMaxClusterSize: 8, memoryRepairMaxClusterSize: 8, suspenseRepairMaxClusterSize: 8, itemRepairMaxClusterSize: 8,
        itemLowUsesRatio: 0.05, itemLowUsesMinItems: 100, itemLowUsesMinAvg: 5, itemLowUsesMinFloors: 200,
        itemLowUsesEveryFloors: 40, itemLowUsesMaxDelete: 1 };
    const badDef = want.filter((w) => Number(defaultCfg[w[0]]) !== defs[w[0]]).map((w) => w[0]);
    const renderOk = settingsControlHtml(SETTINGS_CONTROLS.feed.find((c) => c.key === 'memoryRepairSim')).indexOf('data-ftt-cfg="memoryRepairSim"') >= 0;
    return J(tail) === J(want) && badDef.length === 0 && renderOk;
})(), () => SETTINGS_CONTROLS.feed.slice(-22).map((c) => c.key));

R.assert('P2d 提取页补齐 V1「各大类单条字数上限」10 个控件：键/标签按 V1、写入 `cfg.dimCharLimits.*` 且**真实影响入库硬截断**（dimCap）', (() => {
    const want = [
        ['dimCharLimits.atoms', '情节正文上限'], ['dimCharLimits.states', '状态值上限'],
        ['dimCharLimits.snapshots', '角色档案累计上限'], ['dimCharLimits.memories', '记忆正文上限'],
        ['dimCharLimits.items', '物品说明上限'], ['dimCharLimits.plans', '计划内容上限'],
        ['dimCharLimits.suspense', '悬念内容上限'], ['dimCharLimits.scenes', '场景描述上限'],
        ['dimCharLimits.concepts', '概念内容上限'], ['dimCharLimits.parallels', '平行事件(推演)上限'],
    ];
    const ex = SETTINGS_CONTROLS.extract.map((c) => [String(c.key), String(c.label)]);
    const tail = ex.slice(ex.length - want.length);
    // 点路径读写 + 内核真的用它做硬截断（long → 截到新上限）
    const before = readControl('dimCharLimits.atoms');
    applySettingsControl('dimCharLimits.atoms', 30);
    const after = readControl('dimCharLimits.atoms');
    const long = '甲'.repeat(80);
    const capped = dimCap('atoms', long);
    applySettingsControl('dimCharLimits.atoms', before);
    return J(tail) === J(want) && Number(after) === 30 && capped.length === 30
        && Number(readControl('dimCharLimits.atoms')) === Number(before);
})(), () => SETTINGS_CONTROLS.extract.slice(-10).map((c) => c.key));

R.assert('P3 控件键均可解析：普通键在 defaultCfg 内、点路径键（storage.* / dimCharLimits.*）逐层在 defaultCfg 内（提取零漏配）', (() => {
    const bad = [];
    const has = (path) => {
        let cur = defaultCfg;
        for (const seg of String(path).split('.')) {
            if (!cur || !Object.prototype.hasOwnProperty.call(cur, seg)) return false;
            cur = cur[seg];
        }
        return true;
    };
    Object.keys(SETTINGS_CONTROLS).forEach((pid) => {
        SETTINGS_CONTROLS[pid].forEach((c) => { if (!has(String(c.key))) bad.push(String(c.key)); });
    });
    return bad.length === 0;
})(), (() => {
    const bad = [];
    Object.keys(SETTINGS_CONTROLS).forEach((pid) => SETTINGS_CONTROLS[pid].forEach((c) => {
        const k = String(c.key);
        if (k.indexOf('storage.') === 0) { if (!(defaultCfg.storage && Object.prototype.hasOwnProperty.call(defaultCfg.storage, k.slice(8)))) bad.push(k); }
        else if (!Object.prototype.hasOwnProperty.call(defaultCfg, k)) bad.push(k);
    }));
    return bad.slice(0, 10);
})());

R.assert('P4 渲染：开关页用 .ftt-switch + 「已开启/已关闭」；文本框用 input；下拉用 select；正文域用 textarea', (() => {
    const boolCtl = SETTINGS_CONTROLS.storage.filter((c) => c.type === 'checkbox')[0];
    const textCtl = SETTINGS_CONTROLS.base.filter((c) => c.type === 'text')[0];
    const sb = settingsControlHtml(boolCtl);
    const st = settingsControlHtml(textCtl);
    const page = settingsPageHtml('storage');
    return sb.indexOf('class="ftt-switch"') >= 0 && sb.indexOf('data-ftt-cfg="' + boolCtl.key + '"') >= 0
        && (sb.indexOf('已开启') >= 0 || sb.indexOf('已关闭') >= 0)
        && st.indexOf('<input type="text"') >= 0 && st.indexOf('value="') >= 0
        && page.indexOf('data-ftt-cfg="storage.stateFile"') >= 0
        && panelBodyHtml('settings').indexOf('ftt-settings-subtabs') >= 0;
})(), '');

R.assert('P5 写回：applySettingsControl 改内核 cfg 并持久化（含 storage.* 嵌套）；未知键不崩', (() => {
    const r1 = applySettingsControl('importanceBase', 0.42);
    const r2 = applySettingsControl('storage.settingsMirror', true);
    const store = host.ctx.extensionSettings.ftt_memory_v2;
    const r3 = applySettingsControl('', 1);
    return r1.ok === true && cfg.importanceBase === 0.42 && readControl('importanceBase') === 0.42
        && r2.ok === true && cfg.storage.settingsMirror === true && readControl('storage.settingsMirror') === true
        && store && store.cfg && store.cfg.importanceBase === 0.42 && store.cfg.storage.settingsMirror === true
        && r3.ok === false;
})(), (() => { try { return JSON.stringify({ a: cfg.importanceBase, b: cfg.storage.settingsMirror }); } catch (e) { return String(e.message); } })());

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

await A('P6 面板接线：settingsSub 切页只影响设定页；数据管理页含导出/导入/清台账按钮；导出走钩子并可复制', async () => {
    openPanel('settings');
    setPanelHooks2({
        exportState: () => J({ format: 'ftt-memory-v2-export', state: { atoms: [] } }),
        importState: async (text) => ({ ok: true, added: JSON.parse(text).state.atoms ? 1 : 0 }),
        clearFloors: () => ({ ok: true, cleared: 2 }),
    });
    const r1 = await panelAction('settingsSub', { sub: 'data' });
    const page = panelBodyHtml('settings');
    const r2 = await panelAction('settingsSub', { sub: 'about' });
    const about = panelBodyHtml('settings');
    await panelAction('settingsSub', { sub: 'data' });
    const exp = await panelAction('exportState', {});
    const imp = await panelAction('importStateApply', { text: J({ state: { atoms: [{ id: 'x', text: '来自导入的情节正文足够长。' }] } }) });
    const st = panelState();
    return r1.ok === true && page.indexOf('data-ftt-settings-page="data"') >= 0
        && page.indexOf('data-ftt-action="exportState"') >= 0 && page.indexOf('data-ftt-import="1"') >= 0
        && page.indexOf('data-ftt-action="clearFloors"') >= 0
        && r2.ok === true && about.indexOf('设定 · 关于') >= 0 && about.indexOf('关于 · FTT记忆组件') >= 0
        && about.indexOf('内核配置键：') < 0 && about.indexOf('V2 附加信息') < 0   // v2.53.0：关于页不再附开发/历史块
        && page.indexOf('本地缓冲') >= 0 && page.indexOf('data-ftt-action="aboutClearCache"') >= 0  // v2.53.0：缓冲清理在数据管理
        // v2.54.0：数据管理页按用途分块 + 危险动作隔离 + 快照只出统计 + 缓冲三项可清
        && page.indexOf('📤 导出备份') >= 0 && page.indexOf('📥 导入存档（合并）') >= 0
        && page.indexOf('⚠️ 删除数据（不可恢复）') >= 0 && page.indexOf('data-ftt-snap-stat') >= 0
        && page.indexOf('data-ftt-action="dbgClear"') >= 0 && page.indexOf('data-ftt-action="dbgTraceClear"') >= 0
        && page.indexOf('不会删除') >= 0 && page.indexOf('不可恢复') >= 0
        && exp.ok === true && exp.chars > 10 && st.exportChars > 10
        && imp.ok === true && st.settingsSub === 'data';
}, (() => { try { return JSON.stringify(panelState()).slice(0, 200); } catch (e) { return String(e.message); } })());

await A('P7 v2.43.0 位置修复：「V2 附加设定」只作为**基础**子页内的一块分节（不再吊在 14 个子页的页脚）；其它子页不出现，切回基础仍在，且控件与动作齐备', async () => {
    openPanel('settings');
    const rows = {};
    for (const t of SETTINGS_TABS) {
        await panelAction('settingsSub', { sub: t.id });
        const h = panelBodyHtml('settings');
        const pageAt = h.indexOf('data-ftt-settings-page="' + t.id + '"');
        const secAt = h.indexOf('data-ftt-section="v2-extras"');
        rows[t.id] = { has: secAt >= 0, inside: pageAt >= 0 && secAt > pageAt, text: h.indexOf('V2 附加设定', secAt >= 0 ? secAt - 200 : 0) >= 0 };
    }
    await panelAction('settingsSub', { sub: 'base' });
    const baseH = panelBodyHtml('settings');
    const onlyBase = SETTINGS_TABS.filter((t) => t.id !== 'base').every((t) => rows[t.id].has === false);
    // 基础页内：分节位于基础页容器**之内**（页脚 bug 的标志是「标题出现在容器之后」）
    const inBase = rows.base.has === true && rows.base.inside === true;
    // 控件与动作齐备（更新检查 / V1 导入 / 维度开关 / 面板宽度）
    const ctrls = ['data-ftt-v2="autoUpdateCheck"', 'data-ftt-v2="updateRepo"', 'data-ftt-v2="panelMaxWidth"', 'ftt_v2_dims',
        'data-ftt-action="check-update"', 'data-ftt-action="importV1Dry"', 'data-ftt-action="importV1Apply"']
        .every((k) => baseH.indexOf(k) >= 0);
    // 旧写法（固定页脚 `<h4 class="ftt-h4-inline">V2 附加设定`）必须消失
    const noLegacyFooter = baseH.indexOf('ftt-h4-inline">V2 附加设定') < 0;
    return onlyBase && inBase && ctrls && noLegacyFooter;
}, () => J(Object.keys(rows).reduce((o, k) => { o[k] = rows[k].has ? (rows[k].inside ? 'base内' : '页脚') : '无'; return o; }, {})));

await A('P8 v2.55.0 设定页标题行只留「设定 · <页名>」：不再展示「N 个配置项 / 共 X 项 / 结构与 V1 同名同序」等开发与沿革说明，也不再出现「B6/B7 批次接入」这类历史待办', async () => {
    openPanel('settings');
    const seen = [];
    for (const t of SETTINGS_TABS) {
        await panelAction('settingsSub', { sub: t.id });
        const h = panelBodyHtml('settings');
        seen.push({
            id: t.id,
            head: h.indexOf('设定 · ' + t.label) >= 0,
            dev: h.indexOf('结构与 V1 同名同序') >= 0 || h.indexOf('个配置项') >= 0 || h.indexOf('批次接入') >= 0,
        });
    }
    await panelAction('settingsSub', { sub: 'base' });
    return seen.every((x) => x.head === true && x.dev === false);
}, () => J(SETTINGS_TABS.map((t) => t.label)));

un();
R.done();
