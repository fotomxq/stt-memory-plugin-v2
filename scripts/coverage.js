// ============================================================
// scripts/coverage.js —— **覆盖率报告（先观测、不阻断）**（v3.45.0，`docs/D22` W5 `技-11`）
//
// 用户要求（原话）：「新版本v3.45.0 / 开发W5待开发事项。」
// 设计依据：`docs/D21` §3.2 / §8 `技-11` ——
//   「用 Node 原生覆盖率产出报告（**先观测不阻断**）；记录 `core/` 基线」；
//   验收：「报告可产出并可读；基线写进文档（**不写死会变的百分比到正文**，按 `D14` 口径指向命令）」。
//
// 用法：
//   node scripts/coverage.js              # 跑整套单测并打印覆盖率表（core/ 在前，其余在后）
//   node scripts/coverage.js --filter core/   # 只看某个前缀
//   node scripts/coverage.js --quiet          # 只打印合计
//
// **退出码恒为 0**（除非自身崩溃）：本项是**观测**，不是门禁 —— 覆盖率数字会随新增测试波动，
//   把它变成阻断会让「加一个还没测的新模块」立刻卡住门禁（与 `技-11` 的「先观测」直接冲突）。
//
// 实现要点：
//   · **零依赖**（`docs/D21` Q5：不允许引入需要 `node_modules` 的工具）—— 只用 `node:fs` / `node:child_process`；
//   · 借助 `NODE_V8_COVERAGE=<临时目录>` 让**子进程**（含它再 spawn 的每个测试文件）各自落一份
//     `coverage-*.json`；跑完读取全部条目 → 按 URL 映射回仓库文件 → 折算行覆盖；
//   · 折算口径见 `scripts/coverage-lib.js`（纯函数、有单测）；
//   · 临时目录跑完即删（不留垃圾）；`--keep` 可保留以便人工核查原始数据。
// ============================================================
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { summarize, filterPrefix, formatSummary, entriesOfCoverageJson } from './coverage-lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = argv.indexOf(name);
    return (i >= 0 && argv[i + 1] && argv[i + 1].indexOf('--') !== 0) ? argv[i + 1] : dflt;
};
const FILTER = argOf('--filter', '');
const QUIET = argv.includes('--quiet');
const KEEP = argv.includes('--keep');

/** 只统计本仓库的**源码**（排除测试 / 脚本 / node_modules / 文档） */
const SOURCE_PREFIXES = ['core/', 'host/', 'adapters/', 'ui/'];
const isSource = (rel) => SOURCE_PREFIXES.some((p) => rel.indexOf(p) === 0) || rel === 'index.js' || rel === 'devtools.js';

/** URL → 仓库文件 + 源码字节（不属于本仓库源码 → null） */
function resolveUrl(url) {
    try {
        const u = String(url || '');
        if (!u.startsWith('file://')) return null;
        const abs = fileURLToPath(u);
        if (abs.indexOf(ROOT) !== 0) return null;
        const rel = relative(ROOT, abs).split(sep).join('/');
        if (!/\.(js|mjs|cjs)$/.test(rel)) return null;
        if (rel.indexOf('node_modules/') >= 0) return null;
        if (!isSource(rel)) return null;
        if (!existsSync(abs)) return null;
        return { file: rel, source: readFileSync(abs) };
    } catch (e) { return null; }
}

/** 读取覆盖率目录里的全部条目（形态识别在 lib 里，可单测） */

function collectEntries(dir) {
    const out = [];
    let names = [];
    try { names = readdirSync(dir); } catch (e) { return out; }
    for (const n of names) {
        const p = join(dir, n);
        try { if (!statSync(p).isFile() || !/^coverage-.*\.json$/.test(n)) continue; } catch (e) { continue; }
        try { out.push(...entriesOfCoverageJson(readFileSync(p, 'utf8'))); } catch (e) { /* 单个坏文件不影响其余 */ }
    }
    return out;
}

const FROM = argOf('--from', '');
const cvgDir = FROM ? FROM : mkdtempSync(join(tmpdir(), 'ftt-cvg-'));
let run = { status: null };
const t0 = Date.now();
if (FROM) {
    console.log('[coverage] 复用已有覆盖率数据：' + FROM + '（不重跑单测）');
} else {
    console.log('[coverage] 运行单测并收集 V8 覆盖率…（NODE_V8_COVERAGE=' + cvgDir + '）');
    run = spawnSync(process.execPath, [join(ROOT, 'tests', 'unit', 'run.js')], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { NODE_V8_COVERAGE: cvgDir }),
        stdio: 'ignore',                       // 只关心覆盖率；单测自身的输出由 `npm test` 负责
    });
}
const entries = collectEntries(cvgDir);
const sum = summarize(entries, resolveUrl);
const ms = Date.now() - t0;

const scope = FILTER ? filterPrefix(sum.files, FILTER) : sum.files;
const scopeSum = {
    files: scope,
    totals: {
        lines: scope.reduce((n, f) => n + f.lines, 0),
        covered: scope.reduce((n, f) => n + f.covered, 0),
        pct: 0,
    },
};
scopeSum.totals.pct = scopeSum.totals.lines ? Math.round((scopeSum.totals.covered / scopeSum.totals.lines) * 1000) / 10 : 0;

console.log('[coverage] 单测退出码 ' + (run.status === null ? '（异常）' : run.status) + ' · 用时 ' + Math.round(ms / 1000) + 's · 覆盖率文件 ' + entries.length + ' 条');
console.log('[coverage] 口径：**行覆盖**（一行被任一 count>0 的区间命中即算覆盖）；空行与注释行**也算** → 百分比**保守偏低**；'
    + '非「分支 / 函数覆盖」。源码面 = ' + SOURCE_PREFIXES.join(' ') + ' index.js devtools.js。');
if (!QUIET) console.log('\n' + formatSummary(scopeSum) + '\n');
else console.log('[coverage] 合计 ' + scopeSum.totals.pct + '%（' + scopeSum.totals.covered + '/' + scopeSum.totals.lines + ' 行）'
    + (FILTER ? '（filter=' + FILTER + '）' : ''));

/** 分档小结（`core/` 是 `技-11` 指定的基线口径） */
try {
    const core = filterPrefix(sum.files, 'core/');
    const host = filterPrefix(sum.files, 'host/');
    const adapters = filterPrefix(sum.files, 'adapters/');
    const ui = filterPrefix(sum.files, 'ui/');
    const pct = (a) => { const l = a.reduce((n, f) => n + f.lines, 0), c = a.reduce((n, f) => n + f.covered, 0); return (l ? Math.round((c / l) * 1000) / 10 : 0) + '%（' + c + '/' + l + '）'; };
    console.log('[coverage] 分档：core/ ' + pct(core) + ' · host/ ' + pct(host) + ' · adapters/ ' + pct(adapters) + ' · ui/ ' + pct(ui));
} catch (e) { /* 分档失败不影响主输出 */ }

// 清理：**只删自己建的临时目录** —— `--from` 给的是调用方的数据，删掉它等于把别人的输入吃掉
//   （本轮实测踩过：`--from` 跑完把源目录删了，之后的复跑全部变成 0 条）。
if (FROM) console.log('[coverage] --from：原始数据是调用方给的，**不动**（' + cvgDir + '）');
else if (KEEP) console.log('[coverage] --keep：原始覆盖率数据保留在 ' + cvgDir);
else { try { rmSync(cvgDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }

process.exit(0);   // **先观测不阻断**：报告产出即成功，覆盖率数字不作为退出码依据
