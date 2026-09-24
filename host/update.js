// ============================================================
// host/update.js —— 更新检查与更新执行（Git 通道）
// 事实源：docs/P0-探针报告.md §1/§3 ——
//   ① 首选 ST 原生端点（git 真值）：POST /api/extensions/version（isUpToDate / commit）
//                                       POST /api/extensions/update（显式更新，仅用户触发）
//   ② 回退远端 manifest/CHANGELOG（仅用于显示版本号与更新要点；不写任何文件、不执行远端代码）
// 约定：检查失败一律静默（只记录），绝不阻塞启动/发送/提取；自动路径永不调用 update 端点。
// ============================================================
import { VERSION, EXTENSION_FOLDER, DEFAULT_UPDATE_REPO, DEFAULT_UPDATE_BRANCH, DEFAULT_UPDATE_INTERVAL_HOURS } from '../core/constants.js';
import { judgeUpdate, repoRawUrls, shouldAutoCheck, updateReport, summarizeCheck, extractChangelogHead } from '../core/update.js';
import { getCtx, hasHost } from './st-api.js';
import { getSettings, setSetting } from '../adapters/settings.js';
import { readUpdateState, writeUpdateState, ensureFirstRun } from '../adapters/update-state.js';

/** 当前更新配置（设置项优先，缺省用常量） */
export function updateConfig() {
    const s = getSettings();
    return {
        autoUpdateCheck: s.autoUpdateCheck !== false,
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
        return { ok: false, status, error: 'HTTP ' + status };
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
export async function checkViaStEndpoint() {
    const body = { extensionName: EXTENSION_FOLDER, global: false };
    let r = await postJson('/api/extensions/version', body);
    if (!r.ok) r = await postJson('/api/extensions/version', { extensionName: EXTENSION_FOLDER, global: true });
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

    const ep = await checkViaStEndpoint();
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
            out.error = rm.error || ep.error || '检查失败';
        } else {
            out.remotePointsError = rm.error || '';
        }
    }
    return out;
}

/** 显式执行 ST 更新（只有用户点击才会调用；自动路径永不调用） */
export async function runStUpdate() {
    let r = await postJson('/api/extensions/update', { extensionName: EXTENSION_FOLDER, global: false });
    if (!r.ok) r = await postJson('/api/extensions/update', { extensionName: EXTENSION_FOLDER, global: true });
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
