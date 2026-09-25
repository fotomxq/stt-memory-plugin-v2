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
import { panelState, panelBodyHtml, setPanelHooks2 } from '../ui/panel.js';
import * as fttPanelMod from '../ui/panel.js';   // v2.38.0：按钮 type 加固 / 滚动保持断言用（避免与既有 panelMod 重名）   // v2.34.0：子标签点击/异常区断言用

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const failures = [];
const pendingGuards = [];   // v2.34.0：thenable 断言的收尾 flush 登记表
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
        // v2.34.0：供收尾统一 flush —— **不置 `awaited`**，故「调用点漏写 await」仍会被防呆抓到；
        //   修复背景：未 await 的 thenable 断言若排在文件末尾，`process.exit(0)` 会在防呆微任务前结束进程，
        //   导致该断言既不计数也不报错（静默消失）。收尾 flush 后此类断言一定被计入失败。
        settle() { return running; },
    };
    pendingGuards.push(guard);
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

/** 数组/对象比较助手（B9-c 起的小节用；与单测同写法） */
const J = (v) => JSON.stringify(v);

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
// B9-a：关于页的版本清单（测试内可切换「扩展目录里有 / 没有」两态）
let aboutJsonText = '';
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
    // B9-a 关于页：版本清单按扩展目录（或相对路径）读取；`aboutJsonText` 为空 → 404（如实失败路径）
    if (url.indexOf('FTT-memory-changelog.json') >= 0) return aboutJsonText ? { status: 200, text: aboutJsonText } : { status: 404, body: {} };
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

await assert('M2 /ftt 状态含「界面：V1 同构浮层」与装配/面板/菜单诊断', (async () => {
    const cmd = (host.ctx.commands || []).filter((c) => c.name === 'ftt')[0] || {};
    // v2.42.0：命令回调经追踪包装 → async，须 await
    const out = String(typeof cmd.callback === 'function' ? await cmd.callback() : '');
    return out.indexOf('界面：V1 同构浮层') >= 0 && out.indexOf('抽屉卡片 关') >= 0
        && out.indexOf('装配：已初始化') >= 0 && out.indexOf('菜单入口：') >= 0;
})(), '');

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

await assert('B5 /ftt 命令注册且回调可执行（回调经追踪包装 → await）', (async () => {
    const cmd = (host.ctx.commands || [])[0];
    const out = (cmd && typeof cmd.callback === 'function') ? String(await cmd.callback()) : '';
    return !!cmd && cmd.name === 'ftt' && out.indexOf(VERSION) >= 0;
})(), '');

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
await assert('E7 /ftt 状态输出含更新行', (async () => {
    const cmd = (host.ctx.commands || [])[0] || {};
    const out = String(typeof cmd.callback === 'function' ? await cmd.callback() : '');
    return out.indexOf('更新：') >= 0;
})(), '');
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

await assert('F5 /ftt 状态含 V1 导入行', (async () => {
    const cmd = (host.ctx.commands || []).filter((c) => c.name === 'ftt')[0] || {};
    const out = String(typeof cmd.callback === 'function' ? await cmd.callback() : '');
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
// P9d 隔离：本次接线后「提取合并成功」会自动排程被动推演（1.8s）——若在此后各小节仍开着，
//   定时器会在无关小节里发起 AI 请求、污染各节的调用计数；故常规链路默认关闭被动推演，
//   该接线由 AI2/AI3 小节用**注入定时器**显式驱动验证。
rt.cfg.parallelWeaveEnabled = false;
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
        return list.indexOf('待分析楼层') >= 0 && one.indexOf('分析完成') >= 0 && String(await st.callback()).indexOf('提取：') >= 0;
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
        const stCmd = (host.ctx.commands || []).filter((c) => c.name === 'ftt')[0] || {};
        const stOut = String(typeof stCmd.callback === 'function' ? await stCmd.callback() : '');
        return floorsMod.isFloorProcessed(newFloor) === true && stOut.indexOf('提取：') >= 0;
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

await assert('K2 文案查询与状态行：t() 按当前语言取词（缺失回退键本身，支持占位变量），/ftt 含语言行', (async () => {
    host.ctx.locale = 'en';
    const en = globalThis.FTT.t('保存');
    const enMissing = globalThis.FTT.t('不存在的键');
    host.ctx.locale = 'zh-cn';
    const zh = globalThis.FTT.t('保存');
    const withVar = i18nMod.t('分析完成：成功 {n} / {m}', { n: 2, m: 3 });
    const k2cmd = (host.ctx.commands || []).filter((c) => c.name === 'ftt')[0] || {};
    const statusLine = String(typeof k2cmd.callback === 'function' ? await k2cmd.callback() : '').indexOf('语言：') >= 0;
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

// ---------- AE 调试页 + 关于页 + reset（B9-a） ----------
await assert('AE1 调试页：V1 同款控件与日志查看器（计数/类别标签/逐条 details/清空按钮）+ `dbgClear` 动作清空并如实回报；FTT.* 入口齐备', (async () => {
    const F = globalThis.FTT;
    const names = ['dbgLog', 'dbgGet', 'dbgLogGet', 'dbgClear', 'debugLogStats', 'aboutLoad', 'aboutEnsureLoaded',
        'aboutState', 'aboutData', 'aboutHtml', 'aboutClearCache', 'aboutCandidateUrls', 'aboutSortDesc', 'aboutFallback',
        'aboutJsonPaths', 'aboutInfo', 'aboutDirUrl', 'resetState'];
    const missing = names.filter((n) => typeof F[n] !== 'function');
    // 调试日志持久层桩（本小节内注入并在小节内清理）
    const lsMap = new Map();
    const ls = {
        getItem: (k) => (lsMap.has(String(k)) ? lsMap.get(String(k)) : null),
        setItem: (k, v) => { lsMap.set(String(k), String(v)); },
        removeItem: (k) => { lsMap.delete(String(k)); },
    };
    const keepLs = globalThis.window && globalThis.window.localStorage;
    globalThis.window.localStorage = ls;
    try {
        F.dbgClear();
        rtMod.cfg.debugEnabled = true;
        F.dbgLog('摘要', { action: '单楼分析完成', floor: 3, added: 2, ms: 120 });
        F.dbgLog('对账', { action: '常规镜像写入', bytes: 825 });
        const stats = F.debugLogStats();
        const stored = ls.getItem('SPreset_FTTMemoryDebug');
        await entry.popupAction('settingsSub', { sub: 'debug' });
        let h = String((await entry.popupAction('refresh', {})).html || '');
        const pageOk = h.indexOf('data-ftt-settings-page="debug"') >= 0 && h.indexOf('data-ftt-cfg="debugEnabled"') >= 0
            && h.indexOf('关闭后不再记录新日志；已存日志仍可查看。') >= 0
            && h.indexOf('data-ftt-action="dbgClear"') >= 0 && h.indexOf('🗑 清空日志') >= 0
            && h.indexOf('共 2 条') >= 0 && h.indexOf('（最多 300 条，最新在上；点击展开详情）') >= 0
            && h.indexOf('class="ftt-dbg-item"') >= 0 && h.indexOf('🧠 分析记忆 1') >= 0 && h.indexOf('🔄 存储对账 1') >= 0
            && h.indexOf('单楼分析完成') >= 0;
        rtMod.cfg.debugEnabled = false;
        const offRet = F.dbgLog('摘要', '关闭时不记录');
        rtMod.cfg.debugEnabled = true;
        // 面板动作 `dbgClear`：清空内存 + 持久层，note 读 r.state.note
        const c = await entry.popupAction('dbgClear', {});
        const note = String(((c.state || {}).note) || '');
        const after = F.dbgGet();
        const clearedOk = c.ok === true && note === '已清空调试日志'
            && c.cleared === 2 && after.length === 0 && JSON.parse(ls.getItem('SPreset_FTTMemoryDebug')).length === 0;
        h = String((await entry.popupAction('refresh', {})).html || '');
        const emptyOk = h.indexOf('暂无日志。运行「AI 摘要」或「自动修复」后在此显示。') >= 0;
        return missing.length === 0 && stats.n === 2 && stats.cap === 300 && typeof stored === 'string'
            && pageOk && offRet === false && clearedOk && emptyOk;
    } finally {
        if (keepLs === undefined) delete globalThis.window.localStorage; else globalThis.window.localStorage = keepLs;
        try { globalThis.FTT.dbgClear(); } catch (e) { /* 忽略 */ }
    }
})(), '');

await assert('AE2 关于页：按**扩展目录**读取版本清单（成功态：来源/计数/倒序条目/按钮）+ 清缓存删键复位；清单缺失时如实失败不伪造数据', (async () => {
    const F = globalThis.FTT;
    const lsMap = new Map();
    const ls = {
        getItem: (k) => (lsMap.has(String(k)) ? lsMap.get(String(k)) : null),
        setItem: (k, v) => { lsMap.set(String(k), String(v)); },
        removeItem: (k) => { lsMap.delete(String(k)); },
    };
    const keepLs = globalThis.window && globalThis.window.localStorage;
    globalThis.window.localStorage = ls;
    try {
        // 候选地址：扩展目录绝对路径优先 + V1 同款相对路径
        const cands = F.aboutCandidateUrls();
        const dir = F.aboutDirUrl();
        const candOk = dir === '/scripts/extensions/third-party/ftt-memory-v2/'
            && cands[0] === dir + 'FTT-memory-changelog.json'
            && JSON.stringify(F.aboutJsonPaths()) === JSON.stringify(['FTT-memory-changelog.json', './FTT-memory-changelog.json']);
        // ① 清单缺失 → 如实失败（不伪造版本数据）
        aboutJsonText = '';
        F.aboutClearCache();
        const bad = await entry.popupAction('aboutReload', {});
        const badNote = String(((bad.state || {}).note) || '');
        const failOk = bad.ok === false && badNote.indexOf('未能读取版本清单') === 0
            && badNote.indexOf(dir) > 0 && F.aboutState().status === 'fail' && F.aboutData().fallback === true
            && (F.aboutData().changelog || []).length === 0;
        // ② 清单存在 → 成功读取（来源 = 扩展目录首个候选）+ 写本地缓存
        aboutJsonText = JSON.stringify({
            name: 'FTT记忆组件', title: '示例标题', version: VERSION, updatedAt: '2026-09-26',
            intro: { what: '示例说明', highlights: ['甲'], entries: ['乙'], notes: '丙' },
            changelog: [
                { version: '1.0.0', date: '2024-01-01', title: '首个版本', points: ['建立记忆容器'] },
                { version: '0.9.0', date: '2023-12-01', title: '预发布', points: [] },
            ],
        });
        const ok = await entry.popupAction('aboutReload', {});
        const okNote = String(((ok.state || {}).note) || '');
        const st = F.aboutState();
        const cacheRaw = ls.getItem('fttAboutJson');
        const okOk = ok.ok === true && okNote.indexOf('版本清单已更新') === 0 && okNote.indexOf('共 2 个版本') > 0
            && st.status === 'ok' && st.from === dir + 'FTT-memory-changelog.json' && !!cacheRaw
            && F.aboutSortDesc(F.aboutData().changelog).map((e) => e.version).join(',') === '1.0.0,0.9.0';
        // ③ 页面渲染（停在「关于」子页）
        await entry.popupAction('settingsSub', { sub: 'about' });
        const h = String((await entry.popupAction('refresh', {})).html || '');
        const htmlOk = h.indexOf('data-ftt-settings-page="about"') >= 0
            && h.indexOf('关于 · FTT记忆组件') >= 0 && h.indexOf('它是什么') >= 0 && h.indexOf('版本更新（倒序 · 最新在最前）') >= 0
            && h.indexOf('data-ftt-action="aboutReload"') >= 0 && h.indexOf('🔄 重新获取') >= 0
            && h.indexOf('data-ftt-action="aboutClearCache"') >= 0 && h.indexOf('🧹 清除本地缓存') >= 0
            && h.indexOf('✅ 版本清单已读取 · 2 个版本') >= 0 && h.indexOf('共 2 个版本') >= 0
            && h.indexOf('首个版本') >= 0 && h.indexOf('建立记忆容器') >= 0
            && h.indexOf('内核配置键：') >= 0;      // V2 附加信息块
        // ④ 清缓存：先等「页面停在关于子页」触发的自动读取落定（渲染即自动读取并回写缓存）
        await new Promise((r) => setTimeout(r, 60));
        const hadCache = ls.getItem('fttAboutJson') !== null;
        const removedNow = F.aboutClearCache();
        const directOk = hadCache === true && removedNow === true && ls.getItem('fttAboutJson') === null
            && F.aboutData() === null && F.aboutState().status === 'idle' && F.aboutState().ts === 0;
        // 动作路径（V1 同名 `aboutClearCache`）：如实回报；此后面板重绘会再自动读一次（V1 同行为）
        aboutJsonText = '';
        const cleared = await entry.popupAction('aboutClearCache', {});
        const clearNote = String(((cleared.state || {}).note) || '');
        const clearOk = directOk && cleared.ok === true && clearNote.indexOf('已清除版本清单本地缓存') === 0;
        // ⑤ 恢复：切回总览（避免影响后续小节）
        await entry.popupAction('tab', { tab: 'overview' });
        return candOk && failOk && okOk && htmlOk && clearOk;
    } finally {
        aboutJsonText = '';
        if (keepLs === undefined) delete globalThis.window.localStorage; else globalThis.window.localStorage = keepLs;
        try { globalThis.FTT.aboutClearCache(); } catch (e) { /* 忽略 */ }
    }
})(), '');

await assert('AE3 数据管理 `reset`：按钮与 V1 逐字一致；确认文案逐字一致；无对话框时不执行（取消态如实提示）、确认后清空并留「先导出备份」提示', (async () => {
    const F = globalThis.FTT;
    const st = rtMod.state;
    st.atoms = [{ id: 'smoke-ae-a1', title: '甲', text: '角色甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29', validity: 'active' }];
    st.memories = [{ id: 'smoke-ae-m1', title: '木箱', content: '甲记得木箱断口整齐。' }];
    st.deleted = {}; st.deletedH = {};
    // ① 数据管理页按钮（文案与 V1 逐字一致）
    await entry.popupAction('settingsSub', { sub: 'data' });
    const h = String((await entry.popupAction('refresh', {})).html || '');
    const btnOk = h.indexOf('data-ftt-action="reset"') >= 0 && h.indexOf('>🗑 清空当前角色记忆</button>') >= 0
        && h.indexOf('data-ftt-action="exportState"') >= 0;
    // ② 无对话框 → 不执行（V1 口径），如实提示
    //   v2.41.0：确认走 `hostConfirm` —— 优先酒馆弹窗（`ctx.callGenericPopup`），故这里把**两层**都撤掉
    const keepConfirm = globalThis.confirm;
    const keepPopup = host.ctx.callGenericPopup;
    delete globalThis.confirm;
    delete host.ctx.callGenericPopup;
    const r1 = await entry.popupAction('reset', {});
    const n1 = String(((r1.state || {}).note) || '');
    const stillThere = (rtMod.state.atoms || []).length === 1;
    const cancelOk = r1.ok === false && r1.reason === 'cancelled' && n1 === '已取消清空（记忆未改动）' && stillThere;
    // ③ 有确认 → 清空全部容器 + 不产生整批墓碑 + 如实回报
    let seen = '';
    host.ctx.callGenericPopup = async (text) => { seen = String(text); return 1; };   // 酒馆弹窗返回 1 = 确认
    const r2 = await entry.popupAction('reset', {});
    const n2 = String(((r2.state || {}).note) || '');
    // 注意：`resetState()` 会**整体替换**内核 state 对象 → 必须重新读 `rtMod.state`（旧引用仍是清空前的容器）
    const st2 = rtMod.state;
    const emptyOk = (st2.atoms || []).length === 0 && (st2.memories || []).length === 0
        && Object.keys(st2.deleted || {}).length === 0 && Object.keys(st2.deletedH || {}).length === 0;
    const confirmOk = seen === '确认清空当前角色的 FTT 记忆？此操作不可恢复，建议先导出备份。';
    const resOk = r2.ok === true && r2.action === 'reset' && n2.indexOf('已清空当前角色的 FTT 记忆') === 0
        && n2.indexOf('条已清除') > 0 && typeof F.resetState === 'function';
    if (keepConfirm === undefined) delete globalThis.confirm; else globalThis.confirm = keepConfirm;
    if (keepPopup === undefined) delete host.ctx.callGenericPopup; else host.ctx.callGenericPopup = keepPopup;
    await entry.popupAction('tab', { tab: 'overview' });
    return btnOk && cancelOk && emptyOk && confirmOk && resOk;
})(), '');

// ---------- AF 关系表定位跳转 + 选角色（B9-b） ----------
await assert('AF1 关系表定位/选角色 FTT 入口齐备：setRelPick 归一与副本、relFilterState/setRelFilter、relClearFilter 四项清空、relKnownNames 只读角色档案、relPickAppendRow 三态（成功 / dup / 容器缺失）', (async () => {
    const F = globalThis.FTT;
    const names = ['relPickState', 'setRelPick', 'relFilterState', 'setRelFilter', 'relClearFilter', 'relPickQuery', 'setRelPickQuery',
        'relKnownNames', 'relPickAppendRow', 'relPickPanelHtml', 'relEntryTitle', 'relFindEntryId', 'relIsRelDim', 'relDimLabelOf',
        'relJump', 'relGoto'];
    const missing = names.filter((n) => typeof F[n] !== 'function');
    const st = rtMod.state;
    st.snapshots = [{ id: 'smoke-af-s1', name: '甲角色' }, { id: 'smoke-af-s2', name: '乙角色' }, { id: 'smoke-af-s3', name: '甲角色' }];
    st.memories = [{ id: 'smoke-af-m1', owner: '甲角色', title: '关系定位记忆', content: '正文用于标题拼接。' }];
    st.links = [];
    // 已知角色只读角色档案（重名去重）
    const known = F.relKnownNames();
    // setRelPick：id 字符串化 / editor 布尔化 / 返回副本
    const pick = F.setRelPick({ dim: 'memories', id: 5, editor: 0 });
    const mut = F.relPickState(); mut.id = 'HACKED';
    const pickOk = pick.dim === 'memories' && pick.id === '5' && pick.editor === false && F.relPickState().id === '5';
    // setRelFilter：jump 归一（id 7 → '7'，title null → ''）
    const filter = F.setRelFilter('memories', '甲角色', { dim: 'plans', id: 7, title: null });
    const filterOk = filter.who === '甲角色' && filter.jump && filter.jump.id === '7' && filter.jump.title === '';
    // relJump 状态迁移 + relClearFilter 四项清空
    const jump = F.relJump('memories', 'smoke-af-m1');
    const jumpOk = jump.ok === true && jump.tab === 'memories' && F.relFilterState().jump
        && F.relFilterState().jump.title === '关系定位记忆：正文用于标题拼接。';
    const cleared = F.relClearFilter();
    const clearedOk = cleared.dim === 'all' && cleared.who === '' && cleared.jump === null && F.relPickState() === null;
    // relPickAppendRow 三态（V2 适配签名：dim + refId；「容器缺失」= 条目引用为空）
    const a1 = F.relPickAppendRow('memories', 'smoke-af-m1', '甲角色');
    const a2 = F.relPickAppendRow('memories', 'smoke-af-m1', '甲角色');
    const a3 = F.relPickAppendRow('memories', '', '甲角色');
    const a4 = F.relPickAppendRow('atoms', 'smoke-af-m1', '甲角色');
    const rowOk = a1 === true && a2 === 'dup' && a3 === false && a4 === false;
    const noteOk = F.relEntryTitle('memories', st.memories[0]) === '关系定位记忆：正文用于标题拼接。'
        && F.relFindEntryId('memories', { id: 'smoke-af-m1' }) === 'smoke-af-m1'
        && F.relIsRelDim('memories') === true && F.relIsRelDim('atoms') === false && F.relDimLabelOf('suspense') === '悬念';
    // 落库：草稿 → 「💾 保存关联」（同时按 V1 关闭选择器）
    const sv = await entry.popupAction('relSave', { kind: 'memories', id: 'smoke-af-m1' });
    const savedOk = sv.ok === true && sv.saved === 1 && (st.links || []).filter((x) => x && x.dim === 'memories' && x.refId === 'smoke-af-m1').length === 1
        && F.relPickState() === null;
    return missing.length === 0 && known.length === 2 && known[0] === '甲角色' && known[1] === '乙角色'
        && pickOk && filterOk && jumpOk && clearedOk && rowOk && noteOk && savedOk;
})(), '');

await assert('AF2 面板编排：条目行「🔗 关联（N）」；`relJump` 切到条目所在页 + 维度子标签置 rel + 定位提示 + 「清除筛选」；`relWho` 只写角色筛选（不再顺带开编辑器）；`relGoto` 把该页搜索词设为条目标题（悬念→计划悬念页）', (async () => {
    const F = globalThis.FTT;
    const st = rtMod.state;
    st.memories = [{ id: 'smoke-af-m2', owner: '甲角色', title: '码头见闻', content: '甲在码头看到木箱。' }];
    st.plans = [{ id: 'smoke-af-p1', title: '追查货单', content: '追查货单来源', status: 'open' }];
    st.suspense = [{ id: 'smoke-af-su1', title: '断口之谜', content: '断口来源不明', status: 'open' }];
    st.parallels = [{ id: 'smoke-af-pa1', title: '第三方插手', text: '若木箱属第三方。' }];
    st.links = [{ id: 'smoke-af-l1', dim: 'memories', refId: 'smoke-af-m2', who: '甲角色', how: 'participant', deviation: 'unknown' }];
    await entry.popupAction('tab', { tab: 'memories' });
    await entry.popupAction('msub', { tab: 'memories', sub: 'list' });
    const listHtml = String((await entry.popupAction('refresh', {})).html || '');
    const btnOk = listHtml.indexOf('data-ftt-action="relJump"') >= 0
        && listHtml.indexOf('data-kind="memories" data-id="smoke-af-m2"') >= 0
        && listHtml.indexOf('🔗 关联（1）') >= 0;
    // relJump：悬念条目 → 计划悬念页 + 悬念段子标签置 rel（V2 页面即维度的落点）
    const j = await entry.popupAction('relJump', { kind: 'suspense', id: 'smoke-af-su1' });
    const js = j.state || {}, jh = String(j.html || '');
    const jumpOk = j.ok === true && js.tab === 'plans' && js.relSub && js.relSub.suspense === 'rel'
        && String(js.note).indexOf('已定位到关系表：悬念') === 0
        && jh.indexOf('当前筛选：定位 悬念「断口之谜：断口来源不明') >= 0
        && jh.indexOf('data-ftt-action="relClearFilter"') >= 0
        && jh.indexOf('data-ftt-rel-entry="suspense|smoke-af-su1"') >= 0;      // 定位目标即使暂无关联也列出
    // relWho：只写角色筛选（V1 口径；V2 早期会顺带打开编辑器 → 本批更正）
    const w = await entry.popupAction('relWho', { who: '甲角色' });
    const whoOk = (w.state || {}).relWho === '甲角色' && (w.state || {}).editing === null
        && F.relFilterState().who === '甲角色';
    // 选择器态 + 定位态 → relClearFilter 一起清
    await entry.popupAction('relPick', { kind: 'suspense', id: 'smoke-af-su1' });
    const cl = await entry.popupAction('relClearFilter', {});
    const clOk = cl.ok === true && String((cl.state || {}).note) === '已清除关系表筛选'
        && F.relFilterState().who === '' && F.relFilterState().jump === null && F.relPickState() === null;
    // relGoto：悬念 → 计划悬念页，搜索词写在该页（V1 tabOf 映射）
    const g = await entry.popupAction('relGoto', { kind: 'suspense', id: 'smoke-af-su1' });
    const gs = g.state || {};
    const gotoOk = g.ok === true && gs.tab === 'plans' && gs.search.plans === '断口之谜'
        && String(gs.note).indexOf('已定位到「断口之谜」') === 0 && F.relFilterState().jump === null;
    return btnOk && jumpOk && whoOk && clOk && gotoOk;
})(), '');

await assert('AF3 选角色闭环：面板结构（角色档案点名 / ➕ / 关闭 / 搜索 / 已关联角标）→ `relPickAdd` 三态提示（成功·重复·容器缺失，与 V1 逐字一致）→ 追加进草稿 → 「💾 保存关联」落库并在关系总览出现', (async () => {
    const F = globalThis.FTT;
    const st = rtMod.state;
    st.snapshots = [{ id: 'smoke-af-s1', name: '甲角色' }, { id: 'smoke-af-s2', name: '乙角色' }];
    st.memories = [{ id: 'smoke-af-m3', owner: '甲角色', title: '仓库清点', content: '乙清点仓库。' }];
    st.links = [];
    await entry.popupAction('relJump', { kind: 'memories', id: 'smoke-af-m3' });
    await entry.popupAction('relPick', { kind: 'memories', id: 'smoke-af-m3' });
    const h = String((await entry.popupAction('refresh', {})).html || '');
    const panelOk = h.indexOf('data-ftt-rel-pick="memories|smoke-af-m3"') >= 0
        && h.indexOf('data-ftt-action="relPickAdd"') >= 0
        && h.indexOf('data-ftt-action="relPickClose"') >= 0
        && h.indexOf('data-ftt-search="relPick"') >= 0
        && h.indexOf('👥 选角色 · 加到「记忆」的关联（角色档案 2 名）') >= 0
        && h.indexOf('只从<b>角色档案</b>点名') >= 0
        && h.indexOf('不遍历记忆 / 计划 / 悬念 / 平行条目') >= 0;
    // 「已在关联」角标：先给该条目一条库内关联
    st.links = [{ id: 'smoke-af-l2', dim: 'memories', refId: 'smoke-af-m3', who: '甲角色', how: 'participant', deviation: 'unknown' }];
    const h2 = String((await entry.popupAction('refresh', {})).html || '');
    const badgeOk = h2.indexOf('已在关联') >= 0;
    // 搜索框分流：不污染列表页搜索（V1 `pageSearchQuery['relPick']` 独立）
    await entry.popupAction('relPickQuery', { q: '乙' });
    const h3 = String((await entry.popupAction('refresh', {})).html || '');
    const searchOk = h3.indexOf('data-name="乙角色"') >= 0 && h3.indexOf('data-name="甲角色"') < 0
        && String(F.relFilterState().who) === ''
        && (await entry.popupAction('search', { kind: 'memories', q: '' })).state.search.memories === '';
    await entry.popupAction('relPickQuery', { q: '' });
    // 三态提示（V1 toast 文案逐字一致）
    const a1 = await entry.popupAction('relPickAdd', { kind: 'memories', id: 'smoke-af-m3', name: '乙角色' });
    const n1 = String((a1.state || {}).note || '');
    const a2 = await entry.popupAction('relPickAdd', { kind: 'memories', id: 'smoke-af-m3', name: '乙角色' });
    const n2 = String((a2.state || {}).note || '');
    const a3 = await entry.popupAction('relPickAdd', { kind: 'memories', id: '', name: '乙角色' });
    const n3 = String((a3.state || {}).note || '');
    const noteOk = n1 === '已加角色「乙角色」—— 点「💾 保存关联」落库'
        && n2 === '「乙角色」已在关联表里（如需再加一行可手写）'
        && n3 === '未找到关联表容器（请重新打开该条目）'
        && a1.appended === true && a2.dup === true && a3.ok === false;
    const pickOpen = !!F.relPickState();
    // 保存落库 → 关系总览出现该角色（V1 `relSave` 同时关闭选择器）
    const sv = await entry.popupAction('relSave', { kind: 'memories', id: 'smoke-af-m3' });
    const savedRows = (st.links || []).filter((x) => x && x.dim === 'memories' && x.refId === 'smoke-af-m3').map((x) => String(x.who)).sort().join(',');
    const view = String((await entry.popupAction('refresh', {})).html || '');
    const saveOk = sv.ok === true && sv.saved === 2 && savedRows === '乙角色,甲角色'
        && view.indexOf('data-ftt-rel-entry="memories|smoke-af-m3"') >= 0 && view.indexOf('甲角色（亲历）') >= 0
        && F.relPickState() === null && pickOpen;
    await entry.popupAction('tab', { tab: 'overview' });     // 复位（不影响后续小节）
    return panelOk && badgeOk && searchOk && noteOk && saveOk;
})(), '');

// ---------- AG 投喂标签分析 + 货币追踪（B9-c） ----------
await assert('AG1 投喂标签「分析/收录/清空」+ 货币标定 FTT 入口齐备：归一/整表排重、`rxPushFeedTag` 四态（收录·重复·空·另一侧）、最新 AI 楼层扫描（成对标签 + 行内标记）、标定名单增删与选择器开关', (async () => {
    const F = globalThis.FTT;
    const names = ['latestAiFloorInfo', 'rxAnalyzeLatestText', 'rxNormTag', 'rxDedupeTagList', 'rxPushFeedTag',
        'rxTagScanHtml', 'rxTagScan', 'setRxTagScan', 'rxFeedTagLists', 'feedScanAction',
        'normalizeTrackedRoles', 'trackedCurrencyRoles', 'isTrackedCurrencyOwner', 'knownCharacterNames',
        'addTrackedCurrencyRole', 'removeTrackedCurrencyRole', 'clearTrackedCurrencyRoles', 'trackPickState', 'setTrackPick'];
    const missing = names.filter((n) => typeof F[n] !== 'function');
    // 夹具：一条带结构标签的 AI 楼层（楼层号按真实压入结果定位，不硬编码）
    const tagged = ['<content>', '【战斗】甲拔出武器。', '<thinking>他在想：是谁动的手？</thinking>', '<br>', '[状态] 体力 70', '</content>'].join('\n');
    host.ctx.chat.push({ is_user: false, role: 'assistant', mes: tagged, swipes: null });
    const floor = host.ctx.chat.length - 1;
    rtMod.setLastMessageId(floor);
    const info = F.latestAiFloorInfo();
    const scan = F.rxAnalyzeLatestText();
    const scanOk = info.floor === floor && info.text === tagged
        && scan.ok === true && scan.floor === floor && scan.chars === tagged.length
        && J(scan.tags.map((x) => x.name + ':' + x.paired)) === J(['content:true', 'thinking:true', 'br:false']);
    const markerOk = scan.markers.length === 2 && scan.markers.map((x) => x.name).indexOf('战斗') >= 0;
    const tagOk = F.rxNormTag('<content>') === 'content' && F.rxNormTag('【战斗】') === '战斗'
        && F.rxNormTag('  [状态] ') === '状态' && F.rxNormTag('甲'.repeat(50)).length === 40
        && J(F.rxDedupeTagList([' a ', 'A', '', 'b', 'b', '  '])) === J(['a', 'b'])
        && J(F.rxDedupeTagList(['<content>', 'CONTENT', '【战斗】', '战斗'])) === J(['content', '战斗']);
    // 收录四态（白/黑/重复/空；两条都验证「另一侧名单」提示）
    const keepWl = (rtMod.cfg.feedRegexWhitelist || []).slice();
    const keepBl = (rtMod.cfg.feedRegexBlacklist || []).slice();
    rtMod.cfg.feedRegexWhitelist = []; rtMod.cfg.feedRegexBlacklist = [];
    const p1 = F.rxPushFeedTag('white', '<content>');
    const wlAfterP1 = rtMod.cfg.feedRegexWhitelist.slice();
    const p2 = F.rxPushFeedTag('white', 'CONTENT');
    const p3 = F.rxPushFeedTag('black', '【战斗】');
    const blAfterP3 = rtMod.cfg.feedRegexBlacklist.slice();
    const p4 = F.rxPushFeedTag('black', 'content');
    const p5 = F.rxPushFeedTag('white', '   ');
    const pushOk = p1.added === true && p1.n === 1 && p1.other === false && J(wlAfterP1) === J(['content'])
        && p2.added === false && p2.reason === 'dup'
        && p3.added === true && J(blAfterP3) === J(['战斗'])
        && p4.added === true && p4.n === 2 && p4.other === true
        && p5.added === false && p5.reason === 'empty' && p5.n === 0;      // V1 原生：空标签分支 n 不计算
    const htmlOk = F.rxTagScanHtml().indexOf('📄 第 ' + floor + ' 楼 AI 正文') >= 0
        && F.rxTagScanHtml().indexOf('ftt-chip-btn--on-w') >= 0;
    rtMod.cfg.feedRegexWhitelist = keepWl; rtMod.cfg.feedRegexBlacklist = keepBl;
    // 货币标定：名单增删清空 + 选择器开关（V1 同名能力）
    const keepRoles = (rtMod.cfg.currencyTrackedRoles || []).slice();
    rtMod.cfg.currencyTrackedRoles = [];
    const st = rtMod.state;
    st.snapshots = [{ id: 'smoke-ag-s1', name: '甲角色', tags: ['主角'] }, { id: 'smoke-ag-s2', name: '乙角色', tags: [] }, { id: 'smoke-ag-s3', name: '甲角色', tags: [] }];
    const known = F.knownCharacterNames();
    F.addTrackedCurrencyRole('乙角色'); F.addTrackedCurrencyRole('乙角色');
    const added = J(F.trackedCurrencyRoles()) === J(['乙角色']);
    const hit = F.isTrackedCurrencyOwner(' 乙角色 ') === true && F.isTrackedCurrencyOwner('甲角色') === false;
    const removed = J(F.removeTrackedCurrencyRole('乙角色')) === J([]);
    F.addTrackedCurrencyRole('甲角色');
    const cleared = F.clearTrackedCurrencyRoles() === 1;
    const pick = F.trackPickState() === false && F.setTrackPick(true) === true && F.trackPickState() === true;
    F.setTrackPick(false);
    rtMod.cfg.currencyTrackedRoles = keepRoles;
    return missing.length === 0 && scanOk && markerOk && tagOk && pushOk && htmlOk
        && known.length === 2 && known.indexOf('甲角色') >= 0 && known.indexOf('乙角色') >= 0
        && added && hit && removed && cleared && pick;
})(), '');

await assert('AG2 面板编排：投喂页（扫描节 + 白/黑名单文本域 + `rxScanTags`/`rxAddTag` 落库与高亮）+ 货币页（「👥 指定角色」→ 选择器 → `curTrackToggle` → 胶囊与角标），提示读 `r.state.note`', (async () => {
    const F = globalThis.FTT;
    const keepWl = (rtMod.cfg.feedRegexWhitelist || []).slice();
    const keepBl = (rtMod.cfg.feedRegexBlacklist || []).slice();
    const keepRoles = (rtMod.cfg.currencyTrackedRoles || []).slice();
    rtMod.cfg.feedRegexWhitelist = []; rtMod.cfg.feedRegexBlacklist = []; rtMod.cfg.currencyTrackedRoles = [];
    F.setRxTagScan(null);
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'feed' });
    const feedHtml = String((await entry.popupAction('refresh', {})).html || '');
    const feedPageOk = feedHtml.indexOf('投喂标签自动分析') >= 0
        && feedHtml.indexOf('data-ftt-action="rxScanTags"') >= 0 && feedHtml.indexOf('data-ftt-action="rxScanClear"') >= 0
        && feedHtml.indexOf('🔍 分析最新正文结构') >= 0 && feedHtml.indexOf('清空结果') >= 0
        && feedHtml.indexOf('data-ftt-cfg="feedRegexWhitelist" class="ftt-textarea">') >= 0
        && feedHtml.indexOf('data-ftt-cfg="feedRegexBlacklist" class="ftt-textarea">') >= 0
        && feedHtml.indexOf('尚未分析') >= 0;                       // 未分析占位
    // 扫描 → 收录（白 + 黑）→ 文本域即时回显
    const sc = await entry.popupAction('rxScanTags', {});
    const noteScan = String((sc.state || {}).note || '');
    const hitFloor = String((sc.scan || {}).floor);
    const a1 = await entry.popupAction('rxAddTag', { kind: 'white', tag: '<content>' });
    const a2 = await entry.popupAction('rxAddTag', { kind: 'black', tag: '【战斗】' });
    const a3 = await entry.popupAction('rxAddTag', { kind: 'white', tag: 'CONTENT' });      // 大小写重复 → 排重
    const taggedHtml = String((await entry.popupAction('refresh', {})).html || '');
    const tagPageOk = sc.ok === true && noteScan.indexOf('已分析最新正文结构：第 ' + hitFloor + ' 楼 · ') === 0
        && String(a1.state.note) === '已加入白名单：content · 当前共 1 项'
        && String(a2.state.note) === '已加入黑名单：战斗 · 当前共 1 项'
        && String(a3.state.note) === '已在白名单中（自动排重）：CONTENT · 当前共 1 项'
        && J(rtMod.cfg.feedRegexWhitelist) === J(['content']) && J(rtMod.cfg.feedRegexBlacklist) === J(['战斗'])
        && taggedHtml.indexOf('data-ftt-cfg="feedRegexWhitelist" class="ftt-textarea">content</textarea>') >= 0
        && taggedHtml.indexOf('ftt-chip-btn--on-w') >= 0 && taggedHtml.indexOf('ftt-chip-btn--on-b') >= 0;
    // 货币页：标定按钮 → 选择器 → 标定 → 胶囊/角标/清空按钮
    await entry.popupAction('tab', { tab: 'currencies' });
    const curOff = String((await entry.popupAction('refresh', {})).html || '');
    const curOffOk = curOff.indexOf('data-ftt-action="curTrackPick"') >= 0
        && curOff.indexOf('👥 指定角色') >= 0 && curOff.indexOf('共 0 条货币') >= 0
        && curOff.indexOf('data-ftt-track-chips') < 0 && curOff.indexOf('✖ 清空标定') < 0;
    await entry.popupAction('curTrackPick', {});
    const openHtml = String((await entry.popupAction('refresh', {})).html || '');
    const pickerOk = openHtml.indexOf('👥 指定跟踪角色 · 从「角色」大类选择（已标定 0 名）') >= 0
        && openHtml.indexOf('data-ftt-search="currencyTrackPick"') >= 0
        && openHtml.indexOf('data-ftt-action="curTrackClose"') >= 0
        && openHtml.indexOf('data-name="乙角色"') >= 0 && F.trackPickState() === true;
    const t1 = await entry.popupAction('curTrackToggle', { name: '乙角色' });
    const trackHtml = String((await entry.popupAction('refresh', {})).html || '');
    const trackOk = String((t1.state || {}).note) === '已标定「乙角色」：后续分析记忆会同时考虑该角色的货币情况；注入时与主角一样恒定列出。'
        && J(F.trackedCurrencyRoles()) === J(['乙角色'])
        && trackHtml.indexOf('⭐ 已标定跟踪：') >= 0 && trackHtml.indexOf('👥 指定角色（1）') >= 0
        && trackHtml.indexOf('✖ 清空标定') >= 0 && trackHtml.indexOf('已标定 1 名') >= 0
        && trackHtml.indexOf('title="取消标定该角色"') >= 0;
    rtMod.cfg.feedRegexWhitelist = keepWl; rtMod.cfg.feedRegexBlacklist = keepBl;
    return feedPageOk && tagPageOk && curOffOk && pickerOk && trackOk;
})(), '');

await assert('AG3 收尾语义：`rxScanClear` 清空结果（无提示）+ 无正文时 `rxScanTags` 如实警示；`curTrackClose` 关闭选择器、空名不标定、`curTrackClear` 清空并回报条数', (async () => {
    const F = globalThis.FTT;
    const keepRoles = (rtMod.cfg.currencyTrackedRoles || []).slice();
    // 清空结果：面板回「尚未分析」占位、结果缓存为 null、无提示
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'feed' });
    F.setRxTagScan(null);
    await entry.popupAction('rxScanTags', {});
    const had = F.rxTagScan();
    const cl = await entry.popupAction('rxScanClear', {});
    const clHtml = String((await entry.popupAction('refresh', {})).html || '');
    const clearOk = String((cl.state || {}).note) === '' && F.rxTagScan() === null
        && clHtml.indexOf('尚未分析') >= 0 && clHtml.indexOf('data-ftt-action="rxAddTag"') < 0;
    // 无正文：last = -1 → warning 分支（V1 文案逐字）
    const keepLast = rtMod.getLastMessageId();
    rtMod.setLastMessageId(-1);
    const nf = await entry.popupAction('rxScanTags', {});
    const nfOk = nf.ok === false && String((nf.state || {}).note) === '未取到最新正文：当前会话没有可分析的 AI 回复（或正文为空）。'
        && F.rxTagScan() && F.rxTagScan().ok === false && F.rxTagScan().reason === 'no-text'
        && String((await entry.popupAction('refresh', {})).html || '').indexOf('⚠️ 未取到最近一条 AI 正文，无法分析。') >= 0;
    rtMod.setLastMessageId(keepLast);
    rtMod.cfg.currencyTrackedRoles = [];
    await entry.popupAction('tab', { tab: 'currencies' });
    F.setTrackPick(false);                                   // AG2 结束时选择器是开着的 → 先归零
    await entry.popupAction('curTrackPick', {});
    const noop = await entry.popupAction('curTrackToggle', { name: '   ' });
    const noopOk = J(F.trackedCurrencyRoles()) === J([]) && F.trackPickState() === true;
    await entry.popupAction('curTrackToggle', { name: '甲角色' });
    const close = await entry.popupAction('curTrackClose', {});
    const closed = F.trackPickState() === false && String((close.state || {}).note).indexOf('已标定「甲角色」') === 0;
    const clr = await entry.popupAction('curTrackClear', {});
    const clr2 = await entry.popupAction('curTrackClear', {});
    const clearTrackOk = String((clr.state || {}).note) === '已清空 1 个标定角色' && J(F.trackedCurrencyRoles()) === J([])
        && String((clr2.state || {}).note) === '当前没有标定角色';
    rtMod.cfg.currencyTrackedRoles = keepRoles;
    await entry.popupAction('tab', { tab: 'overview' });      // 复位（不影响后续小节）
    return clearOk && nfOk && noopOk && closed && clearTrackOk;
})(), '');

// ---------- AH 条目瘦身/gzip + 同步分歧选择（B9-d） ----------
await assert('AH1 条目瘦身 + gzip 的 `FTT.*` 入口齐备，且瘦身/索引/gzip 原语真实生效（同义字段丢弃、快照索引过滤无 id、gzip 往返文本全等、魔数判定）', (async () => {
    const F = globalThis.FTT;
    const names = ['slimEntryForStorage', 'hydrateSlimEntry', 'slimDataForStorage', 'hydrateStorageData', 'snapshotIndexFrom',
        'slimSnapshotStoreForStorage', 'hydrateSnapshotStore', 'slimFileEnvelope', 'gzipToBase64', 'gunzipFromBytes',
        'bytesToBase64', 'base64ToBytes', 'isGzipBytes', 'slimInfo',
        // B9-d 分歧处置（V1 `__FTT` 同名能力）
        'crossComputeInfo', 'crossPendingGet', 'crossPendingView', 'crossPendingClear', 'applyRemoteReplaceState',
        'adoptRemoteEnvelope', 'crossPullPolicy', 'storageEnvelope', 'storageHash', 'storageEnvValid'];
    const missing = names.filter((n) => typeof F[n] !== 'function');
    // 瘦身：content 与 text 全等 → 丢弃；空值/默认值不写盘；extra 只留顶层没有的槽位
    const slim = F.slimEntryForStorage('atoms', {
        id: 'ah1', text: 'AH 瘦身情节', title: 'AH 瘦身', date: '1936-12-06', tags: ['AH'], uses: 3,
        content: 'AH 瘦身情节', location: '', keywords: [], extra: [{ name: 'title', value: 'AH 瘦身' }, { name: 'onlyHere', value: 'x' }],
    });
    const slimOk = slim.content === undefined && slim.location === undefined && slim.keywords === undefined
        && slim.uses === 3 && Array.isArray(slim.extra) && slim.extra.length === 1 && slim.extra[0].name === 'onlyHere'
        && F.hydrateSlimEntry('atoms', JSON.parse(JSON.stringify(slim))).content === 'AH 瘦身情节';
    // 快照索引：无 id 过滤 + covered 计数
    const idx = F.snapshotIndexFrom([{ id: 'r1', kind: 'root', ts: 1, atomsHashes: { a: 'h', b: 'h' } }, { id: '', kind: 'root', ts: 2 }]);
    const idxOk = idx.length === 1 && idx[0].covered === 2 && idx[0].id === 'r1';
    // gzip 往返（真实 CompressionStream → 魔数 → DecompressionStream）
    const text = JSON.stringify({ atoms: Array.from({ length: 20 }, (_, i) => ({ id: 'g' + i, text: '压缩样本内容压缩样本内容'.repeat(2) })) });
    const gz = await F.gzipToBase64(text);
    const u8 = F.base64ToBytes(gz.b64);
    const back = await F.gunzipFromBytes(u8);
    const gzOk = gz.ok === true && u8[0] === 0x1f && u8[1] === 0x8b && F.isGzipBytes(u8) === true && back === text
        && F.bytesToBase64(u8) === gz.b64 && gz.b64.length < text.length;
    const info = F.slimInfo();
    // 默认安全：两个开关默认关闭，写入名 = 明文名
    return missing.length === 0 && slimOk && idxOk && gzOk
        && info && info.slim === false && info.gzip === false && info.gzipAvailable === true
        && /\.json$/.test(info.writeName) && /\.json\.gz$/.test(info.gzName)
        && F.storageEnvValid(F.storageEnvelope({ atoms: [] })) === true;
})(), '');

await assert('AH2 存储页如实呈现瘦身/gzip 开关与写入名；两个分歧动作进入 `SYNC_ACTIONS` 并经面板分发（无待选时如实警示且不改动本端，提示读 `r.state.note`）', (async () => {
    const F = globalThis.FTT;
    const keepSlim = rtMod.cfg.storage.stateFileSlim, keepGzip = rtMod.cfg.storage.stateFileGzip;
    F.crossPendingClear();
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'storage' });
    const off = String((await entry.popupAction('refresh', {})).html || '');
    const offOk = off.indexOf('data-ftt-slim-gzip') >= 0 && off.indexOf('条目瘦身 关闭（默认）') >= 0
        && off.indexOf('gzip 写入 关闭（默认）') >= 0 && off.indexOf('读取按内容魔数自动识别') < 0
        && off.indexOf('data-ftt-action="syncPickLocal"') < 0;          // 无待选 → 不渲染横幅按钮
    rtMod.cfg.storage.stateFileSlim = true; rtMod.cfg.storage.stateFileGzip = true;
    const on = String((await entry.popupAction('refresh', {})).html || '');
    const onOk = on.indexOf('条目瘦身 <b>已开启</b>') >= 0 && on.indexOf('gzip 写入 <b>已开启</b>') >= 0
        && on.indexOf('读取按内容魔数自动识别，明文旧文件仍可读') >= 0;
    rtMod.cfg.storage.stateFileSlim = keepSlim; rtMod.cfg.storage.stateFileGzip = keepGzip;
    // 无待选时点「采用对端」：如实警示 + 不改动本端
    const before = J((rtMod.state.atoms || []).map((x) => x.id).sort());
    const r = await entry.popupAction('syncPickRemote', {});
    const after = J((rtMod.state.atoms || []).map((x) => x.id).sort());
    return offOk && onOk
        && String(r.state.note) === '未找到待选对端（未改动本端）'
        && r.action === 'syncPickRemote' && r.ok === false
        && before === after && F.crossPendingGet() === null;
})(), '');

await assert('AH3 真实自动对账遇分歧 → **暂存待选 + 横幅 + 不静默合并**；「保留本端」与「采用对端」两个动作分别覆盖对端 / 整体替换本端并写同步日志留痕', (async () => {
    const F = globalThis.FTT;
    const st = rtMod.state;
    const info = F.syncStatus().file;
    const keepMeta = rtMod.cfg.storage.syncMetaProbe;
    rtMod.cfg.storage.syncMetaProbe = false;      // 关掉清单预判：本小节要强制读对端文件（否则可能因清单命中而跳过）
    // ① 本端：一条「与对端同 id 但内容不同」的条目（冲突）+ 一条本端独有条目
    const A = { id: 'smoke-ah-A', text: 'AH 共同条目原文', title: 'AH 共同条目', date: '1936-12-06', tags: ['AH'], uses: 1, floorStart: 0, floorEnd: 1 };
    st.atoms = (st.atoms || []).concat([A, { id: 'smoke-ah-L', text: 'AH 本端独有情节', title: 'AH 本端独有', date: '1936-12-06', tags: ['AH'], uses: 1, floorStart: 0, floorEnd: 1 }]);
    const localAtom = A;
    /** 造一份「对端」信封（同 id 冲突 + 对端独有 + 本端独有 → 无端是超集） */
    const makeRemote = () => {
        const d = JSON.parse(JSON.stringify(st));
        d.atoms = [Object.assign({}, localAtom, { text: String(localAtom.text || '') + '（对端改写）' }), { id: 'smoke-ah-R', text: 'AH 对端独有情节', title: 'AH 对端独有', date: '1936-12-07', tags: ['AH'], uses: 1, floorStart: 0, floorEnd: 1 }];
        d.updatedAt = 9000000000000;
        const env = F.storageEnvelope(d);
        env.ts = 9000000000000; env.payload.updatedAt = 9000000000000; env.hash = F.storageHash(env.payload);
        return JSON.stringify(env);
    };
    const put = () => { srvFiles.set(info.name, makeRemote()); srvFiles.set(info.bak, makeRemote()); F.syncDropCache(); };
    put();
    const r1 = await F.crossPullPolicy('冒烟', { force: true });
    const pend = F.crossPendingView();
    const stashOk = r1.divergence === 'divergence' && !!pend && pend.conflict >= 1
        && pend.onlyLocal >= 1 && pend.onlyRemote >= 1
        && (rtMod.state.atoms || []).some((x) => x.id === 'smoke-ah-L')      // 未静默合并
        && (rtMod.state.atoms || []).every((x) => x.id !== 'smoke-ah-R');
    // ② 横幅（V1 同款文案 + 两个按钮，且无 title）
    const pageHtml = String((await entry.popupAction('refresh', {})).html || '');
    const bannerOk = pageHtml.indexOf('⚠️ 跨端同步分歧 · 请选择保留哪个版本') >= 0
        && pageHtml.indexOf('data-ftt-action="syncPickLocal"') >= 0 && pageHtml.indexOf('data-ftt-action="syncPickRemote"') >= 0
        && pageHtml.indexOf('保留本地（') >= 0 && pageHtml.indexOf('采用对端（') >= 0
        && F.crossPendingGet() !== null;
    // ③ 保留本端（本端推送覆盖对端）
    const p1 = await entry.popupAction('syncPickLocal', {});
    const log1 = F.syncLog().filter((x) => String(x.action) === '分歧选择')[0];
    const keepOk = String(p1.state.note).indexOf('已保留本地版本') >= 0 && F.crossPendingGet() === null
        && (rtMod.state.atoms || []).some((x) => x.id === 'smoke-ah-L')
        && !!log1 && log1.mode === '保留本端(覆盖对端)' && String(log1.note).indexOf('本端推送覆盖对端') >= 0;
    // ④ 再来一次分歧 → 采用对端（整体替换）
    put();
    await F.crossPullPolicy('冒烟', { force: true });
    const p2 = await entry.popupAction('syncPickRemote', {});
    const log2 = F.syncLog().filter((x) => String(x.action) === '分歧选择')[0];
    const adoptOk = String(p2.state.note).indexOf('已采用对端版本') >= 0 && F.crossPendingGet() === null
        && (rtMod.state.atoms || []).some((x) => x.id === 'smoke-ah-R')
        && (rtMod.state.atoms || []).every((x) => x.id !== 'smoke-ah-L')
        && Number(rtMod.state.updatedAt) === 9000000000000
        && !!log2 && log2.mode === '采用对端(整体替换)' && String(log2.note).indexOf('本端已替换为对端数据') >= 0;
    // 复位：移除造出来的对端条目 + 恢复清单开关，避免影响后续小节
    rtMod.state.atoms = (rtMod.state.atoms || []).filter((x) => String(x.id).indexOf('smoke-ah-') !== 0);
    rtMod.cfg.storage.syncMetaProbe = keepMeta;
    await entry.popupAction('tab', { tab: 'overview' });
    return stashOk && bannerOk && keepOk && adoptOk;
})(), '');

// ---------- AI 独立分组抽取 + 被动调度接线（P9d） ----------
const setPagesMod = await import('../ui/settings-pages.js');
/** 只启用「情节 / 状态」两维（其余 12 个容器键**显式置 false** —— V2 `enabledDims()` 是「≠ false 即启用」口径）
 *  → 独立分组下 = 2 个单维度组 + 1 个「统一」组（其余 8 个 V1 摘要维度） */
const P9D_DIMS = {
    atoms: true, currentStates: true, snapshots: false, memories: false, items: false, plans: false, suspense: false,
    scenes: false, concepts: false, parallels: false, links: false, plotSegments: false, rumors: false, currencies: false,
};
/** 注入「记录型」定时器（P9d 的延迟排程全部经 `timerHooks`；由本小节手动驱动，不做真实 1.8s/4s 等待） */
function p9dTimers() {
    const saved = { set: rtMod.timerHooks.set, clear: rtMod.timerHooks.clear };
    const rec = [];
    rtMod.setTimerHooks({ set: (fn, ms) => { rec.push({ fn, ms }); return rec.length; }, clear: () => undefined });
    return { rec, restore: () => rtMod.setTimerHooks(saved) };
}
const p9dMs = (rec, ms) => rec.filter((x) => x.ms === ms);
/** 驱动记录到的定时器（先清空清单，避免同一回调被驱动两次） */
async function p9dDrain(rec) {
    const list = rec.slice();
    rec.length = 0;
    for (const x of list) { try { await x.fn(); } catch (e) { /* 忽略 */ } }
}

assert('AI1 独立分组接线齐备：FTT.* 4 项入口 + 分组构造（启用各自单组 / 未启用并「统一」组）+ jsExtractKeywords 真实命中 + 分析页「独立分组」开关（V1 代理键写回真键）', (() => {
    const F = globalThis.FTT;
    const names = ['jsExtractKeywords', 'runSummarySeparate', 'summaryDimGroups', 'separateGroupingEnabled'];
    const miss = names.filter((n) => typeof F[n] !== 'function');
    const before = F.separateGroupingEnabled();
    rtMod.cfg.dimensionEnabled = Object.assign({}, P9D_DIMS);
    const groups = F.summaryDimGroups();
    // 真实扫描定位关键词来源：造一条带标签的情节，标签词必须**原样出现在正文**才命中
    rtMod.state.atoms = (rtMod.state.atoms || []).concat([{ id: 'smoke-ai-seed', title: 'AI 关键词种子', text: '甲在码头清点铜箱。', date: '1919-11-29', tags: ['码头', '铜箱'], keywords: [], uses: 0, floorStart: 0, floorEnd: 1 }]);
    const kw = F.jsExtractKeywords('甲在码头清点铜箱，天色已晚。');
    const html = setPagesMod.settingsPageHtml('analyze');
    const r = setPagesMod.applySettingsControl('dimensionSeparate', true);
    const onHtml = setPagesMod.settingsPageHtml('analyze');
    const on = r.ok === true && rtMod.cfg.dimensionGrouping === 'separate' && F.separateGroupingEnabled() === true;
    setPagesMod.applySettingsControl('dimensionSeparate', false);
    return miss.length === 0 && before === false
        && J(groups) === J({ enabled: ['atoms', 'states'], rest: ['snapshots', 'memories', 'items', 'plans', 'scenes', 'concepts', 'currencies', 'rumors'] })
        && J(kw) === J(['码头', '铜箱'])
        && html.indexOf('data-ftt-cfg="dimensionSeparate"') >= 0 && html.indexOf('>独立分组</label>') >= 0
        && html.indexOf('统一分组（一次请求全部维度）') >= 0
        // v2.35.0（B10-a）：各维度 API 分组下拉**按 V1 原位**渲染在「分析记忆」页（V1 `dimensionRowsHtml` 24565）
        && html.indexOf('data-ftt-dim-preset="states"') >= 0 && html.indexOf('各维度独立子开关与分组') >= 0
        && on && onHtml.indexOf('data-ftt-cfg="dimensionSeparate" checked') >= 0
        // v2.35.0：V1 开启态原文「各维度可单独选预设并行请求」现已成立（按维度选分组已实现），逐字恢复
        && onHtml.indexOf('独立分组（各维度可单独选预设并行请求）') >= 0 && rtMod.cfg.dimensionGrouping === 'unified';
})(), String(rtMod.cfg.dimensionGrouping));

const AI2dbg = {};
await assert('AI2 独立分组端到端（注入定时器驱动）：分段路径 → 3 组并行请求、逐组切片落库（`added` 按 V1 怪癖为 0）+ 每组成功各排程推演（1.8s 去重为 1，且**不**排情节总结 —— V1 只在单楼/批量收尾排）；驱动后真实推演且 `weaveLastFloor` = 段末楼', (async () => {
    const t = p9dTimers();
    const savedGen = host.ctx.generateRaw;
    const prompts = [];
    rtMod.cfg.dimensionGrouping = 'separate';
    rtMod.cfg.dimensionEnabled = Object.assign({}, P9D_DIMS);
    rtMod.cfg.parallelWeaveEnabled = true;
    rtMod.cfg.parallelWeaveInterval = 0;
    rtMod.state.weaveLastFloor = -1;
    // 响应键必须是**英文维度键**：独立分组在 `mergeDelta` 之前按原始键切片（V1 原样 —— 中文键会判「无该维度数据」）
    const P9D_WEAVE_MARK = '触发关键词（提取记忆所得，用于关联更新）：';
    host.ctx.generateRaw = async (args) => {
        prompts.push(String((args && args.systemPrompt) || '') + '\n' + String((args && args.prompt) || ''));
        return JSON.stringify({
            atoms: { add: [{ title: '分组情节', text: '甲在码头清点铜箱后记账（正文足够长）。', date: '1919-11-29' }] },
            states: { add: [{ subject: '甲', field: '位置', value: '码头' }] },
            memories: { add: [{ owner: '甲', title: '铜箱', content: '甲记得铜箱的锁完好。', date: '1919-11-29' }] },
        });
    };
    let out = null;
    try {
        host.ctx.chat.push({ is_user: false, mes: '甲在码头清点铜箱后记账。', name: '角色甲' });
        const fid = host.ctx.chat.length - 1;
        const r = await extractMod.analyzeSegment(fid, fid, {});
        const promptsBefore = prompts.filter((s) => s.indexOf('触发关键词（提取记忆所得，用于关联更新）：') >= 0).length;
        const timersOk = p9dMs(t.rec, 1800).length === 1 && p9dMs(t.rec, 4000).length === 0;
        const weaveTimers = p9dMs(t.rec, 1800).slice();
        await p9dDrain(t.rec);                                   // 驱动推演（分段路径无情节总结检查点）
        const weavePrompt = prompts.filter((s) => s.indexOf('触发关键词（提取记忆所得，用于关联更新）：') >= 0).pop() || '';
        Object.assign(AI2dbg, { r, timers: t.rec.map((x) => x.ms), promptsBefore, weaveTimers: weaveTimers.length, wlf: rtMod.state.weaveLastFloor, counts: { atoms: (rtMod.state.atoms || []).length, states: (rtMod.state.currentStates || []).length, memories: (rtMod.state.memories || []).length }, weaveHead: weavePrompt.slice(0, 120) });
        out = r.separate === true && r.groups === 3 && r.groupOk === 3 && r.groupFailed === 0 && r.added === 0
            && (rtMod.state.atoms || []).length >= 2 && (rtMod.state.currentStates || []).length === 1
            && (rtMod.state.memories || []).length >= 1
            && timersOk && weaveTimers.length === 1 && promptsBefore === 0
            && weavePrompt.indexOf('触发关键词（提取记忆所得，用于关联更新）：') >= 0
            && Number(rtMod.state.weaveLastFloor) === fid;
    } finally { host.ctx.generateRaw = savedGen; t.restore(); }
    return out;
})(), AI2dbg);

const AI3dbg = {};
await assert('AI3 被动调度接线（合并成功后自动排程）：单楼成功 → 推演 1.8s + 情节总结 4s 各 1；再次成功不重复排程（防抖合并）；失败（AI 无 JSON）不排程；驱动推演后关键词来自 jsExtractKeywords', (async () => {
    const t = p9dTimers();
    const savedGen = host.ctx.generateRaw;
    const prompts = [];
    let failMode = false;
    rtMod.cfg.dimensionGrouping = 'unified';                     // 单楼路径 V1 无独立分组分支 → 统一请求
    rtMod.cfg.parallelWeaveEnabled = true;
    rtMod.cfg.parallelWeaveInterval = 0;
    rtMod.state.weaveLastFloor = -1;
    let out = null;
    try {
        host.ctx.generateRaw = async (args) => {
            prompts.push(String((args && args.systemPrompt) || '') + '\n' + String((args && args.prompt) || ''));
            if (failMode) return '没有 JSON';
            return JSON.stringify({ atoms: { add: [{ title: '单楼', text: '甲把铜箱锁好（正文足够长）。', date: '1919-11-29' }] } });
        };
        host.ctx.chat.push({ is_user: false, mes: '甲把铜箱锁好，随后离开码头。', name: '角色甲' });
        const f1 = host.ctx.chat.length - 1;
        host.ctx.chat.push({ is_user: false, mes: '甲在仓库里整理账册，铜箱放在脚边。', name: '角色甲' });
        const f2 = host.ctx.chat.length - 1;
        host.ctx.chat.push({ is_user: false, mes: '夜里码头的风很大，甲没有再出门。', name: '角色甲' });
        const f3 = host.ctx.chat.length - 1;
        const r1 = await extractMod.analyzeFloor(f1, {});
        const after1 = { w: p9dMs(t.rec, 1800).length, c: p9dMs(t.rec, 4000).length };
        const r2 = await extractMod.analyzeFloor(f2, {});
        const after2 = { w: p9dMs(t.rec, 1800).length, c: p9dMs(t.rec, 4000).length };
        failMode = true;
        const r3 = await extractMod.analyzeFloor(f3, {});
        const after3 = { w: p9dMs(t.rec, 1800).length, c: p9dMs(t.rec, 4000).length };
        failMode = false;                                        // 驱动推演时恢复可解析响应（只为记录真实提示词）
        const weaveTimers = p9dMs(t.rec, 1800).slice();
        await p9dDrain(t.rec);
        const weavePrompt = prompts.filter((s) => s.indexOf('触发关键词（提取记忆所得，用于关联更新）：') >= 0).pop() || '';
        Object.assign(AI3dbg, { r1, r2, r3, after1, after2, after3, timers: t.rec.map((x) => x.ms), weaveTimers: weaveTimers.length, wlf: rtMod.state.weaveLastFloor, weaveHead: weavePrompt.slice(0, 120) });
        out = r1.ok === true && after1.w === 1 && after1.c === 1                // 合并成功 → 各排程一次
            && r2.ok === true && after2.w === 1 && after2.c === 1               // 二次成功 → 防抖合并（仍是 1）
            && r3.ok === false && r3.reason === 'no-json'
            && after3.w === 1 && after3.c === 1                                // 失败 → 不新增排程
            && weaveTimers.length === 1 && Number(rtMod.state.weaveLastFloor) === f1
            && weavePrompt.indexOf('触发关键词（提取记忆所得，用于关联更新）：') >= 0
            && weavePrompt.indexOf('铜箱') >= 0;                                // 关键词真实来自 jsExtractKeywords（种子标签）
    } finally { host.ctx.generateRaw = savedGen; t.restore(); }
    return out;
})(), AI3dbg);

// ---------- AJ 子标签点击修复 + 异常捕捉强化（v2.34.0） ----------
await assert('AJ1 设定子标签点击真实生效：V1 同款标记（`<a href="javascript:void(0)" class="ftt-subtab" data-ftt-subtab>`）→ 点击切换 settingsSub 并重绘对应子页', (async () => {
    await entry.popupAction('tab', { tab: 'settings' });
    const before = String((panelState().settingsSub) || '');
    const html0 = String(panelBodyHtml('settings') || '');
    const el = doc.getElementById('ftt-panel');
    const bound = !!el && el.__fttBound === true;
    const fire = (dataset) => { const l = (el && el.listeners && el.listeners.click) || []; if (!l.length) return false; l.forEach((fn) => fn({ target: { dataset } })); return true; };
    const okMarkup = html0.indexOf('data-ftt-subtab="base"') >= 0 && html0.indexOf('class="ftt-subtab') >= 0
        && html0.indexOf('href="javascript:void(0)"') >= 0 && html0.indexOf('ftt-btn ftt-sm ftt-subtab') < 0;   // 修复前的错误标记不得再出现
    const fired = fire({ fttSubtab: 'feed' });
    await new Promise((r) => setTimeout(r, 0));
    const after = String(panelState().settingsSub || '');
    const html1 = String(panelBodyHtml('settings') || '');
    const fired2 = fire({ fttSubtab: 'storage' });
    await new Promise((r) => setTimeout(r, 0));
    return bound && okMarkup && fired && after === 'feed' && html1.indexOf('data-ftt-settings-page="feed"') >= 0
        && fired2 && String(panelState().settingsSub) === 'storage';
})(), '');

await assert('AJ2 记忆/情节子标签点击真实生效（此前同样被「无 action 即 return」吞掉）；且宿主已有面板节点时也会绑定委托', (async () => {
    const el = doc.getElementById('ftt-panel');
    const fire = (dataset) => { const l = (el && el.listeners && el.listeners.click) || []; l.forEach((fn) => fn({ target: { dataset } })); return l.length > 0; };
    await entry.popupAction('tab', { tab: 'memories' });
    const f1 = fire({ fttMsub: 'rel' });
    await new Promise((r) => setTimeout(r, 0));
    const relSub = String((panelState().relSub || {}).memories || '');
    await entry.popupAction('tab', { tab: 'atoms' });
    const f2 = fire({ fttAsub: 'segments' });
    await new Promise((r) => setTimeout(r, 0));
    const atSub = String(panelState().atomSub || '');
    return el.__fttBound === true && f1 && relSub === 'rel' && f2 && atSub === 'segments';
})(), '');

await assert('AJ3 异常捕捉强化：window error / unhandledrejection / 面板动作失败 → 调试日志 kind=「异常」；调试页显示只读异常区；解绑后不再记录', (async () => {
    const DL = await import('../core/debug-log.js');
    const EV = await import('../host/events.js');
    const AD = await import('../adapters/debug-log.js');
    // 事件目标桩（smoke 的 window 桩可能没有 addEventListener → 临时补上并还原）
    const oldWin = globalThis.window;
    const listeners = {};
    globalThis.window = Object.assign({}, oldWin, {
        addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
        removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((x) => x !== fn); },
    });
    AD.wireDebugLog();
    const n0 = DL.debugLogErrorCount();
    const installed = EV.installErrorCapture();
    (listeners.error || []).forEach((fn) => fn({ message: 'smoke-boom', filename: 'smoke.js', lineno: 11, colno: 2, error: new Error('smoke-boom') }));
    (listeners.unhandledrejection || []).forEach((fn) => fn({ reason: new Error('smoke-reject') }));
    const n1 = DL.debugLogErrorCount();
    // 面板动作抛错（注入会抛的 hook）
    setPanelHooks2({ importV1: () => { throw new Error('smoke-hook-boom'); } });
    const bad = await entry.popupAction('importV1Apply', {});
    const n2 = DL.debugLogErrorCount();
    setPanelHooks2({});
    // 调试页只读区
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'debug' });
    const html = String(panelBodyHtml('settings') || '');
    const shown = html.indexOf('⚠ 异常捕捉') >= 0 && /共 \d+ 条/.test(html);
    const un = EV.uninstallErrorCapture();
    (listeners.error || []).forEach((fn) => fn({ message: 'after-uninstall' }));
    const n3 = DL.debugLogErrorCount();
    globalThis.window = oldWin;
    const dump = globalThis.FTT && typeof globalThis.FTT.dbgDump === 'function' ? globalThis.FTT.dbgDump() : null;
    return installed === true && n1 === n0 + 2 && bad.ok === false && n2 === n1 + 1 && shown
        && !!dump && Number(dump.errors) >= n2 && Array.isArray(dump.recent) && !!dump.errCapture
        && un === true && n3 === n2 && EV.errorCaptureState().installed === false;
})(), '');

// ---------- AK API 页与按用途渠道（v2.35.0 / B10-a） ----------
await assert('AK1 API 子页真实渲染（V1 同款分节与标记）+ 分组预设三动作端到端（保存 → 加载 → 删除）', (async () => {
    const AC = await import('../core/api-channel.js');
    const { cfg } = await import('../core/model/runtime.js');
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'api' });
    const html = String(panelBodyHtml('settings') || '');
    const markup = html.indexOf('API 分组（预设管理）') >= 0 && html.indexOf('API 设定（主 API 配置，摘要/修复默认）') >= 0
        && html.indexOf('data-ftt-action="presetSave"') >= 0 && html.indexOf('data-ftt-action="presetLoad"') >= 0
        && html.indexOf('data-ftt-action="presetDelete"') >= 0 && html.indexOf('💾 保存当前设定为分组') >= 0
        && html.indexOf('data-ftt-cfg="apiChannel"') >= 0 && html.indexOf('data-ftt-cfg="apiProfileId"') >= 0
        && html.indexOf('data-ftt-cfg="apiUrl"') >= 0 && html.indexOf('data-ftt-cfg="apiKey"') >= 0
        && html.indexOf('data-ftt-cfg="apiTemperature"') >= 0 && html.indexOf('data-ftt-cfg="apiMaxTokens"') >= 0
        && html.indexOf('data-ftt-cfg="apiTopP"') >= 0 && html.indexOf('id="ftt-api-result-main"') >= 0
        && html.indexOf('data-ftt-action="apiTest"') >= 0 && html.indexOf('data-ftt-action="apiModels"') >= 0
        && html.indexOf('data-ftt-model-select="main"') >= 0
        && html.indexOf('按用途渠道（V2 映射 V1 的多渠道设定）') >= 0;
    const saved = { channel: cfg.apiChannel, url: cfg.apiUrl, key: cfg.apiKey, model: cfg.model, active: cfg.activeApiPreset, presets: cfg.apiPresets };
    cfg.apiChannel = 'direct'; cfg.apiUrl = 'https://preset.example/v1/'; cfg.apiKey = 'sk-p'; cfg.model = 'pm'; cfg.activeApiPreset = ''; cfg.apiPresets = {};
    const r1 = await entry.popupAction('presetSave', { name: '主API' });
    const savedOk = r1.ok === true && String(r1.name) === '主API'
        && !!cfg.apiPresets['主API'] && cfg.apiPresets['主API'].channel === 'direct'
        && cfg.apiPresets['主API'].apiUrl === 'https://preset.example/v1';
    cfg.apiUrl = ''; cfg.model = ''; cfg.apiKey = '';
    const r2 = await entry.popupAction('presetLoad', { preset: '主API' });
    const loadOk = r2.ok === true && cfg.apiUrl === 'https://preset.example/v1' && cfg.model === 'pm'
        && cfg.apiKey === 'sk-p' && cfg.apiChannel === 'direct' && cfg.activeApiPreset === '主API';
    const r3 = await entry.popupAction('presetDelete', { preset: '主API' });
    const delOk = r3.ok === true && !cfg.apiPresets['主API'] && cfg.activeApiPreset === '';
    const r4 = await entry.popupAction('presetDelete', { preset: '主API' });
    const emptyName = await entry.popupAction('presetSave', { name: '   ' });
    const html2 = String(panelBodyHtml('settings') || '');
    cfg.apiChannel = saved.channel; cfg.apiUrl = saved.url; cfg.apiKey = saved.key; cfg.model = saved.model;
    cfg.activeApiPreset = saved.active; cfg.apiPresets = saved.presets;
    await entry.popupAction('refresh', {});
    return markup && savedOk && loadOk && delOk && r4.ok === false && emptyName.ok === false
        && html2.indexOf('API 分组（预设管理）') >= 0 && AC.apiPresetNames().length === Object.keys(saved.presets || {}).length;
})(), '');

await assert('AK2 按用途渠道真实生效：平行/维度分组解析 + 维度下拉与模型下拉的变更写入', (async () => {
    const AC = await import('../core/api-channel.js');
    const { cfg } = await import('../core/model/runtime.js');
    const saved = { presets: cfg.apiPresets, active: cfg.activeApiPreset, channel: cfg.apiChannel, url: cfg.apiUrl, model: cfg.model, par: cfg.parallelApiPreset, dims: cfg.dimensionPresets, group: cfg.dimensionGrouping, key: cfg.apiKey };
    cfg.apiPresets = { P1: { channel: 'direct', apiUrl: 'https://p1.example/v1', apiKey: 'k1', model: 'm1' }, P2: { channel: 'direct', apiUrl: 'https://p2.example/v1', apiKey: 'k2', model: 'm2' } };
    cfg.apiChannel = 'host'; cfg.apiUrl = ''; cfg.apiKey = ''; cfg.model = ''; cfg.activeApiPreset = '';
    cfg.parallelApiPreset = 'P2'; cfg.dimensionPresets = {}; cfg.dimensionGrouping = 'separate';
    const tPar = AC.resolveApiTarget({ purpose: 'parallel' });
    const tMain = AC.resolveApiTarget({ purpose: 'main' });
    const labelOk = AC.purposeOfLabel('[平行事件·交织]') === 'parallel' && AC.purposeOfLabel('平行事件推进') === 'parallel'
        && AC.purposeOfLabel('弱化NSFW') === 'main' && AC.purposeOfLabel('关键词提取') === 'kw'
        && AC.purposeOfLabel('记忆分析发送') === 'mem';
    // 维度下拉变更（真实 change 委托）—— 按 V1 原位渲染在「分析记忆」页；平行渠道在「平行」页
    const el = doc.getElementById('ftt-panel');
    const fireChange = (dataset, value) => { const l = (el && el.listeners && el.listeners.change) || []; l.forEach((fn) => fn({ target: { dataset, value, type: 'select-one' } })); return l.length > 0; };
    await entry.popupAction('settingsSub', { sub: 'analyze' });
    const analyzeHtml = String(panelBodyHtml('settings') || '');
    const analyzeOk = analyzeHtml.indexOf('data-ftt-dim-preset="states"') >= 0 && analyzeHtml.indexOf('各维度独立子开关与分组') >= 0
        && analyzeHtml.indexOf('独立分组（各维度可单独选预设并行请求）') >= 0;   // v2.35.0：V1 原文恢复
    const f1 = fireChange({ fttDimPreset: 'states' }, 'P1');
    await new Promise((r) => setTimeout(r, 0));
    const dimSet = String((cfg.dimensionPresets || {}).states || '');
    const tDim = AC.resolveApiTarget({ purpose: 'dim', dimension: 'states' });
    await entry.popupAction('settingsSub', { sub: 'parallels' });
    const parHtml = String(panelBodyHtml('settings') || '');
    const parOk = parHtml.indexOf('推演/推进分析渠道') >= 0 && parHtml.indexOf('data-ftt-cfg="parallelApiPreset"') >= 0;
    const f2 = fireChange({ fttModelSelect: 'main' }, 'm2');
    await new Promise((r) => setTimeout(r, 0));
    const modelSet = String(cfg.model || '');
    await entry.popupAction('settingsSub', { sub: 'api' });
    const apiHtml = String(panelBodyHtml('settings') || '');
    const indexOk = apiHtml.indexOf('按用途渠道（V2 映射 V1 的多渠道设定）') >= 0
        && apiHtml.indexOf('在「平行」设定页选择') >= 0 && apiHtml.indexOf('在「分析记忆」设定页选择') >= 0
        && apiHtml.indexOf('data-ftt-dim-preset=') < 0 && apiHtml.indexOf('data-ftt-cfg="parallelApiPreset"') < 0;
    cfg.apiPresets = saved.presets; cfg.activeApiPreset = saved.active; cfg.apiChannel = saved.channel; cfg.apiUrl = saved.url; cfg.model = saved.model;
    cfg.parallelApiPreset = saved.par; cfg.dimensionPresets = saved.dims; cfg.dimensionGrouping = saved.group; cfg.apiKey = saved.key;
    await entry.popupAction('refresh', {});
    return tPar.apiUrl === 'https://p2.example/v1' && tPar.channel === 'direct' && tMain.channel === 'host'
        && labelOk && analyzeOk && f1 && dimSet === 'P1' && tDim.apiUrl === 'https://p1.example/v1'
        && parOk && f2 && modelSet === 'm2' && indexOk;
})(), '');

await assert('AK3 API 三通道端到端：direct 直连（端点/鉴权/参数）+ profile 经酒馆连接配置 + host 经 responseLength 覆盖 max_tokens', (async () => {
    const AC = await import('../core/api-channel.js');
    const HP = await import('../host/api-channel.js');
    const GEN = await import('../host/generation.js');
    const { cfg } = await import('../core/model/runtime.js');
    const saved = { channel: cfg.apiChannel, url: cfg.apiUrl, key: cfg.apiKey, model: cfg.model, temp: cfg.apiTemperature, max: cfg.apiMaxTokens, top: cfg.apiTopP, presets: cfg.apiPresets, active: cfg.activeApiPreset };
    cfg.apiChannel = 'direct'; cfg.apiUrl = 'https://direct.example/v1/'; cfg.apiKey = 'sk-d'; cfg.model = 'dm';
    cfg.apiTemperature = 0.3; cfg.apiMaxTokens = 256; cfg.apiTopP = 0.9; cfg.apiPresets = {}; cfg.activeApiPreset = '';
    const calls = [];
    const mkOk = (text) => ({ status: 200, body: { choices: [{ message: { content: text } }] } });
    const restore = installGlobalFetch((url, opts) => {
        calls.push({ url, opts });
        if (url.indexOf('fail.example') >= 0) return { status: 500, text: 'boom' };   // 先判失败域，避免被 /models 分支抢先
        if (/\/models$/.test(url)) return { status: 200, body: { data: [{ id: 'm1' }, { id: 'm2' }] } };
        return mkOk('DIRECT-OK');
    });
    let direct; let probe; let models; let bad;
    try {
        direct = await GEN.rawGenerate(Object.assign({ systemPrompt: 'S', prompt: 'P' }, { target: AC.resolveApiTarget({ purpose: 'main' }) }));
        probe = await HP.probeTarget(AC.resolveApiTarget({ purpose: 'main' }), 'chat');
        models = await HP.fetchModels(AC.resolveApiTarget({ purpose: 'main' }));
        cfg.apiUrl = 'https://fail.example/v1';
        bad = await HP.fetchModels(AC.resolveApiTarget({ purpose: 'main' }));
        const noUrl = { channel: 'direct', apiUrl: '', model: 'dm' };
        var probeNoUrl = await HP.probeTarget(noUrl, 'chat');
        var probeNoModel = await HP.probeTarget({ channel: 'direct', apiUrl: 'https://direct.example/v1', model: '' }, 'chat');
        var probeFail = await HP.probeTarget(AC.resolveApiTarget({ purpose: 'main' }), 'chat');
    } finally { restore(); }
    const chat = calls.filter((c) => String(c.url).indexOf('/chat/completions') >= 0)[0] || { url: '', opts: {} };
    const body = JSON.parse(String(chat.opts.body || '{}'));
    const directOk = direct.ok === true && direct.text === 'DIRECT-OK' && direct.via === 'direct'
        && chat.url === 'https://direct.example/v1/chat/completions'
        && (chat.opts.headers || {}).Authorization === 'Bearer sk-d'
        && body.model === 'dm' && body.temperature === 0.3 && body.top_p === 0.9 && body.max_tokens === 256
        && (body.messages || []).length === 2 && body.messages[0].role === 'system';
    const probeOk = probe.ok === true && Number(probe.ms) >= 0 && probe.kind === 'chat';
    const modelsOk = models.ok === true && models.models.join(',') === 'm1,m2';
    const badOk = bad.ok === false && String(bad.error).indexOf('HTTP 500') === 0;
    const errOk = String(probeNoUrl.error) === '未配置 API 地址' && String(probeNoModel.error) === '未配置模型'
        && String(probeFail.error).indexOf('HTTP 500') === 0;
    // profile 通道（替换酒馆连接配置服务桩）
    const savedSvc = host.ctx.ConnectionManagerRequestService;
    const sent = [];
    host.ctx.ConnectionManagerRequestService = {
        getSupportedProfiles: () => [{ id: 'p1', name: '主连接', api: 'openai', model: 'gpt-x' }],
        sendRequest: async (id, messages, maxTokens, custom, override) => { sent.push({ id, messages, maxTokens, custom, override }); return { content: 'PROFILE-OK' }; },
    };
    cfg.apiChannel = 'profile'; cfg.apiProfileId = 'p1'; cfg.apiUrl = ''; cfg.model = '';
    let prof; let profTest; let profModels; let avail;
    try {
        await new Promise((r) => setTimeout(r, 0));
        avail = HP.apiChannelAvailability();
        prof = await GEN.rawGenerate(Object.assign({ systemPrompt: 'S', prompt: 'P' }, { target: AC.resolveApiTarget({ purpose: 'main' }) }));
        profTest = await HP.probeTarget(AC.resolveApiTarget({ purpose: 'main' }), 'chat');
        profModels = await HP.fetchModels(AC.resolveApiTarget({ purpose: 'main' }));
    } finally { host.ctx.ConnectionManagerRequestService = savedSvc; }
    const s0 = sent[0] || {};
    const profileOk = prof.ok === true && prof.text === 'PROFILE-OK' && prof.via === 'profile'
        && s0.id === 'p1' && Array.isArray(s0.messages) && s0.messages.length === 2
        && s0.maxTokens === 256 && s0.override && s0.override.temperature === 0.3 && s0.override.top_p === 0.9
        && profTest.ok === true && profModels.ok === false && avail.profile.available === true && avail.profile.count === 1
        && String(profModels.error).indexOf('连接配置') >= 0;
    // host 通道：responseLength 覆盖 max_tokens；temperature 不在 payload（宿主签名无该形参）
    cfg.apiChannel = 'host';
    const savedGen = host.ctx.generateRaw;
    let seen = null;
    host.ctx.generateRaw = async (payload) => { seen = payload; return 'HOST-OK'; };
    let hostRes;
    try { hostRes = await GEN.rawGenerate(Object.assign({ prompt: 'P' }, { target: AC.resolveApiTarget({ purpose: 'main' }) })); } finally { host.ctx.generateRaw = savedGen; }
    const hostOk = hostRes.ok === true && hostRes.text === 'HOST-OK' && hostRes.via === 'host'
        && seen && seen.responseLength === 256 && seen.temperature === undefined && seen.prompt === 'P';
    cfg.apiChannel = saved.channel; cfg.apiUrl = saved.url; cfg.apiKey = saved.key; cfg.model = saved.model;
    cfg.apiTemperature = saved.temp; cfg.apiMaxTokens = saved.max; cfg.apiTopP = saved.top;
    cfg.apiPresets = saved.presets; cfg.activeApiPreset = saved.active;
    return directOk && probeOk && modelsOk && badOk && errOk && profileOk && hostOk;
})(), '');

// ---------- AL 面板宽度自适应（v2.36.0） ----------
await assert('AL1 面板宽度自适应端到端：打开即下发 CSS 变量（默认 1280px）→ 档位切换即时生效并落 extensionSettings（内核 cfg 不新增键）→ 铺满档 100vw', (async () => {
    const S = await import('../adapters/settings.js');
    const { cfg } = await import('../core/model/runtime.js');
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'base' });
    const el = doc.getElementById('ftt-panel');
    const varOf = () => String((el && el.style && el.style.getPropertyValue('--ftt-panel-max-w')) || '');
    const html0 = String(panelBodyHtml('settings') || '');
    const ctrl = html0.indexOf('data-ftt-v2="panelMaxWidth"') >= 0 && html0.indexOf('铺满（只留 32px 边距）') >= 0
        && html0.indexOf('<option value="1280" selected>') >= 0 && html0.indexOf('手机端恒铺满') >= 0;
    const v0 = varOf();
    const fireChange = (dataset, value) => {
        const list = (el && el.listeners && el.listeners.change) || [];
        list.forEach((fn) => fn({ target: { dataset, value, type: 'select-one' } }));
        return list.length > 0;
    };
    const f1 = fireChange({ fttV2: 'panelMaxWidth' }, '1440');
    await new Promise((r) => setTimeout(r, 0));
    const v1 = varOf();
    const stored1 = Number(S.getSettings().panelMaxWidth);
    const f2 = fireChange({ fttV2: 'panelMaxWidth' }, '0');
    await new Promise((r) => setTimeout(r, 0));
    const v2 = varOf();
    const stored2 = Number(S.getSettings().panelMaxWidth);
    const notInCfg = !Object.prototype.hasOwnProperty.call(cfg, 'panelMaxWidth');
    // 归位默认档并重绘（后续小节按默认档继续）
    S.resetSettings();
    await entry.popupAction('refresh', {});
    const back = varOf();
    return ctrl && v0 === '1280px' && f1 && v1 === '1440px' && stored1 === 1440
        && f2 && v2 === '100vw' && stored2 === 0 && notInCfg && back === '1280px';
})(), '');

await assert('AL2 CSS 三档齐备且不写死宽度：桌面 min(变量, 100vw-32px) / 平板 min(变量, 96vw) / 手机 100dvw 全屏 + 宽面板溢出保护', (() => {
    const CSS = readFileSync(join(ROOT, 'style.css'), 'utf8');
    const base = /#ftt-panel\s*\{[^}]*--ftt-panel-max-w:\s*1280px/.test(CSS)
        && CSS.indexOf('width: min(var(--ftt-panel-max-w), calc(100vw - 32px))') >= 0
        && CSS.indexOf('width: min(940px, 94vw)') < 0;
    const tabIdx = CSS.indexOf('@media (min-width: 701px) and (max-width: 1024px)');
    const tab = tabIdx >= 0 && CSS.slice(tabIdx, tabIdx + 400).indexOf('min(var(--ftt-panel-max-w), 96vw)') >= 0;
    const mobIdx = CSS.indexOf('@media (max-width: 700px)');
    const mob = mobIdx >= 0 && (() => { const seg = CSS.slice(mobIdx, mobIdx + 900); return seg.indexOf('width: 100dvw') >= 0 && seg.indexOf('height: 100dvh') >= 0; })();
    const guard = CSS.indexOf('#ftt-panel .ftt-body, #ftt-panel .ftt-section, #ftt-panel .ftt-settings-page { min-width: 0; max-width: 100%; }') >= 0
        && CSS.indexOf('.ftt-v2-settings .ftt-v2-row { flex-wrap: wrap; }') >= 0;
    return base && tab && mob && guard;
})(), '');

// ---------- AN 时钟取值追踪（v2.37.0：值从哪来 / 为什么取它 / 有什么没被采用 / 这次改了什么） ----------
await assert('AN1 端到端：解析落盘后，时钟日志含「来源（含时间/地点）+ 判据 + 落选候选 + 落盘差异」四类信息；`FTT.clockTrace()` 可读', (async () => {
    const DL = await import('../adapters/debug-log.js');
    const CT = await import('../core/clock-trace.js');
    globalThis.FTT.clockTraceClear();
    const text = '▷1919年12月1日 09:10(钟楼内)\n▷凉州卫-钟鼓楼\n晚上甲与乙在码头清点铜箱。';
    const ok = globalThis.FTT.clockExtractOnce({ text, force: true });
    const logs = DL.debugLogList().filter((l) => l.kind === '时钟');
    const d = (() => { try { return JSON.parse(logs[0].data); } catch (e) { return null; } })();
    const trace = globalThis.FTT.clockTrace();
    const info = globalThis.FTT.clockTrace('resolve');
    const labels = globalThis.FTT.clockSrcLabels();
    const summary = globalThis.FTT.clockTraceSummary('resolve');
    return ok === true && !!d
        // ① 来源（含此前缺失的「时间/地点」来源；日期用精确来源而非 V1 的 'regex' 统一标记）
        && d.dateFrom === '正文头结构（▷/▶）' && d.dateFromV1 === '正文正则（最新正文）'
        && d.timeFrom === '正文头结构（▷/▶）' && d.locationFrom === '正文头结构（▷/▶）' && String(d.presentFrom).length > 0
        // ② 判据
        && String(d.dateWhy).length > 10 && String(d.timeWhy).length > 5 && String(d.locationWhy).length > 5
        && Array.isArray(d.chain) && d.chain.length >= 4 && String(d.how).indexOf('clockTrace') > 0
        // ③ 落选候选（含原因与原文片段线索）
        && Array.isArray(d.rejects) && d.rejects.length >= 1 && d.rejects.every((x) => x.indexOf('←') > 0 && x.indexOf('（') > 0)
        // ④ 落盘差异
        && Array.isArray(d.applied) && d.applied.length >= 2 && Number(d.textChars) > 0 && String(d.textFloors).length > 0
        // FTT 入口与调试页
        && !!trace && trace.stage === 'resolve' && !!info && info.picks.length >= 4 && info.text.sample.indexOf('▷') === 0
        && labels.length >= 17 && labels.every((x) => !!x.label)
        && summary.indexOf('🕒 取值 [resolve]') >= 0 && summary.indexOf('正文头结构（▷/▶）') >= 0;
})(), '');

await assert('AN2 无改动时不写提取日志（避免噪声），但取值追踪仍在；调试页「🕒 时钟取值追踪」区块渲染；清空入口可用', (async () => {
    const DL = await import('../adapters/debug-log.js');
    const DBG = await import('../ui/debug.js');
    // 与现值完全相同 → 不写提取日志（V1 同口径）
    // 用与 AN1 **完全相同**的正文再跑一次（此时 state 已等于解析结果）→ 不产生任何改动 → 不写提取日志
    const text = '▷1919年12月1日 09:10(钟楼内)\n▷凉州卫-钟鼓楼\n晚上甲与乙在码头清点铜箱。';
    globalThis.FTT.clockTraceClear();
    const before = DL.debugLogList().filter((l) => l.kind === '时钟').length;
    globalThis.FTT.clockExtractOnce({ text, force: true });
    const after = DL.debugLogList().filter((l) => l.kind === '时钟').length;
    const t = globalThis.FTT.clockTrace('resolve');
    // 调试页区块
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'debug' });
    const html = String(panelBodyHtml('settings') || '');
    const section = DBG.clockTraceSectionHtml();
    const cleared = globalThis.FTT.clockTraceClear();
    const afterClear = DBG.clockTraceSectionHtml();
    return after === before && !!t && t.picks.length >= 3
        && html.indexOf('🕒 时钟取值追踪') >= 0 && html.indexOf('clockTraceClear') >= 0
        && section.indexOf('自动解析（日期/时间/地点/在场）') >= 0 && section.indexOf('值 ← 来源') >= 0
        && section.indexOf('未采用的候选') >= 0 && afterClear.indexOf('暂无记录') >= 0 && cleared === true;
})(), '');

// ---------- AO 点击不跳顶（v2.38.0：滚动保持 + 按钮 type + 点击入口防默认） ----------
await assert('AO1 面板 HTML 的按钮全部带 `type="button"`（对齐 V1 v1.206 26525：无 type 的按钮在 form 内是 submit → 跳顶/刷新）', (() => {
    const PM = fttPanelMod;
    const raw = String(PM.panelHtml());
    const hardened = String(PM.ensureButtonTypes(raw));
    const rendered = String(PM.renderPanel());        // 真实渲染路径的返回值（renderPanel 内已加固）
    const count = (x) => (x.match(/<button/g) || []).length;
    const untyped = (x) => (x.match(/<button(?![^>]*\stype=)/g) || []).length;
    return count(raw) >= 20 && untyped(raw) === count(raw)      // 加固前：全部无 type
        && untyped(hardened) === 0 && untyped(rendered) === 0   // 加固后：一个不漏
        && hardened.indexOf('<button type="button"') >= 0;
})(), '');

let AO2dbg = null;
await assert('AO2 端到端：真实点击 → 重渲染（滚动归零）后**活动标签内容区**滚动位置被恢复；点击入口阻止默认行为', (async () => {
    const prevEl = doc._els['ftt-panel'];
    // DOM 影子：只实现本断言用到的选择器；`innerHTML=` 模拟真实重渲染（滚动归零）
    const sc = { panel: 0, modal: 0, tabs: 0, subs: 0, bodies: { atoms: 0 } };
    const nodes = {
        modal: { get scrollTop() { return sc.modal; }, set scrollTop(v) { sc.modal = Number(v) || 0; } },
        tabs: { get scrollLeft() { return sc.tabs; }, set scrollLeft(v) { sc.tabs = Number(v) || 0; } },
        subs: { get scrollLeft() { return sc.subs; }, set scrollLeft(v) { sc.subs = Number(v) || 0; } },
    };
    const bodyNode = (t) => {
        if (!nodes['b:' + t]) nodes['b:' + t] = { get scrollTop() { return sc.bodies[t] || 0; }, set scrollTop(v) { sc.bodies[t] = Number(v) || 0; } };
        return nodes['b:' + t];
    };
    const fake = {
        id: 'ftt-panel', _html: '', listeners: {},
        get scrollTop() { return sc.panel; }, set scrollTop(v) { sc.panel = Number(v) || 0; },
        style: { setProperty() { }, getPropertyValue() { return ''; } },
        classList: { add() { }, remove() { }, contains() { return true; } },
        parentNode: { removeChild() { return true; } },
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = String(v); sc.panel = 0; sc.modal = 0; sc.tabs = 0; sc.subs = 0; const z = {}; Object.keys(sc.bodies).forEach((k) => { z[k] = 0; }); sc.bodies = z; },
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        removeEventListener() { },
        querySelector(sel) {
            if (sel === '.ftt-modal') return nodes.modal;
            if (sel === '.ftt-tabs') return nodes.tabs;
            if (sel === '.ftt-subtabs') return nodes.subs;
            const m = /^\.ftt-body\[data-ftt-body="([^"]*)"\]$/.exec(String(sel));
            if (m) return bodyNode(m[1]);
            if (sel === '.ftt-body') return bodyNode('overview');
            return null;
        },
        querySelectorAll() { return []; },
    };
    let ok = false;
    try {
        // 先卸载（清掉模块内的浮层引用），再挂到 DOM 影子并重新打开 → 面板真的渲染进 fake
        fttPanelMod.unmountPanel();
        doc._els['ftt-panel'] = fake;
        fttPanelMod.openPanel('atoms');
        await new Promise((r) => setTimeout(r, 0));
        sc.bodies.atoms = 640;
        sc.tabs = 37;
        sc.panel = 9;
        const click = fake.listeners.click || [];
        let prevented = 0;
        let stopped = 0;
        const btn = { dataset: { fttAction: 'refresh' } };
        btn.closest = (sel) => (String(sel).indexOf('button') >= 0 || String(sel).indexOf('data-ftt-action') >= 0 ? btn : null);
        click.forEach((fn) => fn({ target: btn, preventDefault() { prevented += 1; }, stopPropagation() { stopped += 1; } }));
        await new Promise((r) => setTimeout(r, 0));
        const n = click.length;
        ok = n >= 1 && sc.bodies.atoms === 640 && sc.tabs === 37 && sc.panel === 9
            && (sc.bodies.overview || 0) === 0              // 恢复目标必须是**活动标签**内容区，不能取第一个 .ftt-body（V1 注释点明的坑）
            && prevented === n && stopped === n             // 点击入口 preventDefault + stopPropagation（V1 26075）
            && String(fake._html).indexOf('data-ftt-body="atoms"') >= 0
            && String(fake._html).indexOf('<button type="button"') >= 0;
    } finally {
        fttPanelMod.unmountPanel();
        doc._els['ftt-panel'] = prevEl;
        fttPanelMod.openPanel('overview');
    }
    return ok;
})(), '');

// ---------- AP 时钟不得取真实日期（v2.39.0：剧情时间字段只取剧情时间） ----------
await assert('AP1 端到端：**无剧情时钟**时写入记忆/状态 → 剧情时间字段留空（不写今天），注入体不含今日年份；手工录入缺年份**只沿用语剧情年份或拒绝**（绝不用现实年份）', (async () => {
    const RT = await import('../core/model/runtime.js');
    const REC = await import('../core/recall.js');
    const CP = await import('../core/clock-patrol.js');
    const ingestMod = await import('../core/ingest.js');
    const st = rtMod.state;
    const saved = { date: st.state.date, time: st.state.time, location: st.state.location, memories: st.memories, currentStates: st.currentStates };
    const YEAR = String(new Date().getFullYear());
    const TODAY = new Date().toISOString().slice(0, 10);
    let ok = false;
    try {
        st.state.date = ''; st.state.time = ''; st.state.location = '';
        st.memories = []; st.currentStates = [];
        const r = ingestMod.mergeDelta({ memories: { add: [{ title: '记忆甲', content: '甲在码头清点铜箱' }] }, states: { add: [{ subject: '甲', field: '体力', value: '疲惫' }] } });
        void r;
        const mem = (st.memories || []).map((m) => String(m.date || ''));
        const sts = (st.currentStates || []).map((x) => [String(x.updatedAt || ''), String(x.updatedAtTime || '')]);
        const body = String(REC.buildMemoryBodyForInject('', { charBudget: 4000, maxMemories: 6, countUses: true, inject: true }) || '');
        const manual = CP.parseClockManualInput({ date: '11月29日' });
        // 手工录入缺年份：**要么拒绝**（库内无可用年份），**要么沿用剧情年份** —— 但**绝不**用现实年份
        const manualNote = String((manual.notes || [])[0] || '');
        const manualOk = manual.ok === true
            ? (String(manual.date || '').indexOf(YEAR) < 0 && manualNote.indexOf('沿用年份') >= 0)
            : (manualNote.indexOf('缺少年份') >= 0 || manualNote.indexOf('无法解析') >= 0);
        ok = mem.length === 1 && mem[0] === '' && sts.length === 1 && sts[0][0] === '' && sts[0][1] === ''
            && body.indexOf('记忆甲') >= 0 && body.indexOf(YEAR) < 0 && body.indexOf(TODAY) < 0
            && manualOk;
    } finally {
        st.state.date = saved.date; st.state.time = saved.time; st.state.location = saved.location;
        st.memories = saved.memories; st.currentStates = saved.currentStates;
        await entry.popupAction('refresh', {});
    }
    return ok;
})(), '');

await assert('AP2 端到端：**有剧情时钟**时同一路径写剧情日期/时刻；平行事件行的现实墙钟只以「现实更新 …」标注出现（与 📅 剧情日期区分）', (async () => {
    const ingestMod = await import('../core/ingest.js');
    const st = rtMod.state;
    const saved = { date: st.state.date, time: st.state.time, memories: st.memories, currentStates: st.currentStates, parallels: st.parallels };
    let ok = false;
    try {
        st.state.date = '1919-11-20'; st.state.time = '傍晚';
        st.memories = []; st.currentStates = [];
        st.parallels = [
            { id: 'sp1', title: '冒烟分支甲', text: '甲去了乙地', date: '1919-11-20', updatedAt: Date.now(), uses: 1, type: '推演' },
            { id: 'sp2', title: '冒烟分支乙', text: '乙去了丙地', date: '1919-11-21', uses: 0, type: '推演' },
        ];
        ingestMod.mergeDelta({ memories: { add: [{ title: '记忆乙', content: '乙在钟鼓楼' }] }, states: { add: [{ subject: '乙', field: '状态', value: '警戒' }] } });
        const mem = (st.memories || []).map((m) => String(m.date || ''))[0] || '';
        const s0 = (st.currentStates || [])[0] || {};
        const html = String(panelBodyHtml('parallels') || '');
        const lineOf = (t) => (html.split('\n').filter((l) => l.indexOf(t) >= 0)[0] || '').replace(/<[^>]*>/g, '');
        const l1 = lineOf('冒烟分支甲');
        const l2 = lineOf('冒烟分支乙');
        ok = mem === '1919-11-20' && String(s0.updatedAt || '') === '1919-11-20' && String(s0.updatedAtTime || '') === '傍晚'
            && l1.indexOf('· 现实更新 ') > 0 && l1.indexOf('1919-11-20') > 0 && l2.indexOf('现实更新') < 0;
    } finally {
        st.state.date = saved.date; st.state.time = saved.time;
        st.memories = saved.memories; st.currentStates = saved.currentStates; st.parallels = saved.parallels;
        await entry.popupAction('refresh', {});
    }
    return ok;
})(), '');

// ---------- AQ 面板钩子接线（v2.40.0：数据管理导出/导入曾因漏接钩子完全不可用） ----------
await assert('AQ1 面板真实动作路径：导出 → 渲染导出文本框；导入（文本域路径）真实合并；此前「入口未就绪」的钩子全部在册', (async () => {
    const st = rtMod.state;
    const saved = { atoms: st.atoms, memories: st.memories, tab: panelState().tab, sub: panelState().settingsSub };
    const ingestMod = await import('../core/ingest.js');
    void ingestMod;
    let ok = false;
    try {
        const hooks = entry.panelRuntimeHooks();
        const needTypes = ['exportState', 'importState', 'importV1', 'autoSummary', 'abort', 'batchProgress', 'clearFloors', 'resetState', 'dimToggle', 'confirm', 'inject']
            .every((k) => typeof hooks[k] === 'function');
        rtMod.setKernelState(Object.assign(rtMod.emptyState ? rtMod.emptyState() : {}, {}));
        Object.assign(rtMod.state, {
            atoms: [{ id: 'aqa1', title: '冒烟情节', text: '甲在码头', date: '1919-11-20', uses: 0, floorStart: 0, floorEnd: 1 }],
            memories: [{ id: 'aqm1', title: '冒烟记忆', content: '甲在码头清点铜箱', date: '1919-11-20' }],
        });
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'data' });
        const page = String(panelBodyHtml('settings'));
        const text = entry.exportStateJson();
        const exp = await entry.popupAction('exportState', {});
        const shown = String(panelBodyHtml('settings')).indexOf('data-ftt-export') >= 0;
        // 文本域路径（真实 UI：粘贴 → 点「⬆ 导入」）
        const prevDoc = globalThis.document;
        globalThis.document = Object.assign({}, doc, { querySelector: (sel) => (String(sel).indexOf('data-ftt-import') >= 0 ? { value: text } : null) });
        rtMod.state.atoms = []; rtMod.state.memories = [];
        const imp = await entry.popupAction('importStateApply', {});
        globalThis.document = prevDoc;
        ok = needTypes && page.indexOf('data-ftt-action="exportState"') >= 0 && page.indexOf('data-ftt-action="importStateApply"') >= 0
            && exp.ok === true && Number(exp.chars) > 100 && shown
            && imp.ok === true && Number(imp.added) === 2
            && (rtMod.state.atoms || []).length === 1 && (rtMod.state.memories || []).length === 1;
    } finally {
        rtMod.state.atoms = saved.atoms; rtMod.state.memories = saved.memories;
        await entry.popupAction('tab', { tab: saved.tab });
        await entry.popupAction('settingsSub', { sub: saved.sub });
    }
    return ok;
})(), '');

await assert('AQ2 维度开关经**真实 change 委托**生效（V2 附加设定「启用维度」此前因缺 hooks.dimToggle 静默无效）', (async () => {
    const before = JSON.stringify(rtMod.cfg.dimensionEnabled || {});
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'base' });
    const el = doc.getElementById('ftt-panel');
    const fireChange = (dataset, checked) => {
        const list = (el && el.listeners && el.listeners.change) || [];
        list.forEach((fn) => fn({ target: { dataset, checked, type: 'checkbox' } }));
        return list.length > 0;
    };
    await entry.popupAction('refresh', {});
    const el2 = doc.getElementById('ftt-panel');
    const list = (el2 && el2.listeners && el2.listeners.change) || [];
    const fired = (() => { list.forEach((fn) => fn({ target: { dataset: { fttDim: 'atoms' }, checked: false, type: 'checkbox' } })); return list.length > 0; })();
    await new Promise((r) => setTimeout(r, 0));
    const off = (rtMod.cfg.dimensionEnabled || {}).atoms === false;
    list.forEach((fn) => fn({ target: { dataset: { fttDim: 'atoms' }, checked: true, type: 'checkbox' } }));
    await new Promise((r) => setTimeout(r, 0));
    const on = (rtMod.cfg.dimensionEnabled || {}).atoms === true;
    let restored = false;
    try { rtMod.cfg.dimensionEnabled = JSON.parse(before); restored = true; } catch (e) { restored = false; }
    await entry.popupAction('refresh', {});
    return fired && off && on && restored;
})(), '');

// ---------- AR 调试包导出 / 确认框 ACL 安全 / 入参透传回归（v2.41.0） ----------
await assert('AR1 调试包导出：面板「📦 导出调试包」产出可复制文本（含版本/环境/一键诊断/**全部日志**与「异常」类），并渲染文本框；`FTT.debugLogExport()` 同源', (async () => {
    const DL = await import('../core/debug-log.js');
    const AD = await import('../adapters/debug-log.js');
    const RT = await import('../core/model/runtime.js');
    // 造一条与用户报告一致的异常（宿主 ACL 拒绝 confirm）
    AD.wireDebugLog();
    DL.debugLogPush('异常', { kind: '未处理的 Promise 拒绝', message: 'Command plugin:dialog|confirm not allowed by ACL', source: 'unhandledrejection', line: 0, col: 0, stack: 'Command plugin:dialog|confirm not allowed by ACL' });
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'debug' });
    const page = String(panelBodyHtml('settings') || '');
    const hasBtn = page.indexOf('data-ftt-action="dbgExport"') >= 0 && page.indexOf('📦 导出调试包') >= 0;
    const r = await entry.popupAction('dbgExport', {});
    const after = String(panelBodyHtml('settings') || '');
    const bundle = globalThis.FTT.debugLogExport();
    const txt = globalThis.FTT.debugLogExportText();
    const bundleOk = !!bundle && bundle.format === 'ftt-memory-v2-debug' && bundle.version === RT.VERSION
        && !!bundle.env && !!bundle.dump && Array.isArray(bundle.logs) && bundle.logs.length >= 1
        && JSON.stringify(bundle.errors).indexOf('not allowed by ACL') >= 0
        && String(txt).indexOf('ftt-memory-v2-debug') >= 0;
    return hasBtn && r.ok === true && Number(r.chars) > 200 && after.indexOf('data-ftt-debugexport') >= 0 && bundleOk;
})(), '');

await assert('AR2 确认框 ACL 安全（用户报告的那条错误）：桥接型 confirm 返回的 Promise **被 await 而不是当成已确认**；拒绝/ACL 失败 → 按取消且不产生未处理拒绝；Tauri 宿主跳过原生 confirm', (async () => {
    const H = entry.panelRuntimeHooks();
    const savedPopup = host.ctx.callGenericPopup;
    const savedConfirm = globalThis.confirm;
    let unhandled = null;
    const onUnhandled = (e) => { unhandled = String((e && (e.reason || e.message)) || e); };
    try {
        process.on('unhandledRejection', onUnhandled);
        // ① 桥接型原生 confirm：resolve(true) → 确认；reject（ACL）→ 取消
        delete host.ctx.callGenericPopup;
        globalThis.confirm = () => Promise.resolve(true);
        const t1 = await H.confirm('测试确认', '');
        globalThis.confirm = () => Promise.reject(new Error('Command plugin:dialog|confirm not allowed by ACL'));
        const t2 = await H.confirm('测试确认', '');
        // ② Tauri 宿主：原生 confirm 会撞 ACL → 直接跳过（不调用）
        let called = false;
        globalThis.__TAURI_INTERNALS__ = {};
        globalThis.confirm = () => { called = true; return true; };
        const t3 = await H.confirm('测试确认', '');
        delete globalThis.__TAURI_INTERNALS__;
        // ③ 酒馆弹窗优先
        host.ctx.callGenericPopup = async () => 1;
        const t4 = await H.confirm('测试确认', '');
        await new Promise((r) => setTimeout(r, 30));
        return t1 === true && t2 === false && t3 === false && called === false && t4 === true && unhandled === null;
    } finally {
        process.removeListener('unhandledRejection', onUnhandled);
        if (savedPopup === undefined) delete host.ctx.callGenericPopup; else host.ctx.callGenericPopup = savedPopup;
        if (savedConfirm === undefined) delete globalThis.confirm; else globalThis.confirm = savedConfirm;
    }
})(), '');

await assert('AR3 入参透传回归：三个曾「点了没反应」的按钮经真实点击生效（投喂＋白 / 自查口径 / NSFW 词条删除）', (async () => {
    const FS = await import('../ui/feed-scan.js');
    const IC = await import('../ui/inject-check.js');
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'safety' });
    const el = doc.getElementById('ftt-panel');
    const click = (el && el.listeners && el.listeners.click) || [];
    const fire = (dataset) => {
        const tg = { dataset, closest: (sel) => (String(sel).indexOf('data-ftt-action') >= 0 ? tg : null) };
        click.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } }));
    };
    const w0 = JSON.stringify(FS.rxFeedTagLists());
    fire({ fttAction: 'rxAddTag', fttKind: 'white', fttTag: '冒烟标签Y' });
    await new Promise((r) => setTimeout(r, 0));
    const w1 = JSON.stringify(FS.rxFeedTagLists());
    const m0 = IC.injectCheckStats().useKeywords;
    fire({ fttAction: 'checkMode', fttMode: 'bare' });
    await new Promise((r) => setTimeout(r, 0));
    const m1 = IC.injectCheckStats().useKeywords;
    fire({ fttAction: 'nsfwKwDel', fttIdx: '0' });
    await new Promise((r) => setTimeout(r, 0));
    const note = String(panelState().note || '');
    // 收尾：把白名单与自查口径复位（避免影响后续小节）
    try { const d = JSON.parse(w1); d.white = d.white.filter((x) => x !== '冒烟标签Y'); } catch (e) { /* 忽略 */ }
    fire({ fttAction: 'checkMode', fttMode: 'kw' });
    await new Promise((r) => setTimeout(r, 0));
    return w0 !== w1 && w1.indexOf('冒烟标签Y') >= 0 && m0 === true && m1 === false && note.indexOf('已删除词条') >= 0;
})(), '');

// ---------- AS 交互/宿主/错误统一追踪（v2.42.0，用户要求：能追到底层关系与具体代码位置） ----------
await assert('AS1 用户交互入流：真实点击 → ① 原始「click」事件（点了什么/带哪些 data-ftt-*）② 动作事件（入参摘要/结果/耗时/opId/代码位置）', (async () => {
    const TR = await import('../core/trace.js');
    TR.traceClear();
    await entry.popupAction('tab', { tab: 'data' });
    TR.traceClear();
    const el = doc.getElementById('ftt-panel');
    const click = (el && el.listeners && el.listeners.click) || [];
    const tg = { tagName: 'BUTTON', dataset: { fttAction: 'refresh' }, closest: (sel) => (String(sel).indexOf('data-ftt-action') >= 0 ? tg : null) };
    click.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } }));
    await new Promise((r) => setTimeout(r, 10));
    const ui = TR.traceList({ cat: 'ui' });
    const clickEv = ui.filter((x) => x.kind === 'click')[0];
    const actEv = ui.filter((x) => x.kind === 'refresh')[0];
    return !!clickEv && clickEv.level === 'debug' && clickEv.detail.target === 'BUTTON'
        && !!clickEv.detail.attrs && clickEv.detail.attrs.fttAction === 'refresh'
        && !!actEv && /^op\d+$/.test(actEv.opId) && actEv.op === 'ui.refresh'
        && !!actEv.site && /\.js:\d+/.test(TR.traceSiteText(actEv.site))
        && String(actEv.detail.note || '').length >= 0 && actEv.ms >= 0;
})(), '');

await assert('AS2 宿主调用入流：经 getCtx() 的调用自动记 方法/参数/返回/耗时；站点是**调用方**（不是包装层）；同 op 内自动带 opId；异步调用 resolve 后追记', (async () => {
    const SA = await import('../host/st-api.js');
    const TR = await import('../core/trace.js');
    TR.traceClear();
    const ctx = SA.getCtx();
    const n0 = ctx.saveSettingsCount;
    ctx.saveSettingsDebounced();
    const sync = TR.traceList({ cat: 'host' })[0];
    // opId 关联：op 内发生的宿主调用归属该 op（跨层可回溯「谁调用的」）
    TR.traceClear();
    const op = TR.traceOpStart('ui.smokeCase');
    ctx.saveSettingsDebounced();
    const inOp = TR.traceList({ cat: 'host' })[0];
    TR.traceOpEnd(op, { ok: true });
    // 异步宿主调用：resolve 后追记结果
    TR.traceClear();
    ctx.generateRaw = async () => 'ok-text';
    await ctx.generateRaw({ prompt: 'x' });
    await new Promise((r) => setTimeout(r, 20));
    const asyncEv = TR.traceList({ cat: 'host' }).filter((x) => x.kind === 'generateRaw')[0];
    delete ctx.generateRaw;
    return !!sync && sync.cat === 'host' && sync.kind === 'saveSettingsDebounced' && sync.ok === true
        && TR.traceSiteText(sync.site).indexOf('tests/smoke-test.js') === 0
        && TR.traceSiteText(sync.site).indexOf('host/st-api.js') < 0
        && ctx.saveSettingsCount === n0 + 2
        && !!inOp && inOp.opId === op.opId && inOp.op === 'ui.smokeCase'
        && !!asyncEv && asyncEv.ok === true && asyncEv.ms >= 0;
})(), '');

await assert('AS3 异常不再孤立：trace 里是 error 事件（带 file:line 站点），调试日志条目附带 traceId + 前后上下文窗口 + opId', (async () => {
    const EV = await import('../host/events.js');
    const DL = await import('../core/debug-log.js');
    const AD = await import('../adapters/debug-log.js');
    const TR = await import('../core/trace.js');
    const oldWin = globalThis.window;
    const listeners = {};
    globalThis.window = Object.assign({}, oldWin, {
        addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
        removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((x) => x !== fn); },
    });
    AD.wireDebugLog();
    TR.traceClear();
    // 先造一段「之前发生了什么」：同一 op 下的宿主调用 → 然后报错
    const op = TR.traceOpStart('ui.smokeCrash');
    TR.traceEvent({ cat: 'host', kind: 'smokeBefore', opId: op.opId, op: op.name });
    const installed = EV.installErrorCapture();
    (listeners.unhandledrejection || []).forEach((fn) => fn({ reason: new Error('smoke-trace-reject') }));
    TR.traceOpEnd(op, { ok: false });
    const est = TR.traceList({ cat: 'error' }).filter((x) => x.reason.indexOf('smoke-trace-reject') >= 0)[0];
    const logs = DL.debugLogList ? DL.debugLogList() : [];
    const rawEntry = (logs || []).filter((x) => x.kind === '异常' && String(x.data || '').indexOf('smoke-trace-reject') >= 0).pop();
    const errData = (() => { try { return typeof rawEntry.data === 'string' ? JSON.parse(rawEntry.data) : (rawEntry.data || {}); } catch (e) { return {}; } })();
    const errEntry = { data: errData };
    const ctxWin = (est ? TR.traceContext(est.id, 20).window : []) || [];
    EV.uninstallErrorCapture();
    globalThis.window = oldWin;
    return installed === true && !!est && est.ok === false && est.level === 'error' && !!est.site
        && !!errEntry && !!errEntry.data.traceId && errEntry.data.traceId === est.id
        && Array.isArray(errEntry.data.context.window) && errEntry.data.context.window.length >= 2
        && errEntry.data.context.window.some((x) => x.kind === 'smokeBefore')
        && errEntry.data.opId === op.opId && Array.isArray(errEntry.data.context.related)
        && ctxWin.length >= 2 && !!errEntry.data.how;
})(), '');

await assert('AS4 调试页「🧭 交互与宿主调用时间线」区块 + 调试包（含 traceStats/trace/timeline 人读文本）；类别筛选按钮可用', (async () => {
    const TR = await import('../core/trace.js');
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'debug' });
    const html = String(panelBodyHtml('settings') || '');
    const hasSection = html.indexOf('🧭 交互与宿主调用时间线') >= 0
        && html.indexOf('data-ftt-action="dbgTraceFilter"') >= 0
        && html.indexOf('data-ftt-action="dbgTraceClear"') >= 0;
    const r = await entry.popupAction('dbgTraceFilter', { kind: 'ui' });
    const filtered = String(panelBodyHtml('settings') || '');
    const r2 = await entry.popupAction('dbgTraceFilter', { kind: '' });
    const bundle = globalThis.FTT.debugLogExport();
    const timeline = globalThis.FTT.traceTimeline();
    const tlTxt = String(bundle.timeline || '');
    const statsOk = !!bundle.traceStats && typeof bundle.traceStats.total === 'number'
        && Array.isArray(bundle.trace) && typeof bundle.timeline === 'string'
        && (!tlTxt.length || /\d{2}:\d{2}:\d{2}\.\d{3}/.test(tlTxt))
        && tlTxt.indexOf('ftt-memory-v2-debug') < 0;
    const fttOk = typeof globalThis.FTT.trace === 'function' && typeof globalThis.FTT.traceList === 'function'
        && typeof globalThis.FTT.traceStats === 'function' && typeof globalThis.FTT.traceContext === 'function'
        && typeof globalThis.FTT.traceClear === 'function' && typeof globalThis.FTT.traceSite === 'function'
        && typeof timeline === 'string';
    return hasSection && r.ok !== false && r2.ok !== false && statsOk && fttOk
        && String(filtered).indexOf('data-ftt-action="dbgTraceFilter"') >= 0
        && JSON.stringify(globalThis.FTT.traceStats()).indexOf('session') >= 0;
})(), '');

await assert('AS5 开关生效：debugTraceUi=false 只停「用户交互」、debugTraceHost=false 只停「宿主调用」，其余类别照记；关闭后主流程不受影响', (async () => {
    const TR = await import('../core/trace.js');
    const RT = await import('../core/model/runtime.js');
    const SA = await import('../host/st-api.js');
    const ku = RT.cfg.debugTraceUi, kh = RT.cfg.debugTraceHost;
    TR.traceClear();
    RT.cfg.debugTraceUi = false;
    TR.traceEvent({ cat: 'ui', kind: 'x' });
    TR.traceEvent({ cat: 'error', kind: 'y', level: 'error' });
    const uiOff = TR.traceList({ cat: 'ui' }).length === 0 && TR.traceList({ cat: 'error' }).length === 1;
    RT.cfg.debugTraceUi = ku;
    TR.traceClear();
    RT.cfg.debugTraceHost = false;
    SA.getCtx().saveSettingsDebounced();
    TR.traceEvent({ cat: 'kernel', kind: 'z' });
    const hostOff = TR.traceList({ cat: 'host' }).length === 0 && TR.traceList({ cat: 'kernel' }).length === 1;
    RT.cfg.debugTraceHost = kh;
    // 还原后仍可记录（开关不改行为，只改记录）
    TR.traceClear();
    SA.getCtx().saveSettingsDebounced();
    const restored = TR.traceList({ cat: 'host' }).length === 1;
    return uiOff && hostOff && restored && ku === true && kh === true;
})(), '');

await assert('AT1 v2.43.0 位置修复：「V2 附加设定」只出现在**基础**子页（不再吊在 14 个子页页脚）；切换子页后随之消失/出现', (async () => {
    const ST = await import('../ui/settings-pages.js');
    await entry.popupAction('tab', { tab: 'settings' });
    const seen = {};
    for (const t of ST.SETTINGS_TABS) {
        await entry.popupAction('settingsSub', { sub: t.id });
        const h = String(panelBodyHtml('settings') || '');
        seen[t.id] = { has: h.indexOf('data-ftt-section="v2-extras"') >= 0, pageAt: h.indexOf('data-ftt-settings-page="' + t.id + '"'), secAt: h.indexOf('data-ftt-section="v2-extras"') };
    }
    const onlyBase = Object.keys(seen).every((k) => (k === 'base' ? seen[k].has === true : seen[k].has === false));
    const insideBase = seen.base.pageAt >= 0 && seen.base.secAt > seen.base.pageAt;   // 在基础页容器之内，而非容器之后的页脚
    await entry.popupAction('settingsSub', { sub: 'base' });
    const back = String(panelBodyHtml('settings') || '');
    const backOk = back.indexOf('data-ftt-section="v2-extras"') >= 0 && back.indexOf('data-ftt-v2="panelMaxWidth"') >= 0
        && back.indexOf('ftt_v2_dims') >= 0 && back.indexOf('data-ftt-action="importV1Dry"') >= 0;
    return onlyBase && insideBase && backOk;
})(), '');

await assert('AU1 v2.44.0 HTML 标签不污染数据：真实宿主楼层正文含 `<br>`/`<div>` → 自动提取落盘地点/场景不含标签；手工改写保存同样被清洗并如实回报', (async () => {
    const CE = await import('../core/clock-extract.js');
    const CP = await import('../core/clock-patrol.js');
    const RT = await import('../core/model/runtime.js');
    const saveChat = host.ctx.chat;
    const savedLoc = RT.state.state.location;
    const savedDate = RT.state.state.date;
    try {
        host.ctx.chat = [
            { is_user: true, mes: '甲：去仓库看看。<br>' },
            { is_user: false, mes: '▷1919年11月29日（东汉建武二十七年）·冬(死寂的长街)<br>▷码头仓库<br>甲推开木门。<div>墙角有一只铜箱。</div>' },
            { is_user: true, mes: '继续。' },
            { is_user: false, mes: '▷1919年11月30日（东汉建武二十七年）·冬(死寂的长街)\n▷钟鼓楼下<br>甲抬头看了看天色。' },
        ];
        RT.setLastMessageId(host.ctx.chat.length - 1);
        const res = CE.resolveStoryClock({ text: undefined });
        const r1 = CE.clockAutoExtractOnce({ force: true });
        const loc = String(RT.state.state.location || '');
        const scene = String(RT.state.state.sceneDesc || '');
        const noTag = !/[<][a-zA-Z/]/.test(loc) && !/[<][a-zA-Z/]/.test(scene) && loc.length > 0;
        // 手工改写：地点粘进 `<br>` → 落盘清洗 + note 说明
        const m = CP.setClockManual({ date: '1919-11-29', time: '傍晚', location: '码头仓库<br>' });
        const manLoc = String(RT.state.state.location || '');
        const notes = (m.notes || []).join(' ');
        // 最新一楼（HTML 排版）→ 地点应为「钟鼓楼下」；更早那楼不应再污染（单测 V 组已逐例覆盖）
        return noTag && res.location === '钟鼓楼下' && loc === '钟鼓楼下'
            && m.ok === true && manLoc === '码头仓库' && notes.indexOf('HTML') >= 0
            && String(RT.state.state.clockManual.location) === '码头仓库';
    } finally {
        try { CP.clearClockManual(); } catch (e) { /* 忽略 */ }
        host.ctx.chat = saveChat;
        RT.state.state.location = savedLoc;
        RT.state.state.date = savedDate;
    }
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
// v2.34.0：收尾 flush —— 先让未 await 的 thenable 断言完成、并等防呆微任务判定，再汇总（防「静默消失」）
try {
    for (const g of pendingGuards) { try { await g.settle(); } catch (e) { /* 断言自身异常已由内部捕获 */ } }
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
} catch (e) { /* 忽略 */ }
console.log('\n========== V2 冒烟：' + pass + ' 通过, ' + fail + ' 失败 ==========');
if (fail) { console.log('  失败项：' + failures.join(' | ')); process.exit(1); }
process.exit(0);
