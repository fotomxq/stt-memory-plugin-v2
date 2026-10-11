// ============================================================
// scripts/coverage-lib.js —— **覆盖率核算的纯函数库**（v3.45.0，`docs/D22` W5 `技-11`）
//
// 定位：把 Node 原生 V8 覆盖率（`NODE_V8_COVERAGE` 产出的 `coverage-*.json`）折算成
//   **逐文件行覆盖数**。**零依赖**（`docs/D21` Q5 裁决：不允许引入需要 `node_modules` 的工具）。
//
// 为什么自己算而不用 `c8` / `nyc`：见上 —— 本仓库的红线是「源码即发布物、无运行时依赖」；
//   开发期工具也不引依赖，是 `D21` Q5 采纳的默认。
//
// 拆出这个文件的原因（**可测性**）：真正的核算逻辑是纯函数，可以在单测里用**合成覆盖率数据**
//   与**真实源文件**验证；CLI（`scripts/coverage.js`）只负责「起进程 → 收集 → 打印 → 退出 0」。
//   否则一个「跑整套单测」的命令没法进单测门禁。
//
// 口径（写进文档，避免读者误读）：
//   · V8 的 `ranges` 是**字节区间**（相对该文件执行时的源码字节）→ 本库按**字节**折算到行，
//     因此对多字节字符（中文注释）也是对的；
//   · 一行只要被**任一** `count > 0` 的区间覆盖就算「覆盖」——这是**行覆盖**的常用口径
//     （与「分支覆盖 / 函数覆盖」不同，本库**不**声称后者）；
//   · 空行与纯注释行**也算行**（不做「可执行行」推断 —— 那需要真正的 AST 解析，
//     引依赖或自写解析器都不划算；故本库给出的百分比是**保守偏低**的，这一点在输出里明说）。
// ============================================================

/**
 * 解析一份 `coverage-*.json` 文本 → 覆盖率条目数组。
 *
 * **两种文件形态都要认**（实测）：老版本 Node 写的是**顶层数组**，新版写的是 `{ "result": [...] }`。
 * 只认其中一种会让报告**静默变成 0%** —— 本轮第一版就踩了这个坑（209 个覆盖率文件全在、报告却是 0 条）。
 * 解析失败 / 形态不认识 → 空数组（单个坏文件不影响其余）。
 * @param {string} text 文件内容
 * @returns {Array<{url:string, functions?:Array}>}
 */
export function entriesOfCoverageJson(text) {
    try {
        const data = JSON.parse(String(text == null ? '' : text));
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.result)) return data.result;
        return [];
    } catch (e) { return []; }
}

/**
 * 源码的**行起始字节偏移**（1-based 行号 → 起始字节）。
 * @param {Buffer|string} source 源码（建议传 Buffer：V8 偏移是字节）
 * @returns {number[]} `starts[i]` = 第 i+1 行的起始字节偏移
 */
export function lineStartsOf(source) {
    const buf = Buffer.isBuffer(source) ? source : Buffer.from(String(source == null ? '' : source), 'utf8');
    const starts = [0];
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) starts.push(i + 1);
    // 「以换行结尾」的文件不会有末尾空行
    if (starts.length > 1 && starts[starts.length - 1] >= buf.length) starts.pop();
    return starts;
}

/**
 * 字节偏移 → 1-based 行号（二分；偏移超出末尾 → 最后一行）。
 * @param {number[]} starts `lineStartsOf` 的结果
 * @param {number} offset 字节偏移
 */
export function lineAt(starts, offset) {
    let lo = 0, hi = starts.length - 1, ans = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= offset) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans + 1;
}

/**
 * 从 V8 的 `functions[].ranges[]` 折算**已覆盖行集合**。
 * 只认 `count > 0` 的区间；区间端点用**半开**语义（`startOffset` 含、`endOffset` 不含），
 * 但 V8 的 endOffset 常指向下一个 token 的开头，故终止行按 `endOffset - 1` 计（避免多算一行）。
 * @param {Buffer|string} source 源码
 * @param {Array<{startOffset:number,endOffset:number,count:number}>} ranges
 * @returns {Set<number>} 已覆盖的 1-based 行号
 */
export function coveredLinesOf(source, ranges) {
    const starts = lineStartsOf(source);
    const total = starts.length;
    const set = new Set();
    for (const r of (Array.isArray(ranges) ? ranges : [])) {
        if (!r || !(Number(r.count) > 0)) continue;
        const s = Math.max(0, Number(r.startOffset) || 0);
        const e = Math.max(s, (Number(r.endOffset) || 0) - 1);
        const from = lineAt(starts, s), to = Math.min(total, lineAt(starts, e));
        for (let ln = from; ln <= to; ln++) set.add(ln);
    }
    return set;
}

/**
 * 单文件汇总。
 * @param {string} file 仓库相对路径（POSIX 风格）
 * @param {Buffer|string} source 源码
 * @param {Array} ranges V8 区间（把所有 `functions[].ranges` 摊平后传入）
 * @returns {{file:string, lines:number, covered:number, pct:number}}
 */
export function fileSummary(file, source, ranges) {
    const starts = lineStartsOf(source);
    const covered = coveredLinesOf(source, ranges).size;
    const lines = starts.length;
    return { file: String(file), lines: lines, covered: covered, pct: lines ? Math.round((covered / lines) * 1000) / 10 : 0 };
}

/**
 * 把 `NODE_V8_COVERAGE` 产出的多个 coverage 对象折算成**每文件一行**的汇总。
 * @param {Array<{url:string, functions?:Array}>} entries V8 coverage 条目（可来自多个 `coverage-*.json`）
 * @param {(url:string)=>({file:string, source:Buffer|string}|null)} resolve 把 URL 映射到仓库文件（不属于本仓库 → null）
 * @returns {{files:Array, totals:{lines:number, covered:number, pct:number}}}
 */
export function summarize(entries, resolve) {
    const byFile = new Map();
    for (const e of (Array.isArray(entries) ? entries : [])) {
        const hit = (() => { try { return resolve(String((e && e.url) || '')); } catch (err) { return null; } })();
        if (!hit) continue;
        const ranges = [];
        for (const fn of ((e && e.functions) || [])) for (const r of ((fn && fn.ranges) || [])) ranges.push(r);
        const prev = byFile.get(hit.file);
        if (prev) prev.ranges.push(...ranges);
        else byFile.set(hit.file, { file: hit.file, source: hit.source, ranges: ranges });
    }
    const files = [];
    for (const v of Array.from(byFile.values())) files.push(fileSummary(v.file, v.source, v.ranges));
    files.sort((a, b) => (a.pct - b.pct) || a.file.localeCompare(b.file));
    const lines = files.reduce((n, f) => n + f.lines, 0);
    const covered = files.reduce((n, f) => n + f.covered, 0);
    return { files: files, totals: { lines: lines, covered: covered, pct: lines ? Math.round((covered / lines) * 1000) / 10 : 0 } };
}

/** 只保留某个前缀（如 `core/`）的文件 —— 基线口径按 `D21` §8 `技-11` 指向 `core/` */
export function filterPrefix(files, prefix) {
    const p = String(prefix == null ? '' : prefix);
    return (Array.isArray(files) ? files : []).filter((f) => f.file.indexOf(p) === 0);
}

/** 一行文本报告（CLI 与单测共用，保证「人看到的」与「测到的」是同一份口径） */
export function formatSummary(sum) {
    const out = [];
    for (const f of (sum.files || [])) out.push(String(f.pct).padStart(6) + '%  ' + String(f.covered).padStart(6) + '/' + String(f.lines).padEnd(6) + '  ' + f.file);
    const t = (sum && sum.totals) || { lines: 0, covered: 0, pct: 0 };
    out.push('合计 ' + t.pct + '%（' + t.covered + '/' + t.lines + ' 行）');
    return out.join('\n');
}
