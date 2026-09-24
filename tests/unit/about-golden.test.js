// ============================================================
// 单元测试 · B9-a 关于页（**与真实 V1 插件 v1.206 逐项比对**）
// 黄金样本：tests/fixtures/v1-golden-about.json（oracle = 真实 V1 插件 v1.206 直调；
//   `aboutFallback` / `aboutSortDesc` / `aboutLoadJson`（stub fetch 成功/失败/缓存/无 fetch）/ `aboutHtml` 渲染投影）
// 覆盖：候选地址（V2 = 扩展目录绝对路径优先）/ 版本号倒序 / 兜底文案（不伪造版本数据）/ 初始态 /
//   成功读取（内存态 + localStorage 缓存 `{ts,data}` + 零重复 fetch）/ 非 force 命中内存缓存 /
//   `aboutEnsureLoaded` 新鲜态不重复拉取 / cached 与 fail 两态 / 渲染投影（分节·按钮·计数·倒序条目·版本不一致警告）/
//   清缓存（删键 + 复位状态）/ **V1 原生缺陷 #1（渲染→重试风暴）与 #2（在途标志污染）已修** 的断言
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { VERSION } from '../../core/constants.js';
import {
    ABOUT_JSON_PATHS, ABOUT_FILE, ABOUT_CACHE_KEY, ABOUT_ACTIONS, ABOUT_TTL_MS,
    aboutFallback, aboutReadCache, aboutClearCache, aboutCandidateUrls, aboutDirUrl,
    aboutSortDesc, aboutLoadJson, aboutEnsureLoaded, getAboutData, getAboutState,
    aboutHtml, aboutStatusText, aboutAction, aboutInfo, setAboutHooks,
} from '../../ui/about.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-about.json'), 'utf8'));
const R = makeReporter('about-golden B9-a 关于页（V1 黄金样本逐项比对）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const FIXED_NOW = G.meta.fixedNow;
const SAMPLE = G.meta.sample;

/** detail 传**函数**（惰性求值：只在失败时收集现场，避免把 await 前的旧快照当证据） */
const A = async (name, fn, detailFn) => {
    let cond = false, extra = '';
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    if (cond !== true && !extra && typeof detailFn === 'function') { try { extra = detailFn(); } catch (e) { extra = String((e && e.message) || e); } }
    R.assert(name, cond === true, extra);
};

const realNow = Date.now;
function freezeNow(v) { Date.now = () => v; }
function nowOff() { Date.now = realNow; }

/** 内存 localStorage 桩 */
function makeLS() {
    const map = new Map();
    return {
        _map: map,
        getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
        setItem: (k, v) => { map.set(String(k), String(v)); },
        removeItem: (k) => { map.delete(String(k)); },
    };
}
let LS = null;
let calls = [];
let route = () => ({ status: 404, text: 'gone' });
const realFetch = globalThis.fetch;
function installRoute() {
    globalThis.fetch = async (url, opts) => {
        calls.push(String(url));
        const base = String(url).split('?')[0];
        const r = route(base, String(url));
        if (r && r.throw) throw new Error(r.throw);
        return {
            ok: Number(r.status) >= 200 && Number(r.status) < 300, status: Number(r.status) || 0,
            async text() { return String(r.text == null ? '' : r.text); },
            async json() { return JSON.parse(String(r.text == null ? '' : r.text)); },
        };
    };
}
function uninstallFetch() { if (realFetch === undefined) delete globalThis.fetch; else globalThis.fetch = realFetch; }

/** 渲染投影（提取与 oracle 同名的字段；V2 无法逐字节比对整段 HTML，故按关键证据比对） */
function htmlProj() {
    const h = String(aboutHtml() || '');
    const grab = (re) => { const m = h.match(re); return m ? String(m[1]) : null; };
    return {
        sections: ['关于 · FTT记忆组件', '它是什么', '版本更新（倒序 · 最新在最前）'].filter((t) => h.indexOf(t) >= 0),
        hasReloadBtn: h.indexOf('data-ftt-action="aboutReload"') >= 0,
        hasClearBtn: h.indexOf('data-ftt-action="aboutClearCache"') >= 0,
        reloadLabel: h.indexOf('🔄 重新获取') >= 0,
        clearLabel: h.indexOf('🧹 清除本地缓存') >= 0,
        btnCount: (h.match(/data-ftt-action="about(Reload|ClearCache)"/g) || []).length,
        nameLine: grab(/<div class="ftt-my-2"><b>([^<]*)<\/b>/),
        countLine: grab(/共 (\d+) 个版本/),
        entries: (h.match(/<b class="[^"]*">([^<]*)<\/b>/g) || []).map((s) => s.replace(/<[^>]*>/g, '')),
        emptyText: h.indexOf('清单暂无版本条目') >= 0,
        statusText: grab(/<div class="ftt-hint ftt-mt-4">([^<]*)</),
        warnText: grab(/ftt-note-warn[^>]*>([^<]*)</),
        introWhat: grab(/<div class="ftt-sec-title">它是什么<\/div><div>([^<]*)</),
    };
}

LS = makeLS();
globalThis.window = { localStorage: LS };
setAboutHooks({ rerender: () => undefined });      // 测试内不触面板重绘
installRoute();
freezeNow(FIXED_NOW);
aboutClearCache();                                  // 复位模块内存态 → 与 V1 oracle 的初始态一致

// ---------------- A0 候选地址与常量（V2 取文件路径的适配） ----------------
await A('A0 候选地址：V2 = **扩展目录绝对路径优先** + V1 同款两条相对路径；ABOUT_JSON_PATHS 与 V1 逐字一致；缓存键同名', () => {
    const cand = aboutCandidateUrls();
    const dir = aboutDirUrl();
    return J(ABOUT_JSON_PATHS) === J(G.aboutJsonPaths)
        && ABOUT_FILE === 'FTT-memory-changelog.json' && ABOUT_CACHE_KEY === G.meta.cacheKey
        && dir === '/scripts/extensions/third-party/ftt-memory-v2/'
        && J(cand) === J([dir + ABOUT_FILE].concat(G.aboutJsonPaths))
        && cand[0] === dir + ABOUT_FILE;
}, () => ({ cand: aboutCandidateUrls(), v1: G.candidateUrls }));

// ---------------- A1 初始态 ----------------
await A('A1 初始态：数据为 null、状态为 idle（与 V1 逐项一致）；`aboutInfo()` 暴露候选/缓存/目录诊断', () => {
    aboutClearCache();
    const st = getAboutState();
    const info = aboutInfo();
    return J(getAboutData()) === J(G.initial.data) && J(st) === J(G.initial.state)
        && info.status === 'idle' && info.hasData === false && info.cached === false
        && J(info.candidates) === J(aboutCandidateUrls());
}, () => ({ data: getAboutData(), state: getAboutState() }));

// ---------------- A2 版本号倒序（V1 `aboutSortDesc` 逐值比对） ----------------
await A('A2 `aboutSortDesc`：乱序样本 + 带 v 前缀/短号/非法项 + 非数组 + 空数组，四组输出与 V1 逐值一致', () => {
    const cases = G.sortDesc.cases;
    // 版本号归一与 oracle 同式：`String((e && e.version) || '')`（null/'' → ''）
    const verOf = (e) => String((e && e.version) || '');
    const got = [
        aboutSortDesc(SAMPLE.changelog).map(verOf),
        aboutSortDesc(cases[1].input.map((v) => ({ version: v }))).map(verOf),
        aboutSortDesc(null).map(verOf),
        aboutSortDesc([]).map(verOf),
    ];
    return cases.every((c, i) => J(got[i]) === J(c.out));
}, () => { try { return { got: aboutSortDesc(SAMPLE.changelog).map((e) => e.version), want: G.sortDesc.stableOut }; } catch (e) { return String(e.message); } });

// ---------------- A3 兜底文案（不伪造版本内容） ----------------
await A('A3 `aboutFallback()`：**只说明读不到清单**（changelog 为空、fallback=true），除 3 处 V2 形态适配（title / intro.what / intro.notes）外与 V1 逐字段一致', () => {
    const fb = aboutFallback();
    const v1 = G.fallback;
    const diff = ['title', 'version', 'intro'];
    const sameCore = fb.name === v1.name && fb.updatedAt === v1.updatedAt && fb.generatedAt === v1.generatedAt
        && fb.fallback === v1.fallback && J(fb.changelog) === J(v1.changelog)
        && J(fb.intro.highlights) === J(v1.intro.highlights) && J(fb.intro.entries) === J(v1.intro.entries)
        && Object.keys(fb).sort().join(',') === Object.keys(v1).sort().join(',')
        && diff.length === 3;
    // V2 适配：title 说明形态；intro.what/notes 给出扩展目录（V1 给的是「与插件 JS 同目录」）
    const adapted = fb.title === 'SillyTavern 长期记忆插件（原生扩展形态）'
        && fb.version === VERSION
        && fb.intro.what.indexOf('未能读取版本清单 JSON') === 0
        && fb.intro.notes.indexOf(aboutDirUrl() + ABOUT_FILE) >= 0
        && v1.intro.notes.indexOf('本插件 JS 放在同一目录') >= 0;
    return sameCore && adapted;
}, () => { try { return { v2: aboutFallback(), v1: G.fallback }; } catch (e) { return String(e.message); } });

// ---------------- A4 成功读取（相对扩展目录） ----------------
await A('A4 成功读取：命中**扩展目录**首个候选 → status=ok、data 与 V1 逐字段一致、localStorage 缓存 `{ts,data}` 一致（ts=固定时钟）', () => {
    aboutClearCache();
    calls = [];
    route = () => ({ status: 200, text: J(SAMPLE) });
    return aboutLoadJson(true).then((res) => {
        const cache = JSON.parse(LS.getItem(ABOUT_CACHE_KEY) || 'null');
        const dirUrl = aboutDirUrl() + ABOUT_FILE;
        const ok = res.ok === true && res.status === 'ok' && res.from === dirUrl
            && J(res.data) === J(G.success.data) && J(getAboutData()) === J(G.success.data)
            && getAboutState().status === 'ok' && getAboutState().from === dirUrl && getAboutState().ts === FIXED_NOW
            && J(cache) === J(G.success.cache) && calls.length === 1 && calls[0] === dirUrl
            // V1 首个候选是相对路径（`FTT-memory-changelog.json`）；V2 首个候选是扩展目录绝对路径（适配①）
            && G.success.calls.length === 1 && G.success.res.from === 'FTT-memory-changelog.json';
        return ok;
    });
}, () => { try { return { from: getAboutState().from, status: getAboutState().status, calls: calls, cache: LS.getItem(ABOUT_CACHE_KEY) }; } catch (e) { return String(e.message); } });

// ---------------- A5 非 force 命中内存缓存（零 fetch） ----------------
await A('A5 非 force 二次调用：命中内存缓存直接返回（零新增 fetch），与 V1 `noForce` 一致', async () => {
    calls = [];
    const res = await aboutLoadJson(false);
    return res.ok === true && res.status === 'ok' && J(res.data) === J(G.success.data)
        && J(calls) === J(G.noForce.calls) && res.from === undefined;
}, () => ({ calls: calls }));

// ---------------- A6 aboutEnsureLoaded 新鲜态不重复拉取 ----------------
await A('A6 `aboutEnsureLoaded()`：状态 ok 且未过期 → false（零 fetch），与 V1 `ensureFresh` 一致', async () => {
    calls = [];
    const ret = aboutEnsureLoaded();
    await new Promise((r) => setTimeout(r, 30));
    return ret === G.ensureFresh.ret && ret === false && J(calls) === J(G.ensureFresh.calls);
}, () => ({ ret: aboutEnsureLoaded(), calls: calls }));

// ---------------- A7 cached 态（读取失败但有缓存） ----------------
await A('A7 读取失败但有缓存 → status=cached、ok=true、data 用缓存（非兜底）；四轮候选与 cache-buster 与 V1 一致', async () => {
    calls = [];
    route = () => ({ status: 404, text: 'gone' });
    const res = await aboutLoadJson(true);
    const dirUrl = aboutDirUrl() + ABOUT_FILE;
    // V2 比 V1 多一条候选（扩展目录绝对路径）→ 每轮 3 条、两轮共 6 次；V1 为 2 条候选 × 2 轮 = 4 次
    const wantCalls = [dirUrl, G.aboutJsonPaths[0], G.aboutJsonPaths[1],
        dirUrl + '?ftt=' + FIXED_NOW, G.aboutJsonPaths[0] + '?ftt=' + FIXED_NOW, G.aboutJsonPaths[1] + '?ftt=' + FIXED_NOW];
    return res.ok === true && res.status === 'cached' && res.error === 'http-404'
        && getAboutState().status === 'cached' && getAboutState().ts === FIXED_NOW
        && String(getAboutData().version) === G.cached.dataVersion
        && getAboutData().fallback !== true
        && J(calls) === J(wantCalls) && G.cached.callsN === 4;
}, () => { try { return { state: getAboutState(), calls: calls }; } catch (e) { return String(e.message); } });

// ---------------- A8 fail 态（无缓存 + 兜底，不伪造版本数据） ----------------
await A('A8 读取失败且无缓存 → status=fail、ok=false、data 为兜底（changelog 空、fallback=true）；与 V1 `fail` 逐项一致', async () => {
    aboutClearCache();
    LS.removeItem(ABOUT_CACHE_KEY);
    calls = [];
    route = () => ({ status: 404, text: 'gone' });
    const res = await aboutLoadJson(true);
    const st = getAboutState();
    return res.ok === G.fail.res.ok && res.status === 'fail' && st.status === 'fail' && st.error === 'http-404'
        && getAboutData().fallback === true && getAboutData().changelog.length === 0
        && G.fail.dataFallback === true && G.fail.dataChangelogN === 0
        && G.fail.callsN === 4 && calls.length === 6;      // V2 多一条扩展目录候选 → 6 次（V1 为 4 次）
}, () => { try { return { state: getAboutState(), calls: calls, data: getAboutData() }; } catch (e) { return String(e.message); } });

// ---------------- A9 渲染投影（成功态，与 V1 `htmlOk` 逐项一致） ----------------
await A('A9 渲染（成功态）：三节标题 / 两个 V1 同款按钮 / 版本计数 / 倒序条目 / 版本不一致警告文案均与 V1 一致；状态行前缀一致', async () => {
    route = () => ({ status: 200, text: J(SAMPLE) });
    await aboutLoadJson(true);
    calls = [];
    const got = htmlProj();
    const v1 = G.htmlOk;
    const sameExceptStatus = J(got.sections) === J(v1.sections)
        && got.hasReloadBtn === v1.hasReloadBtn && got.hasClearBtn === v1.hasClearBtn
        && got.reloadLabel === v1.reloadLabel && got.clearLabel === v1.clearLabel && got.btnCount === v1.btnCount
        && got.nameLine === v1.nameLine && got.countLine === v1.countLine && J(got.entries) === J(v1.entries)
        && got.emptyText === v1.emptyText && got.introWhat === v1.introWhat
        && got.warnText === G.htmlOk.warnText.replace('v1.206', VERSION)
        && calls.length === v1.ensureCalls.length;
    const statusOk = got.statusText === ('✅ 版本清单已读取 · 3 个版本 · ' + new Date(FIXED_NOW).toLocaleString())
        || got.statusText.indexOf('✅ 版本清单已读取 · 3 个版本 · ') === 0;
    return sameExceptStatus && statusOk && v1.countLine === '3' && J(v1.entries) === J(['1.0.0', '0.10.0', '0.9.0']);
}, () => { try { return htmlProj(); } catch (e) { return String(e.message); } });

// ---------------- A10 缓存态渲染：V1 缺陷 #1 已修（不再渲染即重试风暴） ----------------
await A('A10 渲染（缓存态）：V1 `htmlCached` 会因 `aboutEnsureLoaded` 恒判 stale 而渲染出「⏳ 正在读取版本清单…」并每次渲染都再发一轮读取（**原生缺陷 #1**）；V2 以重试间隔闸门修掉 → 渲染出「📦 上次缓存…」且**零新增 fetch**', async () => {
    route = () => ({ status: 404, text: 'gone' });
    await aboutLoadJson(true);            // → cached
    calls = [];
    const got = htmlProj();
    const st = getAboutState();
    return G.htmlCached.statusText === '⏳ 正在读取版本清单…' && G.htmlCached.ensureCalls.length === 1
        && calls.length === 0 && st.status === 'cached'
        && got.statusText.indexOf('📦 上次缓存（') === 0 && got.statusText.indexOf('打开本页自动重试') > 0
        && got.countLine === G.htmlCached.countLine && J(got.entries) === J(G.htmlCached.entries)
        && aboutStatusText().indexOf('📦 上次缓存（') === 0;
}, () => { try { return { state: getAboutState(), calls: calls.length, status: aboutStatusText() }; } catch (e) { return String(e.message); } });

// ---------------- A11 失败态渲染（无缓存 + stale 但受闸门保护） ----------------
await A('A11 渲染（失败态）：状态行给出**扩展目录**提示（V1 给的是「与插件 JS 同目录」）且零新增 fetch；表格为空时展示 V1 同款空态', async () => {
    aboutClearCache();
    LS.removeItem(ABOUT_CACHE_KEY);
    route = () => ({ status: 404, text: 'gone' });
    await aboutLoadJson(true);            // → fail（aboutLastAttemptAt 已置位 → 闸门生效）
    calls = [];
    const got = htmlProj();
    // V1 现场：失败态渲染时 `aboutEnsureLoaded()` 立刻把状态置为 loading → 渲染出「⏳ 正在读取版本清单…」（缺陷 #1）；
    //   V2 因重试闸门不再自触发，渲染出真实失败文案（给出扩展目录路径）
    return G.htmlFail.statusText === '⏳ 正在读取版本清单…' && G.htmlFail.ensureCalls.length === 1
        && G.htmlFail.countLine === null && G.htmlFail.emptyText === true
        && got.countLine === null && got.emptyText === true && got.entries.length === 0
        && calls.length === 0
        && got.statusText.indexOf('⚠️ 版本清单读取失败') === 0
        && got.statusText.indexOf('确认 ' + ABOUT_FILE + ' 在扩展目录（' + aboutDirUrl() + '）') > 0;
}, () => { try { return { status: aboutStatusText(), calls: calls.length, info: aboutInfo() }; } catch (e) { return String(e.message); } });

// ---------------- A12 清缓存（V1 `case 'aboutClearCache'`） ----------------
await A('A12 `aboutClearCache()`：删除 localStorage 键 `fttAboutJson` + 数据复位 null + 状态复位 idle；动作 `aboutClearCache` 文案一致', async () => {
    route = () => ({ status: 200, text: J(SAMPLE) });
    await aboutLoadJson(true);                       // 写缓存
    const before = LS.getItem(ABOUT_CACHE_KEY) !== null;
    const ar = await aboutAction('aboutClearCache', {});
    return before === true && LS.getItem(ABOUT_CACHE_KEY) === null && getAboutData() === null
        && J(getAboutState()) === J(G.initial.state) && ar.ok === true && ar.removed === true
        && ar.note.indexOf('已清除版本清单本地缓存') === 0
        && ABOUT_ACTIONS.join(',') === 'aboutReload,aboutClearCache'
        && ABOUT_TTL_MS === 10 * 60 * 1000;
}, () => { try { return { cache: LS.getItem(ABOUT_CACHE_KEY), state: getAboutState(), info: aboutInfo() }; } catch (e) { return String(e.message); } });

// ---------------- A13 动作 aboutReload（成功 / 失败两态如实提示） ----------------
await A('A13 动作 `aboutReload`：成功 → 「版本清单已更新（来源 … · 共 3 个版本）」；失败 → 如实提示扩展目录 + 错误码（不伪造数据）', async () => {
    aboutClearCache();
    route = () => ({ status: 200, text: J(SAMPLE) });
    const okRes = await aboutAction('aboutReload', {});
    route = () => ({ status: 500, text: 'boom' });
    aboutClearCache();
    const badRes = await aboutAction('aboutReload', {});
    return okRes.ok === true && okRes.versions === 3
        && okRes.note.indexOf('版本清单已更新（来源 ' + (aboutDirUrl() + ABOUT_FILE)) === 0
        && okRes.note.indexOf('共 3 个版本') > 0
        && badRes.ok === false && badRes.note.indexOf('未能读取版本清单') === 0
        && badRes.note.indexOf('http-500') > 0 && badRes.note.indexOf(aboutDirUrl()) > 0
        && getAboutData().fallback === true;
}, () => { try { return { ok: getAboutState(), data: getAboutData() }; } catch (e) { return String(e.message); } });

// ---------------- A14 V1 缺陷 #2 已修：no-fetch 分支不再污染在途标志 ----------------
await A('A14 **V1 原生缺陷 #2 已修**：无 fetch 环境下 `aboutLoadJson` 的早退分支不再污染在途标志 —— V2 恢复 fetch 后能立刻重新读取（黄金样本 `noFetch.poisoned=true`）', async () => {
    aboutClearCache();
    const keep = globalThis.fetch;
    try {
        delete globalThis.fetch;
        const r1 = await aboutLoadJson(true);
        const r2 = await aboutLoadJson(true);
        globalThis.fetch = keep;
        route = () => ({ status: 200, text: J(SAMPLE) });
        const r3 = await aboutLoadJson(true);
        return G.noFetch.poisoned === true
            && r1.ok === false && r1.status === 'fail' && r1.error === 'no-fetch'
            && r2.ok === false && r2.error === 'no-fetch'
            && r3.ok === true && r3.status === 'ok' && getAboutState().status === 'ok'
            && getAboutData().fallback !== true;
    } finally { globalThis.fetch = keep; }
}, () => { try { return { state: getAboutState(), info: aboutInfo(), v1: G.noFetch.poisoned }; } catch (e) { return String(e.message); } });

uninstallFetch();
try { delete globalThis.window; } catch (e) { /* 忽略 */ }
nowOff();
R.done();
