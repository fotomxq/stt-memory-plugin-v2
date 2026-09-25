// ============================================================
// core/update.js —— 更新检查纯逻辑（零宿主依赖）
// 事实源：docs/P0-探针报告.md §1（ST 原生更新端点：git 检测 + git pull）
// 职责：版本比较 / 是否该自动检查 / 仓库地址 → raw 地址 / 更新要点提取 / 状态文案。
// ============================================================

/** 解析版本号：'v2.1.3' / '2.1.3-p0' → { parts:[2,1,3], pre:'p0' } */
export function parseVersion(v) {
    const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
    const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?$/);
    if (!m) return null;
    return { parts: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre: m[4] ? String(m[4]) : '' };
}

/** 版本比较：a<b → -1，相等 → 0，a>b → 1；无法解析 → null */
export function compareVersions(a, b) {
    const A = parseVersion(a), B = parseVersion(b);
    if (!A || !B) return null;
    for (let i = 0; i < 3; i++) {
        if (A.parts[i] !== B.parts[i]) return A.parts[i] < B.parts[i] ? -1 : 1;
    }
    if (A.pre === B.pre) return 0;
    if (!A.pre) return 1;          // 正式版 > 预发布
    if (!B.pre) return -1;
    return A.pre < B.pre ? -1 : 1;
}

/**
 * 判定更新状态。
 * @returns {{ status: 'newer'|'same'|'older'|'unknown', remoteNewer: boolean, current: string, remote: string }}
 */
export function judgeUpdate(current, remote) {
    const c = compareVersions(current, remote);
    if (c === null) return { status: 'unknown', remoteNewer: false, current: String(current || ''), remote: String(remote || '') };
    if (c < 0) return { status: 'newer', remoteNewer: true, current: String(current), remote: String(remote) };
    if (c > 0) return { status: 'older', remoteNewer: false, current: String(current), remote: String(remote) };
    return { status: 'same', remoteNewer: false, current: String(current), remote: String(remote) };
}

// ============================================================
// 启动自动检查的**内置延迟**（v2.46.0，用户要求：「启动时自动检查更新，内置延迟几秒后执行，避免插件异常」）
//
// 为什么要延迟：插件加载期与酒馆自身的启动流程（事件源绑定、聊天载入、其它扩展初始化、本插件的存储对账）
//   高度重叠。此时立刻发起更新检查会：
//     ① 与启动期网络/存储竞争（实测在弱网或大体量存档下会拖慢首屏与「存储对账」）；
//     ② 若宿主把 `POST /api/extensions/version` 桥接为 git handshake，可能**抢先弹出后端错误**，
//        用户看到的是「插件异常」而不是「更新检查失败」。
//   因此自动路径统一**延迟 `UPDATE_STARTUP_DELAY_MS` 后**再跑；**手动检查（用户点击）不延迟**。
// 约定：延迟只影响「何时开始」，不影响「是否该查」（策略判定仍在 `shouldAutoCheck` 内，手工/首次/间隔语义不变）。
// ============================================================

/** 启动自动检查的默认延迟（毫秒）——4 秒：足够让酒馆完成启动与首屏，又不至于让用户等太久 */
export const UPDATE_STARTUP_DELAY_MS = 4000;
/** 延迟上限（毫秒）：即使调用方给了很大的值也不至于"永不检查" */
export const UPDATE_STARTUP_DELAY_MAX_MS = 60000;

/**
 * 计算启动检查的延迟方案（纯函数，便于单测与诊断）。
 * · 手动（`manual: true`）→ 0（用户点了就立刻查）；
 * · 显式 `delayMs`（数字，含 0）→ 夹在 `0..UPDATE_STARTUP_DELAY_MAX_MS`；
 * · 其余（启动自动路径）→ 默认 `UPDATE_STARTUP_DELAY_MS`。
 * @param {object} [opts] manual / delayMs
 * @returns {{ delayMs: number, reason: 'manual'|'explicit'|'startup' }}
 */
export function startupDelayPlan(opts) {
    const o = opts || {};
    if (o.manual) return { delayMs: 0, reason: 'manual' };
    if (o.delayMs !== undefined && o.delayMs !== null && o.delayMs !== '' && Number.isFinite(Number(o.delayMs))) {
        const n = Math.max(0, Math.min(UPDATE_STARTUP_DELAY_MAX_MS, Math.floor(Number(o.delayMs))));
        return { delayMs: n, reason: 'explicit' };
    }
    return { delayMs: UPDATE_STARTUP_DELAY_MS, reason: 'startup' };
}

/**
 * 是否应执行自动检查（首次启动 / 间隔到期）。
 * @param {object} p autoUpdateCheck / lastCheckAt / startupCheckedAt / intervalHours / now / hasHost
 * @returns {{ run: boolean, reason: string }}
 */
export function shouldAutoCheck(p) {
    const o = p || {};
    if (o.manual) return { run: true, reason: 'manual' };
    if (o.hasHost === false) return { run: false, reason: 'no-host' };
    if (o.autoUpdateCheck === false) return { run: false, reason: 'disabled' };
    const now = Number(o.now) || Date.now();
    if (!Number(o.startupCheckedAt)) return { run: true, reason: 'first-startup' };
    const last = Number(o.lastCheckAt) || 0;
    const hours = Number(o.intervalHours) > 0 ? Number(o.intervalHours) : 24;
    if (!last || now - last >= hours * 3600 * 1000) return { run: true, reason: 'interval-elapsed' };
    return { run: false, reason: 'recent' };
}

/** 从 CHANGELOG 文本提取首个版本段落（标题 + 前 N 条要点） */
export function extractChangelogHead(md, maxPoints) {
    const lines = String(md == null ? '' : md).split(/\r?\n/);
    const n = Number(maxPoints) > 0 ? Number(maxPoints) : 5;
    const out = { version: '', date: '', points: [] };
    let inHead = false;
    for (const raw of lines) {
        const line = String(raw || '').trim();
        // 版本号兼容两位（如 v1.206）与三位（如 v2.0.0）写法
        const h = line.match(/^##\s+v?(\d+(?:\.\d+){1,2})\s*[（(]([^）)]*)[）)]/);
        if (h) {
            if (inHead) break;
            out.version = h[1];
            out.date = String(h[2] || '').trim();
            inHead = true;
            continue;
        }
        if (!inHead) continue;
        if (/^##\s/.test(line)) break;
        if (/^[-*]\s+/.test(line) && out.points.length < n) {
            out.points.push(line.replace(/^[-*]\s+/, '').replace(/\*\*/g, '').replace(/`/g, '').slice(0, 160));
        }
    }
    return out;
}

/**
 * 仓库地址 → 原始文件地址（manifest / CHANGELOG）。
 * 支持 github.com 与 gitee.com；其它域名返回 null（调用方只用 ST 端点）。
 */
export function repoRawUrls(repoUrl, branch) {
    const url = String(repoUrl == null ? '' : repoUrl).trim().replace(/\.git$/, '').replace(/\/+$/, '');
    const br = String(branch == null || branch === '' ? 'main' : branch).trim();
    const gh = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
    if (gh) {
        const base = 'https://raw.githubusercontent.com/' + gh[1] + '/' + gh[2] + '/' + br;
        return { host: 'github', owner: gh[1], repo: gh[2], branch: br, manifest: base + '/manifest.json', changelog: base + '/CHANGELOG.md' };
    }
    const ge = url.match(/^https?:\/\/gitee\.com\/([^/]+)\/([^/]+)$/i);
    if (ge) {
        const base = 'https://gitee.com/' + ge[1] + '/' + ge[2] + '/raw/' + br;
        return { host: 'gitee', owner: ge[1], repo: ge[2], branch: br, manifest: base + '/manifest.json', changelog: base + '/CHANGELOG.md' };
    }
    if (/^https?:\/\//i.test(url) || /^[\w.-]+\/[\w.-]+$/.test(url)) {
        return { host: 'other', owner: '', repo: '', branch: br, manifest: null, changelog: null };
    }
    return { host: '', owner: '', repo: '', branch: br, manifest: null, changelog: null };
}

/** 状态文案（设置面板状态行 / /ftt 输出共用；纯函数便于断言） */
export function updateReport(result) {
    const r = result || {};
    if (!r.ok) return '检查更新失败：' + (r.error || '未知原因');
    // 兼容两种结果结构：runUpdateCheck 原始输出（judge）/ summarizeCheck 摘要（status/current/remote）
    const j = r.judge || { status: r.status || 'unknown', current: r.current || '', remote: r.remote || '', commitOnly: !!r.commitOnly };
    if (j.status === 'newer' && j.commitOnly) return '远端有更新（Git 校验 · 同版本新提交）' + (r.remoteCommit ? ' · ' + String(r.remoteCommit).slice(0, 7) : '');
    if (j.status === 'newer') return '发现新版本 ' + j.remote + '（当前 ' + j.current + '）' + (r.via ? ' · 来源 ' + r.via : '');
    if (j.status === 'same') return '已是最新版本 ' + j.current + (r.via ? ' · 来源 ' + r.via : '');
    if (j.status === 'older') return '本地版本（' + j.current + '）高于远端（' + j.remote + '）—— 可能是开发版';
    // 版本号判不出时，回退 ST 端点的 git 真值
    if (r.isUpToDate === true) return '已是最新（Git 校验）' + (r.via ? ' · 来源 ' + r.via : '');
    if (r.isUpToDate === false) return '远端有更新（Git 校验）' + (r.remoteCommit ? ' · ' + String(r.remoteCommit).slice(0, 7) : '') + (r.via ? ' · 来源 ' + r.via : '');
    return '无法判定版本：本地 ' + String(j.current || '—') + '，远端 ' + String(j.remote || '—');
}

/** 检查结果摘要（供调试导出与通知） */
export function summarizeCheck(result, now) {
    const r = result || {};
    return {
        at: Number(now) || Date.now(),
        ok: !!r.ok,
        via: r.via || '',
        current: (r.judge && r.judge.current) || '',
        remote: (r.judge && r.judge.remote) || '',
        status: (r.judge && r.judge.status) || 'unknown',
        remoteCommit: r.remoteCommit || '',
        isUpToDate: r.isUpToDate === undefined ? null : !!r.isUpToDate,
        points: Array.isArray(r.points) ? r.points.slice(0, 5) : [],
        commitOnly: !!(r.judge && r.judge.commitOnly),
        // 宿主 Git 端点是否启用（默认关；便于诊断「为何没有 git 校验」）
        stEndpoint: r.stEndpoint || '',
        error: r.error || '',
    };
}
