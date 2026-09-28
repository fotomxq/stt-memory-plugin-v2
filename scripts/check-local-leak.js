#!/usr/bin/env node
// ============================================================
// scripts/check-local-leak.js —— 本地隐私泄漏门禁（v3.0.6）
//
// 为什么需要它：
//   `tests/local/` 引入了「本地调试」能力，而本地调试天然要接触本机路径
//   （用户主目录 / 主机名 / 应用数据目录）。本仓库是**公开仓库**，一旦把
//   `C:\Users\<某人>\...` 或主机名写进入库文件，就等于把开发者的机器信息发布出去。
//   本门禁把「不要泄漏本地隐私信息」从口头约定变成**可执行、会失败**的检查。
//
// 判据（三条，互为补充）：
//   A. user-profile-path —— **机器无关**的通用用户主目录路径：
//        `C:\Users\<name>` / `/home/<name>` / `/Users/<name>`
//      占位符形态（`<you>` / `%USERNAME%` / `$HOME` / `{user}` / `username` / `你` …）
//      一律**不算**命中 —— 文档里教人填路径属正常写法。
//   B. hostname —— 当前机器的主机名（长度 ≥ 5 才判，避免短名误伤）。
//   C. repo-abs-path —— **本次扫描的仓库根绝对路径**出现在文件里。
//      这条是自适应的：仓库检出在哪，就判哪条；因此换台机器也有效。
//      （加它的由来：v3.0.6 批次档曾把本机检出路径抄进文档，而 A/B 两条都拦不住。）
//
// 已公开的白名单（`ALLOW_SUBSTRINGS`）：
//   上游作者构建机的 Linux 路径自 v1 起就公开出现在 `开发守则.md` 与 `docs/`、
//   `tests/fixtures/gen-*.cjs` 中（oracle 生成器的绝对路径）。它们是**既有公开事实**，
//   不是本次泄漏；若不白名单，作者在自己的机器上跑本门禁会误报。
// 合成样本豁免（`ALLOW_SYNTHETIC`）：
//   单元测试里编造的假路径（如 `file:///home/u/proj/...`，用户名为单个 `u`）。
//   它们不指向任何真实机器，故**按行豁免**而不是放宽规则 —— 放宽「用户名段」判据
//   会同时漏掉真泄漏。
//
// 扫描范围：工作区文本文件，跳过 VCS / 依赖 / **本地调试实参与产物**
//   （`tests/local/local.config.json`、`tests/local/out/`）—— 后者按设计就含本机路径。
//
// 用法：
//   node scripts/check-local-leak.js
//   node scripts/check-local-leak.js --list   # 附带打印白名单与跳过范围
// ============================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 跳过目录 / 文件：VCS、依赖、本地调试实参与产物（按设计含本机路径） */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out']);
const SKIP_REL = new Set([
    'tests/local/local.config.json',
]);
/** 二进制/超大文件跳过阈值 */
const MAX_BYTES = 4 * 1024 * 1024;

/** 已公开的、允许出现的既有路径（见文件头说明） */
export const ALLOW_SUBSTRINGS = [
    '/home/ubuntu/st/ftt-memory-v2',
    '/home/ubuntu/st/STT记忆插件',
];

/**
 * **合成测试数据**里的假路径：整行豁免。
 * 与上一条白名单的区别：这些是明确编造的示例（不指向任何真实机器），
 * 只因规则要求「用户名段不像占位符」而命中 —— 收紧规则会漏掉真泄漏，故按行豁免。
 */
export const ALLOW_SYNTHETIC = [
    // tests/unit/trace.test.js 的 V8 裸帧样本（假用户名单字符 `u`，两种路径形）
    //   B7 `file:///home/u/proj/tests/a.js:12:5`
    //   B8 `file:///home/u/p/ui/panel.js?t=123:88:9`
    'file:///home/u/',
    // tests/unit/local-harness.test.js E1：本门禁自己的**解析用例**必须有像样的样本路径。
    // 故写成**精确整路径**（而不是只写主目录前缀），避免把别人的真实路径顺带豁免掉。
    '/home/bob/proj',
    '/Users/carol/proj',
];

/** 占位符形态：命中这些片段就当作「教人填路径」，不算泄漏 */
const PLACEHOLDER = /^(<.*>|\{.*\}|\$.*|%.*%|\*+|\.{2,}|user|users|username|your[_-]?name|name|you|你|用户名|用户|某某|xxx+)$/i;

/**
 * 通用用户主目录路径。
 *   Windows：`C:\Users\<name>`（也接受正反斜杠混用）
 *   POSIX  ：`/home/<name>`、`/Users/<name>`
 */
const RX_WIN_PROFILE = /[A-Za-z]:[\\/]Users[\\/]([^\\/\s"'`<>|]+)/g;
const RX_POSIX_PROFILE = /\/(?:home|Users)\/([^/\s"'`<>|]+)/g;

/** 抽一行里的所有用户主目录路径片段（含被命中的用户名段） */
export function findProfilePaths(text) {
    const hits = [];
    for (const rx of [RX_WIN_PROFILE, RX_POSIX_PROFILE]) {
        rx.lastIndex = 0;
        let m;
        while ((m = rx.exec(text)) !== null) hits.push({ full: m[0], name: m[1] });
    }
    return hits;
}

/** 是否在白名单内（按整行判断，白名单片段出现在行内即豁免该行） */
export function isAllowedLine(line) {
    return ALLOW_SUBSTRINGS.some((s) => line.includes(s))
        || ALLOW_SYNTHETIC.some((s) => line.includes(s));
}

/** 脱敏展示：只留首字符，其余打码，避免门禁自己把隐私再打印一遍 */
export function maskSecret(s) {
    const t = String(s == null ? '' : s);
    if (t.length <= 1) return '*';
    return t.slice(0, 1) + '*'.repeat(Math.max(1, Math.min(t.length - 1, 8)));
}

/** 单行是否命中某条规则 */
function lineMatches(line, rule, machineHost, repoRoot) {
    if (rule === 'hostname') return !!machineHost && line.includes(machineHost);
    if (rule === 'repo-abs-path') return !!repoRoot && containsPath(line, repoRoot);
    return findProfilePaths(line).some((p) => !PLACEHOLDER.test(p.name));
}

/** 大小写不敏感地判断一行是否含某个绝对路径（Windows 路径大小写常不一致） */
function containsPath(line, abs) {
    if (!abs || abs.length < 4) return false;
    return line.toLowerCase().includes(abs.toLowerCase());
}

/**
 * 纯函数：扫一段文本，返回命中列表（便于单测）。
 * @returns {Array<{rule:string, masked:string}>}
 */
export function scanText(text, { machineHost = '', repoRoot = '' } = {}) {
    const out = [];
    for (const line of String(text == null ? '' : text).split('\n')) {
        if (isAllowedLine(line)) continue;
        for (const h of findProfilePaths(line)) {
            if (PLACEHOLDER.test(h.name)) continue;      // `<you>` / `%USERNAME%` / `username` …
            out.push({ rule: 'user-profile-path', masked: maskSecret(h.name) });
        }
        if (machineHost && machineHost.length >= 5 && line.includes(machineHost)) {
            out.push({ rule: 'hostname', masked: maskSecret(machineHost) });
        }
        if (containsPath(line, repoRoot)) {
            out.push({ rule: 'repo-abs-path', masked: maskSecret(repoRoot) });
        }
    }
    return out;
}

/** 判定字节缓冲是否像文本（前 8KB 内出现 NUL 即视为二进制） */
export function looksBinary(buf) {
    const n = Math.min(buf.length, 8192);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
}

/** 递归收集待扫文件（相对路径以 POSIX 分隔符表示） */
function walk(root, dir = root, acc = []) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
    for (const e of entries) {
        const abs = join(dir, e.name);
        const rel = relative(root, abs).split('\\').join('/');
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            walk(root, abs, acc);
            continue;
        }
        if (SKIP_REL.has(rel)) continue;
        if (extname(e.name) === '.log') continue;
        acc.push({ abs, rel });
    }
    return acc;
}

/**
 * 扫描工作区（只返回结果，不打印、不退出）——单元测试可直接调用。
 * @returns {{scanned:number, skippedBinary:number, skippedBig:number, issues:Array}}
 */
export function scanRepo(root = ROOT, { machineHost = hostname() } = {}) {
    const issues = [];
    let scanned = 0, skippedBinary = 0, skippedBig = 0;
    for (const f of walk(root)) {
        let buf;
        try {
            if (statSync(f.abs).size > MAX_BYTES) { skippedBig++; continue; }
            buf = readFileSync(f.abs);
        } catch { continue; }
        if (looksBinary(buf)) { skippedBinary++; continue; }
        scanned++;
        const text = buf.toString('utf8');
        const hits = scanText(text, { machineHost, repoRoot: root });
        if (!hits.length) continue;
        const lines = text.split('\n');
        for (const h of hits) {
            // 定位行号（仅供人排查，不打印原文）
            const idx = lines.findIndex((l) => !isAllowedLine(l) && lineMatches(l, h.rule, machineHost, root));
            issues.push({ file: f.rel, line: idx >= 0 ? idx + 1 : 0, rule: h.rule, masked: h.masked });
        }
    }
    return { scanned, skippedBinary, skippedBig, issues };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
    const { scanned, skippedBinary, skippedBig, issues } = scanRepo();
    console.log('本地隐私门禁：扫描 ' + scanned + ' 个文本文件'
        + (skippedBinary ? '（跳过二进制 ' + skippedBinary + '）' : '')
        + (skippedBig ? '（跳过超大 ' + skippedBig + '）' : ''));
    if (process.argv.includes('--list')) {
        console.log('  白名单（已公开路径）：' + ALLOW_SUBSTRINGS.join(' · '));
        console.log('  合成样本豁免：' + ALLOW_SYNTHETIC.join(' · '));
        console.log('  跳过：' + [...SKIP_DIRS].join('/') + ' · ' + [...SKIP_REL].join(' · '));
    }
    if (issues.length) {
        for (const it of issues) console.log('  ❌ ' + it.file + ':' + it.line + ' [' + it.rule + '] ' + it.masked);
        console.log('本地隐私：' + issues.length + ' 处违规（入库文件不得含本机路径/主机名；本地实参请放 tests/local/local.config.json）');
        process.exit(1);
    }
    console.log('✅ 本地隐私门禁通过（0 命中）');
}
