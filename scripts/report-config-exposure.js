#!/usr/bin/env node
// ============================================================
// scripts/report-config-exposure.js —— **高级域参数「已就绪未暴露 / 未调度」清单**（`docs/D22` `业-5` / `docs/D18` §3.5）
//
// 背景：`docs/01` §6 只写了「内核已就绪，部分缺 UI / 调度」，**没有清单**；`docs/D18` §3.5 要求一份
//   「键名 → 所属域 → 现状（无控件 / 有控件无调度 / 缺默认值）」的逐项清单，并逐条给
//   「补 UI / 补调度 / 明确不做」三选一。本脚本产出这张表（**可复跑**，避免清单与代码二次漂移）。
//
// 判据（全部实测，不推断）：
//   · **控件现状** = `ui/settings-pages.js#SETTINGS_CONTROLS` 里有没有这个键（**设定页控件**）；
//     没有的话再看 `ui/` 与 `settings.html` 里有没有**同名字面量**（= **专用页 / 自定义正文页控件**）。
//   · **调度现状** = `core/`（除 `core/config.js` 自身）/`host/`/`adapters/`/`index.js`/`devtools.js`
//     里有没有 `cfg.<键>` 或 `'<键>'` 形态的读取点。
//   · **缺默认值** = 控件指向的叶子在 `defaultCfg` 里不存在（与 `scripts/check-config-decl.js` 判据②同源）。
//
// 结论口径（写死在脚本里，便于复核；`docs/D18` §10 只做汇总与说明）：
//   | 控件 | 调度 | 结论 |
//   | --- | --- | --- |
//   | 设定页控件 | 有 | `不做`（已闭环：可见且在用） |
//   | 仅专用页控件 | 有 | `不做`（由专用页承载，设定页不重复） |
//   | **无控件** | **有** | **补 UI**（内核已在用却无处可改） |
//   | 无控件 | 无 | `不做`（内部 / 派生 / 预留键；无消费点则无暴露价值） |
//   | —— | —— | 缺默认值 → **补默认值**（真缺陷，`check-config-decl.js` 同时报） |
//
// 用法：node scripts/report-config-exposure.js [--summary]
// ============================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUMMARY_ONLY = process.argv.includes('--summary');
/** 只列「未暴露」候选（不在 `SETTINGS_CONTROLS`、也未被专用页动态承载、也没有 UI 字面量） */
const UNCOVERED_ONLY = process.argv.includes('--uncovered-only');

/** 极简 DOM 桩（与 `scripts/check-config-decl.js` 同款）：`ui/settings-pages.js` 导入期不碰 DOM */
function stubDom() {
    const el = () => ({
        style: {}, classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
        appendChild() { }, setAttribute() { }, removeAttribute() { }, addEventListener() { },
        querySelector() { return null; }, querySelectorAll() { return []; }, insertAdjacentHTML() { }, remove() { },
        dataset: {}, value: '', textContent: '', innerHTML: '',
    });
    try { if (!globalThis.window) globalThis.window = globalThis; } catch (e) { /* 忽略 */ }
    try {
        if (!globalThis.document) {
            globalThis.document = {
                addEventListener() { }, removeEventListener() { },
                querySelector() { return null; }, querySelectorAll() { return []; },
                createElement: el, createTextNode() { return el(); },
                body: el(), head: el(), documentElement: el(),
            };
        }
    } catch (e) { /* 忽略 */ }
}

/** 把配置对象摊平成叶子路径集合（与 `check-config-decl.js#flatten` 同口径） */
function flattenLeaves(obj) {
    const leaves = [];
    (function walk(o, p) {
        if (!o || typeof o !== 'object') return;
        for (const k of Object.keys(o)) {
            const path = p ? p + '.' + k : k;
            const v = o[k];
            if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path);
            else leaves.push(path);
        }
    })(obj, '');
    return leaves;
}

function walkFiles(dir, acc = []) {
    let names = [];
    try { names = readdirSync(dir); } catch (e) { return acc; }
    for (const name of names) {
        if (name === 'node_modules' || name === '.git' || name === 'out') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walkFiles(p, acc);
        else if (/\.(js|html|json)$/.test(name)) acc.push(p);
    }
    return acc;
}

/**
 * **结论改判表**（人工核对代码后的口径；命中则覆盖默认判据，并把 `why` 写进输出）。
 *   · `storeMax*`：现行存储模型是「**总上限 × 各维占比**」—— `core/ingest.js#storeCapRaw` 在
 *     `cfg.storeTotalMax > 0`（默认 `3000`）时**不读**逐维 `storeMax*`，只有用户把总上限设为 ≤ 0 才回落；
 *     界面已用 `ui/forget.js#storeShareSectionHtml` 的占比滚动条表达同一件事 → 逐维键是**兼容口径**，不必补 UI。
 *   · `clockManualLock`：**全仓只读不写**（`core/clock-patrol.js#setClockManual` 只读它），
 *     界面上「💾 保存并锁定 / 🔓 解锁并恢复自动」（`ui/clock.js`）走的是 `state.state.clockManual`，
 *     语义已被这两个动作取代 → 兼容位，不必补 UI。
 */
const VERDICT_OVERRIDES = [
    { kind: 'prefix', value: 'storeMax', verdict: '明确不做', why: '兼容口径（总上限×占比派生，core/ingest.js#storeCapRaw）' },
    { kind: 'exact', value: 'clockManualLock', verdict: '明确不做', why: '全仓只读不写（core/clock-patrol.js#setClockManual），语义已由「保存并锁定 / 解锁」两动作取代' },
];
/** 命中改判表则返回其条目，否 = null */
function verdictOverride(path) {
    for (const o of VERDICT_OVERRIDES) {
        if (o.kind === 'exact' && path === o.value) return o;
        if (o.kind === 'prefix' && path.indexOf(o.value) === 0) return o;
    }
    return null;
}

/**
 * **专用页动态承载表**（人工核实后写死；这些页面的控件键是**运行时拼出来的**，字面量检测看不到）：
 *   · `ui/prompts.js`：按 `PROMPT_TEMPLATES_V2` 的键**逐个**渲染提示词编辑框（`promptTemplates[key]`）；
 *   · `ui/forget.js#storeShareSectionHtml` + `ui/panel.js`：按 `STORE_SHARE_DIMS` 渲染占比滚动条（`storeShare.*`）；
 *   · `ui/api-page.js`：`pick(pre + 'ProxyPreset')` 形态 —— 主渠道 / 关键词渠道（`kwApi.`）/ 记忆渠道（`memApi.`）三组；
 *   · `ui/nsfw.js`：词条与转化词走 `core/nsfw.js` 的 `nsfwKeyword*` / `nsfwRule*` API（读写 `cfg.nsfwKeywords` / `cfg.nsfwRules`）。
 * 命中即记「仅专用页控件」，并由结论口径判为 `不做（专用页承载）`。
 */
const DEDICATED_SURFACES = [
    { kind: 'prefix', value: 'promptTemplates.', surface: 'ui/prompts.js' },
    { kind: 'prefix', value: 'storeShare.', surface: 'ui/forget.js#storeShareSectionHtml' },
    { kind: 'prefix', value: 'kwApi.', surface: 'ui/api-page.js' },
    { kind: 'prefix', value: 'memApi.', surface: 'ui/api-page.js' },
    { kind: 'exact', value: 'nsfwKeywords', surface: 'ui/nsfw.js' },
    { kind: 'exact', value: 'nsfwRules', surface: 'ui/nsfw.js' },
    { kind: 'exact', value: 'apiType', surface: 'ui/api-page.js' },
    { kind: 'exact', value: 'apiUrl', surface: 'ui/api-page.js' },
    { kind: 'exact', value: 'apiKey', surface: 'ui/api-page.js' },
    { kind: 'exact', value: 'apiMaxTokens', surface: 'ui/api-page.js' },
    { kind: 'exact', value: 'apiTemperature', surface: 'ui/api-page.js' },
    { kind: 'exact', value: 'apiTopP', surface: 'ui/api-page.js' },
    { kind: 'exact', value: 'apiProfileId', surface: 'ui/api-page.js' },
    { kind: 'exact', value: 'apiChannel', surface: 'ui/api-page.js' },
    { kind: 'exact', value: 'model', surface: 'ui/api-page.js' },
    { kind: 'exact', value: 'proxyPreset', surface: 'ui/api-page.js' },
    { kind: 'exact', value: 'activeApiPreset', surface: 'ui/api-page.js' },
    { kind: 'exact', value: 'parallelApiPreset', surface: 'ui/api-page.js' },
    { kind: 'exact', value: 'armorPresetEnabled', surface: 'ui/api-page.js' },
    { kind: 'exact', value: 'armorPreset', surface: 'ui/api-page.js' },
];
/** 该键是否由某个专用页**动态**承载（返回页面标识，否 = null） */
function dedicatedSurface(path) {
    for (const d of DEDICATED_SURFACES) {
        if (d.kind === 'exact' && path === d.value) return d.surface;
        if (d.kind === 'prefix' && path.indexOf(d.value) === 0) return d.surface;
    }
    return null;
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 该键在文本里有没有「读取点」。**收紧口径**（避免叶子名太通用造成假命中）：
 *   ① `cfg.<任意前缀>.<叶子>`（含 `cfg.<叶子>`）；② 完整路径字面量 `'a.b.c'`；
 *   ③ 叶子字面量 `'leaf'` —— **仅当该键是顶层键**时才算（嵌套键的叶子名会误命中）。
 */
function hasReadSite(text, path, leaf, topLevel) {
    const pats = [
        new RegExp('\\bcfg\\.[A-Za-z0-9_$.]*\\b' + esc(leaf) + '\\b'),
        new RegExp("['\"`]" + esc(path) + "['\"`]"),
    ];
    if (topLevel) pats.push(new RegExp("['\"`]" + esc(leaf) + "['\"`]"));
    for (const r of pats) { if (r.test(text)) return true; }
    return false;
}

stubDom();
let defaultCfg = null, SETTINGS_CONTROLS = null;
try { ({ defaultCfg } = await import('../core/config.js')); } catch (e) { console.error('无法加载 core/config.js：' + String((e && e.message) || e)); process.exit(1); }
try { ({ SETTINGS_CONTROLS } = await import('../ui/settings-pages.js')); } catch (e) { console.error('无法加载 ui/settings-pages.js：' + String((e && e.message) || e)); process.exit(1); }

const leaves = flattenLeaves(defaultCfg).sort();
const settingCtrlKeys = new Set();
for (const page of Object.keys(SETTINGS_CONTROLS)) {
    for (const c of (SETTINGS_CONTROLS[page] || [])) if (c && c.key) settingCtrlKeys.add(String(c.key));
}
const controlCount = Object.keys(SETTINGS_CONTROLS).reduce((n, k) => n + (SETTINGS_CONTROLS[k] || []).length, 0);

// 读一次工作区：分「UI 面」与「消费面」两组
const allFiles = walkFiles(ROOT);
const uiFiles = allFiles.filter((f) => /[\\/]ui[\\/]/.test(f) || /settings\.html$/.test(f) || /[\\/]i18n[\\/]/.test(f));
const coreFiles = allFiles.filter((f) => /[\\/](core|host|adapters)[\\/]/.test(f) || /[\\/](index|devtools)\.js$/.test(f));
const uiText = uiFiles.map((f) => ({ f: relative(ROOT, f).replace(/\\/g, '/'), t: readFileSync(f, 'utf8') }));
const coreText = coreFiles
    .filter((f) => !/[\\/]core[\\/]config\.js$/.test(f))          // 声明源自身不算消费点
    .map((f) => ({ f: relative(ROOT, f).replace(/\\/g, '/'), t: readFileSync(f, 'utf8') }));

const rows = [];
for (const path of leaves) {
    const leaf = path.split('.').pop();
    const topLevel = path.indexOf('.') < 0;
    const inSettings = settingCtrlKeys.has(path);
    const dedicated = dedicatedSurface(path);
    const uiHits = uiText.filter((x) => hasReadSite(x.t, path, leaf, topLevel)).map((x) => x.f);
    const coreHits = coreText.filter((x) => hasReadSite(x.t, path, leaf, topLevel)).map((x) => x.f);
    const exposed = inSettings || !!dedicated || uiHits.length > 0;
    const wired = coreHits.length > 0;
    const controlState = inSettings ? '设定页控件' : (dedicated ? '仅专用页控件' : (uiHits.length ? '仅专用页控件' : '无控件'));
    let verdict;
    if (!exposed && wired) verdict = '补 UI';
    else if (!exposed && !wired) verdict = '明确不做';
    else verdict = '不做（已闭环）';
    const ov = verdictOverride(path);
    const why = ov ? ov.why : '';
    if (ov) verdict = ov.verdict;
    rows.push({
        path: path, dim: path.indexOf('.') > 0 ? path.split('.')[0] : '（顶层）',
        control: controlState, wired: wired, uiHits: uiHits, coreHits: coreHits, verdict: verdict, why: why,
        uncovered: !inSettings && !dedicated && uiHits.length === 0,
    });
}
// 「缺默认值」：控件指向的叶子在 defaultCfg 里不存在（与 check-config-decl 判据②同源）
const leafSet = new Set(leaves);
const midSet = new Set();
(function walkMid(o, p) {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
        const path = p ? p + '.' + k : k;
        const v = o[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) { midSet.add(path); walkMid(v, path); }
    }
})(defaultCfg, '');
const noDefault = Array.from(settingCtrlKeys).filter((k) => !leafSet.has(k) && (midSet.has(k) || k.split('.').some((_, i, a) => midSet.has(a.slice(0, i + 1).join('.')))));

const byVerdict = (v) => rows.filter((r) => r.verdict === v);
const counts = {
    leaves: leaves.length, controls: controlCount,
    settingsCtrl: rows.filter((r) => r.control === '设定页控件').length,
    dedicatedCtrl: rows.filter((r) => r.control === '仅专用页控件').length,
    noControl: rows.filter((r) => r.control === '无控件').length,
    wired: rows.filter((r) => r.wired).length,
    fixUi: byVerdict('补 UI').length, noop: byVerdict('明确不做').length, closed: byVerdict('不做（已闭环）').length,
    noDefault: noDefault.length,
};

if (SUMMARY_ONLY) {
    console.log(JSON.stringify(counts, null, 2));
    console.log('补 UI：' + byVerdict('补 UI').map((r) => r.path).join('、'));
    console.log('无控件且无调度（明确不做）：' + byVerdict('明确不做').map((r) => r.path).join('、'));
    process.exit(0);
}

// ---------- markdown 输出（按域分组） ----------
const printRows = UNCOVERED_ONLY ? rows.filter((r) => r.uncovered) : rows;
console.log('| 键名 | 所属域 | 控件现状 | 调度现状 | 消费点（前 2 处） | 结论 | 改判理由 |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of printRows) {
    const hits = r.coreHits.slice(0, 2).map((f) => '`' + f + '`').join(' · ');
    console.log('| `' + r.path + '` | ' + r.dim + ' | ' + r.control + ' | ' + (r.wired ? '有' : '**无**') + ' | ' + (hits || '——') + ' | ' + r.verdict + ' | ' + (r.why || '——') + ' |');
}
console.error(JSON.stringify(counts, null, 2));
