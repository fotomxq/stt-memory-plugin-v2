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
