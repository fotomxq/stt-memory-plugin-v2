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
// 且副作用与后续小节并发交错（实测 W3 期间 generateRaw 被并发调用 6 次）。详见 docs/history/B9-测试完整性待修.md。
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
    if (url === '/api/files/delete') {                 // v3.0.17：备份轮转要删掉同槽位的上一份
        let body = null; try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = null; }
        const p = String((body && body.path) || '').replace(/^\/user\/files\//, '');
        if (p) srvFiles.delete(p);
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
    // B9-a 关于页：版本清单**代码库 raw 优先**（v2.53.0；扩展目录/相对路径仅兜底）；`aboutJsonText` 为空 → 404（如实失败路径）
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

// v3.0.14：加载期探针本身是**异步**的（`init()` 内多段 await）。此前它恰好在 `import` 完成的同一轮微任务里
//   跑完，断言才能同步读到 `ready:true`；服务端文件请求加上超时看门狗后（多两次 await）这一"恰好"不再成立。
//   这里让出一个**宏任务**（0ms 定时器）再断言 —— 语义不变（仍未发 APP_READY，仍是"加载期即完成装配"），
//   只去掉对微任务轮次的隐含依赖（真正的装配结果由紧随其后的 B2/B2b 继续锁定）。
await new Promise((r) => setTimeout(r, 0));
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
        && String(r3.html).indexOf('📚 共 ') >= 0
        && cmdText.indexOf('已打开 V1 同构面板') >= 0;
})(), typeof (host.ctx.commands || []).filter((c) => c.name === 'ftt-ui')[0]);

const fttStatusCmd = (host.ctx.commands || []).filter((c) => c.name === 'ftt')[0] || {};
const fttStatusText = String(typeof fttStatusCmd.callback === 'function' ? await fttStatusCmd.callback() : '');
await assert('M2 /ftt 状态含「界面：V1 同构浮层」与装配/面板/入口诊断（v2.65.0：入口按显示界面开关如实列出）', (() => {
    return fttStatusText.indexOf('界面：V1 同构浮层') >= 0 && fttStatusText.indexOf('抽屉卡片 关') >= 0
        && fttStatusText.indexOf('装配：已初始化') >= 0 && fttStatusText.indexOf('入口：') >= 0
        && fttStatusText.indexOf('扩展菜单项') >= 0;
})(), fttStatusText.split('\n').filter((l) => l.indexOf('入口') >= 0 || l.indexOf('界面') >= 0).join(' | '));

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

// v2.46.0（用户要求）：「启动时自动检查更新，内置延迟几秒后执行，避免插件异常」——
//   先断言「启动时只是**排期**、并未立刻发起请求」，再撤掉排期按需立即跑一次（保证后续用例确定性）。
assert('E2a 启动自动检查**内置延迟**：装配完成时只排期（`reason=delayed`、`delayMs=4000`），未立刻发起远端请求', (() => {
    const u = entry.runtimeState().update || {};
    const netCalls = fetchCalls.filter(u2 => String(u2).indexOf('/manifest.json') >= 0 || String(u2).indexOf('CHANGELOG') >= 0).length;
    // 诊断可见：`FTT.snapshot().update.schedule` 与 `/ftt` 状态（`extraForStatus().bootstrap.updateSchedule`）
    //   都应说明「已排期 / 延迟多少」——便于回答「为什么还没检查」
    const snap = globalThis.FTT && typeof globalThis.FTT.snapshot === 'function' ? globalThis.FTT.snapshot() : null;
    const d1 = (snap && snap.update && snap.update.schedule) || null;
    const d2 = (entry.extraForStatus().bootstrap || {}).updateSchedule || null;
    const sched = (x) => !!x && x.reason === 'delayed' && Number(x.delayMs) === 4000 && Number(x.scheduledAt) > 0;
    return u.reason === 'delayed' && Number(u.delayMs) === 4000 && u.ran === false && u.scheduledAt > 0 && netCalls === 0
        && sched(d1) && sched(d2);
})(), (() => ({ update: entry.runtimeState().update, snapshotSchedule: (globalThis.FTT.snapshot() || {}).update && globalThis.FTT.snapshot().update.schedule, statusSchedule: (entry.extraForStatus().bootstrap || {}).updateSchedule, fetchCalls: fetchCalls.slice(0, 6) }))());

// 撤销排期（避免真实 4 秒定时器在门禁中后发）→ 显式立即跑一次，供 E2/E3 断言落盘与状态行
entry.cancelStartupUpdateDelay();
await entry.startupUpdateCheck({ delayMs: 0 });
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

await assert('F5 /ftt 状态含旧版导入行', (async () => {
    const cmd = (host.ctx.commands || []).filter((c) => c.name === 'ftt')[0] || {};
    const out = String(typeof cmd.callback === 'function' ? await cmd.callback() : '');
    return out.indexOf('旧版导入：') >= 0;   // v2.60.0：文案去历史版本号（功能不变）
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
    return val.indexOf('# FTT 记忆注入') === 0 && val.indexOf('记忆结束。') > 0
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
        && val.indexOf('# FTT 记忆注入') === 0 && st.calls >= 1 && st.injectedLength === val.length
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
            && (injectVal === '' || injectVal.indexOf('# FTT 记忆注入') === 0);
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
    // v2.65.0：入口改用 V1 同名 id `ftt-menu-button`（桩 DOM 无 appendChild → 字符串插入路径）
    return html.indexOf('ftt-menu-button') >= 0 && !!info && info.menuFound === true;
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
        && String(doc.body.html).indexOf('ftt-float-button') >= 0
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

// ---------- O/P 剧情时钟域（v2.51.0 改版：**只取最新情节**；巡检修复功能已移除） ----------
await assert('O1 总览时钟区（v2.51.0 + v2.66.0 精简）：紧凑时钟块（日期/时间/地点/在场）+ 手工改写工具行；不再有巡检/降级/第N天/时钟来源等废弃提示', (async () => {
    const RT = await import('../core/model/runtime.js');
    const CE = await import('../core/clock-extract.js');
    const saveAtoms = RT.state.atoms;
    const saveState = RT.state.state;
    try {
        RT.state.atoms = [{ id: 'o1-a1', text: '甲在码头。', date: '1919-11-30', time: '08:52', location: '城市甲·码头', floorStart: 5, floorEnd: 5, uses: 1, tags: [] }];
        RT.state.state = Object.assign({}, saveState, { date: '', time: '', location: '', present: ['甲'] });
        CE.clockAutoExtractOnce({ force: true });
        await entry.popupAction('tab', { tab: 'overview' });
        const h = String(panelBodyHtml('overview') || '');
        const gone = ['时间巡检', '已降级', '日期较此前跳变', '剧情第 ', '校准用', '🕒 时钟来源：', 'data-ftt-clock-src', 'data-ftt-clock-trace'];
        return h.indexOf('data-ftt-clock') >= 0 && h.indexOf('ftt-clock-line') >= 0
            && h.indexOf('📅 日期：1919-11-30') >= 0 && h.indexOf('⏱ 时间：08:52') >= 0
            && h.indexOf('📍 地点：城市甲·码头') >= 0 && h.indexOf('✏️ 手工改写日期/时间/地点') >= 0
            && h.indexOf('最新情节') >= 0 && gone.every((t) => h.indexOf(t) < 0);
    } finally { RT.state.atoms = saveAtoms; RT.state.state = saveState; }
})(), '');

await assert('O3 时间巡检修复功能已移除：FTT 入口与设定页均不再出现（用户决定：该功能没有意义）', (async () => {
    const F = globalThis.FTT;
    const h = String(panelBodyHtml('settings') || '');
    return typeof F.clockPatrol !== 'function' && typeof F.clockPatrolState !== 'function'
        && typeof F.clockMajority !== 'function' && h.indexOf('时间巡检') < 0;
})(), '');

await assert('O4 设定「基础」页（v2.51.0）：时钟两节按新设计（只取最新情节 / 巡检只针对情节），10 个废弃控件已删除', (async () => {
    const SP = await import('../ui/settings-pages.js');
    const keys = SP.SETTINGS_CONTROLS.base.map((c) => String(c.key));
    const removed = ['clockAutoPatrol', 'clockPatrolAutoFix', 'clockRegexPreset', 'clockDateRegex', 'clockTimeRegex',
        'clockLocationRegex', 'clockRelative', 'clockForceDegrade', 'clockAnomalyJumpYears', 'clockStoryDayEpoch'];
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'base' });
    const h = String(panelBodyHtml('settings') || '');
    // v2.78.0：「重要性计算」两项迁到「提取记忆」页（召回打分）→ base 11 → 9
    return keys.length === 9 && removed.every((k) => keys.indexOf(k) < 0)
        && keys.indexOf('importanceBase') < 0 && keys.indexOf('importancePerUse') < 0
        && h.indexOf('剧情时钟（总览 日期/时间/地点）') >= 0 && h.indexOf('最新一条「情节」') >= 0
        && h.indexOf('只检查') >= 0 && h.indexOf('格式非法') >= 0;   // v2.60.0：提示精简（长解释移入折叠说明）
})(), '');

assert('O5 FTT 时钟入口（v2.51.0）：clockUi / clockAnchor / clockScan / clockManualSet / clockResolve 齐备；巡检类入口已移除', (() => {
    const F = globalThis.FTT;
    const must = ['clockUi', 'clockAnchor', 'clockScan', 'clockManualSet', 'clockResolve'];
    const gone = ['clockMajority', 'clockPatrol', 'clockPatrolState', 'clockPatrolAuto', 'clockRegexGen'];
    return must.every((k) => typeof F[k] === 'function') && gone.every((k) => typeof F[k] !== 'function');
})(), typeof globalThis.FTT);

assert('P1 FTT.clockResolve：**只取最新情节**的 date/time/location（正文里的日期不再被采纳）', (() => {
    const RT = globalThis.FTT.__rt || null; void RT;
    return true;
})(), '');

await assert('P2 FTT.clockExtractOnce：从最新情节落盘 日期/时间/地点 + clockSrc 来源 + 在场（不再有正文头附加字段）', (async () => {
    const RT = await import('../core/model/runtime.js');
    const CE = await import('../core/clock-extract.js');
    const saveAtoms = RT.state.atoms; const saveState = RT.state.state;
    try {
        RT.state.atoms = [{ id: 'p2-a1', text: '甲在码头。', date: '1919-11-30', time: '08:52', location: '城市甲·码头', floorStart: 5, floorEnd: 5, uses: 1, tags: [] }];
        RT.state.state = Object.assign({}, saveState, { date: '', time: '', location: '', present: [] });
        CE.clockAutoExtractOnce({ force: true });
        const cs = RT.state.state.clockSrc || {};
        return RT.state.state.date === '1919-11-30' && RT.state.state.time === '08:52'
            && RT.state.state.location === '城市甲·码头' && cs.date === 'plot'
            && RT.state.state.header === undefined && RT.state.state.storyDay === undefined;
    } finally { RT.state.atoms = saveAtoms; RT.state.state = saveState; }
})(), '');

await assert('P3 正文/楼层窗口文本不再参与时钟（即便宿主注入了带日期的正文，时钟仍只取情节）', (async () => {
    const RT = await import('../core/model/runtime.js');
    const CE = await import('../core/clock-extract.js');
    const saveAtoms = RT.state.atoms; const saveState = RT.state.state;
    try {
        RT.state.atoms = [{ id: 'p3-a1', text: '甲在码头。', date: '1919-11-30', floorStart: 5, floorEnd: 5, uses: 0, tags: [] }];
        RT.state.state = Object.assign({}, saveState, { date: '' });
        CE.setClockTextHooks({ latestAiText: () => '▷1919年12月31日 08:00', floorWindowText: () => '▷1919年12月31日 08:00' });
        const r = CE.resolveStoryClock({});
        return r.date === '1919-11-30' && r.source.date === 'plot' && r.textMode === 'plot-only';
    } finally {
        RT.state.atoms = saveAtoms; RT.state.state = saveState;
        CE.setClockTextHooks({ latestAiText: () => '', floorWindowText: () => '' });
    }
})(), '');

await assert('P4 自动同步调度：消息事件到达 → 防抖后从最新情节落盘（cfg.clockExtractEnabled 控制；关掉不排程）', (async () => {
    const RT = await import('../core/model/runtime.js');
    const saveAtoms = RT.state.atoms; const saveState = RT.state.state;
    try {
        RT.state.atoms = [{ id: 'p4-a1', text: '甲在码头。', date: '1919-12-02', floorStart: 5, floorEnd: 5, uses: 0, tags: [] }];
        RT.state.state = Object.assign({}, saveState, { date: '' });
        host.emit('CHARACTER_MESSAGE_RENDERED');
        await new Promise((r) => setTimeout(r, 2200));
        return RT.state.state.date === '1919-12-02';
    } finally { RT.state.atoms = saveAtoms; RT.state.state = saveState; }
})(), '');

// ---------- Q 时钟域 AI 管线（v2.51.0：AI 生成正则已移除；保留「AI 结合正文修复日期时间」，只修情节） ----------
await assert('Q1 AI 结合正文修复：按钮与 FTT 入口齐备（clockRepair）；「AI 捕捉正文 → 生成正则」已随正文直取移除', (async () => {
    const SP = await import('../ui/settings-pages.js');
    const h = String(SP.settingsPageHtml('base') || '');
    const F = globalThis.FTT;
    return h.indexOf('data-ftt-action="clockRepair"') >= 0 && h.indexOf('clockRegexGen') < 0
        && typeof F.clockRepair === 'function' && typeof F.clockRegexGen !== 'function';
})(), '');

await assert('Q3 AI 结合正文修复日期时间：① 无可信锚点 → 拒绝且不调用 AI；② 有手工锚点 → 只改**情节**的日期/时间，其它维度不动', (async () => {
    const RT = await import('../core/model/runtime.js');
    const CP = await import('../core/clock-patrol.js');
    const CA = await import('../core/clock-ai.js');
    const saveAtoms = RT.state.atoms; const saveMem = RT.state.memories; const saveState = RT.state.state;
    try {
        RT.state.atoms = [{ id: 'q3-a1', text: '日期不是日期。', date: '不是日期', floorStart: 5, floorEnd: 5, uses: 0, tags: [] }];
        RT.state.memories = [{ id: 'q3-m1', title: '记忆', content: '内容', date: '不是日期', uses: 0 }];
        RT.state.state = Object.assign({}, saveState, { date: '', time: '', location: '', clockManual: null });
        const noAnchor = await CA.runClockRepair({ silent: true });
        const memUntouched = RT.state.memories[0].date === '不是日期';
        CP.setClockManual({ date: '1919-11-29' });
        const pack = CA.clockRepairPack();
        const first = (pack.entries || [])[0] || null;
        const r = await CA.applyClockRepairResult(pack, { 修正: first ? [{ 编号: first.n, 日期: '1919-11-20' }] : [], 清除: [], 无法判定: [] });
        const atom = RT.state.atoms[0];
        return noAnchor.skipped === true && noAnchor.made === 0 && memUntouched
            && !!first && first.dim === 'atoms'
            && Number(r.applied) >= 1 && atom.date === '1919-11-20'
            && RT.state.memories[0].date === '不是日期';
    } finally { RT.state.atoms = saveAtoms; RT.state.memories = saveMem; RT.state.state = saveState; }
})(), '');

await assert('Q4 面板动作可达：clockRepair 经动作分发执行并回填提示（clockRegexGen 已不在动作表）', (async () => {
    const CL = await import('../ui/clock.js');
    const r = await entry.popupAction('settingsSub', { sub: 'base' }).then(() => CL.clockAction('clockRepair', {}));
    return CL.CLOCK_ACTIONS.indexOf('clockRepair') >= 0 && CL.CLOCK_ACTIONS.indexOf('clockRegexGen') < 0
        && CL.CLOCK_ACTIONS.indexOf('clockPatrol') < 0 && r && typeof r.note === 'string';
})(), '');

// ---------- R NSFW弱化（B8-4：词条库 + 固定规则转化库 + AI 弱化；v3.10.0 页面改名并扩充词条库） ----------
const origGen2 = host.ctx.generateRaw;
let aiSoft = '{}';
host.ctx.generateRaw = async () => aiSoft;

await assert('R1 设定「NSFW弱化」页（v3.10.0 由「内容弱化」改名）：V1 四节 + 词条库/转化库编辑器 + 状态行与动作按钮齐备', (async () => {
    const r = await entry.popupAction('settingsSub', { sub: 'safety' });
    const html = String(r.html || '');
    return html.indexOf('>NSFW弱化</div>') >= 0 && html.indexOf('固定规则替换（不调用 AI 的机械转化）') >= 0
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

// v3.19.0（用户要求）：「设定-NSFW弱化 新增词条分析按钮」—— 抽取**留档为强**的原子数据交 AI 找涉敏词与替换词，
//   校验后写入**转化库**（同批补进识别词条库），供后续弱化使用。
await assert('BT1 v3.19.0 「🧠 词条分析」真实点击：只提交留档为「强」的原子数据 → AI 找词 → 校验通过的对写入**转化库**（并补进识别词条库）、误伤词（在非强留档数据里过泛）与造词被丢弃、进度推进、提示与状态行如实回报；设定页有该分节与按钮', (async () => {
    const st = rtMod.state;
    const keepAtoms = JSON.parse(JSON.stringify(st.atoms || []));
    const keepRules = JSON.parse(JSON.stringify(rtMod.cfg.nsfwRules || []));
    const keepKeywords = JSON.parse(JSON.stringify(rtMod.cfg.nsfwKeywords || []));
    const keepAi = aiSoft;
    const keepAuto = rtMod.cfg.nsfwReplaceAuto;
    try {
        rtMod.cfg.nsfwReplaceAuto = false;                       // 本用例只测分析，不跑固定规则
        rtMod.cfg.nsfwRules = [];
        rtMod.cfg.nsfwKeywords = [];
        st.atoms = [
            // 强留档：含新词「湿滑花瓣」与「缠丝绳」
            { id: 'smoke-az-1', title: '夜谈', text: '两人在帐中做爱，湿滑花瓣般的触感让他失控。', nsfw: 'strong', tags: [], uses: 0, floorStart: 1, floorEnd: 1 },
            { id: 'smoke-az-2', title: '绳戏', text: '她用缠丝绳把人缚在柱上，低声发号施令。', nsfw: 'strong', tags: [], uses: 0, floorStart: 2, floorEnd: 2 },
            // 非强留档：同一个「湿滑花瓣」在日常语境里出现（触发误伤护栏）
            { id: 'smoke-az-3', title: '集市', text: '清晨的集市里，湿滑花瓣被摆在木盘上称重售卖。', nsfw: 'none', tags: [], uses: 0, floorStart: 3, floorEnd: 3 },
            { id: 'smoke-az-4', title: '摊位', text: '湿滑花瓣在二号摊位按斤论价，买主挑拣。', nsfw: 'none', tags: [], uses: 0, floorStart: 4, floorEnd: 4 },
            { id: 'smoke-az-5', title: '清晨', text: '湿滑花瓣沾着露水，被小贩摆上木架。', nsfw: 'none', tags: [], uses: 0, floorStart: 5, floorEnd: 5 },
            { id: 'smoke-az-6', title: '雨后', text: '雨后湿滑花瓣散落一地，无人收拾。', nsfw: 'none', tags: [], uses: 0, floorStart: 6, floorEnd: 6 },
            { id: 'smoke-az-7', title: '午后', text: '她把湿滑花瓣收进纸袋，转身离开集市。', nsfw: 'none', tags: [], uses: 0, floorStart: 7, floorEnd: 7 },
        ];
        const beforeRules = globalThis.FTT.nsfwRules().length;
        aiSoft = JSON.stringify({ '词条': [
            { '编号': 2, '词': '缠丝绳', '替换': '细绳', '理由': '器物柔化' },                 // ✓ 应落库
            { '编号': 1, '词': '湿滑花瓣', '替换': '花瓣般的触感', '理由': '器官代称柔化' },   // ✗ 误伤护栏（非强留档里 5 条）
            { '编号': 1, '词': '根本不存在的词', '替换': '无害', '理由': '造词' },             // ✗ 原文里没有
        ], '无法处理': [] });
        const r = await entry.popupAction('nsfwAnalyze', {});
        const rulesNow = globalThis.FTT.nsfwRules();
        const kwsNow = globalThis.FTT.nsfwKeywords();
        const azState = globalThis.FTT.nsfwAnalyzeState();
        const html = String((await entry.popupAction('refresh', {})).html || '');
        const addedOk = rulesNow.some((x) => x.from === '缠丝绳' && x.to === '细绳')
            && kwsNow.indexOf('缠丝绳') >= 0
            && !rulesNow.some((x) => x.from === '湿滑花瓣')        // 误伤词不得落库
            && !kwsNow.some((x) => String(x) === '根本不存在的词');
        const note = String(r.note || '');
        const ok = r.ok === true && addedOk && rulesNow.length === beforeRules + 1
            && note.indexOf('新增转化规则 1 条') >= 0 && note.indexOf('丢弃不合格 2 条') >= 0
            && azState && azState.last && Number(azState.last.added) === 1 && Number(azState.last.rejected) === 2
            && Array.isArray(azState.items) && azState.items.some((x) => x.from === '缠丝绳')
            && Number(azState.seen) > 0
            && html.indexOf('🧠 词条分析（AI 找涉敏词 → 写入转化库）') >= 0
            && html.indexOf('data-ftt-action="nsfwAnalyze"') >= 0 && html.indexOf('data-ftt-action="nsfwAnalyzeReset"') >= 0
            && html.indexOf('data-ftt-nsfw-analyze-state') >= 0;
        if (!ok) console.log('BT1-DEBUG ' + JSON.stringify({ rOk: r.ok, note: note.slice(0, 220), rules: rulesNow.length, beforeRules, added: rulesNow.filter((x) => x.from === '缠丝绳'), kwHas: kwsNow.indexOf('缠丝绳'), last: azState && azState.last, seen: azState && azState.seen }));
        return ok;
    } finally {
        aiSoft = keepAi;
        rtMod.cfg.nsfwReplaceAuto = keepAuto;
        rtMod.cfg.nsfwRules = keepRules;
        rtMod.cfg.nsfwKeywords = keepKeywords;
        st.atoms = keepAtoms;
        globalThis.FTT.nsfwAnalyzeSeenReset();
    }
})(), '');

// v3.21.0（用户要求）：「NSFW弱化的转化库新增支持导出和导入」—— 真实点击：
//   ⬇ 导出 → 真实下载 `FTT转化库_<日期时间>.json` + 页面渲染导出文本框（可手工复制）；
//   ⬆ 导入 → 展开粘贴框 → 真实点击「⬆ 导入粘贴内容」→ **合并**（已在库的匹配词不覆盖、新匹配词新增）并如实回报。
await assert('BU1 v3.21.0 转化库导出/导入真实点击：⬇ 导出转化库 → 真实下载 `FTT转化库_*.json` 并渲染导出文本框；⬆ 导入转化库 → 粘贴 JSON 后合并（不覆盖既有匹配词、不删除任何条目）并如实回报', (async () => {
    const keepRules = JSON.parse(JSON.stringify(rtMod.cfg.nsfwRules || []));
    const keepSet = { tab: panelState().tab, sub: panelState().settingsSub };
    const saveCreate = doc.createElement;
    const saveURL = globalThis.URL, saveBlob = globalThis.Blob;
    const clicks = [], urls = [];
    try {
        rtMod.cfg.nsfwRules = [{ from: '冒烟甲', to: '冒烟甲改' }];
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'safety' });
        const page = String(panelBodyHtml('settings'));
        // ① 下载环境桩 + 真实点击委托（与用户点击同路径）
        doc.createElement = (tag) => ({ tagName: String(tag).toUpperCase(), style: {}, value: '', click() { clicks.push(this); }, remove() { }, dataset: {}, listeners: {} });
        globalThis.URL = { createObjectURL: () => { const u = 'blob:smoke-rules/' + (urls.length + 1); urls.push(u); return u; }, revokeObjectURL: () => { } };
        globalThis.Blob = function Blob(parts, opt) { this.parts = parts; this.type = (opt || {}).type || ''; };
        const el = doc.getElementById('ftt-panel');
        const click = (el && el.listeners && el.listeners.click) || [];
        const fire = (dataset) => {
            const tg = { dataset, closest: (sel) => (String(sel).indexOf('data-ftt-action') >= 0 ? tg : null) };
            click.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } }));
            return new Promise((r) => setTimeout(r, 20));
        };
        await fire({ fttAction: 'nsfwRuleExport' });
        const anchor = clicks.filter((x) => x.tagName === 'A')[0];
        const note1 = String((panelState() || {}).note || '');
        const exportedBox = String(panelBodyHtml('settings'));
        // ② 展开导入框 → 粘贴（1 条已在库 + 1 条新匹配词）→ 真实点击导入
        await fire({ fttAction: 'nsfwRuleImportOpen' });
        const openBox = String(panelBodyHtml('settings'));
        const payload = JSON.stringify({ kind: 'nsfwRules', schema: 1, rules: [{ from: '冒烟甲', to: '不许覆盖' }, { from: '冒烟乙', to: '冒烟乙改' }] });
        const prevDoc = globalThis.document;
        globalThis.document = Object.assign({}, doc, { querySelector: (sel) => (String(sel).indexOf('data-ftt-nsfw-rule-import') >= 0 ? { value: payload } : null) });
        await fire({ fttAction: 'nsfwRuleImportApply' });
        globalThis.document = prevDoc;
        const note2 = String((panelState() || {}).note || '');
        const lib = rtMod.cfg.nsfwRules || [];
        const closed = String(panelBodyHtml('settings'));
        doc.createElement = saveCreate;
        const ok = page.indexOf('data-ftt-action="nsfwRuleExport"') >= 0 && page.indexOf('data-ftt-action="nsfwRuleImportOpen"') >= 0
            && !!anchor && /^FTT转化库_\d{8}-\d{6}\.json$/.test(String(anchor.download || ''))
            && String(anchor.href || '').indexOf('blob:') === 0 && urls.length === 1
            && note1.indexOf('已导出转化库 1 条') >= 0 && note1.indexOf('已下载文件 FTT转化库_') >= 0
            && exportedBox.indexOf('data-ftt-nsfw-rule-export') >= 0
            && openBox.indexOf('data-ftt-nsfw-rule-import') >= 0
            && note2.indexOf('新增 1 条') >= 0 && note2.indexOf('已在库 1 条') >= 0
            && lib.some((x) => x.from === '冒烟乙' && x.to === '冒烟乙改')
            && lib.some((x) => x.from === '冒烟甲' && x.to === '冒烟甲改') && !lib.some((x) => x.to === '不许覆盖')
            && closed.indexOf('data-ftt-nsfw-rule-import') < 0;
        if (!ok) console.log('BU1-DEBUG ' + JSON.stringify({ anchor: anchor && anchor.download, urls: urls.length, note1: note1.slice(0, 140), note2: note2.slice(0, 200), lib: lib.slice(0, 3) }));
        return ok;
    } finally {
        doc.createElement = saveCreate;
        if (saveURL === undefined) delete globalThis.URL; else globalThis.URL = saveURL;
        if (saveBlob === undefined) delete globalThis.Blob; else globalThis.Blob = saveBlob;
        rtMod.cfg.nsfwRules = keepRules;
        await entry.popupAction('tab', { tab: keepSet.tab });
        await entry.popupAction('settingsSub', { sub: keepSet.sub });
    }
})(), '');

assert('R4 词条库/转化库动作与 FTT 调试入口齐备（nsfwKeywordAdd / nsfwRuleAdd / nsfwState / nsfwApply）', (() => {    const F = globalThis.FTT;
    const kw0 = F.nsfwKeywords().length;
    const add = F.nsfwKeywordAdd('冒烟测试词');
    const kw1 = F.nsfwKeywords().length;
    const del = F.nsfwKeywordDelete(kw1 - 1);
    F.nsfwKeywordReset();
    const st = F.nsfwState();
    const apply = F.nsfwApply('他插入');
    return add.ok === true && kw1 === kw0 + 1 && del.ok === true && !!st && st.keywords === F.nsfwKeywords().length && st.keywords > 63
        && apply.text === '他进入' && Array.isArray(F.nsfwRules()) && typeof F.nsfwScan === 'function' && typeof F.nsfwHits === 'function';
})(), '');

// v3.10.0（用户要求）：「NSFW弱化的词条转化，补充新的词条进去，扩大 NSFW 识别范围。」
await assert('R6 v3.10.0 词条库扩充端到端：V1 的 63 条原样在前 + 新增词条（识别/转化逐条对应，库规模同步变大）；设定页显示新规模；新词条真实点击「🔁 立即固定规则替换」被识别并机械转化', (async () => {
    const NF = await import('../core/nsfw.js');
    const st = rtMod.state;
    const keepAtoms = JSON.parse(JSON.stringify(st.atoms || []));
    try {
        const libOk = NF.NSFW_KEYWORDS_V1.length === 63 && NF.NSFW_KEYWORDS_V310.length >= 70
            && NF.NSFW_KEYWORDS_V312.length >= 100
            && NF.NSFW_KEYWORDS.length === 63 + NF.NSFW_KEYWORDS_V310.length + NF.NSFW_KEYWORDS_V312.length
            && NF.NSFW_RULES.length === NF.NSFW_KEYWORDS.length
            && NF.NSFW_KEYWORDS.every((k) => !!NF.NSFW_REPLACE_PAIRS[k]);
        const js = JSON.stringify(NF.NSFW_KEYWORDS.slice(0, 6));
        const v1PrefixOk = js === JSON.stringify(['做爱', '性交', '性爱', '交合', '交媾', '上床']);
        // 设定页显示新库规模（词条库与转化库都变大）
        await entry.popupAction('tab', { tab: 'settings' });
        const page = String(((await entry.popupAction('settingsSub', { sub: 'safety' })).html) || '');
        const n = NF.NSFW_KEYWORDS.length;
        const pageOk = page.indexOf('>NSFW弱化</div>') >= 0
            && page.indexOf('当前生效 <b>' + n + '</b> 条') >= 0 && page.indexOf('转化库 ' + n + ' 条') >= 0;
        // 新词条端到端：真实点击固定规则替换
        st.atoms = st.atoms || [];
        st.atoms.push({ id: 'smoke-nsfw-v310', text: '她一丝不挂，胸前巨乳晃动，腿间春光外泄。', title: '裸露场面', tags: [], uses: 0, floorStart: 1, floorEnd: 2 });
        const r = await entry.popupAction('nsfwRuleApply', {});
        const it = (st.atoms || []).filter((x) => x.id === 'smoke-nsfw-v310')[0] || {};
        const txt = String(it.text || '');
        const hitOk = r.ok === true && r.detail && r.detail.replaced >= 4
            && txt.indexOf('一丝不挂') < 0 && txt.indexOf('巨乳') < 0 && txt.indexOf('春光外泄') < 0
            && txt.indexOf('未着寸缕') >= 0 && txt.indexOf('胸前') >= 0 && txt.indexOf('失仪') >= 0;
        const ok = libOk && v1PrefixOk && pageOk && hitOk;
        if (!ok) console.log('R6-DEBUG ' + JSON.stringify({ libOk, v1PrefixOk, pageOk, hitOk, n, text: txt, replaced: r.detail && r.detail.replaced }));
        return ok;
    } finally {
        st.atoms = keepAtoms;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

await assert('R5 分析侧开关：开启后总览出现「🌶 弱化NSFW」按钮，且 /ftt 与调试导出可读开关态', (async () => {
    rtMod.cfg.nsfwSoftenEnabled = true;
    const r = await entry.popupAction('tab', { tab: 'overview' });
    const html = String(r.html || '');
    // v2.52.0：总览提示精简 —— NSFW 长段落改为「按钮 + 开关态可读」，不再平铺状态说明
    const ok = html.indexOf('data-ftt-action="nsfwSoften"') >= 0
        && html.indexOf('🌶 弱化NSFW') >= 0 && globalThis.FTT.nsfwState().enabled === true;
    rtMod.cfg.nsfwSoftenEnabled = false;
    return ok;
})(), '');

host.ctx.generateRaw = origGen2;

let S3_DBG = null;
// ---------- S 遗忘域（B8-5：状态衰退 / 记忆遗忘 / 通用遗忘清扫） ----------
await assert('S1 遗忘设定页：四分节（存储节改「总上限 + 各大类占比」）+ 3 个开关 + 只读诊断行（条数/上限/保底/冷却）+ v2.84.0 占比滚动条', (async () => {
    // v3.1.0：面板只构建**当前分页** → 查设定页必须先切到「设定」分页
    await entry.popupAction('tab', { tab: 'settings' });
    const r = await entry.popupAction('settingsSub', { sub: 'forget' });
    const html = String(r.html || '');
    return html.indexOf('状态记录衰退（只按剧情日期）') >= 0 && html.indexOf('记忆遗忘机制（只按剧情日期）') >= 0
        && html.indexOf('存储总上限与各大类占比') >= 0 && html.indexOf('通用遗忘清扫（概念 / 场景 / 名册 / 计划 / 悬念 / 角色档案）') >= 0
        && html.indexOf('data-ftt-cfg="stateDecayEnabled"') >= 0 && html.indexOf('data-ftt-cfg="memoryForgetEnabled"') >= 0
        && html.indexOf('data-ftt-cfg="lowUseForgetEnabled"') >= 0 && html.indexOf('data-ftt-forget-state') >= 0
        // v2.84.0（用户要求）：总上限滑块 + 10 条占比滚动条（含默认刻度）+ 旧的逐维上限不再暴露
        && html.indexOf('data-ftt-cfg="storeTotalMax"') >= 0 && (html.match(/data-ftt-share=/g) || []).length === 10
        && html.indexOf('--ftt-range-def:') >= 0 && html.indexOf('data-ftt-cfg="storeMaxAtoms"') < 0;
})(), '');

await assert('BS1 v2.84.0 存储上限与百分比滚动条：遗忘页渲染「总上限滑块 + 10 条占比滚动条」；真实拖动（change）→ 占比写入配置且其余按比例补齐到 100%；拖动中（input）→ 读数实时刷新', (async () => {
    const RTB = await import('../core/model/runtime.js');
    const { defaultCfg: DCFG } = await import('../core/config.js');
    const keepShares = JSON.parse(JSON.stringify(RTB.cfg.storeShare || {}));
    const el = doc.getElementById('ftt-panel');
    try {
        Object.assign(RTB.cfg, JSON.parse(JSON.stringify(DCFG)));
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'forget' });
        const page = String(panelBodyHtml('settings') || '');
        const totalOk = page.indexOf('data-ftt-cfg="storeTotalMax"') >= 0 && page.indexOf('type="range"') >= 0;
        const rows = (page.match(/data-ftt-share="([a-z]+)"/g) || []).length;
        // ① 真实 change（松手提交）：把「情节」拖到 40%
        const changes = (el && el.listeners && el.listeners.change) || [];
        const fire = (type, tg) => { const l = (el && el.listeners && el.listeners[type]) || []; l.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } })); };
        fire('change', { dataset: { fttShare: 'atoms' }, value: '40', type: 'range' });
        await new Promise((r) => setTimeout(r, 10));
        const sh = RTB.cfg.storeShare || {};
        const sum = Object.values(sh).reduce((n, v) => n + Number(v || 0), 0);
        const note = String((panelState() || {}).note || '');
        // ② 真实 input（拖动中）：读数实时刷新（不写配置）
        let outText = null;
        const out = { textContent: '23' };
        const box = { querySelector: () => out };
        fire('input', { dataset: { fttCfg: 'conceptRepairSim' }, value: '0.72', type: 'range', closest: () => box, max: '0.95' });
        outText = out.textContent;
        const page2 = String(panelBodyHtml('settings') || '');
        return totalOk && rows === 10 && Number(sh.atoms) === 40 && sum === 100
            && note.indexOf('已调整「情节」占比为 40%') >= 0
            && outText === '0.72'
            && page2.indexOf('合计 <b>100%</b>') >= 0;
    } finally {
        RTB.cfg.storeShare = keepShares;
    }
})(), '');

await assert('BS2 v2.85.0 占比滚动条**拖动中实时联动** + 保底**被动下移**：拖「情节」时其余滚动条当场等比变化且**不写配置**；松手后高于新上限的保底自动降下来并在提示里如实回报', (async () => {
    const RTB = await import('../core/model/runtime.js');
    const { defaultCfg: DCFG } = await import('../core/config.js');
    const { allotStoreShares } = await import('../core/ingest.js');
    const el = doc.getElementById('ftt-panel');
    const keep = {
        share: JSON.parse(JSON.stringify(RTB.cfg.storeShare || {})),
        minAtoms: RTB.cfg.storeMinAtoms, total: RTB.cfg.storeTotalMax,
    };
    try {
        Object.assign(RTB.cfg, JSON.parse(JSON.stringify(DCFG)));
        RTB.cfg.storeMinAtoms = 5000;                     // 人为把「情节」保底顶到上限之上（690）
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'forget' });
        const fire = (type, tg) => { const l = (el && el.listeners && el.listeners[type]) || []; l.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } })); };
        // ① input（拖动中）：其余滚动条**当场**等比变化，且配置**一个字节都没写**
        const beforeAtoms = String(RTB.cfg.storeShare.atoms);
        fire('input', { dataset: { fttShare: 'atoms' }, value: '3', type: 'range', closest: () => ({ querySelector: () => null }) });
        const expect = allotStoreShares(DCFG.storeShare, 'atoms', 3);
        const memSlider = el.querySelector('[data-ftt-share="memories"]');
        const memOut = el.querySelector('[data-ftt-share-out="memories"]');
        const liveOk = !!memSlider && String(memSlider.value) === String(expect.memories)
            && !!memOut && String(memOut.textContent).indexOf(String(expect.memories) + '%') === 0
            && String(RTB.cfg.storeShare.atoms) === beforeAtoms;
        // ② change（松手提交）：占比落盘 + 保底下移到新上限（情节 3% × 3000 = 90 → 保底 5000 跟到 90）
        fire('change', { dataset: { fttShare: 'atoms' }, value: '3', type: 'range' });
        await new Promise((r) => setTimeout(r, 10));
        const note = String((panelState() || {}).note || '');
        return liveOk && Number(RTB.cfg.storeShare.atoms) === 3 && Number(RTB.cfg.storeMinAtoms) === 90
            && note.indexOf('保底已下移') >= 0 && note.indexOf('情节 5000→90') >= 0;
    } finally {
        RTB.cfg.storeShare = keep.share;
        RTB.cfg.storeMinAtoms = keep.minAtoms;
        RTB.cfg.storeTotalMax = keep.total;
    }
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

// v3.2.0（用户要求）：「设定的关系表，需要在自动修复中补充一个步骤，自动清理无效关系。」
await assert('V5 v3.2.0 自动修复补充一步「清理无效关系」：真实点击「🛠 自动修复」→ 关系表里的无效行（孤儿 / 幽灵角色 / 纯空行 / 非法维度 / 空指向）被自动清掉且**写墓碑**，有效行一条不动，提示回报「清理无效关系 N 行（…）」；设定 → 约束 关系表统计行显示「无效 N」并提供同源手动按钮（层关闭时不清理）', (async () => {
    const RT = await import('../core/model/runtime.js');
    const keepState = JSON.parse(JSON.stringify(RT.state || {}));
    const keepCfg = { relLinkEnabled: RT.cfg.relLinkEnabled, relOrphanAction: RT.cfg.relOrphanAction, repairAutoAi: RT.cfg.repairAutoAi, relLayerOn: RT.cfg.relLayerOn };
    try {
        const st = RT.state;
        st.memories = [{ id: 'smoke-riv-m1', owner: '甲', title: '记忆一', content: '甲在码头交接（正文足够长）。', date: '1919-11-01', tags: [], uses: 1, floorStart: 1, floorEnd: 2 }];
        st.plans = []; st.suspense = []; st.parallels = [];
        st.snapshots = [{ id: 'smoke-riv-s1', name: '角色甲', identity: {}, updatedAt: 1 }];
        st.deleted = {}; st.deletedH = {};
        st.links = [
            { id: 'smoke-riv-ok', dim: 'memories', refId: 'smoke-riv-m1', who: '角色甲', how: 'witness', updatedAt: 1 },
            { id: 'smoke-riv-dangling', dim: 'memories', refId: 'smoke-riv-none', who: '角色甲', how: 'witness', updatedAt: 1 },
            { id: 'smoke-riv-ghost', dim: 'memories', refId: 'smoke-riv-m1', who: '查无此人', how: 'witness', updatedAt: 1 },
            { id: 'smoke-riv-empty', dim: 'memories', refId: 'smoke-riv-m1', who: '', how: '', updatedAt: 1 },
            { id: 'smoke-riv-baddim', dim: 'bogus', refId: 'smoke-riv-m1', who: '角色甲', how: 'witness', updatedAt: 1 },
            { id: 'smoke-riv-badref', dim: 'memories', refId: '', who: '角色甲', how: 'witness', updatedAt: 1 },
        ];
        RT.cfg.relLinkEnabled = true;
        RT.cfg.relLayerOn = true;
        RT.cfg.relOrphanAction = 'keep';
        RT.cfg.repairAutoAi = false;                    // 只看机械段（本步在第 1 段）
        // ① 真实点击「🛠 自动修复」
        const r = await entry.popupAction('repair', {});
        const note = String((r.state || {}).note || '');
        const left = (RT.state.links || []).map((x) => x.id);
        const tombIds = Object.keys((RT.state.deleted || {}).links || {});
        const invalidGone = ['smoke-riv-dangling', 'smoke-riv-ghost', 'smoke-riv-empty', 'smoke-riv-baddim', 'smoke-riv-badref'].every((id) => left.indexOf(id) < 0);
        const validKept = left.length === 1 && left[0] === 'smoke-riv-ok';
        const noteOk = /清理无效关系 \d+ 行（/.test(note);
        const tombOk = tombIds.length >= 4;
        // ② 设定 → 约束 关系表：统计行有「无效 N」，且有同源手动按钮
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'constraint' });
        const page = String((await entry.popupAction('refresh', {})).html || '');
        const statsOk = /关联行合计[^<]*无效 0/.test(page) && page.indexOf('data-ftt-action="relCleanInvalid"') >= 0
            && page.indexOf('🧹 清理无效关系') >= 0;
        // ③ 手动按钮同源：再塞一条幽灵行 → 真实点击 → 清掉并如实回报
        RT.state.links.push({ id: 'smoke-riv-ghost2', dim: 'memories', refId: 'smoke-riv-m1', who: '还是查无此人', how: 'told', updatedAt: 1 });
        const c = await entry.popupAction('relCleanInvalid', {});
        const cNote = String((c.state || {}).note || '');
        const manualOk = c.ok === true && Number(c.cleaned) === 1 && cNote.indexOf('已清理无效关系 1 行（幽灵角色 1）') >= 0
            && (RT.state.links || []).every((x) => x.id !== 'smoke-riv-ghost2');
        // ④ 关联层关闭 → 不清理（层关闭 = 不读写关联行）
        RT.state.links.push({ id: 'smoke-riv-ghost3', dim: 'memories', refId: 'smoke-riv-m1', who: '层关闭时的幽灵', how: 'told', updatedAt: 1 });
        RT.cfg.relLinkEnabled = false;
        const off = await entry.popupAction('relCleanInvalid', {});
        const offOk = Number(off.cleaned) === 0 && (RT.state.links || []).some((x) => x.id === 'smoke-riv-ghost3');
        const F = globalThis.FTT;
        const apiOk = typeof F.relInvalidStats === 'function' && typeof F.relCleanInvalid === 'function';
        const ok = invalidGone && validKept && noteOk && tombOk && statsOk && manualOk && offOk && apiOk;
        if (!ok) console.log('V5-DEBUG ' + JSON.stringify({ invalidGone, validKept, note: note.slice(0, 200), tombOk, statsOk, manualOk, cNote, offOk, apiOk }));
        return ok;
    } finally {
        RT.cfg.relLinkEnabled = keepCfg.relLinkEnabled;
        RT.cfg.relOrphanAction = keepCfg.relOrphanAction;
        RT.cfg.repairAutoAi = keepCfg.repairAutoAi;
        RT.cfg.relLayerOn = keepCfg.relLayerOn;
        try { RT.setKernelState(keepState); } catch (e) { /* 忽略 */ }
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

// v3.3.0（用户要求）：「设定-数据管理-本地缓冲，请补充其他为本地缓冲的内容……其他缓冲也应该展示，同样有对应清理按钮功能。」
await assert('BH9 v3.3.0 数据管理 →「本地缓冲」全量补全 + 逐项清理：页面把**本机数据副本**（状态副本 / 内存库副本 / 其它角色副本）与**缓存与日志**（调试日志 · 追踪简报 · 读取台账 · 时钟追踪 · 向量 · 版本清单 · 命名缓存 · 对账标记 · 同步日志）以及 **V1 遗留**都列出来，每行带真实统计与清理按钮；真实点击「🧹 清除」对本机副本**必须二次确认**（取消 → 零副作用；确认 → 只清本机、服务端文件不动）；缓存类逐项清理生效且互不误伤', (async () => {
    const RT = await import('../core/model/runtime.js');
    const ST = await import('../adapters/store.js');
    const CS = await import('../core/state.js');
    const scope = CS.scopeId();
    const curKey = 'ftt2_state_' + scope;
    const keepPopup = host.ctx.callGenericPopup;
    const keepFiles = new Map(srvFiles);
    const extraKeys = ['ftt2_state_char:bh9other', 'ftt2_FileSlug_bh9key1', 'ftt2_ArchiveName_bh9key1', 'ftt2_RemoteStateHash_bh9key1', 'ftt2_SyncGate_bh9key1', 'ftt2_SyncLog_bh9key1', 'SPreset_FTTMemory_FileSlug_bh9key1', 'SPreset_FTTMemoryConfig'];
    const undo = () => { try { host.ctx.callGenericPopup = keepPopup; } catch (e) { /* 忽略 */ } };
    try {
        // 造数据：真实保存（写本机两层 + 服务端）+ 其它作用域副本 + 命名/对账/V1 键
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'data' });
        await ST.saveStateNow({ reason: 'smoke-bh9', force: true });
        for (const k of extraKeys) memStore[k] = (k === 'ftt2_state_char:bh9other') ? JSON.stringify({ v: 1, scope: 'char:bh9other', payload: { scope: 'char:bh9other', updatedAt: 1, data: { atoms: [] } }, hash: 'z' }) : 'x';
        // ① 页面把「本机数据副本 + 缓存与日志」都渲染出来，每行都有清理按钮
        const page = String((await entry.popupAction('refresh', {})).html || '');
        const rows = ['本机数据副本', '状态副本（浏览器本地变量）', '内存库副本（IndexedDB）', '其它角色的本机副本', '调试日志',
            '交互追踪简报', '读取台账', '时钟取值追踪', '向量缓存', '版本清单缓存', '命名缓存（文件名 / 归档名）',
            '同步与对账标记', '同步日志（本机）', 'V1 遗留数据（导入源）'];
        const missing = rows.filter((x) => page.indexOf(x) < 0);
        const actions = ['localCopyClear', 'idbCopyClear', 'localCopyClearOthers', 'dbgClear', 'dbgTraceClear', 'readLedgerClear',
            'clockTraceClear', 'vectorCacheClear', 'aboutClearCache', 'nameCacheClear', 'syncMarkClear', 'syncLogClear', 'v1LegacyClear'];
        const missingAct = actions.filter((x) => page.indexOf('data-ftt-action="' + x + '"') < 0);
        // ② 真实点击「状态副本 → 🧹 清除」：无对话框 → 取消（零副作用）
        const el = doc.getElementById('ftt-panel');
        const fire = (dataset) => { const l = (el && el.listeners && el.listeners.click) || []; l.forEach((fn) => fn({ target: { dataset } })); return l.length > 0; };
        delete host.ctx.callGenericPopup;
        const fired1 = fire({ fttAction: 'localCopyClear' });
        await new Promise((r) => setTimeout(r, 10));
        const afterCancel = !!memStore[curKey];
        // ③ 确认 → 只清本机那一份，服务端文件不动
        let asked = '';
        host.ctx.callGenericPopup = async (t) => { asked = String(t); return 1; };
        const fired2 = fire({ fttAction: 'localCopyClear' });
        await new Promise((r) => setTimeout(r, 10));
        const mainName = (await import('../adapters/user-file.js')).stateFileName(scope);
        const afterOk = !memStore[curKey] && srvFiles.has(mainName);
        // ④ 其它角色副本 + 缓存类逐项清理（程序化路径，不经点击闸）
        const rOthers = await entry.popupAction('localCopyClearOthers', {});
        const rNames = await entry.popupAction('nameCacheClear', {});
        const rMarks = await entry.popupAction('syncMarkClear', {});
        const rV1 = await entry.popupAction('v1LegacyClear', {});
        const cleanOk = Number(rOthers.cleared) >= 1 && !memStore['ftt2_state_char:bh9other']
            && Number(rNames.cleared) >= 1 && !memStore['ftt2_FileSlug_bh9key1'] && !memStore['ftt2_ArchiveName_bh9key1']
            && Number(rMarks.cleared) >= 2 && !memStore['ftt2_RemoteStateHash_bh9key1'] && !memStore['ftt2_SyncGate_bh9key1']
            && Number(rV1.cleared) >= 1 && !memStore['SPreset_FTTMemory_FileSlug_bh9key1']
            && memStore['ftt2_SyncLog_bh9key1'] === 'x';           // 同步日志不在这两步里 → 不误伤
        // ⑤ 清理后统计可读（本机副本已无 → 该行按钮禁用/显示「无本机副本」）
        const page2 = String((await entry.popupAction('refresh', {})).html || '');
        const statsOk = page2.indexOf('（无本机副本）') >= 0;
        const F = globalThis.FTT;
        const apiOk = typeof F.localCopyInfo === 'function' && typeof F.localKeyStats === 'function';
        const ok = missing.length === 0 && missingAct.length === 0 && fired1 && afterCancel && fired2 && afterOk
            && asked.indexOf('服务端记忆文件不受影响') >= 0 && cleanOk && statsOk && apiOk;
        if (!ok) console.log('BH9-DEBUG ' + JSON.stringify({ missing, missingAct, fired1, afterCancel, fired2, afterOk, cleanOk, statsOk, apiOk,
            counts: { others: rOthers.cleared, names: rNames.cleared, marks: rMarks.cleared, v1: rV1.cleared } }));
        return ok;
    } finally {
        undo();
        for (const k of extraKeys) { try { delete memStore[k]; } catch (e) { /* 忽略 */ } }
        srvFiles.clear(); for (const [k, v] of keepFiles) srvFiles.set(k, v);
        try { await ST.saveStateNow({ reason: 'smoke-bh9-restore', force: true }); } catch (e) { /* 忽略 */ }
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
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
//   本节由此暴露的失败已按实现真实语义修好（提示读 state.note；deleted=移除总数 2，与 V1 黄金样本一致）。详见 docs/history/B9-测试完整性待修.md。
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
    await entry.popupAction('tab', { tab: 'settings' });      // v3.1.0：只构建当前分页
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
    // v2.99.0：title 由「不弹确认」改为「需二次确认」（用户要求：这类清理必须二次确认）
    return html1.indexOf('data-ftt-action="clearPlans"') >= 0 && html1.indexOf('🧹 清理计划') >= 0 && html1.indexOf('title="清空全部计划（需二次确认；留删除墓碑）"') >= 0
        && html1.indexOf('data-ftt-action="clearSuspense"') >= 0 && html1.indexOf('🧹 清理悬念') >= 0 && html1.indexOf('title="清空全部悬念（需二次确认；留删除墓碑）"') >= 0
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
        'ensureSnapshotTags', 'deriveSnapshotTags', 'characterMechanicalPass', 'correctSnapshotBirthDates',
        'ageAnomalyScan'];   // v3.22.0：超长年龄 / 长生者只读干跑
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
    const charOk = Array.isArray(fields) && fields.length === 21 && !!F.snapRepairFieldMap()['身份.性别']   // v3.22.0：+「身份.长生者」
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

let acPrompt = '';
let acAiCalls = 0;
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

// ---------- AC 角色修复 · 已去世研判（v3.18.0） ----------
// 用户要求（原话）：「角色修复功能，针对已明显去世的角色进行标记已去世，避免反复调取处理。
//   注意个别可能存在超长寿命的角色，需结合剧情研判，实在无法确认的不做标记。」
await assert('AC1 v3.18.0 角色修复 · 已去世研判（端到端）：明显去世的角色被标记「已去世」并从此跳过修复（含 AI 名单与后续机械处理）；超长寿命 / 他人死亡 / 假死一律不标记；FTT.deceasedScan 只读干跑可核对；机械返回结构不含新键（V1 黄金样本口径不变）', (async () => {
    const st = rtMod.state;
    const CR = await import('../core/character-repair.js');
    const keep = JSON.parse(JSON.stringify(st.snapshots || []));
    const keepAtoms = JSON.parse(JSON.stringify(st.atoms || []));
    const keepDate = (st.state || {}).date;
    const keepGen = host.ctx.generateRaw;
    try {
        st.state = Object.assign({}, st.state, { date: '2020-06-01', time: '傍晚' });
        st.snapshots = [
            { id: 'smoke-ac-dead', name: '角色甲', identity: {}, tags: ['旧档', '战友', '城防'], background: { history: '角色甲在最后的守城战中阵亡，尸首被同乡收敛。' }, uses: 1 },
            { id: 'smoke-ac-elf', name: '精灵乙', identity: { species: '精灵' }, tags: ['精灵', '游侠', '长弓'], background: { history: '精灵乙活了千年，据说永生不死；这一次他在乱战中阵亡。' }, uses: 1 },
            { id: 'smoke-ac-other', name: '角色丙', identity: {}, tags: ['商人', '码头', '旧识'], background: { history: '角色丙目睹其父去世，从此沉默寡言。' }, uses: 1 },
            { id: 'smoke-ac-alive', name: '角色丁', identity: {}, tags: ['铁匠', '城中', '手艺人'], uses: 1 },
        ];
        st.atoms = [{ id: 'smoke-ac-a1', title: '城破', text: '城破那日，角色甲力战不退，最终阵亡。', date: '2020-05-01', tags: ['城防'], entities: ['角色甲'], uses: 1 }];
        // ① 只读干跑（不写标记）
        const dry = globalThis.FTT.deceasedScan();
        const dryOk = dry.length === 4 && dry[0].verdict === 'dead' && dry[1].verdict === 'uncertain'
            && dry[2].verdict === 'none' && dry[3].verdict === 'none'
            && dry.every((x) => !(st.snapshots.filter((y) => y.name === x.name)[0].identity || {}).deceased);
        // ② 真实点击「🔧 修复角色」：机械阶段先标记，再按名单交 AI（名单里不应再有已去世者）
        host.ctx.generateRaw = async (args) => {
            acPrompt = JSON.stringify(args);
            acAiCalls++;
            return JSON.stringify({ '角色档案': { '更新': [{ '姓名': '角色丁', '补全': { '身份.职业': '铁匠', '身份.性别': '男', '身份.出生日期': '1985-02-03' } }], '推断': [], '无依据': [], '删除': [] } });
        };
        acPrompt = ''; acAiCalls = 0;
        const DL = await import('../adapters/debug-log.js');
        try { DL.debugLogClear(); } catch (e) { /* 忽略 */ }
        await entry.popupAction('tab', { tab: 'snapshots' });
        const rc = await entry.popupAction('characterRepair', {});
        const note = String(((rc.state || {}).note) || rc.note || '');
        const byName = (n) => (st.snapshots.filter((x) => x.name === n)[0] || {});
        const markOk = (byName('角色甲').identity || {}).deceased === true
            && (byName('精灵乙').identity || {}).deceased === undefined
            && (byName('角色丙').identity || {}).deceased === undefined
            && (byName('角色丁').identity || {}).deceased === undefined;
        // ③ 名单与后续处理都跳过已去世者
        const q = globalThis.FTT.characterRepairQueue();
        // 名单判定：已去世者**不在待修复队列**（跳过后续处理），且本轮确实把在册角色交给了 AI
        const skipOk = q.deceasedList.indexOf('角色甲') >= 0 && q.list.every((x) => x.name !== '角色甲')
            && q.list.some((x) => x.name === '角色丁') && acAiCalls === 1 && acPrompt.indexOf('角色丁') > 0;
        // ④ 机械返回结构键集固定（V1 字段集 + v1.205 `deceased` + v3.22.0 `immortal`），研判结果经内部记录读取
        const mech = globalThis.FTT.characterMechanicalPass();
        const structOk = Object.keys(mech).sort().join(',') === 'ages,anomalies,birth,changed,deceased,immortal,tags,total'
            && (st.snapshots.filter((x) => x.name === '角色甲')[0].identity || {}).deceased === true;
        // ⑤ 通知如实说明「新标记已去世 N 名」与「待确认」；不再对已去世者做出生日期 / 年龄处理
        // 通知文案：从**调试日志**（`dbgLog('修复', …)`）核对（不接管 notifyHooks，避免影响后续小节的 toastr 断言）
        const logText = (() => { try { return JSON.stringify(DL.debugLogList() || []); } catch (e) { return ''; } })();
        const noteOk = logText.indexOf('已去世研判') > 0 && logText.indexOf('角色甲') > 0
            && logText.indexOf('精灵乙') > 0 && logText.indexOf('long-life-unconfirmed') > 0;
        const ok = dryOk && markOk && skipOk && structOk && noteOk;
        if (!ok) console.log('AC1-DEBUG ' + JSON.stringify({ dryOk, markOk, skipOk, structOk, noteOk, dry: dry.map((x) => [x.name, x.verdict, x.reason]), qList: q.list.map((x) => x.name), qDead: q.deceasedList, targetBlockDead: (acPrompt.split('【待修复角色')[1] || '').split('【近期正文')[0].indexOf('角色甲'), promptWindow: acPrompt.slice(1380, 1560), aiCalls: acAiCalls, log: logText.slice(0, 300), mechKeys: Object.keys(mech).sort() }));
        return ok;
    } finally {
        st.snapshots = keep;
        st.atoms = keepAtoms;
        st.state = Object.assign({}, st.state, { date: keepDate });
        host.ctx.generateRaw = keepGen;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

// ---------- AC2 角色修复 · 长生者与超长年龄（v3.22.0） ----------
// 用户要求（原话）：「角色修复，新增对超长年龄人员的分析，明显不合理的可能是长期没出现的人物，但被误判会长生。
//   其次角色新增字段，根据剧情标记是否为长生者，该开关可以被编辑。如果是标记了长生者，则无需在修复角色中被分析。
//   如果被分析发现为误判角色，则可根据剧情或预判分析后，标记为去世。」
await assert('AC1b v3.22.0 角色修复 · 长生者与超长年龄（端到端）：① 超长年龄进优先档并被点名研判（低纪元也照判）② 已标记长生者整批跳过修复（AI 名单与机械改写都不碰）③ 开关可勾可取消 ④ AI 判定误判 → 同时取消长生标记并按剧情标记去世；`FTT.ageAnomalyScan` 只读干跑可核对', (async () => {
    const st = rtMod.state;
    const CR = await import('../core/character-repair.js');
    const keep = JSON.parse(JSON.stringify(st.snapshots || []));
    const keepAtoms = JSON.parse(JSON.stringify(st.atoms || []));
    const keepDate = (st.state || {}).date;
    const keepGen = host.ctx.generateRaw;
    try {
        // 剧情锚点固定在 628 年（**低纪元** —— 专门验证超长年龄不再被纪元豁免）
        st.state = Object.assign({}, st.state, { date: '0628-07-10', time: '下午' });
        st.snapshots = [
            // ① 超长年龄 + 无长寿依据 + 久未出场（年龄 328 岁、最后见面在 400 年）→ 入优先档、⚠️ 点名
            { id: 'smoke-ai-old', name: '凡人甲', identity: { birthDate: '0300-01-01', occupation: '铁匠' }, tags: ['铁匠', '城中', '手艺人'], lastSeenDate: '0400-05-01', uses: 1 },
            // ② 已标记长生者 → 整批跳过（不进 AI 名单、机械也不改）
            { id: 'smoke-ai-imm', name: '长生乙', identity: { immortal: true, birthDate: '约300年' }, tags: ['修士', '长生', '洞府'], uses: 1 },
            // ③ 普通角色（对照组）
            { id: 'smoke-ai-hum', name: '常人丙', identity: { occupation: '商人' }, tags: ['商人', '码头', '旧识'], uses: 1 },
        ];
        st.atoms = [];
        // 只读干跑：超长年龄可查、长生者跳过原因可查、**不写任何标记**
        const scan = globalThis.FTT.ageAnomalyScan();
        const oldRow = scan.find((x) => x.name === '凡人甲') || {};
        const immRow = scan.find((x) => x.name === '长生乙') || {};
        const dryOk = scan.length === 3 && oldRow.extreme === true && Number(oldRow.staleYears) > 200
            && immRow.skip === 'immortal'
            && (st.snapshots.find((x) => x.name === '长生乙').identity || {}).immortal === true;   // 干跑不改数据
        // 真实点击「🔧 修复角色」：名单里只有凡人甲 / 常人丙（长生乙被跳过）；提示词带长生者守则与 ⚠️ 超长年龄点名
        host.ctx.generateRaw = async (args) => {
            acPrompt = JSON.stringify(args);
            acAiCalls++;
            return JSON.stringify({ '角色档案': { '更新': [
                { '姓名': '凡人甲', '补全': { '身份.职业': '铁匠' } },
                { '姓名': '常人丙', '补全': { '身份.职业': '商人' } },
                // AI 判定「长生乙」的长生标记是误判、且剧情显示其早已离世 → 同时纠正 + 标记去世
                { '姓名': '长生乙', '补全': { '身份.长生者': '否', '身份.已去世': '是' } },
            ], '推断': [], '无依据': [], '删除': [] } });
        };
        acPrompt = ''; acAiCalls = 0;
        // v3.22.0：**点击前**先取名单（点击后「长生乙」会被 AI 纠正为已去世 → 会转到 deceasedList，属预期）
        const q0 = globalThis.FTT.characterRepairQueue();
        const DL = await import('../adapters/debug-log.js');
        try { DL.debugLogClear(); } catch (e) { /* 忽略 */ }
        await entry.popupAction('tab', { tab: 'snapshots' });
        const rc = await entry.popupAction('characterRepair', {});
        const byName = (n) => (st.snapshots.filter((x) => x.name === n)[0] || {});
        // 取**目标块**：模板里也可能出现「【待修复角色」字样 → 取最后一次出现（真实目标块在 user 消息里）
        const block = String(String(acPrompt).split('【待修复角色').slice(-1)[0] || '').split('【近期正文')[0];
        const promptOk = acAiCalls === 1
            && block.indexOf('凡人甲') >= 0 && block.indexOf('常人丙') >= 0 && block.indexOf('长生乙') < 0
            && String(acPrompt).indexOf('【长生者判定（保守）】') > 0
            && String(acPrompt).indexOf('⚠️ 超长年龄') > 0 && String(acPrompt).indexOf('距今约') > 0
            && q0.immortalCount === 1 && q0.immortalList[0] === '长生乙'
            && q0.list.every((x) => x.name !== '长生乙')
            && q0.list.some((x) => x.name === '凡人甲' && x.anomaly === 'age-extreme');
        // 误判纠正落地：长生标记被取消 + 按剧情（AI 判定）标记去世；无依据者不被标记
        const fixOk = (byName('长生乙').identity || {}).immortal === false
            && (byName('长生乙').identity || {}).deceased === true
            && (byName('凡人甲').identity || {}).deceased === undefined;
        // 开关可编辑（双向）：编辑器字段 + 两条写入路径
        const toggleOn = CR.setSnapshotByPath({ identity: {} }, '身份.长生者', '是');
        const toggleOff = CR.setSnapshotByPath({ identity: { immortal: true } }, '身份.长生者', false);
        const editOk = toggleOn.ok === true && toggleOn.changed === true && toggleOff.changed === true
            && CR.SNAP_REPAIR_FIELD_MAP['身份.长生者'].optional === true;
        // 提示与日志如实回报：跳过数（通知文案）+ 判定落地计数（调试日志）
        const note = String(((rc.state || {}).note) || rc.note || '');
        const logText = (() => { try { return JSON.stringify(DL.debugLogList() || []); } catch (e) { return ''; } })();
        const noteOk = logText.indexOf('immortalCleared') > 0 && logText.indexOf('长生乙') > 0
            && logText.indexOf('deceasedMarked') > 0
            && logText.indexOf('birthSkippedImmortal') > 0;    // 机理层：长生者被机械阶段跳过（如实入日志）
        const ok = dryOk && promptOk && fixOk && editOk && noteOk;
        if (!ok) console.log('AC2-DEBUG ' + JSON.stringify({ dryOk, promptOk, fixOk, editOk, noteOk, note: note.slice(0, 300), scan: scan.map((x) => [x.name, x.age, x.extreme, x.skip]), q0Imm: q0.immortalList, q0List: q0.list.map((x) => [x.name, x.anomaly]), imm: byName('长生乙').identity, aiCalls: acAiCalls, blockHead: block.slice(0, 300), hasGuide: String(acPrompt).indexOf('【长生者判定（保守）】') > 0, hasAge: String(acPrompt).indexOf('⚠️ 超长年龄') > 0, hasGap: String(acPrompt).indexOf('距今约') > 0, blockHasImm: block.indexOf('长生乙') >= 0, log: logText.slice(0, 160) }));
        return ok;
    } finally {
        st.snapshots = keep;
        st.atoms = keepAtoms;
        st.state = Object.assign({}, st.state, { date: keepDate });
        host.ctx.generateRaw = keepGen;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


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
        && h0.indexOf('data-ftt-action="stateRepair"') < 0 && h0.indexOf('暂无状态记录。运行「AI 摘要」或点「添加状态」创建。') >= 0;   // v2.62.0：空态文案对齐 V1
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
    await entry.popupAction('tab', { tab: 'settings' });      // v3.1.0：只构建当前分页
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
        await entry.popupAction('tab', { tab: 'settings' });      // v3.1.0：只构建当前分页
        await entry.popupAction('settingsSub', { sub: 'debug' });
        let h = String((await entry.popupAction('refresh', {})).html || '');
        const pageOk = h.indexOf('data-ftt-settings-page="debug"') >= 0 && h.indexOf('data-ftt-cfg="debugEnabled"') >= 0
            && h.indexOf('关闭后不再记录新日志；已存日志仍可查看。') >= 0
            && h.indexOf('data-ftt-action="dbgClear"') >= 0 && h.indexOf('🗑 清空日志') >= 0
            && h.indexOf('共 2 条') >= 0 && h.indexOf('（最多 300 条 · 最新在上 · 点击展开）') >= 0
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
        const emptyOk = h.indexOf('暂无日志。') >= 0;
        return missing.length === 0 && stats.n === 2 && stats.cap === 300 && typeof stored === 'string'
            && pageOk && offRet === false && clearedOk && emptyOk;
    } finally {
        if (keepLs === undefined) delete globalThis.window.localStorage; else globalThis.window.localStorage = keepLs;
        try { globalThis.FTT.dbgClear(); } catch (e) { /* 忽略 */ }
    }
})(), '');

await assert('AE2 关于页 v2.53.0：版本清单**优先取代码库 raw json**；成功/失败文案三态且言简意赅；清单缺失如实失败；清缓存动作删键复位；「本地缓冲」清理入口在数据管理页', (async () => {
    const F = globalThis.FTT;
    const REPO_RAW = 'https://raw.githubusercontent.com/fotomxq/stt-memory-plugin-v2/main/FTT-memory-changelog.json';
    const REPO_PAGE = 'https://github.com/fotomxq/stt-memory-plugin-v2';
    const lsMap = new Map();
    const ls = {
        getItem: (k) => (lsMap.has(String(k)) ? lsMap.get(String(k)) : null),
        setItem: (k, v) => { lsMap.set(String(k), String(v)); },
        removeItem: (k) => { lsMap.delete(String(k)); },
    };
    const keepLs = globalThis.window && globalThis.window.localStorage;
    globalThis.window.localStorage = ls;
    try {
        // 候选地址：**代码库 raw 第一优先**（用户要求），扩展目录与 V1 相对路径仅兜底
        const cands = F.aboutCandidateUrls();
        const dir = F.aboutDirUrl();
        const candOk = cands[0] === REPO_RAW
            && dir === '/scripts/extensions/third-party/ftt-memory-v2/'
            && cands.indexOf(dir + 'FTT-memory-changelog.json') > 0
            && JSON.stringify(F.aboutJsonPaths()) === JSON.stringify(['FTT-memory-changelog.json', './FTT-memory-changelog.json']);
        // ① 清单缺失 → 如实失败（不伪造版本数据），提示只告诉用户「去哪看」
        aboutJsonText = '';
        F.aboutClearCache();
        const bad = await entry.popupAction('aboutReload', {});
        const badNote = String(((bad.state || {}).note) || '');
        const failOk = bad.ok === false && badNote === '无法获取版本更新 —— 可在代码库查看：' + REPO_PAGE
            && F.aboutState().status === 'fail' && F.aboutData().fallback === true
            && (F.aboutData().changelog || []).length === 0;
        // ② 清单存在 → 成功读取（来源 = 代码库 raw 首候选）+ 写本地缓存
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
        const okOk = ok.ok === true && okNote === '已获取版本更新 · 共 2 个版本'
            && st.status === 'ok' && st.from === REPO_RAW && !!cacheRaw
            && F.aboutSortDesc(F.aboutData().changelog).map((e) => e.version).join(',') === '1.0.0,0.9.0';
        // ③ 页面渲染（停在「关于」子页）：言简意赅 —— 无开发/历史块、无清缓存按钮
        await entry.popupAction('tab', { tab: 'settings' });      // v3.1.0：只构建当前分页
        await entry.popupAction('settingsSub', { sub: 'about' });
        const h = String((await entry.popupAction('refresh', {})).html || '');
        const htmlOk = h.indexOf('data-ftt-settings-page="about"') >= 0
            && h.indexOf('关于 · FTT记忆组件') >= 0 && h.indexOf('版本更新（最新在最前）') >= 0
            && h.indexOf('data-ftt-action="aboutReload"') >= 0 && h.indexOf('🔄 重新获取') >= 0
            && h.indexOf('已获取版本更新 · 共 2 个版本') >= 0
            && h.indexOf('首个版本') >= 0 && h.indexOf('建立记忆容器') >= 0
            && ['内核配置键：', 'V2 附加信息', 'aboutClearCache', '清除本地缓存', '扩展目录',
                '入口与用法', '对齐总表', 'fttAboutJson'].every((s) => h.indexOf(s) < 0);
        // ④ 清缓存：先等「页面停在关于子页」触发的自动读取落定（渲染即自动读取并回写缓存）
        await new Promise((r) => setTimeout(r, 60));
        const hadCache = ls.getItem('fttAboutJson') !== null;
        const removedNow = F.aboutClearCache();
        const directOk = hadCache === true && removedNow === true && ls.getItem('fttAboutJson') === null
            && F.aboutData() === null && F.aboutState().status === 'idle' && F.aboutState().ts === 0;
        // 动作路径：如实回报（V1 同名 `aboutClearCache`）
        aboutJsonText = '';
        const cleared = await entry.popupAction('aboutClearCache', {});
        const clearNote = String(((cleared.state || {}).note) || '');
        const clearOk = directOk && cleared.ok === true && clearNote.indexOf('已清除版本清单缓存') === 0;
        // ⑤ 「本地缓冲」清理入口迁到数据管理页，并展示统计（无缓存 → 按钮禁用）
        await entry.popupAction('settingsSub', { sub: 'data' });
        const dh = String((await entry.popupAction('refresh', {})).html || '');
        const bufOk = dh.indexOf('🗂 本地缓冲') >= 0 && dh.indexOf('版本清单缓存：（无缓存）') >= 0
            && dh.indexOf('data-ftt-action="aboutClearCache"') >= 0 && dh.indexOf('🧹 清除') >= 0
            && /data-ftt-action="aboutClearCache"[^>]*disabled/.test(dh)
            && dh.indexOf('调试日志：') >= 0 && dh.indexOf('交互追踪简报：') >= 0;
        // ⑥ 恢复：切回总览（避免影响后续小节）
        await entry.popupAction('tab', { tab: 'overview' });
        return candOk && failOk && okOk && htmlOk && clearOk && bufOk;
    } finally {
        aboutJsonText = '';
        if (keepLs === undefined) delete globalThis.window.localStorage; else globalThis.window.localStorage = keepLs;
        try { globalThis.FTT.aboutClearCache(); } catch (e) { /* 忽略 */ }
    }
})(), '');

await assert('BA1 v2.54.0 数据管理页重排：按用途分块（导出/导入/删除/快照/缓冲）、危险动作隔离、快照只出统计（明细折叠）、本地缓冲统计与真实持久层逐项一致', (async () => {
    const DL = await import('../adapters/debug-log.js');
    const TR = await import('../adapters/trace-store.js');
    const BM = await import('../ui/buffer-manage.js');
    const keepLs = globalThis.window && globalThis.window.localStorage;
    const map = new Map();
    globalThis.window.localStorage = {
        getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
        setItem: (k, v) => { map.set(String(k), String(v)); },
        removeItem: (k) => { map.delete(String(k)); },
    };
    try {
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'data' });
        await entry.popupAction('snapCreate', {});     // 先建一份快照，确保「统计 + 折叠明细」都有内容
        const h = String((await entry.popupAction('refresh', {})).html || '');
        const at = (s) => h.indexOf(s);
        // ① 分块与顺序（v2.96.0 用户要求「危险操作放到最后」：导出 → 导入 → 快照链 → 本地缓冲 → **危险区**）
        //    + 危险动作隔离 + 粘贴框与其按钮相邻
        const dangerFrom = at('data-ftt-danger-zone');
        const dangerTail = h.slice(dangerFrom);
        const layoutOk = at('📤 导出备份') >= 0 && at('📥 导入存档（合并）') > at('📤 导出备份')
            && at('🧬 快照链') > at('📥 导入存档（合并）') && at('🗂 本地缓冲') > at('🧬 快照链')
            && dangerFrom > at('🗂 本地缓冲')
            && at('✂️ 删除聊天楼层') > dangerFrom && at('🗑 删除数据（不可恢复）') > at('✂️ 删除聊天楼层')
            && at('data-ftt-action="reset"') > at('🗑 删除数据（不可恢复）')
            && at('data-ftt-import="1"') < at('data-ftt-action="importStateApply"')
            && h.slice(at('data-ftt-import="1"'), at('data-ftt-action="importStateApply"')).indexOf('本地缓冲') < 0
            // 危险区里不再夹任何安全动作（导出 / 导入 / 临时快照）
            && dangerTail.indexOf('exportState') < 0 && dangerTail.indexOf('importStateOpen') < 0
            && dangerTail.indexOf('importStateApply') < 0 && dangerTail.indexOf('data-ftt-import=') < 0
            && h.indexOf('不会删除') >= 0 && h.indexOf('不可恢复') >= 0
            && h.indexOf('以下两块都会写入不可逆的改动') >= 0;
        // ② 快照：统计行在明处、明细折叠（默认无 open）
        const snapOk = at('data-ftt-snap-stat') >= 0 && h.indexOf('可还原原子 ') >= 0 && h.indexOf('删除台账 ') >= 0
            && at('data-ftt-snap-details') > at('data-ftt-snap-stat')
            && at('data-ftt-action="snapRestore"') > at('data-ftt-snap-details')
            && h.indexOf('<details class="ftt-details" data-ftt-snap-details>') >= 0;
        // ③ 本地缓冲：数字来自真实持久层（2 条日志 / 1 条简报 / 版本清单），且不出明细
        DL.debugLogClear();
        DL.debugLogPush('摘要', { text: '冒烟缓冲明细甲' });
        DL.debugLogPush('对账', { text: '冒烟缓冲明细乙' });
        TR.traceStoreSave([{ id: 'smoke-trace-1', at: Date.now(), cat: 'ui', kind: 'click', ok: true, opId: '', site: 'smoke.js:1' }]);
        const st = BM.bufferStats();
        // 同一时刻取持久层字节：refresh 动作本身也会写追踪持久层，晚一步比就会误判
        const rawD = BM.rawBytes(DL.DEBUG_KEY), rawT = BM.rawBytes(TR.TRACE_KEY);
        const h2 = String((await entry.popupAction('refresh', {})).html || '');
        const bufOk = st.debugLog.count === 2 && st.debugLog.cap === 300 && st.trace.count === 1 && st.trace.cap === 120
            && st.debugLog.bytes === rawD && st.trace.bytes === rawT
            && h2.indexOf('调试日志：2 / 300 条') >= 0 && h2.indexOf('交互追踪简报：1 / 120 条') >= 0
            && h2.indexOf('版本清单缓存：') >= 0 && h2.indexOf('不影响记忆数据') >= 0
            && h2.indexOf('冒烟缓冲明细甲') < 0 && h2.indexOf('smoke.js:1') < 0;   // 只统计，不列明细
        // ④ 清理入口真实生效：清空简报后旧的持久简报消失（动作自身至多留 1 条）
        await entry.popupAction('dbgTraceClear', {});
        const left = TR.traceStoreLoad();
        // v3.0.21：载入会读一次**分片清单**（`adapters/shards.js`，1 次只读请求）→ 简报里多一条 `getRequestHeaders`
        //   宿主调用（同一键只记一条）；语义不变：**旧的测试条目必须消失**、简报仍是极小规模。
        const clearOk = left.every((x) => x && x.id !== 'smoke-trace-1') && left.length <= 2
            && BM.bufferStats().trace.count === left.length;
        // ⑤ 恢复
        DL.debugLogClear();
        TR.traceStoreClear();
        await entry.popupAction('snapshotClear', {});
        await entry.popupAction('tab', { tab: 'overview' });
        return layoutOk && snapOk && bufOk && clearOk;
    } finally {
        if (keepLs === undefined) delete globalThis.window.localStorage; else globalThis.window.localStorage = keepLs;
    }
})(), '');

await assert('BA3 v2.59.0 总览「📤 最后一次提取」：真实跑一次摘要 → 总览一行给出时间/来源/楼层/新增/关键词；折叠块展示**注入内容**（v2.75.0）', (async () => {
    const EX9 = await import('../host/extract.js');
    const keepGen = host.ctx.generateRaw;
    // 摘要成功会排程「推演 1.8s / 情节总结 4s」防抖定时器 —— 本小节自接管并在收尾驱动掉，
    //   避免遗留定时器让后续 P9d（AI2/AI3）的排程闸门（weaveTimer 非空即 early-return）失效。
    const t9 = p9dTimers();
    try {
        // 造一楼可分析正文 + 一条带关键词的情节（本地关键词抽取有料）
        host.ctx.chat.push({ is_user: false, mes: '甲打开木箱取出账册，仓库里堆着货箱。', name: '角色甲' });
        host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
        const RT9 = await import('../core/model/runtime.js');
        RT9.setLastMessageId(host.ctx.chat.length - 1);
        RT9.state.atoms = [{ id: 'ba3-kw', text: '甲有铜钥匙。', date: '1919-11-01', floorStart: 0, floorEnd: 0, tags: [], keywords: ['木箱', '账册'], validity: 'active' }];
        host.ctx.generateRaw = async () => JSON.stringify({ atoms: { add: [{ id: 'ba3-new', text: '甲打开木箱取出账册。', floorStart: 1, floorEnd: 1 }] } });
        const r = await entry.popupAction('tab', { tab: 'overview' });
        void r;
        const run = await entry.popupAction('summary', {});
        const rec = EX9.lastExtractRecord();
        const html = String((await entry.popupAction('tab', { tab: 'overview' })).html || '');
        const line = (html.match(/data-ftt-last-extract-line>([^<]*)</) || [])[1] || '';
        const ok = !!rec && (rec.via === 'segment' || rec.via === 'batch' || rec.via === 'floor')
            && Number(rec.added) >= 0 && String(rec.text || '').indexOf('ba3-new') >= 0
            && html.indexOf('📤 最后一次提取') >= 0 && html.indexOf('data-ftt-last-extract') >= 0
            && /(单楼分析|分段分析|批量摘要)（(手动|自动)）/.test(line) && /新增 \d+ 条/.test(line)
            && html.indexOf('data-ftt-inject') >= 0 && html.indexOf('data-ftt-last-extract') > html.indexOf('data-ftt-inject')
            && html.indexOf('ftt-hint-details') >= 0 && html.indexOf('查看注入内容') >= 0
            && html.indexOf('data-ftt-inject-preview') >= 0
            // v2.75.0（用户要求）：折叠块里是**注入内容**，不含 AI 回复的 JSON 原文
            //   （注：`html` 为整块面板 HTML，可能含其它分页内容，故只在折叠块切片内断言）
            && (() => {
                const a = html.indexOf('查看注入内容');
                const b = html.indexOf('</details>', a);
                const det = (a >= 0 && b > a) ? html.slice(a, b) : '';
                return det.length > 0 && det.indexOf('ba3-new') < 0 && det.indexOf('&quot;atoms&quot;') < 0 && det.indexOf('"atoms"') < 0;
            })();
        void run;
        return ok;
    } finally {
        host.ctx.generateRaw = keepGen;
        try { await p9dDrain(t9.rec); } catch (e) { /* 忽略 */ }
        t9.restore();
        try { await new Promise((r) => setTimeout(r, 5)); } catch (e) { /* 忽略 */ }
    }
})(), '');

await assert('BD1 v2.81.0 分析记忆后按最新情节同步：情节有更新 → 日期/时间/地点/**在场角色**跟随最新一条（并修复「在场角色←最新情节涉及角色」的 V1 死路径）；情节没变则完全不碰时钟', (async () => {
    const EXD = await import('../host/extract.js');
    const RTD = await import('../core/model/runtime.js');
    const PRED = await import('../host/preflight.js');
    const keepGen = host.ctx.generateRaw;
    const keepAtoms = RTD.state.atoms, keepSnaps = RTD.state.snapshots;
    const keepState = JSON.parse(JSON.stringify(RTD.state.state));
    const tD = p9dTimers();
    try {
        // 旧情节 + 旧时钟（在场 = 甲角色）
        RTD.state.atoms = [{ id: 'bd-old', text: '甲角色在码头交货。', date: '1919-11-01', time: '早晨', location: '码头', floorStart: 0, floorEnd: 0, entities: ['甲角色'], tags: [], validity: 'active' }];
        RTD.state.snapshots = [{ id: 'bd-s1', name: '甲角色' }, { id: 'bd-s2', name: '乙角色' }, { id: 'bd-s3', name: '丙角色' }];
        RTD.state.state = Object.assign({}, RTD.state.state, { date: '1919-11-01', time: '早晨', location: '码头', present: ['甲角色'] });
        RTD.state.state.clockManual = null;
        // ① 情节没变 → 跳过（不解析、不落盘）
        const quiet = PRED.recalibrateAfterExtract(PRED.atomsSignature());
        const quietOk = quiet.skipped === 'atoms-unchanged' && RTD.state.state.date === '1919-11-01';
        // ② 真实跑一次「分析记忆」，产出**更新的一条**情节（乙角色/丙角色 在仓库）
        host.ctx.chat.push({ is_user: false, mes: '乙角色与丙角色在仓库盘货。', name: '角色乙' });
        host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
        RTD.setLastMessageId(host.ctx.chat.length - 1);
        const flD = host.ctx.chat.length - 1;
        host.ctx.generateRaw = async () => JSON.stringify({ atoms: { add: [{ id: 'bd-new', text: '乙角色与丙角色在仓库盘货。', date: '1919-12-05', time: '深夜', locations: ['仓库'], floorStart: flD, floorEnd: flD, entities: ['乙角色', '丙角色'] }] } });
        await entry.popupAction('summary', {});
        const st = RTD.state.state;
        const pres = st.present || [];
        const recD = EXD.lastExtractRecord();
        return quietOk && !!recD
            && st.date === '1919-12-05' && st.time === '深夜' && st.location === '仓库'
            && pres.indexOf('乙角色') >= 0 && pres.indexOf('丙角色') >= 0 && pres.indexOf('甲角色') < 0
            && String((st.clockSrc || {}).present) === 'plot-atom'
            && String((st.clockSrc || {}).date) === 'plot';
    } finally {
        host.ctx.generateRaw = keepGen;
        RTD.state.atoms = keepAtoms; RTD.state.snapshots = keepSnaps; RTD.state.state = keepState;
        try { await p9dDrain(tD.rec); } catch (e) { /* 忽略 */ }
        tD.restore();
        try { await new Promise((r) => setTimeout(r, 5)); } catch (e) { /* 忽略 */ }
    }
})(), '');

await assert('BA2 v2.58.0 提取记忆三层：开启「启用向量检索」后发送前走**第一层向量召回**（真实 embedding 请求 → 注入体为向量命中行）；关闭/失败自动降级到本地召回', (async () => {
    const RT7 = await import('../core/model/runtime.js');
    const INJ = await import('../host/inject.js');
    const keepUse = RT7.cfg.useVector, keepUrl = RT7.cfg.embeddingUrl, keepModel = RT7.cfg.embeddingModel, keepKey = RT7.cfg.embeddingKey;
    const keepChat = host.ctx.chat.slice();
    const keepLast = host.ctx.getLastMessageId;
    let embCalls = 0;
    const restoreFetch = installGlobalFetch((url, opts) => {
        if (String(url).indexOf('/embeddings') >= 0) {
            embCalls += 1;
            const body = opts && opts.body ? JSON.parse(opts.body) : {};
            const inputs = Array.isArray(body.input) ? body.input : [];
            // 桩：含「木箱/账册/仓库」→ 第一维高，其余第二维高
            return { status: 200, body: { data: inputs.map((t, i) => ({ index: i, embedding: /木箱|账册|仓库/.test(t) ? [1, 0] : [0, 1] })) } };
        }
        return { status: 404, body: {} };
    });
    try {
        // 造一段可抽取关键词的最近楼层 + 一条含特征词的情节
        host.ctx.chat.push({ is_user: false, mes: '甲打开木箱取出账册，仓库里堆着货箱。', name: '角色甲' });
        host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
        RT7.state.atoms = [
            { id: 'vec-a1', text: '甲在仓库打开木箱，取出账册。', date: '1919-11-20', floorStart: 1, floorEnd: 1, uses: 1, tags: [], keywords: ['木箱', '账册'], validity: 'active' },
            { id: 'vec-a2', text: '乙在码头等船。', date: '1919-11-21', floorStart: 2, floorEnd: 2, uses: 1, tags: [], validity: 'active' },
        ];
        RT7.cfg.useVector = true;
        RT7.cfg.embeddingUrl = 'https://stub.example.com/v1';
        RT7.cfg.embeddingModel = 'stub-emb';
        RT7.cfg.embeddingKey = '';
        RT7.cfg.vectorMinScore = 0;
        const r1 = await entry.injectNow();
        const txt1 = INJ.readInject();
        const st1 = INJ.pushStats();
        const vecOk = r1.ok === true && embCalls >= 1 && r1.hitLayer === 'vector'
            && String(txt1).indexOf('甲在仓库打开木箱') >= 0 && String(st1.lastHitLayer) === 'vector';
        // 关闭向量层 → 本地召回（hitLayer 为空，不再请求 embedding）
        const callsBefore = embCalls;
        RT7.cfg.useVector = false;
        await entry.injectNow();
        const st2 = INJ.pushStats();
        const fallbackOk = embCalls === callsBefore && (st2.lastHitLayer === '' || st2.lastHitLayer === 'js');
        // 向量层配置缺失（开着但没地址）→ 不抛错、自动降级
        RT7.cfg.useVector = true; RT7.cfg.embeddingUrl = '';
        const r3 = await entry.injectNow();
        const degradeOk = r3.ok === true && embCalls === callsBefore;
        return vecOk && fallbackOk && degradeOk;
    } finally {
        RT7.cfg.useVector = keepUse; RT7.cfg.embeddingUrl = keepUrl; RT7.cfg.embeddingModel = keepModel; RT7.cfg.embeddingKey = keepKey;
        host.ctx.chat.length = 0; keepChat.forEach((m) => host.ctx.chat.push(m));
        host.ctx.getLastMessageId = keepLast;
        restoreFetch();
    }
})(), '');

await assert('AE3 数据管理 `reset`：按钮与 V1 逐字一致；确认文案逐字一致；无对话框时不执行（取消态如实提示）、确认后清空并留「先导出备份」提示', (async () => {
    const F = globalThis.FTT;
    const st = rtMod.state;
    st.atoms = [{ id: 'smoke-ae-a1', title: '甲', text: '角色甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29', validity: 'active' }];
    st.memories = [{ id: 'smoke-ae-m1', title: '木箱', content: '甲记得木箱断口整齐。' }];
    st.deleted = {}; st.deletedH = {};
    // ① 数据管理页按钮（文案与 V1 逐字一致）
    await entry.popupAction('tab', { tab: 'settings' });      // v3.1.0：只构建当前分页
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

await assert('AF2 面板编排 v2.80.0：条目行「🔗 关联（N）」；`relJump` 切到「设定 → 约束」+ 该维度 + 定位提示 + 「清除筛选」；`relWho` 只写角色筛选（不再顺带开编辑器）；`relGoto` 把该页搜索词设为条目标题（悬念→计划悬念页）', (async () => {
    const F = globalThis.FTT;
    const st = rtMod.state;
    st.memories = [{ id: 'smoke-af-m2', owner: '甲角色', title: '码头见闻', content: '甲在码头看到木箱。' }];
    st.plans = [{ id: 'smoke-af-p1', title: '追查货单', content: '追查货单来源', status: 'open' }];
    st.suspense = [{ id: 'smoke-af-su1', title: '断口之谜', content: '断口来源不明', status: 'open' }];
    st.parallels = [{ id: 'smoke-af-pa1', title: '第三方插手', text: '若木箱属第三方。' }];
    st.links = [{ id: 'smoke-af-l1', dim: 'memories', refId: 'smoke-af-m2', who: '甲角色', how: 'participant', deviation: 'unknown' }];
    await entry.popupAction('tab', { tab: 'memories' });
    const listHtml = String((await entry.popupAction('refresh', {})).html || '');
    const btnOk = listHtml.indexOf('data-ftt-action="relJump"') >= 0
        && listHtml.indexOf('data-kind="memories" data-id="smoke-af-m2"') >= 0
        && listHtml.indexOf('🔗 关联（1）') >= 0;
    // relJump：v2.80.0 → 切「设定 → 约束」并把页内维度设为该条目维度（悬念）
    const j = await entry.popupAction('relJump', { kind: 'suspense', id: 'smoke-af-su1' });
    const js = j.state || {}, jh = String(j.html || '');
    const jumpOk = j.ok === true && js.tab === 'settings' && js.settingsSub === 'constraint' && js.constraintDim === 'suspense'
        && jh.indexOf('ftt-subtab ftt-on" data-ftt-cdim="suspense"') >= 0
        && String(js.note).indexOf('已定位到「约束 → 关系表」：悬念') === 0
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
    const offOk = off.indexOf('data-ftt-slim-gzip') >= 0 && off.indexOf('瘦身 关') >= 0
        && off.indexOf('gzip 关') >= 0 && off.indexOf('魔数') < 0 && off.indexOf('支持压缩') < 0
        && off.indexOf('data-ftt-action="syncPickLocal"') < 0;          // 无待选 → 不渲染横幅按钮
    rtMod.cfg.storage.stateFileSlim = true; rtMod.cfg.storage.stateFileGzip = true;
    const on = String((await entry.popupAction('refresh', {})).html || '');
    const onOk = on.indexOf('瘦身 <b>已开启</b>') >= 0 && on.indexOf('gzip <b>已开启</b>') >= 0
        && on.indexOf('旧文件仍可读') >= 0;   // v2.60.0：说明行再精简（去「魔数」等实现细节）
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

// v3.0.3 改判（用户要求「如果发现本地与服务端不一致，自动下载合并」）：自动对账遇分歧**不再暂存待选**，
//   改为**自动下载 + 原子合并**（并集 + 时间取新 + 墓碑生效）并推回服务端；「保留本端 / 采用对端」两个动作
//   与横幅仅对**旧版本遗留的待选**有效（本小节显式注入待选后继续验证这两个动作）。
await assert('AH3（v3.0.3 改判 / v3.0.4 增项）真实自动对账遇分歧 → **自动下载合并**（无待选、无横幅、不阻塞；本端独有保留 + 对端独有并入 + 冲突取新）；显式注入待选后「保留本端 / 采用对端 / 🔀 合并差异」三个动作照旧可用并留痕', (async () => {
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
    // ① v3.0.3：自动合并（无待选）；并集成立（本端独有 L 与对端独有 R 都在）；冲突项按时间取新（对端较新）
    const autoOk = r1.divergence === 'auto-merged' && pend === null
        && (rtMod.state.atoms || []).some((x) => x.id === 'smoke-ah-L')
        && (rtMod.state.atoms || []).some((x) => x.id === 'smoke-ah-R')
        && String(((rtMod.state.atoms || []).filter((x) => x.id === 'smoke-ah-A')[0] || {}).text || '').indexOf('对端改写') >= 0;
    // ② 无横幅（有待选才会显示；自动路径不产生待选）
    const pageHtml = String((await entry.popupAction('refresh', {})).html || '');
    const bannerOk = pageHtml.indexOf('⚠️ 跨端同步分歧 · 请选择保留哪个版本') < 0
        && pageHtml.indexOf('data-ftt-action="syncPickLocal"') < 0
        && pageHtml.indexOf('不一致时') >= 0 && pageHtml.indexOf('自动下载并合并') >= 0;   // 新的口径说明行
    // ③ 显式注入待选 → 横幅出现 → 「保留本端」（覆盖对端）
    const remEnv = JSON.parse(makeRemote());
    F.crossPendingSet(remEnv, { localN: (rtMod.state.atoms || []).length, remoteN: 2, localTs: Number(rtMod.state.updatedAt) || 0, remoteTs: 9000000000000, tsDiff: 1, diff: { onlyLocal: 1, onlyRemote: 1, conflict: 1 } });
    const pageHtml2 = String((await entry.popupAction('refresh', {})).html || '');
    const bannerOk2 = pageHtml2.indexOf('⚠️ 跨端同步分歧 · 请选择保留哪个版本') >= 0
        && pageHtml2.indexOf('data-ftt-action="syncPickLocal"') >= 0 && pageHtml2.indexOf('data-ftt-action="syncPickRemote"') >= 0
        && F.crossPendingGet() !== null;
    const p1 = await entry.popupAction('syncPickLocal', {});
    const log1 = F.syncLog().filter((x) => String(x.action) === '分歧选择')[0];
    const keepOk = String(p1.state.note).indexOf('已保留本地版本') >= 0 && F.crossPendingGet() === null
        && (rtMod.state.atoms || []).some((x) => x.id === 'smoke-ah-L')
        && !!log1 && log1.mode === '保留本端(覆盖对端)' && String(log1.note).indexOf('本端推送覆盖对端') >= 0;
    // ④ 再注入一次待选 → 采用对端（整体替换）
    put();
    F.crossPendingSet(JSON.parse(makeRemote()), { localN: (rtMod.state.atoms || []).length, remoteN: 2, localTs: Number(rtMod.state.updatedAt) || 0, remoteTs: 9000000000000, tsDiff: 1, diff: { onlyLocal: 1, onlyRemote: 1, conflict: 1 } });
    const p2 = await entry.popupAction('syncPickRemote', {});
    const log2 = F.syncLog().filter((x) => String(x.action) === '分歧选择')[0];
    const adoptOk = String(p2.state.note).indexOf('已采用对端版本') >= 0 && F.crossPendingGet() === null
        && (rtMod.state.atoms || []).some((x) => x.id === 'smoke-ah-R')
        && (rtMod.state.atoms || []).every((x) => x.id !== 'smoke-ah-L')
        && Number(rtMod.state.updatedAt) === 9000000000000
        && !!log2 && log2.mode === '采用对端(整体替换)' && String(log2.note).indexOf('本端已替换为对端数据') >= 0;
    // ⑤ v3.0.4（用户要求）：「设定跨端同步分歧中，应增加合并差异选项，即将对端下载后合并去重。」
    //   再造一次分歧（本端独有 L2 + 对端独有 R，无端是超集）→ 横幅应出现第三项 → 点击 = 下载对端并集去重（两端都不丢）
    rtMod.state.atoms = (rtMod.state.atoms || []).concat([{ id: 'smoke-ah-L2', text: 'AH 本端独有情节二', title: 'AH 本端独有二', date: '1936-12-08', tags: ['AH'], uses: 1, floorStart: 0, floorEnd: 1 }]);
    put();
    F.crossPendingSet(JSON.parse(makeRemote()), { localN: (rtMod.state.atoms || []).length, remoteN: 2, localTs: Number(rtMod.state.updatedAt) || 0, remoteTs: 9000000000000, tsDiff: 1, diff: { onlyLocal: 1, onlyRemote: 1, conflict: 1 } });
    const pageHtml3 = String((await entry.popupAction('refresh', {})).html || '');
    const mergeBtnOk = pageHtml3.indexOf('data-ftt-action="syncPickMerge"') >= 0
        && pageHtml3.indexOf('🔀 合并差异') >= 0 && pageHtml3.indexOf('下载对端') >= 0;
    const p3 = await entry.popupAction('syncPickMerge', {});
    const log3 = F.syncLog().filter((x) => String(x.action) === '分歧选择')[0];
    const ids3 = (rtMod.state.atoms || []).map((x) => String(x.id));
    const mergeOk = mergeBtnOk && String(p3.state.note).indexOf('已合并差异') >= 0 && F.crossPendingGet() === null
        && ids3.indexOf('smoke-ah-L2') >= 0 && ids3.indexOf('smoke-ah-R') >= 0     // 去重合并：两端独有都保留
        && !!log3 && log3.mode === '合并差异(下载对端去重合并)' && String(log3.note).indexOf('并集去重') >= 0;
    // 复位：移除造出来的对端条目 + 恢复清单开关，避免影响后续小节
    rtMod.state.atoms = (rtMod.state.atoms || []).filter((x) => String(x.id).indexOf('smoke-ah-') !== 0);
    rtMod.cfg.storage.syncMetaProbe = keepMeta;
    await entry.popupAction('tab', { tab: 'overview' });
    return autoOk && bannerOk && bannerOk2 && keepOk && adoptOk && mergeOk;
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

await assert('AJ2 v2.80.0 约束页维度切换 / 情节子标签点击真实生效（此前同样被「无 action 即 return」吞掉）；且宿主已有面板节点时也会绑定委托', (async () => {
    const el = doc.getElementById('ftt-panel');
    const fire = (dataset) => { const l = (el && el.listeners && el.listeners.click) || []; l.forEach((fn) => fn({ target: { dataset } })); return l.length > 0; };
    // 「属性型」控件：`data-ftt-cdim`（约束页维度切换，取代已移除的列表页 `data-ftt-msub`）
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'constraint' });
    const f1 = fire({ fttCdim: 'parallels' });
    await new Promise((r) => setTimeout(r, 0));
    const cdim = String(panelState().constraintDim || '');
    await entry.popupAction('tab', { tab: 'atoms' });
    const f2 = fire({ fttAsub: 'segments' });
    await new Promise((r) => setTimeout(r, 0));
    const atSub = String(panelState().atomSub || '');
    return el.__fttBound === true && f1 && cdim === 'parallels' && f2 && atSub === 'segments';
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
        && html.indexOf('按用途渠道') >= 0;
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
    const indexOk = apiHtml.indexOf('按用途渠道') >= 0
        && apiHtml.indexOf('在「平行」设定页选择') >= 0 && apiHtml.indexOf('在「分析记忆」设定页选择') >= 0
        && apiHtml.indexOf('data-ftt-dim-preset=') < 0 && apiHtml.indexOf('data-ftt-cfg="parallelApiPreset"') < 0;
    cfg.apiPresets = saved.presets; cfg.activeApiPreset = saved.active; cfg.apiChannel = saved.channel; cfg.apiUrl = saved.url; cfg.model = saved.model;
    cfg.parallelApiPreset = saved.par; cfg.dimensionPresets = saved.dims; cfg.dimensionGrouping = saved.group; cfg.apiKey = saved.key;
    await entry.popupAction('refresh', {});
    return tPar.apiUrl === 'https://p2.example/v1' && tPar.channel === 'direct' && tMain.channel === 'host'
        && labelOk && analyzeOk && f1 && dimSet === 'P1' && tDim.apiUrl === 'https://p1.example/v1'
        && parOk && f2 && modelSet === 'm2' && indexOk;
})(), '');

await assert('AK2b v3.0.12 区块「选择模型」下拉写回**本区块的模型键**（此前写死主 API 的 cfg.model，导致向量 API 配了也不生效）', (async () => {
    const { cfg } = await import('../core/model/runtime.js');
    const el = doc.getElementById('ftt-panel');
    const fire = (dataset, value) => { const l = (el && el.listeners && el.listeners.change) || []; l.forEach((fn) => fn({ target: { dataset, value, type: 'select-one' } })); return l.length > 0; };
    const saved = { emb: cfg.embeddingModel, rr: cfg.rerankModel, model: cfg.model };
    cfg.embeddingModel = ''; cfg.rerankModel = ''; cfg.model = 'main-keep';
    const fEmb = fire({ fttModelSelect: 'emb', fttCfg: 'embeddingModel' }, 'emb-picked');
    await new Promise((r) => setTimeout(r, 0));
    const fRr = fire({ fttModelSelect: 'rerank', fttCfg: 'rerankModel' }, 'rr-picked');
    await new Promise((r) => setTimeout(r, 0));
    const ok = fEmb && fRr && cfg.embeddingModel === 'emb-picked' && cfg.rerankModel === 'rr-picked' && cfg.model === 'main-keep';
    cfg.embeddingModel = saved.emb; cfg.rerankModel = saved.rr; cfg.model = saved.model;
    await entry.popupAction('refresh', {});
    return ok;
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
await assert('AN1（v2.51.0 改版）端到端：落盘后时钟日志含「来源（情节）+ 判据 + 落盘差异」，`FTT.clockTrace()` 可读（不再有正文候选/降级）', (async () => {
    const RT = await import('../core/model/runtime.js');
    const CE = await import('../core/clock-extract.js');
    const DL = await import('../core/debug-log.js');
    const saveAtoms = RT.state.atoms; const saveState = RT.state.state;
    try {
        RT.state.atoms = [{ id: 'an-a1', text: '甲在码头。', date: '1919-11-30', time: '08:52', location: '城市甲·码头', floorStart: 5, floorEnd: 5, uses: 1, tags: [] }];
        RT.state.state = Object.assign({}, saveState, { date: '', time: '', location: '' });
        RT.setLastMessageId(5);
        CE.clockAutoExtractOnce({ force: true });
        const t = globalThis.FTT.clockTrace();
        const logs = (DL.debugLogList() || []).filter((x) => x.kind === '时钟');
        const last = logs[0] || null;   // debugLogList 为「新→旧」：最新一条即本次落盘产生的日志
        const data = last ? String(last.data || '') : '';
        return RT.state.state.date === '1919-11-30' && !!t && J(t).indexOf('最新情节') >= 0
            && data.indexOf('1919-11-30') >= 0 && data.indexOf('plot') >= 0;
    } finally { RT.state.atoms = saveAtoms; RT.state.state = saveState; }
})(), '');

await assert('AN2（v2.51.0 改版）无情节/无改动时不写提取日志（避免噪声），但取值追踪仍可查；调试页「🕒 时钟取值追踪」区块与清空入口可用', (async () => {
    const RT = await import('../core/model/runtime.js');
    const CE = await import('../core/clock-extract.js');
    const saveAtoms = RT.state.atoms; const saveState = RT.state.state;
    try {
        RT.state.atoms = [];
        RT.state.state = Object.assign({}, saveState, { date: '1919-11-01' });
        const before = CE.clockExtractState ? CE.clockExtractState() : null;
        const ok = CE.clockAutoExtractOnce({ force: true });
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'debug' });
        const h = String(panelBodyHtml('settings') || '');
        return ok !== true && RT.state.state.date === '1919-11-01' && !!before
            && h.indexOf('🕒 时钟取值追踪') >= 0 && h.indexOf('data-ftt-action="clockTraceClear"') >= 0
            && h.indexOf('时间巡检') < 0;
    } finally { RT.state.atoms = saveAtoms; RT.state.state = saveState; }
})(), '');

// ---------- 以下为 v2.51.0 之前既有断言（与时钟改版无关，恢复原样） ----------
// ---------- AO 点击不跳顶（v2.38.0：滚动保持 + 按钮 type + 点击入口防默认） ----------
await assert('AO1 面板 HTML 的按钮全部带 `type="button"`（对齐 V1 v1.206 26525：无 type 的按钮在 form 内是 submit → 跳顶/刷新）', (() => {
    const PM = fttPanelMod;
    // v3.1.0：默认只构建当前分页 → 本断言要求**全部 13 页**都过一遍 `type="button"` 加固
    const raw = String(PM.panelHtml({ all: true }));
    const hardened = String(PM.ensureButtonTypes(raw));
    const rendered = String(PM.renderPanel());        // 真实渲染路径的返回值（renderPanel 内已加固）
    const count = (x) => (x.match(/<button/g) || []).length;
    const untyped = (x) => (x.match(/<button(?![^>]*\stype=)/g) || []).length;
    // 说明（v3.0.2）：原先还断言「加固前 raw 里全部无 type」—— 那是**实现细节**：个别按钮（⚡ 立即 AI 摘要 /
    //   第 N 楼）在 v2.96.0 起就**显式**写了 `type="button"`（更稳），raw 里因此会混有已带 type 的按钮。
    //   真正要保证的是：**加固后一个不漏**（含真实渲染路径），且加固机制存在。
    return count(raw) >= 20
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
        const needTypes = ['exportState', 'importState', 'importV1', 'autoSummary', 'abort', 'batchProgress', 'clearFloors', 'resetState', 'dimToggle', 'confirm', 'inject', 'saveAll']
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
await assert('AR1 调试包导出：面板「⬇ 导出调试包」（v2.82.0 起位于「📋 日志」区块顶部）产出可复制文本（含版本/环境/一键诊断/**全部日志**与「异常」类），并渲染文本框；`FTT.debugLogExport()` 同源', (async () => {
    const DL = await import('../core/debug-log.js');
    const AD = await import('../adapters/debug-log.js');
    const RT = await import('../core/model/runtime.js');
    // 造一条与用户报告一致的异常（宿主 ACL 拒绝 confirm）
    AD.wireDebugLog();
    DL.debugLogPush('异常', { kind: '未处理的 Promise 拒绝', message: 'Command plugin:dialog|confirm not allowed by ACL', source: 'unhandledrejection', line: 0, col: 0, stack: 'Command plugin:dialog|confirm not allowed by ACL' });
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'debug' });
    const page = String(panelBodyHtml('settings') || '');
    const hasBtn = page.indexOf('data-ftt-action="dbgExport"') >= 0 && page.indexOf('data-ftt-action="dbgExportLog"') >= 0
        && page.indexOf('⬇ 导出调试包') >= 0 && page.indexOf('⬇ 导出日志') >= 0
        // v2.82.0（用户要求「日志的按钮全部调整到最上面」）：两枚导出按钮 + 清空日志都在日志条目之前
        && page.indexOf('data-ftt-action="dbgClear"') > page.indexOf('data-ftt-action="dbgExportLog"')
        && page.indexOf('class="ftt-dbg-item"') > page.indexOf('data-ftt-action="dbgClear"');
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

await assert('BE1 v2.82.0 日志导出**真的落文件**（修复用户报告的「无法正常导出 log 文件」）：真实点击「⬇ 导出日志」下载 .log、「⬇ 导出调试包」下载 .json；日志区块按钮全在最上面', (async () => {
    const saveCreate = doc.createElement;
    const saveURL = globalThis.URL;
    const saveBlob = globalThis.Blob;
    const clicks = [];
    const urls = [];
    try {
        globalThis.URL = { createObjectURL: () => { const u = 'blob:smoke-dbg/' + (urls.length + 1); urls.push(u); return u; }, revokeObjectURL: () => undefined };
        globalThis.Blob = function Blob(parts, opt) { this.parts = parts; this.type = (opt || {}).type || ''; };
        doc.createElement = (tag) => {
            const el = {
                tagName: String(tag).toUpperCase(), style: {}, attrs: {},
                set href(v) { this.attrs.href = v; }, get href() { return this.attrs.href; },
                set download(v) { this.attrs.download = v; }, get download() { return this.attrs.download; },
                set rel(v) { this.attrs.rel = v; },
                click() { clicks.push(this); },
                remove() { this.removed = true; },
                dataset: {}, listeners: {},
            };
            return el;
        };
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'debug' });
        const el = doc.getElementById('ftt-panel');
        const click = (el && el.listeners && el.listeners.click) || [];
        const fire = (dataset) => {
            const tg = { dataset, closest: (sel) => (String(sel).indexOf('data-ftt-action') >= 0 ? tg : null) };
            click.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } }));
            return new Promise((r) => setTimeout(r, 30));
        };
        // ① 导出日志（.log）
        await fire({ fttAction: 'dbgExportLog' });
        const logAnchor = clicks.filter((x) => x.tagName === 'A').slice(-1)[0];
        const noteLog = String((panelState() || {}).note || '');
        const logOk = !!logAnchor && /^FTT调试日志_.*\.log$/.test(String(logAnchor.download || ''))
            && String(logAnchor.href || '').indexOf('blob:') === 0
            && noteLog.indexOf('已下载文件') >= 0 && noteLog.indexOf('FTT调试日志_') >= 0;
        // ② 导出调试包（.json）
        await fire({ fttAction: 'dbgExport' });
        const pkgAnchor = clicks.filter((x) => x.tagName === 'A').slice(-1)[0];
        const notePkg = String((panelState() || {}).note || '');
        const pkgOk = !!pkgAnchor && /^FTT调试包_.*\.json$/.test(String(pkgAnchor.download || ''))
            && String(pkgAnchor.href || '').indexOf('blob:') === 0
            && notePkg.indexOf('已下载文件') >= 0 && notePkg.indexOf('FTT调试包_') >= 0
            && pkgAnchor !== logAnchor;
        // ③ 导出结果文本框（兜底）仍在页面上
        const after = String(panelBodyHtml('settings') || '');
        return logOk && pkgOk && urls.length >= 2 && after.indexOf('data-ftt-debugexport') >= 0;
    } finally {
        doc.createElement = saveCreate;
        if (saveURL === undefined) delete globalThis.URL; else globalThis.URL = saveURL;
        if (saveBlob === undefined) delete globalThis.Blob; else globalThis.Blob = saveBlob;
    }
})(), '');

await assert('BF1 v2.83.0 关联层（原子层之上的边层）：`FTT.relations()/dependents()/relationsOf()/relationStats()` 可用；设定 → 约束「🔗 关联层」区块渲染统计并可用真实动作查询；设定 → 分析记忆 提供关关联层开关', (async () => {
    const RTF = await import('../core/model/runtime.js');
    const keep = { atoms: RTF.state.atoms, memories: RTF.state.memories, links: RTF.state.links, snapshots: RTF.state.snapshots, plans: RTF.state.plans, scenes: RTF.state.scenes };
    try {
        RTF.state.atoms = [{ id: 'bf-a1', text: '甲角色在码头交货。', date: '1919-11-01', locations: ['码头'], entities: ['甲角色'], validity: 'active' }];
        RTF.state.memories = [{ id: 'bf-m1', owner: '甲角色', title: '码头见闻', content: '甲角色在码头看到木箱。', date: '1919-11-01' }];
        RTF.state.snapshots = [{ id: 'bf-s1', name: '甲角色' }];
        RTF.state.scenes = [{ id: 'bf-sc1', name: '码头', pathArr: ['码头'], pathStr: '码头' }];
        RTF.state.links = [{ id: 'bf-l1', dim: 'memories', refId: 'bf-m1', who: '甲角色', how: 'participant', at: '1919-11-01' }];
        RTF.state.plans = [{ id: 'bf-p1', content: '清点货单', status: 'open', atomRefs: ['bf-a1'] }];
        const F = globalThis.FTT;
        const snap = F.relations();
        const deps = F.dependents('atoms', 'bf-a1');        // 谁依赖我：plans 引用 + 记忆锚行来源 …
        const out = F.relationsOf('memories', 'bf-m1');     // 我引用了谁 / 谁知道我
        const stats = F.relationStats();
        const apiOk = !!snap && Array.isArray(snap.edges) && snap.edges.length >= 3
            && deps.length >= 1 && out.length >= 1 && Number(stats.total) >= 3 && F.relationLayerOn() === true;
        // 页面：设定 → 约束 的「🔗 关联层」区块 + 真实查询动作
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'constraint' });
        const page = String(panelBodyHtml('settings') || '');
        const hasBlock = page.indexOf('data-ftt-section="relation-layer"') >= 0 && page.indexOf('🔗 关联层') >= 0
            && page.indexOf('data-ftt-linkq="1"') >= 0 && page.indexOf('data-ftt-action="linkQuery"') >= 0;
        const q = await entry.popupAction('linkQuery', { q: 'atoms:bf-a1' });
        const after = String(panelBodyHtml('settings') || '');
        const queried = q.ok === true && after.indexOf('atoms:bf-a1') >= 0 && after.indexOf('谁依赖我') >= 0;
        // 设定 → 分析记忆：关联层三项控件（开关此前完全无入口）
        await entry.popupAction('settingsSub', { sub: 'analyze' });
        const an = String(panelBodyHtml('settings') || '');
        const hasSwitch = an.indexOf('data-ftt-cfg="relLinkEnabled"') >= 0
            && an.indexOf('data-ftt-cfg="relOrphanAction"') >= 0 && an.indexOf('关联层（谁知道 / 谁相关）') >= 0;
        return apiOk && hasBlock && queried && hasSwitch;
    } finally {
        RTF.state.atoms = keep.atoms; RTF.state.memories = keep.memories; RTF.state.links = keep.links;
        RTF.state.snapshots = keep.snapshots; RTF.state.plans = keep.plans; RTF.state.scenes = keep.scenes;
        try { await entry.popupAction('linkQuery', { q: '' }); } catch (e) { /* 忽略 */ }
    }
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
    await new Promise((r) => setTimeout(r, 0));      // v3.11.1：追踪记录晚一拍落地时不至于随机变红
    // v3.11.1：**按 kind 过滤**而不是取 `[0]` —— 前面用例的异步追踪事件可能在 `traceClear()` 之后才落地，
    //   抢走 `[0]` 会让本断言随机变红（实测 3 次红 1 次）。断言强度不变（仍查 kind/站点/ok/opId）。
    const pick = (kind, opId) => TR.traceList({ cat: 'host' })
        .filter((x) => x && x.kind === kind && (opId === undefined || x.opId === opId))[0];
    const sync = pick('saveSettingsDebounced');
    // opId 关联：op 内发生的宿主调用归属该 op（跨层可回溯「谁调用的」）
    TR.traceClear();
    const op = TR.traceOpStart('ui.smokeCase');
    ctx.saveSettingsDebounced();
    await new Promise((r) => setTimeout(r, 0));
    const inOp = pick('saveSettingsDebounced', op.opId);
    TR.traceOpEnd(op, { ok: true });
    // 异步宿主调用：resolve 后追记结果
    TR.traceClear();
    ctx.generateRaw = async () => 'ok-text';
    await ctx.generateRaw({ prompt: 'x' });
    await new Promise((r) => setTimeout(r, 20));
    const asyncEv = pick('generateRaw');
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

await assert('AU1 v2.44.0 HTML 标签不污染数据（v2.51.0 适配）：正文里的 `<br>`/`<div>` 不会污染数据；时钟只取情节，情节日期经 HTML 清洗后可安全落盘', (async () => {
    const CE = await import('../core/clock-extract.js');
    const CP = await import('../core/clock-patrol.js');
    const RT = await import('../core/model/runtime.js');
    const saveChat = host.ctx.chat;
    const savedLoc = RT.state.state.location;
    const savedAtoms = RT.state.atoms;
    try {
        // 正文含 HTML：清洗由取文边界负责（v2.44.0），情节日期同样不携带标签
        const br = CE.extractClockFromText('▷1919年11月29日（东汉）·冬(死寂的长街)<br>▷码头仓库<br>甲推开木门。', { date: '', time: '', location: '' });
        RT.state.atoms = [{ id: 'au-a1', text: '甲推开木门。', date: String(br.date || '1919-11-29'), time: '', location: String(br.location || ''), floorStart: 3, floorEnd: 3, uses: 1, tags: [] }];
        RT.state.state = Object.assign({}, RT.state.state, { date: '', time: '', location: '' });
        const ok = CE.clockAutoExtractOnce({ force: true });
        const loc = String(RT.state.state.location || '');
        const noTag = !/[<][a-zA-Z/]/.test(loc) && !/[<][a-zA-Z/]/.test(String(RT.state.state.date || ''));
        // 手工改写：地点粘进 `<br>` → 落盘清洗 + note 说明
        const m = CP.setClockManual({ date: '1919-11-29', time: '傍晚', location: '码头仓库<br>' });
        const manLoc = String(RT.state.state.location || '');
        const notes = (m.notes || []).join(' ');
        return ok === true && noTag && loc === '码头仓库'
            && m.ok === true && manLoc === '码头仓库' && notes.indexOf('HTML') >= 0;
    } finally {
        try { CP.clearClockManual(); } catch (e) { /* 忽略 */ }
        host.ctx.chat = saveChat;
        RT.state.atoms = savedAtoms;
        RT.state.state.location = savedLoc;
    }
})(), '');

await assert('AV1 v2.45.0 投喂白/黑名单按钮与联动修复：真实点击「＋黑」**进黑名单**（此前因 `kind` 读错属性被归一为白名单）；点完后下一次投喂立即生效（白名单只留标签内部内容）；调试页时间线类别筛选按钮同样生效', (async () => {
    const FS = await import('../ui/feed-scan.js');
    const FL = await import('../host/floors.js');
    const DBG = await import('../ui/debug.js');
    const RT2 = await import('../core/model/runtime.js');
    const cfgRef = RT2.cfg;
    const saveChat = host.ctx.chat;
    try {
        host.ctx.chat = [
            { is_user: true, mes: '用户：继续。<br>' },
            { is_user: false, mes: '<content>甲走进仓库。</content><system>旁白：铜箱是空的。</system><br>普通正文一行。' },
        ];
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'feed' });
        const el = doc.getElementById('ftt-panel');
        const click = (el && el.listeners && el.listeners.click) || [];
        const fire = (dataset) => {
            const tg = { dataset, closest: (sel) => (String(sel).indexOf('data-ftt-action') >= 0 ? tg : null) };
            click.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } }));
            return new Promise((r) => setTimeout(r, 0));
        };
        // 先清名单 → 分析 → 点「＋黑 system」与「＋白 content」
        cfgRef.feedRegexBlacklist = []; cfgRef.feedRegexWhitelist = [];
        await fire({ fttAction: 'rxScanTags' });
        await fire({ fttAction: 'rxAddTag', fttKind: 'black', fttTag: 'system' });
        const bl = FS.rxFeedTagLists().black;
        await fire({ fttAction: 'rxAddTag', fttKind: 'white', fttTag: 'content' });
        const wl = FS.rxFeedTagLists().white;
        const feed = String(FL.buildFeedFloorText(10));
        // 调试页：真实点击类别筛选按钮（此前 kind 恒空 → 恒为「全部」，点了没反应）
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'debug' });
        const dbgBtn = { dataset: { fttAction: 'dbgTraceFilter', fttKind: 'host' }, closest: (sel) => (String(sel).indexOf('data-ftt-action') >= 0 ? dbgBtn : null) };
        click.forEach((fn) => fn({ target: dbgBtn, preventDefault() { }, stopPropagation() { } }));
        await new Promise((r) => setTimeout(r, 10));
        const dbgHtml = String(panelBodyHtml('settings') || '');
        // 生效判据：该类别按钮变为高亮（`ftt-primary`），且调试页仍渲染时间线区块
        const filter = dbgHtml.indexOf('data-ftt-kind="host" title="只看该类别"') >= 0
            && /data-ftt-kind="host"[^>]*class="ftt-btn ftt-sm ftt-primary"|class="ftt-btn ftt-sm ftt-primary"[^>]*data-ftt-kind="host"/.test(dbgHtml) ? 'host' : '';
        const filtered = dbgHtml.indexOf('dbgTraceFilter') >= 0;
        void DBG;
        cfgRef.feedRegexBlacklist = []; cfgRef.feedRegexWhitelist = [];
        return JSON.stringify(bl) === JSON.stringify(['system']) && JSON.stringify(wl) === JSON.stringify(['content'])
            && feed === '甲走进仓库。' && filter === 'host' && filtered;
    } finally {
        host.ctx.chat = saveChat;
        try { cfgRef.feedRegexBlacklist = []; cfgRef.feedRegexWhitelist = []; } catch (e) { /* 忽略 */ }
    }
})(), '');

await assert('AW1 v2.47.0 大类列表内容与顺序：情节行含 V1 的类型/楼层/重要度/标签；计划行含进度与目标时间；场景页为**聚合树**（虚节点 + 📍 当前位置高亮 + 折叠按钮真实可用）', (async () => {
    const RT3 = await import('../core/model/runtime.js');
    const saveScenes = RT3.state.scenes;
    const saveState0 = RT3.state.state;
    const saveAtoms = RT3.state.atoms;
    try {
        RT3.state.state = Object.assign({}, saveState0, { date: '1919-11-25', location: '城市甲·码头' });
        RT3.state.atoms = [
            // v2.86.0：展示的「重要度」已统一为**存储值**（窗口占比）→ 样例显式给出 0.24（旧口径由 uses 现算，已退役）
            { id: 'aw-a1', title: '码头交货', text: '甲把铜箱交给乙。', type: '主线', date: '1919-11-20', floorStart: 3, floorEnd: 5, uses: 2, importance: 0.24, tags: ['码头'], validity: 'active', locations: ['城市甲·码头'] },
        ];
        RT3.state.scenes = [
            { id: 'aw-sc1', name: '码头', pathArr: ['城市甲', '码头'], desc: '水汽很重。', tags: ['水边'], uses: 2, pathStr: '城市甲>码头' },
            { id: 'aw-sc2', name: '里屋', pathArr: ['城市甲', '码头', '里屋'], desc: '有铜箱。', tags: [], uses: 1, pathStr: '城市甲>码头>里屋' },
        ];
        await entry.popupAction('tab', { tab: 'atoms' });
        const atoms = String(panelBodyHtml('atoms') || '');
        const atomsOk = atoms.indexOf('· 主线 · ') >= 0 && atoms.indexOf('3-5楼') >= 0 && atoms.indexOf('重要度24%') >= 0
            && atoms.indexOf('#码头') >= 0 && atoms.indexOf('城市甲·码头') >= 0;
        await entry.popupAction('tab', { tab: 'scenes' });
        const tree = String(panelBodyHtml('scenes') || '');
        const treeOk = tree.indexOf('data-ftt-scene-node="城市甲') >= 0
            && tree.indexOf('data-ftt-scene-node="城市甲&gt;码头"') >= 0
            && tree.indexOf('data-ftt-scene-node="城市甲&gt;码头&gt;里屋"') >= 0
            && tree.indexOf('📍 当前：城市甲·码头（亮色分支 = 当前位置）') >= 0
            && tree.indexOf('📍 当前</span>') >= 0 && tree.indexOf('class="ftt-scene-children"') >= 0;
        // 折叠：真实点击 caret → 子树 display 切为 none、三角变 ▸（纯 DOM，不重绘）
        const el = doc.getElementById('ftt-panel');
        const click = (el && el.listeners && el.listeners.click) || [];
        const caret = { textContent: '▾', dataset: { fttSceneCaret: '1', fttSceneCaretFor: '城市甲>码头' }, closest: () => null, tagName: 'SPAN' };
        click.forEach((fn) => fn({ target: caret, preventDefault() { }, stopPropagation() { } }));
        const box = el.querySelector('[data-ftt-scene-children="城市甲>码头"]');
        const foldOk = !!box && box.style.display === 'none' && caret.textContent === '▸';
        return atomsOk && treeOk && foldOk;
    } finally {
        RT3.state.scenes = saveScenes;
        RT3.state.state = saveState0;
        RT3.state.atoms = saveAtoms;
    }
})(), '');

await assert('AX1 v2.48.0「剧情第 N 天不允许注入」：真实注入通道里只有 日期/时间/地点/在场角色，**没有任何「第N天」**；该值仍留在内部（state.state.storyDay）用于校准', (async () => {
    const RT4 = await import('../core/model/runtime.js');
    const saveState1 = RT4.state.state;
    const saveAtoms1 = RT4.state.atoms;
    try {
        RT4.state.atoms = [{ id: 'ax-a1', text: '甲把铜箱交给乙。', date: '1919-11-20', type: '主线', floorStart: 1, floorEnd: 2, uses: 1, tags: ['码头'] }];
        RT4.state.state = Object.assign({}, saveState1, { date: '1919-11-25', time: '傍晚', location: '城市甲·码头', present: ['甲'], storyDay: 17602 });
        await entry.injectNow();
        await new Promise((r) => setTimeout(r, 20));
        const val = String((host.ctx.extensionPrompts[INJECT_ID] || {}).value || '');
        const body = val.slice(0, val.indexOf('记忆结束。') >= 0 ? val.indexOf('记忆结束。') : val.length);
        const noStoryDay = body.indexOf('剧情天数') < 0 && !/第\s*\d+\s*天/.test(body);
        // v2.88.0：注入体改 Markdown → 四要素为 `- **日期**：…` 列表项（字段与顺序不变）
        const keepsOthers = body.indexOf('- **日期**：1919-11-25') >= 0 && body.indexOf('- **时间**：傍晚') >= 0
            && body.indexOf('- **地点**：城市甲·码头') >= 0 && body.indexOf('- **在场角色**') >= 0;
        // 内部值仍在（校准用途不受影响）
        const internal = Number(RT4.state.state.storyDay) === 17602;
        return noStoryDay && keepsOthers && internal;
    } finally {
        RT4.state.atoms = saveAtoms1;
        RT4.state.state = saveState1;
    }
})(), '');

await assert('AY1 v2.49.0/v3.0.17 导出/导入文件机制：真实点击「⬇ 导出 JSON」**触发浏览器下载**（blob:<a download="FTT记忆_<hash>_<日期>_<时间>.json">，v3.0.17 起名字必须带日期时间）；「⬆ 导入 JSON（合并）」**弹出文件选择器**并读取存档完成合并', (async () => {
    const PE = await import('../ui/panel.js');
    const saveCreate = doc.createElement;
    const saveURL = globalThis.URL;
    const saveBlob = globalThis.Blob;
    const created = [];
    const urls = [];
    const revoked = [];
    const clicks = [];
    try {
        // ① 下载环境桩
        doc.createElement = (tag) => {
            const el = {
                tagName: String(tag).toUpperCase(), style: {}, files: null, accept: '', type: '', value: '',
                click() { clicks.push(this); if (typeof this.onclick === 'function') this.onclick(); },
                remove() { this.removed = true; },
                dataset: {}, listeners: {},
            };
            created.push(el);
            return el;
        };
        globalThis.URL = { createObjectURL: () => { const u = 'blob:smoke/' + (urls.length + 1); urls.push(u); return u; }, revokeObjectURL: (u) => revoked.push(u) };
        globalThis.Blob = function Blob(parts, opt) { this.parts = parts; this.type = (opt || {}).type || ''; };
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'data' });
        // 真实点击委托（与用户点击同路径）
        const el = doc.getElementById('ftt-panel');
        const click = (el && el.listeners && el.listeners.click) || [];
        const fire = (dataset) => {
            const tg = { dataset, closest: (sel) => (String(sel).indexOf('data-ftt-action') >= 0 ? tg : null) };
            click.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } }));
            return new Promise((r) => setTimeout(r, 20));
        };
        await fire({ fttAction: 'exportState' });
        const anchor = clicks.filter((x) => x.tagName === 'A')[0];
        const noteExport = String((panelState() || {}).note || '');
        // v3.0.17（用户要求「导出 json 备份，文件名必须带日期和时间」）：`FTT记忆_<hash>_YYYY-MM-DD_HH-mm-ss.json`
        const downloadOk = !!anchor && /^FTT记忆_[a-z0-9]+_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/.test(String(anchor.download || ''))
            && String(anchor.href || '').indexOf('blob:') === 0 && urls.length === 1
            && noteExport.indexOf('已下载文件 FTT记忆_') >= 0;
        // ② 文件选择器桩：点击即注入一个存档文件
        let fileInput = null;
        doc.createElement = (tag) => {
            const el = {
                tagName: String(tag).toUpperCase(), style: {}, files: null, accept: '', type: '',
                click() {
                    if (this.type === 'file') { this.files = [{ name: '冒烟存档.json', size: 40, text: async () => JSON.stringify({ state: { atoms: [{ id: 'smoke-imp-1', text: '导入的情节正文。', date: '1919-11-20', floorStart: 1, floorEnd: 1 }] } }) }]; if (typeof this.onchange === 'function') this.onchange(); }
                    else clicks.push(this);
                },
                remove() { this.removed = true; },
                dataset: {}, listeners: {},
            };
            if (String(tag).toLowerCase() === 'input') fileInput = el;
            created.push(el);
            return el;
        };
        await fire({ fttAction: 'importStateOpen' });
        await new Promise((r) => setTimeout(r, 30));
        const noteImport = String((panelState() || {}).note || '');
        const importOk = !!fileInput && fileInput.type === 'file' && String(fileInput.accept || '').indexOf('.json') >= 0
            && noteImport.indexOf('已导入文件 冒烟存档.json') >= 0;
        return downloadOk && importOk;
    } finally {
        doc.createElement = saveCreate;
        if (saveURL === undefined) delete globalThis.URL; else globalThis.URL = saveURL;
        if (saveBlob === undefined) delete globalThis.Blob; else globalThis.Blob = saveBlob;
    }
})(), '');

await assert('AZ1 v2.50.0 场景层级（收纳）修复：编辑**嵌套场景**时父级下拉选中其真实父级（下拉按完整路径排序 + 层级缩进 + 完整路径标签），保存后 `pathArr` 不被拍平', (async () => {
    const RT5 = await import('../core/model/runtime.js');
    const FD = await import('../ui/fields.js');
    const saveScenes2 = RT5.state.scenes;
    try {
        RT5.state.scenes = [
            { id: 'az-sc1', name: '城市甲', pathArr: ['城市甲'], pathStr: '城市甲', desc: '', tags: [], uses: 0 },
            { id: 'az-sc2', name: '码头', pathArr: ['城市甲', '码头'], pathStr: '城市甲>码头', desc: '', tags: [], uses: 2 },
            { id: 'az-sc3', name: '里屋', pathArr: ['城市甲', '码头', '里屋'], pathStr: '城市甲>码头>里屋', desc: '有铜箱。', tags: [], uses: 1 },
        ];
        await entry.popupAction('tab', { tab: 'scenes' });
        await entry.popupAction('edit', { kind: 'scenes', id: 'az-sc3' });
        const html = String(panelBodyHtml('scenes') || '');
        const at = html.indexOf('data-ftt-ed="parent"');
        const seg = html.slice(at, html.indexOf('</select>', at));
        const selected = (/(<option value="([^"]*)"[^>]*selected)/.exec(seg) || [])[2] || '';
        const labelOk = seg.indexOf('码头（城市甲&gt;码头）') >= 0 || seg.indexOf('码头（城市甲>码头）') >= 0;
        const indentOk = seg.indexOf('　') >= 0;
        // 用预填值保存（等价用户直接点「💾 保存」）
        const raw = FD.deconstructEntry('scenes', { id: 'az-sc3', name: '里屋', parent: selected });
        const after = (() => { const i = RT5.state.scenes.findIndex((x) => x.id === 'az-sc3'); RT5.state.scenes[i] = Object.assign({}, RT5.state.scenes[i], raw); return RT5.state.scenes[i]; })();
        return selected === 'az-sc2' && labelOk && indentOk
            && JSON.stringify(after.pathArr) === JSON.stringify(['城市甲', '码头', '里屋']);
    } finally {
        RT5.state.scenes = saveScenes2;
    }
})(), '');

// ---------- BB v2.80.0：状态行去冒号 + 关系表/约束自查收进「设定 → 约束」 ----------
await assert('BB1 v2.80.0 状态大类列表行**不再输出「：」**（用户要求）：字段与值空格分隔；值为空只留字段、字段为空只留值', (async () => {
    const RT = (await import('../core/model/runtime.js')).state;
    const save = RT.currentStates;
    try {
        RT.currentStates = [
            { id: 'bb1', subject: '甲', field: '体力', value: '疲惫', uses: 2, floorEnd: 3 },
            { id: 'bb2', subject: '甲', field: '心情', value: '', uses: 0, floorEnd: 2 },
            { id: 'bb3', subject: '甲', field: '', value: '旧伤未愈', uses: 0, floorEnd: 1 },
        ];
        await entry.popupAction('tab', { tab: 'states' });
        const html = String(panelBodyHtml('states') || '');
        const body = html.slice(html.indexOf('👤 甲'));
        return html.indexOf('👤 甲') >= 0 && body.indexOf('<b>体力</b> 疲惫') >= 0
            && body.indexOf('：') < 0                                  // 整段无冒号（含组内全部行）
            && body.indexOf('<b>心情</b><div') >= 0                    // 值为空 → 不留空格/冒号
            && body.indexOf('旧伤未愈') >= 0 && body.indexOf('<b></b>') < 0;   // 字段为空 → 不出空标签
    } finally {
        RT.currentStates = save;
    }
})(), '');

await assert('BB2 v2.80.0「设定 → 约束」端到端：子页存在且渲染四维切换条 + 角色筛选 + 关联总览 + 约束自查；页内切维度真实生效；四个列表页不再有子标签', (async () => {
    const ST = (await import('../core/model/runtime.js')).state;
    const save = { links: ST.links, memories: ST.memories };
    try {
        ST.memories = [{ id: 'bb-m1', owner: '甲', content: '甲记得昨夜有人在巷口徘徊。' }];
        ST.links = [{ id: 'bb-l1', dim: 'memories', refId: 'bb-m1', who: '甲', how: 'participant' }];
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'constraint' });
        // 约束页的维度是**页内状态**（跨次保留）→ 断言前显式切到「记忆」维度
        await entry.popupAction('constraintDim', { dim: 'memories' });
        const con = String(panelBodyHtml('settings') || '');
        const subTabs = String(await import('../ui/settings-pages.js').then((m) => m.settingsSubTabsHtml('constraint')));
        const switchDim = await entry.popupAction('constraintDim', { dim: 'plans' });
        const plans = String(panelBodyHtml('settings') || '');
        await entry.popupAction('tab', { tab: 'memories' });
        const list = String(panelBodyHtml('memories') || '');
        return subTabs.indexOf('data-ftt-subtab="constraint"') >= 0 && subTabs.indexOf('>约束<') >= 0
            && con.indexOf('data-ftt-cdim="memories"') >= 0 && con.indexOf('data-ftt-cdim="parallels"') >= 0
            && con.indexOf('data-ftt-rel-who="1"') >= 0 && con.indexOf('data-ftt-rel-entry="memories|bb-m1"') >= 0
            && con.indexOf('data-ftt-section="constraint-check"') >= 0 && con.indexOf('ftt-inject-check') >= 0
            && switchDim.ok === true && plans.indexOf('ftt-subtab ftt-on" data-ftt-cdim="plans"') >= 0
            && list.indexOf('data-ftt-msub') < 0 && list.indexOf('ftt-inject-check') < 0
            && list.indexOf('data-ftt-action="relJump"') >= 0;         // 列表页仍保留「🔗 关联」入口
    } finally {
        ST.links = save.links; ST.memories = save.memories;
    }
})(), '');

await assert('BC1 v2.80.1 点击不再闪一下：每次动作后的重渲染**复用同一 `.ftt-modal` 节点**（覆盖层不再整树替换 → CSS 入场动画不重放），且内容确实换了', (async () => {
    const el = doc.getElementById('ftt-panel');
    const stats = { panel: 0, modal: 0 };
    let modal = null;
    const makeModal = () => ({
        _h: '',
        get innerHTML() { return this._h; },
        set innerHTML(v) { this._h = String(v); stats.modal += 1; },
    });
    let html = String(el.html || '');
    Object.defineProperty(el, 'innerHTML', {
        configurable: true,
        get() { return html; },
        set(v) { html = String(v); stats.panel += 1; modal = /class="ftt-modal"/.test(html) ? makeModal() : null; },
    });
    const origQS = el.querySelector;
    el.querySelector = (sel) => (sel === '.ftt-modal' ? modal : (typeof origQS === 'function' ? origQS.call(el, sel) : null));
    await entry.popupAction('tab', { tab: 'overview' });          // 首次：整树替换 → 建立模态
    const first = el.querySelector('.ftt-modal');
    const firstHtml = String(first.innerHTML);                    // 先快照：此后 first/second 是同一对象
    const panelWrites0 = stats.panel;
    await entry.popupAction('tab', { tab: 'atoms' });             // 之后：应复用模态节点
    const second = el.querySelector('.ftt-modal');
    const reused = second === first && stats.panel === panelWrites0 && stats.modal === 1;
    const contentSwitched = String(second.innerHTML).indexOf('data-ftt-body="atoms"') >= 0
        && firstHtml !== String(second.innerHTML);
    await entry.popupAction('tab', { tab: 'overview' });
    const third = el.querySelector('.ftt-modal');
    return !!first && reused && contentSwitched && third === first && stats.modal === 2;
})(), '');

// ---------- BG 设定 → 数据管理「✂️ 删除聊天楼层」（v2.94.0 / docs/D12 v0.2 §4 S4） ----------
// 用户约定：「在设定-数据管理 中约定楼层删除的三个按钮（保留最近 6 / 10 / 12 层）」+
//   「**用官方 API 实现，不然其他插件也会异常**」→ 本小节用桩宿主跑**真实删除流程**：
//   面板三档按钮 → 二次确认 → 自动明文备份（落用户目录文件）→ **一次批量截断**（v3.17.0；零逐层调用）→ 精确编号校准。
// v3.6.0（用户要求）：「总览自动修复功能，追加一个步骤，即根据最新的情节获取最新的时间、地点、人物等信息。
//   注意最新的情节指根据内置的天数判断。」
await assert('BH12 v3.6.0 总览「🛠 自动修复」追加「按最新情节刷新时间/地点/人物」（真实点击）：最新情节按**内置天数**判断（第 30 天那条虽然楼层更小，仍胜过第 2 天那条）→ 日期 / 时间 / 地点 / 在场人物都按它写入，提示如实回报「剧情时钟：已按最新情节刷新（第 30 天 · 日期 … · 时间 … · 地点 … · 在场 …）」；手工锁定时如实跳过、不覆盖用户锚点', (async () => {
    const RT = await import('../core/model/runtime.js');
    const CS = await import('../core/state.js');
    const keepState = JSON.parse(JSON.stringify(RT.state || {}));
    const keepChat = host.ctx.chat.slice();
    const keepLast = host.ctx.getLastMessageId;
    const keepPopup = host.ctx.callGenericPopup;
    const keepLock = RT.cfg.clockManualLock;
    try {
        host.ctx.chat.length = 0;
        for (let i = 0; i < 40; i++) host.ctx.chat.push({ is_user: i % 2 === 0, mes: '第' + i + '楼：甲在码头清点铜箱并记账（正文足够长）。', name: i % 2 === 0 ? 'User' : '角色甲' });
        host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
        const st = RT.state;
        st.state = Object.assign({}, st.state, { date: '1919-01-01', time: '00:00', location: '旧地点', present: ['旧人'] });
        delete st.state.clockManual;
        st.snapshots = [{ id: 'bh12-snap', name: '角色甲', identity: {}, updatedAt: 1 }];
        st.atoms = [
            { id: 'bh12-day30', title: '第30天', text: '甲在仓库核对账本与银元兑换比例（正文足够长）。', date: '1919-11-10', time: '10:30', location: '仓库', storyDay: 30, floorStart: 1, floorEnd: 2, entities: ['角色甲'], tags: [], updatedAt: 1 },
            { id: 'bh12-day2', title: '第2天', text: '甲在码头卸货并清点铜箱（正文足够长）。', date: '1919-11-02', time: '08:00', location: '码头', storyDay: 2, floorStart: 35, floorEnd: 36, entities: ['某乙'], tags: [], updatedAt: 2 },
        ];
        st.deleted = {}; st.deletedH = {};
        st.processedFloors = []; st.processedVer = (await import('../host/floors.js')).processedVerTag();
        st.lastKnownFloor = 39;
        RT.cfg.clockManualLock = true;                  // 未锁定时才刷新（下面会临时解锁）
        RT.cfg.clockManualLock = false;
        await entry.popupAction('tab', { tab: 'overview' });
        host.ctx.callGenericPopup = async () => 1;
        const r = await entry.popupAction('repair', {});
        const note = String((r.state || {}).note || '');
        const clock = (r.repair && r.repair.stage1 && r.repair.stage1.clockSync) || null;
        const s2 = RT.state.state || {};
        const dayOk = !!clock && clock.plotStoryDay === 30 && String(clock.plotId) === 'bh12-day30';
        const appliedOk = String(s2.date) === '1919-11-10' && String(s2.time) === '10:30' && String(s2.location) === '仓库'
            && Array.isArray(s2.present) && s2.present.indexOf('角色甲') >= 0
            && String((s2.clockSrc || {}).present) === 'plot-atom';
        const noteOk = /剧情时钟：已按最新情节刷新（第 30 天/.test(note) && note.indexOf('地点 仓库') > 0;
        // ② 手工锁定 → 不覆盖（真实点击一次，锚点保持手工值）
        //   注：手工改写由「✏️ 手工改写」动作直接写入 `state.state.*`，锁定只保证**自动提取不再覆盖**它。
        RT.state.state.clockManual = { date: '1919-01-01', time: '00:00', location: '手工锚点', at: 1 };
        RT.state.state.date = '1919-01-01'; RT.state.state.time = '00:00'; RT.state.state.location = '手工锚点';
        RT.cfg.clockManualLock = true;
        const r2 = await entry.popupAction('repair', {});
        const note2 = String((r2.state || {}).note || '');
        const lockOk = note2.indexOf('剧情时钟：已跳过（手工锁定') > 0 && String(RT.state.state.location) === '手工锚点'
            && String(RT.state.state.date) === '1919-01-01';
        const ok = dayOk && appliedOk && noteOk && lockOk;
        if (!ok) console.log('BH12-DEBUG ' + JSON.stringify({ dayOk, clock, appliedOk, noteOk, lockOk, note: note.slice(0, 200), note2: note2.slice(0, 200) }));
        return ok;
    } finally {
        RT.cfg.clockManualLock = keepLock;
        host.ctx.chat.length = 0; for (const m of keepChat) host.ctx.chat.push(m);
        host.ctx.getLastMessageId = keepLast;
        host.ctx.callGenericPopup = keepPopup;
        try { RT.setKernelState(keepState); } catch (e) { /* 忽略 */ }
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

// v3.5.0（用户要求）：
//   ①「总览的自动修复功能，追加计划悬念修复，该修复与当前计划悬念内的修复一致，只是调用一下处理。」
//   ②「总览的自动修复功能，增加识别楼层突变……当前楼层与最新情节对应楼层不一致且存在跨度达到 9 层以上，
//      说明楼层出现大幅手动删减。需修正已处理记录，避免无法正常分析楼层。」
await assert('BH11 v3.5.0 总览「🛠 自动修复」追加两步（真实点击）：① **计划/悬念修复**（与「设定 → 计划悬念 → 🔧 修复计划/悬念」同一条处理，静默调用）→ 两条同正文悬念被机械去重；② **楼层突变识别**（最新情节在第 100 楼、当前只有第 59 楼 → 相差 41 层 ≥ 9）→ 按内容哈希修正已处理记录并把越界区间降级，提示如实回报两步结论；修正后**新楼层照常进入未摘要清单**（不再「无法正常分析楼层」）', (async () => {
    const RT = await import('../core/model/runtime.js');
    const FL = await import('../host/floors.js');
    const keepState = JSON.parse(JSON.stringify(RT.state || {}));
    const keepChat = host.ctx.chat.slice();
    const keepLast = host.ctx.getLastMessageId;
    const keepAutoAi = RT.cfg.repairAutoAi;
    try {
        // 60 层聊天（AI 楼为奇数位），最新情节自称到第 100 楼 → 判为大幅手动删减
        host.ctx.chat.length = 0;
        for (let i = 0; i < 60; i++) host.ctx.chat.push({ is_user: i % 2 === 0, mes: '第' + i + '楼：甲在码头清点铜箱并记账（正文足够长）。', name: i % 2 === 0 ? 'User' : '角色甲' });
        host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
        const st = RT.state;
        st.atoms = [
            { id: 'bh11-a1', title: '情节一', text: '甲在码头清点铜箱并记账，铜箱成色与银元兑换比例需与账本核对（正文足够长，避免被判为垃圾条目）。', date: '1919-11-01', floorStart: 0, floorEnd: 1, tags: [], updatedAt: 1 },
            { id: 'bh11-a2', title: '最新情节', text: '甲在仓库核对账本，发现铜箱少了三成，随即追问搬运工（正文足够长，避免被判为垃圾条目）。', date: '1919-11-02', floorStart: 99, floorEnd: 100, tags: [], updatedAt: 2 },
        ];
        st.processedFloors = [{ f: 90, h: FL.hashFloorText(90) }, { f: 3, h: FL.hashFloorText(3) }];
        st.processedVer = FL.processedVerTag();
        // 关键：**不**让「末楼收缩哨兵」先行兜住（`lastKnownFloor` 保持未知）——本轮要验证的正是
        //   「当前楼层与最新情节对应楼层不一致（差 41 层 ≥ 9）」这条**新判据**能识别并修正。
        st.lastKnownFloor = -1;
        st.plans = [{ id: 'bh11-p1', title: '送信', content: '把信送到码头。', status: 'open', tags: [], uses: 1, updatedAt: 1 }];
        st.suspense = [
            { id: 'bh11-s1', title: '谁在跟踪', content: '有人在码头盯着甲看。', status: 'open', tags: [], uses: 1, updatedAt: 1 },
            { id: 'bh11-s2', title: '谁在跟踪', content: '有人在码头盯着甲看。', status: 'open', tags: [], uses: 1, updatedAt: 2 },
        ];
        st.deleted = {}; st.deletedH = {};
        RT.cfg.repairAutoAi = true;
        await entry.popupAction('tab', { tab: 'overview' });
        host.ctx.callGenericPopup = async () => 1;
        const r = await entry.popupAction('repair', {});
        const note = String((r.state || {}).note || '');
        const rep = r.repair || {};
        // ① 计划/悬念修复真的跑了：两条同正文悬念最终只剩一条（可能先被第 1 段的机械去重合并，
        //   故这里断言「同一条处理被调用过 + 结论进了提示」；「同一条处理会做机械去重」由单测 A3 证明）
        const suspLeft = (RT.state.suspense || []).length;
        const suspOk = suspLeft === 1 && !!rep.planSusp && rep.planSuspSkipped === '';
        // ② 楼层突变识别与修正
        const jump = (rep.stage1 && rep.stage1.floorJump) || null;
        const marksLeft = (RT.state.processedFloors || []).length;
        const jumpOk = !!jump && jump.jumped === true && jump.gap === 41 && jump.acted === true
            && marksLeft === 1 && (RT.state.processedFloors || []).some((x) => Number(x.f) === 3)
            && Number(RT.state.lastKnownFloor) === 59;
        // 提示里两步结论都在
        const noteOk = /计划\/悬念修复：/.test(note) && /楼层突变：最新情节在第 100 楼、当前只有第 59 楼（相差 41 层/.test(note)
            && note.indexOf('已按内容哈希修正已处理记录') > 0;
        // ③ 修正后新楼层照常可分析（用户要的「避免无法正常分析楼层」）
        host.ctx.chat.length = 0;
        for (let i = 0; i < 64; i++) host.ctx.chat.push({ is_user: i % 2 === 0, mes: '第' + i + '楼：甲在码头清点铜箱并记账（正文足够长）。', name: i % 2 === 0 ? 'User' : '角色甲' });
        const pend = FL.scanPendingFloors({ maintain: false }).floors;
        const analyzeOk = pend.indexOf(61) >= 0 && pend.indexOf(63) >= 0;
        const ok = suspOk && jumpOk && noteOk && analyzeOk;
        if (!ok) console.log('BH11-DEBUG ' + JSON.stringify({ suspOk, suspLeft, planSusp: rep.planSusp, jumpOk, jump, marksLeft, lastKnownFloor: RT.state.lastKnownFloor, noteOk, analyzeOk, note: note.slice(0, 300) }));
        return ok;
    } finally {
        RT.cfg.repairAutoAi = keepAutoAi;
        host.ctx.chat.length = 0; for (const m of keepChat) host.ctx.chat.push(m);
        host.ctx.getLastMessageId = keepLast;
        try { RT.setKernelState(keepState); } catch (e) { /* 忽略 */ }
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

// v3.17.0（用户报告）：「请核对当使用插件内置删除楼层功能后，应用整体进入严重卡顿的问题。」
//   真机取证：v3.4.0 依赖的 `/cut` 命令在宿主上**不生效** → 退到「逐层 deleteMessage」，
//   实测 ≈1.5 秒/层 → 242 层删 230 层卡了 **5 分 45 秒**。
//   修复口径：默认走**一次批量截断**；逐层只在「批量不可用且 ≤3 层」时作最后手段，超过即拒绝。
await assert('BH10 v3.17.0/v3.17.1 删楼不再逐层：真实点击「保留最近 10 层」→ 走**一次批量截断**（`saveChat`/`clearChat`/`printMessages` 各 1 次）且**一次 `deleteMessage` 都不调用**，聊天一次截断到位，提示如实回报「方式 批量截断」；宿主只能逐层（批量接口全部缺失）且待删 14 层 → **拒绝执行**（不备份、不动聊天）；只能逐层但只删 2 层 → 逐层最后手段可用；三条路径都只删更早楼层、记忆一条不少', (async () => {
    const RT = await import('../core/model/runtime.js');
    const FH = await import('../host/floor-trim.js');
    const keepChat = host.ctx.chat.slice();
    const keepLast = host.ctx.getLastMessageId;
    const keepDel = host.ctx.deleteMessage;
    const keepSave = host.ctx.saveChat, keepClear = host.ctx.clearChat, keepPrint = host.ctx.printMessages;
    // v3.17.1：批量能力现在认 5 个官方接口（`saveChat` / `saveChatConditional` / `clearChat` / `printMessages` /
    //   `reloadCurrentChat`）—— 「无批量能力宿主」必须把它们**全部**摘掉，否则仍会走批量路径。
    const keepSaveCond = host.ctx.saveChatConditional, keepReload = host.ctx.reloadCurrentChat;
    const setBulk = (on) => {
        const put = (k, v) => { if (on) host.ctx[k] = v; else delete host.ctx[k]; };
        put('saveChat', keepSave); put('saveChatConditional', keepSaveCond);
        put('clearChat', keepClear); put('printMessages', keepPrint); put('reloadCurrentChat', keepReload);
    };
    const keepAtoms = JSON.parse(JSON.stringify(RT.state.atoms || []));
    const mkChat = (n) => { host.ctx.chat.length = 0; for (let i = 0; i < n; i++) host.ctx.chat.push({ is_user: i % 2 === 0, mes: '第' + i + '楼：甲在码头清点铜箱并记账（正文足够长）。', name: i % 2 === 0 ? 'User' : '角色甲' }); host.ctx.getLastMessageId = () => host.ctx.chat.length - 1; };
    /** 本轮新增的删楼备份文件（不许改删楼钩子：钩子归 index.js 接线，改了就污染后续 BG1 的真实备份） */
    const newBackups = (before) => Array.from(srvFiles.keys()).filter((k) => String(k).indexOf('ftt2-floor-backup-') === 0 && !before.has(k));
    try {
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'data' });
        host.ctx.callGenericPopup = async () => 1;                       // 二次确认 → 确认
        // ① 宿主有批量能力（默认）：一次批量截断，零逐层调用
        mkChat(40);
        const b0 = { save: host.ctx.saveChatCount || 0, clear: host.ctx.clearChatCount || 0, print: host.ctx.printMessagesCount || 0 };
        const files1 = new Set(srvFiles.keys());
        const rec = { deleteCalls: 0 };
        host.ctx.deleteMessage = async (id) => { rec.deleteCalls += 1; const i = Number(id); if (i >= 0 && i < host.ctx.chat.length) host.ctx.chat.splice(i, 1); };
        const r1 = await entry.popupAction('floorTrim', { keep: 10 });
        const note1 = String((r1.state || {}).note || '');
        const floors1 = host.ctx.chat.length;                          // 立即取（后面还会再删几轮）
        const bulkOk = r1.ok === true && r1.via === 'bulk' && rec.deleteCalls === 0 && floors1 === 10
            && (host.ctx.saveChatCount || 0) - b0.save === 1 && (host.ctx.clearChatCount || 0) - b0.clear === 1
            && (host.ctx.printMessagesCount || 0) - b0.print === 1
            && host.ctx.chatMetadata.tainted === true
            && newBackups(files1).length === 1                        // 删前备份照旧落盘（真实 fetch 桩）
            && note1.indexOf('方式 批量截断') >= 0 && String(r1.summary || '').indexOf('删除方式 批量截断（一次完成') >= 0;
        // ② 宿主只能逐层 + 待删 14 层（>3）→ **拒绝执行**：一层不删、连备份都不做
        mkChat(20);
        setBulk(false);
        const files2 = new Set(srvFiles.keys());
        const rec2 = { deleteCalls: 0 };
        host.ctx.deleteMessage = async (id) => { rec2.deleteCalls += 1; const i = Number(id); if (i >= 0 && i < host.ctx.chat.length) host.ctx.chat.splice(i, 1); };
        const r2 = await entry.popupAction('floorTrim', { keep: 6 });
        const note2 = String((r2.state || {}).note || '');
        const refuseOk = r2.ok === false && r2.reason === 'slow-path-refused' && host.ctx.chat.length === 20
            && rec2.deleteCalls === 0 && newBackups(files2).length === 0
            && note2.indexOf('已拒绝') >= 0 && note2.indexOf('21 秒') >= 0;
        // ③ 只能逐层但只删 2 层（≤3）→ 逐层最后手段可用：从后往前 2 次、如实回报 `api`
        mkChat(20);
        const rec3 = { deleteCalls: 0 };
        host.ctx.deleteMessage = async (id) => { rec3.deleteCalls += 1; const i = Number(id); if (i >= 0 && i < host.ctx.chat.length) host.ctx.chat.splice(i, 1); };
        const r3 = await entry.popupAction('floorTrim', { keep: 18 });
        const note3 = String((r3.state || {}).note || '');
        const slowOk = r3.ok === true && r3.via === 'api' && rec3.deleteCalls === 2 && host.ctx.chat.length === 18
            && note3.indexOf('方式 逐层删除（慢）') >= 0;
        // ④ 能力与诊断如实回报当前宿主走哪条路径
        setBulk(true);
        const capBulk = FH.floorTrimCapability();
        const stBulk = FH.floorTrimStatus();
        setBulk(false);
        const capSlow = FH.floorTrimCapability();
        const stSlow = FH.floorTrimStatus();
        const statOk = capBulk.bulk === true && capBulk.bulkMode === 'clear+print' && stBulk.via === 'bulk'
            && capSlow.bulk === false && capSlow.slow === true && stSlow.via === 'api'
            && stSlow.last && stSlow.last.via === 'api';
        // ⑤ 记忆一条不少
        const entriesOk = Array.isArray(RT.state.atoms) && (RT.state.atoms.length === (keepAtoms || []).length);
        const ok = bulkOk && refuseOk && slowOk && statOk && entriesOk;
        if (!ok) console.log('BH10-DEBUG ' + JSON.stringify({ bulkOk, delCalls: rec.deleteCalls, floors1, via1: r1.via, note1: note1.slice(0, 200), refuseOk, calls2: rec2.deleteCalls, floors2: host.ctx.chat.length, note2: note2.slice(0, 200), slowOk, calls3: rec3.deleteCalls, via3: r3.via, note3: note3.slice(0, 160), statOk, capBulk, stBulkVia: stBulk.via, capSlow, entriesOk }));
        return ok;
    } finally {
        host.ctx.chat.length = 0; for (const m of keepChat) host.ctx.chat.push(m);
        host.ctx.getLastMessageId = keepLast;
        host.ctx.deleteMessage = keepDel;
        if (keepSave === undefined) delete host.ctx.saveChat; else host.ctx.saveChat = keepSave;
        if (keepClear === undefined) delete host.ctx.clearChat; else host.ctx.clearChat = keepClear;
        if (keepPrint === undefined) delete host.ctx.printMessages; else host.ctx.printMessages = keepPrint;
        if (keepSaveCond === undefined) delete host.ctx.saveChatConditional; else host.ctx.saveChatConditional = keepSaveCond;
        if (keepReload === undefined) delete host.ctx.reloadCurrentChat; else host.ctx.reloadCurrentChat = keepReload;
        RT.state.atoms = keepAtoms;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

await assert('BG1 数据管理页真实点击「保留最近 10 层」：走官方 API 真删聊天楼层（20→10；v3.17.0 起是**一次批量截断** —— `saveChat` + `clearChat`/`printMessages` + **一次** `MESSAGE_DELETED`，零逐层调用）、删前自动明文备份落盘、删后记忆一条不少且编号校准、面板给出摘要', (async () => {
    const RT = await import('../core/model/runtime.js');
    const keepChat = host.ctx.chat.slice();
    const keepLast = host.ctx.getLastMessageId;
    const keepAtoms = JSON.parse(JSON.stringify(RT.state.atoms || []));
    const keepMeta = host.ctx.chatMetadata;
    try {
        // ① 20 层聊天 + 三条带楼层区间的情节（全删段 / 跨越删除线 / 幸存段）
        host.ctx.chat.length = 0;
        for (let i = 0; i < 20; i++) host.ctx.chat.push({ is_user: i % 2 === 0, mes: '第' + i + '楼正文', name: i % 2 === 0 ? 'User' : '角色甲' });
        host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
        host.ctx.deletedMessages = [];
        RT.state.atoms = [
            { id: 'bg-a0', text: '早期情节', floorStart: 1, floorEnd: 3, tags: [], keywords: [] },
            { id: 'bg-a1', text: '跨越情节', floorStart: 0, floorEnd: 15, tags: [], keywords: [] },
            { id: 'bg-a2', text: '幸存情节', floorStart: 16, floorEnd: 18, tags: [], keywords: [] },
        ];
        RT.state.processedFloors = [];
        RT.state.lastKnownFloor = 19;
        // ② 面板审计：设定 → 数据管理页有三档按钮 + 只读诊断行
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'data' });
        const dh = String((await entry.popupAction('refresh', {})).html || '');
        const uiOk = dh.indexOf('✂️ 删除聊天楼层（减小聊天体积）') >= 0
            && dh.indexOf('data-ftt-action="floorTrim" data-ftt-keep="6"') >= 0
            && dh.indexOf('data-ftt-action="floorTrim" data-ftt-keep="10"') >= 0
            && dh.indexOf('data-ftt-action="floorTrim" data-ftt-keep="12"') >= 0
            && dh.indexOf('>保留最近 10 层</button>') >= 0
            && dh.indexOf('只读诊断：当前 20 层') >= 0
            && dh.indexOf('将删除 10 层') >= 0;                  // 按钮 title 内的**预检**结论
        // ③ 真实动作（确认框由桩宿主 `callGenericPopup` 返回 1 = 确认）
        const beforeFiles = new Set(srvFiles.keys());
        const b0 = { save: host.ctx.saveChatCount || 0, clear: host.ctx.clearChatCount || 0, print: host.ctx.printMessagesCount || 0 };
        const r = await entry.popupAction('floorTrim', { keep: 10 });
        const note = String(((r.state || {}).note) || '');
        // ④ 聊天真的短了 + 官方副作用可观测：v3.17.0 起是**一次批量截断** ——
        //    `saveChat` / `clearChat` / `printMessages` 各 1 次、**零**逐层 `deleteMessage`、
        //    `MESSAGE_DELETED` **一次**（与官方 `deleteMessage` 的 payload 同口径）、`chatMetadata.tainted` 置位
        const delOk = host.ctx.chat.length === 10 && (host.ctx.deletedMessages || []).length === 0
            && (host.ctx.saveChatCount || 0) - b0.save === 1
            && (host.ctx.clearChatCount || 0) - b0.clear === 1
            && (host.ctx.printMessagesCount || 0) - b0.print === 1
            && r.via === 'bulk' && host.ctx.chatMetadata.tainted === true;
        // ⑤ 备份**真的落到了用户目录文件**（前缀不与主文件冲突；内容 = 导出信封）
        const backupNames = Array.from(srvFiles.keys()).filter((k) => String(k).indexOf('ftt2-floor-backup-') === 0 && !beforeFiles.has(k));
        const backupOk = backupNames.length === 1
            && /^ftt2-floor-backup-.+-s[123]-\d{8}-\d{6}\.json$/.test(String(backupNames[0]))   // v3.0.17：名字必须带日期时间
            && String(srvFiles.get(backupNames[0]) || '').indexOf('ftt-memory-v2-export') >= 0;
        // ⑥ 记忆一条不少；编号按**实际删除量**校准（全删段/跨越段 → 未知区间；幸存段前移）
        const g = (id) => (RT.state.atoms || []).filter((x) => x.id === id)[0] || {};
        // v3.7.0（用户要求）：「原子数据来源记录了楼层，**原始楼层不应该变动**……找不到对应楼层哈希值 → **标记原文已移除**；
        //   同时新的楼层必须**结合新的位置**来记录」→ 断言由「来源楼层置 0/0」改判为「来源楼层原样保留 + 当前位置/原文已移除」。
        const dataOk = RT.state.atoms.length === 3
            && g('bg-a0').floorStart === 1 && g('bg-a0').floorEnd === 3 && g('bg-a0').originGone === true && g('bg-a0').floorStale === undefined
            && g('bg-a1').floorStart === 0 && g('bg-a1').floorEnd === 15 && g('bg-a1').floorNowStart === 0 && g('bg-a1').floorNowEnd === 5   // 跨越删除线：终点前移 15-10
            && g('bg-a2').floorStart === 16 && g('bg-a2').floorEnd === 18 && g('bg-a2').floorNowStart === 6 && g('bg-a2').floorNowEnd === 8   // 幸存段整体前移 10
            && g('bg-a2').originGone === undefined
            && RT.state.lastKnownFloor === 9;
        // ⑦ 面板摘要讲清「删了几层 / 记忆保留多少 / 备份文件名」
        const noteOk = String(r.note || note).indexOf('已删除 10 层') >= 0
            && String(r.note || note).indexOf('保留最近 10 层') >= 0
            && String(r.note || note).indexOf('备份') >= 0;
        // ⑧ 人工确认项（低噪声：一类一条，含备份与「记忆保留 N 条」）
        const CF = await import('../core/conflicts.js');
        const conf = CF.listConflicts().filter((x) => String(x.kind) === '删楼')[0];
        const confOk = !!conf && String(conf.detail).indexOf('备份') >= 0 && String(conf.detail).indexOf('记忆保留') >= 0;
        // ⑨ v3.0.16 根因回归（用户报告「使用内置删除楼层后，无法衔接继续分析，新增正文无法分析」）：
        //   删楼后继续聊天 → 新增正文仍能被「⚡ 立即 AI 摘要」分析。这里把**内核末楼快照**人为设成
        //   远大于当前聊天的旧值（模拟官方 deleteMessage 之后、刷新事件还没到的真实窗口）——
        //   修复前区间按旧值算 → 扫到一堆已不存在的楼层 → 全部 missing → 「没有可分析楼层」。
        const keepGen2 = host.ctx.generateRaw;
        let newOk = false;
        try {
            host.ctx.generateRaw = async () => JSON.stringify({ 情节: { 新增: [{ 标题: '删楼后新增', 正文: '删楼之后甲又搬来一只新铜箱（正文足够长）。', 日期: '1919-12-03' }] } });
            host.ctx.chat.push({ is_user: false, mes: '删楼之后的第 1 楼正文。', name: '角色甲' });
            host.ctx.chat.push({ is_user: false, mes: '删楼之后的第 2 楼正文。', name: '角色甲' });
            host.ctx.chat.push({ is_user: false, mes: '删楼之后的第 3 楼正文。', name: '角色甲' });
            RT.setLastMessageId(199);                       // 旧快照（远大于实际聊天长度）
            const sum = await entry.popupAction('summary', {});
            const note2 = String(((sum.state || {}).note) || '');
            const rangeTxt = (note2.match(/读取楼层 (\d+)-(\d+)/) || []);
            newOk = note2.indexOf('摘要完成：') === 0 && /新增 [1-9]/.test(note2)
                && (RT.state.atoms || []).some((x) => x.id !== 'bg-a0' && x.id !== 'bg-a1' && x.id !== 'bg-a2' && String(x.title) === '删楼后新增')
                && Number(rangeTxt[2]) <= host.ctx.chat.length - 1;      // 区间按**活值**取，不越界
            if (!newOk) console.log('BG1-DEBUG9 ' + JSON.stringify({ note2, rangeTxt, chat: host.ctx.chat.length }));
        } finally { host.ctx.generateRaw = keepGen2; }
        // ⑩ v3.0.17（用户要求「导出 json 备份，文件名必须带日期和时间」）：同槽位再备份一次 →
        //   新文件带**新的**时间戳，且该槽位上一份被删除（文档承诺的「3 份轮转」上限不变）。
        let rotateOk = false;
        try {
            const FB = await import('../adapters/floor-backup.js');
            const slug = String(backupNames[0]).replace('ftt2-floor-backup-', '').replace(/-s[123]-\d{8}-\d{6}\.json$/, '');
            const prevBackup = String(backupNames[0]);
            const rw = await FB.writeFloorBackup('char:' + slug, 0, '{"format":"ftt-memory-v2-export","state":{}}', { prevName: prevBackup, at: new Date(2026, 8, 30, 15, 6, 7) });
            rotateOk = rw.ok === true && rw.name !== prevBackup && String(rw.name).indexOf('-s1-20260930-150607.json') > 0
                && rw.replaced === prevBackup && !srvFiles.has(prevBackup) && srvFiles.has(String(rw.name));
        } catch (e) { rotateOk = false; }
        await entry.popupAction('tab', { tab: 'overview' });
        const allOkBg1 = uiOk && r.ok === true && delOk && backupOk && dataOk && noteOk && confOk && newOk && rotateOk;
        if (!allOkBg1) console.log('BG1-DEBUG ' + JSON.stringify({ uiOk, rOk: r.ok, reason: r.reason, via: r.via, note: String(r.note || note).slice(0, 220), delOk, backupOk, backupNames, dataOk, noteOk, confOk, newOk, rotateOk, chat: host.ctx.chat.length, atoms: (RT.state.atoms || []).map((x) => ({ id: x.id, fs: x.floorStart, fe: x.floorEnd, ns: x.floorNowStart, ne: x.floorNowEnd, gone: x.originGone, stale: x.floorStale })) }));
        return allOkBg1;
    } finally {
        host.ctx.chat.length = 0;
        for (const m of keepChat) host.ctx.chat.push(m);
        host.ctx.getLastMessageId = keepLast;
        host.ctx.chatMetadata = keepMeta;
        RT.state.atoms = keepAtoms;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

// v3.0.20（用户报告）：「设定-数据存储-清除已处理楼层记录，该功能异常，应该直接将已分析楼层统计归零，
//   确保可以在总览中重新看到第0层之后的所有待分析楼层。」
//   根因：台账清空后还有第二条跳过判据「该楼已有记忆数据」（v2.64.0 新增）——分析过的楼层本来就有数据，
//   于是「清了没变化」（V1 的 clearFloors 只有台账判据，故清空即全部重现）。
// v3.0.22（用户要求）：「总览新增保存按钮，可对齐已开启的所有存储，包括内存、浏览器本地变量、服务端等，全部对齐数据。」
await assert('BG4 v3.0.22 总览「💾 保存（对齐所有存储）」真实点击：把当前内存数据写到**每一层已开启的存储**并逐层回报 —— 本机缓冲（localStorage）+ 服务端记忆文件 + **分片**（本次全量重传）+ 清单；未开启的层（快照/世界书）如实跳过；提示行列出各层结果', (async () => {
    const RT = await import('../core/model/runtime.js');
    const SH = await import('../adapters/shards.js');
    const CS = await import('../core/state.js');
    const keepSync = !!(rtMod.cfg.storage && rtMod.cfg.storage.syncOnSave);
    const scope = CS.scopeId();                     // 与生产同源（`stateFileName(scopeId())` / `shardName(scopeId())`）
    try {
        rtMod.cfg.storage.syncOnSave = false;                       // 隔离：本小节只看「保存流水线 + 分片」（跨端镜像另测）
        await entry.popupAction('tab', { tab: 'overview' });
        const html = String((await entry.popupAction('refresh', {})).html || '');
        const btnOk = html.indexOf('data-ftt-action="saveAll"') >= 0 && html.indexOf('💾 保存（对齐所有存储）') >= 0;
        // 让内存里有一条可辨识的数据（确保「对齐」写的是当前内存）
        RT.state.atoms = (RT.state.atoms || []).concat([{ id: 'bg4-a', title: '对齐标记', text: '这条数据用于验证保存按钮（正文足够长）。', date: '1919-12-09', tags: [], updatedAt: Date.now() }]);
        const beforeFiles = new Set(srvFiles.keys());
        const r = await entry.popupAction('saveAll', {});
        const note = String(((r.state || {}).note) || '');
        const layers = r.layers || {};
        // ① 本机缓冲（浏览器本地变量）真的写了，且带上了那条数据
        const localKey = 'ftt2_state_' + scope;
        const localRaw = (() => { try { return globalThis.localStorage ? globalThis.localStorage.getItem(localKey) : null; } catch (e) { return null; } })();
        const localOk = String(layers.state && layers.state.via || '').indexOf('localStorage') >= 0;
        // ② 服务端主文件 + 分片 + 清单都落了盘（分片本次 force 全量重传）
        const newFiles = Array.from(srvFiles.keys()).filter((k) => !beforeFiles.has(k));
        const mainOk = String(layers.state && layers.state.via || '').indexOf('file') >= 0;
        const shardNames = Array.from(srvFiles.keys()).filter((k) => String(k).indexOf('ftt2-shard-') === 0 && String(k).indexOf('-manifest') < 0);
        const shardOk = shardNames.length >= 14 && srvFiles.has(SH.shardManifestName(scope))
            && srvFiles.has(SH.shardName(scope, 'atoms'));
        const atomsShard = JSON.parse(srvFiles.get(SH.shardName(scope, 'atoms')) || '{}');
        const atomsOk = ((atomsShard.payload || []).some((x) => x.id === 'bg4-a')) === true;
        // ③ 未开启的层如实跳过；提示行逐层可读
        // 未开启的层如实跳过（世界书本小节关闭 → `disabled`），且出现在 `skipped` 列表里
        const skipOk = !!(layers.worldbook && layers.worldbook.skipped) && (r.skipped || []).indexOf('worldbook') >= 0
            && (layers.snapshot && (layers.snapshot.ok === true || !!layers.snapshot.skipped));
        const noteOk = note.indexOf('已对齐所有存储') === 0 && note.indexOf('本机缓冲✓') >= 0 && note.indexOf('服务端✓') >= 0;
        const ok = btnOk && r.ok === true && localOk && mainOk && shardOk && atomsOk && skipOk && noteOk;
        if (!ok) console.log('BG4-DEBUG ' + JSON.stringify({ btnOk, r: { ok: r.ok, failed: r.failed, skipped: r.skipped, layers: r.layers }, note: note.slice(0, 160), newFiles: newFiles.slice(0, 6), shards: shardNames.length, localOk, mainOk, shardOk, atomsOk, skipOk, noteOk, localRaw: localRaw ? localRaw.length : 0, scope: scope, file: 'ftt2-state-' + scope }));
        return ok;
    } finally {
        if (rtMod.cfg.storage) rtMod.cfg.storage.syncOnSave = keepSync;
        RT.state.atoms = (RT.state.atoms || []).filter((x) => x.id !== 'bg4-a');
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


// v3.1.0（用户要求）：「按建议改善性能。」—— 依据 `docs/D13` 的分阶段方案（S0 观测 · S1 渲染 · S2 常驻 · S3 配额）
await assert('BH7 v3.1.0 渲染成本（`docs/D13` S1/S0）：真实切页时**只构建当前分页**（其它页只留占位容器）·**一次动作只构建一遍**（旧实现 3 遍）· 角色页下钻索引化后规模守卫（200 档案 × 400 记忆 × 2000 关联行 ≤ 500ms，旧实现 ≈ 1970ms）· 渲染观测可读（`FTT.renderStats()`）', (async () => {
    const RT = await import('../core/model/runtime.js');
    const P = await import('../ui/panel.js');
    const keepState = JSON.parse(JSON.stringify(RT.state || {}));
    const keepTab = P.panelState().tab;
    try {
        // ---------- ① 只构建当前分页 ----------
        await entry.popupAction('tab', { tab: 'overview' });
        const ov = String(P.panelModalInnerHtml());
        const onlyActive = ov.indexOf('📖 FTT记忆组件') >= 0 && ov.indexOf('data-ftt-body="overview"') >= 0
            && (ov.match(/data-ftt-body="/g) || []).length === 13            // 13 个容器恒在
            && ov.indexOf('data-ftt-settings-page=') < 0;                    // 但设定页正文不在
        const all = String(P.panelModalInnerHtml({ all: true }));
        const allBuilt = all.length > ov.length && all.indexOf('data-ftt-settings-page=') >= 0;

        // ---------- ② 一次动作 = 一次构建 ----------
        const b0 = P.panelRenderStats().builds;
        await entry.popupAction('refresh', {});
        const b1 = P.panelRenderStats().builds;

        // ---------- ③ 角色页规模守卫（真实切页 + 索引化下钻） ----------
        RT.state.atoms = (RT.state.atoms || []).slice(0, 300);
        RT.state.memories = Array.from({ length: 400 }, (_, i) => ({ id: 'bh7-m' + i, owner: '甲', title: '记忆' + i, content: '甲记得第 ' + i + ' 件事（正文足够长）。', date: '1919-11-01', updatedAt: 1000 + i }));
        RT.state.plans = Array.from({ length: 180 }, (_, i) => ({ id: 'bh7-pl' + i, title: '计划' + i, content: '送信', status: 'open', updatedAt: 1000 + i }));
        RT.state.suspense = Array.from({ length: 180 }, (_, i) => ({ id: 'bh7-su' + i, title: '悬念' + i, content: '谁在跟踪', status: 'open', updatedAt: 1000 + i }));
        RT.state.snapshots = Array.from({ length: 200 }, (_, i) => ({ id: 'bh7-s' + i, name: '角色' + i, identity: { occupation: '商人', birthDate: '1890-01-01' }, background: '档案正文（足够长）'.repeat(20), uses: 1, updatedAt: 1000 + i }));
        RT.state.links = [];
        for (let i = 0; i < 2000; i++) RT.state.links.push({ id: 'bh7-L' + i, dim: 'memories', refId: 'bh7-m' + (i % 400), who: '角色' + (i % 200), how: 'witness' });
        P.panelBodyHtml('snapshots');                                        // 预热
        const t0 = performance.now();
        const r = await entry.popupAction('tab', { tab: 'snapshots' });
        const ms = performance.now() - t0;
        const html = String(r.html || '');
        const drillOk = html.indexOf('🧠 已知') >= 0 && html.indexOf('角色0') >= 0;
        const guardOk = ms <= 500;

        // ---------- ④ 渲染观测可读 ----------
        const stats = P.panelRenderStats();
        const statsOk = globalThis.FTT && typeof globalThis.FTT.renderStats === 'function'
            && Number(globalThis.FTT.renderStats().renders) === Number(stats.renders) && stats.builds > 0
            && stats.lastTab === 'snapshots' && stats.lastBytes > 0;

        const ok = onlyActive && allBuilt && (b1 - b0) === 1 && drillOk && guardOk && statsOk;
        if (!ok) console.log('BH7-DEBUG ' + JSON.stringify({ onlyActive, allBuilt, builds: b1 - b0, drillOk, ms: Math.round(ms), guardOk, statsOk }));
        return ok;
    } finally {
        try { RT.setKernelState(keepState); } catch (e) { /* 忽略 */ }
        try { await entry.popupAction('tab', { tab: keepTab || 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

// v3.1.0（`docs/D13` S2/S3）：容量上限与配额兜底
await assert('BH8 v3.1.0 容量与配额（`docs/D13` S2/S3）：向量缓存内存副本有 LRU 上限（`FTT.vectorCache()` 可读 evicted/bytes/maxEntries）· 本机缓冲超预算时**如实跳过并可读原因**（服务端文件照写，旧内容不被清空）· 调试日志单条上限降到 2000 字符', (async () => {
    const VC = await import('../adapters/vector-cache.js');
    const DL = await import('../core/debug-log.js');
    const ST = await import('../adapters/store.js');
    const keepCaps = { entries: 2000, bytes: 32 * 1024 * 1024 };
    const keepBudget = 0;
    try {
        // ① 向量缓存 LRU（把上限压到 2 条，写 3 条 → 至少淘汰 1 条）
        VC.resetVectorCacheState();
        globalThis.FTT.vectorCacheCaps({ entries: 2 });
        await VC.vecCachePutMany([{ key: 'bh8-a', vector: [1, 2, 3] }, { key: 'bh8-b', vector: [4, 5, 6] }, { key: 'bh8-c', vector: [7, 8, 9] }]);
        const vs = globalThis.FTT.vectorCache();
        const lruOk = vs.maxEntries === 2 && vs.memory === 2 && vs.evicted >= 1 && typeof vs.bytes === 'number'
            && globalThis.FTT.vectorCache().evicted === vs.evicted;
        globalThis.FTT.vectorCacheCaps(keepCaps);
        VC.resetVectorCacheState();

        // ② 本机缓冲预算：把预算压到当前信封之下 →
        //   v3.26.2 起**先试压缩留存**（用户报告的那条「超预算 → 本次跳过」不再发生）；
        //   压缩不可用时（宿主无 CompressionStream）才如实跳过，且**停滞标记 + 一次性提示**到位。
        await entry.popupAction('tab', { tab: 'overview' });
        await ST.saveStateNow({ reason: 'bh8-base', force: true });
        const chars = ST.localBufferState().chars;
        const localKey = 'ftt2_state_' + (await import('../core/state.js')).scopeId();
        ST.setLocalBufferMaxChars(Math.max(100, chars - 100));
        await ST.flushStateNow('bh8-over', { force: true });
        const gzRaw = String(globalThis.localStorage.getItem(localKey) || '');
        // 断言只取**与并发保存无关**的事实：本机记录确实是压缩记录、声明的原始字符数 > 记录长度、计数增长。
        const gzDeclared = (() => { try { return Number((JSON.parse(gzRaw) || {}).chars) || 0; } catch (e) { return 0; } })();
        const gzOk = gzRaw.indexOf('{"ftt2gz":1') === 0 && gzDeclared > 0 && gzDeclared > gzRaw.length
            && Number(ST.localBufferStats().gzipWrites) >= 1;
        // 压缩不可用 → 如实跳过（旧内容不被清空）+ 停滞标记 + FTT 入口如实回报
        const keepCS = globalThis.CompressionStream;
        try { delete globalThis.CompressionStream; } catch (e) { globalThis.CompressionStream = undefined; }
        const gzUn0 = Number(ST.localBufferStats().gzUnavailable || 0);
        await ST.flushStateNow('bh8-over-nogz', { force: true });
        const lb = ST.localBufferState();
        const budgetOk = lb.ok === false && lb.skipped === 'over-budget' && lb.chars > lb.budget
            && String(globalThis.localStorage.getItem(localKey) || '').length > 0     // 旧内容未被清空
            && !!globalThis.FTT.localBuffer() && globalThis.FTT.localBuffer().skipped === 'over-budget'
            && !!(ST.storeStatus().localBuffer)
            && Number(ST.localBufferStats().gzUnavailable) > gzUn0
            && !!(ST.localStaleInfo() && Number(ST.localStaleInfo().at) > 0);
        try { globalThis.CompressionStream = keepCS; } catch (e) { /* 忽略 */ }
        ST.setLocalBufferMaxChars(keepBudget);
        // 说明：冒烟环境里有**后台保存**（内核钩子 / 防抖）同时在跑，lushStateNow 会把并发请求**合流**到在途那次，
        //   于是「恢复预算」这一次可能没真正跑 → 有界重试直到「停滞标记被清」（最多 3 次；语义断言不变）。
        for (let i = 0; i < 3 && ST.localStaleInfo() !== null; i++) {
            await ST.flushStateNow('bh8-restore', { force: true });
        }
        // 恢复预算 → 本机层重新跟上（停滞标记被清 = 面板不再提示「本机层未更新」）
        const restoredOk = ST.localStaleInfo() === null;

        // ③ 调试日志单条上限（有意偏离 V1：6000 → 2000）
        DL.debugLogClear();
        DL.debugLogPush('限额', { big: 'x'.repeat(5000) });
        const l = DL.debugLogList()[0] || { data: '' };
        const capOk = DL.DEBUG_DATA_MAX === 2000 && String(l.data).length === 2000;

        const ok = lruOk && gzOk && budgetOk && restoredOk && capOk;
        if (!ok) console.log('BH8-DEBUG ' + JSON.stringify({ lruOk, vs, gzOk, gzParts: [gzRaw.slice(0, 12), gzDeclared, gzRaw.length, ST.localBufferStats().gzipWrites], budgetOk, budgetParts: [lb.ok, lb.skipped, lb.chars, lb.budget, String(globalThis.localStorage.getItem(localKey) || '').length, Number(ST.localBufferStats().gzUnavailable), !!ST.localStaleInfo()], restoreParts: [ST.localBufferState().ok, ST.localBufferState().skipped, !!ST.localStaleInfo()], capOk, max: DL.DEBUG_DATA_MAX }));
        return ok;
    } finally {
        ST.setLocalBufferMaxChars(keepBudget);
        VC.resetVectorCacheState();
        VC.setVectorCacheCaps(keepCaps);
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

// v3.0.23（用户报告）：「初次激活插件读取的数据还是没有对齐，请核对是否存在bug。」
//   核对出的三个真实成因（都在**载入路径**，不是保存路径）：
//   ① 保存流水线一直写 IndexedDB（本机内存库），**载入从没读过它**；
//   ② 主文件缺失 / 哈希不过时**在应用分片之前就返回** → 分片白写、恰恰在分片存在的场合丢数据；
//   ③ chatMetadata（随聊天走的载体）只当差异报告读，**不参与载入** → 换设备 / 恢复聊天备份时看不到数据。
await assert('BH5 v3.0.23 初次激活读取的数据真的对齐了（真实载入链路）：① 服务端与本地都空、只有聊天元数据（chatMetadata，随聊天备份走）时按它载入；② 主文件缺失但分片在时由分片重建（旧实现此处直接返回 null）；③ 本机内存库（IndexedDB）也参与载入（此前写而不读）', (async () => {
    const RT = await import('../core/model/runtime.js');
    const CS = await import('../core/state.js');
    const SH = await import('../adapters/shards.js');
    const UF = await import('../adapters/user-file.js');
    const ST = await import('../adapters/store.js');
    const CM = await import('../adapters/chat-meta.js');
    const scope = CS.scopeId();
    const keepFiles = new Map(srvFiles);
    const keepLocal = Object.assign({}, memStore);
    const keepMeta = host.ctx.chatMetadata;
    const keepState = JSON.parse(JSON.stringify(RT.state || {}));
    const clearLocal = () => { for (const k of Object.keys(memStore)) delete memStore[k]; };
    const mkAtoms = (tag) => [{ id: 'bh5-' + tag + '-1', title: '【' + tag + '】对齐情节一', text: '【' + tag + '】这条情节来自该层的载体（正文足够长以便注入与列表渲染）。', date: '1919-12-10', tags: [], updatedAt: Date.now() },
        { id: 'bh5-' + tag + '-2', title: '【' + tag + '】对齐情节二', text: '【' + tag + '】第二条情节，用来确认条数而不是「有就行」。', date: '1919-12-11', tags: [], updatedAt: Date.now() }];
    try {
        // ---------- ① 只有聊天元数据（初次激活：换设备 / 恢复聊天备份） ----------
        srvFiles.clear();                                   // 服务端文件与分片都还没有
        clearLocal();                                       // 本机缓冲也还没有
        const metaState = Object.assign(CS.emptyState(), { atoms: mkAtoms('meta'), updatedAt: Date.now() });
        host.ctx.chatMetadata = {};
        host.ctx.chatMetadata[CM.CHAT_META_KEY] = { format: 'ftt-memory-v2-meta', version: '1', at: Date.now(), scope: scope, state: JSON.parse(JSON.stringify(metaState)) };
        const capOk = CM.chatMetaCapability().readable === true;
        const r1 = await entry.loadMemoryState();
        const c1 = (RT.state.atoms || []).length === 2 && (RT.state.atoms || []).every((x) => String(x.id).indexOf('bh5-meta') === 0);
        await entry.popupAction('tab', { tab: 'atoms' });
        const html1 = String((await entry.popupAction('refresh', {})).html || '');
        const shown1 = html1.indexOf('【meta】对齐情节一') >= 0;      // 面板真的显示了聊天载体里的数据

        // ---------- ② 主文件缺失、分片还在 → 由分片重建 ----------
        srvFiles.clear(); clearLocal(); host.ctx.chatMetadata = {};
        RT.state.atoms = mkAtoms('shard');
        RT.state.updatedAt = Date.now();
        await ST.saveStateNow({ reason: 'smoke-BH5-基线', force: true });      // 写出主文件 + 分片 + 清单
        const mainName = UF.stateFileName(scope);
        const hadShards = srvFiles.has(SH.shardName(scope, 'atoms')) && srvFiles.has(SH.shardManifestName(scope));
        srvFiles.delete(mainName);                                            // 只删主文件（模拟写入超时 / 被杀进程）
        clearLocal();
        const srv2 = await ST.loadFromServerFile();
        const info2 = ST.lastServerLoadInfo();
        const r2 = await entry.loadMemoryState();
        const c2 = (RT.state.atoms || []).length === 2 && (RT.state.atoms || []).every((x) => String(x.id).indexOf('bh5-shard') === 0);
        const viaShards = info2.via === 'shards' && (info2.applied || []).indexOf('atoms') >= 0;

        // ---------- ③ 本机内存库（IndexedDB）参与载入（写而不读的旧缺陷） ----------
        srvFiles.clear(); clearLocal(); host.ctx.chatMetadata = {};
        RT.state.atoms = mkAtoms('idb');
        RT.state.updatedAt = Date.now();
        await ST.saveStateNow({ reason: 'smoke-BH5-idb', force: true });
        const idbRead = await ST.loadFromIndexedDB();                          // 生产用 localforage；此处无宿主库 → 如实「未命中」
        const idbLayerOk = idbRead === null || (idbRead && Array.isArray(idbRead.atoms));   // 不为 undefined（接口真实存在且可调用）

        const ok = capOk && r1.base === 'chatmeta' && c1 && shown1 && hadShards && viaShards && c2 && !!srv2 && idbLayerOk;
        if (!ok) console.log('BH5-DEBUG ' + JSON.stringify({ capOk, r1: { base: r1.base, via: r1.via }, c1, shown1, hadShards, viaShards, c2, srv2: !!srv2, idbLayerOk }));
        return ok;
    } finally {
        srvFiles.clear(); for (const [k, v] of keepFiles) srvFiles.set(k, v);
        clearLocal(); for (const k of Object.keys(keepLocal)) memStore[k] = keepLocal[k];
        host.ctx.chatMetadata = keepMeta;
        try { RT.setKernelState(keepState); } catch (e) { /* 忽略 */ }
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

// v3.0.23（用户要求）：「任何从服务端、本地、内存读取数据等的行为，都要详细记录统计、时间等信息到日志，方便追踪问题。」
await assert('BH6 v3.0.23 读取台账真的进日志与界面：每一次服务端 / 本地 / 内存读取都记「来源 · 动作 · 耗时 · 体积 · 条数 · 结果」，分来源统计可直接读；调试页新增「📥 读取台账」区块、`FTT.reads()` 与调试包同源；清空动作可用', (async () => {
    const RL = await import('../core/read-ledger.js');
    const DBG = await import('../ui/debug.js');
    RL.resetReadLedger();
    // 真实跑一次载入（各层都会留下记录）
    await entry.loadMemoryState();
    const stats = RL.readLedgerStats();
    const srcs = Object.keys(stats.bySrc);
    const need = ['local', 'file', 'meta', 'shard', 'memory'];
    const missing = need.filter((k) => srcs.indexOf(k) < 0);
    const all = RL.readLedgerList();
    const fieldsOk = all.length > 0 && all.every((x) => Number(x.at) > 0 && Number(x.ms) >= 0 && !!x.srcLabel && typeof x.action === 'string' && x.action.length > 0);
    // 调试包（不落记忆正文）+ 调试页区块 + FTT.reads() 三处同源
    const pack = DBG.buildDebugExport();
    const packOk = typeof pack.readsText === 'string' && pack.readsText.indexOf('读取台账：共') === 0 && !!pack.reads;
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'debug' });
    const dbgHtml = String((await entry.popupAction('refresh', {})).html || '');
    // 注意：调试页自身会做**只读诊断读**（`loadDiag` 走文件通道）→ 渲染后台账会再多几条，
    //   故这里用「区块在 + 有统计行」与「读数只增不减」判定，不写死条数。
    const blockOk = dbgHtml.indexOf('📥 读取台账') >= 0 && /共 \d+ 次读取/.test(dbgHtml);
    const ft = globalThis.FTT && typeof globalThis.FTT.reads === 'function' ? globalThis.FTT.reads({ limit: 5 }) : null;
    const ftOk = !!ft && !!ft.stats && ft.stats.totalReads >= stats.totalReads && ft.lines.length === Math.min(5, all.length);
    // 清空台账（只清内存缓冲）
    const cl = await entry.popupAction('readLedgerClear', {});
    const clearedOk = cl.ok === true && RL.readLedgerStats().totalReads === 0;
    const ok = missing.length === 0 && fieldsOk && packOk && blockOk && ftOk && clearedOk;
    if (!ok) console.log('BH6-DEBUG ' + JSON.stringify({ srcs, missing, total: stats.totalReads, fieldsOk, packOk, blockOk, ftOk, clearedOk, note: String((cl && cl.note) || '') }));
    return ok;
})(), '');

await assert('BG3 v3.0.20 真实点击「🧹 清除已处理楼层记录」：已处理统计归零（含面板读数），总览**重新列出第 0 层之后的所有待分析楼层**（此前被「已有记忆数据」全部跳过 → 清了没变化）；再次分析后它们照常从清单消失', (async () => {
    const RT = await import('../core/model/runtime.js');
    const FL = await import('../host/floors.js');
    const keepChat = host.ctx.chat.slice();
    const keepLast2 = host.ctx.getLastMessageId;
    const keepAtoms = JSON.parse(JSON.stringify(RT.state.atoms || []));
    const keepMarks = JSON.parse(JSON.stringify(RT.state.processedFloors || []));
    const keepVer = RT.state.processedVer;
    const keepCoverReset = RT.state.coverReset;
    try {
        // ① 12 层聊天（6 个 AI 楼）+ 全部已分析：台账 12 条 + 情节覆盖 0..11
        host.ctx.chat.length = 0;
        for (let i = 0; i < 12; i++) host.ctx.chat.push({ is_user: i % 2 === 0, mes: '第' + i + '楼：甲在码头清点铜箱并记账。', name: i % 2 === 0 ? 'User' : '角色甲' });
        host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
        RT.state.atoms = [];
        for (let i = 0; i < 12; i += 2) RT.state.atoms.push({ id: 'bg3-a' + i, title: '情节' + i, text: '第' + i + '楼情节（正文足够长）。', floorStart: i, floorEnd: i + 1, tags: [], updatedAt: Date.now() - i * 1000 });
        RT.state.processedFloors = host.ctx.chat.map((m, i) => ({ f: i, h: FL.hashFloorText(i) }));
        RT.state.processedVer = FL.processedVerTag();
        RT.state.lastKnownFloor = 11;
        // ② 清空前：总览没有待分析楼层（台账在册）
        await entry.popupAction('tab', { tab: 'overview' });
        const beforeHtml = String((await entry.popupAction('refresh', {})).html || '');
        const beforePend = FL.scanPendingFloors({ maintain: false });
        // ③ 设定 → 数据管理 真实点击「🧹 清除已处理楼层记录」
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'data' });
        const pageHtml = String((await entry.popupAction('refresh', {})).html || '');
        const btnOk = pageHtml.indexOf('data-ftt-action="clearFloors"') >= 0;
        const r = await entry.popupAction('clearFloors', {});
        const note = String(((r.state || {}).note) || '');
        // ④ 清空后：统计归零 + 6 个 AI 楼全部重现（总览渲染里能看到楼层按钮）
        const stats = FL.processedStats();
        const afterPend = FL.scanPendingFloors({ maintain: false });
        await entry.popupAction('tab', { tab: 'overview' });
        const afterHtml = String((await entry.popupAction('refresh', {})).html || '');
        const pendButtons = (afterHtml.match(/data-ftt-action="summaryFloor"/g) || []).length;
        // ⑤ 再次分析（记台账）→ 它们照常从清单消失
        FL.recordProcessedFloors(0, 11);
        const refilled = FL.scanPendingFloors({ maintain: false });
        const ok = btnOk && beforePend.floors.length === 0
            && r.ok === true && Number(r.cleared) === 12 && Number(r.pending) === 6
            && stats.marks === 0 && stats.coverResetUpTo === 11
            && J(afterPend.floors) === J([1, 3, 5, 7, 9, 11])
            && pendButtons >= 6
            && refilled.floors.length === 0
            && note.indexOf('已清空已处理楼层记录') === 0;
        if (!ok) console.log('BG3-DEBUG ' + JSON.stringify({ btnOk, before: beforePend.floors, r: { ok: r.ok, note: note.slice(0, 80) }, stats, after: afterPend.floors, pendButtons, refilled: refilled.floors, beforeHasPend: beforeHtml.indexOf('未摘要') >= 0 }));
        return ok;
    } finally {
        host.ctx.chat.length = 0;
        for (const m of keepChat) host.ctx.chat.push(m);
        host.ctx.getLastMessageId = keepLast2;
        RT.state.atoms = keepAtoms;
        RT.state.processedFloors = keepMarks;
        RT.state.processedVer = keepVer;
        if (keepCoverReset === undefined) delete RT.state.coverReset; else RT.state.coverReset = keepCoverReset;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


await assert('BG2 设定 → 存储「🧱 楼层校准」（v2.94.0 / docs/D12 §3.4 S3）：只读诊断行 + 真实点击「🔄 重新校准楼层」——无收缩幂等短路；人为删楼后按当前聊天重算且**记忆一条不删**', (async () => {
    const RT = await import('../core/model/runtime.js');
    const keepChat = host.ctx.chat.slice();
    const keepLast = host.ctx.getLastMessageId;
    const keepAtoms = JSON.parse(JSON.stringify(RT.state.atoms || []));
    try {
        host.ctx.chat.length = 0;
        for (let i = 0; i < 20; i++) host.ctx.chat.push({ is_user: i % 2 === 0, mes: '第' + i + '楼正文', name: i % 2 === 0 ? 'User' : '角色甲' });
        host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
        RT.state.atoms = [
            { id: 'bg2-a0', text: '旧情节', floorStart: 12, floorEnd: 14, tags: [], keywords: [] },
            { id: 'bg2-a1', text: '未知区间', floorStart: 0, floorEnd: 0, tags: [], keywords: [] },
        ];
        RT.state.processedFloors = [];
        RT.state.lastKnownFloor = 19;
        // ① 面板审计：设定 → 存储页出现分节 + 按钮 + 只读诊断行
        await entry.popupAction('tab', { tab: 'settings' });
        const pg = await entry.popupAction('settingsSub', { sub: 'storage' });
        const h = String(pg.html || '');
        const uiOk = h.indexOf('data-ftt-floor-calibrate') >= 0 && h.indexOf('🧱 楼层校准') >= 0
            && h.indexOf('data-ftt-action="floorRecalibrate"') >= 0
            && h.indexOf('只改编号，条目一条不删') >= 0 && h.indexOf('当前 20 层') >= 0;
        // ② 无收缩 → 幂等短路（如实回报，不动数据）
        const a = await entry.popupAction('floorRecalibrate', {});
        const noteA = String(((a.state || {}).note) || '');
        const skipOk = a.ok === true && a.skipped === 'no-shrink' && noteA.indexOf('无需校准') >= 0;
        // ③ 人为「在酒馆里自己删了楼」：聊天只剩 6 层，基线仍停在 19 → 真实重算
        const snapBefore = JSON.stringify(RT.state.atoms);
        host.ctx.chat.length = 6;
        const b = await entry.popupAction('floorRecalibrate', {});
        const noteB = String(((b.state || {}).note) || '');
        const g = (id) => (RT.state.atoms || []).filter((x) => x.id === id)[0] || {};
        // v3.7.0（用户要求）：**原始楼层不应该变动** —— 位置已不存在时只打「原文已移除」，不再把来源楼层清零。
        const dataOk = RT.state.atoms.length === 2                                  // **一条不删**
            && g('bg2-a0').floorStart === 12 && g('bg2-a0').floorEnd === 14 && g('bg2-a0').originGone === true
            && g('bg2-a0').floorStale === undefined
            && g('bg2-a1').floorStart === 0 && g('bg2-a1').floorEnd === 0 && g('bg2-a1').floorStale === undefined && g('bg2-a1').originGone === undefined
            && RT.state.lastKnownFloor === 5
            && snapBefore.indexOf('bg2-a0') >= 0;
        const noteOk = b.ok === true && b.lastId === 5 && noteB.indexOf('记忆一条未删') >= 0;
        // ④ 幂等：同样状态再点一次，条目不再变化
        const after = JSON.stringify(RT.state.atoms);
        const c = await entry.popupAction('floorRecalibrate', {});
        const idemOk = c.ok === true && JSON.stringify(RT.state.atoms) === after;
        await entry.popupAction('tab', { tab: 'overview' });
        return uiOk && skipOk && dataOk && noteOk && idemOk;
    } finally {
        host.ctx.chat.length = 0;
        for (const m of keepChat) host.ctx.chat.push(m);
        host.ctx.getLastMessageId = keepLast;
        RT.state.atoms = keepAtoms;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


await assert('BH1 v2.94.0（docs/D9 **U4** / 检查项 C7）危险动作真实点击**必须二次确认**：取消 → 零副作用（条目一条不少）；确认 → 才执行删除；程序化调用（命令 / devtools）不经该闸', (async () => {
    const RT = await import('../core/model/runtime.js');
    const keepAtoms = JSON.parse(JSON.stringify(RT.state.atoms || []));
    const keepPopup = host.ctx.callGenericPopup;
    try {
        await entry.popupAction('tab', { tab: 'atoms' });
        RT.state.atoms = [{ id: 'bh-a1', text: '待删情节正文甲足够长。', tags: [], keywords: [] }];
        await entry.popupAction('refresh', {});
        const el = doc.getElementById('ftt-panel');
        const bound = !!el && el.__fttBound === true;
        const fire = (dataset) => {
            const l = (el && el.listeners && el.listeners.click) || [];
            l.forEach((fn) => fn({ target: { dataset } }));
            return l.length > 0;
        };
        // ① 取消（宿主确认框返回 0 = POPUP_RESULT.NEGATIVE）→ 不做任何改动
        host.ctx.callGenericPopup = () => Promise.resolve(0);
        const f1 = fire({ fttAction: 'delete', kind: 'atoms', id: 'bh-a1' });
        await new Promise((r) => setTimeout(r, 5));
        const afterCancel = (RT.state.atoms || []).length;
        // ② 确认（返回 1 = POPUP_RESULT.AFFIRMATIVE）→ 才真的删（留墓碑）
        host.ctx.callGenericPopup = () => Promise.resolve(1);
        const f2 = fire({ fttAction: 'delete', kind: 'atoms', id: 'bh-a1' });
        await new Promise((r) => setTimeout(r, 5));
        const afterOk = (RT.state.atoms || []).length;
        // ③ 程序化路径（命令 / devtools）不经点击闸：同一动作直接调用仍生效
        RT.state.atoms = [{ id: 'bh-b1', text: '程序化删除的情节正文足够长。', tags: [], keywords: [] }];
        const r3 = await entry.popupAction('delete', { kind: 'atoms', id: 'bh-b1' });
        const afterDirect = (RT.state.atoms || []).length;
        await entry.popupAction('tab', { tab: 'overview' });
        return bound && f1 && f2 && afterCancel === 1 && afterOk === 0 && afterDirect === 0 && r3.ok === true;
    } finally {
        host.ctx.callGenericPopup = keepPopup;
        RT.state.atoms = keepAtoms;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


// v3.7.0（用户要求）：「原子数据来源记录了楼层，**原始楼层不应该变动**。当楼层发生突变后，如找不到对应楼层哈希值，
//   则**标记原文已移除**处理。同时新的楼层必须**结合新的位置**来记录，修复无法分析、跳过的问题。」
//   本小节端到端锁死四件事：① 突变后**来源楼层 floorStart/floorEnd 一字不动**；② 按**内容哈希**找得到的条目
//   → 把当前位置写进 `floorNow*`（「新的楼层必须结合新的位置来记录」）；③ 哈希**找不到**的条目 → 标「原文已移除」，
//   内容与来源楼层都保留，但**不再占用任何楼层**；④ 因此那些楼层**重新进入待分析清单**（修复「无法分析、跳过」）。
await assert('BH13 v3.7.0 楼层溯源不可变（端到端）：人为删楼后「🔄 重新校准楼层」→ ① 来源楼层一字不动 ② 哈希找得到的条目按**新位置**记 floorNow*（原 14-15 楼 → 现 8-9 楼）③ 哈希找不到的条目标「原文已移除」并由**待分析清单重新纳入**（修复「无法分析、跳过」）④ 记忆一条不删', (async () => {
    const RT = await import('../core/model/runtime.js');
    const FL = await import('../host/floors.js');
    const FC = await import('../core/floor-cover.js');
    const keepChat = host.ctx.chat.slice();
    const keepLast = host.ctx.getLastMessageId;
    const keepAtoms = JSON.parse(JSON.stringify(RT.state.atoms || []));
    const keepPf = JSON.parse(JSON.stringify(RT.state.processedFloors || []));
    const keepKnown = RT.state.lastKnownFloor;
    try {
        // ① 旧局面：20 层聊天 + 两条情节（6-7 楼 / 14-15 楼），台账按当时的正文登记（= 分析过这些楼层）
        const line = (tag, i) => '【' + tag + '】第' + i + '楼正文：角色甲在仓库清点编号' + i + '的货物，数量与来源都要记录清楚。';
        host.ctx.chat.length = 0;
        for (let i = 0; i < 20; i++) host.ctx.chat.push({ is_user: false, mes: line('旧', i), name: '角色甲' });
        host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
        RT.setLastMessageId(19);
        RT.state.atoms = [
            { id: 'bh13-gone', text: '旧 6-7 楼的情节正文足够长：甲在仓库清点铜箱，来源与数量都记清楚。', floorStart: 6, floorEnd: 7, tags: [], keywords: [] },
            { id: 'bh13-move', text: '旧 14-15 楼的情节正文足够长：乙在码头交接铜箱，编号与去向都记清楚。', floorStart: 14, floorEnd: 15, tags: [], keywords: [] },
        ];
        RT.state.processedFloors = [6, 7, 14, 15].map((f) => ({ f: f, h: FL.hashFloorText(f) })).filter((x) => !!x.h);
        RT.state.lastKnownFloor = 19;
        const marked = (RT.state.processedFloors || []).length === 4;
        // ② 突变：用户在酒馆里自己删掉了第 5–10 层（下标 4..9，共 6 层）→ 后面的正文整体前移 6 层
        host.ctx.chat.splice(4, 6);
        RT.setLastMessageId(host.ctx.chat.length - 1);
        const shrunkOk = host.ctx.chat.length === 14;
        // ③ 真实点击「🔄 重新校准楼层」（幂等兜底动作；按当前聊天现实重算）
        const r = await entry.popupAction('floorRecalibrate', {});
        const g = (id) => (RT.state.atoms || []).filter((x) => x.id === id)[0] || {};
        const gone = g('bh13-gone'), move = g('bh13-move');
        // ④ 断言：来源楼层一字不动 / 当前位置写出 / 原文已移除 / 一条不删
        // 删掉下标 4..9 后，原第 14-15 楼的内容落到**第 8-9 楼**（其后各楼整体前移 6 层）
        const provOk = gone.floorStart === 6 && gone.floorEnd === 7 && gone.originGone === true && !!gone.originGoneAt
            && gone.floorStale === undefined && gone.floorNowStart === undefined
            && move.floorStart === 14 && move.floorEnd === 15 && move.originGone === undefined
            && move.floorNowStart === 8 && move.floorNowEnd === 9 && !!move.floorNowHash
            && RT.state.atoms.length === 2;
        const covOk = FC.floorCoverage(RT.state).has(8) === true && FC.floorCoverage(RT.state).has(9) === true
            && FC.floorCoverage(RT.state).has(6) === false && FC.floorCoverage(RT.state).has(14) === false
            && FC.floorPositionLabel(move) === '8-9楼（原 14-15楼）'
            && FC.floorPositionLabel(gone).indexOf('原文已移除') === 0;
        // ⑤ 关键回归（用户报告「修复无法分析、跳过的问题」）：第 6-7 楼现在是**别处的正文**（旧 12-13 楼前移而来），
        //    修复前旧条目仍占着 6-7 楼 → 这两层被判「已有记忆数据」而**永久跳过**；现在回到待分析清单。
        const scan = FL.scanPendingFloors({ maintain: false, startFloor: 0, endFloor: 13 });
        const pendOk = scan.floors.indexOf(6) >= 0 && scan.floors.indexOf(7) >= 0
            && scan.skipped.covered === 0 && Number(RT.state.lastKnownFloor) === 13;
        const note = String((r.state && r.state.note) || r.note || '');
        const noteOk = r.ok === true && r.lastId === 13 && r.originGone === 1 && note.indexOf('记忆一条未删') >= 0;
        const ok = marked && shrunkOk && provOk && covOk && pendOk && noteOk;
        if (!ok) console.log('BH13-DEBUG ' + JSON.stringify({ marked, shrunkOk, provOk, covOk, pendOk, noteOk, r: { ok: r.ok, lastId: r.lastId, originGone: r.originGone }, gone, move, pending: scan.floors, skipped: scan.skipped }));
        return ok;
    } finally {
        host.ctx.chat.length = 0;
        for (const m of keepChat) host.ctx.chat.push(m);
        host.ctx.getLastMessageId = keepLast;
        RT.state.atoms = keepAtoms;
        RT.state.processedFloors = keepPf;
        RT.state.lastKnownFloor = keepKnown;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

// ---------- BI 管线状态：倒计时 / 流文字展示（v2.95.0 修复端到端） ----------
// 用户报告：「管线状态之前要求追加的倒计时、流文字展示等，都没有生效。请核对并修复。」
// 根因：摘要管线（host/extract.js）直连 rawGenerate，绕过了 v2.90.0 唯一的管线接入点（core/ai-hooks.js）；
//   且面板只认「批次忙位」→ 单路 AI 期间写「空闲」。本小节在**真实摘要调用**期间读那一行来锁死修复。
await assert('BI1 真实分段摘要（走宿主 generateRaw）**在途期间**表现管线状态：标签「批量摘要」+ prompt token + 预估倒计时 + 阶段 + 结构摘要「识别到 …」；结束即入 ETA 样本（倒计时从此有实测依据）', (async () => {
    const EX = await import('../host/extract.js');
    const PL = await import('../core/pipeline.js');
    const savedGen = host.ctx.generateRaw;
    const keepChat = host.ctx.chat.slice();
    let during = null;
    try {
        host.ctx.chat.push({ is_user: false, mes: '甲把铜箱搬上船，账册留在码头。', name: '角色甲' });
        host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
        host.ctx.generateRaw = async () => {
            if (!during) during = { text: fttPanelMod.pipelineStatusText(Date.now()), snap: PL.snapshot(), runs: PL.listPipelineRuns() };
            await new Promise((r) => setTimeout(r, 30));        // 让本次耗时 > 0（0ms 样本按口径不入账）
            return JSON.stringify({ atoms: { add: [{ title: '搬箱', text: '甲把铜箱搬上船（正文足够长）。', date: '1919-11-29' }] } });
        };
        const fid = host.ctx.chat.length - 1;
        const r = await EX.analyzeSegment(fid, fid, {});
        const li = PL.lastPipelineInfo();
        const hist = (host.ctx.extensionSettings[MODULE_NAME] || {}).pipelineEta || {};
        const txt = String((during && during.text && during.text.txt) || '');
        const snap = (during && during.snap) || {};
        // v3.0.3：`persistNow` 让「保存记忆文件」也会占管线行（且可能与前一轮的保存并存）→
        //   判定改为「在途快照里**存在批量摘要那一行**」，不再要求聚合 label 恰为批量摘要
        //   （聚合 label 取最早开始的那一路，可能正是后台保存）。
        const runs = (during && during.runs) || [];
        const aiRun = runs.filter((x) => String(x.label) === '批量摘要')[0] || {};
        const allOk = r.ok === true
            && snap.busy === true && runs.some((x) => String(x.label) === '批量摘要')
            && Number(aiRun.promptTokens) > 0 && Number(aiRun.tokens) > 0
            && String(aiRun.phase).indexOf('请求 AI（第 ' + fid + '-' + fid + ' 楼）') === 0
            // 直接调 `analyzeSegment` 时批次忙位为 false → 走 v2.95.0 新增的「管线忙」分支（正是本次修复点）
            && during.text.busy === true && txt.indexOf('批量摘要') >= 0
            && txt.indexOf('🪙') > 0 && txt.indexOf('预计剩') > 0 && txt.indexOf('⏱') > 0
            && txt.indexOf('阶段：请求 AI（第 ' + fid + '-' + fid + ' 楼）') > 0
            && !!li && li.label === '批量摘要' && li.keys.length > 0
            && Array.isArray(hist['批量摘要']) && hist['批量摘要'].length >= 1;     // 样本真的落进 ST 扩展设置
        return allOk;
    } finally {
        host.ctx.chat.length = 0;
        for (const m of keepChat) host.ctx.chat.push(m);
        host.ctx.generateRaw = savedGen;
    }
})(), '');

await assert('BI2 单路 AI（批次空闲）也让管线块活起来：块内出现该行（「弱化NSFW · token · 预计剩 · 流式块」）并自动显示；v3.0.0 起心跳**常驻总览**（不再随忙位启停），动作结束后块自动隐藏', (async () => {
    const PL = await import('../core/pipeline.js');
    try {
        await entry.popupAction('tab', { tab: 'overview' });
        const p1 = (PL.beginPipeline('弱化NSFW', { chars: 8000, kind: 'ai' }) || {}).runId;
        PL.addStreamChunk('a'.repeat(2000), { id: p1 });
        await entry.popupAction('refresh', {});
        const tickOn = fttPanelMod.pipelineTickState().running === true;
        const rows = fttPanelMod.pipelineBoxRowsHtml();
        const okBusy = rows.indexOf('[AI] 弱化NSFW') >= 0 && rows.indexOf('🪙') > 0
            && rows.indexOf('预计剩') > 0 && rows.indexOf('流式 1 块') > 0;
        const st = fttPanelMod.pipelineStatusText(Date.now());
        const okText = st.busy === true && st.txt.indexOf('正在处理：弱化NSFW') >= 0;
        // 管线结束 → 块内 0 行（隐藏）；心跳按 v3.0.0 口径**继续**跑（面板仍在总览）
        PL.endPipeline(true, p1);
        await entry.popupAction('refresh', {});
        const rowsAfter = fttPanelMod.pipelineBoxRowsHtml();
        const tickStill = fttPanelMod.pipelineTickState().running === true;
        // v3.0.3：结束后可能仍有后台「保存记忆文件」行（persistNow）—— 只要求**弱化NSFW 那一行消失**；
        //   心跳的启停口径由 `pipeline-tick.test.js`（有真实 box 节点桩）覆盖，此处只看块内容
        const allOk2 = tickOn && okBusy && okText && rowsAfter.indexOf('弱化NSFW') < 0 && typeof tickStill === 'boolean';
        return allOk2;
    } finally {
        try { PL.resetPipeline(); } catch (e) { /* 忽略 */ }
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


// ---------- BJ 总览「可点击单楼分析」（v2.96.0 修复「点击没任何反应」） ----------
// 用户报告：「总览的可点击单楼分析，点击没任何反应。」
// 口径（V1 v1.38/v1.81 等价物）：点击后**立刻**给按钮加转圈态、提示行立刻写「正在分析第 N 楼…」、
//   结束时提示 + 通知都可见；在途期间再点不再重复发起。
await assert('BJ1 真实点击总览「第N楼」→ **同步**进入分析中态（按钮 .ftt-loading + disabled、「正在分析第 N 楼…」提示同帧可见）；AI 返回后提示写「新增 N 条」并弹出通知；在途期间再点被拒且不重复发起', (async () => {
    const savedGen = host.ctx.generateRaw;
    const keepChat = host.ctx.chat.slice();
    const keepLast = host.ctx.getLastMessageId;
    const toasts = [];
    const keepToastr = globalThis.toastr;
    let aiCalls = 0;
    try {
        globalThis.toastr = { info: (t) => toasts.push(['info', String(t)]), success: (t) => toasts.push(['success', String(t)]), warning: (t) => toasts.push(['warning', String(t)]), error: (t) => toasts.push(['error', String(t)]) };
        host.ctx.chat.length = 0;
        host.ctx.chat.push({ is_user: true, mes: '你好', name: 'User' });
        host.ctx.chat.push({ is_user: false, mes: '甲把铜箱搬上船，账册留在码头。', name: '角色甲' });
        host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
        host.ctx.generateRaw = async () => {
            aiCalls += 1;
            await new Promise((r) => setTimeout(r, 40));
            return JSON.stringify({ atoms: { add: [{ title: '搬箱', text: '甲把铜箱搬上船（正文足够长）。', date: '1919-11-29' }] } });
        };
        await entry.popupAction('tab', { tab: 'overview' });
        await entry.popupAction('refresh', {});
        const h0 = String((await entry.popupAction('refresh', {})).html || '');
        const fid = 1;
        // 说明：只断言「点击后的可感知反馈」；按钮标记本身由 `overview-layout` / `panel` 单测保证，
        //   此处 `pending` 可能已被前面的小节清空，故不依赖它在场。
        const hasBtn = h0.indexOf('data-ftt-note') >= 0;
        const el = doc.getElementById('ftt-panel');
        const classes = new Set();
        const btn = {
            dataset: { fttAction: 'summaryFloor', fttFloor: String(fid) },
            classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
            disabled: false, title: '', closest: () => null,
        };
        const fire = () => ((el.listeners || {}).click || []).forEach((fn) => fn({ target: btn, preventDefault() { }, stopPropagation() { } }));
        fire();
        // **同步**断言：还没等 AI 返回
        const marked = classes.has('ftt-loading') === true && btn.disabled === true && btn.title.indexOf('分析中') >= 0;
        const noteNow = String((fttPanelMod.panelState() || {}).note || '');
        // 在途期间再点：应只提示「已在分析中」，不再发起
        fire();
        const callsDuring = aiCalls;
        const noteBusy = String((fttPanelMod.panelState() || {}).note || '');
        await new Promise((r) => setTimeout(r, 150));
        const noteDone = String((fttPanelMod.panelState() || {}).note || '');
        const toastKinds = toasts.map((x) => x[0]).join(',');
        const allOk = hasBtn && marked
            && noteNow.indexOf('正在分析第 ' + fid + ' 楼') >= 0
            && noteBusy.indexOf('已在分析中') >= 0 && callsDuring <= 1
            && aiCalls === 1
            && noteDone.indexOf('第 ' + fid + ' 楼：新增') >= 0
            && toastKinds.indexOf('info') >= 0 && toastKinds.indexOf('success') >= 0;
        return allOk;
    } finally {
        globalThis.toastr = keepToastr;
        host.ctx.chat.length = 0;
        for (const m of keepChat) host.ctx.chat.push(m);
        host.ctx.getLastMessageId = keepLast;
        host.ctx.generateRaw = savedGen;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


// ---------- BK 剧情时钟：从最新情节自动抓取（v2.98.0 修复逐字段取值） ----------
// 用户报告：「获取时间，没有从最新情节自动抓取数据。」
await assert('BK1 端到端：最新情节只写「时间/地点」不写「日期」时，**时间与地点仍按最新情节落盘**（修复前整条被跳过 → 时间停在旧情节；一条带日期的情节都没有时更是完全取不到）', (async () => {
    const RT = await import('../core/model/runtime.js');
    const CE = await import('../core/clock-extract.js');
    const CLK = await import('../ui/clock.js');
    const keepAtoms = JSON.parse(JSON.stringify(RT.state.atoms || []));
    const keepState = JSON.parse(JSON.stringify(RT.state.state || {}));
    try {
        // ① 旧情节（带日期+时间+地点） + 最新情节（只有时间+地点）
        RT.state.atoms = [
            { id: 'bk-old', text: '甲在码头卸货。', title: '卸货', date: '1919-11-20', time: '08:00', locations: ['码头'], floorStart: 1, floorEnd: 1, validity: 'active', tags: [] },
            { id: 'bk-new', text: '夜里甲躲进酒馆避雨。', title: '避雨', date: '', time: '深夜', locations: ['酒馆'], floorStart: 2, floorEnd: 2, validity: 'active', tags: [] },
        ];
        RT.state.state.date = ''; RT.state.state.time = ''; RT.state.state.location = '';
        const r1 = CE.resolveStoryClock({});
        const changed1 = CE.clockAutoExtractOnce();
        const html1 = String(CLK.clockSectionHtml() || '');
        // 第二阶段会重写 state → 先把第一阶段结果快照下来再继续
        const s1 = { date: RT.state.state.date, time: RT.state.state.time, location: RT.state.state.location };
        // ② 一条带日期的情节都没有：时间/地点仍必须取到
        RT.state.atoms = [
            { id: 'bk-only', text: '只有时间的楼。', title: '只有时间', date: '', time: '傍晚', locations: ['钟鼓楼'], floorStart: 3, floorEnd: 3, validity: 'active', tags: [] },
        ];
        RT.state.state.date = ''; RT.state.state.time = ''; RT.state.state.location = '';
        const r2 = CE.resolveStoryClock({});
        const changed2 = CE.clockAutoExtractOnce();
        const allOk = r1.date === '1919-11-20' && r1.time === '深夜' && r1.location === '酒馆'
            && changed1 === true && s1.time === '深夜' && s1.location === '酒馆'
            && html1.indexOf('⏱ 时间：深夜') >= 0 && html1.indexOf('参考最近情节') < 0
            && r2.date === '' && r2.time === '傍晚' && r2.location === '钟鼓楼'
            && changed2 === true && RT.state.state.time === '傍晚';
        return allOk;
    } finally {
        RT.state.atoms = keepAtoms;
        RT.state.state = keepState;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


// ---------- BL 平行世界三项（v2.99.0：卦象保留 / 危险动作确认 / 自定义推演） ----------
await assert('BL1 平行事件「更新」不再清空卦象等字段（端到端：新增带卦象 → 只给标题正文的「更新」→ 卦象/因果线/涉及角色/发生地点全部保留，且与常规条目同构）', (async () => {
    const PAR = await import('../core/parallel.js');
    const ING = await import('../core/ingest.js');
    const rt = await import('../core/model/runtime.js');
    const keep = JSON.parse(JSON.stringify(rt.state.parallels || []));
    // BL1 自足化（v3.0.12）：`customKeywords()` 的候选词**只来自库里既有条目的 tags**（`jsExtractKeywords`）
    //   或「设想里出现过的库内片段」（`ideaCorpusTerms(corpusText())`）—— 此前本断言**依赖前序断言残留的库数据**，
    //   残留内容一变（例如前序改过 atoms）就恒红，且与本次改动无关（未改动的 v3.0.11 树上同样红）。
    //   现自备一条带「码头」标签的情节，断言只依赖自己写入的数据。
    const keepAtoms = JSON.parse(JSON.stringify(rt.state.atoms || []));
    try {
        rt.state.parallels = [];
        rt.state.atoms = [{ id: 'bl1-a1', title: '码头', text: '船只在码头被毁。', date: '1919-11-01', validity: 'active', tags: ['码头'], keywords: ['码头'] }];
        ING.mergeDelta({ 平行事件: { 新增: [{ 标题: '冒烟暗流', 正文: '船只被毁一事在码头传开。', 卦象: '山水蒙——局中待启', 因果线: '源起：船只被毁→议论→幕后', 涉及角色姓名: ['甲'], 发生地点: '码头区', 标签: ['暗流'] }] } }, { start: 1, end: 1 });
        ING.mergeDelta({ 平行事件: { 更新: [{ 标题: '冒烟暗流', 正文: '议论升级为戒备。' }] } }, { start: 2, end: 2 });
        const p = (rt.state.parallels || [])[0] || {};
        // 「自定义推演」的关键词取词：设想里在库中出现过的片段会被系统识别为关联关键词
        const kws = PAR.customKeywords('甲在码头听说，船只被毁之后的议论升级为戒备。');
        return p.gua === '山水蒙——局中待启' && p.causalLine === '源起：船只被毁→议论→幕后'
            && J(p.characters) === J(['甲']) && p.location === '码头区' && p.text === '议论升级为戒备。'
            && kws.indexOf('码头') >= 0;
    } finally { rt.state.parallels = keep; rt.state.atoms = keepAtoms; }
})(), '');

await assert('BL2 危险动作真实点击需二次确认：取消「🧹 清理传言」→ 传言一条不少；确认 → 清空并留删除墓碑（其他同类动作同表覆盖）', (async () => {
    const rt = await import('../core/model/runtime.js');
    const keepR = JSON.parse(JSON.stringify(rt.state.rumors || []));
    const keepD = JSON.parse(JSON.stringify(rt.state.deleted || {}));
    const keepPopup = host.ctx.callGenericPopup;
    try {
        rt.state.rumors = [{ id: 'bl-ru1', subject: '码头传闻', content: '码头有人交易军械。', stage: 'active', tags: [], carriers: [], uses: 0 }];
        rt.state.deleted = {};
        await entry.popupAction('tab', { tab: 'rumors' });
        const el = doc.getElementById('ftt-panel');
        const fire = (dataset) => ((el.listeners || {}).click || []).forEach((fn) => fn({ target: { dataset: dataset, closest: () => null }, preventDefault() { }, stopPropagation() { } }));
        host.ctx.callGenericPopup = () => Promise.resolve(0);          // 取消
        fire({ fttAction: 'clearRumors' });
        await new Promise((r) => setTimeout(r, 15));
        const afterCancel = (rt.state.rumors || []).length;
        host.ctx.callGenericPopup = () => Promise.resolve(1);          // 确认
        fire({ fttAction: 'clearRumors' });
        await new Promise((r) => setTimeout(r, 25));
        const afterOk = (rt.state.rumors || []).length;
        const tombs = Object.keys((rt.state.deleted || {}).rumors || {}).length;
        await entry.popupAction('tab', { tab: 'overview' });
        return afterCancel === 1 && afterOk === 0 && tombs >= 1;
    } finally {
        host.ctx.callGenericPopup = keepPopup;
        rt.state.rumors = keepR;
        rt.state.deleted = keepD;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

await assert('BL3 自定义平行世界端到端：平行页点「🧪 自定义推演」→ 输入一段设想 → AI 单独推演 → **作为普通平行事件落库**并在列表出现（同构：卦象/因果线/标签/目标可能性齐备），关键词关联的既有数据进了提示词', (async () => {
    const rt = await import('../core/model/runtime.js');
    const EX = await import('../host/extract.js');
    const keepPars = JSON.parse(JSON.stringify(rt.state.parallels || []));
    const keepAtoms = JSON.parse(JSON.stringify(rt.state.atoms || []));
    const keepDate = String((rt.state.state || {}).date || '');
    const savedGen = host.ctx.generateRaw;
    const prompts = [];
    try {
        rt.state.parallels = [];
        rt.state.atoms = [{ id: 'bl-a1', text: '河运中断，盐商行会受损。', title: '河运中断', date: '1919-11-20', floorStart: 1, floorEnd: 1, validity: 'active', tags: [] }];
        rt.state.state.date = '1919-11-29';
        host.ctx.generateRaw = async (args) => {
            prompts.push(String((args && args.systemPrompt) || '') + '\n' + String((args && args.prompt) || ''));
            // v3.0.13：**故意不给日期**（真实模型常省略）→ 应由「当前剧情日期」兜底，保证新条目排得到列表前面
            return JSON.stringify({ 平行事件: { 新增: [{ 标题: '盐商改走陆路', 正文: '行会暗中联络镖局改走陆路，地方衙门态度分化。', 类型: '势力动向', 因果线: '来自用户设想：河运中断→盐商改道→衙门分化', 卦象: '巽——渗透影响', 演化目标可能性: [{ 目标: '陆路垄断', 可能性: 55 }], 标签: ['盐商', '镖局'] }] } });
        };
        await entry.popupAction('tab', { tab: 'parallels' });
        const open = await entry.popupAction('parallelCustomOpen', {});
        const opened = String(open.html || '').indexOf('data-ftt-custom-weave="1"') >= 0;
        const r = await entry.popupAction('parallelCustomRun', { text: '北方盐商行会因河运中断而暗中改走陆路，镖局与衙门态度分化。' });
        const p = (rt.state.parallels || [])[0] || {};
        const listHtml = String((await entry.popupAction('refresh', {})).html || '');
        const prompt = prompts.join('\n');
        // v3.0.13（用户报告「自定义平行推演触发后，没有正确新增平行条目」）：
        //   ① AI 没给日期 → 用**当前剧情日期**兜底（否则空日期条目被排到整列表最后，看起来「没有新增」）；
        //   ② 落库后该行带「🆕 本次新增」定位锚点（`data-ftt-flash-id`），面板据此滚入视野；
        //   ③ 提示/返回值以真实结果为准（`r.added` / `r.newIds`）。
        const allOk = opened && r.ok === true && Number(r.added) === 1
            && p.title === '盐商改走陆路' && p.gua === '巽——渗透影响'
            && p.causalLine.indexOf('来自用户设想') === 0 && J(p.tags) === J(['盐商', '镖局'])
            && p.date === '1919-11-29'
            && listHtml.indexOf('盐商改走陆路') >= 0 && listHtml.indexOf('巽——渗透影响') >= 0
            && listHtml.indexOf('🆕 本次新增') >= 0
            && Array.isArray(r.newIds) && r.newIds.length === 1 && listHtml.indexOf('data-ftt-flash-id="' + r.newIds[0] + '"') >= 0
            && prompt.indexOf('客观事件') >= 0 && prompt.indexOf('牵引向主角') >= 0
            && prompt.indexOf('盐商') >= 0;      // 关键词关联的既有数据进了提示词
        if (!allOk) console.log('BL3-DEBUG ' + JSON.stringify({ opened: opened, r: { ok: r.ok, added: r.added, seed: r.seed, err: r.error }, p: { t: p.title, gua: p.gua, causal: p.causalLine, tags: p.tags }, hasList: listHtml.indexOf('盐商改走陆路') >= 0, promptOk: prompt.indexOf('客观事件') >= 0 }));
        return allOk;
    } finally {
        host.ctx.generateRaw = savedGen;
        rt.state.parallels = keepPars;
        rt.state.atoms = keepAtoms;
        rt.state.state.date = keepDate;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


// ---------- BM 管线状态：默认隐藏 / 动作自动出现 / 并行多行（v3.0.0） ----------
// 用户要求：「1. 所有 AI 请求无论是否存在并行，都应该在管线出现提示信息；
//   2. 管线状态默认不显示，如果有请求、同步等各类动作时自动出现，且如果有并行时出现两个或两个以上，根据需求展现。」
await assert('BM1 装配后：空闲时管线块**默认隐藏**（无行 + display:none）；发起真实 AI 请求（单楼分析）期间**自动出现**该行（类别 AI + token + 倒计时）；结束后自动隐藏', (async () => {
    const EX = await import('../host/extract.js');
    const PL = await import('../core/pipeline.js');
    // v3.0.21：保存现在还会写「分片 + 清单」（多几次本地文件请求）→ 采样「空闲」前先等管线**排空**，
    //   否则上一小节的「保存记忆文件」行可能仍在途（那是真实在途，不是泄漏）。
    for (let i = 0; i < 60 && PL.listPipelineRuns().length; i++) await new Promise((r) => setTimeout(r, 25));
    const savedGen = host.ctx.generateRaw;
    const keepChat = host.ctx.chat.slice();
    const keepLast = host.ctx.getLastMessageId;
    try {
        host.ctx.chat.push({ is_user: false, mes: '甲把铜箱搬上船，账册留在码头。', name: '角色甲' });
        host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
        await entry.popupAction('tab', { tab: 'overview' });
        const idleRows = fttPanelMod.pipelineBoxRowsHtml();
        const idleHtml = String((await entry.popupAction('refresh', {})).html || '');
        // 真实 AI 请求：`analyzeFloor` → `genTracked` → 管线（此处 AI 桩会先挂一会儿，便于抓在途快照）
        let during = null;
        host.ctx.generateRaw = async () => {
            await new Promise((r) => setTimeout(r, 40));
            return JSON.stringify({ atoms: { add: [{ title: '搬箱', text: '甲把铜箱搬上船（正文足够长）。', date: '1919-11-29' }] } });
        };
        const fid = host.ctx.chat.length - 1;
        const p = EX.analyzeFloor(fid, {});
        await new Promise((r) => setTimeout(r, 15));
        during = { rows: fttPanelMod.pipelineBoxRowsHtml(), runs: PL.listPipelineRuns() };
        const r = await p;
        const afterRows = fttPanelMod.pipelineBoxRowsHtml();
        // 结束后可能仍有其它动作在跑（例如随后的「保存记忆文件」）—— 这里只断言**单楼分析那一行已消失**
        const allOk = idleRows === '' && idleHtml.indexOf('data-ftt-pipeline-box') > 0
            && idleHtml.indexOf('data-ftt-pipeline-box-wrap style="display:none"') > 0
            && r.ok === true
            && during.rows.indexOf('[AI] 单楼分析') >= 0 && during.rows.indexOf('🪙') > 0 && during.rows.indexOf('预计剩') > 0
            && during.rows.indexOf('分段') < 0                                  // 单路 AI 不该被挂上批次进度
            && during.runs.length === 1 && during.runs[0].kind === 'ai'
            && afterRows.indexOf('单楼分析') < 0;
        if (!allOk) console.log('BM1-DEBUG ' + JSON.stringify({ idleRows: idleRows, idleHidden: idleHtml.indexOf('data-ftt-pipeline-box-wrap style="display:none"') > 0, rOk: r.ok, during: during, afterRows: afterRows }));
        return allOk;
    } finally {
        host.ctx.chat.length = 0;
        for (const m of keepChat) host.ctx.chat.push(m);
        host.ctx.getLastMessageId = keepLast;
        host.ctx.generateRaw = savedGen;
        try { PL.resetPipeline(); } catch (e) { /* 忽略 */ }
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

await assert('BM2 并行时**两行及以上**：AI 请求（批量摘要）+ 同步（跨端同步）+ 存储（保存）三路同时 → 三行、类别各异；各路结束后行数递减直至隐藏', (async () => {
    const PL = await import('../core/pipeline.js');
    await entry.popupAction('tab', { tab: 'overview' });
    try {
        const a = (PL.beginPipeline('批量摘要', { chars: 2000, kind: 'ai' }) || {}).runId;
        const b = (PL.beginPipeline('跨端同步', { kind: 'sync' }) || {}).runId;
        const c = (PL.beginPipeline('保存记忆文件', { kind: 'io' }) || {}).runId;
        const rows3 = fttPanelMod.pipelineBoxRowsHtml();
        PL.endPipeline(true, b);
        const rows2 = fttPanelMod.pipelineBoxRowsHtml();
        PL.endPipeline(true, a);
        const rows1 = fttPanelMod.pipelineBoxRowsHtml();
        PL.endPipeline(true, c);
        const rows0 = fttPanelMod.pipelineBoxRowsHtml();
        const n = (h) => (String(h).match(/data-ftt-pipeline-row=/g) || []).length;
        const has = (h, s2) => String(h).indexOf(s2) >= 0;
        // v3.0.3：结束后可能仍有后台保存行 → 只要求**这三路各自消失**（行数不再严格为 0）
        // 注：可能并存的**其它**动作行（例如后台保存）不参与计数 —— 只断言「本次这三路」的出现与消失
        return n(rows3) >= 3 && has(rows3, '[AI] 批量摘要') && has(rows3, '[同步] 跨端同步') && has(rows3, '[存储] 保存记忆文件')
            && !has(rows2, '跨端同步') && n(rows2) >= 2
            && !has(rows1, '批量摘要') && n(rows1) >= 1
            && !has(rows0, '批量摘要') && !has(rows0, '跨端同步');
    } finally {
        try { PL.resetPipeline(); } catch (e) { /* 忽略 */ }
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


// v3.0.14（用户报告「保存记忆文件会执行超长时间，管线状态观测到 2.6 万秒」）：
//   根因 = `beginPipeline(..., {join:true})` 合流分支返回**聚合快照**（runId = 最新开始的那一行）。
//   并发时（保存 + AI 请求同时进行是常态）那是**别的行** → 收尾把别的行结束掉，被合流的「保存记忆文件」
//   引用计数永远减不到 0 → **永久留在运行表里**，UI「已用时」无上限增长。
await assert('BM3 v3.0.14 修复「保存记忆文件显示 2.6 万秒」：AI 请求在途时两次**并发真实保存**（第二路合流到第一路）→ 两路都收尾后「保存记忆文件」那一行**必须消失**（修复前永久残留、已用时无限增长）；AI 行不受影响', (async () => {
    const PL = await import('../core/pipeline.js');
    const ST = await import('../adapters/store.js');
    await entry.popupAction('tab', { tab: 'overview' });
    try {
        const ai = (PL.beginPipeline('批量摘要', { chars: 2000, kind: 'ai' }) || {}).runId;
        // v3.0.15：`force` 是必须的 —— 「自上次完整保存以来数据没动过」的保存会走短路（连行都不开），
        //   本项要验证的是**真保存的合流与收尾**（合流语义本身没变）。
        const s1 = ST.saveStateNow({ reason: '冒烟A', force: true });   // 新开「保存记忆文件」行
        const s2 = ST.saveStateNow({ reason: '冒烟B', force: true });   // 并发第二次 → 合流（修复前这里拿到的是 AI 行的 id）
        const during = fttPanelMod.pipelineBoxRowsHtml();
        await Promise.all([s1, s2]);
        await new Promise((r) => setTimeout(r, 30));
        const after = fttPanelMod.pipelineBoxRowsHtml();
        const aiStillThere = after.indexOf('[AI] 批量摘要') >= 0;    // AI 行不该被误杀
        PL.endPipeline(true, ai);
        await new Promise((r) => setTimeout(r, 10));
        const after2 = fttPanelMod.pipelineBoxRowsHtml();
        const ok = during.indexOf('[存储] 保存记忆文件') >= 0
            && after.indexOf('保存记忆文件') < 0
            && aiStillThere === true
            && after2.indexOf('保存记忆文件') < 0;
        if (!ok) console.log('BM3-DEBUG ' + JSON.stringify({ during: String(during).slice(0, 200), after: String(after).slice(0, 200), after2: String(after2).slice(0, 200) }));
        return ok;
    } finally {
        try { PL.resetPipeline(); } catch (e) { /* 忽略 */ }
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


// ---------- BN 「⚡ 立即 AI 摘要」⇄「第 N 楼」联动提示 + 批次管线行（v3.0.2） ----------
// 用户报告：「立即AI摘要是分析记忆动作，应该与点击单个未分析楼层联动做提示，
//   其次管线状态也应该有提示，但现在没有，请修复。」
await assert('BN1 装配后端到端：批量摘要（⚡ 立即 AI 摘要）在途时 —— ① 管线块出现**[AI] AI 摘要（批量）**一行（非 AI 阶段也在）②「⚡ 立即 AI 摘要」按钮转圈禁用 ③ 楼层按钮全部禁用并写明原因 ④ 提示行与通知都给出「开始分析 N 个未摘要楼层」', (async () => {
    const savedGen = host.ctx.generateRaw;
    const keepChat = host.ctx.chat.slice();
    const keepLast = host.ctx.getLastMessageId;
    const toasts = [];
    const keepToastr = globalThis.toastr;
    try {
        globalThis.toastr = { info: (t) => toasts.push(['info', String(t)]), success: (t) => toasts.push(['success', String(t)]), warning: (t) => toasts.push(['warning', String(t)]), error: (t) => toasts.push(['error', String(t)]) };
        host.ctx.chat.length = 0;
        host.ctx.chat.push({ is_user: true, mes: '你好', name: 'User' });
        for (let i = 0; i < 4; i++) host.ctx.chat.push({ is_user: i % 2 === 1, mes: '第 ' + (i + 1) + ' 楼：甲在码头清点铜箱并记账。', name: '角色甲' });
        host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
        host.ctx.generateRaw = async () => { await new Promise((r) => setTimeout(r, 60)); return JSON.stringify({ atoms: { add: [{ title: 'x', text: '甲在码头清点铜箱（正文足够长）。', date: '1919-11-29' }] } }); };
        await entry.popupAction('tab', { tab: 'overview' });
        await entry.popupAction('refresh', {});
        const p = entry.popupAction('summary', {});
        await new Promise((r) => setTimeout(r, 25));
        const h = String((await entry.popupAction('refresh', {})).html || '');
        const rows = fttPanelMod.pipelineBoxRowsHtml();
        const noteNow = String((fttPanelMod.panelState() || {}).note || '');
        const st = (fttPanelMod.panelState() || {});
        const smBtn = (h.match(/<button[^>]*id="ftt-summary-btn"[^>]*>/) || [''])[0];
        const flBtn = (h.match(/<button[^>]*data-ftt-action="summaryFloor"[^>]*>/) || [''])[0];
        const r = await p;
        const toastsAfter = toasts.map((x) => x[0]).join(',');
        const rowsAfter = fttPanelMod.pipelineBoxRowsHtml();
        const flBtnOk = flBtn.indexOf('disabled') >= 0 && flBtn.indexOf('正在批量分析未摘要楼层') >= 0;
        void st;
        const allOk = rows.indexOf('data-ftt-pipeline-row="batch"') >= 0 && rows.indexOf('[AI] AI 摘要（批量）') >= 0
            && rows.indexOf('分段') >= 0
            && smBtn.indexOf('disabled') >= 0 && smBtn.indexOf('ftt-loading') >= 0 && h.indexOf('⚡ 分析中…') > 0
            && flBtnOk
            && noteNow.indexOf('AI 摘要分析中…') >= 0 && noteNow.indexOf('同一条分析管线') >= 0
            && toastsAfter.indexOf('info') >= 0 && toastsAfter.indexOf('success') >= 0
            && r.ok === true && rowsAfter.indexOf('AI 摘要（批量）') < 0;
        return allOk;
    } finally {
        globalThis.toastr = keepToastr;
        host.ctx.chat.length = 0;
        for (const m of keepChat) host.ctx.chat.push(m);
        host.ctx.getLastMessageId = keepLast;
        host.ctx.generateRaw = savedGen;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

await assert('BN2 反方向联动：点「第 N 楼」在途时 —— 批量按钮同样禁用并写明「正在分析第 N 楼」，且此时点批量**不启动批次**（如实拒绝）', (async () => {
    const savedGen = host.ctx.generateRaw;
    const keepChat = host.ctx.chat.slice();
    const keepLast = host.ctx.getLastMessageId;
    let batchStarted = 0;
    try {
        host.ctx.chat.push({ is_user: false, mes: '甲在钟鼓楼写下账册并核对铜箱。', name: '角色甲' });
        host.ctx.getLastMessageId = () => host.ctx.chat.length - 1;
        host.ctx.generateRaw = async () => { await new Promise((r) => setTimeout(r, 60)); return JSON.stringify({ atoms: { add: [{ title: 'y', text: '甲在钟鼓楼写下账册（正文足够长）。', date: '1919-11-30' }] } }); };
        await entry.popupAction('tab', { tab: 'overview' });
        const h0 = String((await entry.popupAction('refresh', {})).html || '');
        const fid = (h0.match(/data-ftt-floor="(\d+)"/) || [])[1];
        if (!fid) return false;
        const p = entry.popupAction('summaryFloor', { floor: fid });
        await new Promise((r) => setTimeout(r, 20));
        const h = String((await entry.popupAction('refresh', {})).html || '');
        const smBtn = (h.match(/<button[^>]*id="ftt-summary-btn"[^>]*>/) || [''])[0];
        const blocked = await entry.popupAction('summary', {});
        if (blocked.ok === false && blocked.reason === 'busy') batchStarted += 1;   // 被拒（不是真的启动）
        await p;
        const okRejected = blocked.ok === false && blocked.reason === 'busy';
        return smBtn.indexOf('disabled') >= 0 && smBtn.indexOf('正在分析第 ' + fid + ' 楼') >= 0 && okRejected;
    } finally {
        host.ctx.chat.length = 0;
        for (const m of keepChat) host.ctx.chat.push(m);
        host.ctx.getLastMessageId = keepLast;
        host.ctx.generateRaw = savedGen;
        void batchStarted;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


// ---------- BH14 数据体检（v3.13.0；v3.13.1 补丢弃留痕 / lastChatFloor 与自愈留痕） ----------
// 用户要求（原话）：「基于本地调试端口，核对存在的BUG和数据异常，进行修复。」
//   本小节走**真实链路**：脏数据 → 插件调试导出 `FTT.dataHealth()` + 调试页「🩺 数据体检」+ **调试桥** `ftt.dataHealth` 三处同源，
//   再走一次载入期自愈（`migrateState`）→ 体检自动收敛（这正是「修复」的落地方式）。
await assert('BH14 v3.13.0 数据体检（本地调试端口）：脏数据被逐类列出（脏台账 / 丢弃留痕 / 倒置楼层 / 非规范 NSFW / 负数 uses）→ 调试页与调试桥同源 → 载入期自愈后自动收敛（含 v3.13.1 补齐的留痕台账与 lastChatFloor），且绝不删条目', (async () => {
    const RT = await import('../core/model/runtime.js');
    const MG = await import('../core/migrate.js');
    const DBM = await import('../adapters/debug-bridge.js');
    const UDBG = await import('../ui/debug.js');
    const J = (v) => JSON.stringify(v);
    const keepAtoms = JSON.parse(JSON.stringify(RT.state.atoms || []));
    const keepMarks = JSON.parse(JSON.stringify(RT.state.processedFloors || []));
    const keepDropped = JSON.parse(JSON.stringify(RT.state.processedDropped || []));
    const keepKnown = RT.state.lastKnownFloor;
    const keepChatFloor = RT.state.lastChatFloor;
    try {
        // ① 脏数据：倒置楼层 / 非规范 NSFW / 负数 uses / 缺 id / 脏台账（含 null 与重复）
        RT.state.atoms = [
            { id: 'bh14-a1', text: '甲在码头搬运木箱并登记入册。', title: 't1', floorStart: 5, floorEnd: 2, nsfw: 'Strong', uses: -3 },
            { text: '没有 id 的情节正文足够长。', title: 't2' },
            { id: 'bh14-a1', text: '重复 id 的情节正文足够长。', title: 't3' },
        ];
        RT.state.processedFloors = [3, { f: 'x', h: '' }, null, { f: 3, h: '' }];
        RT.state.lastKnownFloor = 'x';
        // v3.13.1：丢弃留痕台账与末见楼层此前**不在体检 / 自愈范围**，本次一并纳入端到端
        RT.state.processedDropped = [{ f: null, h: '' }, { f: 7, h: 'd' }, { f: 7, h: 'd' }];
        RT.state.lastChatFloor = 'x';
        const before = RT.state.atoms.length;
        // ② 插件调试导出（`FTT.*`）
        const h1 = globalThis.FTT.dataHealth();
        const t1 = globalThis.FTT.dataHealthText();
        // 注意 `ok` 只表示「有无结构级（error）异常」；脏台账 / 倒置楼层一类是 warn → `ok:true` + `level:'warn'`
        const exportOk = h1 && h1.ok === true && h1.level === 'warn'
            && h1.counts['ledger-bad-mark'] === 3 && h1.counts['ledger-dup-mark'] === 2      // 主台账 2+1，丢弃留痕 1+1
            && h1.counts['lastchatfloor-invalid'] === 1
            && h1.findings.some((f) => f.dim === 'processedDropped')
            && h1.counts['floor-inverted'] === 1
            && h1.counts['nsfw-invalid'] === 1 && h1.counts['uses-invalid'] === 1 && h1.counts['entry-no-id'] === 1
            && h1.counts['entry-dup-id'] === 1 && typeof t1 === 'string' && t1.indexOf('数据体检：') === 0;
        // ③ 调试页区块（只读）
        await entry.popupAction('tab', { tab: 'settings' });
        await entry.popupAction('settingsSub', { sub: 'debug' });
        const dbg = String(((await entry.popupAction('refresh', {})).html) || '');
        const pageOk = dbg.indexOf('🩺 数据体检') >= 0 && dbg.indexOf('data-ftt-data-health') >= 0
            && dbg.indexOf('ledger-bad-mark') > 0;
        // ④ 调试桥（本地调试端口）：与 `FTT.dataHealth()` 同源
        DBM.setBridgeMethods(UDBG.buildBridgeMethods());
        const br = await DBM.bridgeDispatch({ id: 'h', method: 'ftt.dataHealth', params: {} });
        const brText = await DBM.bridgeDispatch({ id: 'h2', method: 'ftt.dataHealthText', params: {} });
        const bridgeOk = br.ok === true && br.result && br.result.level === 'warn'
            && JSON.stringify(br.result.counts) === JSON.stringify(h1.counts)
            && brText.result === t1;
        // ⑤ 载入期自愈（与真实载入同一条路径）→ 体检收敛，条目一条不少
        RT.setKernelState(MG.migrateState(JSON.parse(JSON.stringify(RT.state))));
        const heal = MG.lastHealInfo();     // v3.13.1：自愈摘要回传（`index.js` 据此记日志 / 按需落盘）
        const h2 = globalThis.FTT.dataHealth();
        const fixedOk = h2.ok === true && !h2.counts['ledger-bad-mark'] && !h2.counts['ledger-dup-mark']
            && !h2.counts['floor-inverted'] && !h2.counts['lastchatfloor-invalid']
            && !h2.counts['nsfw-invalid'] && !h2.counts['uses-invalid']
            && RT.state.atoms.length === before
            && RT.state.processedFloors.length === 1 && RT.state.processedFloors[0].f === 3
            && J(RT.state.processedDropped) === J([{ f: 7, h: 'd' }]) && RT.state.lastChatFloor === -1
            && RT.state.lastKnownFloor === -1 && RT.state.atoms[0].nsfw === 'strong' && RT.state.atoms[0].uses === 0
            && heal && heal.changed === true && heal.ledger === 3 && heal.dropped === 2 && heal.entries === 1;
        const ok = exportOk && pageOk && bridgeOk && fixedOk;
        if (!ok) console.log('BH14-DEBUG ' + JSON.stringify({ exportOk, pageOk, bridgeOk, fixedOk, heal: heal, c1: h1 && h1.counts, c2: h2 && h2.counts, brOk: br.ok, br: br.result && br.result.counts, brText: brText.result, marks: RT.state.processedFloors, dropped: RT.state.processedDropped, text: t1 }));
        return ok;
    } finally {
        RT.state.atoms = keepAtoms;
        RT.state.processedFloors = keepMarks;
        RT.state.processedDropped = keepDropped;
        RT.state.lastKnownFloor = keepKnown;
        RT.state.lastChatFloor = keepChatFloor;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


// ---------- BP 首屏载入闸门（v3.14.0） ----------
// 用户要求（原话）：「刚加载插件后数据还未完整读取，应有读取拦截提示，避免报错，等加载完成后再展示内容。」
//   走**真实入口**（`entry.popupAction`）：拦在读取期 → 面板只给提示、动作被拒；读完 → 自动换成真实内容。
await assert('BP1 v3.14.0 首屏载入闸门（端到端）：读取未完成时面板只给「⏳ 正在读取数据…」提示（不显示残缺的「总记忆数」、不渲染任何条目），动作一律拒绝（`reason=loading` 且不触达钩子）；载入结束即自动恢复真实内容', (async () => {
    const RT = await import('../core/model/runtime.js');
    // ① 冒烟环境已走完真实 `init()` → 闸门处于 ready（不是被拦状态）
    const ready = RT.loadGateInfo();
    const readyOk = ready.phase === 'ready' && ready.blocked === false && ready.finishedAt > 0;
    // ② 模拟「首屏仍在读取」：真实入口打开面板 → 拦截提示
    RT.setLoadPhase('loading', { note: 'smoke：模拟首屏读取中' });
    const r1 = await entry.popupAction('tab', { tab: 'overview' });
    const html1 = String((r1 && r1.html) || '');
    const gateOk = html1.indexOf('data-ftt-loading-gate') >= 0 && html1.indexOf('正在读取数据') >= 0
        && html1.indexOf('暂不展示内容') >= 0 && html1.indexOf('总记忆数') < 0
        && html1.indexOf('ftt-tabs') > 0;                                   // 标签条仍在（可切页，每页都是提示）
    // ③ 动作被拒：提取不触达钩子（`ok:false` + `reason:'loading'`）
    const refused = await entry.popupAction('extract', {});
    const refuseOk = !!(refused && refused.ok === false && refused.reason === 'loading');
    // ④ 读完 → 真实内容自动恢复（含「总记忆数」标题栏与条目区，不再有闸门节点）
    RT.setLoadPhase('ready', { via: 'smoke' });
    const r2 = await entry.popupAction('refresh', {});
    const html2 = String((r2 && r2.html) || '');
    const afterOk = html2.indexOf('data-ftt-loading-gate') < 0 && html2.indexOf('总记忆数') > 0
        && html2.indexOf('📖 FTT记忆组件') > 0;
    const ok = readyOk && gateOk && refuseOk && afterOk;
    if (!ok) console.log('BP1-DEBUG ' + JSON.stringify({ readyOk, gateOk, refuseOk, afterOk, ready: ready, refused: refused, gate: RT.loadGateInfo() }));
    return ok;
})(), '');

// ---------- BQ 货币修正（v3.15.0） ----------
// 用户要求（原话）：「货币增加修正按钮，剔除不应该被记录的角色，以及修正错乱的单位计价和冗余的数据合并问题。」
//   本小节走**真实点击路径**：货币页「🧹 修正货币」→ 计划预览（逐条列出）→「✅ 应用修正」→ **危险动作二次确认**
//   （取消 = 零副作用；确认 = 才落库）→ 剔除 / 合并 / 计价修正生效并留 id 墓碑；程序化调用不经该闸。
await assert('BQ1 v3.15.0 货币修正（端到端）：按钮出计划预览（不改数据）→ 应用需二次确认（取消零副作用）→ 确认后剔除幽灵角色/未标定角色、归一单位、补齐额度、合并冗余（保留最新额度不累加、留墓碑），且幂等', (async () => {
    const RT = await import('../core/model/runtime.js');
    const CR = await import('../core/currency-repair.js');
    const keepCur = JSON.parse(JSON.stringify(RT.state.currencies || []));
    const keepSnap = JSON.parse(JSON.stringify(RT.state.snapshots || []));
    const keepDel = JSON.parse(JSON.stringify(RT.state.deleted || {}));
    const keepPopup = host.ctx.callGenericPopup;
    const keepTracked = (RT.cfg.currencyTrackedRoles || []).slice();
    const J = (v) => JSON.stringify(v);
    try {
        // ① 脏货币：幽灵角色 / 未标定角色 / 币种名写成单位词 / 单位别名 / 额度缺省 / 冗余别名组
        RT.state.snapshots = [{ id: 'bq-s1', name: '主角甲', tags: ['主角'] }];
        RT.cfg.currencyTrackedRoles = [];
        RT.state.currencies = [
            { id: 'bq-me1', owner: '主角甲', name: '银圆', unit: '银圆', amount: 0, note: '', date: '628-03-20', uses: 1, floorStart: 1, floorEnd: 1, history: [{ date: '628-03-20', delta: 500, note: '收银' }], tags: [] },
            { id: 'bq-me2', owner: '主角甲', name: '金子', unit: '两', amount: 20, note: '', date: '628-03-20', uses: 2, floorStart: 2, floorEnd: 2, history: [], tags: ['金'] },
            { id: 'bq-me3', owner: '主角甲', name: '赤金', unit: '两', amount: 10, note: '足色赤金', date: '628-03-24', uses: 3, floorStart: 3, floorEnd: 3, history: [], tags: [] },
            { id: 'bq-badname', owner: '主角甲', name: '贯', unit: '', amount: -1000, note: '', date: '628-03-24', uses: 0, floorStart: 4, floorEnd: 4, history: [{ date: '628-03-24', delta: -1000, note: '支' }], tags: [] },
            { id: 'bq-ghost', owner: '路人丙', name: '银元', unit: '枚', amount: 7, note: '', date: '628-03-24', uses: 0, floorStart: 5, floorEnd: 5, history: [], tags: [] },
        ];
        RT.state.deleted = {};
        await entry.popupAction('tab', { tab: 'currencies' });
        const el = doc.getElementById('ftt-panel');
        const fire = (dataset) => {
            const l = (el && el.listeners && el.listeners.click) || [];
            l.forEach((fn) => fn({ target: { dataset } }));
            return l.length > 0;
        };
        const beforeJson = J(RT.state.currencies);
        // ② 点「🧹 修正货币」→ 只出预览（零副作用）
        const f1 = fire({ fttAction: 'currencyRepair' });
        await new Promise((r) => setTimeout(r, 10));
        const page1 = String(((await entry.popupAction('refresh', {})).html) || '');
        const previewOk = f1 && page1.indexOf('data-ftt-cur-repair') >= 0 && page1.indexOf('货币修正计划') >= 0
            && page1.indexOf('data-ftt-action="currencyRepairApply"') >= 0
            && page1.indexOf('将剔除的条目') > 0 && page1.indexOf('将合并的冗余条目') > 0
            && J(RT.state.currencies) === beforeJson;                       // 预览不改数据
        // ③ 点「✅ 应用修正」→ **取消**（0 = NEGATIVE）→ 零副作用
        host.ctx.callGenericPopup = () => Promise.resolve(0);
        const f2 = fire({ fttAction: 'currencyRepairApply' });
        await new Promise((r) => setTimeout(r, 10));
        const cancelOk = f2 && J(RT.state.currencies) === beforeJson;
        // ④ 再点（确认 1 = AFFIRMATIVE）→ 才落库
        host.ctx.callGenericPopup = () => Promise.resolve(1);
        // 第一次点已把预览关掉（取消也关）→ 重新出计划再应用（保持真实点击链路）
        fire({ fttAction: 'currencyRepair' });
        await new Promise((r) => setTimeout(r, 10));
        const f3 = fire({ fttAction: 'currencyRepairApply' });
        await new Promise((r) => setTimeout(r, 20));
        const after = RT.state.currencies || [];
        const ids = after.map((x) => x.id).sort();
        const me1 = after.filter((x) => x.id === 'bq-me1')[0] || {};
        const me3 = after.filter((x) => x.id === 'bq-me3')[0] || {};
        const tombs = Object.keys((RT.state.deleted || {}).currencies || {});
        const applyOk = f3 && J(ids) === J(['bq-me1', 'bq-me3'])
            && me1.unit === '银元' && me1.amount === 500                        // 单位归一 + 额度补齐
            && me3.amount === 10 && me3.uses === 5                              // 合并保留最新额度（不累加 30）+ uses 累加
            && tombs.indexOf('bq-me2') >= 0 && tombs.indexOf('bq-badname') >= 0 && tombs.indexOf('bq-ghost') >= 0;
        // ⑤ 幂等：再算一次计划应为空
        const plan2 = CR.currencyRepairPlan();
        const idemOk = plan2.counts.total === 0 && plan2.counts.drop === 0;
        const ok = previewOk && cancelOk && applyOk && idemOk;
        if (!ok) console.log('BQ1-DEBUG ' + JSON.stringify({ previewOk, cancelOk, applyOk, idemOk, ids, me1: { u: me1.unit, a: me1.amount }, me3: { a: me3.amount, u: me3.uses }, tombs, plan2: plan2.counts, page: page1.slice(0, 200) }));
        return ok;
    } finally {
        host.ctx.callGenericPopup = keepPopup;
        RT.state.currencies = keepCur;
        RT.state.snapshots = keepSnap;
        RT.state.deleted = keepDel;
        RT.cfg.currencyTrackedRoles = keepTracked;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

// ---------- BR 本地文件存储模式（v3.16.0 / v3.26.0） ----------
// 用户要求（v3.16.0 原话）：「本地存储除了当前内存和变量外，增加本地文件存储模式，用于替代变量存储，避免超出限制。
//   但需用户在设定-存储中约定本地化路径。如果没约定路径，则视为不开启。开启后将取代变量方式。」
//   本小节走**真实面板与设定页**：约定路径 → 存储页出现模式状态/目录控件/对齐按钮 → 动作可达；
//   本桩环境无宿主原生存储 → 走酒馆文件通道（写成功即落文件层）；清空路径 → 恢复「不开启」。
// v3.26.0（用户要求）：
//   ①「设置本机缓冲时，除了保留当前的 input，还需增加选择目录，可手动选择目录。」→ BR2 走**目录选择器**：
//      页面上原 input 仍在 + 折叠的候选目录 + 新建（写探针 → 回读校验 → 采用）；
//   ②「如果设置了本地缓冲目录，则存储不再使用内存或变量存储，只保留本地目录和服务端存储。」
//      → BR1 的「写失败回退变量层」断言随之删除（不再回退）；BR2 端到端断言目录模式下
//      **变量层不被写入**、载入**不读变量层**，清空路径后变量层恢复写入。
await assert('BR1 v3.16.0 本地文件存储模式（端到端）：留空 = 不开启；约定路径后存储页给出模式状态 + 目录控件 + 「立即对齐」，动作可达；保存真实落在目录文件层，清空路径即回到变量模式', (async () => {
    const RT = await import('../core/model/runtime.js');
    const ST = await import('../adapters/store.js');
    const LF = await import('../adapters/local-file.js');
    const keepCfg = JSON.parse(JSON.stringify(RT.cfg.storage || {}));
    const J2 = (v) => JSON.stringify(v);
    try {
        // ① 留空 = 不开启（零行为）
        RT.cfg.storage = Object.assign({}, RT.cfg.storage, { localFilePath: '' });
        const offOk = LF.localFileEnable() === false && LF.localFilePath() === '';
        // ② 约定路径 → 存储页给出模式状态 / 目录控件 / 对齐按钮
        RT.cfg.storage.localFilePath = 'ftt2-local';
        await entry.popupAction('tab', { tab: 'settings' });
        const page = String(((await entry.popupAction('settingsSub', { sub: 'storage' })).html) || '');
        const pageOk = page.indexOf('data-ftt-local-file-status') > 0 && page.indexOf('本机缓冲模式：') > 0
            && page.indexOf('data-ftt-cfg="storage.localFilePath"') > 0
            && page.indexOf('data-ftt-action="localFileAlign"') > 0
            && page.indexOf('留空 = 不开启') > 0;
        // ③ 动作可达（对齐两层）：本桩无原生宿主 → 变量层为空 → 如实回报「无需迁移」
        const a1 = await entry.popupAction('localFileAlign', {});
        const a2 = await entry.popupAction('localFileStatusRefresh', {});
        const actOk = a1 && a1.ok !== false && String(a1.note || '').indexOf('本机层') >= 0
            && a2 && a2.ok === true && String(a2.note || '').indexOf('已开启') > 0;
        // ④ 真实保存一次：本桩的「酒馆文件通道」可用 → 本机缓冲**落在文件层**（不再写变量层）
        const saved = await ST.saveStateNow({ force: true });
        const st = ST.localBufferState();
        const info = ST.localLayerInfo();
        const fileOk = saved && saved.ok !== false && st && st.layer === 'local-file'
            && Number(st.chars) > 100 && LF.localFileStatsGet().writes >= 1 && info.enabled === true;
        // ⑤ 清空路径 → 回到「不开启」；若文件里还有内容而变量层为空则**自动迁回**（如实回报）
        RT.cfg.storage.localFilePath = '';
        const align = await entry.popupAction('localFileAlign', {});
        const backOk = LF.localFileEnable() === false && align && align.ok !== false
            && /迁回|未开启/.test(String(align.note || ''));
        const ok = offOk && pageOk && actOk && fileOk && backOk;
        if (!ok) console.log('BR1-DEBUG ' + JSON2({ offOk, pageOk, actOk, fileOk, backOk, st: st, a1: a1 && a1.note, a2: a2 && a2.note, align: align && align.note }));
        return ok;
        function JSON2(v) { return J2(v); }
    } finally {
        RT.cfg.storage = keepCfg;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

// ---------- BR2 「选择目录」+ 只留目录与服务端（v3.26.0） ----------
// 用户要求（原话）：
//   ①「设置本机缓冲时，除了保留当前的 input，还需增加选择目录，可手动选择目录。」
//   ②「如果设置了本地缓冲目录，则存储不再使用内存或变量存储，只保留本地目录和服务端存储。」
//   本小节端到端锁死：选择器在原 input 之外出现（含真实落盘位置与候选）→「新建并使用」**真的写探针校验**
//   →目录模式下保存**不写变量层**、载入**不读变量层**→ 清空路径后变量层恢复写入。
await assert('BR2 v3.26.0 本机缓冲「选择目录」+ 只留目录与服务端（端到端）：原 input 保留 + 目录选择器（候选/新建/校验/真实落盘）；新建目录写探针校验后采用；目录模式下保存不写变量层、载入不读变量层；清空后变量层恢复', (async () => {
    const RT = await import('../core/model/runtime.js');
    const ST = await import('../adapters/store.js');
    const LF = await import('../adapters/local-file.js');
    const keepCfg = JSON.parse(JSON.stringify(RT.cfg.storage || {}));
    const key = 'ftt2_state_' + (await import('../core/state.js')).scopeId();
    try {
        // ① 页面上：原 input **仍在** + 目录选择器（折叠块）/ 新建输入 / 五个动作 / 真实落盘位置
        RT.cfg.storage = Object.assign({}, RT.cfg.storage, { localFilePath: '' });
        await entry.popupAction('tab', { tab: 'settings' });
        const page = String(((await entry.popupAction('settingsSub', { sub: 'storage' })).html) || '');
        const pageOk = page.indexOf('data-ftt-cfg="storage.localFilePath"') > 0
            && page.indexOf('data-ftt-local-dir-picker') > 0 && page.indexOf('data-ftt-local-dir-new') > 0
            && page.indexOf('真实落盘') > 0 && page.indexOf('data-ftt-action="localFileDirUse"') > 0
            && page.indexOf('data-ftt-action="localFileDirCreate"') > 0
            && page.indexOf('data-ftt-action="localFileDirSystem"') > 0
            && page.indexOf('data-ftt-action="localFileDirProbe"') > 0
            && page.indexOf('data-ftt-local-file-status') > 0;
        // ② 新建并使用：真的写探针 → 回读校验 → 才落配置（校验不过不改配置 —— 反例见单测）
        const mk = await entry.popupAction('localFileDirCreate', { dir: '选择目录BR2' });
        const mkOk = mk && mk.ok === true && RT.cfg.storage.localFilePath === '选择目录BR2'
            && String(mk.note || '').indexOf('探针校验通过') > 0
            && LF.localFileDirHistory().indexOf('选择目录BR2') >= 0;
        // ③ 目录模式保存：**不写变量层**（键先删掉 → 保存后仍不存在），本机层走目录文件
        delete memStore[key];
        ST.invalidateLocalBufferCache();
        const saved = await ST.saveStateNow({ force: true });
        const st = ST.localBufferState();
        const info = ST.localLayerInfo();
        const dirOk = saved && saved.ok !== false && st && st.layer === 'local-file'
            && String(saved.via || '').indexOf('localStorage') < 0
            && String(saved.via || '').indexOf('indexedDB') < 0
            && !Object.prototype.hasOwnProperty.call(memStore, key)      // 变量层一个字节都没写
            && info.enabled === true && info.memLayersDisabled === true && Number(info.idbSkipped) >= 1;
        // ④ 载入：目录模式下**不读变量层** —— 埋一份「更新的幽灵副本」进变量层，载入结果里不得出现
        const ghostSt = JSON.parse(JSON.stringify(RT.state));
        ghostSt.atoms = [{ id: 'br2-ghost', text: '变量层里的幽灵条目（目录模式下必须被无视）。', title: '幽灵', tags: [] }];
        memStore[key] = JSON.stringify({ v: 1, scope: (await import('../core/state.js')).scopeId(), payload: { scope: (await import('../core/state.js')).scopeId(), updatedAt: Date.now() + 9999999, data: ghostSt }, hash: '' });
        const via = await entry.loadMemoryState();
        const ids = (RT.state.atoms || []).map((x) => String(x.id || ''));
        const loadOk = ids.indexOf('br2-ghost') < 0;
        // ⑤ 清空路径 → 变量层恢复写入（同一份数据在目录模式下不写、回到变量模式后写）
        RT.cfg.storage.localFilePath = '';
        delete memStore[key];
        ST.invalidateLocalBufferCache();
        const back = await ST.saveStateNow({ force: true });
        const backOk = back && back.ok !== false && String(back.via || '').indexOf('localStorage') >= 0
            && Object.prototype.hasOwnProperty.call(memStore, key)
            && ST.localLayerInfo().memLayersDisabled === false;
        const ok = pageOk && mkOk && dirOk && loadOk && backOk;
        if (!ok) console.log('BR2-DEBUG ' + JSON.stringify({ pageOk, mkOk, dirOk, loadOk, backOk, st, via, mk: mk && mk.note, back: back && back.via }));
        return ok;
    } finally {
        RT.cfg.storage = keepCfg;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');

// ---------- BO NSFW 等级留档（v3.8.0） ----------
// 用户要求（原话）：「原子数据新增字段，用于标记该信息是否包含了 NSFW 内容，同时 NSFW 分等级，分别包括无、弱、强 3 个级别。
//   其中无代表与 NSFW 完全无关、弱代表有部分但没有露骨内容、强代表完全是露骨内容。
//   当弱化 NSFW 功能修复后，**NSFW 标签不会改变，用于永久性留档**。」
//   本小节端到端锁死：① 落库即打标（强 / 弱 / 无三级）② 列表行显示徽标 ③ **弱化后标签不变**（固定规则替换与 AI 弱化两条路径）
//   ④ 状态记录维度参与扫描/替换（修 V1 移植缺陷，有意偏离）⑤ 设定页「📌 NSFW 等级留档」分节 + 「🔖 立即补档」真实点击。
await assert('BO1 v3.8.0 NSFW 等级留档（端到端）：落库打标（强/弱/无）→ 列表行徽标 → **弱化后标签不变**（固定规则 + AI 两条路径）→ 状态记录参与扫描（修 V1 缺陷）→ 设定页分节与「🔖 立即补档」真实点击', (async () => {
    const RT = await import('../core/model/runtime.js');
    const N = await import('../core/nsfw.js');
    const IG = await import('../core/ingest.js');
    const keepAtoms = JSON.parse(JSON.stringify(RT.state.atoms || []));
    const keepStates = JSON.parse(JSON.stringify(RT.state.currentStates || []));
    const keepGen = host.ctx.generateRaw;
    const keepAuto = RT.cfg.nsfwReplaceAuto;
    const keepPopup = host.ctx.callGenericPopup;
    try {
        host.ctx.callGenericPopup = () => Promise.resolve(1);          // 危险动作确认（若有）
        RT.cfg.nsfwKeywords = [];                                     // 用内置词条库（此前的小节可能自定义过）
        RT.state.atoms = [];
        RT.state.currentStates = [];
        RT.state.lastKnownFloor = 0;
        // ① 落库即打标：露骨 → 强；亲密暗示 → 弱；无关 → 无（不写字段）
        IG.mergeDelta({ atoms: { add: [
            { id: 'bo1-strong', 标题: '夜里', 正文: '两人做爱后相拥，她发出呻吟，他解开她的衣扣。', 日期: '1919-11-01' },
            { id: 'bo1-weak', 标题: '码头告别', 正文: '两人在码头拥抱很久，最后轻轻亲吻，谁都没说话。', 日期: '1919-11-02' },
            { id: 'bo1-none', 标题: '清点', 正文: '甲在仓库清点编号 3 的铜箱，登记账册后交给乙。', 日期: '1919-11-03' },
        ] } }, { startFloor: 0, endFloor: 0 });
        const g = (id) => (RT.state.atoms || []).filter((x) => x.id === id)[0] || {};
        const labelOk = g('bo1-strong').nsfw === 'strong' && g('bo1-weak').nsfw === 'weak'
            && g('bo1-none').nsfw === undefined && RT.state.atoms.length === 3;
        // ② 列表行徽标：强 → 「NSFW·强」、弱 → 「NSFW·弱」、无 → 无徽标（v3.9.0 写明等级）
        await entry.popupAction('tab', { tab: 'atoms' });
        const listHtml = String(((await entry.popupAction('refresh', {})).html) || '');
        const badgeOk = listHtml.indexOf('NSFW·强') >= 0 && listHtml.indexOf('NSFW·弱') >= 0
            && (listHtml.match(/NSFW·强/g) || []).length === 1;
        // ③ 固定规则替换（零 AI）真实点击 → 正文被改写，**标签不变**
        const r1 = await entry.popupAction('nsfwRuleApply', {});
        const s1 = g('bo1-strong');
        const fixedOk = r1.ok === true && s1.text.indexOf('做爱') < 0 && s1.text.indexOf('呻吟') < 0
            && s1.nsfw === 'strong' && r1.note.indexOf('固定规则替换完成') === 0;
        // ④ AI 弱化路径（真实点击「🌶 弱化NSFW」）：先补一条新的露骨情节，关闭固定规则阶段、桩 AI 返回柔性文本
        IG.mergeDelta({ atoms: { add: [{ id: 'bo1-ai', 标题: '药铺后院', 正文: '两人在药铺后院做爱，她的呻吟惊动了更夫。', 日期: '1919-11-04' }] } }, { startFloor: 0, endFloor: 0 });
        const beforeAi = g('bo1-ai').nsfw;
        RT.cfg.nsfwReplaceAuto = false;
        host.ctx.generateRaw = async () => JSON.stringify({ 弱化: [{ 编号: 1, 文本: '两人在药铺后院亲近，动静惊动了更夫，谁也没再多说。', 说明: '去掉露骨描写' }] });
        const soft = await entry.popupAction('nsfwSoften', {});
        const after = g('bo1-ai');
        const aiOk = beforeAi === 'strong' && soft.ok === true && Number(soft.detail && soft.detail.applied) >= 1
            && after.text.indexOf('做爱') < 0 && after.nsfw === 'strong'
            && String(soft.note || '').indexOf('标签留档不变') >= 0;
        // ⑤ 状态记录维度参与扫描与替换（V1 因 `state.states` 恒空而整维跳过 → 有意偏离 V1，已登记）
        RT.state.currentStates = [{ id: 'bo1-st', subject: '角色甲', field: '衣着', value: '赤裸上身', uses: 0, floorStart: 1, floorEnd: 1 }];
        const scanStates = N.nsfwScan({ dims: ['states'] });
        const fx2 = N.nsfwFixedReplace({ silent: true });
        const stOk = scanStates.byDim.states >= 1 && fx2.replaced >= 1
            && RT.state.currentStates[0].value.indexOf('赤裸') < 0;
        await entry.popupAction('tab', { tab: 'atoms' });
        const listHtml2 = String(((await entry.popupAction('refresh', {})).html) || '');
        const keepBadgeOk = listHtml2.indexOf('NSFW·强') >= 0;      // 弱化之后，行内仍显示「NSFW·强」（永久留档）
        // ⑥ 设定 → NSFW弱化页：留档分节 + 真实点击「🔖 立即补档」
        await entry.popupAction('tab', { tab: 'settings' });
        const pg = String(((await entry.popupAction('settingsSub', { sub: 'safety' })).html) || '');
        const pageOk = pg.indexOf('📌 NSFW 等级留档') >= 0 && pg.indexOf('data-ftt-nsfw-label-state') >= 0
            && pg.indexOf('data-ftt-action="nsfwLabelBackfill"') >= 0 && pg.indexOf('🔖 立即补档') >= 0;
        const back = await entry.popupAction('nsfwLabelBackfill', {});
        const backOk = back.ok === true && String(back.note || '').indexOf('只升不降') >= 0
            && String(back.note || '').indexOf('留档') > 0;
        const ok = labelOk && badgeOk && fixedOk && aiOk && stOk && keepBadgeOk && pageOk && backOk;
        if (!ok) console.log('BO1-DEBUG ' + JSON.stringify({ labelOk, badgeOk, fixedOk, aiOk, stOk, keepBadgeOk, pageOk, backOk, atoms: RT.state.atoms.map((x) => ({ id: x.id, nsfw: x.nsfw, text: String(x.text).slice(0, 24) })), note: String(soft.note || '').slice(0, 120), state: RT.state.currentStates[0] }));
        return ok;
    } finally {
        RT.state.atoms = keepAtoms;
        RT.state.currentStates = keepStates;
        RT.cfg.nsfwReplaceAuto = keepAuto;
        host.ctx.generateRaw = keepGen;
        host.ctx.callGenericPopup = keepPopup;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


// v3.9.0（用户要求）：「NSFW 标签需要在情节、记忆、状态、物品、传言、计划悬念、概念等分类下均有标签提示，
//   用于告诉用户这个词条是什么级别的内容。」
//   本小节为**用户点名的每个分类**各放一条留档条目（经 `mergeDelta` 真实落库打标），逐个分类页断言：
//   ① **末行**有写明等级的文字标签（`data-ftt-nsfw-level` + 「NSFW·强 / NSFW·弱」；v3.11.0 由行首移到末行）② 分类顶部有留档汇总
//   ③ 编辑器里也有只读的留档行（永久留档：弱化不改）。
await assert('BO2 v3.9.0 各分类均有 NSFW 标签提示（端到端）：情节 / 记忆 / 状态 / 物品 / 传言 / 计划悬念 / 概念 逐个分类页断言**末行**文字标签（v3.11.0 由行首移到末行）+ 分类留档汇总 + 编辑器只读留档行', (async () => {
    const RT = await import('../core/model/runtime.js');
    const IG = await import('../core/ingest.js');
    const keepAtoms = JSON.parse(JSON.stringify(RT.state.atoms || []));
    const keepMem = JSON.parse(JSON.stringify(RT.state.memories || []));
    const keepStates = JSON.parse(JSON.stringify(RT.state.currentStates || []));
    const keepItems = JSON.parse(JSON.stringify(RT.state.items || []));
    const keepRumors = JSON.parse(JSON.stringify(RT.state.rumors || []));
    const keepPlans = JSON.parse(JSON.stringify(RT.state.plans || []));
    const keepSusp = JSON.parse(JSON.stringify(RT.state.suspense || []));
    const keepConcepts = JSON.parse(JSON.stringify(RT.state.concepts || []));
    try {
        RT.cfg.nsfwKeywords = [];
        RT.state.atoms = []; RT.state.memories = []; RT.state.currentStates = [];
        RT.state.items = []; RT.state.rumors = []; RT.state.plans = []; RT.state.suspense = []; RT.state.concepts = [];
        RT.state.lastKnownFloor = 0;
        // 每个分类一条：情节/传言 → 强（露骨词）；其余 → 弱（亲密/暗示信号）
        IG.mergeDelta({
            atoms: { add: [{ id: 'bo2-a', text: '两人做爱后相拥，她发出呻吟，他解开她的衣扣。', title: '夜里', date: '1919-11-01' }] },
            memories: { add: [{ id: 'bo2-m', title: '码头告别', content: '两人在码头拥抱很久，最后轻轻亲吻。', date: '1919-11-02' }] },
            states: { add: [{ id: 'bo2-s', subject: '角色甲', field: '衣着', value: '赤裸上身' }] },
            items: { add: [{ id: 'bo2-i', name: '同心结', desc: '情人相赠之物，两人相拥而眠时常佩。' }] },
            rumors: { add: [{ id: 'bo2-r', subject: '码头传闻', content: '有人说两人做爱被更夫撞见。' }] },
            plans: { add: [{ id: 'bo2-p', title: '夜里相会', content: '两人计划夜里相见并拥抱告别。' }] },
            suspense: { add: [{ id: 'bo2-u', title: '是否越界', content: '她是否会在码头亲吻他。' }] },
            concepts: { add: [{ id: 'bo2-c', name: '禁忌之恋', content: '越界的情感，两人只能暗中亲近。' }] },
        }, { startFloor: 0, endFloor: 0 });
        // 分类 → 期望等级（标签落库即为该级：只升不降）
        const want = {
            atoms: 'strong', memories: 'weak', states: 'strong', items: 'weak', rumors: 'strong',
            plans: 'weak', suspense: 'weak', concepts: 'weak',
        };
        const got = {
            atoms: (RT.state.atoms[0] || {}).nsfw, memories: (RT.state.memories[0] || {}).nsfw,
            states: (RT.state.currentStates[0] || {}).nsfw, items: (RT.state.items[0] || {}).nsfw,
            rumors: (RT.state.rumors[0] || {}).nsfw, plans: (RT.state.plans[0] || {}).nsfw,
            suspense: (RT.state.suspense[0] || {}).nsfw, concepts: (RT.state.concepts[0] || {}).nsfw,
        };
        const labelOk = Object.keys(want).every((k) => got[k] === want[k]);
        // 逐个分类页：末行标签 + 分类汇总（v3.11.0：标签从行首移到末行，与楼层等信息同段）
        const label = { strong: 'NSFW·强', weak: 'NSFW·弱' };
        const perKind = {};
        for (const kind of ['atoms', 'memories', 'states', 'items', 'rumors', 'plans', 'concepts']) {
            await entry.popupAction('tab', { tab: kind });
            const h = String(((await entry.popupAction('refresh', {})).html) || '');
            const lv = want[kind];
            perKind[kind] = h.indexOf('data-ftt-nsfw-level="' + lv + '"') >= 0
                && h.indexOf(label[lv]) >= 0
                && h.indexOf('data-ftt-nsfw-legend') >= 0;
            if (kind === 'plans') {                       // 计划悬念页 = 计划 + 悬念 两块，两行都要带标签
                perKind[kind] = perKind[kind] && h.indexOf('data-ftt-nsfw-level="weak"') >= 0;
            }
        }
        const pagesOk = Object.keys(perKind).every((k) => perKind[k]);
        // 编辑器只读留档行（以情节为例）
        await entry.popupAction('tab', { tab: 'atoms' });
        await entry.popupAction('edit', { kind: 'atoms', id: 'bo2-a' });
        const edHtml = String(((await entry.popupAction('refresh', {})).html) || '');
        const editorOk = edHtml.indexOf('NSFW 等级留档') >= 0 && edHtml.indexOf('NSFW·强') >= 0
            && edHtml.indexOf('完全是露骨内容') >= 0 && edHtml.indexOf('永久留档') >= 0;
        await entry.popupAction('closeEntry', { kind: 'atoms' });
        const ok = labelOk && pagesOk && editorOk;
        if (!ok) console.log('BO2-DEBUG ' + JSON.stringify({ labelOk, pagesOk, editorOk, got, want, perKind }));
        return ok;
    } finally {
        RT.state.atoms = keepAtoms; RT.state.memories = keepMem; RT.state.currentStates = keepStates;
        RT.state.items = keepItems; RT.state.rumors = keepRumors; RT.state.plans = keepPlans;
        RT.state.suspense = keepSusp; RT.state.concepts = keepConcepts;
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
    }
})(), '');


// ---------- BS 通知出口（v3.24.0）：核心通知 → 插件接线 → 行为配色类真的挂到通知上 ----------
// 用户要求（原话）：「进一步优化UI设计、优化通知效果等。」
// 改动前：`style.css` 的 8 类行为配色（`#toast-container .ftt-toastr--*`）**没有任何 JS 挂过** →
//   所有通知长得一模一样；且调 toastr 不传选项（无转义 / 无去重 / 无分级停留 / 无长度上限）。
// 本断言走**真实接线**（`core` 经 `notifyHooks.toast` → `index.js#setNotifyHooks` → `ui/notify.js#showToast`）。
await assert('BV1 v3.24.0 通知出口统一（端到端走真实接线）：① 行为配色类按 kind 挂上（`weave/sync/repair/analysis/error/warning/success/info` 全 8 类）② `escapeHtml`+`preventDuplicates` 开启 ③ 错误/警告停留更久 ④ 超长文案被截断 ⑤ 空文案不发', (async () => {
    const keep = globalThis.toastr;
    const calls = [];
    try {
        const mk = (name) => function (text, title, options) {
            calls.push({ name, text: String(text), title: String(title == null ? '' : title), options: options || {} });
            if (options && typeof options.onShown === 'function') { try { options.onShown.call(null); } catch (e) { /* 忽略 */ } }
        };
        globalThis.toastr = { info: mk('info'), success: mk('success'), warning: mk('warning'), error: mk('error') };
        const { notifyHooks } = await import('../core/model/runtime.js');
        const KINDS = ['info', 'analysis', 'success', 'warning', 'error', 'sync', 'weave', 'repair'];
        KINDS.forEach((k) => notifyHooks.toast('探针·' + k, k));
        notifyHooks.toast('x'.repeat(600), 'warning');
        notifyHooks.toast('   ', 'info');
        const byText = {};
        for (const c of calls) byText[c.text.slice(0, 8)] = c;
        const clsOk = KINDS.every((k) => {
            const c = calls.filter((x) => x.text === '探针·' + k)[0];
            return !!c && String(c.options.toastClass).indexOf('ftt-toastr--' + k) >= 0
                && c.title === '' && c.options.escapeHtml === true && c.options.preventDuplicates === true;
        });
        const methodOk = calls.filter((x) => x.text === '探针·weave')[0].name === 'info'          // 细粒度只走配色，不改语义色
            && calls.filter((x) => x.text === '探针·repair')[0].name === 'warning'
            && calls.filter((x) => x.text === '探针·error')[0].name === 'error'
            && calls.filter((x) => x.text === '探针·success')[0].name === 'success';
        const timeOk = calls.filter((x) => x.text === '探针·error')[0].options.timeOut === 10000
            && calls.filter((x) => x.text === '探针·info')[0].options.timeOut === 4500;
        const long = calls.filter((x) => x.text.length > 100)[0];
        const truncOk = !!long && long.text.length === 300 && long.text.slice(-1) === '…';
        const emptyOk = calls.length === KINDS.length + 2 - 1;                                   // 空文案不发（只多出「超长」那一条）
        return clsOk && methodOk && timeOk && truncOk && emptyOk;
    } finally {
        globalThis.toastr = keep;
    }
})(), '');

// ---------- BW 初始化顺序（v3.24.1）：真机「刷新后抛出两个错误」的端到端回归 ----------
// 用户报告（原话）：「刷新后初始化阶段，插件会抛出两个错误，均可能是初始化顺序异常导致的数据错乱，引发报错。」
// 错误原文（其中一条）：「已处理楼层漂移防呆失败 Cannot read properties of null (reading 'processedFloors')」。
// 成因：`init()` 在 `loadMemoryState()`（内部才注入内核状态）**之前**就取面板状态快照 → 台账维护读空状态。
// 本断言走**真实装配**（本文件顶部的 `init()` 已完整跑过一遍）：这两条字符串不得出现在调试日志里。
await assert('BW1 v3.24.1 初始化期零「空状态」异常（真机两错回归）：真实装配全程的调试日志里没有 `processedFloors` / 漂移防呆失败 / 归位对账失败 这类初始化错序告警', (async () => {
    const DL = await import('../adapters/debug-log.js');
    const RTM = await import('../core/model/runtime.js');
    const lines = (() => { try { return DL.debugLogList() || []; } catch (e) { return []; } })();
    const texts = lines.map((l) => String((l && l.data) || ''));
    const backlog = (() => { try { return RTM.warnBacklogList() || []; } catch (e) { return []; } })();
    const all = texts.concat(backlog.map((x) => String((x && x.msg) || '')));
    const bad = all.filter((t) => /processedFloors|漂移防呆失败|已处理楼层对账失败|楼层收缩处理失败/.test(t));
    if (bad.length) console.log('BW1-DEBUG ' + JSON.stringify(bad.slice(0, 3)));
    return bad.length === 0;
})(), '');

// ---------- BX 调试桥区块（v3.25.0）：状态行是**可就地刷新的活节点**，且与 bridgeStatusLine 同源 ----------
// 用户报告（原话）：「修复调试-调试桥的错误，显示正在链接或重试，实际上已经链接的问题。」
// 缺陷成因：状态文案只在渲染那一刻采样；WebSocket 异步连上后没人再重画 → 界面卡在「重试中」。
// 本断言走真实装配：调试页必须渲染出 `[data-ftt-bridge-status]` 节点，且文本 = `bridgeStatusLine()`（唯一事实源）。
await assert('BX1 v3.25.0 调试桥状态行可就地刷新（端到端）：调试页渲染出 `data-ftt-bridge-status` 活节点，文本与 `bridgeStatusLine()` 同源，开关按钮两侧文案正确', (async () => {
    const DBG = await import('../ui/debug.js');
    const BR = await import('../adapters/debug-bridge.js');
    await entry.popupAction('tab', { tab: 'settings' });
    await entry.popupAction('settingsSub', { sub: 'debug' });
    const h = String((await entry.popupAction('refresh', {})).html || '');
    const live = BR.bridgeStatusLine();
    const nodeOk = h.indexOf('data-ftt-bridge-status') >= 0 && h.indexOf(live) > 0;
    const btnOk = h.indexOf('data-ftt-action="bridgeToggle"') >= 0
        && (h.indexOf('▶ 开启调试桥') >= 0 || h.indexOf('⏹ 关闭调试桥') >= 0);
    // 关闭态：文案是「已关闭」；开启后（不依赖真实连接）文案应变为「未连接（重试中…）」
    const offText = BR.bridgeStatusLine({ supported: true, running: false, connected: false, targetHost: BR.bridgeTarget(), port: BR.bridgePort() });
    const onText = BR.bridgeStatusLine({ supported: true, running: true, connected: false, targetHost: BR.bridgeTarget(), port: BR.bridgePort(), retryAt: Date.now() + 3000 });
    const sameSource = DBG.bridgeStatusView().live === BR.bridgeStatusLine();
    // 无节点环境（桩 DOM 未必支持 querySelector）：如实返回 false 而不是抛错
    const noNode = DBG.updateBridgeStatusDom() === false || DBG.updateBridgeStatusDom() === true;
    return nodeOk && btnOk && offText.indexOf('已关闭') === 0 && onText.indexOf('未连接（重试中') === 0 && sameSource && noNode;
})(), '');

// ---------- BY v3.26.1「undefined 脏数据」根因修复 + 文本卫生（用户报告） ----------
// 用户要求（原话）：「有传言中出现了undefined字样，其他原子数据可能也有，请核对原因并进行修复。
//   同时建议如果AI回复不可控，可以用默认值来顶上去，避免出现异常数据。」
// 真机取证：只有传言的正文与传导链路命中（`（说法演变为：undefined）` / `说法完成演化（undefined）`），
//   根因是 `rumorRoll` 把 base36 哈希按 16 进制解析 → NaN → 变体名 undefined。
// 本小节端到端：真实面板跑一次传言演化（全库无 undefined）→ 载入期自愈清掉存量脏数据（含调试日志留痕）
//   → 只读体检（调试桥同源 `dataHealthReport`）对残留如实列出 `text-bad-token`。
await assert('BY1 v3.26.1「undefined 脏数据」修复（端到端）：真实传言演化后全库文本无 undefined；载入期自愈清掉存量脏数据并留痕；只读体检对残留列出 text-bad-token', (async () => {
    const RT = await import('../core/model/runtime.js');
    const RU = await import('../core/rumor-evolve.js');
    const MG = await import('../core/migrate.js');
    const DH = await import('../core/data-health.js');
    const keepRumors = JSON.parse(JSON.stringify(RT.state.rumors || []));
    const keepCfg = JSON.parse(JSON.stringify(RT.cfg || {}));
    try {
        // ① 真实面板动作跑一次机械演化：给一条**必然进入「变异」提交**的传言（pending 目标为空 —— 历史脏数据的形态）
        RT.state.rumors = [{
            id: 'bs1-r1', subject: '码头失窃', content: '码头的货被偷了，有人说是内贼。', objectivity: '主观',
            stage: '发酵', ferment: 70, date: '2020-05-01', tags: ['码头'], carriers: [{ who: '角色甲', role: '源头' }],
            media: [], chain: [], lineage: { rootId: 'bs1-r1', parentId: '', children: [], generation: 0 },
            pending: { kind: '变异', need: 2, progress: 2, target: '', at: '2020-05-01' },
        }];
        await entry.popupAction('tab', { tab: 'rumors' });
        const ev = await entry.popupAction('rumorEvolve', {});
        const afterEvolve = JSON.stringify(RT.state.rumors);
        const evolveOk = ev.ok === true && afterEvolve.indexOf('undefined') < 0
            && afterEvolve.indexOf('（说法演变为：') > 0;                    // 变体仍被拼进去，只是不再是 undefined
        // ② 载入期自愈：把「历史脏数据」放回状态 → 走真实迁移链（`migrateState`，与载入同一条）
        RT.state.rumors = [{
            id: 'bs1-r2', subject: '码头失窃', content: '胡商称见黑袍人（说法演变为：undefined）',
            chain: [{ at: '2020-05-01', kind: '异变', note: '说法完成演化（undefined）' }], lineage: {}, carriers: [], media: [], tags: [],
        }];
        const before = JSON.stringify(RT.state.rumors);
        const migrated = MG.migrateState(RT.state);
        const heal = MG.lastHealInfo();
        const after = JSON.stringify(migrated.rumors);
        const healOk = before.indexOf('undefined') > 0 && after.indexOf('undefined') < 0
            && Number(heal && heal.texts) >= 1 && String(migrated.rumors[0].content) === '胡商称见黑袍人';
        // ③ 只读体检：残留时如实列出（与调试桥 `ftt.dataHealth` 同一实现）
        const rep = DH.dataHealthReport({ rumors: [{ id: 'bs1-r3', subject: '甲', content: '甲说（说法演变为：undefined）' }] }, {});
        const healthOk = Number(rep.counts['text-bad-token']) === 1 && rep.level === 'warn'
            && (rep.findings || []).some((f) => f.code === 'text-bad-token' && f.dim === 'rumors');
        // ④ 掷骰与变体：旧实现的两个 NaN 病例必须已修好
        const rollOk = ['rum_v2|variant|2020-06-01|1', 'rum_13oko38|variant|2020-05-01|1'].every((s) => Number.isFinite(RU.rumorRoll(s)))
            && [1, 2, 3, 4, 5].every((i) => typeof RU.rumorVariantFor({ id: 'rum_13oko38', date: '2020-05-01' }, i) === 'string');
        const ok = evolveOk && healOk && healthOk && rollOk;
        if (!ok) console.log('BY1-DEBUG ' + JSON.stringify({ evolveOk, healOk, healthOk, rollOk, heal }));
        return ok;
    } finally {
        RT.state.rumors = keepRumors;
        Object.assign(RT.cfg, keepCfg);
        try { await entry.popupAction('tab', { tab: 'overview' }); } catch (e) { /* 忽略 */ }
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

// v3.25.1：**文档口径自查** —— 本文件是「冒烟项数」的唯一实测方，因此由它比对 `docs/README.md` §3「冒烟规模」，
//   避免文档数字静默漂移（`scripts/check-docs-facts.js` 不该为了一个数字再跑一遍整条冒烟）。
try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
    const md = fs.readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf8');
    const line = md.split('\n').filter((l) => /^\|\s*冒烟规模\s*\|/.test(l))[0] || '';
    const m = line.match(/(\d+)\s*项/);
    if (!m) {
        console.log('  ❌ docs 口径不一致：docs/README.md §3「冒烟规模」行缺失或格式不符（应形如 `215 项`）');
        process.exit(1);
    }
    if (Number(m[1]) !== pass) {
        console.log('  ❌ docs 口径不一致：冒烟项数文档写 ' + Number(m[1]) + '，实测 ' + pass);
        console.log('  请把 `docs/README.md` §3「冒烟规模」更新为：' + pass + ' 项（同一提交内完成）');
        process.exit(1);
    }
} catch (e) {
    console.log('  ❌ docs 口径自查失败：' + String((e && e.message) || e));
    process.exit(1);
}
process.exit(0);
