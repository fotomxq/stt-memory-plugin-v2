// ============================================================
// tests/local/plot-segment-audit.mjs —— **只读**核对宿主原生存储里的真实「情节」数据与
//   「🧩 生成分段总结」实际会提交给 AI 的提示词体量。
//
// 用途（v3.49.3，用户报告「情节的自动分段统计存在设计缺陷，会提交巨量数据。其实需要统计的 30 个情节
//   不可能这么大的数据量，请链接本地调试并核对，解决该问题。」）：
//   本脚本把**真实存档**灌进内核（`setKernelState`），然后用**真实代码路径**
//   （`core/plot-segment.js#plotSegmentPlan` + `#buildPlotSegmentPrompt`，非复刻）算出：
//     · 可见/隐藏情节数、每条正文长度分布（含超长条目）
//     · 每批提示词的**实际字符数**（system + user）、批次总数、全流程合计字符数
//     · 提示词里各项占比（正文 / 标题 / 角色 / 地点 / 楼层）
//   从而回答「到底提交了多少」。
//
// 纪律：**只读**，不写任何宿主文件；**不打印情节正文**（只打印长度与统计）。
// 用法：node tests/local/plot-segment-audit.mjs    （换库：环境变量 `FTT_AUDIT_ROOT=<extension-store 目录>`）
// 路径纪律：**不写死用户目录**（`check-local-leak` 会拦）—— 默认用 `%APPDATA%` 拼出宿主数据目录。
// ============================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APPDATA = String(process.env.APPDATA || process.env.HOME || '.').replace(/\\/g, '/');
const ROOT = process.env.FTT_AUDIT_ROOT
    || join(APPDATA, 'com.tauritavern.client', 'data', '_tauritavern', 'extension-store');
const STORES = ['ftt2-files', 'ftt-files', 'fft_v2_store', 'ftt2-local'];

function walk(dir, out = [], depth = 0) {
    if (depth > 3) return out;
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out, depth + 1);
        else { try { const st = statSync(p); out.push({ p, size: st.size }); } catch { /* 忽略 */ } }
    }
    return out;
}

/** 从任意 JSON 里递归找指定数组字段（state 顶层或分片信封里都可能） */
function collectArrays(node, key, sink, path = '') {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node[key])) sink.push({ path, arr: node[key] });
    for (const k of Object.keys(node)) {
        if (k === key) continue;
        const v = node[k];
        if (v && typeof v === 'object') collectArrays(v, key, sink, path + '/' + k);
    }
}
/** 从任意 JSON 里递归收集标量配置键（第一个命中即可） */
function collectScalars(node, keys, sink) {
    if (!node || typeof node !== 'object') return;
    for (const k of keys) if (node[k] != null && typeof node[k] !== 'object' && sink[k] === undefined) sink[k] = node[k];
    for (const k of Object.keys(node)) { const v = node[k]; if (v && typeof v === 'object') collectScalars(v, keys, sink); }
}

// ---------- 1) 扫盘：找出最大的 atoms / plotSegments 数组 ----------
let best = { atoms: [], path: '', size: 0 };
const segsCand = [];
const cfgFound = {};
let scanned = 0, files = 0;
for (const store of STORES) {
    for (const f of walk(join(ROOT, store))) {
        if (f.size > 64 * 1024 * 1024) continue;
        let txt = '';
        try { txt = readFileSync(f.p, 'utf8'); } catch { continue; }
        scanned++; files++;
        let json = null;
        try { json = JSON.parse(txt); } catch { json = null; }
        const items = json ? [json] : txt.split('\n').map((l) => { const s = l.trim(); if (!s || s[0] !== '{') return null; try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
        for (const it of items) {
            const a = []; collectArrays(it, 'atoms', a);
            for (const x of a) if (x.arr.length > best.atoms.length) best = { atoms: x.arr, path: f.p + x.path, size: f.size };
            const s2 = []; collectArrays(it, 'plotSegments', s2);
            for (const x of s2) if (x.arr.length) segsCand.push(x.arr);
            collectScalars(it, ['plotSegmentBatchAtoms', 'plotSegmentIncremental', 'summaryChunkSize', 'atomMaxTotal'], cfgFound);
        }
    }
}
const segs = segsCand.sort((a, b) => b.length - a.length)[0] || [];

console.log('=== 只读核对：情节分段总结的实际提交体量 ===');
console.log('扫盘：' + files + ' 个文件（跳过超大），命中情节 ' + best.atoms.length + ' 条 · 分段总结 ' + segs.length + ' 段');
console.log('数据来源：' + best.path);
console.log('存档里的相关配置：' + JSON.stringify(cfgFound));

if (!best.atoms.length) { console.log('未找到情节数据 —— 请确认宿主数据目录（可用 FTT_AUDIT_ROOT 指定）。'); process.exit(0); }

// ---------- 2) 灌进内核，用**真实代码路径**算提示词 ----------
const runtime = await import('../../core/model/runtime.js');
const { defaultCfg } = await import('../../core/config.js');
const { emptyState } = await import('../../core/state.js');
const ps = await import('../../core/plot-segment.js');

const cfg0 = JSON.parse(JSON.stringify(defaultCfg));
for (const [k, v] of Object.entries(cfgFound)) if (cfg0[k] !== undefined) cfg0[k] = v;
const state0 = Object.assign(emptyState(), { atoms: best.atoms, plotSegments: segs });
runtime.setScopeKey('plot-audit');
runtime.setKernelState(state0);
Object.assign(runtime.cfg, cfg0);
runtime.setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

const plan = ps.plotSegmentPlan();
const size = ps.plotSegmentBatchSize();

// 2a) 每条情节的正文长度分布
const lens = best.atoms.map((a) => String(a.text || a.content || '').length).sort((x, y) => x - y);
const q = (p) => lens.length ? lens[Math.min(lens.length - 1, Math.floor(lens.length * p))] : 0;
const sum = lens.reduce((s, n) => s + n, 0);
console.log('\n--- 情节正文长度 ---');
console.log('条目 ' + lens.length + ' 条 · 合计 ' + sum + ' 字符 · 中位 ' + q(0.5) + ' · 90% ' + q(0.9) + ' · 最长 ' + (lens[lens.length - 1] || 0));
console.log('超长条目：>1KB ' + lens.filter((n) => n > 1024).length + ' 条 · >10KB ' + lens.filter((n) => n > 10240).length + ' 条');
const hidden = (state0.atoms || []).filter((a) => a && (a.hidden === true || a.validity === 'inactive')).length;
console.log('隐藏 / 失效：' + hidden + ' 条（不参与分段总结）');

// 2b) 真实提示词：逐批算字符数
console.log('\n--- 每批实际提示词（真实 buildPlotSegmentPrompt）---');
console.log('批大小 plotSegmentBatchAtoms = ' + size + ' · 批次 ' + plan.batches.length + ' 批 · 情节 ' + plan.total + ' 条');
let totalSys = 0, totalUser = 0, worst = null;
const rows = [];
for (const b of plan.batches) {
    const prompt = ps.buildPlotSegmentPrompt(b);
    if (!prompt) continue;
    const sys = String((prompt[0] || {}).content || '').length;
    const user = String((prompt[1] || {}).content || '').length;
    totalSys += sys; totalUser += user;
    const rec = { i: b.index, n: b.atoms.length, sys, user, total: sys + user };
    rows.push(rec);
    if (!worst || rec.total > worst.total) worst = rec;
}
for (const r of rows.slice(0, 6)) console.log('  第 ' + r.i + ' 批：' + r.n + ' 条 → system ' + r.sys + ' + user ' + r.user + ' = ' + r.total + ' 字符');
if (rows.length > 6) console.log('  …（共 ' + rows.length + ' 批，其余略）');
console.log('最重一批：第 ' + (worst ? worst.i : '-') + ' 批 = ' + (worst ? worst.total : 0) + ' 字符');
console.log('全部批次合计 = ' + (totalSys + totalUser) + ' 字符（system ' + totalSys + ' + user ' + totalUser + '）');

// 2c) 自动流程实际会提交多少：**新口径（一次一批）vs 旧口径（12 批/次）**
const NEW_BATCHES = Math.max(1, Math.min(40, Number(cfg0.plotSegmentMaxBatches) || 1));
const OLD_BATCHES = 12;
const pick = (n) => rows.slice(0, n);
const sumOf = (arr) => arr.reduce((s, r) => s + r.total, 0);
console.log('\n--- 「🧩 生成分段总结」一次点击 ---');
console.log('  旧口径（v3.49.2 及以前，默认最多 ' + OLD_BATCHES + ' 批）：' + pick(OLD_BATCHES).length + ' 次请求 · 合计 ' + sumOf(pick(OLD_BATCHES)) + ' 字符');
console.log('  新口径（v3.49.3，默认最多 ' + NEW_BATCHES + ' 批）：' + pick(NEW_BATCHES).length + ' 次请求 · 合计 ' + sumOf(pick(NEW_BATCHES)) + ' 字符');
console.log('  字符预算：每批 ≤ ' + (ps.plotSegmentMaxChars() || '不限') + ' 字符 · 条数上限 ' + ps.plotSegmentBatchSize() + ' 条');
console.log('  增量模式默认开（' + (cfg0.plotSegmentIncremental === true) + '）：已被现有段落覆盖的批次不再重复提交');
console.log('  全部 ' + rows.length + ' 批若要跑完：合计 ' + sumOf(rows) + ' 字符（新口径下需点 ' + rows.length + ' 次，每次一批，可随时停）');

// 2d) 单条情节在提示词里的实际形态（长度分解，不打印正文）
const demo = (plan.batches[0] && plan.batches[0].atoms[0]) || best.atoms[0] || {};
const d = (() => {
    const line = ps.plotSegmentLineText(demo);
    return { line: String(line).length, rawBody: String(demo.text || demo.content || '').length, cost: ps.plotSegmentLineCost(demo) };
})();
console.log('\n--- 单条情节进提示词后的长度（示例第一条）---');
console.log('原始正文 ' + d.rawBody + ' → 行文本 ' + d.line + ' 字符（正文上限 300）· 计入切批预算 ' + d.cost + ' 字符');

// 2e) 结论对比
console.log('\n--- 对照 ---');
console.log('存档里可见情节正文总量 ' + sum + ' 字符（' + plan.total + ' 条 / ' + rows.length + ' 批）');
console.log('一次点击提交：旧 ' + sumOf(pick(OLD_BATCHES)) + ' 字符 → 新 ' + sumOf(pick(NEW_BATCHES)) + ' 字符（' +
    (sumOf(pick(NEW_BATCHES)) ? ('降低到 ' + Math.round(sumOf(pick(NEW_BATCHES)) / sumOf(pick(OLD_BATCHES)) * 100) + '%') : '-') + '）');

