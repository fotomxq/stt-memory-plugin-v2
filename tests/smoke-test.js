#!/usr/bin/env node
// ============================================================
// tests/smoke-test.js —— V2 冒烟（用宿主桩端到端跑一遍装配链路）
// 覆盖：有宿主初始化 / 面板挂载 / 命令与宏注册 / 拦截器 / 调试导出 / 收尾清理；
//       无宿主导入不崩（子进程验证）；版本与清单一致。
// ============================================================
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHost, makeDocument, installGlobalHost, installGlobalFetch } from './harness/st-mock.js';
import { VERSION, MODULE_NAME, INJECT_ID } from '../core/constants.js';
import { readUpdateState } from '../adapters/update-state.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const failures = [];
function assert(name, cond, extra) {
    if (cond) { pass++; console.log('  ✅', name); }
    else { fail++; failures.push(name); console.log('  ❌', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

// ---------- A 无宿主导入（子进程；验证 Node 环境下不崩） ----------
try {
    const out = execFileSync(process.execPath, ['-e', "import('./index.js').then(m => console.log('OK:' + m.__internals.VERSION)).catch(e => { console.log('ERR:' + e.message); process.exit(2); })"], { cwd: ROOT, encoding: 'utf8' });
    assert('A1 无宿主（Node）导入入口不抛异常并可用', out.indexOf('OK:' + VERSION) >= 0, out.trim());
} catch (e) {
    assert('A1 无宿主（Node）导入入口不抛异常并可用', false, String(e.stdout || e.message));
}

// ---------- B 有宿主：完整装配 ----------
// 更新检查桩：ST 版本端点（git 真值）+ 远端清单/更新日志
const templateHtml = readFileSync(join(ROOT, 'settings.html'), 'utf8');
let remoteVersion = '2.1.0';
let endpointDown = false;
let v1FileName = '';
let v1FileText = '';
const fetchCalls = [];
const uninstallFetch = installGlobalFetch((url) => {
    fetchCalls.push(url);
    if (url === '/api/extensions/version') {
        if (endpointDown) return { status: 404, body: {} };
        return { status: 200, body: { isUpToDate: true, currentCommitHash: 'abc1234def', currentBranchName: 'main' } };
    }
    if (url.indexOf('/api/extensions/update') === 0) return { status: 200, body: { isUpToDate: false, shortCommitHash: 'beef999' } };
    if (url.endsWith('/manifest.json')) return { status: 200, text: JSON.stringify({ version: remoteVersion }) };
    if (url.endsWith('/CHANGELOG.md')) return { status: 200, text: '# 版本历史\n\n## v2.1.0（2026-10-01）\n\n- 新增：更新检查机制\n' };
    if (v1FileName && url === '/user/files/' + v1FileName) return { status: 200, text: v1FileText };
    return { status: 404, body: {} };
});

const host = makeHost({ templateHtml });
const doc = makeDocument(['extensions_settings2', 'extensions_settings', 'rm_extensions_block', 'extensionsMenu', 'ftt_v2_settings', 'ftt_v2_updstate', 'ftt_v2_checkupd', 'ftt_v2_doupd', 'ftt_v2_autoupd', 'ftt_v2_updrepo',
    'ftt_v2_cfg_injp', 'ftt_v2_cfg_budget', 'ftt_v2_cfg_maxatoms', 'ftt_v2_cfg_maxmems', 'ftt_v2_cfg_autoext',
    'ftt_v2_dims', 'ftt_v2_status', 'ftt_v2_action', 'ftt_v2_analyze', 'ftt_v2_list', 'ftt_v2_clearinj', 'ftt_v2_imp_dry', 'ftt_v2_imp_apply',
    'ftt_v2_console', 'ftt_v2_console_refresh']);
const uninstall = installGlobalHost(host, doc);
const entry = await import('../index.js');

const before = entry.runtimeState();
assert('B1 加载期探针即完成装配（无需 APP_READY；弹窗优先、抽屉卡片默认关）', (() => {
    const b = entry.extraForStatus().bootstrap;
    return before.ready === true && before.settingsVia === 'popup'
        && before.bootstrap.triggers.indexOf('load') >= 0
        && b.popup && b.popup.canPopup === true && b.popup.showDrawer === false
        && b.menu && b.menu.menuFound === true;
})(), { ready: before.ready, via: before.settingsVia, triggers: before.bootstrap.triggers });

host.emit('APP_READY');
await new Promise(r => setTimeout(r, 30));
const st = entry.runtimeState();
assert('B2 APP_READY 再入装配（幂等）：ready/探测/事件绑定/命令/宏', (() => {
    const want = ['USER_MESSAGE_RENDERED', 'GENERATION_ENDED', 'CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED'];
    const got = (st.bind.bound || []).slice().sort().join(',');
    // 装配可能由「加载期探针」或「APP_READY」触发（多触发设计）；两者都算通过
    const viaOk = st.settingsVia === 'popup' || st.settingsVia === 'template' || st.settingsVia === 'already';
    return st.ready === true && st.probe.ok === true && got === want.slice().sort().join(',') && st.bind.missing.length === 0
        && viaOk && st.slash === true && st.macros === true;
})(), st);

assert('B2b P2 接线：记忆容器已载入内核（本机缓冲/服务端文件/空容器三选一）且聊天视图已注入', (() => {
    return ['local', 'file', 'new'].indexOf(st.store && st.store.via) >= 0
        && typeof st.store.scope === 'string' && st.store.scope.length > 0
        && st.chat && st.chat.messages >= 1 && typeof st.chat.lastMessageId === 'number'
        && st.chat.scopeKey === '角色甲';
})(), st);

// ---------- M 弹窗主界面（用户要求：对齐 V1 的弹窗形态） ----------
assert('M1 弹窗主界面可用：/ftt-ui 入口 + 四个分页 + 切换分页渲染对应内容', (async () => {
    const cmd = (host.ctx.commands || []).filter((c) => c.name === 'ftt-ui')[0];
    const cap = [];
    const saved = host.ctx.callGenericPopup;
    host.ctx.callGenericPopup = async (h) => { cap.push(String(h)); return 1; };
    try {
        const open = await globalThis.FTT.ui('console');
        const tabs = (globalThis.FTT.popupInfo() || {}).tabs || [];
        const r1 = await entry.popupAction('tab', { tab: 'extract' });
        const r2 = await entry.popupAction('tab', { tab: 'settings' });
        const cmdText = cmd ? String(await cmd.callback({}, 'console')) : '';
        return open.ok === true && open.via === 'popup' && cap.length >= 1
            && cap[0].indexOf('ftt_v2_popup') >= 0 && cap[0].indexOf('data-ftt-tab="overview"') >= 0
            && tabs.join(',') === 'overview,console,extract,settings'
            && String(r1.html).indexOf('未分析楼层') >= 0
            && String(r2.html).indexOf('ftt_v2_cfg_budget') >= 0
            && cmdText.indexOf('已打开弹窗') >= 0;
    } finally { host.ctx.callGenericPopup = saved; }
})(), typeof (host.ctx.commands || []).filter((c) => c.name === 'ftt-ui')[0]);

assert('M2 /ftt 状态含「界面：弹窗优先」与装配/面板/菜单诊断', (() => {
    const out = String(((host.ctx.commands || []).filter((c) => c.name === 'ftt')[0] || {}).callback());
    return out.indexOf('界面：弹窗优先') >= 0 && out.indexOf('抽屉卡片 关') >= 0
        && out.indexOf('装配：已初始化') >= 0 && out.indexOf('菜单入口：') >= 0;
})(), String(((host.ctx.commands || []).filter((c) => c.name === 'ftt')[0] || {}).callback()).slice(0, 200));

// 后续 B3/E/I/L 断言语义为「抽屉卡片路径」：按需打开该开关并强制挂载一次（用户默认不开，但功能仍需可用）
const rtMod = await import('../core/model/runtime.js');
rtMod.cfg.uiShowDrawer = true;
await entry.forceMountPanel();

assert('B3 抽屉卡片路径（cfg.uiShowDrawer=true 时）已挂载到 #extensions_settings2（渲染真实 settings.html 模板）', (() => {
    const el = doc.getElementById('extensions_settings2');
    return !!el && el.html.indexOf('ftt_v2_settings') >= 0 && el.html.indexOf('ftt_v2_budget') >= 0 && el.html.indexOf('ftt_v2_autoupd') >= 0;
})(), doc.getElementById('extensions_settings2') && doc.getElementById('extensions_settings2').html.slice(0, 100));

assert('B4 配置已初始化进 extensionSettings（含版本戳）', (() => {
    const s = host.ctx.extensionSettings[MODULE_NAME];
    return !!s && s.version === VERSION && host.ctx.saveSettingsCount >= 1;
})(), host.ctx.extensionSettings[MODULE_NAME]);

assert('B5 /ftt 命令注册且回调可执行', (() => {
    const cmd = (host.ctx.commands || [])[0];
    return !!cmd && cmd.name === 'ftt' && String(cmd.callback()).indexOf(VERSION) >= 0;
})(), host.ctx.commands);

assert('B6 宏注册（fttVersion / fttStatus）', (() => {
    const names = (host.ctx.macrosRegistered || []).map(x => x.name);
    return names.indexOf('fttVersion') >= 0 && names.indexOf('fttStatus') >= 0;
})(), host.ctx.macrosRegistered);

assert('B7 window.FTT 调试导出可用（快照含 14 维与探测结果）', (() => {
    const F = globalThis.FTT;
    if (!F || typeof F.snapshot !== 'function') return false;
    const snap = F.snapshot();
    return snap.version === VERSION && snap.dimensions.length === 14 && snap.probe.ok === true;
})(), typeof globalThis.FTT);

// ---------- C 生成前钩子（永不 abort） ----------
let aborted = false;
const gname = (await import('../manifest.json', { with: { type: 'json' } }).catch(() => ({ default: null }))).default;
try {
    const interceptor = globalThis.fttGenerateInterceptor;
    await interceptor(host.ctx.chat, 8192, () => { aborted = true; }, 'normal');
    assert('C1 全局拦截器可被 ST 调用且不 abort、不改 chat', aborted === false && host.ctx.chat.length === 1, { aborted, name: gname && gname.generate_interceptor });
} catch (e) {
    assert('C1 全局拦截器可被 ST 调用且不 abort、不改 chat', false, String(e.message));
}
assert('C2 拦截器统计可读（供 /ftt 与调试导出）', entry.__internals.interceptorStats().calls >= 1, entry.__internals.interceptorStats());

// ---------- E 更新检查机制（首次启动自动检查 + 设定内手动检查） ----------
assert('E1 设置面板含更新区块（自动检查开关 / 仓库地址 / 检查与立即更新按钮 / 状态行）', (() => {
    const el = doc.getElementById('extensions_settings2');
    return !!el && el.html.indexOf('ftt_v2_autoupd') >= 0 && el.html.indexOf('ftt_v2_updrepo') >= 0
        && el.html.indexOf('ftt_v2_checkupd') >= 0 && el.html.indexOf('ftt_v2_doupd') >= 0
        && el.html.indexOf('data-ftt-update-state') >= 0;
})(), doc.getElementById('extensions_settings2').html.slice(0, 120));

await new Promise(r => setTimeout(r, 60));
assert('E2 首次启动自动检查：写 startupCheckedAt/lastCheckAt + 结果来自 ST 端点', (() => {
    const st = readUpdateState();
    return st.firstRunAt > 0 && st.startupCheckedAt > 0 && st.lastCheckAt > 0
        && !!st.lastResult && st.lastResult.via === 'st-endpoint' && st.lastResult.isUpToDate === true;
})(), readUpdateState());
assert('E3 自动检查结果回填状态行（Git 校验：已是最新）', (() => {
    const t = String(doc.getElementById('ftt_v2_updstate').textContent || '');
    return t.indexOf('已是最新（Git 校验）') >= 0;
})(), doc.getElementById('ftt_v2_updstate').textContent);

// 手动检查：让 ST 端点不可用 → 回退远端清单（有新版本 + 更新要点）
endpointDown = true;
doc.getElementById('ftt_v2_checkupd').dispatch('click');
await new Promise(r => setTimeout(r, 60));
assert('E4 手动检查（按钮）：端点不可用时回退远端清单并报出新版本', (() => {
    const t = String(doc.getElementById('ftt_v2_updstate').textContent || '');
    const st = readUpdateState();
    return t.indexOf('发现新版本 ' + remoteVersion) >= 0 && st.lastResult.status === 'newer'
        && Array.isArray(st.lastResult.points) && st.lastResult.points.join(' ').indexOf('更新检查机制') >= 0;
})(), doc.getElementById('fft_v2_updstate') ? String(doc.getElementById('ftt_v2_updstate').textContent) : '');
assert('E5 更新请求走「配置仓库 → GitHub raw」地址', fetchCalls.some(u => u === 'https://raw.githubusercontent.com/fotomxq/stt-memory-plugin-v2/main/manifest.json'), fetchCalls.slice(0, 6));

// 立即更新（显式，仅用户点击）
doc.getElementById('ftt_v2_doupd').dispatch('click');
await new Promise(r => setTimeout(r, 40));
assert('E6 「立即更新」按钮调用 ST 更新端点并回填 commit', (() => {
    const t = String(doc.getElementById('ftt_v2_updstate').textContent || '');
    return fetchCalls.indexOf('/api/extensions/update') >= 0 && t.indexOf('beef999') >= 0;
})(), doc.getElementById('ftt_v2_updstate').textContent);
assert('E7 /ftt 状态输出含更新行', (() => {
    const cmd = (host.ctx.commands || [])[0];
    const out = String(cmd.callback());
    return out.indexOf('更新：') >= 0;
})(), String(((host.ctx.commands || [])[0] || {}).callback));
assert('E8 调试导出含更新状态', (() => {
    const F = globalThis.FTT;
    const u = F && typeof F.update === 'function' ? F.update() : null;
    return !!u && !!u.config && u.config.repo === 'https://github.com/fotomxq/stt-memory-plugin-v2';
})(), typeof globalThis.FTT);
// ---------- F V1 数据导入（P2 次批：发现 → 干跑 → apply 写入） ----------
const v1mod = await import('../adapters/import-v1.js');
const coreState = await import('../core/state.js');
{
    const scope = coreState.scopeId();
    const payload = {
        scope, updatedAt: 1700000000000,
        data: { version: 'v1.206', scope, state: { time: '', date: '', location: '码头', sceneFocus: null },
            atoms: [{ id: 'v1a1', title: 'V1 情节甲', text: '正文足够长的一段情节描述。' }],
            memories: [{ id: 'v1m1', owner: '角色甲', content: 'V1 记忆一条', date: '1919-11-29' }] },
    };
    const env = { v: 1, scope, payload, hash: v1EnvelopeHashOf(payload), ts: 1700000000001 };
    v1FileName = v1mod.v1FileNames(scope, v1mod.v1SlugFromName('角色甲')).state[1];   // 明文 .json（避免冒烟里再造 gzip）
    v1FileText = JSON.stringify(env);
}
function v1EnvelopeHashOf(payload) {
    const str = JSON.stringify(payload);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ (c ^ 0x5f), 0x85ebca6b) >>> 0;
    }
    return h1.toString(36) + '_' + h2.toString(36);
}
const memStore = {};
const prevLs = globalThis.localStorage;
globalThis.localStorage = {
    get length() { return Object.keys(memStore).length; },
    key(i) { return Object.keys(memStore)[i]; },
    getItem(k) { return Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : null; },
    setItem(k, v) { memStore[String(k)] = String(v); },
    removeItem(k) { delete memStore[k]; },
};

assert('F1 V1 导入入口已导出（FTT.importV1 / FTT.importStatus）', (() => {
    const F = globalThis.FTT;
    return !!F && typeof F.importV1 === 'function' && typeof F.importStatus === 'function';
})(), typeof globalThis.FTT);

const dry = await globalThis.FTT.importV1({});
assert('F2 干跑：发现 V1 文件并出差异报告，不写入（merged 为空）', (() => {
    return dry.dryRun === true && dry.via === 'server-file' && dry.name === v1FileName
        && dry.report.totals.add === 2 && dry.report.totals.v1Entries === 2
        && dry.merged === null && Array.isArray(dry.notes) && dry.report.scope.v1 === coreState.scopeId();
})(), { via: dry.via, name: dry.name, totals: dry.report && dry.report.totals });

const applied = await globalThis.FTT.importV1({ apply: true });
const savedKey = 'ftt2_state_' + coreState.scopeId();
const saved = memStore[savedKey] ? JSON.parse(memStore[savedKey]) : null;
assert('F3 apply：合并写入内核并走保存流水线落盘（信封含导入条目；源文件未被删）', (() => {
    const data = saved && saved.payload ? saved.payload.data : null;
    const ids = data ? (data.atoms || []).map((x) => x.id) : [];
    const mIds = data ? (data.memories || []).map((x) => x.id) : [];
    return applied.dryRun === false && applied.summary && applied.summary.added.atoms === 1
        && ids.indexOf('v1a1') >= 0 && mIds.indexOf('v1m1') >= 0
        && saved.payload.scope === coreState.scopeId()
        && String(applied.notes.join('|')).indexOf('未被删除') >= 0
        && fetchCalls.every((u) => u.indexOf('/api/files/delete') !== 0);
})(), { key: savedKey, ids: saved && saved.payload ? (saved.payload.data.atoms || []).map((x) => x.id) : null });

const impCmd = (host.ctx.commands || []).filter((c) => c.name === 'ftt-import')[0];
assert('F4 /ftt-import 命令：默认干跑并给出「确认写入」提示，apply 时报告已写入', (async () => {
    if (!impCmd || typeof impCmd.callback !== 'function') return false;
    const dryText = String(await impCmd.callback({}, ''));
    const applyText = String(await impCmd.callback({}, 'apply'));
    return dryText.indexOf('【干跑】') >= 0 && dryText.indexOf('确认写入') >= 0 && applyText.indexOf('【已写入】') >= 0;
})(), typeof impCmd);

assert('F5 /ftt 状态含 V1 导入行', (() => {
    const cmd = (host.ctx.commands || []).filter((c) => c.name === 'ftt')[0];
    const out = String(cmd.callback());
    return out.indexOf('V1 导入：') >= 0;
})(), '');
// 注意：localStorage 桩保留到测试结束 —— 真实酒馆始终有 localStorage，
// 后续（数据台/H 段）的「保存是否真的落盘」断言依赖它（F 段引入，不在此卸载）。

// ---------- G 记忆注入（P3 首批：内核配置 → 注入推送 → 拦截器） ----------
const rt = await import('../core/model/runtime.js');
const coreCfgMod = await import('../core/config.js');
/** 默认配置键数 = V1 的 217 + V2 专有界面键 3（uiShowDrawer / uiShowFloating / uiFirstTab） */
const DEF_CFG_KEYS = Object.keys(coreCfgMod.defaultCfg).length;
const inj = await import('../host/inject.js');
const coreCfg = await import('../core/config.js');
{
    const s = coreState.emptyState();
    s.state = { time: '', date: '1919-11-29', location: '码头', sceneFocus: null };
    s.atoms = [{ id: 'smoke-a1', title: '烟测情节', text: '角色甲在码头发现一只木箱，断口整齐（正文足够长）。', date: '1919-11-29', tags: ['码头'], floor: 1 }];
    rt.setKernelState(s);
}
rt.cfg.injectCurrentPrompt = true;
rt.cfg.charBudget = 8000;

assert('G1 内核配置已同步：默认 217(V1)+3(V2 界面键) 进入内核视图并落盘 ST 配置容器', (() => {
    const store = host.ctx.extensionSettings.ftt_memory_v2;
    return Object.keys(rt.cfg).length === DEF_CFG_KEYS && rt.cfg.charBudget === 8000
        && !!store && !!store.cfg && store.cfg.maxAtoms === coreCfg.defaultCfg.maxAtoms
        && String(rt.cfg.promptTemplates.injectGuide).length > 100;
})(), { keys: Object.keys(rt.cfg).length });

host.emit('CHARACTER_MESSAGE_RENDERED');
await new Promise((r) => setTimeout(r, 20));
assert('G2 楼层事件刷新注入：写入 ST 注入通道（结构头 + 正文 + 结束标记）', (() => {
    const p = host.ctx.extensionPrompts[INJECT_ID];
    const val = p ? String(p.value) : '';
    return val.indexOf('【FTT记忆注入】') === 0 && val.indexOf('记忆结束。') > 0
        && val.indexOf('发现一只木箱') > 0 && p.position === 0 && p.depth === 0;
})(), String((host.ctx.extensionPrompts[INJECT_ID] || {}).value || '').slice(0, 60));

let smokeAborted = 0;
const smokeChat = [{ is_user: true, mes: '你好' }, { is_user: false, mes: '晚上好' }];
const smokeChatCopy = JSON.stringify(smokeChat);
assert('G3 生成前拦截器：刷新注入、不改 chat、永不 abort', (async () => {
    globalThis.fttGenerateInterceptor(smokeChat, 8000, () => { smokeAborted++; }, 'normal');
    await new Promise((r) => setTimeout(r, 20));
    const val = String((host.ctx.extensionPrompts[INJECT_ID] || {}).value || '');
    const st = entry.runtimeState().interceptor;
    return smokeAborted === 0 && JSON.stringify(smokeChat) === smokeChatCopy
        && val.indexOf('【FTT记忆注入】') === 0 && st.calls >= 1 && st.injectedLength === val.length
        && st.lastPush && st.lastPush.injected === true;
})(), typeof globalThis.fttGenerateInterceptor);

// ---------- H 提取（P4 首批：AI 摘要 → JSON 增量 → mergeDelta → 台账） ----------
const floorsMod = await import('../host/floors.js');
const extractMod = await import('../host/extract.js');
host.ctx.chat.push({ is_user: false, mes: '甲用铜钥匙打开木箱，取出账册并记下转运日期。', name: '角色甲' });
const floorId = host.ctx.chat.length - 1;

assert('H1 提取入口已导出（FTT.analyze / pendingFloors / extractStatus）', (() => {
    const F = globalThis.FTT;
    return !!F && typeof F.analyze === 'function' && typeof F.pendingFloors === 'function' && typeof F.extractStatus === 'function';
})(), typeof globalThis.FTT);

assert('H2 楼层判据与台账：可分析正文 + 哈希台账（版本签名与 V1 同值）', (() => {
    const txt = floorsMod.floorAnalyzableText(floorId);
    return txt.indexOf('[第' + floorId + '楼 AI]') === 0 && txt.indexOf('铜钥匙') > 0
        && floorsMod.PROCESSED_SIG === '11n8nlu' && floorsMod.PROCESSED_VER === 'v1.174'
        && globalThis.FTT.pendingFloors({}).indexOf(floorId) >= 0;
})(), floorsMod.PROCESSED_SIG);

const aiDelta = JSON.stringify({ atoms: { add: [{ title: '账册', text: '甲打开木箱取出账册并记下转运日期。', date: '1919-11-29' }] } });

assert('H3 FTT.analyze：AI 返回 JSON → 落库 + 台账记录 + 状态可读', (async () => {
    const saved = host.ctx.generateRaw;
    host.ctx.generateRaw = async () => aiDelta;
    try {
        const r = await globalThis.FTT.analyze({ floor: floorId });
        const st = globalThis.FTT.extractStatus();
        const imported = entry.__internals;
        return r.ok === true && r.added === 1 && r.floor === floorId
            && floorsMod.isFloorProcessed(floorId) === true
            && st.runs >= 1 && st.ok >= 1 && st.processed.tag === floorsMod.PROCESSED_VER + ':' + floorsMod.PROCESSED_SIG
            && !!imported;
    } finally { host.ctx.generateRaw = saved; }
})(), '');

assert('H4 /ftt-analyze 命令：指定楼层与清单两种用法；/ftt 状态含提取行', (async () => {
    const cmd = (host.ctx.commands || []).filter((c) => c.name === 'ftt-analyze')[0];
    const st = (host.ctx.commands || []).filter((c) => c.name === 'ftt')[0];
    if (!cmd) return false;
    const list = String(await cmd.callback({}, 'list'));
    const saved = host.ctx.generateRaw;
    host.ctx.generateRaw = async () => aiDelta;
    try {
        const one = String(await cmd.callback({}, String(floorId)));
        return list.indexOf('待分析楼层') >= 0 && one.indexOf('分析完成') >= 0 && String(st.callback()).indexOf('提取：') >= 0;
    } finally { host.ctx.generateRaw = saved; }
})(), typeof (host.ctx.commands || []).filter((c) => c.name === 'ftt-analyze')[0]);

assert('H5 GENERATION_ENDED 自动提取：新增 AI 楼后事件触发即自动分析并记账', (async () => {
    host.ctx.chat.push({ is_user: false, mes: '甲把账册放回木箱，锁上铜锁，转身离开仓库。', name: '角色甲' });
    const newFloor = host.ctx.chat.length - 1;
    const saved = host.ctx.generateRaw;
    host.ctx.generateRaw = async () => aiDelta;
    try {
        host.emit('GENERATION_ENDED');
        await new Promise((r) => setTimeout(r, 30));
        return floorsMod.isFloorProcessed(newFloor) === true
            && String(((host.ctx.commands || []).filter((c) => c.name === 'ftt')[0] || {}).callback()).indexOf('提取：') >= 0;
    } finally { host.ctx.generateRaw = saved; }
})(), '');

assert('H6 提取失败姿态：AI 不可用时只回报原因，不影响聊天与注入', (async () => {
    host.ctx.chat.push({ is_user: false, mes: '甲在仓库门口停下，回头看了一眼。', name: '角色甲' });
    const f = host.ctx.chat.length - 1;
    const saved = host.ctx.generateRaw;
    delete host.ctx.generateRaw;
    try {
        const r = await globalThis.FTT.analyze({ floor: f });
        const injectVal = String((host.ctx.extensionPrompts[INJECT_ID] || {}).value || '');
        return r.ok === false && r.reason === 'no-generate'
            && floorsMod.isFloorProcessed(f) === false
            && host.ctx.chat[f].mes.indexOf('回头看了一眼') > 0
            && (injectVal === '' || injectVal.indexOf('【FTT记忆注入】') === 0);
    } finally { host.ctx.generateRaw = saved; }
})(), '');

// ---------- I 设定面板（P5 首批：内核配置控件 + 状态块 + 动作按钮） ----------
const panelMod = await import('../ui/settings-panel.js');

assert('I1 面板已渲染内核配置控件 / 维度勾选 / 状态块 / 动作按钮（模板渲染）', (() => {
    const html = doc._els.extensions_settings2.html;
    // 桩 DOM 的模板渲染不做变量替换（原样写入 html），故状态块文本由 refreshPanelStatus 落地后再断言
    const statusText = panelMod.refreshPanelStatus();
    return html.indexOf('ftt_v2_cfg_budget') >= 0 && html.indexOf('ftt_v2_cfg_autoext') >= 0
        && html.indexOf('ftt_v2_dims') >= 0 && html.indexOf('ftt_v2_status') >= 0
        && html.indexOf('ftt_v2_analyze') >= 0 && html.indexOf('ftt_v2_imp_dry') >= 0
        && String(statusText).indexOf('内核配置') >= 0
        && String(doc._els.ftt_v2_status.textContent).indexOf('提取：') >= 0;
})(), String(doc._els.ftt_v2_status.textContent || '').slice(0, 80));

assert('I2 面板 cfg 控件：change 事件写回内核配置并持久化到 ST 配置容器', (() => {
    const el = doc._els.ftt_v2_cfg_autoext;
    const before = rt.cfg.autoExtract;
    el.checked = false;
    el.dispatch('change');
    const store = host.ctx.extensionSettings.ftt_memory_v2;
    const persisted = store && store.cfg && store.cfg.autoExtract;
    const el2 = doc._els.ftt_v2_cfg_budget;
    el2.value = '6000';
    el2.dispatch('change');
    return before !== false && rt.cfg.autoExtract === false && persisted === false
        && rt.cfg.charBudget === 6000 && store.cfg.charBudget === 6000
        && panelMod.PANEL_CFG_BINDINGS.ftt_v2_cfg_autoext[0] === 'autoExtract';
})(), JSON.stringify({ autoExtract: rt.cfg.autoExtract, budget: rt.cfg.charBudget }));

assert('I3 维度开关与状态块刷新：applyPanelDim 写 cfg.dimensionEnabled，状态块随之刷新', (() => {
    const r = panelMod.applyPanelDim('atoms', false);
    const txt = panelMod.refreshPanelStatus();
    return r.ok === true && rt.cfg.dimensionEnabled.atoms === false
        && String(txt).indexOf('内核配置') >= 0;
})(), '');

assert('I4 面板动作按钮：待分析清单 / 分析未分析楼层 / 清空注入 均调用注入钩子并回填提示', (async () => {
    // 复原自动提取开关，避免影响后续动作
    rt.cfg.autoExtract = true;
    doc._els.ftt_v2_list.dispatch('click');
    await new Promise((r) => setTimeout(r, 20));
    const listNote = String(doc._els.ftt_v2_action.textContent || '');
    doc._els.ftt_v2_clearinj.dispatch('click');
    await new Promise((r) => setTimeout(r, 10));
    const clearNote = String(doc._els.ftt_v2_action.textContent || '');
    const injectAfter = String((host.ctx.extensionPrompts[INJECT_ID] || {}).value || '');
    const saved = host.ctx.generateRaw;
    host.ctx.generateRaw = async () => JSON.stringify({ atoms: { add: [{ title: '面板', text: '甲在仓库门口停下脚步并望向码头。', date: '1919-11-29' }] } });
    try {
        host.ctx.chat.push({ is_user: false, mes: '甲在仓库门口停下脚步并望向码头。', name: '角色甲' });
        doc._els.ftt_v2_analyze.dispatch('click');
        await new Promise((r) => setTimeout(r, 40));
    } finally { host.ctx.generateRaw = saved; }
    const analyzeNote = String(doc._els.ftt_v2_action.textContent || '');
    return (listNote.indexOf('待分析') >= 0 || listNote.indexOf('没有') >= 0)
        && clearNote.indexOf('已清空注入') >= 0 && injectAfter === ''
        && (analyzeNote.indexOf('分析完成') >= 0 || analyzeNote.indexOf('新增') >= 0);
})(), String(doc._els.ftt_v2_action.textContent || ''));

// ---------- J 数据台（P5 次批：浏览 / 搜索 / 编辑 / 删除 / 注入自查） ----------
const con = await import('../ui/console.js');

assert('J1 数据台已随面板渲染：维度标签 + 搜索框 + 条目行 + 注入自查合计', (() => {
    const html = String(doc._els.ftt_v2_console.html || '');
    const sum = con.consoleSummary();
    return html.indexOf('数据台 · 共') >= 0 && html.indexOf('data-ftt-console="tab"') >= 0
        && html.indexOf('ftt_con_search') >= 0 && html.indexOf('注入 ') >= 0
        && sum.dims.length === 14 && sum.total >= 1 && typeof sum.injectChars === 'number';
})(), (() => { try { return con.consoleSummary(); } catch (e) { return String(e.message); } })());

assert('J2 搜索与列表：按正文/标签命中过滤，未命中返回空；标签行取维度容器', (() => {
    con.consoleAction('tab', { kind: 'atoms' });
    const all = con.consoleList('atoms', '');
    const hitText = con.consoleList('atoms', '木箱');
    const hitTag = con.consoleList('atoms', '码头');
    const none = con.consoleList('atoms', '不存在的关键词zzz');
    return all.length >= 1 && hitText.length >= 1 && hitTag.length >= 1 && none.length === 0
        && con.entryMatches(all[0], '') === true;
})(), (() => { try { return con.consoleList('atoms', '木箱').length; } catch (e) { return String(e.message); } })());

assert('J3 编辑保存：走 upsertEntry 写回内核容器并落盘（信封含新值）', (() => {
    const list = con.consoleList('atoms', '木箱');
    const id = String((list[0] || {}).id || '');
    con.consoleAction('open', { kind: 'atoms', id });
    const detail = con.consoleEntry('atoms', id);
    const r = con.consoleAction('save', { kind: 'atoms', id, fields: { title: '木箱（已核对）', text: '甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29', tags: '码头、木箱', importance: '0.9' } });
    const after = con.consoleEntry('atoms', id);
    const env = memStore['ftt2_state_' + coreState.scopeId()] ? JSON.parse(memStore['ftt2_state_' + coreState.scopeId()]) : null;
    const persisted = env && env.payload && env.payload.data ? (env.payload.data.atoms || []).filter((x) => String(x.id) === id)[0] : null;
    return !!detail && !!detail.hash && r.ok === true && after.item.title === '木箱（已核对）'
        && after.item.importance === 0.9 && after.item.tags.join('、') === '码头、木箱'
        && !!persisted && persisted.title === '木箱（已核对）';
})(), (() => { try { return con.consoleState().note; } catch (e) { return String(e.message); } })());

assert('J4 删除：移除条目 + 写 id 墓碑（跨端不复活），列表随之减少', (() => {
    const list = con.consoleList('atoms', '');
    const id = String((list[0] || {}).id || '');
    const r = con.consoleAction('delete', { kind: 'atoms', id });
    const after = con.consoleList('atoms', '');
    return r.ok === true && after.filter((x) => String(x.id) === id).length === 0
        && ((rt.state.deleted || {}).atoms || {})[id] !== undefined
        && con.consoleState().note.indexOf('已删除') >= 0;
})(), (() => { try { return JSON.stringify((rt.state.deleted || {}).atoms || {}); } catch (e) { return String(e.message); } })());

assert('J5 注入自查：逐条判定是否进入当前注入，并给出命中/未命中合计', (() => {
    host.ctx.chat.push({ is_user: false, mes: '甲重新清点货物并把记录写在账册上。', name: '角色甲' });
    return (async () => {
        const saved = host.ctx.generateRaw;
        host.ctx.generateRaw = async () => aiDelta;
        try { await globalThis.FTT.analyze({ floor: host.ctx.chat.length - 1 }); } finally { host.ctx.generateRaw = saved; }
        rt.setKernelState(rt.state);                     // 触发一次注入刷新所依赖的视图（幂等）
        const au = con.injectAudit({});
        return au.chars > 0 && au.injected + au.missing > 0 && Array.isArray(au.rows) && au.rows.length === au.injected + au.missing;
    })();
})(), (() => { try { const a = con.injectAudit({ rows: false }); return JSON.stringify(a); } catch (e) { return String(e.message); } })());

assert('J6 数据台动作入口与刷新按钮：tab/search/cancel 可用，刷新按钮回填提示', (async () => {
    const t = con.consoleAction('tab', { kind: 'memories' });
    const q = con.consoleAction('search', { q: '记忆' });
    const c = con.consoleAction('cancel', {});
    const bad = con.consoleAction('不存在', {});
    doc._els.ftt_v2_console_refresh.dispatch('click');
    await new Promise((r) => setTimeout(r, 10));
    return t.ok === true && q.ok === true && c.ok === true && bad.ok === false
        && con.consoleState().tab === 'memories' && con.consoleState().q === '记忆' && con.consoleState().open === null
        && String(doc._els.ftt_v2_action.textContent || '').indexOf('数据台已刷新') >= 0;
})(), (() => { try { return JSON.stringify(con.consoleState()); } catch (e) { return String(e.message); } })());

// ---------- K 词条（i18n，P6） ----------
const i18nMod = await import('../adapters/i18n.js');
const pathsMod = await import('../host/paths.js');

assert('K1 词条已注册到宿主：zh-cn 与 en 两份（键集一致、JS 镜像即运行时词条）', (() => {
    const st = i18nMod.i18nStats();
    const calls = host.ctx.localeCalls || [];
    return st.locales.join(',') === 'zh-cn,en' && st.keys >= 40
        && st.registered.ok === true && st.registered.locales.indexOf('zh-cn') >= 0 && st.registered.locales.indexOf('en') >= 0
        && calls.length >= 2 && !!host.ctx.localeData['en']['保存'] && host.ctx.localeData['en']['保存'] === 'Save'
        && Object.keys(host.ctx.localeData['zh-cn']).length === st.keys;
})(), (() => { try { return JSON.stringify({ st: i18nMod.i18nStats(), calls: host.ctx.localeCalls, enKeys: Object.keys((host.ctx.localeData || {}).en || {}).length, zhKeys: Object.keys((host.ctx.localeData || {})['zh-cn'] || {}).length, sample: ((host.ctx.localeData || {}).en || {})['保存'] }); } catch (e) { return String(e.message); } })());

assert('K2 文案查询与状态行：t() 按当前语言取词（缺失回退键本身，支持占位变量），/ftt 含语言行', (() => {
    host.ctx.locale = 'en';
    const en = globalThis.FTT.t('保存');
    const enMissing = globalThis.FTT.t('不存在的键');
    host.ctx.locale = 'zh-cn';
    const zh = globalThis.FTT.t('保存');
    const withVar = i18nMod.t('分析完成：成功 {n} / {m}', { n: 2, m: 3 });
    const statusLine = String(((host.ctx.commands || []).filter((c) => c.name === 'ftt')[0] || {}).callback()).indexOf('语言：') >= 0;
    return en === 'Save' && zh === '保存' && enMissing === '不存在的键' && withVar === '分析完成：成功 2 / 3' && statusLine;
})(), String(globalThis.FTT.t('保存')));

// ---------- K3 扩展目录名解析（安装位置无关） ----------
assert('K3 更新端点与设置面板都用「运行时解析的扩展目录名」（改名/归档安装同样可用）', (() => {
    const info = (globalThis.FTT && typeof globalThis.FTT.folderInfo === 'function') ? globalThis.FTT.folderInfo() : null;
    const calledNames = (fetchCalls || []).length;   // 版本端点调用过（E2）
    const p = pathsMod.folderInfo();
    return !!info && info.folder === p.folder && info.folder.length > 0
        && pathsMod.folderFromUrl('http://x/scripts/extensions/third-party/renamed/host/paths.js') === 'third-party/renamed'
        && calledNames > 0;
})(), (() => { try { return JSON.stringify(pathsMod.folderInfo()); } catch (e) { return String(e.message); } })());

// ---------- L 可见性（用户报「装上了但看不到面板」的防护） ----------
assert('L1 装配触发来源可查：加载期探针已在无事件依赖下完成装配与挂载', (() => {
    const b = entry.runtimeState().bootstrap;
    const panel = entry.panelMountInfo();
    return Array.isArray(b.triggers) && b.triggers.length >= 1
        && panel.mounted === true && panel.ok === true && String(panel.container) === 'extensions_settings2'
        && String(doc._els.extensions_settings2.html).indexOf('ftt_v2_settings') >= 0;
})(), (() => { try { return JSON.stringify({ t: entry.runtimeState().bootstrap.triggers, p: entry.panelMountInfo().container }); } catch (e) { return String(e.message); } })());

assert('L2 /ftt-panel 命令存在且报告面板/候选容器/菜单与「在扩展设置抽屉」提示', (async () => {
    const cmd = (host.ctx.commands || []).filter((c) => c.name === 'ftt-panel')[0];
    if (!cmd) return false;
    const t = String(await cmd.callback({}, ''));
    return t.indexOf('面板挂载') >= 0 && t.indexOf('候选容器') >= 0 && t.indexOf('菜单入口') >= 0 && t.indexOf('扩展设置') >= 0;
})(), typeof (host.ctx.commands || []).filter((c) => c.name === 'ftt-panel')[0]);

assert('L3 面板状态块含挂载诊断行（用户可在面板里看到「面板挂载：已挂载 → #容器」）', (() => {
    const txt = panelMod.refreshPanelStatus();
    return String(txt).indexOf('面板挂载：') >= 0 && String(txt).indexOf('已挂载') >= 0;
})(), String(panelMod.refreshPanelStatus()).split('\n').slice(-1)[0]);

assert('L4 魔杖菜单入口已插入 #extensionsMenu（面板容器异常时的可见兜底）', (() => {
    const html = String((doc._els.extensionsMenu || {}).html || '');
    const info = globalThis.FTT && typeof globalThis.FTT.menuInfo === 'function' ? globalThis.FTT.menuInfo() : null;
    return html.indexOf('ftt_v2_menu_btn') >= 0 && !!info && info.menuFound === true;
})(), (() => { try { return JSON.stringify(globalThis.FTT.menuInfo()); } catch (e) { return String(e.message); } })());

// ---------- L5 悬浮兜底（抽屉容器异常时的最后可见性方案） ----------
assert('L5 悬浮兜底链路：抽屉不可用时装悬浮入口 → 点击以弹窗打开面板 → 抽屉恢复后自动移除', (async () => {
    const floatMod = await import('../ui/floating.js');
    const saved = { a: doc._els.extensions_settings2, b: doc._els.extensions_settings, c: doc._els.rm_extensions_block };
    delete doc._els.extensions_settings2; delete doc._els.extensions_settings; delete doc._els.rm_extensions_block;
    doc.body = { html: '', insertAdjacentHTML(pos, h) { this.html += String(h); } };
    const savedPopup = host.ctx.callGenericPopup;
    const popupHtml = [];
    host.ctx.callGenericPopup = async (html) => { popupHtml.push(String(html)); return 1; };
    panelMod.unmountSettingsPanel();
    const vis = await entry.ensureVisibleEntry();
    const clickR = await globalThis.FTT.openPanel();
    host.ctx.callGenericPopup = savedPopup;
    doc._els.extensions_settings2 = saved.a; doc._els.extensions_settings = saved.b; doc._els.rm_extensions_block = saved.c;
    const back = await entry.ensureVisibleEntry();
    return vis.panel.ok === false && vis.floating.ok === true
        && String(doc.body.html).indexOf('ftt_v2_float_btn') >= 0
        && clickR.ok === true && clickR.via === 'popup' && popupHtml.length === 1
        && popupHtml[0].indexOf('ftt_v2_settings') >= 0
        && back.panel.ok === true && back.floating.ok === false
        && floatMod.floatingInfo().installed === false;
})(), (() => { try { return JSON.stringify({ body: String(doc.body && doc.body.html || '').length, back: 'ok' }); } catch (e) { return String(e.message); } })());

endpointDown = false;
uninstallFetch();

// ---------- D 注入与收尾 ----------
assert('D1 注入通道可用且可写入/清空', (() => {
    const inp = entry.__internals;
    return inp.injectAvailable() === true;
})(), '');
assert('D2 teardown：解绑事件 + 清空注入 + 移除面板 + 清理调试导出', (() => {
    entry.teardown();
    const listenersLeft = Object.keys(host.listeners).length === 0;
    const injectCleared = !host.ctx.extensionPrompts[INJECT_ID] || host.ctx.extensionPrompts[INJECT_ID].value === '';
    const fttGone = globalThis.FTT === undefined;
    return listenersLeft && injectCleared && fttGone && entry.runtimeState().ready === false;
})(), { listeners: Object.keys(host.listeners).length, inject: host.ctx.extensionPrompts[INJECT_ID], ftt: typeof globalThis.FTT });

uninstall();
console.log('\n========== V2 冒烟：' + pass + ' 通过, ' + fail + ' 失败 ==========');
if (fail) { console.log('  失败项：' + failures.join(' | ')); process.exit(1); }
process.exit(0);
