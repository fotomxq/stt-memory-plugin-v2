// ============================================================
// 单元测试 · v3.40.3（`docs/D22` `技-15`）—— **配置声明一致性**（`scripts/check-config-decl.js`）
//
// 覆盖：
//   正向：当前工作区通过（有控件无键 0 · 缺默认值 0 · 无新增未覆盖键）；
//   反向探针（`docs/D21` §3.3 的验收判据「故意删除一个控件或默认值 → 脚本报出对应键」）：
//     P1 控件指向**完全不存在**的配置路径 → 报「有控件无键」；
//     P2 控件指向**只有中间节点**的路径（叶子无默认值）→ 报「缺默认值」；
//     P3 defaultCfg 新增一个没有控件的键 → 报「新增未覆盖键」（基线只减不增）；
//     P4 基线纪律：`--write-baseline` **不把**新增未覆盖键写进基线（不洗白漂移）。
//
// 探针手法：与 `tests/unit/version-rule.test.js` 的 C 组同款 ——
//   **临时改动真实源文件 → 以子进程跑门禁脚本 → `finally` 原样写回**（探针不改工作区最终状态）。
//
// 运行：node tests/unit/config-decl.test.js
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';

const R = makeReporter('config-decl v3.40.3 配置声明一致性（技-15：有控件无键 / 缺默认值 / 有键无控件基线）');
const A = (n, c, e) => R.assert(n, !!c, e);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CFG = join(ROOT, 'core', 'config.js');
const PAGES = join(ROOT, 'ui', 'settings-pages.js');
const BASELINE = join(ROOT, 'scripts', 'config-decl-baseline.json');

/** 跑子进程；返回 `{code, out}`（不抛） */
function runScript(extraArgs) {
    const args = [join(ROOT, 'scripts', 'check-config-decl.js')].concat(extraArgs || []);
    try {
        return { code: 0, out: String(execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' }) || '') };
    } catch (e) {
        return { code: Number(e.status) || 1, out: String(e.stdout || '') + String(e.stderr || '') };
    }
}
/** 临时改一个文件 → 跑回调 → 原样还原（异常也还原） */
function withPatched(file, mutate, fn) {
    const back = readFileSync(file, 'utf8');
    try {
        const next = mutate(back);
        if (next === back) throw new Error('探针未改动目标文件（mutate 未命中）');
        writeFileSync(file, next, 'utf8');
        return fn();
    } finally {
        try { writeFileSync(file, back, 'utf8'); } catch (e) { /* 忽略 */ }
    }
}
/** 在 `SETTINGS_CONTROLS` 字面量开头插入一个探针页（内含给定 key） */
const insertProbeControl = (key) => (src) => {
    const anchor = 'export const SETTINGS_CONTROLS = {';
    if (src.indexOf(anchor) < 0) return src;
    return src.replace(anchor, anchor + '\n    "__probe__": [{ "key": "' + key + '", "label": "探针", "type": "text" }],');
};
/** 在 `defaultCfg` 字面量开头插入一个探针键 */
const insertProbeCfgKey = (key) => (src) => {
    const anchor = 'const defaultCfg = {';
    if (src.indexOf(anchor) < 0) return src;
    return src.replace(anchor, anchor + '\n    ' + key + ': true,');
};

// ---------- 正向 ----------
A('P0 当前工作区通过：有控件无键 0 · 缺默认值 0 · 无新增未覆盖键（`--strict` 亦 exit 0）', (() => {
    const a = runScript([]);
    const b = runScript(['--strict']);
    return a.code === 0 && a.out.indexOf('配置声明一致性通过') >= 0
        && b.code === 0;
})(), '');

// ---------- 反向探针 ----------
A('P1 **有控件无键**：控件指向 `__probe_no_such_key__`（defaultCfg 里完全没有）→ 脚本必须报出该键（`--strict` 退出码 1）', (() => {
    return withPatched(PAGES, insertProbeControl('__probe_no_such_key__'), () => {
        const r = runScript(['--strict']);
        return r.code === 1 && r.out.indexOf('有控件无键') >= 0 && r.out.indexOf('__probe_no_such_key__') >= 0;
    });
})(), '');

A('P2 **缺默认值**：控件指向 `storage.__probe_no_default__`（`storage` 在、叶子不在）→ 脚本必须报「缺默认值」', (() => {
    return withPatched(PAGES, insertProbeControl('storage.__probe_no_default__'), () => {
        const r = runScript(['--strict']);
        return r.code === 1 && r.out.indexOf('缺默认值') >= 0 && r.out.indexOf('__probe_no_default__') >= 0;
    });
})(), '');

A('P3 **有键无控件**：defaultCfg 新增 `__probeNewCfgKey` 却没有控件 → 脚本必须报「新增未覆盖键」并点名（基线只减不增）', (() => {
    return withPatched(CFG, insertProbeCfgKey('__probeNewCfgKey'), () => {
        const r = runScript(['--strict']);
        return r.code === 1 && r.out.indexOf('新增未覆盖键') >= 0 && r.out.indexOf('__probeNewCfgKey') >= 0;
    });
})(), '');

A('P4 基线纪律：`--write-baseline` **不把**新增未覆盖键写进基线（洗白漂移），且不改动已豁免项', (() => {
    const backBase = readFileSync(BASELINE, 'utf8');
    try {
        return withPatched(CFG, insertProbeCfgKey('__probeNewCfgKey'), () => {
            runScript(['--write-baseline']);
            const after = JSON.parse(readFileSync(BASELINE, 'utf8'));
            const before = JSON.parse(backBase);
            const hasProbe = (after.uncovered || []).indexOf('__probeNewCfgKey') >= 0;
            return hasProbe === false && (after.uncovered || []).length === (before.uncovered || []).length;
        });
    } finally { try { writeFileSync(BASELINE, backBase, 'utf8'); } catch (e) { /* 忽略 */ } }
})(), '');

R.done();
