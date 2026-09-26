// ============================================================
// 单元测试 · v2.53.0「关于页：从代码库取版本清单 + 言简意赅 + 缓冲清理迁到数据管理」
//
// 用户报告（v2.53.0 三条）：
//   ① 「版本更新应该是**代码库中的 json 文件**」—— 旧实现首候选是扩展目录/相对路径，代码库清单不在候选里；
//   ② 「『关于·FTT记忆组件』**重新获取**设计有错误」—— 旧 `aboutReload` 命中在途 Promise / TTL 节流时直接返回旧结果；
//   ③ 「关于页大量历史/文档提示需言简意赅，不扩散开发内容」+「清理本地缓冲应移到数据管理，并展示缓冲统计」。
//
// 本测试是 **V2 契约测试**（不是 V1 HTML 逐字对照）：`tests/fixtures/v1-golden-about.json` 仍是 V1 v1.206 的
//   原始证据（docs 引用保留），但 V2 在以下 4 点**有意偏离** V1，故不再逐字比对：
//   ① 候选顺序 = 代码库 raw 优先（V1 只有相对路径）；② 状态文案收敛为三态（V1 带来源路径/时间戳/emoji）；
//   ③ 「关于」页不渲染开发/历史块（V1 放「入口与用法 / 配置键数 / 缓存 TTL / 扩展目录」等）；
//   ④ 「清理本地缓冲」不在关于页，迁至 设定 → 数据管理（带条数/字节统计，见 docs/P10q）。
// 覆盖：C 候选与常量 ｜ L 读取/缓存/失败三态 ｜ R 「重新获取」强制重取与清缓存动作 ｜ H 渲染精简 ｜ B 缓冲统计与数据页。
// 运行：node tests/unit/about-golden.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setKernelState } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import {
    ABOUT_FILE, ABOUT_JSON_PATHS, ABOUT_CACHE_KEY, ABOUT_TTL_MS,
    aboutCandidateUrls, aboutRepoRawUrl, aboutRepoPageUrl, aboutDirUrl,
    aboutLoadJson, aboutSortDesc, aboutClearCache, aboutWriteCache, aboutReadCache,
    aboutStatusText, aboutHtml, aboutAction, aboutCacheStats, aboutInfo,
    getAboutData, getAboutState, setAboutHooks,
} from '../../ui/about.js';
import { settingsPageHtml } from '../../ui/settings-pages.js';
import { VERSION } from '../../core/constants.js';

const R = makeReporter('about v2.53.0 关于页：代码库清单 / 强制重取 / 精简渲染 / 缓冲清理');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);

// ---- 宿主与 localStorage 桩 ----
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
const host = makeHost({});
installGlobalHost(host, doc);
setKernelState(emptyState());

const lsMap = new Map();
const ls = {
    getItem: (k) => (lsMap.has(String(k)) ? lsMap.get(String(k)) : null),
    setItem: (k, v) => { lsMap.set(String(k), String(v)); },
    removeItem: (k) => { lsMap.delete(String(k)); },
    clear: () => lsMap.clear(),
    key: (i) => Array.from(lsMap.keys())[i] || null,
    get length() { return lsMap.size; },
};
const keepWin = globalThis.window;
globalThis.window = Object.assign({}, globalThis.window, { localStorage: ls });

const REPO_PAGE = 'https://github.com/fotomxq/stt-memory-plugin-v2';
const REPO_RAW = 'https://raw.githubusercontent.com/fotomxq/stt-memory-plugin-v2/main/FTT-memory-changelog.json';
const EXT_DIR = '/scripts/extensions/third-party/ftt-memory-v2/';

const DOC = {
    name: 'FTT记忆组件', version: VERSION, updatedAt: '2026-10-01',
    intro: { what: 'SillyTavern 记忆扩展', highlights: ['自动提取', '自动注入'] },
    changelog: [
        { version: '2.51.0', date: '2026-09-01', title: '时钟改版', points: ['情节唯一可信', '去掉巡检'] },
        { version: '2.53.0', date: '2026-10-01', title: '关于页', points: ['a', 'b', 'c', 'd', 'e'] },
        { version: '2.52.0', date: '2026-09-20', title: '总览精简', points: ['管线状态'] },
    ],
};

/** 仓库里真实随发布的版本清单（由 CHANGELOG.md 生成；用于「关于页 ↔ 部署物」契约） */
const REAL_TEXT = readFileSync(new URL('../../FTT-memory-changelog.json', import.meta.url), 'utf8');
const REAL = JSON.parse(REAL_TEXT);

/** 可编排的 fetch 桩：记录每次请求 URL；`mode` 控制响应 */
const fetchLog = { urls: [], mode: 'ok' };
const unFetch = installGlobalFetch((url) => {
    fetchLog.urls.push(String(url));
    if (fetchLog.mode === 'real') return { status: 200, text: REAL_TEXT };
    if (fetchLog.mode === 'ok') return { status: 200, text: J(DOC) };
    if (fetchLog.mode === 'bad-json') return { status: 200, text: 'not-json' };
    if (fetchLog.mode === 'no-array') return { status: 200, text: J({ version: '9.9.9' }) };
    return { status: 404, body: {} };
});
const resetFetch = (mode) => { fetchLog.urls = []; fetchLog.mode = mode || 'ok'; };

// ---- C 组：候选地址与常量契约 ----
A('C1 常量与 V1 同值：文件名 / 缓存键 / 相对路径候选 / TTL', ABOUT_FILE === 'FTT-memory-changelog.json'
    && ABOUT_CACHE_KEY === 'fttAboutJson'
    && J(ABOUT_JSON_PATHS) === J(['FTT-memory-changelog.json', './FTT-memory-changelog.json'])
    && ABOUT_TTL_MS === 600000, J({ file: ABOUT_FILE, key: ABOUT_CACHE_KEY, paths: ABOUT_JSON_PATHS, ttl: ABOUT_TTL_MS }));

A('C2 代码库 raw 清单 = 第一候选（用户要求「版本更新应取代码库中的 json 文件」）', (() => {
    const c = aboutCandidateUrls();
    return aboutRepoRawUrl() === REPO_RAW && c[0] === REPO_RAW;
})(), J(aboutCandidateUrls()));

A('C3 兜底候选仍在且不重复：扩展目录 → V1 相对路径', (() => {
    const c = aboutCandidateUrls();
    const dir = aboutDirUrl();
    const noDup = c.length === new Set(c).size;
    const hasRel = c.indexOf('FTT-memory-changelog.json') >= 0 && c.indexOf('./FTT-memory-changelog.json') >= 0;
    return noDup && hasRel && (dir ? c.indexOf(dir + ABOUT_FILE) > 0 : true);
})(), J(aboutCandidateUrls()));

A('C4 代码库页面地址可用于失败提示的「去哪看」', aboutRepoPageUrl() === REPO_PAGE
    && aboutRepoRawUrl().indexOf('raw.githubusercontent.com/fotomxq/stt-memory-plugin-v2/main/') >= 0,
    aboutRepoPageUrl());

A('C5 仓库设置可覆写（HTTPS / SSH / slug 形态都归一为 owner/name@branch）', (() => {
    const out = [];
    for (const repo of ['https://github.com/foo/bar', 'git@github.com:foo/bar.git', 'foo/bar']) {
        globalThis.__fttAboutRepo = { repo: repo, branch: 'dev' };
        out.push(aboutRepoRawUrl());
    }
    delete globalThis.__fttAboutRepo;
    return J(out) === J([
        'https://raw.githubusercontent.com/foo/bar/dev/FTT-memory-changelog.json',
        'https://raw.githubusercontent.com/foo/bar/dev/FTT-memory-changelog.json',
        'https://raw.githubusercontent.com/foo/bar/dev/FTT-memory-changelog.json',
    ]) && aboutRepoRawUrl() === REPO_RAW;
})(), '见断言');

A('C6 aboutSortDesc：版本倒序、非法版本按 0.0.0、入参不被修改', (() => {
    const src = [{ version: '2.9.0' }, { version: 'bad' }, { version: '2.10.0' }, { version: 'v2.10.1' }, {}];
    const before = J(src);
    const got = aboutSortDesc(src).map((e) => e.version);
    return J(got) === J(['v2.10.1', '2.10.0', '2.9.0', 'bad', null])
        && J(src) === before;
})(), '(见断言)');

// ---- L 组：读取 / 缓存 / 三态文案 ----
await (async () => {
    aboutClearCache();
    resetFetch('ok');
    const r = await aboutLoadJson(true);
    A('L1 成功：ok / 3 个版本 / 来源为代码库 raw / 写本地缓存', r.ok === true && (r.data.changelog || []).length === 3
        && r.from === REPO_RAW && getAboutState().status === 'ok'
        && ls.getItem(ABOUT_CACHE_KEY) !== null && aboutReadCache() !== null,
        J({ from: r.from, status: getAboutState().status, cached: !!aboutReadCache() }));

    A('L2 首个请求地址 = 代码库 raw 候选（不是扩展目录）', fetchLog.urls.length >= 1
        && fetchLog.urls[0] === REPO_RAW && aboutInfo().candidates[0] === REPO_RAW,
        J(fetchLog.urls.slice(0, 3)));

    A('L3 成功态文案 =「已获取版本更新 · 共 3 个版本」（不含来源/时间戳/emoji）', aboutStatusText() === '已获取版本更新 · 共 3 个版本'
        && aboutStatusText().indexOf('raw.githubusercontent') < 0 && aboutStatusText().indexOf('✅') < 0,
        aboutStatusText());

    // 离线 + 有缓存 → cached 态，仍 ok
    resetFetch('fail');
    const c = await aboutLoadJson(true);
    A('L4 离线但有缓存：status=cached、ok=true、文案注明「本次未联网，使用上次缓存」', c.ok === true
        && getAboutState().status === 'cached'
        && aboutStatusText() === '已获取版本更新 · 共 3 个版本（本次未联网，使用上次缓存）',
        J({ ok: c.ok, status: getAboutState().status, text: aboutStatusText() }));

    // 无缓存 + 离线 → fail 态，如实失败不伪造
    aboutClearCache();
    resetFetch('fail');
    const f = await aboutLoadJson(true);
    A('L5 无缓存且离线：ok=false、status=fail、只回退说明且 changelog 为空（不伪造版本数据）', f.ok === false
        && getAboutState().status === 'fail' && f.data.fallback === true && (f.data.changelog || []).length === 0,
        J({ ok: f.ok, status: getAboutState().status, changelog: f.data.changelog, fallback: f.data.fallback }));

    A('L6 失败文案 =「无法获取版本更新 —— 可在代码库查看：<仓库页>」（不含扩展目录/相对路径等实现细节）',
        aboutStatusText() === ('无法获取版本更新 —— 可在代码库查看：' + REPO_PAGE)
        && aboutStatusText().indexOf(EXT_DIR) < 0 && aboutStatusText().indexOf('相对路径') < 0,
        aboutStatusText());

    A('L7 坏 JSON / changelog 非数组 → 一律判失败', await (async () => {
        aboutClearCache(); resetFetch('bad-json');
        const a = await aboutLoadJson(true);
        aboutClearCache(); resetFetch('no-array');
        const b = await aboutLoadJson(true);
        return a.ok === false && b.ok === false && getAboutState().status === 'fail';
    })(), '见断言');

    // V1 缺陷 #2 回归：no-fetch 早退分支不得污染在途标志
    const keepFetch = globalThis.fetch;
    delete globalThis.fetch;
    aboutClearCache();
    const n1 = await aboutLoadJson(true);
    globalThis.fetch = keepFetch;
    resetFetch('ok');
    const n2 = await aboutLoadJson(true);
    A('L8 V1「在途标志污染」回归：无 fetch 分支返回后，恢复 fetch 仍能真正取到数据（不是旧结果）', n1.ok === false
        && n1.error === 'no-fetch' && n2.ok === true && (n2.data.changelog || []).length === 3,
        J({ n1: { ok: n1.ok, error: n1.error }, n2: { ok: n2.ok, status: n2.status } }));

    A('L9 写缓存 → 读缓存往返一致（`{ts, data}` 结构）', (() => {
        aboutClearCache();
        aboutWriteCache(DOC);
        const c2 = aboutReadCache();
        return !!c2 && !!c2.data && c2.data.version === DOC.version && typeof c2.ts === 'number' && c2.ts > 0;
    })(), '见断言');
})();

// ---- R 组：「重新获取」与清缓存动作 ----
await (async () => {
    aboutClearCache();
    resetFetch('ok');
    const r1 = await aboutAction('aboutReload', {});
    const calls1 = fetchLog.urls.length;
    const r2 = await aboutAction('aboutReload', {});
    const calls2 = fetchLog.urls.length;
    A('R1 「重新获取」强制重取：两次点击都真的发请求（旧实现在途去重/节流会直接返回旧结果）',
        r1.ok === true && r2.ok === true && calls1 >= 1 && calls2 > calls1,
        J({ calls1, calls2, note: r1.note }));

    A('R2 成功提示言简意赅：「已获取版本更新 · 共 3 个版本」', r1.note === '已获取版本更新 · 共 3 个版本'
        && r1.versions === 3 && r1.note.indexOf('来源') < 0,
        String(r1.note));

    resetFetch('fail');
    const rf = await aboutAction('aboutReload', {});
    A('R3 离线但有缓存：动作仍 ok=true，提示如实说明「使用上次缓存」', rf.ok === true
        && rf.note === '已获取版本更新 · 共 3 个版本（本次未联网，使用上次缓存）',
        String(rf.note));

    aboutClearCache();
    resetFetch('fail');
    const rf2 = await aboutAction('aboutReload', {});
    A('R4 无缓存且离线：ok=false 且提示「无法获取版本更新 —— 可在代码库查看：<仓库页>」',
        rf2.ok === false && rf2.note === ('无法获取版本更新 —— 可在代码库查看：' + REPO_PAGE),
        String(rf2.note));

    // 先造出缓存，再验证清缓存动作真的删键（removed 如实回报）
    aboutWriteCache(DOC);
    const cl = await aboutAction('aboutClearCache', {});
    A('R5 清缓存动作：删 localStorage 键 + 复位内存态（data=null / status=idle / ts=0）', cl.ok === true
        && cl.removed === true && ls.getItem(ABOUT_CACHE_KEY) === null
        && getAboutData() === null && getAboutState().status === 'idle' && getAboutState().ts === 0,
        J({ ok: cl.ok, removed: cl.removed, status: getAboutState().status }));

    A('R6 未知动作如实返回失败（不静默成功）', await (async () => {
        const x = await aboutAction('aboutNope', {});
        return x.ok === false && x.note.indexOf('未知关于页动作') === 0;
    })(), '见断言');
})();

// ---- H 组：渲染精简（言简意赅，不扩散开发内容） ----
await (async () => {
    setAboutHooks({ rerender: () => undefined });
    aboutClearCache();
    resetFetch('ok');
    await aboutLoadJson(true);
    const h = aboutHtml();
    A('H1 结构齐备：标题 / 一句话定位 / 当前版本 / 重新获取 / 状态行 / 功能 / 版本更新', h.indexOf('关于 · FTT记忆组件') >= 0
        && h.indexOf('SillyTavern 记忆扩展') >= 0 && h.indexOf('当前版本 <b>' + VERSION + '</b>') >= 0
        && h.indexOf('data-ftt-action="aboutReload"') >= 0 && h.indexOf('🔄 重新获取') >= 0
        && h.indexOf('data-ftt-about-status') >= 0 && h.indexOf('已获取版本更新 · 共 3 个版本') >= 0
        && h.indexOf('功能') >= 0 && h.indexOf('版本更新（最新在最前）') >= 0,
        h.slice(0, 200));

    A('H2 不出现开发/历史内容，也不出现清缓存按钮（已迁数据管理）', ['V2 附加信息', '内核配置键', '默认配置键',
        '扩展目录', '相对路径', '入口与用法', '缓存 TTL', 'fttAboutJson', '对齐总表', 'docs/', '本页自动重试',
        'aboutClearCache', '清除本地缓存'].every((s) => h.indexOf(s) < 0),
        h);

    A('H3 版本条目倒序且每条最多 3 条要点（用户要求言简意赅）', (() => {
        // 只在「版本更新」分节内比对顺序（节外「当前版本」行也含版本号，会干扰 indexOf）
        const secAt = h.indexOf('版本更新（最新在最前）');
        if (secAt < 0) return false;
        const sec = h.slice(secAt);
        const order = ['2.53.0', '2.52.0', '2.51.0'].map((v) => sec.indexOf(v));
        const ok3 = sec.indexOf('>a<') >= 0 && sec.indexOf('>b<') >= 0 && sec.indexOf('>c<') >= 0
            && sec.indexOf('>d<') < 0 && sec.indexOf('>e<') < 0;
        return ok3 && order[0] >= 0 && order[0] < order[1] && order[1] < order[2] && sec.indexOf('当前版本</span>') >= 0;
    })(), '见断言');

    aboutClearCache();
    resetFetch('fail');
    await aboutLoadJson(true);
    const hf = aboutHtml();
    A('H4 失败态：渲染骨架（标题/重新获取），状态行指向代码库，版本更新区为空态说明；不渲染兜底里的实现说明',
        hf.indexOf('关于 · FTT记忆组件') >= 0 && hf.indexOf('🔄 重新获取') >= 0
        && hf.indexOf('无法获取版本更新 —— 可在代码库查看：' + REPO_PAGE) >= 0
        && hf.indexOf('ftt-empty') >= 0 && hf.indexOf('首个版本') < 0
        && hf.indexOf('扩展目录') < 0 && hf.indexOf('最新版本') < 0 && hf.indexOf('不一致') < 0,
        hf.slice(0, 300));
})();

// ---- B 组：缓冲统计 + 数据管理页 ----
A('B1 aboutCacheStats：无缓存 = 0 条 0 字节；有缓存 = 条数/字节/已缓存', (() => {
    aboutClearCache();
    const s0 = aboutCacheStats();
    aboutWriteCache(DOC);
    const s1 = aboutCacheStats();
    return s0.cached === false && s0.versions === 0 && s0.bytes === 0
        && s1.cached === true && s1.versions === 3 && s1.bytes > 50;
})(), J(aboutCacheStats()));

A('B2 数据管理页含「本地缓冲」统计与清除按钮；关于页不含开发块', (() => {
    aboutWriteCache(DOC);
    const dataHtml = settingsPageHtml('data', '');
    const aboutPage = settingsPageHtml('about', '');
    return dataHtml.indexOf('本地缓冲') >= 0 && dataHtml.indexOf('版本清单缓存：已缓存 3 个版本') >= 0
        && dataHtml.indexOf('data-ftt-action="aboutClearCache"') >= 0 && dataHtml.indexOf('🧹 清除版本清单缓存') >= 0
        && dataHtml.indexOf('调试日志：') >= 0 && dataHtml.indexOf('交互追踪简报：') >= 0
        && aboutPage.indexOf('本地缓冲') < 0 && aboutPage.indexOf('V2 附加信息') < 0 && aboutPage.indexOf('内核配置键') < 0;
})(), '见断言');

A('B3 无缓存时数据页清除按钮禁用（不误导用户点空操作）', (() => {
    aboutClearCache();
    const h = settingsPageHtml('data', '');
    return h.indexOf('版本清单缓存：（无缓存）') >= 0 && h.indexOf('aboutClearCache" disabled') >= 0;
})(), '见断言');

// ---- D 组：与「真实随发布的清单」契约（防文档/代码各写一套，也证明成功态不是只能靠桩） ----
await (async () => {
    A('D1 仓库清单结构：version == 当前版本、首条 = 当前版本、每条含 version/date/title/points', REAL.version === VERSION
        && String((REAL.changelog[0] || {}).version) === VERSION && REAL.changelog.length >= 50
        && REAL.changelog.every((e) => /^\d+\.\d+\.\d+$/.test(String(e.version)) && /^\d{4}-\d{2}-\d{2}$/.test(String(e.date))
            && typeof e.title === 'string' && Array.isArray(e.points) && e.points.length > 0),
        J({ version: REAL.version, n: REAL.changelog.length, first: REAL.changelog[0] && REAL.changelog[0].version }));

    aboutClearCache();
    resetFetch('real');
    const r = await aboutLoadJson(true);
    const hr = aboutHtml();
    A('D2 用真实清单渲染：成功态计数一致、当前版本条目标注「当前版本」、倒序首条 = 当前版本', r.ok === true
        && getAboutState().status === 'ok'
        && aboutStatusText() === ('已获取版本更新 · 共 ' + REAL.changelog.length + ' 个版本')
        && hr.indexOf('版本更新（最新在最前）') >= 0
        && hr.indexOf('当前版本</span>') >= 0
        && hr.indexOf(String(REAL.changelog[1].version)) > hr.indexOf(String(REAL.changelog[0].version)),
        J({ status: getAboutState().status, text: aboutStatusText() }));
})();

unFetch();
if (keepWin === undefined) delete globalThis.window; else globalThis.window = keepWin;
R.done();
