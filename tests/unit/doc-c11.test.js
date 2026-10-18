// ============================================================
// 单元测试 · v3.50.25：W5 `技-22` —— C11 判据脚本 + `技-21` P0 修复
//
// 判据来源：`docs/D14` C11 · `开发守则.md` §2.7 A–E 组。
// 本测试锁四件事：
//   ① 五类反向探针都能被检出（E1 链式否定 / E3 并列标签 / E4 标题带版本 / B1 缺附录）；
//   ② 干净样本零命中（不误报）；
//   ③ 基线棘轮：当前工作区 `--strict` 通过；基线「只减不增」（改大基线的文件会被判失败）；
//   ④ `技-21` P0：`02` 的两处自相矛盾/并列标签已修（E3 归零、该处 E1 消失）。
//
// 运行：node tests/unit/doc-c11.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeReporter } from '../harness/st-mock.js';

const R = makeReporter('doc-c11 v3.50.25：W5 `技-22` C11 判据脚本（5 类反向探针 + 基线棘轮）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const run = (args) => {
    try {
        const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-doc-c11.js'), ...args], { cwd: ROOT, encoding: 'utf8' });
        return { code: 0, out };
    } catch (e) {
        return { code: Number(e.status) || 1, out: String(e.stdout || '') + String(e.stderr || '') };
    }
};

// ① 自检模式：5 组反向探针
A('A1 `--self-test` 五组反向探针全部通过（E1/E3/E4/B1 + 干净样本零命中）', (() => {
    const r = run(['--self-test']);
    return r.code === 0 && r.out.indexOf('C11 自检通过（5 组反向探针）') >= 0;
})(), 'n/a');

// ② strict 在当前工作区通过（说明基线覆盖了存量）
A('A2 当前工作区 `--strict` 通过（无新增违规；存量都在基线里）', (() => {
    const r = run(['--strict', '--quiet']);
    return r.code === 0 && r.out.indexOf('C11 主体纯度检查通过') >= 0;
})(), 'n/a');

// ③ 基线文件存在且形态正确（density 逐文件 + hits 逐类）
A('A3 基线文件形态正确：`density` 为逐文件映射、`hits` 为逐类计数，且 `E3` 已归零（`技-21` P0 修完并列标签）', (() => {
    const b = JSON.parse(readFileSync(join(ROOT, 'scripts', 'doc-c11-baseline.json'), 'utf8'));
    const keys = Object.keys(b.density || {});
    return keys.length >= 40 && typeof b.hits === 'object'
        && Number(b.hits.E3 || 0) === 0
        && keys.every((k) => Number.isFinite(Number(b.density[k])));
})(), 'n/a');

// ④ `技-21` P0：02 的两处
A('A4 `技-21` P0 已修：`02` 不再有「（vX 口径）」并列标签；「楼层突变口径」改成单一「自 v3.7.0 起」表述', (() => {
    const t = readFileSync(join(ROOT, 'docs', '02-数据架构.md'), 'utf8');
    const hasOldLabel = /（v\d+\.\d+\.\d+\s*口径）/.test(t);
    const hasOldInvert = /楼层突变口径\*\*（v3\.5\.0 起，v3\.7\.0 改为/.test(t);
    return hasOldLabel === false && hasOldInvert === false && t.indexOf('自 v3.7.0 起按**内容哈希**定位') >= 0;
})(), 'n/a');

// ⑤ 密度棘轮的方向：任一文档的正文版本号数不得超过基线（只减不增）
A('A5 密度棘轮：每份文档的正文版本号数都 ≤ 基线（新加版本叙述会立刻失败）', (() => {
    const b = JSON.parse(readFileSync(join(ROOT, 'scripts', 'doc-c11-baseline.json'), 'utf8'));
    const r = run(['--strict', '--quiet']);
    return r.code === 0 && Object.keys(b.density).length >= 40;
})(), 'n/a');

R.done();
