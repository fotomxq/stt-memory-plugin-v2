// ============================================================
// 单元测试 · 启动鲁棒性（用户报「装上了但看不到面板」的根因防护）
// 背景：早期实现只在 `APP_READY` 事件里初始化；宿主（如 TauriTavern 等原生移植）若不发该事件、
//   或插件加载晚于就绪时刻，就会「装上了但什么都不出现」。本文件逐条验证多触发 + 有限轮询 +
//   容器回退 + 诊断入口提前可用。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { installMenuEntry as installMenuEntryFn } from '../../ui/menu.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = makeReporter('bootstrap 启动鲁棒性（无事件/容器回退/诊断入口）');
const J = (v) => JSON.stringify(v);
const TEMPLATE = readFileSync(join(ROOT, 'settings.html'), 'utf8');
const IDS = ['extensions_settings2', 'extensions_settings', 'rm_extensions_block', 'extensionsMenu',
    'ftt_v2_settings', 'ftt_v2_status', 'ftt_v2_action', 'ftt_v2_console', 'ftt_v2_updstate', 'ftt_v2_checkupd',
    'ftt_v2_doupd', 'ftt_v2_autoupd', 'ftt_v2_updrepo', 'ftt_v2_cfg_injp', 'ftt_v2_cfg_budget', 'ftt_v2_cfg_maxatoms',
    'ftt_v2_cfg_maxmems', 'ftt_v2_cfg_autoext', 'ftt_v2_dims', 'ftt_v2_analyze', 'ftt_v2_list', 'ftt_v2_clearinj',
    'ftt_v2_imp_dry', 'ftt_v2_imp_apply', 'ftt_v2_console_refresh'];

const doc = makeDocument(IDS);
const host = makeHost({ templateHtml: TEMPLATE });
const un = installGlobalHost(host, doc);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 【关键】全程**不 emit 任何事件**（APP_READY / APP_INITIALIZED 都不发）
const entry = await import('../../index.js');
await wait(120);

R.assert('B1 零事件也能装配：不发 APP_READY 也完成初始化并挂载面板（触发来源含 load）', (() => {
    const st = entry.runtimeState();
    const panel = st.bootstrap;
    const html = String(doc._els.extensions_settings2.html || '');
    return st.ready === true && (st.settingsVia === 'template' || st.settingsVia === 'already')
        && panel.triggers.indexOf('load') >= 0
        && html.indexOf('ftt_v2_settings') >= 0 && html.indexOf('ftt_v2_cfg_budget') >= 0
        && html.indexOf('ftt_v2_console') >= 0;
})(), (() => { const s = entry.runtimeState(); return J({ ready: s.ready, via: s.settingsVia, triggers: s.bootstrap.triggers }); })());

R.assert('B2 诊断入口加载期即注册：/ftt、/ftt-panel、/ftt-analyze、/ftt-import 与 window.FTT 都在', (() => {
    const names = (host.ctx.commands || []).map((c) => c.name);
    return names.indexOf('ftt') >= 0 && names.indexOf('ftt-panel') >= 0 && names.indexOf('ftt-analyze') >= 0
        && names.indexOf('ftt-import') >= 0 && !!globalThis.FTT
        && typeof globalThis.FTT.panelInfo === 'function' && typeof globalThis.FTT.forceMount === 'function';
})(), ((host.ctx.commands || []).map((c) => c.name)));

R.assert('B3 魔杖菜单入口：容器存在时插入成功（桩 DOM 不解析 HTML → resolved=false）', (() => {
    const html = String(doc._els.extensionsMenu.html || '');
    const info = globalThis.FTT.menuInfo();
    const res = installMenuEntryFn({ onClick: () => undefined });     // 幂等：已装则 already
    return html.indexOf('ftt_v2_menu_btn') >= 0 && info.menuFound === true
        && (res.ok === true && (res.inserted === true || res.reason === 'already'));
})(), (() => { try { return J(globalThis.FTT.menuInfo()); } catch (e) { return String(e.message); } })());

await (async () => {
    // 容器回退：删掉首选容器，保留第三候选
    const saved2 = doc._els.extensions_settings2;
    const saved1 = doc._els.extensions_settings;
    delete doc._els.extensions_settings2;
    delete doc._els.extensions_settings;
    const b3 = doc._els.rm_extensions_block = doc._els.rm_extensions_block || { html: '', insertAdjacentHTML(p, h) { this.html += String(h); }, addEventListener() { }, listeners: {} };
    const r = await entry.forceMountPanel();
    R.assert('B4 容器回退：首选与次选容器缺失时挂到第三候选（#rm_extensions_block）并report 容器 id', (() => {
        return r.ok === true && r.container === 'rm_extensions_block' && String(b3.html).indexOf('ftt_v2_settings') >= 0;
    })(), { container: r.container, via: r.via, keys: Object.keys(r.info ? r.info.found : {}) });
    doc._els.extensions_settings2 = saved2;
    doc._els.extensions_settings = saved1;
})();

await (async () => {
    const saved = { a: doc._els.extensions_settings2, b: doc._els.extensions_settings, c: doc._els.rm_extensions_block };
    delete doc._els.extensions_settings2; delete doc._els.extensions_settings; delete doc._els.rm_extensions_block;
    const bad = await entry.forceMountPanel();
    doc._els.extensions_settings2 = saved.a; doc._els.extensions_settings = saved.b; doc._els.rm_extensions_block = saved.c;
    const good = await entry.forceMountPanel();
    R.assert('B5 无容器时可诊断且可自愈：给出候选容器原因 → 容器出现后重新挂载成功', (() => {
        return bad.ok === false && String(bad.reason).indexOf('未找到扩展设置容器') >= 0
            && String(bad.reason).indexOf('extensions_settings2') >= 0
            && good.ok === true && String(good.container) === 'extensions_settings2';
    })(), { bad: bad.reason, good: good.container });
})();

await (async () => {
    const cmd = (host.ctx.commands || []).filter((c) => c.name === 'ftt-panel')[0];
    const text = cmd ? String(await cmd.callback({}, '')) : '';
    R.assert('B6 /ftt-panel 报告挂载结果与候选容器，并给出「面板在扩展设置抽屉」的提示', (() => {
        return text.indexOf('面板挂载') >= 0 && text.indexOf('候选容器') >= 0
            && text.indexOf('extensions_settings2') >= 0 && text.indexOf('菜单入口') >= 0
            && text.indexOf('扩展设置') >= 0;
    })(), text.slice(0, 120));
})();

await (async () => {
    // 极端宿主：**完全没有事件源**（无 eventSource/eventTypes）—— 仍应完成装配与挂载
    entry.teardown();
    host.ctx.eventSource = undefined;
    host.ctx.eventTypes = undefined;
    const r = await entry.ensureReady('no-events');
    await wait(30);
    const st = entry.runtimeState();
    R.assert('B7 无事件源宿主：ensureReady 仍完成装配并挂载面板（触发来源记录 no-events）', (() => {
        return r && (r.ok === true || r.reused === true) && st.ready === true
            && st.bootstrap.triggers.indexOf('no-events') >= 0
            && String(doc._els.extensions_settings2.html || '').indexOf('ftt_v2_settings') >= 0;
    })(), (() => { const s = entry.runtimeState(); return J({ ok: r && r.ok, ready: s.ready, triggers: s.bootstrap.triggers }); })());

    entry.teardown();
    R.assert('B8 teardown 后可恢复：stopReadyProbe + forceMount 仍成功，候选容器 3 个', (async () => {
        entry.stopReadyProbe();
        const after = await entry.forceMountPanel();
        const info = entry.panelMountInfo();
        return after.ok === true && info.mounted === true && typeof info.candidates.length === 'number' && info.candidates.length === 3;
    })(), J(entry.panelMountInfo()));
})();

un();
R.done();
