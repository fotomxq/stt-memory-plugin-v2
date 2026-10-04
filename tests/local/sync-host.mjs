#!/usr/bin/env node
// ============================================================
// tests/local/sync-host.mjs —— **部署时把宿主下的插件替换到最新版**
//
// 用户新约定（原话，2026-10-04；落点见 `开发守则.md` §6.4）：
//   「如果在本地运行，且启动了调试端口，则在部署时除了 git 提交外，额外替换 TauriTavern 下的插件到最新版。」
//
// 用法：
//   npm run local:sync                 # 只读检查：条件是否满足 / 两侧版本与提交是否一致（不写任何东西、不调 git 写操作）
//   npm run local:sync -- --yes        # 执行：把宿主扩展目录下的本插件快进到开发仓库当前提交
//   npm run local:sync -- --show-paths # 打全路径（默认脱敏）
//   npm run local:sync -- --port 9222 --bridge-port 8791   # 覆盖调试端口
//
// 边界（硬性，与 `开发守则.md` §6.2 同口径）：
//   · 只动宿主扩展目录下**本插件自己**的子目录；插件用户数据（`extension-store/**`）与宿主配置一律不碰；
//   · **永不** `reset --hard` / `clean` / `checkout -f` / `push`；只 `fetch` + `merge --ff-only`；
//   · 部署副本有本地改动、或与开发仓库不同源 → **拒绝并报告**，绝不覆盖；
//   · 入库文件不得含本机路径（`scripts/check-local-leak.js` 强制）：路径一律走 `maskPath` 脱敏。
// ============================================================
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import net from 'node:net';
import {
    nodeFs, discoverHost, maskPath, readManifest, readGitHead, readGitRemote, planHostSync, sha256,
} from './host.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = resolve(HERE, '..', '..');
const CONFIG_FILE = join(HERE, 'local.config.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f, dflt) => {
    const i = argv.indexOf(f);
    if (i < 0 || i + 1 >= argv.length) return dflt;
    const v = Number(argv[i + 1]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
};
const SHOW_PATHS = has('--show-paths');
const CONFIRMED = has('--yes');

if (has('--help') || has('-h')) {
    console.log('用法：node tests/local/sync-host.mjs [--yes] [--show-paths] [--port <CDP 端口>] [--bridge-port <只读调试桥端口>] [--bridge-wait <短听毫秒>]');
    console.log('  不带 --yes = 只读检查（不写、不调 git 写操作）；带 --yes = 把宿主副本快进到开发仓库当前提交。');
    console.log('  「干净与否查不出来」时一律拒绝（不会覆盖）；脏副本 / 异源同样拒绝。');
    process.exit(0);
}

const fsx = nodeFs();
const env = process.env;
const home = homedir();
const show = (p) => (SHOW_PATHS ? String(p || '') : maskPath(p, { env, home }));

/** 载入不入库的本地实参（可缺省） */
function loadConfig() {
    if (!fsx.isFile(CONFIG_FILE)) return { config: {}, present: false };
    try { return { config: JSON.parse(fsx.readText(CONFIG_FILE)), present: true }; } catch (e) {
        return { config: {}, present: true, error: String((e && e.message) || e) };
    }
}

/** 规范化远端地址（`https://host/a/b(.git)` 与 `git@host:a/b(.git)` 视为同一个仓库） */
function remoteSlug(url) {
    let s = String(url || '').trim();
    if (!s) return '';
    s = s.replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/[^/]*\//, 'https://');
    s = s.replace(/\.git$/, '').replace(/\/+$/, '');
    return s.toLowerCase();
}

/** 调试端口探测：CDP（HTTP）与只读调试桥（TCP）各探一次，任一可用即算「调试端口已启动」 */
async function probePorts(cdpPort, bridgePort, bridgeWaitMs) {
    const out = { cdp: false, bridge: false, cdpPort: cdpPort, bridgePort: bridgePort };
    try {
        const r = await fetch('http://127.0.0.1:' + cdpPort + '/json/version', { signal: AbortSignal.timeout(1500) });
        out.cdp = !!(r && r.ok);
    } catch (e) { out.cdp = false; }
    out.bridge = await probeBridge(bridgePort, bridgeWaitMs);
    return out;
}

/**
 * 只读调试桥是否在线。桥是**反向**的（页面无法监听端口 → 由插件主动连出），故分两步：
 *   ① 先试 `connect`：**已经有人监听**该端口（例如另一个 `local:bridge` 实例）即算在线；
 *   ② 连不上时**短听一次**（默认 2s）：插件开着「🔌 调试桥」时会连过来，收到连接即算在线 ——
 *      这是判定「用户已启动调试端口」的可靠信号（插件侧开关无法从外部直接读）。
 * 不写任何东西；探测结束后立即关闭监听。
 */
function probeBridge(port, waitMs) {
    return new Promise((res) => {
        let settled = false;
        const fin = (v, server) => {
            if (settled) return;
            settled = true;
            try { if (server) server.close(); } catch (e) { /* 忽略 */ }
            res(v);
        };
        const probe = net.connect({ host: '127.0.0.1', port: port });
        probe.setTimeout(600);
        probe.on('connect', () => { try { probe.destroy(); } catch (e) { /* 忽略 */ } fin(true, null); });
        probe.on('timeout', () => { try { probe.destroy(); } catch (e) { /* 忽略 */ } listen(); });
        probe.on('error', () => { try { probe.destroy(); } catch (e) { /* 忽略 */ } listen(); });

        function listen() {
            if (settled) return;
            let server;
            try {
                server = net.createServer((sock) => { try { sock.destroy(); } catch (e) { /* 忽略 */ } fin(true, server); });
                server.on('error', (e) => fin(String((e && e.code) || '') === 'EADDRINUSE', server));
                server.listen(port, '127.0.0.1', () => { setTimeout(() => fin(false, server), waitMs); });
            } catch (e) { fin(false, server); }
        }
    });
}

/** 在部署副本里跑一次只读 git（`-c safe.directory=<该目录>`：不改任何全局配置）
 *  v3.10.2：路径**归一为 `/`** —— git 的 `safe.directory` 不认反斜杠写法，
 *    否则会以 `dubious ownership` 拒绝（真机首跑即踩到；宿主仓库属主与当前进程用户不一致）。 */
function safePath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}
function gitIn(dir, args) {
    return execFileSync('git', ['-c', 'safe.directory=' + safePath(dir)].concat(args), {
        cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}
function gitTry(dir, args) {
    try { return { ok: true, out: gitIn(dir, args) }; } catch (e) {
        return { ok: false, out: String((e && (e.stderr || e.message)) || e).trim().slice(0, 300) };
    }
}

const { config } = loadConfig();
const host = discoverHost({ config, fsx, home });
const devRoot = host.dev.root || DEV_ROOT;
const deployedDir = (host.plugin && host.plugin.root) || '';
const devManifest = readManifest(fsx, devRoot);
const devHead = readGitHead(fsx, devRoot);
const devRemote = readGitRemote(fsx, devRoot);
const extManifest = readManifest(fsx, deployedDir);
const extHead = readGitHead(fsx, deployedDir);
const extRemote = readGitRemote(fsx, deployedDir);
const isRepo = !!extHead;
const sameRemote = isRepo ? (remoteSlug(devRemote) !== '' && remoteSlug(devRemote) === remoteSlug(extRemote)) : null;

const cdpPort = argOf('--port', Number(config.debugPort) || 9222);
const bridgePort = argOf('--bridge-port', 8791);
// v3.10.2：短听窗口可调（默认 5s）—— 插件侧拨号有重试间隔，窗口太短会误报「未启动」
const bridgeWaitMs = argOf('--bridge-wait', 5000);
const ports = await probePorts(cdpPort, bridgePort, bridgeWaitMs);
const localRun = !!(host.st.userRoot || host.tt.appRoot);
const debugPortUp = ports.cdp || ports.bridge;

// ============================================================
// v3.11.1：部署副本的「干净」判定分级 + **可验证的采纳通道**
//
// 真机遇到的实际局面：部署副本 HEAD 停在旧提交，但工作树里多出 3 个**未跟踪文件**
//   （都是仓库后续提交里的文档/测试，被 `git reset` 之类的操作留了下来）。
//   一刀切的「有改动就拒绝」会卡住同步；但直接覆盖又可能踩到用户的真实改动。
// 判据（保守且**可验证**）：
//   · 已跟踪文件被**修改/删除** → 一律拒绝（可能是用户改的）；
//   · 只有**未跟踪文件**：
//       - 不带 `--adopt-untracked` → 拒绝，并提示该开关；
//       - 带上开关 → 逐个与**开发仓库 HEAD 的同名文件**做 sha256 比对：
//           全部逐字节相同 → 安全（它们就是仓库文件，快进后会原样恢复）→ 采纳（先删这几个残留）；
//           有任何一个不同 → **拒绝**（那是用户的文件，绝不删）。
// ============================================================
const ADOPT_UNTRACKED = has('--adopt-untracked');
const shaOfFile = (p) => {
    try { return sha256(readFileSync(p)); } catch (e) { return ''; }
};
let adoptList = [];
let untrackedDiffers = [];
let dirtyNote = '';

// 部署副本是否干净（v3.10.2：**只有 --yes 才需要**；查不出来时传 `null` → 判定为拒绝，绝不放行）
const dirtyKnown = CONFIRMED && isRepo;
let dirtyCount = dirtyKnown ? null : undefined;
let dirtyError = '';
if (dirtyKnown) {
    // `-c core.quotepath=false`：中文文件名不被八进制转义/加引号，才能正确拼出本地路径比对
    const st = gitTry(deployedDir, ['-c', 'core.quotepath=false', 'status', '--porcelain']);
    if (!st.ok) dirtyError = st.out;
    else {
        const rows = st.out.split('\n').map((l) => l.trim()).filter(Boolean);
        // porcelain 格式：`XY<空格>路径` —— 必须跳 3 个字符（两字符状态 + 一个空格），否则路径多一个前导空格读不到文件
        const untracked = rows.filter((l) => l.startsWith('??')).map((l) => l.slice(3).replace(/^"|"$/g, ''));
        const tracked = rows.filter((l) => !l.startsWith('??'));
        if (tracked.length) dirtyCount = tracked.length;                       // 已跟踪被改/删 → 一律拒绝
        else if (!untracked.length) dirtyCount = 0;
        else if (!ADOPT_UNTRACKED) { dirtyCount = untracked.length; dirtyNote = '（均为未跟踪文件；如确认它们就是仓库文件，可加 --adopt-untracked 让工具逐字节核验后采纳）'; }
        else {
            // 带开关：逐个与开发仓库 HEAD 的同名文件比对 sha256 —— 只采纳**逐字节相同**的残留
            const bad = untracked.filter((f) => {
                const a = shaOfFile(join(deployedDir, f));
                const b = shaOfFile(join(devRoot, f));
                return !a || !b || a !== b;
            });
            if (bad.length) { untrackedDiffers = bad; dirtyCount = bad.length; dirtyNote = '（未跟踪文件与仓库同名文件内容**不同** → 视为用户文件，拒绝）'; }
            else { adoptList = untracked; dirtyCount = 0; dirtyNote = '（' + untracked.length + ' 个未跟踪文件与仓库逐字节相同 → 可安全采纳）'; }
        }
    }
}
const gitAvailable = isRepo ? gitTry(deployedDir, ['--version']).ok : false;

const plan = planHostSync(Object.assign({
    deployedDir: deployedDir,
    isRepo: isRepo,
    devSha: devHead && devHead.sha,
    deployedSha: extHead && extHead.sha,
    sameRemote: sameRemote,
    gitAvailable: isRepo ? gitAvailable : true,
}, dirtyKnown ? { dirtyCount: dirtyCount } : {}));

console.log('===== 宿主副本同步（开发守则 §6.4）=====');
console.log('  条件 · 本地运行            ：' + (localRun ? '是' : '否（未发现宿主安装）'));
console.log('  条件 · 调试端口已启动      ：' + (debugPortUp ? '是' : '否')
    + '（CDP ' + cdpPort + ' ' + (ports.cdp ? '✓' : '✗') + ' · 只读调试桥 ' + bridgePort + ' ' + (ports.bridge ? '✓' : '✗')
    + '，短听 ' + bridgeWaitMs + 'ms）');
console.log('  开发仓库                   ：v' + String((devManifest && devManifest.version) || '?')
    + ' · ' + String((devHead && devHead.sha) || '(无)').slice(0, 8) + ' · ' + show(host.dev.root || DEV_ROOT));
console.log('  部署副本                   ：v' + String((extManifest && extManifest.version) || '?')
    + ' · ' + String((extHead && extHead.sha) || '(非 git 检出)').slice(0, 8) + ' · ' + show(deployedDir));
console.log('  同源 / 干净                ：' + (sameRemote === null ? '—' : (sameRemote ? '同源' : '**异源**'))
    + ' / ' + (dirtyCount === null ? ('**查不出**（' + String(dirtyError || '').slice(0, 80) + '）')
        : (dirtyCount === undefined ? '未检查（--yes 时检查）' : ((dirtyCount === 0 ? '干净' : dirtyCount + ' 处改动') + dirtyNote))));
if (adoptList.length) console.log('  可采纳的残留（与仓库逐字节相同）      ：' + adoptList.join(' · '));
if (untrackedDiffers.length) console.log('  内容不同的未跟踪文件（拒绝删除）      ：' + untrackedDiffers.join(' · '));
console.log('  判定                       ：' + plan.action + '（' + plan.reason + '）—— ' + plan.note);

if (!CONFIRMED) {
    console.log('\n  只读检查结束。执行同步：npm run local:sync -- --yes');
    if (plan.action === 'ff') process.exitCode = 1;   // 存在漂移 → 让调用方看得见
    process.exit();
}

if (plan.action === 'none') {
    console.log('\n  ✅ 两侧已一致，无需同步。');
    process.exit(0);
}
if (plan.action !== 'ff') {
    console.log('\n  ❌ 未执行同步：' + plan.note);
    process.exit(1);
}

// ---------- 执行：先清掉「与仓库逐字节相同」的未跟踪残留，再 fetch + 快进 ----------
const branch = String((devHead && devHead.ref) || '').replace(/^refs\/heads\//, '') || 'main';
if (adoptList.length) {
    console.log('\n  采纳残留（与仓库同名文件 sha256 相同 → 快进后会原样恢复）：');
    for (const f of adoptList) {
        try {
            rmSync(join(deployedDir, f), { force: true });
            console.log('    · 已移除 ' + f);
        } catch (e) { console.log('    · 移除失败 ' + f + '：' + String((e && e.message) || e)); }
    }
}
console.log('\n  同步中：git fetch <开发仓库> ' + branch + ' → merge --ff-only');
const f = gitTry(deployedDir, ['fetch', String(host.dev.root || DEV_ROOT), branch]);
if (!f.ok) {
    console.log('  ❌ fetch 失败：' + f.out);
    process.exit(1);
}
const m = gitTry(deployedDir, ['merge', '--ff-only', 'FETCH_HEAD']);
if (!m.ok) {
    console.log('  ❌ 快进失败（非快进 / 冲突一律不处理，绝不 force）：' + m.out);
    process.exit(1);
}

const afterHead = readGitHead(fsx, deployedDir);
const afterManifest = readManifest(fsx, deployedDir);
const devVersion = String((devManifest && devManifest.version) || '');
const afterVersion = String((afterManifest && afterManifest.version) || '');
const shaOk = !!(afterHead && devHead && afterHead.sha === devHead.sha);
const verOk = afterVersion === devVersion && devVersion !== '';

console.log('  结果                       ：部署副本 v' + (afterVersion || '?') + ' · ' + String((afterHead && afterHead.sha) || '').slice(0, 8));
console.log('  核对                       ：' + (shaOk && verOk ? '✅ 版本与提交均与开发仓库一致' : '❌ 不一致（请人工核对）'));
if (debugPortUp) console.log('  生效提醒                   ：插件在**页面加载时**装配 —— 需要用户**刷新页面**才生效（刷新后只读调试桥按设计回到关闭）。');
process.exit(shaOk && verOk ? 0 : 1);
