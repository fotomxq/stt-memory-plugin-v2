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
function commit(name, cond, extra) {
    if (cond) { pass++; console.log('  ✅', name); }
    else { fail++; failures.push(name); console.log('  ❌', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
// 断言器（B9 专项 · 测试完整性）：
//   1) 同步条件：立即计数 —— 既有同步调用点行为与时序完全不变；
//   2) thenable 条件（异步小节）：内部 `await` 后再计数，**调用点必须写 `await assert(...)`**。
// 历史缺陷：调用点把 async IIFE 的 Promise 直接当条件传入且未 await → Promise 恒真 → 小节永远 ✅（假绿），
// 且副作用与后续小节并发交错（实测 W3 期间 generateRaw 被并发调用 6 次）。详见 docs/B9-测试完整性待修.md。
// 永久防呆（写法对齐 tests/harness/st-mock.js#makeReporter）：thenable 条件的调用点若没有 await
// （返回值未被 `.then` 消费），直接判失败并提示「请 await」——防止缺陷回归。
function assert(name, cond, extra) {
    const thenable = cond && (typeof cond === 'object' || typeof cond === 'function') && typeof cond.then === 'function';
    if (!thenable) { commit(name, cond, extra); return; }   // 同步条件：零影响
    const slot = { ok: false, extra, done: false, awaited: false, guardFailed: false };
    const running = (async () => {
        try { slot.ok = !!(await cond); } catch (e) { slot.ok = false; slot.extra = { error: String((e && e.message) || e) }; }
        slot.done = true;
        if (!slot.guardFailed) commit(name, slot.ok, slot.extra);   // 已由防呆判失败则不重复计数
    })();
    // 可被 await 的守卫对象：await 会在同一 tick 内通过 PromiseResolve 触发 .then()
    const guard = {
        then(onFulfilled, onRejected) { slot.awaited = true; return running.then(onFulfilled, onRejected); },
        catch(onRejected) { slot.awaited = true; return running.catch(onRejected); },
        finally(onFinally) { slot.awaited = true; return running.finally(onFinally); },
    };
    // 两个微任务之后仍未被 .then()（即 await）消费 → 调用点漏了 await：直接判失败并提示「请 await」
    queueMicrotask(() => queueMicrotask(() => {
        if (slot.awaited) return;
        slot.guardFailed = true;
        if (slot.done && slot.ok) pass--;                            // 撤销后台已计入的「假绿」
        if (!(slot.done && !slot.ok)) { fail++; }                    // 已按失败计过则不重复
        if (failures.indexOf(name) < 0) failures.push(name);
        console.log('  ❌', name, '断言条件是一个 Promise 而调用点没有 `await`：请改为 `await assert(...)`');
    }));
    return guard;
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
// 远端样本版本按当前版本推导（发版升级不再打破本断言）
const remoteVersion = (() => {
    const m = String(VERSION).split('.').map((x) => Number(x.replace(/\D/g, '')) || 0);
    return [m[0] || 0, (m[1] || 0) + 1, 0].join('.');
})();
let endpointDown = false;
let v1FileName = '';
let v1FileText = '';
const fetchCalls = [];
// B7-2：服务端用户目录文件的内存实现（记忆文件 / 备份 / 快照 / 清单 / 同步日志）
const srvFiles = new Map();
const uninstallFetch = installGlobalFetch((url, opts) => {
    fetchCalls.push(url);
    if (url === '/api/files/upload') {
        let body = null;
        try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        if (!body || !body.name) return { status: 400, body: {} };
        let text = '';
        try { text = Buffer.from(String(body.data || ''), 'base64').toString('utf8'); } catch (e) { text = ''; }
        srvFiles.set(String(body.name), text);
        return { status: 200, text: 'ok' };
    }
    if (url.indexOf('/user/files/') === 0) {
        const name = decodeURIComponent(url.slice('/user/files/'.length));
        if (v1FileName && name === v1FileName) return { status: 200, text: v1FileText };
        if (srvFiles.has(name)) return { status: 200, text: srvFiles.get(name) };
        return { status: 404, body: {} };
    }
    if (url === '/api/extensions/version') {
        if (endpointDown) return { status: 404, body: {} };
        return { status: 200, body: { isUpToDate: true, currentCommitHash: 'abc1234def', currentBranchName: 'main' } };
    }
    if (url.indexOf('/api/extensions/update') === 0) return { status: 200, body: { isUpToDate: false, shortCommitHash: 'beef999' } };
    if (url.endsWith('/manifest.json')) return { status: 200, text: JSON.stringify({ version: remoteVersion }) };
    if (url.endsWith('/CHANGELOG.md')) return { status: 200, text: '# 版本历史\n\n## v' + remoteVersion + '（2026-10-01）\n\n- 新增：更新检查机制\n' };
    if (v1FileName && url === '/user/files/' + v1FileName) return { status: 200, text: v1FileText };
    return { status: 404, body: {} };
});

const host = makeHost({ templateHtml });
const doc = makeDocument(['extensions_settings2', 'extensions_settings', 'rm_extensions_block', 'extensionsMenu', 'ftt-panel', 'ftt_v2_settings', 'ftt_v2_updstate', 'ftt_v2_checkupd', 'ftt_v2_doupd', 'ftt_v2_autoupd', 'ftt_v2_updrepo', 'ftt_v2_usegit',
    'ftt_v2_cfg_injp', 'ftt_v2_cfg_budget', 'ftt_v2_cfg_maxatoms', 'ftt_v2_cfg_maxmems', 'ftt_v2_cfg_autoext',
    'ftt_v2_dims', 'ftt_v2_status', 'ftt_v2_action', 'ftt_v2_analyze', 'ftt_v2_list', 'ftt_v2_clearinj', 'ftt_v2_imp_dry', 'ftt_v2_imp_apply',
    'ftt_v2_console', 'ftt_v2_console_refresh']);
const uninstall = installGlobalHost(host, doc);
const entry = await import('../index.js');

const before = entry.runtimeState();
assert('B1 加载期探针即完成装配（无需 APP_READY；V1 同构浮层优先、抽屉卡片默认关）', (() => {
    const b = entry.extraForStatus().bootstrap;
    return before.ready === true && before.settingsVia === 'overlay'
        && before.bootstrap.triggers.indexOf('load') >= 0
        && b.popup && b.popup.id === 'ftt-panel' && b.popup.tabs.length === 13
        && b.menu && b.menu.menuFound === true;
})(), { ready: before.ready, via: before.settingsVia, triggers: before.bootstrap.triggers });

host.emit('APP_READY');
await new Promise(r => setTimeout(r, 30));
const st = entry.runtimeState();
assert('B2 APP_READY 再入装配（幂等）：ready/探测/事件绑定/命令/宏', (() => {
    const want = ['USER_MESSAGE_RENDERED', 'GENERATION_ENDED', 'CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED'];
    const got = (st.bind.bound || []).slice().sort().join(',');
    // 装配可能由「加载期探针」或「APP_READY」触发（多触发设计）；两者都算通过
    const viaOk = st.settingsVia === 'overlay' || st.settingsVia === 'template' || st.settingsVia === 'already';
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
await assert('M1 V1 同构面板：/ftt-ui 与 FTT.ui() 打开浮层、13 个 V1 分页、切页渲染对应内容', (async () => {
    const cmd = (host.ctx.commands || []).filter((c) => c.name === 'ftt-ui')[0];
    const open = await globalThis.FTT.ui('overview');
    const info = entry.panelInfo();
    const r1 = await entry.popupAction('tab', { tab: 'atoms' });
    const r2 = await entry.popupAction('tab', { tab: 'settings' });
    const r3 = await entry.popupAction('tab', { tab: 'overview' });
    const cmdText = cmd ? String(await cmd.callback({}, 'memories')) : '';
    return open.ok === true && open.via === 'overlay'
        && info.tabs.join(',') === 'overview,atoms,states,snapshots,memories,items,currencies,rumors,plans,scenes,concepts,parallels,settings'
        && String(r1.html).indexOf('data-ftt-search="atoms"') >= 0
        && String(r2.html).indexOf('data-ftt-settings-page="base"') >= 0        // V1 同构浮层的设定页标记（原断言 ftt_v2_cfg_budget 属抽屉模板 settings.html，浮层里恒不存在）
        && String(r2.html).indexOf('data-ftt-cfg="autoExtract"') >= 0           // base 子页的控件（settings-pages.js basePageHtml 首节）
        && String(r3.html).indexOf('📚 类目统计') >= 0
        && cmdText.indexOf('已打开 V1 同构面板') >= 0;
})(), typeof (host.ctx.commands || []).filter((c) => c.name === 'ftt-ui')[0]);

assert('M2 /ftt 状态含「界面：V1 同构浮层」与装配/面板/菜单诊断', (() => {
    const out = String(((host.ctx.commands || []).filter((c) => c.name === 'ftt')[0] || {}).callback());
    return out.indexOf('界面：V1 同构浮层') >= 0 && out.indexOf('抽屉卡片 关') >= 0
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
assert('E1 设置面板含更新区块（自动检查开关 / 仓库地址 / **宿主 Git 端点开关（默认关）** / 检查与立即更新按钮 / 状态行）', (() => {
    const el = doc.getElementById('extensions_settings2');
    return !!el && el.html.indexOf('ftt_v2_autoupd') >= 0 && el.html.indexOf('ftt_v2_updrepo') >= 0
        && el.html.indexOf('ftt_v2_usegit') >= 0 && el.html.indexOf('ftt_v2_checkupd') >= 0 && el.html.indexOf('ftt_v2_doupd') >= 0
        && el.html.indexOf('data-ftt-update-state') >= 0;
})(), doc.getElementById('extensions_settings2').html.slice(0, 160));

await new Promise(r => setTimeout(r, 60));
assert('E2 首次启动自动检查：写 startupCheckedAt/lastCheckAt，且**默认不触碰宿主 Git 端点**（回归 v2.11.1）', (() => {
    const st = readUpdateState();
    const gitCalls = fetchCalls.filter(u => u.indexOf('/api/extensions/version') >= 0).length;
    return st.firstRunAt > 0 && st.startupCheckedAt > 0 && st.lastCheckAt > 0
        && !!st.lastResult && st.lastResult.via.indexOf('remote-manifest:github') >= 0
        && st.lastResult.stEndpoint === 'off' && gitCalls === 0;
})(), { st: readUpdateState(), fetchCalls: fetchCalls.slice(0, 8) });
assert('E3 自动检查结果回填状态行（远端清单判定：发现新版本）', (() => {
    const t = String(doc.getElementById('ftt_v2_updstate').textContent || '');
    return t.indexOf('发现新版本 ' + remoteVersion) >= 0 && t.indexOf('remote-manifest:github') >= 0;
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

// 立即更新（显式，仅用户点击）—— 默认关闭宿主 Git 端点：**不发起任何请求**，只给引导
doc.getElementById('ftt_v2_doupd').dispatch('click');
await new Promise(r => setTimeout(r, 40));
assert('E6 默认关闭宿主 Git 端点：「立即更新」不请求 /api/extensions/update，只回填引导文案', (() => {
    const t = String(doc.getElementById('ftt_v2_updstate').textContent || '');
    return fetchCalls.indexOf('/api/extensions/update') < 0 && t.indexOf('未执行：') >= 0 && t.indexOf('Git handshake failed') >= 0;
})(), doc.getElementById('ftt_v2_updstate').textContent);

// 显式开启宿主 Git 端点（设置开关）→ 才允许调用更新端点
const usegitEl = doc.getElementById('ftt_v2_usegit');
usegitEl.checked = true;
usegitEl.dispatch('change');
doc.getElementById('ftt_v2_doupd').dispatch('click');
await new Promise(r => setTimeout(r, 40));
assert('E6b 开启后「立即更新」才调用宿主 Git 更新端点并回填 commit', (() => {
    const t = String(doc.getElementById('ftt_v2_updstate').textContent || '');
    return fetchCalls.indexOf('/api/extensions/update') >= 0 && t.indexOf('beef999') >= 0;
})(), doc.getElementById('ftt_v2_updstate').textContent);
usegitEl.checked = false;
usegitEl.dispatch('change');
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
await assert('F4 /ftt-import 命令：默认干跑并给出「确认写入」提示，apply 时报告已写入', (async () => {
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
await assert('G3 生成前拦截器：刷新注入、不改 chat、永不 abort', (async () => {
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

await assert('H3 FTT.analyze：AI 返回 JSON → 落库 + 台账记录 + 状态可读', (async () => {
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

await assert('H4 /ftt-analyze 命令：指定楼层与清单两种用法；/ftt 状态含提取行', (async () => {
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

await assert('H5 GENERATION_ENDED 自动提取：新增 AI 楼后事件触发即自动分析并记账', (async () => {
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

await assert('H6 提取失败姿态：AI 不可用时只回报原因，不影响聊天与注入', (async () => {
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

await assert('I4 面板动作按钮：待分析清单 / 分析未分析楼层 / 清空注入 均调用注入钩子并回填提示', (async () => {
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

await assert('J5 注入自查：逐条判定是否进入当前注入，并给出命中/未命中合计', (async () => {
    host.ctx.chat.push({ is_user: false, mes: '甲重新清点货物并把记录写在账册上。', name: '角色甲' });
    const saved = host.ctx.generateRaw;
    host.ctx.generateRaw = async () => aiDelta;
    try { await globalThis.FTT.analyze({ floor: host.ctx.chat.length - 1 }); } finally { host.ctx.generateRaw = saved; }
    rt.setKernelState(rt.state);                         // 刷新内核视图（幂等）
    await entry.injectNow();                             // I4「清空注入」后注入为空；注入自查需先按当前状态推送一次（生产触发路径见 index.js onFloorChanged）
    const au = con.injectAudit({});
    return au.chars > 0 && au.injected + au.missing > 0 && Array.isArray(au.rows) && au.rows.length === au.injected + au.missing;
})(), (() => { try { const a = con.injectAudit({ rows: false }); return JSON.stringify(a); } catch (e) { return String(e.message); } })());

await assert('J6 数据台动作入口与刷新按钮：tab/search/cancel 可用，刷新按钮回填提示', (async () => {
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

await assert('L2 /ftt-panel 命令存在且报告面板/候选容器/菜单与「在扩展设置抽屉」提示', (async () => {
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
await assert('L5 悬浮兜底链路：抽屉不可用时装悬浮入口 → 点击以弹窗打开面板 → 抽屉恢复后自动移除', (async () => {
    const floatMod = await import('../ui/floating.js');
    const saved = { a: doc._els.extensions_settings2, b: doc._els.extensions_settings, c: doc._els.rm_extensions_block };
    delete doc._els.extensions_settings2; delete doc._els.extensions_settings; delete doc._els.rm_extensions_block;
    doc.body = { html: '', insertAdjacentHTML(pos, h) { this.html += String(h); } };
    const popupHtml = [];
    panelMod.unmountSettingsPanel();
    const vis = await entry.ensureVisibleEntry();
    const clickR = await globalThis.FTT.openPanel();
    doc._els.extensions_settings2 = saved.a; doc._els.extensions_settings = saved.b; doc._els.rm_extensions_block = saved.c;
    const back = await entry.ensureVisibleEntry();
    return vis.panel.ok === false && vis.floating.ok === true
        && String(doc.body.html).indexOf('ftt_v2_float_btn') >= 0
        && clickR.ok === true && clickR.via === 'overlay' && popupHtml.length === 0
        && String((doc._els['ftt-panel'] || {}).html || '').indexOf('ftt-modal') >= 0
        && back.panel.ok === true && back.floating.ok === false
        && floatMod.floatingInfo().installed === false;
})(), (() => { try { return JSON.stringify({ body: String(doc.body && doc.body.html || '').length, back: 'ok' }); } catch (e) { return String(e.message); } })());

endpointDown = false;
// 注意：这里的 fetch 桩**不能在此卸载** —— 它同时承载「服务端用户目录文件」通道
//   （/api/files/upload + /user/files/<name>）：N 段的「立即同步 / 刷新状态」要真正读写主文件、备份与清单。
//   此前在此处 uninstallFetch() → globalThis.fetch 被删除 → 文件通道全部静默失败（N3/N4 因此永远不可能成立）。
//   改为收尾（D2 之后）再卸载。

// ---------- N 跨端同步（B7-2：文件通道 / 清单预判 / 快照文件 / 同步日志 / 刷新与立即同步） ----------
const syncMod = await import('../adapters/sync.js');
await assert('N1 存储页（V1 分节）：记忆文件/一致性/世界书/状态与操作/同步日志 + V1 同名动作按钮齐备', (async () => {
    await entry.popupAction('tab', { tab: 'settings' });
    const r = await entry.popupAction('settingsSub', { sub: 'storage' });
    const html = String(r.html || '');
    return html.indexOf('记忆文件（服务端 · 核心基准）') >= 0 && html.indexOf('一致性') >= 0
        && html.indexOf('世界书存储（单向写入 · 由下方开关联动）') >= 0 && html.indexOf('状态与操作') >= 0
        && html.indexOf('🔄 同步日志（最近 30 条 · 本角色）') >= 0
        && html.indexOf('data-ftt-action="storageStatusRefresh"') >= 0 && html.indexOf('data-ftt-action="storageSync"') >= 0
        && html.indexOf('data-ftt-action="storageVerify"') >= 0 && html.indexOf('data-ftt-action="syncLogRefresh"') >= 0
        && html.indexOf('data-ftt-action="syncLogClear"') >= 0 && html.indexOf('data-ftt-state-file-status') >= 0;
})(), '');

await assert('N2 同步日志：记录入队（本端源头 + ts）→ 面板渲染「本地 → 对端 → 同步后」→ 清空即空', (async () => {
    globalThis.FTT.syncLogClear();
    globalThis.FTT.syncLogPush({ action: '冒烟记录', mode: '推送', changed: true, localN: 1, remoteN: 2, afterN: 2, localHash: 'abcdef0123456789', remoteHash: 'ffeeddccbbaa9988', afterHash: 'abcdef0123456789', note: '冒烟' });
    const list = globalThis.FTT.syncLog();
    const r = await entry.popupAction('settingsSub', { sub: 'storage' });
    const html = String(r.html || '');
    const ok = list.length === 1 && list[0].action === '冒烟记录' && String(list[0].src || '').length > 0
        && html.indexOf('冒烟记录') >= 0 && html.indexOf('本地 1 条') >= 0 && html.indexOf('→ 对端') >= 0 && html.indexOf('→ 同步后') >= 0;
    globalThis.FTT.syncLogClear();
    return ok && globalThis.FTT.syncLog().length === 0;
})(), '');

await assert('N3 立即同步（无对端）→ mode=none：写入服务端主文件 + 备份文件，并记一条同步日志', (async () => {
    // 场景前置：清空服务端用户目录文件 —— 否则前面各节的保存流水线已写出主文件，跨端对账会判定为「两端一致」而非「无对端」
    srvFiles.clear();
    const r = await globalThis.FTT.syncNow();
    const names = Array.from(srvFiles.keys());
    const log = globalThis.FTT.syncLog();
    return r.mode === 'none' && names.indexOf(syncMod.stateFileName()) >= 0 && names.indexOf(syncMod.bakFileName()) >= 0
        && log.length >= 1 && log[0].action === '手动立即同步';
})(), '');

await assert('N4 刷新状态：取服务端最新并合并 → 报告条数/快照数/是否回推；清单与快照文件随写入生成', (async () => {
    const rep = await globalThis.FTT.syncRefresh();
    // 清单是「主文件写成功后**延迟排程**上传」的（adapters/sync.js `scheduleMetaFilePush`，META_PUSH_DELAY=1200ms），
    //   故读文件列表前先等排程窗口过去
    await new Promise((r) => setTimeout(r, 1500));
    const names = Array.from(srvFiles.keys());
    return rep.err === '' && !!rep.merged && rep.merged.entries >= 0
        && names.indexOf(syncMod.metaFileName()) >= 0
        && globalThis.FTT.syncStatus().file.name === syncMod.stateFileName();
})(), '');

await assert('N5 FTT 同步调试入口齐备（syncStatus / syncInfo / syncSource / syncLogServerStatus / syncVerify）', (async () => {
    const st = globalThis.FTT.syncStatus();
    const info = globalThis.FTT.syncInfo();
    const src = globalThis.FTT.syncSource();
    const sv = globalThis.FTT.syncLogServerStatus();
    const ver = await globalThis.FTT.syncVerify();
    return !!st && st.file.name === syncMod.stateFileName() && st.snapshot.name === syncMod.snapshotFileName()
        && !!info && info.stateFile === syncMod.stateFileName() && String(src || '').length > 0
        && sv.file === syncMod.syncLogServerFile() && sv.url === '/user/files/' + syncMod.syncLogServerFile()
        && Array.isArray(ver.details) && ver.details.length >= 4;
})(), '');

await assert('N6 存储动作经面板分发可达（校验并修复 / 清空日志 / 刷新日志）且回填提示', (async () => {
    const r1 = await entry.popupAction('storageVerify', {});
    const r2 = await entry.popupAction('syncLogRefresh', {});
    const r3 = await entry.popupAction('syncLogClear', {});
    return r1.ok === true && String(r1.note || '').length > 0
        && r2.ok === true && String(r2.note || '').length > 0
        && r3.ok === true && String(r3.note || '').indexOf('清空') >= 0;
})(), '');

// ---------- O 剧情时钟域（B8-1：手工锚点 + 零 AI 时间巡检 + 总览/设定界面） ----------
await assert('O1 总览时钟区（V1 同构）：日期/时间/地点行 + 手工改写工具行 + 时间巡检状态行与按钮', (async () => {
    await entry.popupAction('tab', { tab: 'overview' });
    const r = await entry.popupAction('tab', { tab: 'overview' });
    const html = String(r.html || '');
    return html.indexOf('📅 日期：') >= 0 && html.indexOf('⏱ 时间：') >= 0 && html.indexOf('📍 地点：') >= 0
        && html.indexOf('data-ftt-action="clockEdit"') >= 0 && html.indexOf('✏️ 手工改写日期/时间/地点') >= 0
        && html.indexOf('data-ftt-clock-patrol') >= 0 && html.indexOf('data-ftt-action="clockPatrol"') >= 0;
})(), '');

await assert('O2 手工强制改写锚点：clockEdit 展开面板 → clockManualSave 写入并锁定 → clockManualClear 解锁恢复自动', (async () => {
    const open = await entry.popupAction('clockEdit', {});
    const openHtml = String((await entry.popupAction('tab', { tab: 'overview' })).html || '');
    const save = await entry.popupAction('clockManualSave', { date: '1919-12-31', time: '下午三点', location: '城市甲·码头' });
    const locked = globalThis.FTT.clockManual();
    const html2 = String((await entry.popupAction('tab', { tab: 'overview' })).html || '');
    const clr = await entry.popupAction('clockManualClear', {});
    return open.ok === true && openHtml.indexOf('data-ftt-clock-manual="date"') >= 0
        && save.ok === true && rtMod.state.state.date === '1919-12-31' && rtMod.state.state.time === '15:00'
        && !!locked && locked.lock === true && html2.indexOf('🔒 已手工锁定') >= 0
        && clr.ok === true && globalThis.FTT.clockManual() === null;
})(), '');

await assert('O3 零 AI 时间巡检 clockPatrol：修复格式非法/年份漂移的日期与时间，并在写回前留全量快照', (async () => {
    const st = rtMod.state;
    st.atoms = (st.atoms || []);
    st.atoms.push({ id: 'smoke-clock-1', text: '情节（脏日期）', title: '情节（脏日期）', date: '2011-05-06', tags: [], uses: 0, floorStart: 1, floorEnd: 2 });
    st.atoms.push({ id: 'smoke-clock-2', text: '情节（坏时间）', title: '情节（坏时间）', date: '1919-12-05', time: '25:99', tags: [], uses: 0, floorStart: 1, floorEnd: 2 });
    st.state = st.state || {};
    st.state.date = ''; st.state.clockManual = null; delete st.state.clockManual;
    const anchor = globalThis.FTT.clockAnchor();
    const rep = await globalThis.FTT.clockPatrol({ silent: true, force: true });
    const fixed = st.atoms.filter((x) => x.id === 'smoke-clock-1')[0];
    return anchor.usable === true && anchor.source === 'atoms-majority'
        && rep.found >= 2 && rep.fixed >= 2 && !!rep.snap
        && String(fixed.date).indexOf('1919-') === 0;
})(), '');

await assert('O4 设定「基础」页：V1 五分节 + 21 个控件 + 强制开关（及时分析开启 → 三项禁用）+ 时间巡检两个开关', (async () => {
    rtMod.cfg.timelyAnalysis = false;
    const r1 = await entry.popupAction('settingsSub', { sub: 'base' });
    const html = String(r1.html || '');
    rtMod.cfg.timelyAnalysis = true;
    const r2 = await entry.popupAction('settingsSub', { sub: 'base' });
    const htmlForced = String(r2.html || '');
    rtMod.cfg.timelyAnalysis = false;
    return html.indexOf('组件开关') >= 0 && html.indexOf('重要性计算（调用次数驱动）') >= 0
        && html.indexOf('剧情时钟自动提取（总览 日期/时间/地点）') >= 0 && html.indexOf('时钟降级与时间巡检（总览）') >= 0
        && html.indexOf('界面特效') >= 0 && html.indexOf('data-ftt-cfg="clockAutoPatrol"') >= 0
        && html.indexOf('data-ftt-cfg="clockPatrolAutoFix"') >= 0 && html.indexOf('data-ftt-cfg="clockRegexPreset"') >= 0
        && html.indexOf('data-ftt-cfg="enabled"') >= 0 && html.indexOf('data-ftt-cfg="uiEffects"') >= 0
        && (htmlForced.match(/disabled/g) || []).length === 3;
})(), '');

assert('O5 FTT 时钟调试入口齐备（clockUi / clockAnchor / clockMajority / clockScan / clockPatrolState / clockManualSet）', (() => {
    const F = globalThis.FTT;
    const ui = F.clockUi();
    const scan = F.clockScan();
    const maj = F.clockMajority();
    const pst = F.clockPatrolState();
    return !!ui && !!ui.patrol && !!scan && Array.isArray(scan.findings) && !!maj
        && !!pst && typeof pst.scanned === 'number' && typeof F.clockManualSet === 'function' && typeof F.clockPatrolAuto === 'function';
})(), '');

// ---------- P 剧情时钟自动提取（B8-2：正文头 / 正则 / 多源择优 / 降级 / 楼层窗口回退） ----------
const HEADER_FLOOR = '▷0051年1月2日（东汉建武二十七年）·冬(死寂的长街，高耸的阴影)\n▷凉州卫-中央大街-钟鼓楼下\n▶第17602天 08:52->09:05(慵懒的漫步与崩溃的余波)';

assert('P1 FTT.clockHeader / clockResolve：正文头结构解析（日期/纪年/季节/地点路径/第 N 天/时间区间/状态）与多源择优', (() => {
    const hdr = globalThis.FTT.clockHeader(HEADER_FLOOR);
    const mark = globalThis.FTT.clockExtractText('【日期：1919-11-29】\n时间：18:30\n地点：城市甲·码头', {});
    const plain = globalThis.FTT.clockExtractText('1919年11月29日，傍晚。角色甲走进码头。', {});
    const rel = globalThis.FTT.clockExtractText('次日清晨出发。', { date: '1919-11-29' });
    const res = globalThis.FTT.clockResolve({ text: '1919年11月29日，傍晚。角色甲走进码头。' });
    return hdr.date === '0051-01-02' && hdr.era === '东汉建武二十七年' && hdr.season === '冬'
        && hdr.location === '凉州卫-中央大街-钟鼓楼下' && hdr.storyDay === 17602 && hdr.time === '08:52' && hdr.timeEnd === '09:05'
        && mark.date === '1919-11-29' && mark.time === '18:30' && mark.location === '城市甲·码头'
        && mark.source.location === 'marker'
        && plain.date === '1919-11-29' && plain.time === '傍晚' && plain.source.time === 'daypart' && plain.location === null
        && rel.date === '1919-11-30' && rel.source.date === 'relative'
        && !!res && String(res.source.date).length > 0 && String(res.source.present).length > 0;
})(), '');

assert('P2 FTT.clockExtractOnce：解析结果落盘（日期/时间/地点 + 正文头附加字段 + clockSrc 来源 + 在场）', (() => {
    const ok = globalThis.FTT.clockExtractOnce({ text: HEADER_FLOOR, force: true });
    const st = rtMod.state.state;
    const res = globalThis.FTT.clockExtractState();
    return ok === true && !!res && !!st.clockSrc && st.storyDay === 17602 && st.timeEnd === '09:05'
        && st.era === '东汉建武二十七年' && st.season === '冬'
        && String(st.location || '').length > 0 && String(st.date || '').length >= 10
        && res.header === true && res.textMode === 'given';
})(), '');

assert('P3 楼层窗口回退：无显式正文时用「最近 N 楼」文本提取（内核经宿主注入取文，不直读聊天）', (() => {
    host.ctx.chat.push({ is_user: false, mes: '▷1919年12月9日·冬(码头)\n▷城市壬-港口\n▶第7天 07:00->07:30(出发)', name: '角色甲' });
    rtMod.setLastMessageId(host.ctx.chat.length - 1);
    const res = globalThis.FTT.clockResolve();
    return res.date === '1919-12-09' && res.location === '城市壬-港口' && res.time === '07:00' && res.timeEnd === '07:30';
})(), '');

await assert('P4 自动提取调度：消息事件到达 → 1.8s 防抖后自动落盘（cfg.clockExtractEnabled 控制；关掉不排程）', (async () => {
    rtMod.cfg.clockExtractEnabled = true;
    rtMod.state.state.date = ''; rtMod.state.state.time = ''; rtMod.state.state.location = '';
    delete rtMod.state.state.clockSrc;
    host.ctx.chat.push({ is_user: false, mes: '▷1919年12月11日·冬(港口)\n▷城市癸-广场\n▶第9天 06:00->06:30(出发)', name: '角色甲' });
    rtMod.setLastMessageId(host.ctx.chat.length - 1);
    host.emit('CHARACTER_MESSAGE_RENDERED', host.ctx.chat.length - 1);
    await new Promise((r) => setTimeout(r, 2100));
    const got = { date: rtMod.state.state.date, time: rtMod.state.state.time, location: rtMod.state.state.location };
    const mode = (globalThis.FTT.clockExtractState() || {}).textMode;
    rtMod.cfg.clockExtractEnabled = false;
    const off = globalThis.FTT.clockExtractSchedule();
    rtMod.cfg.clockExtractEnabled = true;
    return got.date === '1919-12-11' && got.time === '06:00' && got.location === '城市癸-广场' && mode === 'latest-ai' && off === false;
})(), '');

await assert('P5 总览时钟区显示「时钟来源」可解释行与场景兜底入口（FTT.clockScene 可用）', (async () => {
    const r = await entry.popupAction('tab', { tab: 'overview' });
    const html = String(r.html || '');
    // 剧情天数取内核当前值（P4 的「▶第9天」解析结果）；原先硬编码 17602 是「未 await → 与 P4 并发」时读到的 P1/P2 旧值
    const sd = Number((rtMod.state.state || {}).storyDay) || 0;
    return html.indexOf('data-ftt-clock-src') >= 0 && html.indexOf('🕒 时钟来源：') >= 0
        && sd > 0 && html.indexOf('📆 剧情第 ' + sd + ' 天') >= 0 && typeof globalThis.FTT.clockScene === 'function';
})(), '');

// ---------- Q 时钟域 AI 管线（B8-3：AI 捕捉正则 + AI 结合正文修复） ----------
const origGenerateRaw = host.ctx.generateRaw;
let aiReturn = '{}';
let aiCallN = 0;
host.ctx.generateRaw = async () => { aiCallN++; return aiReturn; };

await assert('Q1 基础页两条 AI 按钮与 FTT 入口齐备（V1 同名动作名 clockRegexGen / clockRepair）', (async () => {
    const r = await entry.popupAction('settingsSub', { sub: 'base' });
    const html = String(r.html || '');
    return html.indexOf('data-ftt-action="clockRegexGen"') >= 0 && html.indexOf('data-ftt-action="clockRepair"') >= 0
        && typeof globalThis.FTT.clockRegexGen === 'function' && typeof globalThis.FTT.clockRepair === 'function'
        && typeof globalThis.FTT.clockRepairPack === 'function';
})(), '');

await assert('Q2 AI 捕捉正文 → 生成正则：三条正则经三重校验后写入 cfg 并给出试算结果', (async () => {
    host.ctx.chat.push({ is_user: false, mes: '1919年12月1日 傍晚。角色甲在【地点：城市甲·码头】。', name: '角色甲' });
    rtMod.setLastMessageId(host.ctx.chat.length - 1);
    aiReturn = JSON.stringify({ '日期正则': '(\\d{4}年\\d{1,2}月\\d{1,2}日)', '时间正则': '(傍晚|清晨|深夜)', '地点正则': '【地点：([^】]+)】', '说明': '冒烟' });
    const before = aiCallN;
    const r = await globalThis.FTT.clockRegexGen({ floors: 2 });
    return r.ok === true && aiCallN > before && r.applied.length === 3 && r.hits.date >= 1 && r.hits.location >= 1
        && rtMod.cfg.clockDateRegex.indexOf('\\d{4}年') >= 0 && rtMod.cfg.clockTimeRegex.length > 0 && rtMod.cfg.clockLocationRegex.indexOf('地点') >= 0
        && !!r.probe;
})(), '');

await assert('Q3 AI 结合正文修复日期时间：只改日期/时间字段，其余字段不动；无可信锚点时拒绝且不调用 AI', (async () => {
    const st = rtMod.state;
    st.atoms = st.atoms || [];
    st.atoms.push({ id: 'smoke-ai-1', text: '情节（年份漂移）', title: '情节（年份漂移）', date: '2011-05-06', tags: [], uses: 0, floorStart: 1, floorEnd: 2 });
    st.state = st.state || {}; st.state.date = ''; delete st.state.clockManual;
    aiReturn = JSON.stringify({ '修正': [{ '编号': 1, '日期': '1919-12-01', '依据': '正文为 1919 年' }] });
    const r = await globalThis.FTT.clockRepair({ silent: true });
    const fixed = st.atoms.filter((x) => x.id === 'smoke-ai-1')[0];
    // 无可信锚点场景：清空全部有效日期 → 拒绝且不调用 AI
    const keepAtoms = st.atoms;
    st.atoms = [{ id: 'smoke-ai-2', text: '坏日期', title: '坏日期', date: '不是日期', tags: [], uses: 0, floorStart: 1, floorEnd: 2 }];
    const before = aiCallN;
    const r2 = await globalThis.FTT.clockRepair({ silent: true });
    st.atoms = keepAtoms;
    return r.made >= 1 && fixed.date === '1919-12-01' && fixed.text === '情节（年份漂移）'
        && r2.noAnchor === true && aiCallN === before;
})(), '');

await assert('Q4 面板动作可达：clockRegexGen / clockRepair 经动作分发执行并回填提示', (async () => {
    // 场景前置：clockRegexGen 需要 AI 返回「日期/时间/地点正则」契约（原场景沿用 Q3 的修复 payload → 采用 0 条 → ok:false）
    aiReturn = JSON.stringify({ '日期正则': '(\\d{4}年\\d{1,2}月\\d{1,2}日)', '时间正则': '(傍晚|清晨|深夜)', '地点正则': '【地点：([^】]+)】', '说明': '冒烟' });
    const r1 = await entry.popupAction('clockRegexGen', {});
    const st = rtMod.state;
    st.atoms = st.atoms || [];
    st.atoms.push({ id: 'smoke-ai-3', text: '情节三', title: '情节三', date: '2011-01-01', tags: [], uses: 0, floorStart: 1, floorEnd: 2 });
    aiReturn = JSON.stringify({ '修正': [{ '编号': 1, '日期': '1919-12-02' }] });
    const r2 = await entry.popupAction('clockRepair', {});
    return r1.ok === true && String(r1.note).indexOf('AI 捕捉正则') >= 0 && String(r2.note).indexOf('日期时间修复') >= 0;
})(), '');

host.ctx.generateRaw = origGenerateRaw;

// ---------- R 内容弱化（B8-4：词条库 + 固定规则转化库 + AI 弱化） ----------
const origGen2 = host.ctx.generateRaw;
let aiSoft = '{}';
host.ctx.generateRaw = async () => aiSoft;

await assert('R1 设定「内容弱化」页：V1 四节 + 词条库/转化库编辑器 + 状态行与动作按钮齐备', (async () => {
    const r = await entry.popupAction('settingsSub', { sub: 'safety' });
    const html = String(r.html || '');
    return html.indexOf('内容弱化（NSFW）') >= 0 && html.indexOf('固定规则替换（不调用 AI 的机械转化）') >= 0
        && html.indexOf('转化库（匹配词 → 转化词，可在设定中管理）') >= 0 && html.indexOf('识别词条库（用于匹配需弱化的内容）') >= 0
        && html.indexOf('data-ftt-action="nsfwSoften"') >= 0 && html.indexOf('data-ftt-action="nsfwRuleApply"') >= 0
        && html.indexOf('data-ftt-nsfw-kw-new') >= 0 && html.indexOf('data-ftt-nsfw-rule-new-from') >= 0
        && html.indexOf('data-ftt-nsfw-state') >= 0;
})(), '');

await assert('R2 固定规则替换（零 AI）：nsfwRuleApply 机械转化命中词并落库（同时刷新 updatedAt）', (async () => {
    const st = rtMod.state;
    st.atoms = st.atoms || [];
    st.atoms.push({ id: 'smoke-nsfw-1', text: '两人做爱后相拥，她发出呻吟。', title: '两人做爱后相拥，她发出呻吟。', tags: [], uses: 0, floorStart: 1, floorEnd: 2 });
    const before = Number(host.ctx.generateRaw.calls || 0);
    const r = await entry.popupAction('nsfwRuleApply', {});
    const it = st.atoms.filter((x) => x.id === 'smoke-nsfw-1')[0];
    return r.ok === true && String(it.text).indexOf('做爱') < 0 && String(it.text).indexOf('亲近') >= 0
        // 内置转化库：'呻吟' → '低吟'（core/nsfw.js NSFW_REPLACE_PAIRS）；原断言写「低声」是实现里不存在的转化词
        && String(it.title).indexOf('低吟') >= 0 && Number(it.updatedAt) > 0 && String(r.note).indexOf('固定规则替换完成') >= 0;
})(), '');

await assert('R3 AI 弱化：nsfwSoften 交 AI 逐条改写，含关键词的结果被丢弃、合格结果落库（镜像字段同步）', (async () => {
    const st = rtMod.state;
    const raw = '他在调教中失控，淫水顺着大腿流下。';
    // 原子情节的镜像字段是 text ↔ content（core/nsfw.js nsfwMirrorKey），置同值以验证镜像同步
    st.atoms.push({ id: 'smoke-nsfw-2', text: raw, content: raw, title: raw, tags: [], uses: 0, floorStart: 1, floorEnd: 2 });
    rtMod.cfg.nsfwReplaceAuto = false;
    // 提交清单按「命中数降序」（同命中保持字段序 title → text；text 与 content 同值只收一次）。
    //   必须按真实扫描结果定位 text 字段的编号：原场景硬编码「编号1」实际落在 title 上 → text 从未被弱化。
    const scan = globalThis.FTT.nsfwScan({}).items;
    const nText = scan.findIndex((x) => x.dim === 'atoms' && x.id === 'smoke-nsfw-2' && x.path === 'text') + 1;
    const nOther = scan.findIndex((x) => !(x.dim === 'atoms' && x.id === 'smoke-nsfw-2' && x.path === 'text')) + 1;
    aiSoft = JSON.stringify({ '弱化': [
        { '编号': nText, '文本': '他情绪失控，气息紊乱。', '说明': '留白' },      // 合格结果 → 落库（并镜像 content）
        { '编号': nOther, '文本': '仍在描写做爱的细节。' },                        // 仍含关键词 → 必被丢弃
    ], '无法处理': [] });
    const r = await globalThis.FTT.nsfwSoften({ silent: true });
    const it = st.atoms.filter((x) => x.id === 'smoke-nsfw-2')[0];
    rtMod.cfg.nsfwReplaceAuto = true;
    return nText >= 1 && r.applied >= 1 && r.skipped >= 1
        && String(it.text).indexOf('调教') < 0 && String(it.content).indexOf('调教') < 0;
})(), '');

assert('R4 词条库/转化库动作与 FTT 调试入口齐备（nsfwKeywordAdd / nsfwRuleAdd / nsfwState / nsfwApply）', (() => {
    const F = globalThis.FTT;
    const kw0 = F.nsfwKeywords().length;
    const add = F.nsfwKeywordAdd('冒烟测试词');
    const kw1 = F.nsfwKeywords().length;
    const del = F.nsfwKeywordDelete(kw1 - 1);
    F.nsfwKeywordReset();
    const st = F.nsfwState();
    const apply = F.nsfwApply('他插入');
    return add.ok === true && kw1 === kw0 + 1 && del.ok === true && !!st && st.keywords === 63
        && apply.text === '他进入' && Array.isArray(F.nsfwRules()) && typeof F.nsfwScan === 'function' && typeof F.nsfwHits === 'function';
})(), '');

await assert('R5 分析侧开关：开启后总览显示「🌶 内容弱化」状态行，且 /ftt 与调试导出可读开关态', (async () => {
    rtMod.cfg.nsfwSoftenEnabled = true;
    const r = await entry.popupAction('tab', { tab: 'overview' });
    const html = String(r.html || '');
    const ok = html.indexOf('data-ftt-action="nsfwSoften"') >= 0 && html.indexOf('data-ftt-nsfw-state') >= 0
        && html.indexOf('🌶 内容弱化：分析侧开关') >= 0 && globalThis.FTT.nsfwState().enabled === true;
    rtMod.cfg.nsfwSoftenEnabled = false;
    return ok;
})(), '');

host.ctx.generateRaw = origGen2;

let S3_DBG = null;
// ---------- S 遗忘域（B8-5：状态衰退 / 记忆遗忘 / 通用遗忘清扫） ----------
await assert('S1 遗忘设定页：V1 五分节 + 3 个开关 + 只读诊断行（条数/上限/保底/冷却）', (async () => {
    const r = await entry.popupAction('settingsSub', { sub: 'forget' });
    const html = String(r.html || '');
    return html.indexOf('状态记录衰退（只按剧情日期）') >= 0 && html.indexOf('记忆遗忘机制（只按剧情日期）') >= 0
        && html.indexOf('存储保底 / 上限') >= 0 && html.indexOf('通用遗忘清扫（概念 / 场景 / 名册 / 计划 / 悬念 / 角色档案）') >= 0
        && html.indexOf('data-ftt-cfg="stateDecayEnabled"') >= 0 && html.indexOf('data-ftt-cfg="memoryForgetEnabled"') >= 0
        && html.indexOf('data-ftt-cfg="lowUseForgetEnabled"') >= 0 && html.indexOf('data-ftt-forget-state') >= 0;
})(), '');

await assert('S2 记忆遗忘：低重要度旧记忆被移除并留下 id 墓碑（跨端不复活）；无剧情时钟时不清理', (async () => {
    const st = rtMod.state;
    const mem = (id, date, imp) => ({ id, title: '记忆' + id, content: '内容' + id, date, importance: imp, uses: 1, floorStart: 1, floorEnd: 2, tags: [] });
    st.memories = [mem('sm-a', '2001-01-01', 0.1), mem('sm-b', '2002-01-01', 0.2), mem('sm-c', '2019-12-31', 0.9), mem('sm-d', '2019-12-30', 0.8)];
    st.deleted = {}; st.deletedH = {};                 // 场景卫生：墓碑容器只保留本节产物（否则前面导入遗留的墓碑会污染「恰为 sm-a,sm-b」）
    st.state.date = '2020-01-01';
    rtMod.cfg.memoryForgetEnabled = true; rtMod.cfg.memoryForgetCutoff = 0.9; rtMod.cfg.memoryForgetRatio = 0.5; rtMod.cfg.storeMinMemories = 2;
    rtMod.setLastMessageId(10);
    const r = await globalThis.FTT.memoryForget({});
    const ids = (st.memories || []).map((x) => x.id).join(',');
    const tombs = Object.keys((st.deleted || {}).memories || {}).sort().join(',');
    st.state.date = '';
    const r2 = await globalThis.FTT.memoryForget({});
    st.state.date = '2020-01-01';
    return r.removed === 2 && ids === 'sm-c,sm-d' && tombs === 'sm-a,sm-b' && r2.reason === 'no-story-clock';
})(), '');

assert('S3 通用遗忘清扫：达门槛的低使用极旧条目被清扫（每维度 1 条 + 冷却闸门 + 墓碑），并受保底保护', (() => {
    const st = rtMod.state;
    const ent = (id, extra) => Object.assign({ id, name: id, title: id, uses: 6, importance: 0.1, floorStart: 1, floorEnd: 1 }, extra || {});
    st.concepts = [];
    for (let i = 0; i < 25; i++) st.concepts.push(ent('sc' + i, { uses: i < 3 ? 0 : 6 }));
    st.lowUseForget = {};
    rtMod.cfg.lowUseForgetEnabled = true; rtMod.cfg.lowUseForgetEveryFloors = 40; rtMod.cfg.lowUseForgetMinItems = 20;
    rtMod.cfg.lowUseForgetMinAvg = 5; rtMod.cfg.lowUseForgetMinFloors = 300; rtMod.cfg.lowUseForgetMaxDelete = 1;
    rtMod.cfg.lowUseForgetProtectImportance = 0.7; rtMod.cfg.storeMinConcepts = 0;
    rtMod.setLastMessageId(400);
    const sw = globalThis.FTT.lowUseSweep({ dims: ['concepts'] });
    const after = (st.concepts || []).length;
    const tombs = Object.keys((st.deleted || {}).concepts || {}).length;
    const sw2 = globalThis.FTT.lowUseSweep({ dims: ['concepts'] });
    rtMod.cfg.storeMinConcepts = after;
    st.lowUseForget = {};                       // 清掉冷却标记，单独验证「保底不跌破」
    const sw3 = globalThis.FTT.lowUseSweep({ dims: ['concepts'] });
    rtMod.cfg.storeMinConcepts = 0;
    S3_DBG = { swept: sw.swept, after: after, tombs: tombs, dims: sw.dims, skipped: sw.skipped, skipped2: sw2.skipped, skipped3: sw3.skipped, avg: sw.avg, candidates: sw.candidates };
    return sw.swept === 1 && after === 24 && tombs >= 1 && (sw.dims.concepts || {}).removed === 1
        && sw2.skipped.indexOf('cooldown') >= 0 && sw3.skipped.indexOf('concepts:at-floor') >= 0;
})(), (() => S3_DBG)());

await assert('S4 状态衰退与遗忘汇总入口：FTT.stateDecay / forgetState / forforeachRunAll 齐备且可运行', (async () => {
    const st = rtMod.state;
    st.state.date = '2020-01-01';
    st.currentStates = [];
    for (let i = 0; i < 40; i++) st.currentStates.push({ id: 'sst' + i, subject: '角色' + i, field: '状态', value: 'v' + i, date: '2001-01-01', uses: 1, updatedAt: 0 });
    rtMod.setLastMessageId(20);
    const decay = await globalThis.FTT.stateDecay({ force: true });
    const state = globalThis.FTT.forgetState();
    const all = await globalThis.FTT.forgetRunAll({});
    return typeof decay.removed === 'number' && !!state && !!state.memoryForget && !!state.lowUse
        && Array.isArray(state.lowUse.dims) && state.lowUse.dims.length === 6
        && !!all.decay && !!all.forget && !!all.sweep && !!all.caps;
})(), '');

// ---------- T 修复管线第 1 段（B8-6a：JS 机械清理，零 AI） ----------
await assert('T1 总览工具行含 V1 同款「🛠 自动修复」按钮（紧贴「⚡ 立即 AI 摘要」右侧）', (async () => {
    const r = await entry.popupAction('tab', { tab: 'overview' });
    const html = String(r.html || '');
    const a = html.indexOf('data-ftt-action="summary"');
    const b = html.indexOf('data-ftt-action="repair"');
    const c = html.indexOf('data-ftt-action="extractNow"');
    return a >= 0 && b > a && c > b && html.indexOf('🛠 自动修复') >= 0;
})(), '');

await assert('T2 点击「自动修复」：机械清理生效（同内容合并 + 垃圾清理 + 墓碑），提示如实回报机械段与 AI 段（B8-6b 已实现 AI 段）', (async () => {
    const st = rtMod.state;
    st.atoms = st.atoms || [];
    st.atoms.push({ id: 'smoke-rp-1', text: '两人在码头交接货物。', title: '两人在码头交接货物。', date: '2020-01-01', tags: ['甲'], uses: 1, floorStart: 1, floorEnd: 2 });
    st.atoms.push({ id: 'smoke-rp-2', text: '两人在码头交接货物。', title: '两人在码头交接货物。', date: '2020-01-01', tags: ['甲'], uses: 1, floorStart: 1, floorEnd: 2 });
    st.atoms.push({ id: 'smoke-rp-3', text: '占位', title: '占位', date: '2020-01-01', tags: [], uses: 1, floorStart: 1, floorEnd: 2 });
    const n0 = st.atoms.length;
    rtMod.cfg.repairAutoAi = true;
    const r = await entry.popupAction('repair', {});
    const n1 = (st.atoms || []).length;
    const tombs = Object.keys((st.deleted || {}).atoms || {});
    // 面板动作返回结构为 { ok, action, repair: runRepair 结果, made, html, state }（ui/panel.js 'repair' 分支）：
    //   机械段在 repair.mech / repair.stage1，报告在 repair.report；顶层没有 mech / aiPending 字段（旧断言写法已过期）
    const note = String((r.state || {}).note || '');
    return r.ok === true && !!r.repair && !!r.repair.mech && typeof r.repair.aiUsed === 'boolean'
        && Number(r.repair.stage1 && r.repair.stage1.merged) >= 1        // 同内容合并
        && n1 < n0 && tombs.indexOf('smoke-rp-3') >= 0
        && String(r.repair.report).indexOf('修复前') >= 0
        && note.indexOf('自动修复：机械清理：') >= 0
        && (note.indexOf('AI 修订') >= 0 || note.indexOf('未调用 AI') >= 0);   // 第 2/3 段如实回报（用了 / 未用）
})(), '');

assert('T3 FTT 修复入口齐备（repairMech / repairDedupe / repairPrune / repairDecay / repairGateTake / latestFloorHash / repairLog）', (() => {
    const F = globalThis.FTT;
    const total = F.repairTotal();
    const gate = F.repairGateTake(true);
    const hash = F.latestFloorHash();
    const log = F.repairLog();
    return typeof total === 'number' && gate && gate.allowed === true && typeof hash === 'string'
        && Array.isArray(log) && typeof F.repairIsGarbage === 'function' && F.repairIsGarbage('占位', 4) === true
        && typeof F.repairBanned === 'function' && F.repairBanned('尽量完成').length === 1
        && typeof F.repairMech === 'function' && typeof F.repairDedupe === 'function'
        && typeof F.repairPrune === 'function' && typeof F.repairDecay === 'function';
})(), '');

// ---------- U 修复管线第 2/3 段（B8-6b：候选筛选 + 窄契约 AI 修订） ----------
const origGen3 = host.ctx.generateRaw;
let repAi = '{}';
let repAiCalls = 0;
host.ctx.generateRaw = async () => { repAiCalls++; return repAi; };

await assert('U1 三段式「自动修复」：机械清理 → 候选筛选 → AI 修订（修订/删除落库），并在提示里回报候选构成', (async () => {
    const st = rtMod.state;
    const a = (id, text, tags, date) => ({ id, text, title: text, date: date || '2020-01-01', tags, uses: 1, floorStart: 1, floorEnd: 2 });
    st.atoms = [
        a('smoke-rp-a1', '角色甲在码头交接货物，收下银两。', ['甲', '码头', '货物']),
        a('smoke-rp-a2', '甲在码头把货物交给乙，收取银两。', ['甲', '码头', '货物']),
        a('smoke-rp-a3', '角色丙前往城市丁采购。', ['丙', '城市丁', '采购'], '2020/01/03'),
    ];
    st.memories = [];
    rtMod.cfg.repairAutoAi = true; rtMod.cfg.repairMaxItems = 20; rtMod.cfg.autoRepairEveryOps = 0; rtMod.cfg.maxAutoRepairRounds = 3;
    rtMod.cfg.repairTagSimHigh = 0.5; rtMod.cfg.repairTagSimLow = 0.15; rtMod.cfg.repairMinCandidates = 5;
    repAi = JSON.stringify({ '修订': [{ '编号': 1, '字段': '内容', '值': '角色甲在码头交接货物并收下银两与契约。' }], '删除': [3] });
    const before = repAiCalls;
    const r = await entry.popupAction('repair', {});
    const a1 = st.atoms.filter((x) => x.id === 'smoke-rp-a1')[0];
    const gone = st.atoms.filter((x) => x.id === 'smoke-rp-a3').length === 0;
    const tombs = Object.keys((st.deleted || {}).atoms || {});
    return r.ok === true && !!r.repair && r.repair.aiUsed === true && repAiCalls > before
        && String(a1.text).indexOf('契约') >= 0 && gone && tombs.indexOf('smoke-rp-a3') >= 0
        && Number(r.repair.cands.length) >= 1 && String((r.state || {}).note).indexOf('候选 ') >= 0;   // 面板提示在 state.note
})(), '');

await assert('U2 repairAutoAi 关闭：自动路径零 AI 调用（只做机械清理，V1 语义）；手动路径仍可调用 AI', (async () => {
    rtMod.cfg.repairAutoAi = false; rtMod.cfg.autoRepairEveryOps = 0;
    const before = repAiCalls;
    const auto = await globalThis.FTT.repair({ silent: true, cause: '冒烟自动' });
    const afterAuto = repAiCalls;
    const manual = await globalThis.FTT.repair({ cause: '冒烟手动' });
    rtMod.cfg.repairAutoAi = true;
    return auto.aiUsed === false && afterAuto === before && manual.aiUsed === true && repAiCalls === before + 1;
})(), '');

assert('U3 FTT 修复第 2/3 段入口齐备（repair / repairCandidates / repairPrompt / repairApply / repairDefect / repairCorr / repairFailArmed）', (() => {
    const F = globalThis.FTT;
    const cands = F.repairCandidates(10, {});
    const d = F.repairDefect('atoms', { id: 'x', text: '尽量完成', date: '2020-01-01', tags: ['a', 'b', 'c'] });
    const corr = F.repairCorr('atoms', [{ id: 'x', text: '甲乙', tags: ['a', 'b'] }, { id: 'y', text: '甲乙', tags: ['a', 'b'] }]);
    const tags = F.repairTags({ tags: ['#甲', '乙'] });     // V1 `repairTagSetOf` 按「单条」取标签集合
    const jc = F.repairJaccard(['甲'], ['甲', '乙']);
    return Array.isArray(cands) && !!d && d.rank === 3 && !!corr && Array.isArray(corr.sims)
        && tags.join(',') === '甲,乙' && jc > 0 && typeof F.repair === 'function' && typeof F.repairPrompt === 'function'
        && typeof F.repairApply === 'function' && typeof F.repairFailArmed === 'function';
})(), '');

assert('U4 提取合并失败自动修复排程：开关关闭不排程，开启后按延迟排程一次（防重复）', (() => {
    rtMod.cfg.autoRepairOnMergeFail = false;
    const off = globalThis.FTT.repairFailArmed();
    rtMod.cfg.autoRepairOnMergeFail = true; rtMod.cfg.repairFailDelaySec = 15;
    const on = globalThis.FTT.repairFailArmed();
    const again = globalThis.FTT.repairFailArmed();
    rtMod.cfg.autoRepairOnMergeFail = false;
    return off === false && on === true && again === false;
})(), '');

host.ctx.generateRaw = origGen3;

// ---------- V 关联层机械维护（B8-6b+：修复第 1 段收尾 + AI 修订后复检） ----------
assert('V1 关联维护（keep）：孤儿关联行清扫 + 同 (维度,条目,角色) 去重合并 + 非法值归一，清理行写墓碑', (() => {
    const F = globalThis.FTT;
    const st = rtMod.state;
    st.snapshots = [{ id: 'smoke-rm-k1', name: '角色甲', appearance: '灰袍', tags: [], uses: 1, floorStart: 1, floorEnd: 2 }];
    st.memories = [
        { id: 'smoke-rm-m1', title: '记忆一', content: '角色甲在码头交接。', date: '2020-01-01', importance: 0.6, uses: 1, floorStart: 1, floorEnd: 2, tags: [] },
        { id: 'smoke-rm-m2', title: '记忆二', content: '角色乙在仓库等待。', date: '2020-01-02', importance: 0.5, uses: 1, floorStart: 2, floorEnd: 3, tags: [] },
    ];
    ['atoms', 'plans', 'suspense', 'scenes', 'items', 'concepts', 'npcs', 'parallels', 'currentStates'].forEach((d) => { st[d] = []; });
    st.deleted = {}; st.deletedH = {};
    st.links = [
        { id: 'smoke-rm-gone', dim: 'memories', refId: 'm-none', who: '角色丙', how: 'witness', deviation: 'unknown', uses: 1, updatedAt: 1000 },
        { id: 'smoke-rm-a', dim: 'memories', refId: 'smoke-rm-m1', who: '角色甲', how: 'told', deviation: 'unknown', uses: 1, updatedAt: 1000 },
        { id: 'smoke-rm-b', dim: 'memories', refId: 'smoke-rm-m1', who: '角色甲', how: 'participant', deviation: 'exact', note: '合并备注', public: true, uses: 3, updatedAt: 2000 },
        { id: 'smoke-rm-m2r', dim: 'memories', refId: 'smoke-rm-m2', who: '角色乙', how: '乱写', deviation: '乱写', uses: 1, updatedAt: 1500 },
    ];
    rtMod.cfg.relLinkEnabled = true; rtMod.cfg.relOrphanAction = 'keep';
    const m = F.relMaint();
    const counts = F.relMaintCounts(m);
    const rows = (st.links || []).filter((x) => x.dim === 'memories' && x.refId === 'smoke-rm-m1');
    const r2 = (st.links || []).filter((x) => x.refId === 'smoke-rm-m2')[0] || {};
    const tombs = Object.keys((st.deleted || {}).links || {});
    return F.relMaintTouched(m) === true && counts.swept === 1 && counts.deduped === 1 && counts.normalized === 2
        && String(F.relMaintSummary(m)).indexOf('清理孤儿关联 1 行') >= 0
        && rows.length === 1 && rows[0].how === 'participant' && rows[0].public === true && rows[0].note === '合并备注'
        && r2.how !== '乱写' && r2.deviation === 'unknown'
        && tombs.indexOf('smoke-rm-gone') >= 0 && tombs.indexOf('smoke-rm-a') >= 0
        && typeof F.mergeRelMaint === 'function' && typeof F.demoteRelLinkOrphans === 'function' && F.relMaintCounts(null) === null;
})(), '');

assert('V2 孤儿条目转公开（public）：按维度补公开锚行（kind 按维度、note 标注来源），平行事件恒不参与', (() => {
    const F = globalThis.FTT;
    const st = rtMod.state;
    st.suspense = [{ id: 'smoke-rm-u1', title: '悬念一', content: '谁在跟踪？', status: 'open', tags: [], uses: 1, floorStart: 1, floorEnd: 2 }];
    st.parallels = [{ id: 'smoke-rm-p1', text: '平行线一', title: '平行线一', date: '2020-01-01', tags: [], uses: 1, floorStart: 1, floorEnd: 2 }];
    st.links = [];
    rtMod.cfg.relOrphanAction = 'public';
    const m = F.relMaint();
    const anchors = (st.links || []).filter((x) => x && x.public && !x.who).map((x) => [x.dim, x.refId, x.kind || '', x.note || '']);
    const hasU = anchors.filter((x) => x[0] === 'suspense' && x[1] === 'smoke-rm-u1' && x[2] === 'suspense' && x[3] === '孤儿条目转公开（修复）').length === 1;
    const hasP = anchors.filter((x) => x[0] === 'parallels').length > 0;
    const p1 = (st.links || []).filter((x) => x.dim === 'parallels' && x.refId === 'smoke-rm-p1');
    rtMod.cfg.relOrphanAction = 'keep';
    return m.publicized >= 1 && m.changed === true && hasU && !hasP && p1.length === 0;
})(), '');

await assert('V3 面板「自动修复」联动：孤儿关联行被清扫并写墓碑，报告里回报「关联维护」摘要', (async () => {
    const st = rtMod.state;
    st.atoms = [];
    st.memories = [{ id: 'smoke-rm-e1', title: '记忆一', content: '角色甲在码头交接。', date: '2020-01-01', importance: 0.6, uses: 1, floorStart: 1, floorEnd: 2, tags: [] }];
    st.links = [{ id: 'smoke-rm-e-gone', dim: 'memories', refId: 'm-none', who: '角色丁', how: 'witness', deviation: 'unknown', uses: 1, updatedAt: 1000 }];
    st.deleted = {}; st.deletedH = {};
    rtMod.cfg.relLinkEnabled = true; rtMod.cfg.relOrphanAction = 'keep'; rtMod.cfg.repairAutoAi = true;
    const r = await entry.popupAction('repair', {});
    const note = String((r.state || {}).note || '');      // 面板提示在 state.note（r.note 恒 undefined）
    const tombs = Object.keys((st.deleted || {}).links || {});
    return r.ok === true && tombs.indexOf('smoke-rm-e-gone') >= 0
        && (st.links || []).every((x) => x.refId !== 'm-none')
        && note.indexOf('关联维护：清理孤儿关联 1 行') >= 0;
})(), '');

assert('V4 FTT 关联维护入口齐备（relMaint / relMaintCounts / relMaintSummary / relMaintTouched / mergeRelMaint / demoteRelLinkOrphans）', (() => {
    const F = globalThis.FTT;
    const a = { action: 'keep', swept: 1, deduped: 0, renamed: 0, staleRefs: 2, normalized: 0, demoted: 1, orphanItems: 3, publicized: 0, changed: true };
    const b = { action: 'keep', swept: 0, deduped: 1, renamed: 2, staleRefs: 0, normalized: 1, demoted: 0, orphanItems: 1, publicized: 1, changed: true };
    const mrg = F.mergeRelMaint(a, b);
    const dm = F.demoteRelLinkOrphans();
    return F.relMaintCounts(null) === null && F.relMaintTouched(a) === true && F.relMaintTouched({}) === false
        && Number(mrg.swept) === 1 && Number(mrg.renamed) === 2 && Number(mrg.publicized) === 1
        && String(F.relMaintSummary(mrg)).indexOf('角色名归一 2 处') >= 0
        && !!dm && typeof dm.demoted === 'number';
})(), '');

// ---------- W 相关组聚类修复 + 记忆修复管道（B8-6c-1：机械去重 → 关系维护 → 聚类选组 → AI → 应用 → 复检） ----------
assert('W1 FTT 聚类修复入口齐备（groupSpecs / groupSpec / groupRelatedness / groupClusters / groupPick / memoryMergeExact / memoryRepairPrompt / memoryRepairApply / memoryRepair / retargetRelRefs）', (() => {
    const F = globalThis.FTT;
    const specs = F.groupSpecs();
    const spec = F.groupSpec('memories');
    const st = rtMod.state;
    st.memories = [
        { id: 'smoke-gpr-1', owner: '角色甲', title: '码头交接', content: '角色甲在码头交接货物。', date: '2020-01-01', memCategory: '交易', importance: 0.6, tags: ['码头', '交接', '货物'], uses: 1, floorStart: 1, floorEnd: 2 },
        { id: 'smoke-gpr-2', owner: '角色甲', title: '码头交货', content: '甲把货物在码头交出去。', date: '2020-01-02', memCategory: '交易', importance: 0.8, tags: ['码头', '交接', '货物'], uses: 3, floorStart: 2, floorEnd: 4 },
    ];
    st.links = [{ id: 'smoke-gpr-l1', dim: 'memories', refId: 'smoke-gpr-2', who: '角色甲', how: 'witness', deviation: 'unknown', uses: 1, updatedAt: 1000 }];
    st.repairCursor = {};
    const pick = F.groupPick(spec);
    const rel = F.groupRelatedness(spec);
    const cl = F.groupClusters(spec);
    const prompt = F.memoryRepairPrompt(pick);
    const n = F.retargetRelRefs('memories', ['smoke-gpr-2'], 'smoke-gpr-1');
    const relinked = (st.links || []).filter((x) => x && x.refId === 'smoke-gpr-1').length;
    return !!specs && !!specs.memories && spec === specs.memories
        && pick.picked === 1 && pick.total === 1 && pick.entries.length === 2
        && rel.sims.length === 2 && cl.length === 1 && cl[0].size === 2
        && Array.isArray(prompt) && prompt.length === 2 && prompt[0].role === 'system'
        && n === 1 && relinked === 1
        && typeof F.memoryMergeExact === 'function' && typeof F.memoryRepairApply === 'function'
        && typeof F.memoryRepair === 'function' && F.groupSpec('nope') === specs.concepts;
})(), '');

await assert('W2 记忆分页渲染 V1 同款「🔧 修复记忆」按钮（有记忆时显示、无记忆时隐藏）', (async () => {
    const st = rtMod.state;
    st.memories = [{ id: 'smoke-gpr-b1', owner: '角色甲', title: '码头交接', content: '角色甲在码头交接货物。', date: '2020-01-01', memCategory: '交易', importance: 0.6, tags: ['码头', '交接', '货物'], uses: 1, floorStart: 1, floorEnd: 2 }];
    const r = await entry.popupAction('tab', { tab: 'memories' });
    const html = String(r.html || '');
    const has = html.indexOf('data-ftt-action="memoryRepair"') >= 0 && html.indexOf('🔧 修复记忆') >= 0
        && html.indexOf('title="融合相似记忆并清理孤儿关联"') >= 0;
    st.memories = [];
    const r2 = await entry.popupAction('tab', { tab: 'memories' });
    const empty = String(r2.html || '');
    return has && empty.indexOf('data-ftt-action="memoryRepair"') < 0;
})(), '');

const origGenW = host.ctx.generateRaw;
let memRepAiCalls = 0;
host.ctx.generateRaw = async () => {
    memRepAiCalls++;
    return JSON.stringify({
        '合并': [{ '保留': 1, '并入': [2], '标题': '码头交接货物', '正文': '角色甲在码头交接货物并收取银两。', '日期': '2020-01-01', '分类': '交易', '标签': ['码头', '交接', '货物', '银两'] }],
        '删除': [3],
    });
};

// 历史：本节（及套件内其余 44 处）曾把 async IIFE 的 **Promise** 直接传给 `assert` 且未 `await` —— Promise 恒真 → 断言空转（假绿）。
//   B9 测试完整性专项已把断言器改为可 await，并加入「thenable 条件未被 await 则直接判失败」的永久防呆；全部调用点已补 `await assert(...)`。
//   本节由此暴露的失败已按实现真实语义修好（提示读 state.note；deleted=移除总数 2，与 V1 黄金样本一致）。详见 docs/B9-测试完整性待修.md。
await assert('W3 点击「🔧 修复记忆」端到端：机械去重/关系维护 → 聚类选组 → AI 合并+删除落库 → 关联重挂 + 墓碑 + 复检口径，提示如实回报', (async () => {
    const st = rtMod.state;
    st.memories = [
        { id: 'smoke-gp-m1', owner: '角色甲', title: '码头交接', content: '角色甲在码头交接货物。', date: '2020-01-01', memCategory: '交易', importance: 0.6, tags: ['码头', '交接', '货物'], uses: 1, floorStart: 1, floorEnd: 2 },
        { id: 'smoke-gp-m2', owner: '角色甲', title: '码头交货', content: '甲把货物在码头交出去。', date: '2020-01-02', memCategory: '交易', importance: 0.8, tags: ['码头', '交接', '货物'], uses: 3, floorStart: 2, floorEnd: 4 },
        { id: 'smoke-gp-m3', owner: '角色甲', title: '空占位', content: '待补充', date: '', memCategory: '', importance: 0.1, tags: [], uses: 0, floorStart: 5, floorEnd: 5 },
    ];
    st.links = [
        { id: 'smoke-gp-l1', dim: 'memories', refId: 'smoke-gp-m1', who: '角色甲', how: 'participant', deviation: 'unknown', uses: 2, updatedAt: 1000 },
        { id: 'smoke-gp-l2', dim: 'memories', refId: 'smoke-gp-m2', who: '角色甲', how: 'witness', deviation: 'unknown', uses: 1, updatedAt: 1000 },
        { id: 'smoke-gp-l3', dim: 'memories', refId: 'smoke-gp-m2', who: '角色乙', how: 'told', deviation: 'unknown', uses: 1, updatedAt: 1200 },
        { id: 'smoke-gp-lgone', dim: 'memories', refId: 'm-none', who: '角色丙', how: 'witness', deviation: 'unknown', uses: 1, updatedAt: 1000 },
    ];
    st.deleted = {}; st.deletedH = {}; st.repairCursor = {};
    rtMod.cfg.relLinkEnabled = true; rtMod.cfg.relOrphanAction = 'keep';
    rtMod.cfg.memoryRepairSim = 0.45; rtMod.cfg.memoryRepairMaxClusters = 3;
    rtMod.cfg.memoryRepairMaxItems = 24; rtMod.cfg.memoryRepairMaxClusterSize = 8;
    const before = memRepAiCalls;
    const r = await entry.popupAction('memoryRepair', {});
    const mr = r.memoryRepair || {};
    const m1 = (st.memories || []).filter((x) => x.id === 'smoke-gp-m1')[0] || {};
    const ids = (st.memories || []).map((x) => x.id);
    const linkRows = (st.links || []).map((x) => [x.refId, x.who, x.how]);
    const memTombs = Object.keys((st.deleted || {}).memories || {});
    const linkTombs = Object.keys((st.deleted || {}).links || {});
    const note = String((r.state || {}).note || '');      // 面板提示在 `state.note`（`r.note` 恒 undefined，曾致 W3 空转）
    return r.ok === true && r.made === 1 && memRepAiCalls === before + 1
        // V1 黄金样本（tests/fixtures/v1-golden-group-repair-flow.json）：fused 1 / removed 1 / deleted 2 ——
        //   deleted = 被移除条目总数（被并入 1 条 + AI 删除 1 条）；removed 只记「被并入」
        && mr.fused === 1 && mr.removed === 1 && mr.deleted === 2 && mr.retargeted === 1 && Number(mr.relMaint.swept) === 1
        && ids.join(',') === 'smoke-gp-m1' && m1.title === '码头交接货物' && String(m1.content).indexOf('银两') >= 0
        && Number(m1.uses) === 4 && Number(m1.floorStart) === 1 && Number(m1.floorEnd) === 4
        && linkRows.length === 2 && linkRows.every((x) => x[0] === 'smoke-gp-m1')
        && memTombs.indexOf('smoke-gp-m2') >= 0 && memTombs.indexOf('smoke-gp-m3') >= 0
        && linkTombs.indexOf('smoke-gp-lgone') >= 0
        && note.indexOf('记忆修复：') >= 0 && note.indexOf('关联重挂 1 行') >= 0;
})(), '');

host.ctx.generateRaw = origGenW;

// ---------- X 概念修复 + 场景修复（B8-6c-2） ----------
assert('X1 FTT 概念/场景修复入口齐备（conceptMergeExact / conceptRelatedness / conceptClusters / conceptPickClusters / conceptRepairPrompt / conceptRepairApply / conceptRepair / sceneRepairPrompt / sceneRepairApply / sceneRepair / scenesUnionMergeAll）', (() => {
    const F = globalThis.FTT;
    const names = ['conceptMergeExact', 'conceptRelatedness', 'conceptClusters', 'conceptPickClusters', 'conceptRepairPrompt', 'conceptRepairApply', 'conceptRepair',
        'sceneRepairPrompt', 'sceneRepairApply', 'sceneRepair', 'scenesUnionMergeAll'];
    const missing = names.filter((n) => typeof F[n] !== 'function');
    const st = rtMod.state;
    st.concepts = [
        { id: 'smoke-xr-c1', name: '天机阁', content: '情报机构。', source: '正文', date: '2020-01-01', tags: ['情报', '组织', '机构'], uses: 1 },
        { id: 'smoke-xr-c2', name: '天机阁总部', content: '情报机构总部。', source: '正文', date: '2020-01-02', tags: ['情报', '组织', '机构'], uses: 2 },
        { id: 'smoke-xr-c3', name: '待补充', content: '待补充', source: '', date: '', tags: [], uses: 0 },
    ];
    st.repairCursor = {};
    const cl = F.conceptClusters();
    const p = F.conceptPickClusters();
    const prompt = F.conceptRepairPrompt(p);
    st.scenes = [{ id: 'smoke-xr-s1', name: '纽约', pathArr: ['纽约'], pathStr: '纽约', desc: '繁华都市。', uses: 2, floorSeen: 5, tags: [] }];
    const sp = F.sceneRepairPrompt();
    const applied = F.sceneRepairApply([{ '名称': '曼哈顿', '路径': ['纽约', '曼哈顿'], '描述': '区。' }]);
    return missing.length === 0 && cl.length === 1 && cl[0].size === 2 && p.picked === 1 && p.entries.length === 3
        && Array.isArray(prompt) && prompt.length === 2 && prompt[0].role === 'system'
        && String(prompt[1].content).indexOf('【相关组 1】') >= 0 && String(prompt[1].content).indexOf('【缺陷条目') >= 0
        && Array.isArray(sp) && sp.length === 2 && String(sp[1].content).indexOf('- 纽约 ｜ 路径：纽约 ｜ 描述：繁华都市。') >= 0
        && applied.ok === true && applied.list.length === 2
        && applied.list[0].pathStr === '纽约>曼哈顿' && applied.list[1].pathStr === '纽约'
        && F.conceptRelatedness().sims.length === 3;
})(), '');

const x2 = await (async () => {
    const st = rtMod.state;
    st.concepts = [{ id: 'smoke-xb-c1', name: '天机阁', content: '情报机构。', source: '正文', date: '2020-01-01', tags: ['情报', '组织', '机构'], uses: 1 }];
    st.scenes = [{ id: 'smoke-xb-s1', name: '纽约', pathArr: ['纽约'], pathStr: '纽约', desc: '都市。', uses: 1, floorSeen: 1, tags: [] }];
    const c1 = String((await entry.popupAction('tab', { tab: 'concepts' })).html || '');
    const s1 = String((await entry.popupAction('tab', { tab: 'scenes' })).html || '');
    st.concepts = [];
    st.scenes = [];
    const c0 = String((await entry.popupAction('tab', { tab: 'concepts' })).html || '');
    const s0 = String((await entry.popupAction('tab', { tab: 'scenes' })).html || '');
    return c1.indexOf('data-ftt-action="conceptRepair"') >= 0 && c1.indexOf('🔧 修复概念') >= 0
        && c1.indexOf('title="修复概念错乱/冗余，并融合相似概念"') >= 0
        && s1.indexOf('data-ftt-action="sceneRepair"') >= 0 && s1.indexOf('🔧 修复结构/用词') >= 0
        && s1.indexOf('title="复用「立即修复」管道，修正场景树错乱的结构/用词不当"') >= 0
        && c0.indexOf('data-ftt-action="conceptRepair"') < 0          // 概念页：无概念 → 隐藏（V1 条件）
        && s0.indexOf('data-ftt-action="sceneRepair"') >= 0;          // 场景页：V1 无显隐条件（空库也显示）
})();
assert('X2 面板按钮与显隐：概念页「🔧 修复概念」（有则显 / 无则隐）+ 场景页「🔧 修复结构/用词」（V1 `scenesHtml` 恒显）', x2, '');

// X3 走真实宿主保存链路：关掉「保存后镜像」（避免镜像把本节的墓碑立即回灌到 state），
// 并在置入数据后对齐删除留痕基线（等价 V1 oracle 里的 `F.entryIndexInit()`）
const sweepMod = await import('../core/sweep.js');
rtMod.cfg.storage.syncOnSave = false;
const origGenX = host.ctx.generateRaw;
let xAiCalls = 0;
let xAiPayload = '';
host.ctx.generateRaw = async () => { xAiCalls++; return xAiPayload; };
const x3 = await (async () => {
    const st = rtMod.state;
    st.concepts = [
        { id: 'smoke-xc-1', name: '天机阁', content: '情报机构。', source: '正文', date: '2020-01-01', tags: ['情报', '组织', '机构'], uses: 1 },
        { id: 'smoke-xc-2', name: '天机阁总部', content: '情报机构总部。', source: '正文', date: '2020-01-02', tags: ['情报', '组织', '机构'], uses: 2 },
        { id: 'smoke-xc-3', name: '待补充', content: '待补充', source: '', date: '', tags: [], uses: 0 },
    ];
    st.scenes = [{ id: 'smoke-xs-1', name: '纽约', pathArr: ['纽约'], pathStr: '纽约', desc: '繁华都市。', uses: 2, floorSeen: 5, tags: [] }];
    st.repairCursor = {}; st.deleted = {}; st.deletedH = {};
    sweepMod.entryIndexInit();
    rtMod.cfg.conceptRepairSim = 0.45; rtMod.cfg.conceptRepairMaxClusters = 3;
    rtMod.cfg.conceptRepairMaxItems = 24; rtMod.cfg.conceptRepairMaxClusterSize = 8;
    // 概念：AI 合并 1←[2] + 删除 3（按编号精确应用；编号只在本批清单内有效）
    xAiPayload = JSON.stringify({
        '合并': [{ '保留': 1, '并入': [2], '名称': '天机阁', '内容': '情报机构及其总部。', '来源': '正文', '日期': '2020-01-02', '标签': ['情报', '组织', '机构', '暗线'] }],
        '删除': [3],
    });
    const beforeC = xAiCalls;
    const rc = await entry.popupAction('conceptRepair', {});
    const mr = rc.conceptRepair || {};
    const c1 = (st.concepts || []).filter((x) => x.id === 'smoke-xc-1')[0] || {};
    const cTombs = Object.keys((st.deleted || {}).concepts || {});
    const afterC = xAiCalls;
    const noteC = String((rc.state || {}).note || '');
    const p1 = afterC === beforeC + 1 && rc.ok === true && rc.made === 1
        && mr.fused === 1 && mr.removed === 1 && mr.deleted === 2 && mr.skipped === 0 && mr.groups === 1 && mr.checked === 3
        && (st.concepts || []).length === 1 && c1.uses === 3
        // V1 怪癖（黄金样本已固化）：管道对 AI 回复先做 `normalizeDeltaKeys`（「内容」→`text`），
        //   故合并后的**正文不生效**（其余字段：名称/来源/日期/标签均生效）
        && c1.content === '情报机构。' && c1.date === '2020-01-02' && (c1.tags || []).length === 4
        && cTombs.length === 2 && cTombs.indexOf('smoke-xc-2') >= 0 && cTombs.indexOf('smoke-xc-3') >= 0
        && noteC.indexOf('概念修复：') >= 0 && noteC.indexOf('高相关组 1/1 组') >= 0
        && noteC.indexOf('合并 1 组（-1 条）') >= 0;
    // 场景：AI「场景库.重建」→ 归一化/去重/补中间层 + 路径未变保留 id/uses → 并集 → 落盘
    xAiPayload = JSON.stringify({
        '场景库': { '重建': [{ '名称': '纽约', '路径': ['纽约'], '描述': '繁华都市（修正）。' }, { '名称': '曼哈顿区', '路径': ['纽约', '曼哈顿区'], '描述': '纽约的一个区。' }] },
    });
    const beforeS = xAiCalls;
    const rs = await entry.popupAction('sceneRepair', {});
    const paths = (st.scenes || []).map((x) => x.pathStr);
    const ny = (st.scenes || []).filter((x) => x.pathStr === '纽约')[0] || {};
    const afterS = xAiCalls;
    const noteS = String((rs.state || {}).note || '');
    const p2 = afterS === beforeS + 1 && rs.ok === true && rs.made === 1
        && (st.scenes || []).length === 2 && paths.indexOf('纽约') >= 0 && paths.indexOf('纽约>曼哈顿区') >= 0
        && ny.id === 'smoke-xs-1' && Number(ny.uses) === 2 && Number(ny.floorSeen) === 5 && ny.desc === '繁华都市（修正）。'
        && noteS.indexOf('场景修复：节点 1 → 2') >= 0;
    return p1 && p2;
})();
host.ctx.generateRaw = origGenX;
assert('X3 AI 桩端到端落库：概念修复（机械合并 → 聚类选组 → AI 合并+删除 → 编号精确应用 + 墓碑）与场景修复（整库重建 → 保留 id/uses/floorSeen → 并集落盘）各发 1 次 AI', x3, '');

// ---------- Y 传言演化 + 世界书单向镜像（B8-7 接线） ----------
assert('Y1 FTT 传言/世界书入口齐备（rumorEvolve / rumorEvolveAuto / rumorDecay / clearRumors / rumorTick / rumorRoll / rumorInjLine / flattenRumor / worldbookEntries / worldbookKeys / worldbookIsFttEntry / worldbookSync / worldbookSyncState / worldbookNames / refreshWorldbookNames）', (() => {
    const F = globalThis.FTT;
    const names = ['rumorEvolve', 'rumorEvolveAuto', 'rumorDecay', 'clearRumors', 'rumorTick', 'rumorEnabled', 'rumorEveryRounds', 'rumorNeedRounds',
        'rumorRoll', 'rumorDecayScore', 'rumorExpired', 'rumorInjLine', 'flattenRumor',
        'worldbookEntries', 'worldbookKeys', 'worldbookIsFttEntry', 'worldbookLegacyEntryName', 'worldbookTotalBytes', 'worldbookMemoryTotal',
        'worldbookSync', 'worldbookSyncNow', 'worldbookSyncState', 'worldbookNames', 'refreshWorldbookNames'];
    const missing = names.filter((n) => typeof F[n] !== 'function');
    const roll = Number(F.rumorRoll('smoke-seed'));
    return missing.length === 0 && roll >= 0 && roll < 1 && F.rumorRoll('smoke-seed') === roll     // 确定性掷骰
        && Number(F.rumorEveryRounds()) >= 1 && Number(F.rumorNeedRounds()) >= 1
        && !!F.rumorTick() && Array.isArray(F.worldbookNames()) && typeof F.worldbookMemoryTotal() === 'number';
})(), '');

await assert('Y2 面板「🧪 立即演化」/「🧹 清理传言」可达：传言页工具条按 V1 显隐（无传言不显示清理）+ 动作写回面板 note', (async () => {
    const st = rtMod.state;
    st.rumors = [{ id: 'smoke-yr-1', subject: '角色甲', claim: '角色甲偷了钥匙。', stage: '传播', ferment: 50, tags: ['传言', '钥匙'], uses: 1, date: '2020-01-01', updatedAt: 1000, carriers: [{ who: '角色乙', role: '传播者' }], media: [{ type: '口耳相传', name: '酒馆', date: '2020-01-01', durability: 1 }], chain: [], lineage: [] }];
    const html1 = String((await entry.popupAction('tab', { tab: 'rumors' })).html || '');
    const ev = await entry.popupAction('rumorEvolve', {});
    const noteEv = String((ev.state || {}).note || '');      // 面板提示在 state.note（r.note 恒 undefined）
    const cl = await entry.popupAction('clearRumors', {});
    const emptyNow = (st.rumors || []).length === 0;
    const html0 = String((await entry.popupAction('tab', { tab: 'rumors' })).html || '');
    return html1.indexOf('data-ftt-action="rumorEvolve"') >= 0 && html1.indexOf('🧪 立即演化') >= 0
        && html1.indexOf('title="立即执行一次机械演化（载体老化 / 发酵消退 / 平行联动 / 裂变）"') >= 0
        && html1.indexOf('data-ftt-action="clearRumors"') >= 0 && html1.indexOf('🧹 清理传言') >= 0
        && ev.ok === true && noteEv.indexOf('传言演化：载体停用') >= 0
        && cl.ok === true && cl.cleared === 1 && String((cl.state || {}).note).indexOf('已清空 1 条传言') >= 0 && emptyNow
        && html0.indexOf('data-ftt-action="clearRumors"') < 0;      // 无传言 → 清理按钮隐藏（V1 条件）
})(), '');

await assert('Y3 设定「存储 → 世界书」：V1 同款「📚 刷新世界书列表」按钮 + worldbookRefresh 动作可达（无酒馆世界书接口时如实告警，不伪造列表）', (async () => {
    const page = await entry.popupAction('settingsSub', { sub: 'storage' });
    const sHtml = String((page && page.html) || '');
    const hasBtn = sHtml.indexOf('data-ftt-action="worldbookRefresh"') >= 0 && sHtml.indexOf('📚 刷新世界书列表') >= 0;
    const r = await entry.popupAction('worldbookRefresh', {});
    const note = String(r.note || '');
    const honest = note.indexOf('世界书列表已刷新') >= 0 || note.indexOf('未读取到世界书') >= 0;
    return hasBtn && r.ok === true && Array.isArray(r.names) && honest;
})(), '');

// ---------- Z 计划 / 悬念库清理（B9 补齐：V1 同名动作 clearPlans / clearSuspense） ----------
await assert('Z1 「🧹 清理计划 / 🧹 清理悬念」：各自库非空才显示；动作写删除墓碑、清空库、回填提示；清空后按钮隐藏', (async () => {
    const st = rtMod.state;
    st.plans = [{ id: 'smoke-zc-p1', title: '计划一', content: '送信。', status: 'open', tags: [], uses: 1, floorStart: 1, floorEnd: 2 }];
    st.suspense = [{ id: 'smoke-zc-u1', title: '悬念一', content: '谁在跟踪？', status: 'open', tags: [], uses: 1, floorStart: 1, floorEnd: 2 }];
    st.deleted = {}; st.deletedH = {};
    const html1 = String((await entry.popupAction('tab', { tab: 'plans' })).html || '');
    const r1 = await entry.popupAction('clearPlans', {});
    const r2 = await entry.popupAction('clearSuspense', {});
    const tombs = Object.keys((st.deleted || {}).plans || {}).concat(Object.keys((st.deleted || {}).suspense || {}));
    const html0 = String((await entry.popupAction('tab', { tab: 'plans' })).html || '');
    return html1.indexOf('data-ftt-action="clearPlans"') >= 0 && html1.indexOf('🧹 清理计划') >= 0 && html1.indexOf('title="清空全部计划（不弹确认）"') >= 0
        && html1.indexOf('data-ftt-action="clearSuspense"') >= 0 && html1.indexOf('🧹 清理悬念') >= 0 && html1.indexOf('title="清空全部悬念（不弹确认）"') >= 0
        && r1.ok === true && r1.cleared === 1 && String((r1.state || {}).note).indexOf('已清理 1 条计划') >= 0 && (st.plans || []).length === 0
        && r2.ok === true && r2.cleared === 1 && String((r2.state || {}).note).indexOf('已清理 1 条悬念') >= 0 && (st.suspense || []).length === 0
        && tombs.indexOf('smoke-zc-p1') >= 0 && tombs.indexOf('smoke-zc-u1') >= 0
        && html0.indexOf('data-ftt-action="clearPlans"') < 0 && html0.indexOf('data-ftt-action="clearSuspense"') < 0;
})(), '');

// ---------- AA 物品修复 + 角色档案修复（B8-6c-3） ----------
assert('AA1 FTT 物品修复 + 角色档案修复入口齐备（物品：isCurrencyItemName / itemMergeExact / itemLowUsesPurge / itemRepairPrompt / itemRepairApply / itemRepair；角色：snapRepairFields / snapshotAtomSize / characterRepairQueue / setSnapshotByPath / characterRepairPrompt / characterRepairApply / characterRepair / characterEvidencePack / characterMechanicalPass / correctSnapshotBirthDates）', (() => {
    const F = globalThis.FTT;
    const names = ['isCurrencyItemName', 'itemMergeExact', 'itemLowUsesPurge', 'itemRepairPrompt', 'itemRepairApply', 'itemRepair',
        'snapRepairFields', 'snapRepairFieldMap', 'snapshotAtomSize', 'characterRepairQueue', 'setSnapshotByPath',
        'characterRepairPrompt', 'characterRepairApply', 'characterRepair', 'characterEvidencePack',
        'ensureSnapshotTags', 'deriveSnapshotTags', 'characterMechanicalPass', 'correctSnapshotBirthDates'];
    const missing = names.filter((n) => typeof F[n] !== 'function');
    const st = rtMod.state;
    st.items = [
        { id: 'smoke-aa-i1', name: '铜钥匙', desc: '开门的钥匙。', location: '腰间', carried: true, qty: 1, tags: ['钥匙', '工具', '铜'], uses: 2, floorStart: 1, floorEnd: 2, seenDate: '2020-01-01' },
        { id: 'smoke-aa-i2', name: '铁钥匙', desc: '另一把钥匙。', location: '背包', carried: false, qty: 1, tags: ['钥匙', '工具', '铁'], uses: 1, floorStart: 2, floorEnd: 4, seenDate: '2020-01-02' },
        { id: 'smoke-aa-i3', name: '铜钥匙（旧）', desc: '旧钥匙，铜锈斑驳。', location: '', carried: false, qty: 1, tags: ['钥匙'], uses: 1, floorStart: 3, floorEnd: 3 },
    ];
    st.repairCursor = {}; st.deleted = {}; st.deletedH = {};
    const me = F.itemMergeExact();                       // i3 规范名 = i1 → 合并 1 件（不写墓碑）
    const purge = F.itemLowUsesPurge();
    const pick = F.groupPick(F.groupSpec('items'));
    const prompt = F.itemRepairPrompt(pick);
    const applied = F.itemRepairApply({ '修订': [{ '编号': 2, '字段': '标签', '值': '钥匙,工具,铁,门禁' }] }, pick);
    const k2 = (st.items || []).filter((x) => x.id === 'smoke-aa-i2')[0] || {};
    const itemOk = me.merged === 1 && (st.items || []).length === 2
        && Number(purge.total) === 2 && pick.picked === 1 && pick.entries.length === 2
        && Array.isArray(prompt) && prompt.length === 2 && prompt[0].role === 'system'
        && String(prompt[1].content).indexOf('【相关组 1】') >= 0
        && applied.revised === 1 && (k2.tags || []).length === 4
        && F.isCurrencyItemName('银两', '') === true && F.isCurrencyItemName('铁剑', '') === false;
    // 角色档案修复：原子尺寸 / 待修复名单（异常优先档）/ 点路径写入 / 提示词 / 精确应用 / 相关原子数据
    st.snapshots = [
        { id: 'smoke-aa-c1', name: '角色乙', identity: { gender: '男', birthDate: '1900-01-01' }, appearance: '高个', tags: ['船长', '海家', '关键角色'], uses: 1 },
        { id: 'smoke-aa-c2', name: '角色丁', identity: { birthDate: '约1890年' }, tags: ['旧档', '村民', '老人'], uses: 1 },
    ];
    st.atoms = [{ id: 'smoke-aa-a1', title: '码头初遇', text: '角色乙在码头出现。', date: '2020-01-01', tags: ['码头'], entities: ['角色乙'], uses: 1 }];
    st.memories = []; st.currentStates = []; st.links = [];
    const fields = F.snapRepairFields();
    const atom = F.snapshotAtomSize(st.snapshots[0]);
    const cq = F.characterRepairQueue();
    const cPrompt = F.characterRepairPrompt(cq.list.slice(0, 2));
    const cApplied = F.characterRepairApply({ snapshots: { update: [{ name: '角色乙', '补全': { '身份.种族': '人类' } }] } }, cq.list);
    const ev = F.characterEvidencePack('角色乙');
    const one = F.setSnapshotByPath({ identity: {} }, '身份.种族', '人类');
    const c1 = (st.snapshots || []).filter((x) => x.id === 'smoke-aa-c1')[0] || {};
    const charOk = Array.isArray(fields) && fields.length === 20 && !!F.snapRepairFieldMap()['身份.性别']
        && atom.total === 19 && cq.list.length === 2 && cq.anomalyList.map(x => x.name).join(',') === '角色丁' && cq.deceasedCount === 0
        && Array.isArray(cPrompt) && cPrompt.length === 2 && String(cPrompt[1].content).indexOf('⚠️ 出生日期异常') >= 0
        && cApplied.changed >= 1 && c1.identity.species === '人类'
        && ev.total >= 1 && one.ok === true && one.changed === true
        && Number(F.characterMechanicalPass().total) === 2;
    return missing.length === 0 && itemOk && charOk;
})(), '');

const aa2 = await (async () => {
    const st = rtMod.state;
    st.items = [{ id: 'smoke-aa-b1', name: '铜钥匙', desc: '开门的钥匙。', location: '腰间', carried: true, qty: 1, tags: ['钥匙', '工具', '铜'], uses: 2, floorStart: 1, floorEnd: 2 }];
    const h1 = String((await entry.popupAction('tab', { tab: 'items' })).html || '');
    st.items = [];
    const h0 = String((await entry.popupAction('tab', { tab: 'items' })).html || '');
    const itemOk = h1.indexOf('data-ftt-action="itemRepair"') >= 0 && h1.indexOf('🔧 修复物品') >= 0
        && h1.indexOf('title="修复物品冗余与记录错误，并更新流转信息"') >= 0
        && h0.indexOf('data-ftt-action="itemRepair"') < 0;      // 无物品 → 按钮隐藏（V1 `itemList.length` 条件）
    // 角色页：有角色才显示「🔧 修复角色」；出生日期异常角色数进优先档 → 文案带「（⚠️N 优先）」角标
    //   （固定剧情日期：出生日期异常判定依赖 ageAnchorDate，避免受前序小节推进的剧情日期影响）
    const savedDate2 = (st.state || {}).date;
    st.state = Object.assign({}, st.state, { date: '2020-06-01', time: '傍晚' });
    st.snapshots = [
        { id: 'smoke-aa-cb1', name: '角色乙', identity: { birthDate: '1990-01-01' }, tags: ['甲', '乙', '丙'], uses: 1 },
        { id: 'smoke-aa-cb2', name: '角色丁', identity: { birthDate: '约1890年' }, tags: ['旧档', '村民', '老人'], uses: 1 },
    ];
    const c1 = String((await entry.popupAction('tab', { tab: 'snapshots' })).html || '');
    st.snapshots = [];
    const c0 = String((await entry.popupAction('tab', { tab: 'snapshots' })).html || '');
    const charOk = c1.indexOf('data-ftt-action="characterRepair"') >= 0 && c1.indexOf('title="出生日期倒挂者优先，其余按字数最薄弱 3 条"') >= 0
        && c1.indexOf('🔧 修复角色（⚠️1 优先）') >= 0
        && c0.indexOf('data-ftt-action="characterRepair"') < 0;  // 无角色 → 按钮隐藏
    st.state = Object.assign({}, st.state, { date: savedDate2 });
    return itemOk && charOk;
})();
assert('AA2 面板按钮按 V1 条件显隐：物品页「🔧 修复物品」（有则显 / 无则隐）+ 角色页「🔧 修复角色」（有则显 / 无则隐，异常角色数进「（⚠️N 优先）」角标；文案与 title 逐字一致）', aa2, '');

const origGenAA = host.ctx.generateRaw;
let aaAiCalls = 0;
let aaPayload = '';
host.ctx.generateRaw = async () => { aaAiCalls++; return aaPayload; };
const aa3 = await (async () => {
    const st = rtMod.state;
    st.items = [
        { id: 'smoke-aa-k1', name: '铜钥匙', desc: '开门的钥匙。', location: '腰间', carried: true, qty: 1, tags: ['钥匙', '工具', '铜'], uses: 2, floorStart: 1, floorEnd: 2, seenDate: '2020-01-01' },
        { id: 'smoke-aa-k2', name: '铁钥匙', desc: '另一把钥匙。', location: '背包', carried: false, qty: 1, tags: ['钥匙', '工具', '铁'], uses: 1, floorStart: 2, floorEnd: 4, seenDate: '2020-01-02' },
        { id: 'smoke-aa-k3', name: '铁剑', desc: '一把铁剑。', location: '背后', carried: true, qty: 1, tags: ['武器', '铁'], uses: 1, floorStart: 5, floorEnd: 5, seenDate: '2020-01-05' },
    ];
    st.repairCursor = {}; st.deleted = {}; st.deletedH = {};
    sweepMod.entryIndexInit();                               // 对齐删除留痕基线（等价 oracle 里的 entryIndexInit）
    rtMod.cfg.itemRepairSim = 0.45; rtMod.cfg.itemRepairMaxClusters = 3;
    rtMod.cfg.itemRepairMaxItems = 24; rtMod.cfg.itemRepairMaxClusterSize = 8;
    rtMod.cfg.itemLowUsesMinItems = 100;                     // 库太小 → 低调用清理不动作（本节只验证聚类 + AI 段）
    rtMod.cfg.itemLowUsesEveryFloors = 0;
    aaPayload = JSON.stringify({
        '合并': [{ '保留': 1, '并入': [2], '名称': '钥匙串', '说明': '一串可开正门侧门的钥匙。', '位置': '腰间', '数量': 2, '标签': ['钥匙', '工具', '门禁'] }],
        '修订': [{ '编号': 3, '字段': '标签', '值': '武器,铁,近战' }],
        '删除': [],
    });
    const before = aaAiCalls;
    const r = await entry.popupAction('itemRepair', {});
    const ir = r.itemRepair || {};
    const k1 = (st.items || []).filter((x) => x.id === 'smoke-aa-k1')[0] || {};
    const k3 = (st.items || []).filter((x) => x.id === 'smoke-aa-k3')[0] || {};
    const tombs = Object.keys((st.deleted || {}).items || {});
    const note = String(((r.state || {}).note) || r.note || '');
    const itemOk = aaAiCalls === before + 1 && r.ok === true && r.made === 1
        && ir.fused === 1 && ir.removed === 1 && ir.revised === 1 && ir.deleted === 1
        && (st.items || []).length === 2 && k1.name === '钥匙串' && Number(k1.uses) === 3
        && (k3.tags || []).length === 3
        && tombs.indexOf('smoke-aa-k2') >= 0
        && note.indexOf('物品修复：') >= 0 && note.indexOf('高相关组 1/1 组') >= 0 && note.indexOf('删除 1 件') >= 0;
    // 角色档案修复：AI 前全局机械处理（零 AI）→ 待修复名单 → 窄契约 AI → 按「姓名 + 中文点路径」精确应用
    st.items = [];
    st.snapshots = [
        { id: 'smoke-aa-cr1', name: '角色乙', identity: { gender: '男', birthDate: '1900-01-01' }, tags: ['船长', '海家', '关键角色'], uses: 1 },
        { id: 'smoke-aa-cr2', name: '角色甲', identity: {}, tags: ['主角', '码头', '商人'], uses: 1 },
    ];
    st.atoms = [{ id: 'smoke-aa-ca1', title: '码头初遇', text: '角色甲在码头做买卖，认识角色乙。', date: '2020-01-01', tags: ['码头'], entities: ['角色甲', '角色乙'], uses: 1 }];
    st.memories = []; st.currentStates = []; st.links = [];
    st.deleted = {}; st.deletedH = {}; st.repairCursor = {};
    st.state = Object.assign({}, st.state, { date: '2020-06-01', time: '傍晚' });   // 固定剧情日期（出生日期推算 / 年龄口径）
    sweepMod.entryIndexInit();
    rtMod.cfg.repairCharacterMinSize = 30; rtMod.cfg.repairCharacterBatch = 3; rtMod.cfg.repairFloors = 10;
    aaPayload = JSON.stringify({
        '角色档案': {
            '更新': [{ '姓名': '角色甲', '补全': { '身份.职业': '商人', '身份.出生日期': '1990-03-05', '性格.性格特质': ['精明', '谨慎'] } }],
            '推断': [], '无依据': [], '删除': [],
        },
    });
    const beforeC = aaAiCalls;
    const rc = await entry.popupAction('characterRepair', {});
    const cr = rc.characterRepair || {};
    const c2 = (st.snapshots || []).filter((x) => x.id === 'smoke-aa-cr2')[0] || {};
    const noteC = String(((rc.state || {}).note) || rc.note || '');
    const charOk = aaAiCalls === beforeC + 1 && rc.ok === true && rc.made === 1
        && Number(cr.attempts) === 1 && Number(cr.rolesChanged) === 1
        && c2.identity.occupation === '商人' && c2.identity.birthDate === '1990-03-05'
        && (c2.personality.traits || []).length === 2 && c2.identity.age === '30'
        && String(c2.lastUpdateDate || '').length > 0
        && noteC.indexOf('角色修复：') >= 0 && noteC.indexOf('补全 1 名 / 3 个字段') >= 0;
    return itemOk && charOk;
})();
host.ctx.generateRaw = origGenAA;
assert('AA3 AI 桩端到端落库：物品修复（聚类选组 → AI 合并 + 修订 → 编号精确应用 + 墓碑）与角色档案修复（机械处理 → 待修复名单 → AI 按中文点路径补全 → 只填空不改写 + 年龄重算）各发 1 次 AI', aa3, '');

// ---------- AB 状态修复 + 计划悬念修复（B8-6c-4） ----------
assert('AB1 FTT 状态修复 + 计划悬念修复入口齐备（状态：stateRepairFields / stateCanonField / stateRepairRoster / stateSubjectMatch / stateRepairMatch / stateRepairClean / removeStatesOfDeceased / stateRepairTargets / stateRepairPrompt / stateRepairApply / stateRepair；计划悬念：suspenseMergeExact / planSuspRepairPrompt / planSuspMergeApply / suspenseRepairApply / planSuspRepair），且机械段真实生效（替代归一 / 无档案主体删除 / 占位清理 / 同内容悬念去重）', (() => {
    const F = globalThis.FTT;
    const names = ['stateRepairFields', 'stateCanonField', 'stateRepairRoster', 'stateSubjectMatch', 'stateRepairMatch',
        'stateRepairClean', 'removeStatesOfDeceased', 'stateRepairTargets', 'stateRepairPrompt', 'stateRepairApply', 'stateRepair',
        'suspenseMergeExact', 'planSuspRepairPrompt', 'planSuspMergeApply', 'suspenseRepairApply', 'planSuspRepair'];
    const missing = names.filter((n) => typeof F[n] !== 'function');
    const st = rtMod.state;
    st.currentStates = [
        { id: 'smoke-ab-s1', subject: '角色乙', field: '情绪', value: '愤怒', uses: 2, floorStart: 1, floorEnd: 5, updatedAt: '2020-01-02', status: 'active' },
        { id: 'smoke-ab-s2', subject: '角色乙', field: '处境', value: '暂无', uses: 1, floorEnd: 1, status: 'active' },
        { id: 'smoke-ab-s3', subject: '黑衣客', field: '处境', value: '跟踪', uses: 1, floorEnd: 2, status: 'active' },
    ];
    st.snapshots = [{ id: 'smoke-ab-n1', name: '角色乙', identity: { gender: '男' }, tags: ['甲', '乙', '丙'], uses: 1 }];
    st.npcs = []; st.protagonist = {};
    st.state = Object.assign({}, st.state, { present: [] });
    st.deleted = {}; st.deletedH = {}; st.repairCursor = {};
    sweepMod.entryIndexInit();
    const fields = F.stateRepairFields();
    const roster = F.stateRepairRoster();
    const mech = F.stateRepairMatch();                 // 黑衣客 无档案 → 整组删除；情绪 → 情绪与心理状态
    const clean = F.stateRepairClean();                // 处境=暂无 → 占位清理
    const targets = F.stateRepairTargets(1);
    const prompt = F.stateRepairPrompt(targets);
    const applied = F.stateRepairApply({ states: { update: [{ subject: targets.list[0].name, field: '长期目标', value: '远航' }] } }, targets);
    const stateOk = Array.isArray(fields) && fields.length === 6 && roster.strong === 1
        && F.stateCanonField('心情') === '情绪与心理状态' && F.stateSubjectMatch('角色乙', roster, 0.72) === '角色乙'
        && mech.removed === 1 && clean.junk === 1 && clean.renamedField === 1
        && targets.list.length === 1 && targets.list[0].name === '角色乙'
        && Array.isArray(prompt) && prompt.length === 2 && String(prompt[1].content).indexOf('字段只允许取：') >= 0
        && applied.added === 1 && applied.changed === 1
        && (st.currentStates || []).some((x) => x.field === '长期目标' && x.value === '远航')
        && (st.currentStates || []).every((x) => x.subject !== '黑衣客');
    st.suspense = [
        { id: 'smoke-ab-u1', title: '', content: '谁在夜里敲门？', tags: ['悬疑', '夜间', '神秘'], uses: 2, importance: 0.4, date: '2020-03-05', status: 'open' },
        { id: 'smoke-ab-u2', title: '夜半', content: '谁在夜里敲门？', tags: ['悬疑', '夜里', '神秘'], uses: 1, importance: 0.8, date: '2020-02-01', status: 'open' },
    ];
    st.plans = [{ id: 'smoke-ab-p1', content: '查明敲门者。', status: 'open', tags: ['计划', '悬疑'], uses: 1 }];
    st.repairCursor = {};
    const me = F.suspenseMergeExact();                 // 同正文 → 并一条（标题取非空者、uses 累加、日期最早）
    const pick = F.groupPick(F.groupSpec('suspense'));
    const pp = F.planSuspRepairPrompt(pick);
    const sp = F.suspenseRepairApply({ '悬念库': { '修订': [{ '编号': pick.entries[0].n, '字段': '内容', '值': '修订后的悬念内容。' }] } }, pick);
    const pm = F.planSuspMergeApply({ plans: { merge: [{ '保留编号': 0, '合并编号': [] }] } });
    const u1 = (st.suspense || [])[0] || {};
    const planOk = me.merged === 1 && (st.suspense || []).length === 1 && u1.id === 'smoke-ab-u1'
        && u1.title === '夜半' && Number(u1.uses) === 3 && u1.date === '2020-02-01'
        && Array.isArray(pp) && pp.length === 2 && String(pp[1].content).indexOf('#P0 查明敲门者。') >= 0
        && sp.revised === 1 && String(u1.content).indexOf('修订后的悬念内容') >= 0
        && pm.mergedPlans === 0 && pm.removed === 0;
    return missing.length === 0 && stateOk && planOk;
})(), '');

await assert('AB2 面板按钮按 V1 条件显隐：状态页「🔧 修复状态」（有状态记录则显 / 无则隐）+ 计划悬念页「🔧 修复计划/悬念」（有进行中计划或未解悬念才显，全为已完结/已揭晓则隐；文案与 title 逐字一致）', (async () => {
    const st = rtMod.state;
    st.snapshots = []; st.npcs = [];
    st.currentStates = [{ id: 'smoke-ab-b1', subject: '角色乙', field: '处境', value: '在码头', uses: 1, floorEnd: 1, status: 'active' }];
    st.plans = []; st.suspense = [];
    const h1 = String((await entry.popupAction('tab', { tab: 'states' })).html || '');
    st.currentStates = [];
    const h0 = String((await entry.popupAction('tab', { tab: 'states' })).html || '');
    const statesOk = h1.indexOf('data-ftt-action="stateRepair"') >= 0 && h1.indexOf('🔧 修复状态') >= 0
        && h1.indexOf('title="匹配角色 → 机械清理与字段规范化 → 交 AI 整理"') >= 0
        && h0.indexOf('data-ftt-action="stateRepair"') < 0 && h0.indexOf('（暂无状态记录）') >= 0;
    st.plans = [{ id: 'smoke-ab-bp1', content: '查明敲门者。', status: 'open', tags: ['计划'], uses: 1 }];
    st.suspense = [];
    const h2 = String((await entry.popupAction('tab', { tab: 'plans' })).html || '');
    st.plans = [{ id: 'smoke-ab-bp2', content: '已了结的计划。', status: 'closed', tags: ['计划'], uses: 1 }];
    const h3 = String((await entry.popupAction('tab', { tab: 'plans' })).html || '');
    st.plans = []; st.suspense = [];
    const plansOk = h2.indexOf('data-ftt-action="planSuspRepair"') >= 0 && h2.indexOf('🔧 修复计划/悬念') >= 0
        && h2.indexOf('title="了结已完成/已揭晓，合并重复并归并关联"') >= 0
        && h3.indexOf('data-ftt-action="planSuspRepair"') < 0;
    return statesOk && plansOk;
})(), '');

await assert('AB3 AI 桩端到端落库：状态修复（匹配角色 → 机械清理 → AI 按「主体 + 字段」精确应用）与计划/悬念修复（机械去重 → 聚类 → AI 按编号修订 + 计划了结）**各发 1 次 AI**，结果如实写回面板 `state.note`', (async () => {
    const st = rtMod.state;
    const origGen = host.ctx.generateRaw;
    let calls = 0;
    let payload = '{}';
    host.ctx.generateRaw = async () => { calls++; return payload; };
    try {
        rtMod.cfg.dimCharLimits = Object.assign({}, rtMod.cfg.dimCharLimits || {}, { states: 130 });
        rtMod.cfg.stateRepairBatch = 3; rtMod.cfg.stateMaxPerSubject = 10;
        rtMod.cfg.suspenseRepairSim = 0.45; rtMod.cfg.suspenseRepairMaxClusters = 3;
        rtMod.cfg.suspenseRepairMaxItems = 24; rtMod.cfg.suspenseRepairMaxClusterSize = 8;
        rtMod.cfg.repairFloors = 10;
        // ---- 状态修复 ----
        st.currentStates = [
            { id: 'smoke-ab-r1', subject: '角色乙', field: '情绪', value: '愤怒', uses: 2, floorStart: 1, floorEnd: 5, updatedAt: '2020-01-02', status: 'active' },
            { id: 'smoke-ab-r2', subject: '角色乙', field: '处境', value: '暂无', uses: 1, floorEnd: 1, status: 'active' },
            { id: 'smoke-ab-r3', subject: '黑衣客', field: '处境', value: '跟踪', uses: 1, floorEnd: 2, status: 'active' },
        ];
        st.snapshots = [{ id: 'smoke-ab-n1', name: '角色乙', identity: { gender: '男' }, tags: ['甲', '乙', '丙'], uses: 1 }];
        st.npcs = []; st.protagonist = {}; st.links = [];
        st.state = Object.assign({}, st.state, { date: '2020-06-01', time: '傍晚', present: [] });
        st.deleted = {}; st.deletedH = {}; st.repairCursor = {};
        sweepMod.entryIndexInit();
        // 按真实扫描结果定位主体（不硬编码）：名册匹配（`stateSubjectMatch`）者才是「机械段后仍存活」的主体
        const roster = globalThis.FTT.stateRepairRoster();
        const targets = globalThis.FTT.stateRepairTargets(3);
        const alive = targets.list.map((t) => t.name).filter((n) => globalThis.FTT.stateSubjectMatch(n, roster, 0.72));
        payload = JSON.stringify({ '状态记录': { '更新': [{ '主体': alive[0], '字段': '长期目标', '值': '远航' }], '删除': [], '无依据': [] } });
        const beforeS = calls;
        const rs = await entry.popupAction('stateRepair', {});
        const sr = rs.stateRepair || {};
        const noteS = String(((rs.state || {}).note) || rs.note || '');
        const added = (st.currentStates || []).some((x) => x.field === '长期目标' && x.value === '远航');
        const stateOk = calls === beforeS + 1 && rs.ok === true && sr.made === 1
            && Number(sr.match && sr.match.removed) === 1 && Number(sr.clean && sr.clean.junk) === 1
            && alive.length === 1 && alive[0] === '角色乙'
            && Number(sr.ai && sr.ai.changed) === 1 && Number(sr.ai && sr.ai.added) === 1
            && Number(sr.ai && sr.ai.unknownRole) === 0 && added
            && (st.currentStates || []).every((x) => x.subject !== '黑衣客')
            && noteS.indexOf('状态修复：') >= 0 && noteS.indexOf('AI 更新 1 条') >= 0;
        // ---- 计划/悬念修复 ----
        st.suspense = [
            { id: 'smoke-ab-u1', title: '', content: '谁在夜里敲门？', tags: ['悬疑', '夜间', '神秘'], uses: 2, importance: 0.4, date: '2020-03-05', status: 'open' },
            { id: 'smoke-ab-u2', title: '夜半', content: '谁在夜里敲门？', tags: ['悬疑', '夜里', '神秘'], uses: 1, importance: 0.8, date: '2020-02-01', status: 'open' },
        ];
        st.plans = [{ id: 'smoke-ab-p1', content: '查明敲门者。', status: 'open', tags: ['计划', '悬疑'], uses: 1 }];
        st.deleted = {}; st.deletedH = {}; st.repairCursor = {}; st.stats = { plansClosed: 0, suspenseResolved: 0 };
        sweepMod.entryIndexInit();
        const pick = globalThis.FTT.groupPick(globalThis.FTT.groupSpec('suspense'));   // 按真实扫描结果定位悬念编号
        const n1 = (pick.entries[0] || {}).n;
        payload = JSON.stringify({
            '悬念库': { '修订': [{ '编号': n1, '字段': '内容', '值': '谁在夜里敲门？已查明是巡夜人。' }] },
            '计划库': { '了结': ['查明敲门者。'] },
        });
        const beforeP = calls;
        const rp = await entry.popupAction('planSuspRepair', {});
        const pr = rp.planSuspRepair || {};
        const noteP = String(((rp.state || {}).note) || rp.note || '');
        const planOk = calls === beforeP + 1 && rp.ok === true && pr.made === 1
            && Number(pr.merged) === 1 && Number(pr.revised) === 1 && Number(pr.closedP) === 1
            && (st.suspense || []).length === 1 && String((st.suspense || [])[0].content).indexOf('巡夜人') >= 0
            && (st.plans || []).every((x) => x.id !== 'smoke-ab-p1') && Number(st.stats.plansClosed) === 1
            && noteP.indexOf('计划/悬念修复：') >= 0 && noteP.indexOf('已了结计划 1 项') >= 0;
        return stateOk && planOk;
    } finally { host.ctx.generateRaw = origGen; }
})(), '');

// ---------- AC 情节总结 + 分段总结（B8-7-a） ----------
await assert('AC1 情节总结 + 分段总结接线齐备：FTT.* 入口（25 项）+ V1 同款按钮文案/title/显隐（🧷 立即聚合早期情节 / 🧷 情节总结（N） / 🧩 分段总结（N） / 🧹 清理分段）', (async () => {
    const F = globalThis.FTT;
    const names = ['atomBodyChars', 'atomDateGrainKey', 'grainStartDateStr', 'atomCompactPlan', 'atomGroupPlan',
        'buildAtomCompactPrompt', 'compactGrainLabel', 'applyCompactGroup', 'scheduleAtomCompact', 'runAtomCompact',
        'atomMergeRange', 'buildAtomMergePrompt', 'parseAtomMergeResult', 'atomMergeSummary', 'runAtomMergeSummary',
        'plotSegmentBatchSize', 'plotSegmentAtomList', 'plotSegmentCoveredIds', 'plotSegmentBatchesFrom', 'plotSegmentPlan',
        'plotSegmentPlanForIds', 'buildPlotSegmentPrompt', 'plotSegmentSameRange', 'applyPlotSegmentResult',
        'runPlotSegmentSummary', 'runPlotSegmentSummarySelected', 'clearPlotSegments', 'deletePlotSegment',
        'flattenPlotSegment', 'atomSubState', 'setAtomSub'];
    const missing = names.filter((n) => typeof F[n] !== 'function');
    const st = rtMod.state;
    st.atoms = [
        { id: 'smoke-ac-a1', title: 'A1', text: '甲在码头搬运货物。', date: '1919-11-29', validity: 'active', tags: ['甲'], floorStart: 1, floorEnd: 1 },
        { id: 'smoke-ac-a2', title: 'A2', text: '乙在仓库清点。', date: '1919-11-30', validity: 'active', tags: ['乙'], floorStart: 2, floorEnd: 2 },
        { id: 'smoke-ac-a3', title: 'A3', text: '丙在城外等待。', date: '1919-11-29', validity: 'active', tags: ['丙'], floorStart: 3, floorEnd: 3 },
    ];
    st.plotSegments = [];
    await entry.popupAction('settingsSub', { sub: 'prompts' });
    let h = String((await entry.popupAction('refresh', {})).html || '');
    const setOk = h.indexOf('data-ftt-action="atomCompactNow"') >= 0
        && h.indexOf('title="立即对早期情节执行一次半自动情节总结（聚合为情节总结，原文保留并隐藏）"') >= 0
        && h.indexOf('🧷 立即聚合早期情节') >= 0 && h.indexOf('data-ftt-compact-result') >= 0
        && h.indexOf('早期情节压缩') >= 0;
    await entry.popupAction('tab', { tab: 'atoms' });
    await entry.popupAction('multiToggle', { kind: 'atoms' });
    await entry.popupAction('selectNone', { kind: 'atoms' });
    h = String((await entry.popupAction('refresh', {})).html || '');
    const multiOff = h.indexOf('🧷 情节总结（0）') >= 0 && h.indexOf('🧩 分段总结（0）') >= 0
        && /data-ftt-action="atomMergeSummary"[^>]*disabled/.test(h)
        && /data-ftt-action="plotSegmentSummarySel"[^>]*disabled/.test(h)
        && h.indexOf('title="【情节总结】把勾选的情节交 AI 聚合成一条情节（标题标记「【A~B 总结】」）；原文保留并隐藏，不参与注入与淘汰，除非人工删除（可在总结上点 🧩 穿透查看）"') >= 0
        && h.indexOf('title="【分段总结】把勾选的情节按剧情时间打包交 AI 分成多段，归档到「🧩 分段总结」子页供人工管理（只归档、不注入、不参与任何自动动作）"') >= 0;
    await entry.popupAction('selectAll', { kind: 'atoms' });
    h = String((await entry.popupAction('refresh', {})).html || '');
    const multiOn = h.indexOf('🧷 情节总结（3）') >= 0 && h.indexOf('🧩 分段总结（3）') >= 0
        && !/data-ftt-action="atomMergeSummary"[^>]*disabled/.test(h);
    await entry.popupAction('selectNone', { kind: 'atoms' });
    await entry.popupAction('atomSub', { sub: 'segments' });
    h = String((await entry.popupAction('refresh', {})).html || '');
    const segTabOk = F.atomSubState() === 'segments' && h.indexOf('data-ftt-asub="segments"') >= 0
        && h.indexOf('data-ftt-action="summary" data-ftt-summary="plotSegments"') >= 0
        && h.indexOf('title="把情节按时间打包交 AI 拆成多段总结（言简意赅、只陈述事实与数据）"') >= 0
        && h.indexOf('🧩 生成分段总结') >= 0
        && h.indexOf('data-ftt-action="clearPlotSegments"') < 0;
    st.plotSegments = [{ id: 'smoke-ac-seg', header: '1899-03-01 ~ 1899-04-10', start: '1899-03-01', end: '1899-04-10', lines: [{ label: '感情线', text: '一段测试概述' }], raw: '### 1899-03-01 ~ 1899-04-10\n1. 感情线：一段测试概述', atomIds: [], atomCount: 0, floorStart: 0, floorEnd: 0, manual: false, uses: 0, createdAt: 1, updatedAt: 1 }];
    h = String((await entry.popupAction('refresh', {})).html || '');
    const segClearOk = h.indexOf('data-ftt-action="clearPlotSegments"') >= 0
        && h.indexOf('title="清空全部分段总结（不弹确认）"') >= 0 && h.indexOf('🧹 清理分段') >= 0
        && h.indexOf('### 1899-03-01 ~ 1899-04-10') >= 0;
    // 机械段（零 AI）：计划 / 分组 / 分段切批 / 合并区间 / 解析
    const plan = F.atomCompactPlan();
    const segPlan = F.plotSegmentPlan();
    const okMech = F.atomBodyChars() > 0 && plan.before === 3
        && F.plotSegmentBatchSize() === Number(rtMod.cfg.plotSegmentBatchAtoms || 30)
        && F.atomMergeRange([{ id: 'x', date: '1919-11-29' }, { id: 'y', date: '1919-12-01' }]).label === '1919-11-29 ~ 1919-12-01'
        && segPlan.total === 3 && segPlan.batches.length === 1
        && F.parseAtomMergeResult('{"标题":"T","内容":"正文内容"}').title === 'T';
    F.setAtomSub('list');
    st.plotSegments = [];
    return missing.length === 0 && setOk && multiOff && multiOn && segTabOk && segClearOk && okMech && F.atomSubState() === 'list';
})(), '');

await assert('AC2 情节总结端到端：面板「🧷 立即聚合早期情节」force 聚合同日情节（原文保留并隐藏、无墓碑）+ 多选「🧷 情节总结」AI 合并为 1 条 A~B 总结，结果如实写回 r.state.note', (async () => {
    const st = rtMod.state;
    const origGen = host.ctx.generateRaw;
    let calls = 0, payload = '';
    host.ctx.generateRaw = async () => { calls++; return payload; };
    try {
        rtMod.cfg.storeMinAtoms = 0;
        rtMod.cfg.atomCompactRecent = 20;
        const old = [], recent = [];
        for (let i = 1; i <= 40; i++) old.push({ id: 'smoke-ac-old' + i, title: 'old' + i, text: '旧事件甲在码头发现物品' + i, date: '1919-11-29', tags: ['旧', '码头'], floorStart: i - 1, floorEnd: i, uses: 0, type: '事件' });
        for (let j = 1; j <= 20; j++) recent.push({ id: 'smoke-ac-new' + j, title: 'new' + j, text: '新剧情事件内容' + j, date: '1926-05-01', tags: ['新'], floorStart: 500 + j, floorEnd: 501 + j, uses: 0, type: '事件' });
        st.atoms = old.concat(recent);
        st.deleted = {}; st.deletedH = {}; st.plotSegments = [];
        sweepMod.entryIndexInit();
        payload = JSON.stringify({ groups: [{ key: '1919-11-29', 标题: '十一月码头事件总结', 内容: '压缩后的顺序化过程：先在码头发现物品，后循线索追查，因果衔接保留XYZ', 标签: ['旧', '码头'], 重要度: 0.8 }] });
        const b1 = calls;
        const r1 = await entry.popupAction('atomCompactNow', {});
        const note1 = String(((r1.state || {}).note) || '');
        const ac = r1.atomCompact || {};
        // 参与运作清单按真实结果统计（不硬编码）
        const active1 = st.atoms.filter((a) => !(a.hidden === true || a.summarizedBy));
        const summaries1 = st.atoms.filter((a) => /^atom_c_/.test(String(a.id || '')));
        const okCompact = calls === b1 + 1 && ac.summarized === 1 && ac.hidden === 40
            && st.atoms.length === 61 && active1.length === 21 && summaries1.length === 1
            && summaries1[0].mergedSummary && summaries1[0].mergedSummary.by === 'auto' && summaries1[0].mergedSummary.sourceCount === 40
            && (st.atoms || []).filter((a) => /^smoke-ac-old/.test(String(a.id))).every((a) => a.hidden === true && String(a.summarizedBy) === String(summaries1[0].id))
            && Object.keys((st.deleted || {}).atoms || {}).length === 0
            && note1.indexOf('聚合 1 条总结') >= 0 && note1.indexOf('原文保留并隐藏') >= 0;
        // 多选 → 合并：按真实可见清单全选（21 条：20 条新剧情 + 1 条自动总结条）
        await entry.popupAction('tab', { tab: 'atoms' });
        await entry.popupAction('multiToggle', { kind: 'atoms' });
        await entry.popupAction('selectAll', { kind: 'atoms' });
        payload = JSON.stringify({ 标题: '粮运交接', 内容: '甲乙在码头敲定粮食转运并清点货物，随后甲出城确认了抵港时间。', 标签: ['交易', '情感'], 重要度: 0.85 });
        const b2 = calls;
        const r2 = await entry.popupAction('atomMergeSummary', {});
        const note2 = String(((r2.state || {}).note) || '');
        const merged = (r2.atomMerge || {}).merged;
        const active2 = st.atoms.filter((a) => !(a.hidden === true || a.summarizedBy));
        const manual = st.atoms.filter((a) => a.mergedSummary && a.mergedSummary.by === 'manual');
        const okMerge = calls === b2 + 1 && Number(merged) === 21 && active2.length === 1 && manual.length === 1
            && manual[0].mergedSummary.sourceCount === 21 && String(manual[0].title).indexOf('总结】') >= 0
            && Object.keys((st.deleted || {}).atoms || {}).length === 0
            && note2.indexOf('新增 1 条情节总结') >= 0 && note2.indexOf('原文保留并隐藏') >= 0;
        await entry.popupAction('multiToggle', { kind: 'atoms' });
        await entry.popupAction('selectNone', { kind: 'atoms' });
        return okCompact && okMerge;
    } finally { host.ctx.generateRaw = origGen; }
})(), '');

await assert('AC3 分段总结端到端：面板「🧩 生成分段总结」（按批归档）→ 多选「🧩 分段总结」（只增不减、同区间跳过）→「🧹 清理分段」清空并留墓碑；产物不参与注入', (async () => {
    const recallMod = await import('../core/recall.js');
    const st = rtMod.state;
    const origGen = host.ctx.generateRaw;
    let calls = 0, payload = '';
    host.ctx.generateRaw = async () => { calls++; return payload; };
    try {
        const SAMPLE = ['### 1899-03-01 ~ 1899-04-10', '1. 感情线: 角色甲与角色乙在码头定下婚约。', '2. 商业线: 角色甲卖掉旧船板得 50 银元。', '', '### 1899-04-11 ~ 1899-05-12', '1. 学术线: 角色丙抄录 3 卷古籍。'].join('\n');
        const NEXT = ['### 1899-06-01 ~ 1899-06-30', '1. 感情线: 六月里两人再次聚首。'].join('\n');
        st.atoms = [
            { id: 'smoke-ac-p1', title: 'P1', text: '甲在码头搬运货物。', date: '1919-11-29', validity: 'active', tags: ['甲'], floorStart: 1, floorEnd: 1 },
            { id: 'smoke-ac-p2', title: '', text: '乙在仓库清点。', date: '1919-11-30', validity: 'active', tags: ['乙'], floorStart: 2, floorEnd: 2 },
            { id: 'smoke-ac-p3', title: 'P3', text: '丙在城外等待。', date: '1919-12-01', validity: 'active', tags: [], floorStart: 3, floorEnd: 3 },
            { id: 'smoke-ac-p4', title: 'P4', text: '丁在城里打听。', date: '', validity: 'active', tags: [], floorStart: 4, floorEnd: 4 },
            { id: 'smoke-ac-p5', title: 'P5', text: '戊已失效。', date: '1919-12-02', validity: 'inactive', tags: [], floorStart: 5, floorEnd: 5 },
        ];
        st.plotSegments = []; st.deleted = {}; st.deletedH = {};
        sweepMod.entryIndexInit();
        rtMod.cfg.plotSegmentBatchAtoms = 2;
        rtMod.cfg.plotSegmentIncremental = false;
        payload = SAMPLE;
        const b1 = calls;
        const r1 = await entry.popupAction('summary', { summary: 'plotSegments' });
        const note1 = String(((r1.state || {}).note) || '');
        const segs1 = (st.plotSegments || []).slice();
        const body1 = String(recallMod.buildMemoryBodyForInject() || '');
        const okAll = calls >= b1 + 1 && segs1.length === 2 && note1.indexOf('新增 2 段') >= 0
            && segs1.every((x) => x && x.header && (x.lines || []).length)
            && body1.indexOf('### 1899-03-01') < 0 && body1.indexOf('感情线') < 0;
        // 多选「🧩 分段总结」：与已有区间不重叠的新段 → 只增（同区间批次跳过）
        await entry.popupAction('tab', { tab: 'atoms' });
        await entry.popupAction('multiToggle', { kind: 'atoms' });
        await entry.popupAction('selectAll', { kind: 'atoms' });
        payload = NEXT;
        const b2 = calls;
        const r2 = await entry.popupAction('plotSegmentSummarySel', {});
        const note2 = String(((r2.state || {}).note) || '');
        const afterSel = (st.plotSegments || []).length;
        const okSel = calls >= b2 + 1 && afterSel === 3 && note2.indexOf('新增 1 段') >= 0
            && note2.indexOf('分段总结') >= 0 && (st.plotSegments || []).every((x) => x.id !== 'smoke-ac-p1');
        await entry.popupAction('multiToggle', { kind: 'atoms' });
        await entry.popupAction('selectNone', { kind: 'atoms' });
        // 清理：清空 + 留墓碑
        const tombsBefore = Object.keys((st.deleted || {}).plotSegments || {}).length;
        const r3 = await entry.popupAction('clearPlotSegments', {});
        const note3 = String(((r3.state || {}).note) || '');
        const tombsAfter = Object.keys((st.deleted || {}).plotSegments || {}).length;
        const okClear = (st.plotSegments || []).length === 0 && tombsBefore === 0 && tombsAfter === 3
            && note3.indexOf('已清理 3 段分段总结') >= 0;
        const body2 = String(recallMod.buildMemoryBodyForInject() || '');
        return okAll && okSel && okClear && body2.indexOf('### 1899-06-01') < 0;
    } finally { host.ctx.generateRaw = origGen; }
})(), '');

// ---------- AD 平行推演 + 推进 + 转正（B8-7-b） ----------
await assert('AD1 平行事件接线齐备：FTT.* 入口（15 项）+ 总览「🧭 推演世界」紧贴「📤 提取记忆」右侧 / 平行页「🚀 全部推进」「🚀」「⬆ 转正为情节」文案与 title 与 V1 逐字一致（已转正不显示 ⬆、未开启开关给提示）', (async () => {
    const F = globalThis.FTT;
    const names = ['weaveEnabled', 'weavePassiveDue', 'weaveInputSig', 'matchParallelsByKeywords', 'scheduleParallelWeave',
        'runParallelWeave', 'advanceContextSeed', 'buildAdvanceContext', 'buildAdvancePrompt', 'applyAdvanceUpdate',
        'runParallelAdvance', 'promoteParallelEvent', 'prunePromotedParallels', 'setParallelLastKeywords', 'parallelLastKeywords'];
    const missing = names.filter((n) => typeof F[n] !== 'function');
    const st = rtMod.state;
    st.parallels = [
        { id: 'smoke-par-1', title: '黑市风声', text: '码头有人私下交易军械。', type: '阴谋', date: '1919-11-29', tags: ['黑市'], characters: ['角色甲'] },
        { id: 'smoke-par-2', title: '远方的战争', text: '北方边境的冲突可能波及本地。', type: '背景', tags: ['战争'] },
    ];
    await entry.popupAction('tab', { tab: 'overview' });
    let h = String((await entry.popupAction('refresh', {})).html || '');
    const a = h.indexOf('data-ftt-action="extractNow"');
    const b = h.indexOf('data-ftt-action="parallelWeaveNow"');
    const overviewOk = a >= 0 && b > a && h.indexOf('id="ftt-weave-btn"') >= 0
        && h.indexOf('>🧭 推演世界</button>') >= 0 && h.indexOf('title="手动触发平行事件推演（独立交织管线）"') >= 0;
    await entry.popupAction('tab', { tab: 'parallels' });
    h = String((await entry.popupAction('refresh', {})).html || '');
    const parOk = h.indexOf('data-ftt-action="parallelAdvanceAll"') >= 0
        && h.indexOf('title="全部平行事件交 AI 逐一推进"') >= 0 && h.indexOf('🚀 全部推进') >= 0
        && h.indexOf('data-ftt-action="parallelAdvance" data-id="smoke-par-1"') >= 0
        && h.indexOf('title="推进该事件（附带记忆数据作种子）"') >= 0
        && h.indexOf('data-ftt-action="promoteParallel" data-id="smoke-par-1"') >= 0
        && h.indexOf('title="转正为情节（需确认）"') >= 0 && h.indexOf('⬆ 转正为情节') >= 0
        && h.indexOf('仅幕后（角色不知情）') >= 0;
    // 已转正 → 该条不显示 ⬆ 按钮 + 备注「 · 已转正为情节」（按真实 id 定位）
    st.parallels[0].promotedTo = 'atom_from_v1';
    h = String((await entry.popupAction('refresh', {})).html || '');
    const promotedOk = h.indexOf('data-ftt-action="promoteParallel" data-id="smoke-par-1"') < 0
        && h.indexOf(' · 已转正为情节') >= 0
        && h.indexOf('data-ftt-action="promoteParallel" data-id="smoke-par-2"') >= 0;
    st.parallels[0].promotedTo = '';
    // 开关未开启 → V1 逐字提示（提示读 r.state.note）
    rtMod.cfg.parallelWeaveEnabled = false;
    const off = await entry.popupAction('parallelWeaveNow', {});
    const offNote = String(((off.state || {}).note) || '');
    rtMod.cfg.parallelWeaveEnabled = true;
    return missing.length === 0 && overviewOk && parOk && promotedOk && offNote === '🧭 推演世界未开启（设置→提取记忆→推演世界）';
})(), '');

await assert('AD2 面板「🧭 推演世界」端到端：AI 桩返回「平行事件」增量 → 新增 1 / 更新 1 落库（提示读 r.state.note），触发提示词含平行事件模板与最近关键词', (async () => {
    const st = rtMod.state;
    const origGen = host.ctx.generateRaw;
    let calls = 0, prompt = '';
    const payload = JSON.stringify({
        平行事件: {
            新增: [{ 标题: '码头军械暗流', 正文: '码头黑市或已流入一批军械，牵动本地势力。', 卦象: '坎', 因果线: '木箱断口 → 黑市军械', 类型: '阴谋', 日期: '1919-11-30', 标签: ['黑市', '军械'], 涉及角色: ['角色甲'] }],
            更新: [{ 标题: '黑市风声', 正文: '交易升级：军械已进入码头仓库，买家开始催货。', 因果线: '木箱断口 → 黑市 → 仓库中转' }],
        },
    });
    host.ctx.generateRaw = async (args) => { calls++; try { prompt = JSON.stringify(args || {}); } catch (e) { prompt = ''; } return payload; };
    try {
        st.atoms = [{ id: 'smoke-pw-a1', title: '发现木箱', text: '甲在码头发现一只木箱，断口整齐，来源不明。', validity: 'active', tags: ['码头'], date: '1919-11-29' }];
        st.parallels = [{ id: 'smoke-par-w1', title: '黑市风声', text: '码头有人私下交易。', tags: ['黑市'], gua: '坎', causalLine: '木箱 → 黑市' }];
        rtMod.cfg.parallelWeaveEnabled = true;
        globalThis.FTT.setParallelLastKeywords(['码头']);
        const base = calls;
        const r = await entry.popupAction('parallelWeaveNow', {});
        const note = String(((r.state || {}).note) || '');
        const added = (st.parallels || []).find((p) => String(p.title) === '码头军械暗流');
        const updated = (st.parallels || []).find((p) => String(p.id) === 'smoke-par-w1');
        const ok = calls === base + 1 && note.indexOf('推演世界完成：新增 1 / 更新 1') >= 0
            && !!added && String(added.gua) === '坎' && !!updated && String(updated.text).indexOf('军械已进入码头仓库') >= 0
            && prompt.indexOf('平行事件') >= 0 && prompt.indexOf('码头') >= 0 && prompt.indexOf('最近正文') >= 0;
        globalThis.FTT.setParallelLastKeywords([]);
        return ok;
    } finally { host.ctx.generateRaw = origGen; }
})(), '');

await assert('AD3 面板「🚀 推进」+「⬆ 转正为情节」端到端：推进按 id 精确改写正文；转正生成情节、自动移除平行记录并留墓碑（提示读 r.state.note）', (async () => {
    const st = rtMod.state;
    const origGen = host.ctx.generateRaw;
    let payload = '';
    host.ctx.generateRaw = async () => payload;
    try {
        st.atoms = []; st.deleted = {}; st.deletedH = {};
        st.parallels = [
            { id: 'smoke-par-a1', title: '黑市风声', text: '码头有人私下交易军械。', type: '阴谋', tags: ['黑市'], characters: ['角色甲'], location: '码头' },
            { id: 'smoke-par-a2', title: '远方的战争', text: '北方边境的冲突可能波及本地。', type: '背景', tags: ['战争'], characters: ['角色乙'] },
        ];
        // ① 单条推进：AI 按真实 id 返回新阶段正文
        payload = JSON.stringify({ 推进: [{ id: 'smoke-par-a1', 正文: '黑市交易升级，军械已进入码头仓库，官府开始留意。', 因果线: '木箱 → 黑市 → 仓库' }] });
        const r1 = await entry.popupAction('parallelAdvance', { id: 'smoke-par-a1' });
        const note1 = String(((r1.state || {}).note) || '');
        const hit = (st.parallels || []).find((p) => p.id === 'smoke-par-a1');
        const okAdv = note1.indexOf('🚀 平行事件推进完成：更新 1/1 条') >= 0
            && !!hit && String(hit.text).indexOf('军械已进入码头仓库') >= 0;
        // ② 转正（关闭确认开关：无对话框环境下 V1 口径为「取消」）
        rtMod.cfg.parallelPromoteConfirm = false;
        const atomsBefore = (st.atoms || []).length;
        const r2 = await entry.popupAction('promoteParallel', { id: 'smoke-par-a1' });
        const note2 = String(((r2.state || {}).note) || '');
        const tombs = Object.keys(((st.deleted || {}).parallels) || {});
        const okPromote = (st.atoms || []).length === atomsBefore + 1
            && !(st.parallels || []).some((p) => String(p.id) === 'smoke-par-a1')
            && tombs.indexOf('smoke-par-a1') >= 0
            && note2.indexOf('已转正为情节') >= 0 && note2.indexOf('自动移除') >= 0;
        // ③ 恢复确认开关；全部推进在空库时如实提示
        rtMod.cfg.parallelPromoteConfirm = true;
        st.parallels = [];
        const r3 = await entry.popupAction('parallelAdvanceAll', {});
        const note3 = String(((r3.state || {}).note) || '');
        return okAdv && okPromote && note3 === '⏳ 当前没有平行事件';
    } finally { host.ctx.generateRaw = origGen; }
})(), '');

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
uninstallFetch();      // 收尾：卸掉「服务端文件通道 / 更新检查」共用的 fetch 桩
console.log('\n========== V2 冒烟：' + pass + ' 通过, ' + fail + ' 失败 ==========');
if (fail) { console.log('  失败项：' + failures.join(' | ')); process.exit(1); }
process.exit(0);
