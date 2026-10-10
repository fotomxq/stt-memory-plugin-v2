#!/usr/bin/env node
// ============================================================
// scripts/check-config-decl.js —— **配置声明一致性**（`docs/D22` `技-15` / `docs/D17` U135）
//
// 背景（`docs/D21` §3.3）：内核配置有 **221** 个键，一致性靠**多处手工同步** ——
//   `core/config.js#defaultCfg`（有默认值）+ `ui/settings-pages.js#SETTINGS_CONTROLS`（有界面控件）。
//   两者漂移的三种形态，本脚本逐条查：
//
//   | 判据 | 含义 | 期望 |
//   | --- | --- | --- |
//   | **有控件无键** | 控件指向的配置路径在 `defaultCfg` 里**完全不存在** | **0**（真缺陷：控件写了个不存在的键） |
//   | **缺默认值** | 控件路径只命中**中间节点**（如 `storage.foo` 的 `storage` 在、`foo` 不在） | **0**（真缺陷：控件有、默认值没有） |
//   | **有键无控件** | `defaultCfg` 的叶子键没有任何控件 | 基线化（见下） |
//
//   第三条**天然有大量合理项**（内部开关 / 派生值 / 由其它键驱动的键，共 150+）→ 直接全量打印是噪声。
//   故按本仓库既有的**「基线只减不增」**纪律处置：`scripts/config-decl-baseline.json` 记录「当前未覆盖」的键集，
//   之后**新增未覆盖键**（= 加了配置却没给控件）与**基线该收窄**（= 某键已有控件却仍留在基线）都会报出来 ——
//   两种都是「该看一眼」的信号，而不再是一堆常驻噪声。
//
// 模式：默认 **warning（永远 exit 0）**，与 `scripts/check-ui-spec.js` 同口径（`docs/D21` §3.3「先 warning 后评阻断」）；
//   加 `--strict` 才在发现问题时 exit 1（供后续升级为阻断门禁）。
//   `--write-baseline` 把「有键无控件」基线**收紧**到当前实测（只减不增：新增未覆盖键不会被写进基线）。
//
// 用法：node scripts/check-config-decl.js [--strict] [--quiet] [--write-baseline]
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const quiet = process.argv.includes('--quiet');
const writeBaseline = process.argv.includes('--write-baseline');
const BASELINE_REL = 'scripts/config-decl-baseline.json';

/**
 * 极简 DOM / window 桩：`ui/settings-pages.js` 及其传递依赖在**导入期**只做定义，
 *   不触碰 DOM（真机装配才碰）。这里给最小可用对象，使本脚本**零测试框架依赖**即可加载同一份声明源。
 *   刻意不引 `tests/harness/`：门禁脚本不该依赖测试目录。
 */
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

/** 把配置对象摊平成「叶子路径 / 中间节点路径」两个集合 */
function flatten(obj) {
    const leaves = new Set(), mids = new Set();
    (function walk(o, p) {
        if (!o || typeof o !== 'object') return;
        for (const k of Object.keys(o)) {
            const path = p ? p + '.' + k : k;
            const v = o[k];
            const isPlainObj = v && typeof v === 'object' && !Array.isArray(v);
            if (isPlainObj) { mids.add(path); walk(v, path); } else leaves.add(path);
        }
    })(obj, '');
    return { leaves, mids };
}

const problems = [];
const notes = [];

stubDom();
let defaultCfg = null, SETTINGS_CONTROLS = null;
try { ({ defaultCfg } = await import('../core/config.js')); } catch (e) { problems.push('无法加载 core/config.js：' + String((e && e.message) || e)); }
try { ({ SETTINGS_CONTROLS } = await import('../ui/settings-pages.js')); } catch (e) { problems.push('无法加载 ui/settings-pages.js：' + String((e && e.message) || e)); }

if (defaultCfg && SETTINGS_CONTROLS) {
    const { leaves, mids } = flatten(defaultCfg);
    /** 控件清单（去重；同一 key 出现在多页只算一次，但如实记下出现次数） */
    const ctrlKeys = [];
    for (const page of Object.keys(SETTINGS_CONTROLS)) {
        for (const c of (SETTINGS_CONTROLS[page] || [])) {
            if (c && c.key) ctrlKeys.push(String(c.key));
        }
    }
    const ctrlSet = new Set(ctrlKeys);
    /** 路径本身是不是 defaultCfg 里的节点（叶子或中间节点） */
    const pathExists = (k) => leaves.has(k) || mids.has(k);
    /** 该路径的**真前缀**（不含自身）里有没有 defaultCfg 的节点 —— 用来区分「写错命名空间」与「命名空间对、叶子缺默认值」 */
    const prefixExists = (k) => {
        const parts = String(k).split('.');
        for (let i = parts.length - 1; i >= 1; i--) {
            if (pathExists(parts.slice(0, i).join('.'))) return true;
        }
        return false;
    };

    /**
     * 判据①：**有控件无键** —— 控件指向的路径在 defaultCfg 里完全找不到，**连命名空间都不存在**
     *   （例：控件写 `fooBar`，defaultCfg 里既没有 `fooBar` 也没有 `fooBar.*`）。
     */
    const orphanControls = ctrlKeys.filter((k) => !pathExists(k) && !prefixExists(k));
    /**
     * 判据②：**缺默认值** —— 控件指向的**命名空间存在**（某级前缀是 defaultCfg 的节点），
     *   但该叶子本身没有默认值（例：控件写 `storage.新开关`，`storage` 在、`storage.新开关` 不在）。
     *   与判据①的分工：① 是"命名空间都写错了"，② 是"命名空间对、默认值漏了"。
     */
    const noDefault = ctrlKeys.filter((k) => !pathExists(k) && prefixExists(k));
    // 判据③：有键无控件（基线化）
    const uncovered = Array.from(leaves).filter((k) => !ctrlSet.has(k)).sort();

    if (orphanControls.length) problems.push('**有控件无键**（控件指向的路径在 defaultCfg 里连命名空间都不存在）：' + Array.from(new Set(orphanControls)).join('、'));
    if (noDefault.length) problems.push('**缺默认值**（控件路径的命名空间在，但该叶子没有默认值）：' + Array.from(new Set(noDefault)).join('、'));

    // 基线（只减不增）
    let baseline = null;
    try { baseline = JSON.parse(readFileSync(join(ROOT, BASELINE_REL), 'utf8')); } catch (e) { baseline = null; }
    const baseList = (baseline && Array.isArray(baseline.uncovered)) ? baseline.uncovered.map(String) : [];
    const baseSet = new Set(baseList);
    let addedUncovered = [], staleBaseline = [];
    if (!baseline) {
        problems.push('基线文件缺失或不可解析：' + BASELINE_REL + '（用 `--write-baseline` 生成）');
    } else {
        addedUncovered = uncovered.filter((k) => !baseSet.has(k));            // 新增了配置却没给控件
        staleBaseline = baseList.filter((k) => !uncovered.includes(k));        // 基线该收窄了（该键已有控件 / 已删除）
        if (addedUncovered.length) problems.push('**新增未覆盖键**（defaultCfg 有、控件没有，且不在基线里）：' + addedUncovered.join('、')
            + '（给它加控件，或确认是内部键后跑 `--write-baseline` 记入基线）');
        if (staleBaseline.length) problems.push('**基线该收窄**（基线里这些键现已无需豁免）：' + staleBaseline.join('、')
            + '（跑 `--write-baseline` 收紧；只减不增纪律见 `docs/D21` §3.3）');
        notes.push('有键无控件（基线内、不报）：' + (uncovered.length - addedUncovered.length) + ' 项；基线规模 ' + baseList.length);
    }

    if (writeBaseline) {
        /**
         * **建基线（bootstrap）**：基线文件缺失或为空时，把当前未覆盖键**全部**记入 —— 这是唯一一次
         *   「接受现状」的写入（否则第一次跑脚本会把 150+ 条存量内部键全判成「新增漂移」，基线永远建不起来）。
         * **收紧（只减不增）**：基线已存在且非空时，只保留「当前仍未覆盖」的那些 ——
         *   新增未覆盖键**不写进**基线（否则等于把新漂移洗白）。
         */
        const boot = (!baseline || baseList.length === 0);
        const keep = boot ? uncovered.slice() : baseList.filter((k) => uncovered.includes(k));
        const out = {
            what: '配置声明一致性（`docs/D22` `技-15`）：defaultCfg 里「有键无控件」的**基线键集**（只减不增）',
            why: '内部开关 / 派生值天然没有控件；基线把这些常驻噪声固化，只让**新增未覆盖键**与**基线该收窄**报出来',
            how: 'node scripts/check-config-decl.js --write-baseline（沿用只减不增纪律）',
            updatedAt: new Date().toISOString().slice(0, 10),
            uncovered: keep,
        };
        try {
            writeFileSync(join(ROOT, BASELINE_REL), JSON.stringify(out, null, 2) + '\n', 'utf8');
            notes.push('已' + (boot ? '建立（bootstrap）' : '收紧') + '基线：' + baseList.length + ' → ' + keep.length + '（' + BASELINE_REL + '）'
                + (!boot && addedUncovered.length ? ('；新增未覆盖键 ' + addedUncovered.length + ' 项**未**写入基线（需先处置）') : ''));
        } catch (e) { problems.push('写入基线失败：' + String((e && e.message) || e)); }
    }

    notes.unshift('配置声明：defaultCfg 叶子 ' + leaves.size + ' 个 / 控件 ' + ctrlKeys.length + ' 个（去重 ' + ctrlSet.size + ' 个）');
}

console.log('配置声明一致性检查：' + (problems.length ? '' : ''));
for (const n of notes) console.log('  · ' + n);
if (problems.length) {
    if (!quiet) for (const p of problems) console.log('  ⚠️ ' + p);
    console.log('配置声明一致性：' + problems.length + ' 类问题（'
        + (strict ? '--strict → 视为失败' : 'warning 模式：不阻断，见 docs/D21 §3.3「先 warning 后评阻断」') + '）');
    process.exit(strict ? 1 : 0);
}
console.log('✅ 配置声明一致性通过（有控件无键 0 · 缺默认值 0 · 无新增未覆盖键）');
