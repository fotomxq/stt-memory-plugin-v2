// ============================================================
// 单元测试 · **现状层文档里的 `cfg.*` 键必须真实存在**（v3.45.10，`docs/D22` W8 `应-25` / `docs/D17` U183 的机械守门）
//
// 为什么需要它：U183 是一次**真实的文档缺陷** —— `docs/04-应用架构.md` §2.2 的「唯一基准」行把 G3 同楼层上限
//   写成 `cfg.maxAutoRepairPerFloor`，而全仓实际键是 `cfg.maxAutoRepairRounds`（`maxAutoRepairPerFloor` 零命中）。
//   这类缺陷**没有任何门禁能发现**（文档门禁只查引用路径 / 数字口径 / 目录树），于是它静静躺了很多版：
//   读者按文档去 `cfg` 里找那个键，找不到、也不知道该信谁。
//   本档把「逐键核对」变成**每次跑单测都执行一次**的机械判据（`应-25` 的验收就是「逐键与 `defaultCfg` 对照」）。
//
// 口径（三条，写死在这里以免漂移）：
//   ① 扫描范围 = **现状层六个文件**（`docs/README.md` · `02` · `03` · `04` · `05` · `开发守则.md`）——
//      不含 `docs/history/**`（历史档是**当时的快照**，允许提到已删除的键）与 `docs/D*.md` 设计稿（可讨论未来键）；
//   ② 判据 = 反引号里的 `cfg.<键>` 必须能在 `core/config.js#defaultCfg` 里找到 —— **叶子**或**分组前缀**（如 `cfg.storage`）都算；
//   ③ **缺陷叙述豁免**：同一行若明确说这个键「不存在 / 无此键 / 已删除 / 死键 / 误写」，则允许出现（那正是在登记缺陷）。
//
// 运行：node tests/unit/docs-cfg-keys.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { defaultCfg } from '../../core/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = makeReporter('docs-cfg-keys v3.45.10 W8 应-25（现状层 cfg.* 键引用守门）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

/** 现状层六个文件（口径见文件头 ①） */
export const CURRENT_STATE_FILES = Object.freeze([
    'docs/README.md', 'docs/02-数据架构.md', 'docs/03-技术架构.md', 'docs/04-应用架构.md', 'docs/05-开发指南.md', '开发守则.md',
]);
/** 缺陷叙述豁免标记（口径见文件头 ③） */
export const NEGATIVE_MARKERS = Object.freeze(['不存在', '无此键', '已删除', '已移除', '死键', '误写', '零命中']);

/** `defaultCfg` 的全部键路径（叶子 + 分组前缀） */
export function cfgKeyIndex(cfg) {
    const out = new Set();
    (function walk(o, p) {
        for (const k of Object.keys(o || {})) {
            const v = o[k];
            const key = p ? p + '.' + k : k;
            out.add(key);                                            // 分组前缀也算（如 storage / storage.autoRepair）
            if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
        }
    })(cfg || {}, '');
    return out;
}

/**
 * 扫描一份文本：返回可疑引用 `[{ key, line, text }]`（已按豁免标记过滤）。
 * @param {string} text
 * @param {Set<string>} index
 */
export function scanCfgRefs(text, index) {
    const bad = [];
    const lines = String(text == null ? '' : text).split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const quoted = /`cfg\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`/g;
        let m = null;
        while ((m = quoted.exec(line))) {
            const key = m[1];
            if (index.has(key)) continue;
            if (NEGATIVE_MARKERS.some((x) => line.indexOf(x) >= 0)) continue;   // 缺陷叙述豁免
            bad.push({ key: key, line: i + 1, text: line.trim().slice(0, 140) });
        }
    }
    return bad;
}

const index = cfgKeyIndex(defaultCfg);

A('C1 索引口径：`cfgKeyIndex` 收录**叶子与分组前缀**（`storage` 与 `storage.autoRepair` 都算），数组不下钻', (() => {
    const idx = cfgKeyIndex({ a: 1, g: { b: 2, gg: { c: 3 } }, arr: [1, 2], s: 'x' });
    return idx.has('a') && idx.has('g') && idx.has('g.b') && idx.has('g.gg.c') && idx.has('arr') && idx.has('s')
        && idx.has('g.b.c') === false;
})(), '');

A('C2 扫描判据正反两向：**不存在的键报出**、「缺陷叙述」行**豁免**、存在的键（含分组前缀）零命中', (() => {
    const text = [
        '正常引用 `cfg.maxAutoRepairRounds` 与分组 `cfg.storage` 都应通过。',
        '缺陷登记：`cfg.maxAutoRepairPerFloor` 全仓不存在（实际是 `cfg.maxAutoRepairRounds`）。',
        '真缺陷：这里写 `cfg.notARealKey` 且没有任何豁免标记。',
        '代码里的 `state.autoRepair` 不是 cfg 引用，应当被忽略。',
    ].join('\n');
    const bad = scanCfgRefs(text, index);
    return bad.length === 1 && bad[0].key === 'notARealKey' && bad[0].line === 3;
})(), J(scanCfgRefs('`cfg.zzz`', index)));

A('C3 **现状层六个文件逐键核对**：出现的每个 `cfg.*` 都能在 `defaultCfg` 里找到（本次实测 0 处可疑）—— U183 那类缺陷从此不可能悄悄上线', (() => {
    const all = [];
    for (const rel of CURRENT_STATE_FILES) {
        let t = '';
        try { t = readFileSync(join(ROOT, rel), 'utf8'); } catch (e) { continue; }
        for (const b of scanCfgRefs(t, index)) all.push(rel + ':' + b.line + ' → cfg.' + b.key);
    }
    return CURRENT_STATE_FILES.length === 6 && all.length === 0;
})(), (() => {
    const all = [];
    for (const rel of CURRENT_STATE_FILES) {
        let t = '';
        try { t = readFileSync(join(ROOT, rel), 'utf8'); } catch (e) { continue; }
        for (const b of scanCfgRefs(t, index)) all.push(rel + ':' + b.line + ' → cfg.' + b.key);
    }
    return J(all);
})());

A('C4 **U183 的原始缺陷形态必须报红**（反向探针：把错键放回 `04` 那行的形态里 → 本判据会拦住它）', (() => {
    const sample = '| **自动修复** | G3 同楼层上限（`cfg.maxAutoRepairPerFloor`；手动重置即归零） |';
    const bad = scanCfgRefs(sample, index);
    return bad.length === 1 && bad[0].key === 'maxAutoRepairPerFloor';
})(), '');

R.done();
