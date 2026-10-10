#!/usr/bin/env node
// ============================================================
// scripts/check-docs-facts.js —— **docs 事实一致性门禁**（v3.25.1 新增）
//
// 用户要求（原话）：「请核对 docs 文档内容的一致性，完善相关文档。」
//
// 为什么需要它：`scripts/check-docs.js` 只查**格式**（围栏 / 标题层级 / 头部元信息 / 行尾空白），
//   不查**内容是否与代码一致** —— 于是文档会静默漂移。已发生的真实例子：
//     · `docs/README.md` §3 表头写着「当前值（v3.19.0）」、版本号行写 `3.19.0`，而实际版本已到 3.25.0；
//     · 同一张表的「内核配置键数 222」与实测 221 不符。
//
// 判据（三条，全部可机械核对）：
//   ① **数字口径**：`docs/README.md` §3 的每一行，用它的「权威来源」**实测一遍**再与表内声明值比对；
//   ② **版本规则**：四处版本一致 + 版本号形如 `3.<minor>.<patch>`（主版本固定 3，位数不限）；
//   ③ **引用存在性**：文档里反引号包住的仓库路径（`.md`/`.js`/`.json`/`.css`/`.html`）必须真实存在；
//      且 `docs/README.md` §1 目录树列出的 `docs/*.md` 与磁盘上的**集合相等**（不允许多列 / 漏列）。
//
// 运行：node scripts/check-docs-facts.js
// ============================================================
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// v3.40.3（技-12）：批次档前缀匹配 / 目录树结构化解析抽为**纯函数库**，供本脚本与反向探针共用
import { BATCH_REF_RE as BATCH_REF_RE_LIB, batchHits as batchHitsLib, parseTopTreeNames } from './docs-facts-lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));
const problems = [];
const notes = [];

/** 取表格单元格里的**前导数字**（截到第一个全角/半角括号之前，避免吃到「（含 v3.13.0）」里的数字） */
function leadingNumbers(cell) {
    let s = String(cell == null ? '' : cell).replace(/[`*]/g, '').trim();
    const cut = s.search(/[（(]/);
    if (cut >= 0) s = s.slice(0, cut);
    const out = [];
    const re = /\d+/g;
    let m;
    while ((m = re.exec(s)) !== null) out.push(Number(m[0]));
    return out;
}

// ------------------------------------------------------------
// ① 数字口径（§3）
// ------------------------------------------------------------
const docsReadme = read('docs/README.md');

/** 解析 §3 表格：返回 [{ label, source, value }] */
function parseFactsTable(md) {
    const lines = String(md).split('\n');
    const start = lines.findIndex((l) => /^##\s*3\.\s*数字口径/.test(l));
    if (start < 0) return [];
    const rows = [];
    for (let i = start + 1; i < lines.length; i++) {
        const l = lines[i];
        if (/^##\s/.test(l)) break;
        const m = l.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/);
        if (!m) continue;
        if (/^-{2,}$/.test(m[1]) || m[1] === '口径') continue;
        rows.push({ label: m[1], source: m[2], value: m[3] });
    }
    return rows;
}

const facts = parseFactsTable(docsReadme);
if (!facts.length) problems.push('§3「数字口径」表未找到（docs/README.md 结构变了？）');

const manifest = readJson('manifest.json');
const pkg = readJson('package.json');
const constSrc = read('core/constants.js');
const changelogHead = (read('CHANGELOG.md').match(/^##\s+v?(\d+\.\d+\.\d+)/m) || [])[1] || '';
const constVer = (constSrc.match(/export const VERSION = '([^']+)'/) || [])[1] || '';

const dimsMod = await import('../core/constants.js');
const cfgMod = await import('../core/config.js');
const pagesMod = await import('../ui/settings-pages.js');
const panelMod = await import('../ui/panel.js');
const nsfwMod = await import('../core/nsfw.js');
const levelMod = await import('../core/nsfw-level.js');
const chunkMod = await import('../core/chunk.js');
const debugMod = await import('../ui/debug.js');

const pagesInfo = pagesMod.settingsPagesInfo();
const bridgeCount = Object.keys(debugMod.buildBridgeMethods()).length;
const i18nKeys = Object.keys(readJson('i18n/zh-cn.json')).length;
const i18nEn = Object.keys(readJson('i18n/en.json')).length;
const goldens = readdirSync(join(ROOT, 'tests', 'fixtures')).filter((f) => /^v1-golden.*\.json$/.test(f)).length;
const unitFiles = readdirSync(join(ROOT, 'tests', 'unit')).filter((f) => f.endsWith('.test.js')).length;
const historyFiles = readdirSync(join(ROOT, 'docs', 'history')).filter((f) => f.endsWith('.md') && f !== 'README.md').length;

/** 口径名 → 实测值数组（顺序与表内声明一致）；返回 `[]` = 该行由别处强制（本脚本跳过） */
const FACTS = {
    '版本号': () => [manifest.version],
    '版本号规则': () => [],                              // 规则文本由 scripts/check-version-sync.js 强制
    '数据模型版本': () => [Number(dimsMod.DATA_VERSION)],
    '维度数 / 原子层维度数': () => [dimsMod.DIMENSIONS.length, dimsMod.ATOM_DIM_KEYS.length],
    '内核配置键数': () => [Object.keys(cfgMod.defaultCfg).length],
    '提示词模板数': () => [Object.keys(cfgMod.PROMPT_TEMPLATES_V2).length],
    '设定子页数 / 配置控件数': () => [pagesInfo.pages.length, pagesInfo.pages.reduce((a, p) => a + p.controls, 0)],
    '面板分页数': () => [panelMod.PANEL_TABS.length],
    '单测规模': () => [unitFiles],                       // 断言数由 `tests/unit/run.js` 自己核对（它才知道实测值）
    '冒烟规模': () => [],                                 // 同上，由 `tests/smoke-test.js` 自己核对
    '黄金样本': () => [goldens],
    '词条数': () => [i18nKeys, 2],
    'NSFW 识别词条 / 转化词': () => [nsfwMod.NSFW_KEYWORDS.length, nsfwMod.NSFW_RULES.length],
    'NSFW 弱级信号词': () => [levelMod.NSFW_WEAK_SIGNALS.length],
    '调试桥只读方法数': () => [bridgeCount],
    '历史批次档数': () => [historyFiles],
    '每段正文数（分段口径）': () => [Number(chunkMod.SUMMARY_CHUNK_DEFAULT)],
};

for (const row of facts) {
    const f = FACTS[row.label];
    if (!f) { notes.push('未登记核验方式的口径（仅提示）：' + row.label); continue; }
    const got = f();
    if (!got.length) continue;                             // 交由对应 runner 自查
    const want = leadingNumbers(row.value);
    // 字符串型口径（如版本号 `3.25.0`）：直接比字符串，不做数字拆解
    const same = (typeof got[0] === 'string')
        ? String(row.value).replace(/[`*\s]/g, '') === got[0]
        : (want.length >= got.length && got.every((v, i) => want[i] === v));
    if (!same) {
        problems.push('§3「' + row.label + '」表内 ' + JSON.stringify(typeof got[0] === 'string' ? row.value : want)
            + ' ≠ 实测 ' + JSON.stringify(got) + '（来源：' + row.source.replace(/[`]/g, '') + '）');
    }
}
if (i18nKeys !== i18nEn) problems.push('词条：zh-cn ' + i18nKeys + ' 条 ≠ en ' + i18nEn + ' 条（两语言必须同键集）');

// ------------------------------------------------------------
// ①b 目录地图（`docs/05-开发指南.md` §2）—— **只核文件数**（行数不登记，见该节说明）
// ------------------------------------------------------------
const guide = read('docs/05-开发指南.md');
/** 目录地图计数时**不计入**的产物目录（gitignore / 本地调试产物，克隆后并不存在）：
 *  `node_modules` / `.git` / `tests/local/out`（本地自检与探针产物）。 */
const COUNT_SKIP = ['node_modules', '.git', 'tests/local/out'];
function countFiles(dir, ok) {
    let n = 0;
    const walk = (d) => {
        let ents = [];
        try { ents = readdirSync(join(ROOT, d), { withFileTypes: true }); } catch (e) { return; }
        for (const e of ents) {
            if (COUNT_SKIP.indexOf(e.name) >= 0) continue;
            const q = d + '/' + e.name;
            if (COUNT_SKIP.indexOf(q) >= 0) continue;
            if (e.isDirectory()) walk(q);
            else if (ok(e.name)) n++;
        }
    };
    walk(dir);
    return n;
}
const MAP_FACTS = [
    ['`core/`', () => countFiles('core', (f) => f.endsWith('.js'))],
    ['`host/`', () => countFiles('host', (f) => f.endsWith('.js'))],
    ['`adapters/`', () => countFiles('adapters', (f) => f.endsWith('.js'))],
    ['`ui/`', () => countFiles('ui', (f) => f.endsWith('.js'))],
    ['`tests/`', () => countFiles('tests', (f) => /\.(js|mjs|cjs)$/.test(f))],
    ['`tests/fixtures/`', () => countFiles('tests/fixtures', (f) => f.endsWith('.json'))],
    ['`scripts/`', () => countFiles('scripts', (f) => f.endsWith('.js'))],
    ['`index.js`', () => (existsSync(join(ROOT, 'index.js')) ? 1 : 0)],
];
for (const [label, calc] of MAP_FACTS) {
    const row = guide.split('\n').filter((l) => l.indexOf('| ' + label + ' |') === 0 || l.indexOf('| ' + label + ' |') > 0)[0] || '';
    if (!row) { problems.push('docs/05-开发指南.md §2 目录地图缺少行：' + label); continue; }
    const cell = row.split('|')[2] || '';
    const want = leadingNumbers(cell)[0];
    const got = calc();
    if (want === undefined) { problems.push('docs/05-开发指南.md §2「' + label + '」行没写文件数（应形如 `70（.js 递归）`）'); continue; }
    if (want !== got) problems.push('docs/05-开发指南.md §2「' + label + '」文件数：文档写 ' + want + '，实测 ' + got);
}

// ------------------------------------------------------------
// ② 版本规则（主版本固定 3；位数不限；四处一致）
// ------------------------------------------------------------
const VER_RE = /^3\.\d+\.\d+$/;
for (const [where, v] of [['manifest.json', manifest.version], ['package.json', pkg.version], ['core/constants.js', constVer], ['CHANGELOG.md 首条', changelogHead]]) {
    if (!v) { problems.push('版本号缺失：' + where); continue; }
    if (!VER_RE.test(v)) {
        problems.push('版本号不合规：' + where + ' = ' + v
            + '（规则：在 3.XX.XX 基础上**追加**，主版本固定 3、minor/patch 位数不限；改主版本须用户明确要求并同步本脚本）');
    }
}
if (new Set([manifest.version, pkg.version, constVer, changelogHead].filter(Boolean)).size > 1) {
    problems.push('版本号四处不一致：' + [manifest.version, pkg.version, constVer, changelogHead].join(' / '));
}

// ------------------------------------------------------------
// ③ 引用存在性 + 目录树集合相等
// ------------------------------------------------------------
function walkMd(dir, acc = []) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walkMd(p, acc);
        else if (name.endsWith('.md')) acc.push(p);
    }
    return acc;
}
const mdFiles = walkMd(ROOT);
const PATH_RE = /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5./-]*\.(md|js|mjs|cjs|json|css|html)$/;
/**
 * **批次档前缀引用**（v3.40.3 / `docs/D22` `技-12`，登记 `docs/D17` U132）。
 *   历史盲区：C5 只校验**带扩展名**的引用 → `history/P10c46` 这类「批次档前缀」从未被拦住，
 *   于是「最近一次界面变更」指向的批次档悄悄过期了也没人发现。
 *   匹配形态与唯一匹配判据见 `scripts/docs-facts-lib.js`（纯函数，便于反向探针直接驱动）。
 */
const BATCH_REF_RE = BATCH_REF_RE_LIB;
/** 批次档目录下的文件名（C5 扩展用的唯一索引） */
const historyDocNames = (() => {
    try { return readdirSync(join(ROOT, 'docs', 'history')).filter((f) => f.endsWith('.md') && f !== 'README.md'); } catch (e) { return []; }
})();
/** 前缀 → 命中的批次档（唯一匹配；实现见 lib） */
function batchHits(prefix) { return batchHitsLib(prefix, historyDocNames); }
/**
 * **失效路径豁免标记**（行内 HTML 注释，渲染时不可见）：用于**文档本身在登记一处错误路径**的场合
 *   —— 例如 `docs/D14` 逐条列出「旧文写错的文件名」，那些路径**本来就不存在**、也不该被判为引用失效。
 * 口径：标记只豁免**它所在的那一行**；必须在同一行显式写出，且该行应说明「为什么这是失效路径」
 *   （写错 / 已删除 / 已改名），不许拿它当成逃避检查的通用开关。
 */
const MISSING_PATH_OK = '<!-- 失效路径豁免 -->';
const BARE_DIRS = ['', 'tests/unit/', 'tests/fixtures/', 'tests/harness/', 'tests/local/', 'tests/', 'scripts/', 'core/', 'core/model/', 'host/', 'ui/', 'adapters/', 'i18n/', 'docs/history/'];
/** 裸文件名（无目录）的常见落点（当前文档里用简称很常见，这里把简称解析到真实目录） */
/** 只校验**现状/设计/专项层**文档：`CHANGELOG.md` 与 `docs/history/**` 是只增不改的历史快照，
 *  里面的旧路径（如归档前的 `docs/P10ar-*.md`）**当时是对的**，不能按现在判错（其过时由勘误表登记）。 */
function isHistorical(rel) {
    return rel === 'CHANGELOG.md' || rel.indexOf('docs/history/') === 0;
}
/**
 * **仓库外**的路径白名单（文档里合法出现、但本仓库不该有这些文件）：
 *   · `settings.json` / `tauritavern-settings.json` —— 酒馆 / TauriTavern 的宿主侧配置（在用户数据目录里）；
 *   · `local.config.json` —— `tests/local/` 的本地实参（gitignore，由用户按 README 自建）；
 *   · `CLAUDE.md` —— **上游参考实现**（`baibai-git/ST-BaiBai-Book`）的文档，本仓库只有引用；
 *   · `st-context.js` / `public/script.js` / `public/scripts/st-context.js` —— 酒馆宿主源码（不在本仓库）；
 *   · `stt-memory-plugin-v2/manifest.json` —— 宿主扩展目录里**本插件副本**的路径。
 */
const EXTERNAL_PATHS = new Set([
    'settings.json', 'tauritavern-settings.json', 'local.config.json', 'tests/local/local.config.json', 'CLAUDE.md',
    'st-context.js', 'public/script.js', 'public/scripts/st-context.js',
    'stt-memory-plugin-v2/manifest.json',
]);
let refChecked = 0;
let batchRefChecked = 0;
for (const f of mdFiles) {
    const rel = relative(ROOT, f).split('\\').join('/');
    if (isHistorical(rel)) continue;
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
        if (line.indexOf(MISSING_PATH_OK) >= 0) return;          // 本行显式声明「在登记失效路径」
        const re = /`([^`\n]+)`/g;
        let m;
        while ((m = re.exec(line)) !== null) {
            let tok = String(m[1]).trim();
            if (!tok || tok.length > 120) continue;
            if (tok.indexOf(' ') >= 0 || tok.indexOf('*') >= 0 || tok.indexOf('…') >= 0 || tok.indexOf('|') >= 0) continue;
            if (/^https?:/i.test(tok)) continue;
            tok = tok.split('#')[0].split('?')[0];
            // 批次档前缀引用（无扩展名）：单独一条判据（v3.40.3 / 技-12）
            const bm = BATCH_REF_RE.exec(tok);
            if (bm) {
                const hits = batchHits(bm[1]);
                batchRefChecked++;
                if (hits.length === 0) {
                    problems.push('批次档引用不存在：' + rel + ':' + (i + 1) + ' → ' + tok
                        + '（docs/history/ 下没有以 `' + bm[1] + '-` 开头、也不叫 `' + bm[1] + '.md` 的文件；'
                        + '若本行是在**举例说明**编号 / 区间（而非引用某一份批次档），请在本行加 `' + MISSING_PATH_OK + '`）');
                } else if (hits.length > 1) {
                    problems.push('批次档引用不唯一：' + rel + ':' + (i + 1) + ' → ' + tok
                        + '（匹配到 ' + hits.length + ' 份：' + hits.slice(0, 4).join('、') + (hits.length > 4 ? '…' : '') + '；请写到能唯一匹配的前缀）');
                }
                continue;
            }
            if (!PATH_RE.test(tok)) continue;
            if (EXTERNAL_PATHS.has(tok)) continue;
            const cands = [tok, 'docs/' + tok, 'docs/history/' + tok];
            if (tok.indexOf('/') < 0) for (const d of BARE_DIRS) cands.push(d + tok);
            refChecked++;
            if (!cands.some((c) => existsSync(join(ROOT, c)))) {
                problems.push('引用不存在：' + rel + ':' + (i + 1) + ' → ' + tok
                    + '（若为仓库外路径，请加进本脚本的 EXTERNAL_PATHS 白名单并写明理由）');
            }
        }
    });
}

// ------------------------------------------------------------
// ③b 引用形态：C8 符号级存在性 + C9 绝对行号棘轮（v1.1，见 docs/D14 §3 / docs/D15 §6）
// ------------------------------------------------------------
/**
 * **C8：`文件#符号` 里的符号必须真实存在**（词边界匹配；允许 `符号()` 形态）。
 *   动机：文件存在 ≠ 文档说的函数/常量还在 —— 改名或删除后文档仍指着它，读者会被误导。
 *   口径：只核**本仓库**、**非历史层**的文档；仓库外路径（C5 的白名单）不参与；文件不存在交给 C5 报错。
 */
const SYM_REF_RE = /^([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5./-]*\.(?:m?js|cjs))#([A-Za-z_$][\w$]*)(?:\(\))?$/;
const LINE_REF_RE = /^([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5./-]*\.(?:m?js|cjs)):(\d+)(?:-(\d+))?$/;
const bodyCache = new Map();
/** 解析仓库内文件（裸文件名按常见落点试；找不到返回 null —— 由 C5 报「引用不存在」） */
function repoFileBody(rel) {
    if (bodyCache.has(rel)) return bodyCache.get(rel);
    const cands = [rel];
    if (rel.indexOf('/') < 0) for (const d of BARE_DIRS) cands.push(d + rel);
    let out = null;
    for (const c of cands) { if (existsSync(join(ROOT, c))) { out = { path: c, text: read(c) }; break; } }
    bodyCache.set(rel, out);
    return out;
}
let symRefChecked = 0;
let lineRefChecked = 0;
const lineRefSamples = [];
for (const f of mdFiles) {
    const rel = relative(ROOT, f).split('\\').join('/');
    if (isHistorical(rel)) continue;
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
        if (line.indexOf(MISSING_PATH_OK) >= 0) return;
        const re = /`([^`\n]+)`/g;
        let m;
        while ((m = re.exec(line)) !== null) {
            const tok = String(m[1]).trim();
            if (!tok || tok.length > 120 || tok.indexOf(' ') >= 0 || tok.indexOf('|') >= 0) continue;
            const sm = SYM_REF_RE.exec(tok);
            if (sm) {
                const hit = repoFileBody(sm[1]);
                if (!hit) continue;                                   // 文件不存在 → 由 C5 报错
                symRefChecked++;
                if (!new RegExp('\\b' + sm[2].replace(/\$/g, '\\$&') + '\\b').test(hit.text)) {
                    problems.push('符号引用不存在：' + rel + ':' + (i + 1) + ' → ' + tok
                        + '（该文件里找不到这个标识符：改名/删除后请同步文档，或改指现存符号）');
                }
                continue;
            }
            const lm = LINE_REF_RE.exec(tok);
            if (lm) {
                if (!repoFileBody(lm[1])) continue;                   // 冻结坐标（V1 源码等不在本仓库）→ 不计入
                lineRefChecked++;
                if (lineRefSamples.length < 3) lineRefSamples.push(rel + ':' + (i + 1) + ' → ' + tok);
            }
        }
    });
}
/**
 * **C9：本仓库自有源码的绝对行号引用「只减不增」**（存量预算 = 棘轮）。
 *   行号会随任何一次代码改动漂移，文档不会自动跟着走；**新引用一律写 `文件#符号`**（C8 负责核）。
 *   冻结坐标（V1 源码行号、历史档）不在本仓库 → 不计入本预算。
 *   **注意**：`tests/unit/version-rule.test.js` 的「C9 反向探针」会临时新增 12 条行号并要求门禁失败 ——
 *   因此预算必须**紧贴实际存量**（留有富余会让该探针失效）。
 *
 *   v3.40.3（`docs/D22` `技-13` / `docs/D17` U133）：预算**不再硬编码在本脚本里** ——
 *   从 `scripts/line-ref-budget.json` 读 `baseline + margin`（棘轮语义不变：实测 > 预算即失败）。
 *   下调棘轮只需 `node scripts/check-docs-facts.js --write-baseline`（或手改该 JSON），
 *   **改引用之后不再需要手改门禁脚本本身**。
 */
const BUDGET_REL = 'scripts/line-ref-budget.json';
const budgetInfo = (() => {
    try {
        const j = JSON.parse(read(BUDGET_REL));
        const base = Number(j && j.baseline);
        const margin = Number(j && j.margin);
        if (!Number.isFinite(base) || base < 0) return { ok: false, error: 'baseline 缺失或非数字' };
        if (!Number.isFinite(margin) || margin < 0) return { ok: false, error: 'margin 缺失或非数字' };
        return { ok: true, baseline: base, margin: margin, budget: base + margin, raw: j };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
})();
if (!budgetInfo.ok) {
    problems.push('C9 预算文件不可用：scripts/line-ref-budget.json（' + budgetInfo.error
        + '）—— 该文件是行号棘轮预算的唯一来源，见 开发指南 §3 与 `docs/D22` `技-13`');
}
const LINE_REF_BUDGET = budgetInfo.ok ? budgetInfo.budget : 0;
if (budgetInfo.ok && lineRefChecked > LINE_REF_BUDGET) {
    problems.push('本仓库源码的绝对行号引用 ' + lineRefChecked + ' 处 > 预算 ' + LINE_REF_BUDGET
        + '（= baseline ' + budgetInfo.baseline + ' + margin ' + budgetInfo.margin
        + '，见 scripts/line-ref-budget.json）（新增引用请写 `文件#符号`，见 开发守则 §2.3 / docs/D14 C9）· 例：' + lineRefSamples.join('、'));
}
if (budgetInfo.ok) {
    notes.push('引用形态：`文件#符号` ' + symRefChecked + ' 处全部可解析；本仓库源码绝对行号 '
        + lineRefChecked + '/' + LINE_REF_BUDGET + '（只减不增；预算来自 scripts/line-ref-budget.json 的 baseline '
        + budgetInfo.baseline + ' + margin ' + budgetInfo.margin + '）');
    // v3.40.3（技-13）：`--write-baseline` = 把棘轮落到本次实测值（只允许下调；上调需显式 `--force`）
    if (process.argv.indexOf('--write-baseline') >= 0) {
        const cur = Number(budgetInfo.baseline);
        const force = process.argv.indexOf('--force') >= 0;
        if (lineRefChecked > cur && !force) {
            console.log('  ⚠️ --write-baseline 拒绝上调：实测 ' + lineRefChecked + ' > baseline ' + cur
                + '（棘轮只减不增；确需上调请显式加 --force 并在 CHANGELOG 说明原因）');
        } else {
            budgetInfo.raw.baseline = lineRefChecked;
            budgetInfo.raw.updatedAt = new Date().toISOString().slice(0, 10);
            budgetInfo.raw.updatedBy = 'check-docs-facts.js --write-baseline（实测 ' + lineRefChecked + ' 处）';
            try {
                writeFileSync(join(ROOT, BUDGET_REL), JSON.stringify(budgetInfo.raw, null, 2) + '\n', 'utf8');
                console.log('  ✅ 已写入 C9 预算：baseline ' + cur + ' → ' + lineRefChecked
                    + '（scripts/line-ref-budget.json，margin ' + budgetInfo.margin + '）');
            } catch (e) { console.log('  ❌ 写入预算文件失败：' + String((e && e.message) || e)); }
        }
    }
}

// §3 表头声明的版本必须等于当前版本（表头写「当前值（vX.Y.Z）」；不随版本更新就会出现「表说旧版本、行却是新值」）
const claimVer = (docsReadme.match(/当前值（v(\d+\.\d+\.\d+)）/) || [])[1];
if (!claimVer) {
    problems.push('docs/README.md §3 表头缺少「当前值（vX.Y.Z）」标注（口径表必须写明它是哪一版的口径）');
} else if (claimVer !== manifest.version) {
    problems.push('§3 表头标注的版本 v' + claimVer + ' ≠ 当前版本 ' + manifest.version + '（表头也要随版本更新）');
}

// 目录树列出的 docs/*.md 与磁盘集合必须相等（不含 README.md 自身；`history/` 子树单独看）
// C6（v3.40.3 / 技-12）：**结构化解析**取代裸子串截断 —— 实现见 `scripts/docs-facts-lib.js#parseTopTreeNames`
//   （旧实现用 `block.indexOf('history/')` 截断：树里任一**描述文字**含该子串就会静默截短比较范围）
const treeNames = parseTopTreeNames(docsReadme);
const diskDocs = readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
const missingInTree = diskDocs.filter((f) => treeNames.indexOf(f) < 0);
const extraInTree = treeNames.filter((f) => diskDocs.indexOf(f) < 0);
if (missingInTree.length) problems.push('docs/README.md §1 目录树**漏列**：' + missingInTree.join('、'));
if (extraInTree.length) problems.push('docs/README.md §1 目录树**多列**（文件不存在）：' + extraInTree.join('、'));

// ------------------------------------------------------------
const scanned = mdFiles.length;
console.log('docs 事实一致性检查：' + scanned + ' 个 Markdown · 核对 §3 口径 ' + facts.length + ' 行'
    + ' · 目录地图 ' + MAP_FACTS.length + ' 行 · 引用 ' + refChecked + ' 处');
if (notes.length) for (const n of notes) console.log('  · ' + n);
if (problems.length) {
    for (const p of problems) console.log('  ❌ ' + p);
    console.log('docs 事实一致性：' + problems.length + ' 处不一致（请更新文档或权威来源，二者必须一致）');
    process.exit(1);
}
console.log('✅ docs 事实一致性通过（数字口径 / 版本规则 / 引用与目录树均一致）');
