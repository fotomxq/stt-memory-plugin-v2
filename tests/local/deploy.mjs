#!/usr/bin/env node
// ============================================================
// tests/local/deploy.mjs —— 本地部署「一条命令」入口（`开发守则.md` §6.4）
//
// 为什么有它：§6.4 的部署顺序是「门禁 → 提交 → 推送 → 同步宿主副本 → 核对」，
//   真机上每轮都要人工重复这几步，还要临场判断「宿主装了没 / 目标是不是本插件 /
//   副本能不能快进 / 多出来的差异是不是行尾假象」。本脚本把这些判断**固化成一条命令**：
//   条件识别 →（可选）产物门禁 → 执行快进 → 核对与差异分类，一次跑完。
//
// 用法：
//   npm run local:deploy                      # 自动探测宿主；条件不足 → 报错退出（不写任何东西）
//   npm run local:deploy -- --to <路径>        # 显式指定目标（本插件目录，或其父级「扩展目录」）
//   npm run local:deploy -- --dry-run          # 只做条件识别与部署计划，不写
//   npm run local:deploy -- --no-gate          # 跳过产物门禁
//   npm run local:deploy -- --isolate-gate     # 工作区脏时，导出「已提交产物」到临时目录后跑门禁
//   npm run local:deploy -- --show-paths       # 打全路径（默认脱敏）
//
// 退出码：0 = 成功（含「两侧已一致」）· 1 = 部署/核对失败 · 2 = 部署条件不足（报错即可，不猜不做）
//
// 边界（硬性，与 `开发守则.md` §6.2 同口径）：
//   · 只写宿主扩展目录下**本插件自己**的子目录；宿主配置与插件用户数据一律不碰；
//   · **永不** `reset --hard` / `clean` / `checkout -f` / `push`；快进只 `fetch` + `merge --ff-only`；
//   · 部署副本脏 / 异源 / 「干净与否查不出来」→ **拒绝**，绝不覆盖；
//   · 入库文件不得含本机路径（`scripts/check-local-leak.js` 强制）：本文件路径一律运行时解析 + 输出脱敏。
// ============================================================
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, cpSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
    nodeFs, discoverHost, maskPath, sha256, readManifest, readGitHead, readGitRemote,
    planHostSync, inventory, diffInventory, PLUGIN_FOLDER,
} from './host.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = resolve(HERE, '..', '..');
const CONFIG_FILE = join(HERE, 'local.config.json');
const GATE_CMD = 'npm run gate';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, dflt) => {
    const i = argv.indexOf(f);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const SHOW_PATHS = has('--show-paths');
const DRY_RUN = has('--dry-run');
const NO_GATE = has('--no-gate');
const ISOLATE_GATE = has('--isolate-gate');
const TO = valOf('--to', '');

if (has('--help') || has('-h')) {
    console.log([
        '用法：node tests/local/deploy.mjs [--to <路径>] [--dry-run] [--no-gate] [--isolate-gate] [--show-paths]',
        '',
        '  默认：自动探测宿主扩展目录 → 逐项识别部署条件 → 跑产物门禁 → git 快进 → 核对差异。',
        '  --to <路径>      显式指定目标（本插件目录，或含本插件子目录的「扩展目录」）',
        '  --dry-run        只识别条件与出计划，不写任何东西',
        '  --no-gate        跳过产物门禁（默认：工作区干净时跑全量门禁）',
        '  --isolate-gate   工作区有未提交改动时，把「已提交产物」导出到临时目录后跑门禁',
        '  --show-paths     打全路径（默认脱敏为 %APPDATA% / ~）',
        '',
        '  退出码：0 成功 · 1 部署/核对失败 · 2 部署条件不足。',
    ].join('\n'));
    process.exit(0);
}

const fsx = nodeFs();
const env = process.env;
const home = homedir();
const show = (p) => (SHOW_PATHS ? String(p || '') : maskPath(p, { env, home }));

/** 载入不入库的本地实参（可缺省）；`--to` 优先于它 */
function loadConfig() {
    if (!fsx.isFile(CONFIG_FILE)) return {};
    try { return JSON.parse(fsx.readText(CONFIG_FILE)); } catch { return {}; }
}

/** 目标目录按「本插件目录」或「扩展目录」两种写法都认 */
function resolveTarget(dir) {
    if (!dir) return '';
    const t = resolve(dir);
    if (fsx.isFile(join(t, 'manifest.json'))) return t;
    if (fsx.isFile(join(t, PLUGIN_FOLDER, 'manifest.json'))) return join(t, PLUGIN_FOLDER);
    return '';
}

/** 远端地址规范化：`https://host/a/b(.git)` 与 `git@host:a/b(.git)` 视为同一仓库 */
function remoteSlug(url) {
    let s = String(url || '').trim();
    if (!s) return '';
    s = s.replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/[^/]*\//, 'https://');
    return s.replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
}

// ------------------------------------------------------------
// git 只读助手（`-c safe.directory=<该目录>`：不改任何全局配置；路径归一为 `/`）
// ------------------------------------------------------------
const safePath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
function gitTry(dir, args, opts = {}) {
    try {
        const out = execFileSync('git', ['-c', 'safe.directory=' + safePath(dir), '-C', dir].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        // `raw`：**绝不整体 trim** —— porcelain 的 ` M path` 首行有前导空格，trim 会把状态位吃掉（曾把 adapters/ 显示成 dapters/）
        return { ok: true, out: opts.raw ? out : out.trim() };
    } catch (e) {
        return { ok: false, out: String((e && (e.stderr || e.message)) || e).trim().slice(0, 400) };
    }
}
const gitHeadSha = (dir) => String((readGitHead(fsx, dir) || {}).sha || '');

/** 工作区改动清单（`--untracked-files=all`；`core.quotepath=false` 让中文名不被转义/加引号） */
function worktreeRows(dir) {
    const r = gitTry(dir, ['-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'], { raw: true });
    if (!r.ok) return { ok: false, err: r.out, rows: [] };
    return { ok: true, rows: r.out.split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean) };
}
const rowPath = (row) => {
    const p = row.slice(3);
    return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
};
const isUntracked = (row) => row.startsWith('??');
const isRename = (row) => row.includes(' -> ');

const fail = (code, title, lines) => {
    console.log('\n❌ ' + title);
    for (const l of lines || []) console.log('   ' + l);
    process.exit(code);
};

// ============================================================
// 产物门禁：工作区干净 → 就地跑；脏 → 如实跳过（门禁测的是工作区，不是要部署的提交），
// 或按 `--isolate-gate` 把「已提交产物」导出到临时目录后跑（只读 git + 临时目录，不碰开发仓库）
// ============================================================
function runGate(cwd, logPath) {
    const fd = openSync(logPath, 'w');
    const r = spawnSync(GATE_CMD, { shell: true, cwd, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    let tail = '';
    try { tail = readFileSync(logPath, 'utf8').split('\n').slice(-10).join('\n'); } catch { /* 忽略 */ }
    return { ok: r.status === 0, tail };
}

/** 复制开发仓库（含 `.git`：行号棘轮判据依赖 git 上下文）并把工作区回填成 HEAD 的内容 */
function exportCommittedToTmp() {
    const tmp = join(tmpdir(), 'ftt-deploy-gate-' + process.pid);
    rmSync(tmp, { recursive: true, force: true });
    cpSync(DEV_ROOT, tmp, {
        recursive: true,
        filter: (src) => {
            const rel = src.slice(DEV_ROOT.length + 1).replace(/\\/g, '/');
            if (!rel) return true;
            if (rel === 'node_modules' || rel.startsWith('node_modules/')) return false;
            if (rel === 'tests/local/out' || rel.startsWith('tests/local/out/')) return false;
            return true;
        },
    });
    const st = worktreeRows(DEV_ROOT);
    if (!st.ok) { rmSync(tmp, { recursive: true, force: true }); return { error: 'git status 失败：' + st.err }; }
    for (const row of st.rows) {
        if (isRename(row)) continue;                        // 重命名极少见：跳过（不回填、不猜）
        const p = rowPath(row);
        const dst = join(tmp, p);
        if (isUntracked(row)) { try { rmSync(dst, { recursive: true, force: true }); } catch { /* 忽略 */ } continue; }
        // 已跟踪：一律回填 HEAD 的内容（含被改 / 被删 / 已暂存）
        try {
            const buf = execFileSync('git', ['-c', 'safe.directory=' + safePath(DEV_ROOT), '-C', DEV_ROOT, 'show', 'HEAD:' + p.replace(/\\/g, '/')], { stdio: ['ignore', 'pipe', 'pipe'] });
            mkdirSync(dirname(dst), { recursive: true });
            writeFileSync(dst, buf);
        } catch { try { rmSync(dst, { recursive: true, force: true }); } catch { /* 忽略 */ } }
    }
    return { tmp };
}

// ============================================================
// ① 条件识别（不满足 → 退出码 2，什么都不写）
// ============================================================
console.log('===== 本地部署（开发守则 §6.4 · 一条命令）=====');

const config = loadConfig();
const host = discoverHost({ config, fsx, home });
const devRoot = host.dev.root || DEV_ROOT;
const devManifest = readManifest(fsx, devRoot);
const devHead = readGitHead(fsx, devRoot);
const devRemote = readGitRemote(fsx, devRoot);

const cond = [];
const addCond = (name, ok, info) => cond.push({ name, ok, info });

function reportAndBail() {
    console.log('');
    for (const c of cond) console.log('  ' + (c.ok ? '✅' : '❌') + ' ' + c.name + '：' + c.info);
    fail(2, '部署条件不足 —— 已中止，未写任何东西', cond.filter((c) => !c.ok).map((c) => '不满足：' + c.name + '（' + c.info + '）'));
}

addCond('开发仓库是 git 检出', !!devHead,
    devHead ? ('v' + String((devManifest && devManifest.version) || '?') + ' · ' + String(devHead.sha).slice(0, 8)) : '未读到 .git/HEAD');

// 目标：`--to` 优先；否则宿主自动探测
let deployedDir = '';
if (TO) {
    deployedDir = resolveTarget(TO);
    if (!deployedDir) addCond('目标路径是本插件目录', false, show(TO) + '（既无 manifest.json，也无 ' + PLUGIN_FOLDER + '/manifest.json）');
    else addCond('目标路径是本插件目录', true, show(deployedDir) + '（--to 显式指定）');
} else {
    deployedDir = (host.plugin && host.plugin.root) || '';
    addCond('发现宿主扩展目录', !!deployedDir, deployedDir ? show(deployedDir) : '未发现宿主（可用 --to 显式指定目标）');
}
if (!cond.every((c) => c.ok)) reportAndBail();

const exManifest = readManifest(fsx, deployedDir);
addCond('目标含本插件 manifest.json', !!exManifest,
    exManifest ? ('v' + String(exManifest.version || '?') + ' · ' + String(exManifest.display_name || '')) : '缺少或无法解析 manifest.json');

const isRepo = !!readGitHead(fsx, deployedDir);
const exRemote = readGitRemote(fsx, deployedDir);
const sameRemote = isRepo ? (devRemote && exRemote ? (remoteSlug(devRemote) === remoteSlug(exRemote)) : null) : null;
addCond('部署副本是 git 检出且同源', isRepo && sameRemote !== false,
    isRepo
        ? (sameRemote === null ? '同源未知（两侧 origin 读取不全）' : (sameRemote ? '同源' : '**异源**（' + remoteSlug(devRemote) + ' ≠ ' + remoteSlug(exRemote) + '）'))
        : '非 git 检出 → 走文件级替换（npm run local -- --deploy --yes，需先退出宿主）');
if (!cond.every((c) => c.ok)) reportAndBail();

// ============================================================
// ② 产物门禁
//
// 就地跑门禁存在 **TOCTOU 竞态**：检查「工作区干净」与门禁跑完之间有 ~1–2 分钟窗口，
//   期间别的进程若改了工作区，门禁就会对**一个从未存在过的中间态**报红（真机上已踩到：
//   `core/recall.js` 在门禁运行中被改，6 个用例假红）。故：
//   · 就地跑的门禁**失败时**，重新取一次改动清单；与开跑前不同 → 就地结果不可信 →
//     **自动改走隔离验证**（在 HEAD 的纯净导出上重跑），而不是把假红当成「产物有问题」。
// ============================================================
const devStatus = worktreeRows(devRoot);
let gate = { state: 'skipped', note: '--no-gate' };

/** 在「HEAD 的纯净导出」上跑门禁（只读 git + 临时目录，跑完即删） */
function gateIsolated() {
    console.log('  → 导出「已提交产物」到临时目录后跑 ' + GATE_CMD + ' …');
    const ex = exportCommittedToTmp();
    if (ex.error) return { state: 'unknown', note: ex.error };
    const g = runGate(ex.tmp, join(ex.tmp, 'gate.log'));
    rmSync(ex.tmp, { recursive: true, force: true });
    return g.ok
        ? { state: 'passed', note: '隔离验证（HEAD ' + String(devHead.sha).slice(0, 8) + ' 的纯净导出）' }
        : { state: 'failed', note: '隔离验证失败', tail: g.tail };
}

if (!NO_GATE) {
    if (!devStatus.ok) {
        gate = { state: 'unknown', note: 'git status 失败：' + devStatus.err };
    } else if (devStatus.rows.length === 0) {
        const before = devStatus.rows.join('\n');
        console.log('\n[产物门禁] 工作区干净 → 就地跑 ' + GATE_CMD + ' …');
        const g = runGate(devRoot, join(tmpdir(), 'ftt-deploy-gate.log'));
        if (g.ok) gate = { state: 'passed', note: '就地（工作区干净）' };
        else {
            const afterRows = worktreeRows(devRoot);
            const after = afterRows.ok ? afterRows.rows.join('\n') : '(读取失败)';
            if (after !== before) {
                console.log('\n[产物门禁] ⚠️ 门禁运行期间工作区发生了变化（并发写入）→ 就地结果不可信，自动改走隔离验证 …');
                gate = gateIsolated();
            } else {
                gate = { state: 'failed', note: '就地失败', tail: g.tail };
            }
        }
    } else if (ISOLATE_GATE) {
        console.log('\n[产物门禁] 工作区有 ' + devStatus.rows.length + ' 处未提交改动 →');
        gate = gateIsolated();
    } else {
        gate = { state: 'skipped', note: '工作区有 ' + devStatus.rows.length + ' 处未提交改动 —— 门禁测的是工作区、不是要部署的提交；如需校验提交产物请加 --isolate-gate' };
    }
}

// ============================================================
// ③ 部署计划（复用 host.js 的纯函数判定：脏 / 异源 / 查不出 → 一律拒绝）
// ============================================================
let dirtyCount;
let dirtyNote = '';
let adoptList = [];
if (isRepo) {
    const st = worktreeRows(deployedDir);
    if (!st.ok) dirtyCount = null;
    else {
        const untracked = st.rows.filter(isUntracked).map(rowPath);
        const tracked = st.rows.filter((r) => !isUntracked(r));
        if (tracked.length) dirtyCount = tracked.length;
        else if (!untracked.length) dirtyCount = 0;
        else if (!has('--adopt-untracked')) { dirtyCount = untracked.length; dirtyNote = '（均为未跟踪文件；确认是仓库文件可加 --adopt-untracked 采纳）'; }
        else {
            const fileSha = (root, f) => (fsx.isFile(join(root, f)) ? sha256(fsx.readBytes(join(root, f))) : '');
            const differ = untracked.filter((f) => { const a = fileSha(deployedDir, f); const b = fileSha(devRoot, f); return !a || !b || a !== b; });
            if (differ.length) { dirtyCount = differ.length; dirtyNote = '（未跟踪文件与仓库同名文件内容**不同** → 视为用户文件，拒绝）'; }
            else { adoptList = untracked; dirtyCount = 0; dirtyNote = '（' + untracked.length + ' 个未跟踪文件与仓库逐字节相同 → 采纳）'; }
        }
    }
}

const plan = planHostSync(Object.assign({
    deployedDir,
    isRepo,
    devSha: devHead && devHead.sha,
    deployedSha: gitHeadSha(deployedDir),
    sameRemote,
    gitAvailable: isRepo ? gitTry(deployedDir, ['--version']).ok : true,
}, isRepo ? { dirtyCount } : {}));

// ============================================================
// ④ 条件与计划统一输出
// ============================================================
console.log('');
for (const c of cond) console.log('  ' + (c.ok ? '✅' : '❌') + ' ' + c.name + '：' + c.info);
console.log('  ' + (gate.state === 'failed' ? '❌' : gate.state === 'passed' ? '✅' : 'ℹ️') + ' 产物门禁：' + gate.state + '（' + gate.note + '）');
if (devStatus.ok && devStatus.rows.length) {
    console.log('  ℹ️ 开发仓库在途改动 ' + devStatus.rows.length + ' 项：' + devStatus.rows.slice(0, 12).map((r) => r.slice(0, 2) + ' ' + rowPath(r)).join(' · ') + (devStatus.rows.length > 12 ? ' …' : ''));
}
console.log('  开发仓库：v' + String((devManifest && devManifest.version) || '?') + ' · ' + String((devHead && devHead.sha) || '(无)').slice(0, 8) + ' · ' + show(devRoot));
console.log('  部署副本：v' + String((exManifest && exManifest.version) || '?') + ' · ' + String(gitHeadSha(deployedDir) || '(非 git 检出)').slice(0, 8) + ' · ' + show(deployedDir)
    + (dirtyCount === undefined ? '' : '（' + (dirtyCount === null ? '干净与否查不出' : dirtyCount === 0 ? '干净' : dirtyCount + ' 处改动') + dirtyNote + '）'));
console.log('  判定    ：' + plan.action + '（' + plan.reason + '）—— ' + plan.note);

if (gate.state === 'failed') {
    console.log('\n--- 门禁输出（末段）---\n' + (gate.tail || ''));
    fail(1, '产物门禁未通过 → 不部署（确认要跳过请加 --no-gate）', []);
}
if (gate.state === 'unknown') fail(2, '无法确认部署条件（' + gate.note + '）→ 中止，宁可不做', []);

if (DRY_RUN) {
    console.log('\n  --dry-run：只识别条件与出计划，未写任何东西。');
    verifyDrift();
    process.exit(0);
}
if (plan.action === 'none') {
    console.log('\n  ✅ ' + plan.note);
    verifyDrift();
    process.exit(0);
}
if (plan.action !== 'ff') {
    console.log('\n--- 门禁输出（末段）---');
    fail(1, '未执行部署：' + plan.note, ['可行替代：npm run local -- --deploy --yes（文件级替换，先完全退出宿主）']);
}

// ============================================================
// ⑤ 执行快进（只 fetch + merge --ff-only；永不 force）
// ============================================================
const branch = String((devHead && devHead.ref) || '').replace(/^refs\/heads\//, '') || 'main';
if (adoptList.length) {
    console.log('\n  采纳残留（与仓库逐字节相同，快进后会原样恢复）：');
    for (const fPath of adoptList) { try { rmSync(join(deployedDir, fPath), { force: true }); console.log('    · 已移除 ' + fPath); } catch { /* 忽略 */ } }
}
console.log('\n  同步中：git fetch <开发仓库> ' + branch + ' → merge --ff-only');
const fetched = gitTry(deployedDir, ['fetch', devRoot, branch]);
if (!fetched.ok) fail(1, 'fetch 失败（未做任何改动）', [fetched.out]);
const merged = gitTry(deployedDir, ['merge', '--ff-only', 'FETCH_HEAD']);
if (!merged.ok) fail(1, '快进失败（非快进/冲突一律不处理，绝不 force）', [merged.out]);

const afterHead = gitHeadSha(deployedDir);
const afterManifest = readManifest(fsx, deployedDir);
const shaOk = !!afterHead && afterHead === String((devHead && devHead.sha) || '');
const verOk = String((afterManifest && afterManifest.version) || '') === String((devManifest && devManifest.version) || '');
console.log('  结果    ：部署副本 v' + String((afterManifest && afterManifest.version) || '?') + ' · ' + String(afterHead).slice(0, 8));
console.log('  核对    ：' + (shaOk && verOk ? '✅ 版本与提交均与开发仓库一致' : '❌ 不一致（请人工核对）'));
console.log('  生效提醒：插件在页面加载时装配 —— 需要**刷新页面**才生效（刷新后只读调试桥按设计回到关闭）。');
verifyDrift();
process.exit(shaOk && verOk ? 0 : 1);

// ============================================================
// ⑥ 差异分类核对：把「行尾假象」与「真实内容差异」分开（省掉每轮人工判一遍）
// ============================================================
function verifyDrift() {
    if (!deployedDir) return;
    let devInv;
    let depInv;
    try { devInv = inventory(fsx, devRoot); depInv = inventory(fsx, deployedDir); } catch { return; }
    const d = diffInventory(devInv, depInv);
    const norm = (x) => { let s = x.toString('utf8'); if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); return s.replace(/\r\n/g, '\n'); };
    const eolOnly = [];
    const real = [];
    for (const rel of d.changed) {
        try {
            (norm(fsx.readBytes(join(devRoot, rel))) === norm(fsx.readBytes(join(deployedDir, rel))) ? eolOnly : real).push(rel);
        } catch { real.push(rel); }
    }
    // 分类用的改动清单**当场重取**：门禁/部署可能耗时数十秒，期间别的进程仍可能在改这个仓库
    //（用脚本开头那份快照会把「刚被改动」的文件误报成「需人工核对」）。
    const rows = worktreeRows(devRoot).rows;
    const inFlight = new Set(rows.filter((r) => !isUntracked(r)).map(rowPath));
    const untrackedSet = new Set(rows.filter(isUntracked).map(rowPath));
    console.log('\n--- 差异分类核对（开发工作区 ↔ 部署副本）---');
    console.log('  仅开发有 ' + d.added.length + ' · 仅部署有 ' + d.removed.length + ' · 内容不同 ' + d.changed.length + '（其中仅行尾 ' + eolOnly.length + ' · 真实差异 ' + real.length + '）');
    if (d.added.length) console.log('  仅开发有：' + d.added.slice(0, 10).join(' · ') + (d.added.length > 10 ? ' …' : '') + '（未提交文件不随部署走，属正常）');
    if (d.removed.length) console.log('  ⚠️ 仅部署有：' + d.removed.slice(0, 10).join(' · ') + '（宿主侧多出的文件；--deploy 只写不删，属预期）');
    if (eolOnly.length) console.log('  ℹ️ 仅行尾不同（去 BOM/行尾后逐字节相同，非漏部署）：' + eolOnly.slice(0, 10).join(' · ') + (eolOnly.length > 10 ? ' …' : ''));
    if (real.length) {
        console.log('  ⚠️ 真实内容不同 ' + real.length + ' 项：');
        for (const rel of real.slice(0, 12)) {
            const why = inFlight.has(rel) ? '开发仓库**未提交**改动（部署副本持有的是已提交版本）'
                : untrackedSet.has(rel) ? '开发仓库**未跟踪**文件'
                    : '两侧内容不同，需人工核对';
            console.log('     · ' + rel + ' —— ' + why);
        }
    }
}
