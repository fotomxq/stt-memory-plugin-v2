// ============================================================
// host/update.js —— 更新检查与更新执行（**默认 HTTP 优先**，Git 端点需显式开启）
// 事实源：docs/P0-探针报告.md §1/§3、docs/更新检查机制.md §2.1 ——
//   ① 默认通道 = 远端 manifest/CHANGELOG（纯 HTTP，无需 git；仅用于显示版本号与更新要点，
//      不写任何文件、不执行远端代码）；
//   ② 宿主 Git 端点（`useStGitEndpoint === true` 时才使用）：
//      POST /api/extensions/version（git 真值 isUpToDate / commit）
//      POST /api/extensions/update（显式更新，仅用户点击「立即更新」）
//      为什么要开关：无 git 能力的宿主（如 TauriTavern 原生移植）会在该端点返回
//      「Failed to get extension version: Git handshake failed…」，宿主以「后端错误」弹窗暴露 ——
//      v2.11.1 起默认不触碰该端点（manifest 亦置 `auto_update: false` 阻止酒馆自身加载期 git 校验）。
// 约定：检查失败一律静默（只记录），绝不阻塞启动/发送/提取；自动路径永不调用 update 端点。
// ============================================================
import { VERSION, DEFAULT_UPDATE_REPO, DEFAULT_UPDATE_BRANCH, DEFAULT_UPDATE_INTERVAL_HOURS } from '../core/constants.js';
import { judgeUpdate, repoRawUrls, shouldAutoCheck, updateReport, summarizeCheck, extractChangelogHead } from '../core/update.js';
import { getCtx, hasHost } from './st-api.js';
import { getSettings, setSetting } from '../adapters/settings.js';
import { readUpdateState, writeUpdateState, ensureFirstRun } from '../adapters/update-state.js';
import { extensionFolder } from './paths.js';

/** 当前更新配置（设置项优先，缺省用常量） */
export function updateConfig() {
    const s = getSettings();
    return {
        autoUpdateCheck: s.autoUpdateCheck !== false,
        // 宿主 Git 端点开关（默认关：见 adapters/settings.js 说明 —— 无 git 宿主会以「后端错误」弹窗暴露失败）
        useStGitEndpoint: s.useStGitEndpoint === true,
        repo: String(s.updateRepo || DEFAULT_UPDATE_REPO),
        branch: String(s.updateBranch || DEFAULT_UPDATE_BRANCH),
        intervalHours: Number(s.updateCheckIntervalHours) > 0 ? Number(s.updateCheckIntervalHours) : DEFAULT_UPDATE_INTERVAL_HOURS,
    };
}

const FETCH_TIMEOUT_MS = 8000;

/** 带超时的 fetch（超时即放弃，绝不挂死界面） */
async function fetchWithTimeout(url, init, timeoutMs) {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : FETCH_TIMEOUT_MS;
    let timer = null;
    try {
        if (typeof AbortController === 'function') {
            const ac = new AbortController();
            init = Object.assign({}, init || {}, { signal: ac.signal });
            timer = setTimeout(() => { try { ac.abort(); } catch (e) { /* noop */ } }, ms);
            return await globalThis.fetch(url, init);
        }
        return await globalThis.fetch(url, init);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function headers() {
    const ctx = getCtx();
    try {
        if (ctx && typeof ctx.getRequestHeaders === 'function') return ctx.getRequestHeaders();
    } catch (e) { /* 忽略 */ }
    return { 'Content-Type': 'application/json' };
}

async function postJson(path, body) {
    if (typeof globalThis.fetch !== 'function') return { ok: false, error: 'fetch 不可用' };
    try {
        const res = await fetchWithTimeout(path, { method: 'POST', headers: headers(), body: JSON.stringify(body || {}) });
        const status = Number(res && res.status) || 0;
        let data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        if (status >= 200 && status < 300) return { ok: true, data: data || {} };
        // 把宿主给出的错误文本透传出来（例如 TauriTavern 的「Git handshake failed: …」），
        //   否则只剩「HTTP 500」，无法区分「扩展名不存在」与「网络不通」。
        const msg = (data && (data.error || data.message)) ? String(data.error || data.message) : ('HTTP ' + status);
        return { ok: false, status, error: msg, data };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

async function getText(url) {
    if (typeof globalThis.fetch !== 'function') return { ok: false, error: 'fetch 不可用' };
    try {
        const res = await fetchWithTimeout(url, { method: 'GET' });
        const status = Number(res && res.status) || 0;
        if (status < 200 || status >= 300) return { ok: false, status, error: 'HTTP ' + status };
        const text = await res.text();
        return { ok: true, text: String(text == null ? '' : text) };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/** ST 原生版本查询（git 真值）：用户态优先，失败再试全局态 */
/**
 * 传输层失败判定：宿主（含 TauriTavern 等原生移植）用 git 取远端真值时，若本机到远端不通，
 *   后端会返回 「Git handshake failed / IO error」这类**网络级**错误。这种失败再打一次 global 端点
 *   只会**翻倍**后端日志噪声，故直接短路（返回 transport 标记，由上层决定退避）。
 */
export function isTransportFailure(text) {
    const t = String(text == null ? '' : text);
    return /handshake|IO error|i\/o|network|timed?\s?out|ECONN|fetch failed|failed to get extension version/i.test(t);
}

/** 会话内退避：传输层失败后不再反复触发（默认 6 小时；进程内有效，重载页面即重置） */
let transportBackoffUntil = 0;
const TRANSPORT_BACKOFF_MS = 6 * 60 * 60 * 1000;
/** 复位传输层退避（测试与「手动检查」用） */
export function resetTransportBackoff() { transportBackoffUntil = 0; return true; }
/** 是否处于传输层退避中（诊断） */
export function transportBackoffActive() { return Date.now() < transportBackoffUntil; }

export async function checkViaStEndpoint() {
    if (Date.now() < transportBackoffUntil) {
        return { ok: false, transport: true, error: '网络不通（本次会话已退避，稍后或手动再试）' };
    }
    const body = { extensionName: extensionFolder(), global: false };
    let r = await postJson('/api/extensions/version', body);
    if (!r.ok && isTransportFailure(r.error)) {
        transportBackoffUntil = Date.now() + TRANSPORT_BACKOFF_MS;
        return { ok: false, transport: true, error: String(r.error || 'Git 传输失败') };
    }
    if (!r.ok) r = await postJson('/api/extensions/version', { extensionName: extensionFolder(), global: true });
    if (!r.ok) return { ok: false, error: r.error || 'ST 版本端点不可用' };
    const d = r.data || {};
    return {
        ok: true,
        isUpToDate: d.isUpToDate === undefined ? null : !!d.isUpToDate,
        remoteCommit: String(d.currentCommitHash || ''),
        branch: String(d.currentBranchName || ''),
        remoteUrl: String(d.remoteUrl || ''),
    };
}

/** 远端清单与更新要点（best-effort；失败不影响主流程） */
export async function checkViaRemote(cfg) {
    const c = cfg || updateConfig();
    const urls = repoRawUrls(c.repo, c.branch);
    if (!urls.manifest) return { ok: false, error: '仓库地址无法解析为 raw 地址' };
    // ① 远端 manifest.json（首选；仓库根没有该文件时不算致命）
    let remoteVersion = '';
    let manifestError = '';
    const man = await getText(urls.manifest);
    if (man.ok) {
        try { remoteVersion = String((JSON.parse(man.text) || {}).version || ''); } catch (e) { manifestError = '远端清单不是合法 JSON'; }
    } else {
        manifestError = man.error || '远端清单不可达';
    }
    // ② 远端 CHANGELOG.md（版本号兜底 + 更新要点；仓库没有 manifest 时仍可判定，例如 V1 形态仓库）
    let points = [];
    let changelogVersion = '';
    const log = await getText(urls.changelog);
    if (log.ok) {
        const head = extractChangelogHead(log.text, 5);
        points = head.points;
        changelogVersion = head.version;
    }
    const resolved = remoteVersion || changelogVersion;
    if (!resolved) return { ok: false, error: manifestError || '远端版本不可判定' };
    return { ok: true, remoteVersion: resolved, points, via: 'remote-manifest:' + urls.host };
}

/**
 * 执行一次更新检查（自动/手动同一入口）。
 * @param {object} [opts] manual 手动触发（会额外抓取远端版本与更新要点）
 * @returns {Promise<object>} { ok, via, judge, points, isUpToDate, remoteCommit, error }
 */
export async function runUpdateCheck(opts) {
    const o = opts || {};
    const cfg = updateConfig();
    const out = { ok: false, via: '', judge: judgeUpdate(VERSION, ''), points: [], isUpToDate: null, remoteCommit: '', error: '' };

    // ① 宿主 Git 端点：**仅在用户显式开启时**才调用（默认关 —— 无 git 的宿主会返回后端错误并弹窗）
    const ep = cfg.useStGitEndpoint ? await checkViaStEndpoint() : { ok: false, disabled: true, error: '' };
    out.stEndpoint = cfg.useStGitEndpoint ? 'on' : 'off';
    if (ep.ok) {
        out.ok = true;
        out.via = 'st-endpoint';
        out.isUpToDate = ep.isUpToDate;
        out.remoteCommit = ep.remoteCommit;
        out.stRemoteUrl = ep.remoteUrl;
        out.judge = judgeUpdate(VERSION, '');
    }
    // 常态：ST 端点不可用（例如非 Git 安装/Node 环境），或手动检查 / 已判定有更新 → 抓远端清单补版本号与要点
    if (!ep.ok || o.manual || ep.isUpToDate === false) {
        const rm = await checkViaRemote(cfg);
        if (rm.ok) {
            out.ok = true;
            out.via = out.via || rm.via;
            out.judge = judgeUpdate(VERSION, rm.remoteVersion);
            out.points = rm.points || [];
            if (ep.ok && ep.isUpToDate === false && out.judge.status === 'same') {
                // git 说有更新但版本号一致（例如仅文档/未改版本的提交）：以 git 为准
                out.judge = { status: 'newer', remoteNewer: true, current: VERSION, remote: rm.remoteVersion || '', commitOnly: true };
            }
        } else if (!ep.ok) {
            out.error = rm.error || ep.error || (cfg.useStGitEndpoint ? '检查失败' : '远端清单不可达（宿主 Git 端点默认关闭）');
        } else {
            out.remotePointsError = rm.error || '';
        }
    }
    return out;
}

/** 显式执行 ST 更新（只有用户点击才会调用；自动路径永不调用；默认关 —— 需先开启宿主 Git 端点） */
export async function runStUpdate() {
    const cfg = updateConfig();
    if (!cfg.useStGitEndpoint) {
        // 不发起任何网络请求：无 git 能力的宿主会在该端点返回 500（Git handshake failed），
        //   宿主把它当「后端错误」弹窗 —— 因此默认不碰该端点，改为引导用户手动更新。
        return {
            ok: false, disabled: true,
            error: '已禁用宿主 Git 更新端点（无 git 的宿主会在该端点报「Git handshake failed」后端错误）。'
                + '如需由酒馆代更新，请在设定中开启「使用宿主 Git 更新端点」；否则请按仓库说明手动更新（本插件源码即发布物，覆盖目录文件即可）。',
        };
    }
    let r = await postJson('/api/extensions/update', { extensionName: extensionFolder(), global: false });
    if (!r.ok && isTransportFailure(r.error)) return { ok: false, error: String(r.error || 'Git 传输失败（网络不通）'), transport: true };
    if (!r.ok) r = await postJson('/api/extensions/update', { extensionName: extensionFolder(), global: true });
    if (!r.ok) return { ok: false, error: r.error || 'ST 更新端点不可用' };
    const d = r.data || {};
    return { ok: true, isUpToDate: d.isUpToDate === undefined ? null : !!d.isUpToDate, commit: String(d.shortCommitHash || ''), remoteUrl: String(d.remoteUrl || '') };
}

/**
 * 启动时按策略自动检查（首次启动必查；之后按间隔）。
 * @param {object} [opts] now / manual / silent
 * @returns {Promise<{ ran: boolean, reason: string, result?: object }>}
 */
export async function maybeAutoCheckOnStartup(opts) {
    const o = opts || {};
    const cfg = updateConfig();
    const st = readUpdateState();
    const now = Number(o.now) || Date.now();
    ensureFirstRun(now);
    const decision = shouldAutoCheck({
        manual: !!o.manual,
        autoUpdateCheck: cfg.autoUpdateCheck,
        startupCheckedAt: st.startupCheckedAt,
        lastCheckAt: st.lastCheckAt,
        intervalHours: cfg.intervalHours,
        now,
        hasHost: hasHost(),
    });
    if (!decision.run) return { ran: false, reason: decision.reason };
    let result;
    try {
        result = await runUpdateCheck({ manual: !!o.manual });
    } catch (e) {
        result = { ok: false, error: String((e && e.message) || e) };
    }
    const summary = summarizeCheck(result, now);
    writeUpdateState({ lastCheckAt: now, lastResult: summary, startupCheckedAt: st.startupCheckedAt || now });
    return { ran: true, reason: decision.reason, result, summary };
}

/** 状态文案（设置面板与 /ftt 共用） */
export function updateStatusText(result) {
    const r = result || readUpdateState().lastResult || null;
    if (!r) return '尚未检查';
    const text = updateReport(r);
    const at = Number(r.at) || 0;
    const when = at ? new Date(at).toLocaleString() : '';
    return (when ? when + ' · ' : '') + text;
}

/** 是否已有可用更新（供 UI 高亮） */
export function hasUpdate(result) {
    const r = result || readUpdateState().lastResult || null;
    if (!r || !r.ok) return false;
    if (r.status === 'newer') return true;                       // summarizeCheck 输出
    return !!(r.judge && r.judge.status === 'newer');            // runUpdateCheck 原始输出
}
