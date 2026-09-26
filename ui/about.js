// ============================================================
// ui/about.js —— **关于页（版本清单读取 + 清缓存 + 重载）**（B9-a）
//
// V1 出处（`src/FTT记忆组件-v1.206.js`）：
//   · 常量与读取：`ABOUT_JSON_PATHS`(~794)、`ABOUT_CACHE_KEY='fttAboutJson'`、`aboutFallback()`(~799)、
//     `aboutReadCache/aboutWriteCache`、`aboutCandidateUrls()`(~820)、`aboutFetchFns/aboutTryFetch`、
//     `aboutLoadJson(force)`(~854)、`aboutEnsureLoaded()`(~893)、`getAboutData/getAboutState`(~906)、`aboutSortDesc`(~909)
//   · 渲染：`aboutHtml()`(~25180~25234)
//   · 动作：`case 'aboutReload'`(~27126)、`case 'aboutClearCache'`(~27133)
//
// V2 适配（逐条 —— 本页是**原生扩展**，与 V1 的 iframe 脚本形态不同，取文件方式必须按扩展目录推导）：
//   ① 取文件路径：V1 直接按「相对路径」`fetch('FTT-memory-changelog.json')`（iframe 内相对**父页** base 解析）；
//      V2 是原生扩展（无 iframe），规范路径是**扩展目录的 HTTP 挂载路径**
//      `/scripts/extensions/<扩展目录>/FTT-memory-changelog.json`（`host/paths.js#extensionFolder()` 运行时推导，
//      与 `renderExtensionTemplateAsync`/扩展静态资源的挂载根一致，见 docs/P0-探针报告.md §1、
//      `core/constants.js#EXTENSION_FOLDER` 注释）。因此 V2 的候选顺序 = **扩展目录绝对路径优先**，
//      再保留 V1 同款的两条相对路径（相对**页面**解析，个别部署可能有效）作为兜底。
//   ② 不移植 V1 的 iframe 父页 base 兜底（`window.parent.location` / `D.location` 解析绝对地址）——
//      那是 iframe base 不一致导致的 404 的补丁；原生扩展没有该问题，且扩展目录路径已足够。
//   ③ 未读取到时**如实失败**：回退到 `aboutFallback()`（只说明读不到清单，**不伪造任何版本内容**），
//      并在文案里给出扩展目录路径（V1 给的是「与插件 JS 同目录」）。
//   ④ V1 原生缺陷 #1（重试风暴）：`aboutHtml()` 开头调 `aboutEnsureLoaded()`，而 cached/fail 态恒被判 stale
//      → 每次渲染都会立刻把状态置为 loading 并再发一轮读取（离线+有缓存时无界重试）。V2 加**重试间隔闸门**
//      （= 缓存 TTL 10 分钟，与 V1 `storeCacheTtl(true)` 默认值同值），状态文案与「打开本页自动重试」保持 V1 语义。
//   ⑤ V1 原生缺陷 #2（在途标志污染）：`aboutLoadJson` 的 `!fns.length` 分支在任何 `await` 之前 return，
//      而 `aboutLoading = (async()=>{…})()` 的赋值发生在 finally 之后 → 该分支走完后 `aboutLoading` 永久停留在
//      已 resolve 的旧 Promise，此后所有读取都返回那次 no-fetch 结果。V2 用「身份比对后再清」的写法修掉。
//   ⑥ `VERSION` 取 V2 自己的版本（V1 取 v1.206）；`aboutFallback()` 的 title/所在目录文案按 V2 形态改（见 docs/P8z 偏差表）。
// ============================================================
import { VERSION, DEFAULT_UPDATE_REPO, DEFAULT_UPDATE_BRANCH } from '../core/constants.js';
import { getSettings } from '../adapters/settings.js';
import { escHtml } from '../core/util.js';
import { extensionFolder } from '../host/paths.js';

const esc = (v) => escHtml(v == null ? '' : v);

/** V1 `ABOUT_JSON_PATHS`（逐字：相对路径候选） */
export const ABOUT_JSON_PATHS = ['FTT-memory-changelog.json', './FTT-memory-changelog.json'];
/** 版本清单文件名（V1 同值） */
export const ABOUT_FILE = 'FTT-memory-changelog.json';
/** V1 `ABOUT_CACHE_KEY`（localStorage 键，逐字） */
export const ABOUT_CACHE_KEY = 'fttAboutJson';
/** 缓存/重试 TTL：V1 由统一存储抽象的 cache 分类策略给出（默认 10 分钟） */
export const ABOUT_TTL_MS = 10 * 60 * 1000;

/** 已解析的版本清单（内存缓存，供「关于」页渲染） */
let aboutData = null;
/** 读取状态：idle|loading|ok|cached|fail */
let aboutState = { status: 'idle', ts: 0, from: '', error: '' };
/** 在途去重（自动获取与手动刷新共用同一 Promise；V1 `aboutLoading` 口径） */
let aboutLoading = null;
/** V2 新增：最近一次「自动重试」的时刻（防 V1 原生缺陷 #1 的渲染→重试风暴） */
let aboutLastAttemptAt = 0;
/** 宿主注入的钩子（重绘 / 存储读写），默认为 no-op + 浏览器 localStorage */
const aboutHooks = { rerender: () => undefined };

/** 注入关于页钩子（`rerender`：自动读取成功后重绘；测试/宿主可替换） */
export function setAboutHooks(next) {
    Object.assign(aboutHooks, next || {});
    return aboutHooks;
}

/** localStorage 视图（V1 同款判断：`window.localStorage` 存在即可） */
function ls() {
    try {
        const w = globalThis.window;
        return (w && w.localStorage) ? w.localStorage : null;
    } catch (e) { return null; }
}

/** 扩展目录的 HTTP 挂载根（`/scripts/extensions/<扩展目录>/`；推导不出时退回常量目录） */
export function aboutDirUrl() {
    const folder = (() => { try { return String(extensionFolder() || ''); } catch (e) { return ''; } })();
    return folder ? ('/scripts/extensions/' + folder + '/') : '';
}

/** 内嵌最小兜底：**只说明读不到清单**，不伪造版本内容（版本号取当前 VERSION） */
export function aboutFallback() {
    return {
        name: 'FTT记忆组件', title: 'SillyTavern 长期记忆扩展（V2 原生扩展）',
        version: VERSION, updatedAt: '', generatedAt: '', fallback: true,
        intro: {
            // v2.53.0：兜底文案只保留一句事实 —— 不再写「文件该放哪」这类实现说明（该块已不参与渲染）
            what: '未能读取版本更新清单（可能当前离线）。插件本体功能不受影响。',
            highlights: [], entries: [], notes: '',
        },
        changelog: [],
    };
}

/** 读本地缓存（V1 `aboutReadCache`：`{ts, data}` 且 `data.changelog` 必须为数组） */
export function aboutReadCache() {
    try {
        const s = ls();
        const raw = s && s.getItem(ABOUT_CACHE_KEY);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (o && o.data && Array.isArray(o.data.changelog)) return o;
    } catch (e) { /* 损坏缓存视为无 */ }
    return null;
}

/** 写本地缓存（V1 `aboutWriteCache`） */
export function aboutWriteCache(data) {
    try {
        const s = ls();
        if (s) s.setItem(ABOUT_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data }));
    } catch (e) { /* 配额/受限环境忽略 */ }
}

/**
 * 候选地址顺序（v2.53.0 起）：**代码库 raw 清单优先** → 扩展目录绝对路径 → V1 同款相对路径。
 * @returns {string[]}
 */
export function aboutCandidateUrls() {
    // v2.53.0（用户要求）：「版本更新**应该是代码库中的 json 文件**」——
    //   第一优先 = 代码库 raw 清单（`raw.githubusercontent.com/<repo>/<branch>/FTT-memory-changelog.json`，
    //   仓库/分支取自更新检查设置，默认常量与 `docs/更新检查机制.md` 一致）；其后才是扩展目录与相对路径
    //   （仅供离线/自建镜像兜底）。提示信息不再暴露这些实现细节，失败时只告诉用户「去哪看」。
    const out = [];
    const raw = aboutRepoRawUrl();
    if (raw) out.push(raw);
    const abs = aboutDirUrl();
    if (abs) out.push(abs + ABOUT_FILE);
    for (const p of ABOUT_JSON_PATHS) { if (out.indexOf(p) < 0) out.push(p); }
    return out;
}

/** 数据来源仓库（更新检查设置 → 常量兜底） */
function aboutRepo() {
    try { const s = getSettings() || {}; return String(s.updateRepo || DEFAULT_UPDATE_REPO || ''); } catch (e) { return String(DEFAULT_UPDATE_REPO || ''); }
}
/** 数据来源分支（更新检查设置 → 常量兜底） */
function aboutBranch() {
    try { const s = getSettings() || {}; return String(s.updateBranch || DEFAULT_UPDATE_BRANCH || 'main'); } catch (e) { return String(DEFAULT_UPDATE_BRANCH || 'main'); }
}

/** 代码库 raw 清单地址（仓库/分支来自更新检查设置；常量兜底） */
export function aboutRepoRawUrl() {
    try {
        const s = (typeof globalThis !== 'undefined' && globalThis.__fttAboutRepo) ? globalThis.__fttAboutRepo : null;
        const repo = String((s && s.repo) || aboutRepo() || '').trim();     // 形如 owner/name 或完整 URL
        const branch = String((s && s.branch) || aboutBranch() || 'main').trim();
        if (!repo) return '';
        const m = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/i.exec(repo.replace(/#.*$/, ''));
        const slug = m ? (m[1] + '/' + m[2]) : repo;
        if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) return '';
        return 'https://raw.githubusercontent.com/' + slug + '/' + branch + '/' + ABOUT_FILE;
    } catch (e) { return ''; }
}
/** 数据来源仓库页（失败提示里给用户「去哪看」） */
export function aboutRepoPageUrl() {
    const slug = (() => {
        try { const r = String(aboutRepo() || ''); const m = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/i.exec(r); return m ? (m[1] + '/' + m[2]) : (/^[\w.-]+\/[\w.-]+$/.test(r) ? r : ''); } catch (e) { return ''; }
    })();
    return slug ? ('https://github.com/' + slug) : '';
}

/** 可用 fetch 列表（V1 依次试父页 fetch 与本环境 fetch；V2 只有本环境一个） */
export function aboutFetchFns() {
    const arr = [];
    try { if (typeof globalThis.fetch === 'function') arr.push(globalThis.fetch); } catch (e) { /* 无 fetch */ }
    return arr;
}

/** 单地址尝试（V1 `aboutTryFetch` 逐字：6s 超时 + no-store + JSON 解析 + `changelog` 必须是数组） */
async function aboutTryFetch(f, url) {
    const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }, 6000) : null;
    try {
        const resp = await f(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
        if (!resp || !resp.ok) return { err: 'http-' + ((resp && resp.status) || '?') };
        const txt = await resp.text();
        const obj = JSON.parse(txt);
        if (!obj || !Array.isArray(obj.changelog)) return { err: 'bad-json' };
        return { ok: obj };
    } catch (e) { return { err: String((e && e.message) || e) }; } finally { if (timer) clearTimeout(timer); }
}

/**
 * 读取版本清单（`force` 时忽略内存缓存；两轮 × 多地址，第二轮带 cache-buster 规避旧缓存）。
 * @returns {Promise<{ok:boolean, data:object, status:string, from?:string, error?:string}>}
 */
export async function aboutLoadJson(force) {
    if (!force && aboutData && !aboutData.fallback) return { ok: true, data: aboutData, status: aboutState.status };
    if (aboutLoading) return aboutLoading;
    aboutState = { status: 'loading', ts: Date.now(), from: '', error: '' };
    aboutLastAttemptAt = Date.now();
    const p = (async () => {
        const fns = aboutFetchFns();
        const urls = aboutCandidateUrls();
        let lastErr = '';
        if (!fns.length) {
            const c = aboutReadCache();
            aboutData = c ? c.data : aboutFallback();
            aboutState = { status: c ? 'cached' : 'fail', ts: c ? c.ts : Date.now(), from: '', error: 'no-fetch' };
            return { ok: !!c, data: aboutData, status: aboutState.status, error: aboutState.error };
        }
        for (let round = 0; round < 2; round++) {
            for (const f of fns) {
                for (const base of urls) {
                    const u = round === 0 ? base : (base + (base.indexOf('?') >= 0 ? '&' : '?') + 'ftt=' + Date.now());
                    const r = await aboutTryFetch(f, u);
                    if (r && r.ok) {
                        aboutData = r.ok;
                        aboutState = { status: 'ok', ts: Date.now(), from: u, error: '' };
                        aboutWriteCache(r.ok);
                        return { ok: true, data: r.ok, status: 'ok', from: u };
                    }
                    lastErr = (r && r.err) || lastErr;
                }
            }
        }
        const c = aboutReadCache();
        aboutData = c ? c.data : aboutFallback();
        aboutState = { status: c ? 'cached' : 'fail', ts: c ? c.ts : Date.now(), from: '', error: lastErr };
        return { ok: !!c, data: aboutData, status: aboutState.status, error: lastErr };
    })();
    aboutLoading = p;
    // V2 适配⑤：身份比对后再清 —— 而非在 async 体内 `finally` 里无条件清空
    //   （V1 的 `aboutLoading = (async()=>{…})()` 会在「无 await 的早退分支」被 finally 抢先清空成 null 后又被赋值覆盖，
    //   导致在途标志永久污染：此后所有读取都返回那次结果）
    void p.then(
        () => { if (aboutLoading === p) aboutLoading = null; },
        () => { if (aboutLoading === p) aboutLoading = null; },
    );
    return p;
}

/**
 * 打开「关于」页自动获取：未取到/兜底 或 超过缓存 TTL 未更新 → 后台拉取一次，成功后重绘。
 * V2 适配④：自动重试带最小间隔（= TTL），避免 V1 的「渲染 → 立刻 loading → 失败 → 再渲染」无界风暴。
 * @returns {boolean} 是否已发起后台读取
 */
export function aboutEnsureLoaded() {
    try {
        const stale = !aboutState || aboutState.status !== 'ok' || (Date.now() - (aboutState.ts || 0)) > ABOUT_TTL_MS;
        if ((!aboutData || aboutData.fallback || stale) === false) return false;
        if (aboutLoading) return false;
        if (aboutLastAttemptAt && (Date.now() - aboutLastAttemptAt) < ABOUT_TTL_MS) return false;
        aboutLoadJson(true).then((r) => {
            try { if (r && r.ok) aboutHooks.rerender(); } catch (e) { /* 重绘失败不影响数据 */ }
        }).catch(() => { /* 静默 */ });
        return true;
    } catch (e) { return false; }
}

/** 已解析的版本清单（V1 `getAboutData`） */
export function getAboutData() { return aboutData; }
/** 读取状态（V1 `getAboutState`） */
export function getAboutState() { return aboutState; }

/** 版本号倒序（V1 `aboutSortDesc` 逐字：`v?主.次[.补]`，非法版本号按 0.0.0 且保持稳定序） */
export function aboutSortDesc(list) {
    const num = (v) => { const m = String(v || '').match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/); return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : [0, 0, 0]; };
    return (Array.isArray(list) ? list.slice() : []).sort((a, b) => {
        const A = num(a && a.version), B = num(b && b.version);
        for (let k = 0; k < 3; k++) if (A[k] !== B[k]) return B[k] - A[k];
        return 0;
    });
}

/** 清本地缓存并复位内存态（V1 `case 'aboutClearCache'`：`removeItem('fttAboutJson')` + data=null + state=idle） */
export function aboutClearCache() {
    let removed = false;
    try { const s = ls(); if (s) { removed = s.getItem(ABOUT_CACHE_KEY) !== null; s.removeItem(ABOUT_CACHE_KEY); } } catch (e) { /* 忽略 */ }
    aboutData = null;
    aboutState = { status: 'idle', ts: 0, from: '', error: '' };
    aboutLastAttemptAt = 0;
    aboutLoading = null;
    return removed;
}

/** 状态行文案（V1 `aboutHtml()` 内的 statusText 分支；fail 分支改指扩展目录 —— V2 适配③） */
export function aboutStatusText() {
    const d = aboutData;
    const st = aboutState || { status: 'idle', ts: 0, from: '', error: '' };
    const list = d ? aboutSortDesc(d.changelog) : [];
    // v2.53.0（用户要求）：提示只保留三态，且失败时**告诉用户去哪看**（不扩散实现细节）
    if (st.status === 'loading') return '获取中…';
    if (st.status === 'ok') return '已获取版本更新 · 共 ' + list.length + ' 个版本';
    if (st.status === 'cached') return '已获取版本更新 · 共 ' + list.length + ' 个版本（本次未联网，使用上次缓存）';
    if (st.status === 'fail') {
        const page = aboutRepoPageUrl() || aboutDirUrl() || '';
        return '无法获取版本更新' + (page ? (' —— 可在代码库查看：' + page) : ' —— 可在代码库查看版本更新');
    }
    return '获取中…';
}

/**
 * 关于页正文（V1 `aboutHtml()` 逐字结构：关于节 / 它是什么节 / 版本更新节）
 * @returns {string}
 */
export function aboutHtml() {
    try { aboutEnsureLoaded(); } catch (e) { /* 自动读取失败不影响渲染 */ }
    const d = aboutData || null;
    const isFallback = !!(d && d.fallback);
    const list = d ? aboutSortDesc(d.changelog) : [];
    const statusText = aboutStatusText();
    // 兜底数据（读不到清单）里没有真实版本信息 → 不显示「最新版本」，也不报版本不一致
    const mismatch = !!(!isFallback && d && d.version && String(d.version) !== String(VERSION));
    const intro = (d && d.intro) ? d.intro : {};
    const repoPage = aboutRepoPageUrl();
    const h = [];
    // ① 关于（一句话定位 + 版本 + 重新获取 + 状态）—— 不再平铺开发/历史说明
    h.push('<div class="ftt-section"><div class="ftt-sec-title">关于 · FTT记忆组件</div>'
        + '<div class="ftt-my-2"><b>FTT记忆组件</b> <span class="ftt-muted">SillyTavern 记忆扩展：自动提取 / 注入 / 维护剧情记忆</span></div>'
        + '<div class="ftt-muted">当前版本 <b>' + esc(VERSION) + '</b>'
        + (d && d.version && !isFallback ? (' · 最新版本 ' + esc(String(d.version)) + (d.updatedAt ? ('（' + esc(String(d.updatedAt)) + '）') : '')) : '')
        + (repoPage ? (' · <a href="' + esc(repoPage) + '" target="_blank" rel="noopener">代码库</a>') : '') + '</div>'
        + (mismatch ? '<div class="ftt-note ftt-note-warn ftt-mt-4">⚠️ 代码库清单（' + esc(String(d.version)) + '）与本插件版本（' + esc(VERSION) + '）不一致，请更新插件。</div>' : '')
        + '<div class="ftt-row ftt-mt-2"><button class="ftt-btn ftt-sm" data-ftt-action="aboutReload">🔄 重新获取</button></div>'
        + '<div class="ftt-hint ftt-mt-4" data-ftt-about-status>' + esc(statusText) + '</div>'
        + '</div>');
    // ② 功能要点（只留一句「它是什么」+ 要点列表；入口/用法与开发说明不再展示）
    //    v2.53.0：兜底数据（读不到清单）里带的是「文件应放哪」这类实现说明 —— 一律不渲染，
    //    失败信息只由状态行给出（「无法获取版本更新 —— 可在代码库查看：<地址>」）。
    const highlights = Array.isArray(intro.highlights) ? intro.highlights : [];
    if (!isFallback && (intro.what || highlights.length)) {
        h.push('<div class="ftt-section"><div class="ftt-sec-title">功能</div>'
            + (intro.what ? '<div>' + esc(String(intro.what)) + '</div>' : '')
            + (highlights.length ? '<ul class="ftt-ul">' + highlights.map((x) => '<li>' + esc(String(x)) + '</li>').join('') + '</ul>' : '')
            + '</div>');
    }
    // ③ 版本更新（倒序；每条只出 版本/日期/标题 + 前 3 条要点）
    h.push('<div class="ftt-section"><div class="ftt-sec-title">版本更新（最新在最前）</div>');
    if (!list.length) {
        h.push('<div class="ftt-empty">' + esc(statusText) + '</div>');
    } else {
        h.push(list.map((e) => {
            const isCur = String(e.version) === String(VERSION);
            const pts = (Array.isArray(e.points) ? e.points : []).slice(0, 3);
            return '<div class="ftt-item" style="flex-wrap:wrap"><div class="ftt-item-main ftt-flex-1">'
                + '<div><b class="' + (isCur ? 'ftt-dot-ok' : 'ftt-tags-inline') + '">' + esc(String(e.version || '')) + '</b>'
                + '<span class="ftt-muted"> ' + esc(String(e.date || '')) + (isCur ? ' · 当前版本' : '') + '</span></div>'
                + (e.title ? '<div class="ftt-desc">' + esc(String(e.title)) + '</div>' : '')
                + (pts.length ? '<ul class="ftt-ul ftt-sub">' + pts.map((x) => '<li>' + esc(String(x)) + '</li>').join('') + '</ul>' : '')
                + '</div></div>';
        }).join('\n'));
    }
    h.push('</div>');
    return h.join('\n');
}

/** 本地缓冲统计（数据管理页展示，供用户决定是否清理）：版本清单缓存的条数/大小/时间 */
export function aboutCacheStats() {
    try {
        const s = ls();
        const raw = s ? s.getItem(ABOUT_CACHE_KEY) : null;
        const bytes = raw ? String(raw).length : 0;
        let n = 0;
        try { const o = raw ? JSON.parse(raw) : null; n = (o && o.data && Array.isArray(o.data.changelog)) ? o.data.changelog.length : 0; } catch (e) { n = 0; }
        return { cached: !!raw, versions: n, bytes: bytes };
    } catch (e) { return { cached: false, versions: 0, bytes: 0 }; }
}

/**
 * 关于页动作（V1 同名：`aboutReload` / `aboutClearCache`）
 * @returns {Promise<{ok:boolean, action:string, note:string, detail?:object}>}
 */
export async function aboutAction(action, payload) {
    const a = String(action || '');
    try {
        if (a === 'aboutReload') {
            // v2.53.0 修复（用户报告「重新获取设计有错误」）：**强制重取** ——
            //   清掉在途标志与节流时间（旧实现命中 `aboutLoading` 时直接返回上一轮的 Promise，
            //   用户点「重新获取」看到的仍是旧结果；命中 TTL 节流时页面也不会重绘）。
            aboutLastAttemptAt = 0;
            aboutLoading = null;
            const ar = await aboutLoadJson(true);
            const n = ((ar && ar.data && ar.data.changelog) || []).length;
            // v2.53.0 提示口径（用户要求：只说明结果 + 失败时告诉用户去哪看，不扩散实现细节）：
            //   直接用状态行文案（ok / cached / fail 三态），保证动作回报与页面提示永远同源。
            const note = aboutStatusText();
            return { ok: !!(ar && ar.ok), action: a, note: note, detail: ar, versions: n };
        }
        if (a === 'aboutClearCache') {
            const removed = aboutClearCache();
            return { ok: true, action: a, note: '已清除版本清单缓存（下次打开「关于」页会重新从代码库获取）', removed: removed };
        }
        return { ok: false, action: a, note: '未知关于页动作：' + a };
    } catch (e) {
        return { ok: false, action: a, note: '关于页动作失败：' + String((e && e.message) || e), error: String((e && e.message) || e) };
    }
}

/** 关于页动作名判定（供面板分发；与 V1 同名逐字一致） */
export const ABOUT_ACTIONS = Object.freeze(['aboutReload', 'aboutClearCache']);

/** 关于页只读诊断（测试/排障用） */
export function aboutInfo() {
    const d = aboutData;
    return {
        status: aboutState.status, ts: Number(aboutState.ts) || 0, from: String(aboutState.from || ''), error: String(aboutState.error || ''),
        hasData: !!d, fallback: !!(d && d.fallback), versions: d && Array.isArray(d.changelog) ? d.changelog.length : 0,
        cached: !!aboutReadCache(), dir: aboutDirUrl(), candidates: aboutCandidateUrls(), loading: !!aboutLoading,
    };
}
