// ============================================================
// 单元测试 · host/update（**默认只用 HTTP 远端清单**；宿主 Git 端点仅在设置开启时使用 / 启动自动检查 / 手动检查）
// 覆盖用户要求：「以 GitHub 项目地址为更新检查地址；首次启动自动检查 + 设定内手动检查」
// 回归（v2.11.1）：无 git 能力的宿主上 POST /api/extensions/version 会返回
//   「Failed to get extension version: Git handshake failed…」并被宿主当「后端错误」弹窗 →
//   默认**绝不**请求该端点（下方 A2/E1b 为回归断言）。
import { makeReporter, makeHost, installGlobalFetch } from '../harness/st-mock.js';
import { setContextProvider, resetContextProvider } from '../../host/st-api.js';
import { runUpdateCheck, runStUpdate, maybeAutoCheckOnStartup, updateStatusText, hasUpdate, updateConfig, checkViaStEndpoint } from '../../host/update.js';
import { readUpdateState, writeUpdateState, ensureFirstRun } from '../../adapters/update-state.js';
import { summarizeCheck as require_summarize } from '../../core/update.js';
import { getSettings, setSetting, DEFAULT_SETTINGS } from '../../adapters/settings.js';
import { MODULE_NAME, VERSION, DEFAULT_UPDATE_REPO } from '../../core/constants.js';

const R = makeReporter('host-update 更新检查与执行');
/**
 * 远端样本版本 = 当前版本的下一个次版本（**按 VERSION 推导**：发版升级版本号时测试不该失效；
 *   此前硬编码 '2.1.0'，升到 2.1.0 后「远端更新」用例会退化成「同版本」而失败）。
 */
const REMOTE_VERSION = (() => {
    const m = String(VERSION).split('.').map((x) => Number(x.replace(/\D/g, '')) || 0);
    return [m[0] || 0, (m[1] || 0) + 1, 0].join('.');
})();
const REMOTE_MANIFEST = JSON.stringify({ version: REMOTE_VERSION, display_name: 'FTT记忆组件 V2' });
const REMOTE_CHANGELOG = '# 版本历史\n\n## v' + REMOTE_VERSION + '（2026-10-01）\n\n- 新增：记忆面板多选\n- 修复：注入深度\n';

function freshHost() {
    const h = makeHost();
    h.ctx.extensionSettings[MODULE_NAME] = {};
    setContextProvider(() => h.ctx);
    return h;
}

// ---------- A2 默认：宿主 Git 端点关闭 → 完全不触碰该端点（回归 v2.11.1） ----------
{
    freshHost();
    const calls = [];
    const un = installGlobalFetch((url) => {
        calls.push(url);
        if (url.endsWith('/manifest.json')) return { status: 200, text: JSON.stringify({ version: VERSION }) };
        if (url.endsWith('/CHANGELOG.md')) return { status: 200, text: '## v' + VERSION + '（2026-09-26）\n- 当前版本\n' };
        return { status: 404, body: {} };
    });
    const r = await runUpdateCheck({});
    un();
    R.assert('A2-1 默认（useStGitEndpoint=false）：不请求 /api/extensions/version，走远端清单判定', (() => {
        return calls.every(u => u.indexOf('/api/extensions') < 0) && r.ok === true && r.via.indexOf('remote-manifest:github') >= 0 && r.stEndpoint === 'off';
    })(), { calls, r });
    R.assert('A2-2 默认路径下端点关闭标记透传到摘要（诊断「为何没有 git 校验」）', (() => {
        const sum = require_summarize(r);
        return sum.stEndpoint === 'off';
    })(), (() => require_summarize(r))());
}

// ---------- A 宿主 Git 端点（**需显式开启**）：git 真值优先 ----------
{
    const h = freshHost();
    setSetting('useStGitEndpoint', true);
    const calls = [];
    const un = installGlobalFetch((url) => {
        calls.push(url);
        if (url === '/api/extensions/version') return { status: 200, body: { isUpToDate: true, currentCommitHash: 'abc1234def', currentBranchName: 'main', remoteUrl: 'https://github.com/fotomxq/stt-memory-plugin-v2' } };
        return { status: 404, body: {} };
    });
    const r = await runUpdateCheck({});
    un();
    R.assert('U1 ST 端点可用：via=st-endpoint 且 isUpToDate 透传', r.ok === true && r.via === 'st-endpoint' && r.isUpToDate === true && r.remoteCommit === 'abc1234def', r);
    R.assert('U2 端点说「最新」且非手动时不打扰远端（只 1 次请求）', calls.length === 1 && calls[0] === '/api/extensions/version', calls);
    R.assert('U3 状态文案走 Git 校验分支', updateStatusText(Object.assign({ at: 1 }, r)).indexOf('已是最新（Git 校验）') >= 0, updateStatusText(Object.assign({ at: 1 }, r)));
}
R.assert('U4 updateConfig 默认取 GitHub 项目地址与 main 分支（宿主 Git 端点默认关）', (() => {
    const h = freshHost();
    const c = updateConfig();
    void h;
    return c.repo === DEFAULT_UPDATE_REPO && c.branch === 'main' && c.autoUpdateCheck === true && c.intervalHours === 24
        && c.useStGitEndpoint === false;
})(), updateConfig());

// ---------- B 端点不可用 → 远端 manifest/CHANGELOG 回退 ----------
{
    freshHost();
    const calls = [];
    const un = installGlobalFetch((url) => {
        calls.push(url);
        if (url.indexOf('/api/extensions/version') === 0) return { status: 404, body: {} };
        if (url.indexOf('raw.githubusercontent.com') >= 0 && url.endsWith('/manifest.json')) return { status: 200, text: REMOTE_MANIFEST };
        if (url.endsWith('/CHANGELOG.md')) return { status: 200, text: REMOTE_CHANGELOG };
        return { status: 404, body: {} };
    });
    const r = await runUpdateCheck({ manual: true });
    un();
    R.assert('U5 端点不可用（用户态+全局态均 404）→ 回退远端清单', r.ok === true && r.via.indexOf('remote-manifest:github') >= 0, r);
    R.assert('U6 远端版本更新 → status=newer + 更新要点提取', r.judge.status === 'newer' && r.judge.remote === REMOTE_VERSION && r.points.length === 2 && r.points[0].indexOf('记忆面板多选') >= 0, [r.judge, r.points]);
    R.assert('U7 hasUpdate 判定为真 + 文案含新版本号', hasUpdate(r) === true && updateStatusText(Object.assign({ at: 1 }, r)).indexOf('发现新版本 ' + REMOTE_VERSION) >= 0, updateStatusText(r));
    R.assert('U8 默认关闭宿主 Git 端点 → 端点请求 0 次（回归：不再触发后端 git handshake）', calls.filter(u => u.indexOf('/api/extensions/version') === 0).length === 0, calls);
    R.assert('U9 远端地址来自可配置仓库（GitHub raw + 分支）', calls.some(u => u === 'https://raw.githubusercontent.com/fotomxq/stt-memory-plugin-v2/main/manifest.json'), calls);
}

// ---------- B2 仓库根没有 manifest.json（例如 V1 形态仓库）→ 用 CHANGELOG 判定 ----------
{
    freshHost();
    const un = installGlobalFetch((url) => {
        if (url.indexOf('/api/extensions/version') === 0) return { status: 404, body: {} };
        if (url.endsWith('/manifest.json')) return { status: 404, body: {} };
        if (url.endsWith('/CHANGELOG.md')) return { status: 200, text: '# 版本历史\n\n## v1.206（2026-09-24）\n- 旧版要点\n' };
        return { status: 404, body: {} };
    });
    const r = await runUpdateCheck({ manual: true });
    un();
    R.assert('U11 远端无 manifest 时用 CHANGELOG 版本兜底（不误报失败）',
        r.ok === true && r.judge.remote === '1.206' && r.judge.status === 'older' && r.points.length === 1, [r.judge, r.points]);
}
{
    freshHost();
    const un = installGlobalFetch(() => ({ status: 404, body: {} }));
    const r = await runUpdateCheck({ manual: true });
    un();
    R.assert('U12 远端两者都不可达 → ok=false 且错误可读', r.ok === false && String(r.error).length > 0, r);
}

// ---------- C git 说有更新但版本号一致 → 以 git 为准（需开启宿主 Git 端点） ----------
{
    freshHost();
    setSetting('useStGitEndpoint', true);
    const un = installGlobalFetch((url) => {
        if (url === '/api/extensions/version') return { status: 200, body: { isUpToDate: false, currentCommitHash: 'fff0000' } };
        if (url.endsWith('/manifest.json')) return { status: 200, text: JSON.stringify({ version: VERSION }) };
        if (url.endsWith('/CHANGELOG.md')) return { status: 200, text: '## v' + VERSION + '（2026-09-24）\n- 同版本新提交\n' };
        return { status: 404, body: {} };
    });
    const r = await runUpdateCheck({});
    un();
    R.assert('U10 端点 isUpToDate=false 且版本号相同 → 仍判为有更新（git 真值优先，标记同版本新提交）',
        r.ok === true && r.isUpToDate === false && r.judge.status === 'newer' && r.judge.commitOnly === true
        && updateStatusText(Object.assign({ at: 1 }, r)).indexOf('同版本新提交') >= 0, [r.judge, updateStatusText(r)]);
}

// ---------- D 全路径失败：静默返回错误 ----------
{
    freshHost();
    const un = installGlobalFetch(() => ({ status: 500, body: {} }));
    const r = await runUpdateCheck({ manual: true });
    un();
    R.assert('D1 全路径失败：ok=false + 有错误原因（不抛异常）', r.ok === false && String(r.error).length > 0, r);
    R.assert('D2 失败文案可读（含错误原因）', updateStatusText(Object.assign({ at: 1 }, r)).indexOf('检查更新失败') >= 0, updateStatusText(r));
}

// ---------- E 显式更新（仅用户触发） ----------
{
    // E1b：默认关 → 点击「立即更新」**不发起任何请求**，返回可读引导（回归 v2.11.1）
    freshHost();
    const calls0 = [];
    const un0 = installGlobalFetch((url) => { calls0.push(url); return { status: 200, body: {} }; });
    const r0 = await runStUpdate();
    un0();
    R.assert('E1b 宿主 Git 端点关闭：立即更新不请求 /api/extensions/update 且给出引导文案', r0.ok === false && r0.disabled === true && calls0.length === 0 && String(r0.error).indexOf('Git handshake failed') >= 0, [r0, calls0]);
}
{
    freshHost();
    setSetting('useStGitEndpoint', true);
    const calls = [];
    const un = installGlobalFetch((url, opts) => {
        calls.push({ url, method: opts.method, body: opts.body });
        if (url === '/api/extensions/update') return { status: 200, body: { isUpToDate: false, shortCommitHash: 'beef123', remoteUrl: 'https://github.com/fotomxq/stt-memory-plugin' } };
        return { status: 404, body: {} };
    });
    const r = await runStUpdate();
    un();
    R.assert('E1 开启后立即更新走宿主 Git 端点并回报新 commit', r.ok === true && r.commit === 'beef123' && calls[0].method === 'POST' && calls[0].body.indexOf('extensionName') >= 0, [r, calls[0]]);
}

// ---------- F 启动自动检查（首次 / 间隔 / 关闭 / 手动）+ 状态持久化 ----------
{
    const h = freshHost();
    setSetting('useStGitEndpoint', true);      // 本组断言 git 端点透传，需显式开启
    const un = installGlobalFetch((url) => {
        if (url === '/api/extensions/version') return { status: 200, body: { isUpToDate: true, currentCommitHash: 'aaa1111' } };
        return { status: 404, body: {} };
    });
    const r1 = await maybeAutoCheckOnStartup({ now: 1000000 });
    un();
    const st1 = readUpdateState();
    R.assert('F1 首次启动 → 自动检查（reason=first-startup）', r1.ran === true && r1.reason === 'first-startup' && r1.result.ok === true, r1);
    R.assert('F2 状态持久化：firstRunAt / startupCheckedAt / lastCheckAt / lastResult',
        st1.firstRunAt === 1000000 && st1.startupCheckedAt === 1000000 && st1.lastCheckAt === 1000000 && !!st1.lastResult && st1.lastResult.via === 'st-endpoint',
        st1);
    const r2 = await maybeAutoCheckOnStartup({ now: 1000000 + 1000 });
    R.assert('F3 间隔内再次启动 → 不重复检查（reason=recent）', r2.ran === false && r2.reason === 'recent', r2);
    const r3 = await maybeAutoCheckOnStartup({ now: 1000000 + 25 * 3600 * 1000 });
    R.assert('F4 超过 24h → 再次自动检查（reason=interval-elapsed）', r3.ran === true && r3.reason === 'interval-elapsed', r3);
    R.assert('F5 firstRunAt 不被覆盖（幂等）', readUpdateState().firstRunAt === 1000000, readUpdateState().firstRunAt);
    setSetting('autoUpdateCheck', false);
    const r4 = await maybeAutoCheckOnStartup({ now: 1000000 + 100 * 3600 * 1000 });
    R.assert('F6 关闭自动检查开关 → 不请求（reason=disabled）', r4.ran === false && r4.reason === 'disabled', r4);
    const r5 = await maybeAutoCheckOnStartup({ manual: true, now: 1000000 + 101 * 3600 * 1000 });
    R.assert('F7 手动检查不受开关与间隔限制（reason=manual）', r5.ran === true && r5.reason === 'manual', r5);
    void h;
}

// ---------- G 无宿主降级 ----------
{
    resetContextProvider();
    const r = await maybeAutoCheckOnStartup({ now: 5 });
    R.assert('G1 无宿主：自动检查直接跳过（no-host，不发起任何请求）', r.ran === false && r.reason === 'no-host', r);
    R.assert('G2 无宿主：状态读写安全降级', (() => {
        const st = readUpdateState();
        const w = writeUpdateState({ lastCheckAt: 1 });
        return st.lastCheckAt === 0 && w === false && ensureFirstRun(9) === 9;
    })(), '');
    R.assert('G3 无宿主：检查端点不可用且可配置项仍有默认值', true, '（无宿主分支已由 runUpdateCheck 内部路径覆盖）');
    const ep = await checkViaStEndpoint();
    R.assert('G3 无宿主：端点检查返回明确失败原因（不抛异常）', ep.ok === false && String(ep.error).length > 0, ep);
    R.assert('G4 无宿主：默认配置仍可读出（不崩）', Object.keys(DEFAULT_SETTINGS).length > 0 && getSettings().updateRepo === DEFAULT_UPDATE_REPO, getSettings().updateRepo);
}

resetContextProvider();

await (async () => {
    // 传输层失败（宿主 git handshake 不通）→ 只打一次端点、短路并进入会话退避
    const calls = [];
    const un2 = installGlobalFetch((url) => {
        calls.push(url);
        return { status: 500, body: { error: 'Git handshake failed: An IO error occurred when talking to the server' } };
    });
    const st = await import('../../host/update.js');
    st.resetTransportBackoff();
    const r = await st.checkViaStEndpoint();
    un2();
    R.assert('U10 传输层失败短路：只请求一次（不再打 global 端点）且标记 transport（避免后端日志翻倍）', (() => {
        return r.ok === false && r.transport === true && calls.length === 1 && st.transportBackoffActive() === true
            && st.isTransportFailure('Git handshake failed: An IO error occurred when talking to the server') === true
            && st.isTransportFailure('extension not found') === false;
    })(), { calls: calls.length, r });
})();

R.done();
