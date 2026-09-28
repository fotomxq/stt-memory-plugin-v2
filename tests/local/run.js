#!/usr/bin/env node
// ============================================================
// tests/local/run.js —— 本地调试自检入口（面向真实宿主）
//
// 用法：
//   npm run local                  # 只读自检（默认；绝不写宿主）
//   npm run local -- --show-paths  # 打全路径（默认脱敏）
//   npm run local -- --json        # 机器可读输出
//   npm run local -- --strict      # 漂移/未启用也算失败（供脚本化）
//   npm run local -- --save        # 另存报告到 tests/local/out/（已 gitignore）
//   npm run local -- --deploy --yes  # 把开发仓库发布物同步进宿主扩展目录
//
// 与 `npm test` 的分工：
//   `npm test`  = 无宿主也能跑的纯单元测试（stub 宿主），发布门禁的一部分；
//   `npm run local` = **本机**真实宿主（TauriTavern / SillyTavern）的只读自检 + 部署，
//     依赖机器上的实际安装，**不属于**发布门禁。
//
// 隐私与边界（硬性，见 `开发守则.md` §6）：
//   ① 输出默认**脱敏**（用户主目录 → `%APPDATA%` / `~`）；
//   ② 宿主配置（`config.yaml` / `settings.json` / `tauritavern-settings.json`）
//      与插件用户数据（`_tauritavern/extension-store/**`）**一律只读**；
//   ③ 只有 `--deploy --yes` 会写，且只写宿主扩展目录下本插件自己的发布物，
//      **不删任何文件、不碰部署副本的 `.git`**；
//   ④ 入库文件不得出现机器特有路径（由 `scripts/check-local-leak.js` 强制）。
// ============================================================
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
    nodeFs, discoverHost, maskPath, readManifest, readGitHead, readGitRemote,
    readDisabledExtensions, pluginEnabled, readDevFlags, storeStats,
    inventory, diffInventory, planDeploy, PLUGIN_FOLDER,
} from './host.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = resolve(HERE, '..', '..');
const CONFIG_FILE = join(HERE, 'local.config.json');
const OUT_DIR = join(HERE, 'out');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const SHOW_PATHS = has('--show-paths');
const AS_JSON = has('--json');
const STRICT = has('--strict');
const SAVE = has('--save');
const DEPLOY = has('--deploy');
const CONFIRMED = has('--yes');

if (has('--help') || has('-h')) {
    console.log('用法：node tests/local/run.js [--show-paths] [--json] [--strict] [--save] [--deploy --yes]');
    process.exit(0);
}

const fsx = nodeFs();
const env = process.env;
const home = homedir();
const show = (p) => (SHOW_PATHS ? String(p || '') : maskPath(p, { env, home }));

/** 载入不入库的本地实参（可缺省 —— 缺省时全靠自动探测） */
function loadConfig() {
    if (!fsx.isFile(CONFIG_FILE)) return { config: {}, present: false };
    try { return { config: JSON.parse(fsx.readText(CONFIG_FILE)), present: true }; } catch (e) {
        return { config: {}, present: true, error: String((e && e.message) || e) };
    }
}

const { config, present: configPresent, error: configError } = loadConfig();
const host = discoverHost({ config, fsx, home });
const devRoot = host.dev.root || DEV_ROOT;

const results = [];
const add = (level, title, detail) => results.push({ level, title, detail: detail == null ? '' : String(detail) });
const ok = (t, d) => add('ok', t, d);
const warn = (t, d) => add('warn', t, d);
const bad = (t, d) => add('bad', t, d);
const info = (t, d) => add('info', t, d);

// ------------------------------------------------------------
// 1. 宿主发现
// ------------------------------------------------------------
if (!configPresent) info('本地实参', '未找到 ' + show(CONFIG_FILE) + '（可选；自动探测已足够）');
else if (configError) bad('本地实参', '解析失败：' + configError);
else ok('本地实参', '已载入 ' + show(CONFIG_FILE));

if (!host.st.userRoot) {
    bad('宿主发现', '未找到 SillyTavern 用户数据目录（可用 local.config.json 显式指定 stUserRoot）');
} else {
    ok('宿主发现', 'ST 用户目录 ' + show(host.st.userRoot) + '（来源：' + (host.sources.stUserRoot || '?') + '）');
}
if (host.tt.appRoot) ok('宿主发现', 'TauriTavern 应用数据 ' + show(host.tt.appRoot) + '（来源：' + (host.sources.ttAppRoot || '?') + '）');
else info('宿主发现', '未发现 TauriTavern 应用数据目录（纯 SillyTavern 环境下属正常）');
if (host.tt.exe) ok('宿主发现', 'TauriTavern 可执行文件 ' + show(host.tt.exe));
if (host.st.extRoot) ok('宿主发现', '扩展加载目录 ' + show(host.st.extRoot));
else bad('宿主发现', '未找到扩展加载目录');

// ------------------------------------------------------------
// 2. 插件是否已安装 + 版本一致性
// ------------------------------------------------------------
const devManifest = readManifest(fsx, devRoot);
const extManifest = readManifest(fsx, host.plugin.root);
let versionMismatch = false;

if (!devManifest) bad('开发仓库', '未读到 manifest.json（devRoot=' + show(devRoot) + '）');
else ok('开发仓库', '版本 ' + devManifest.version + ' · ' + show(devRoot));

if (!extManifest) {
    bad('插件安装', '宿主扩展目录下未找到 ' + host.plugin.folder + '/manifest.json —— 尚未安装或路径不对');
} else {
    ok('插件安装', '已安装版本 ' + extManifest.version + ' · ' + show(host.plugin.root));
    if (devManifest && String(devManifest.version) !== String(extManifest.version)) {
        versionMismatch = true;
        warn('版本一致性', '开发仓库 ' + devManifest.version + ' ≠ 宿主部署 ' + extManifest.version);
    } else if (devManifest) {
        ok('版本一致性', '开发仓库与宿主部署同为 ' + devManifest.version);
    }
}

// ------------------------------------------------------------
// 3. git 元数据（直读 .git，不调用 git 命令）
// ------------------------------------------------------------
const devHead = readGitHead(fsx, devRoot);
const extHead = readGitHead(fsx, host.plugin.root);
const devRemote = readGitRemote(fsx, devRoot);
const extRemote = readGitRemote(fsx, host.plugin.root);

if (devHead) ok('开发仓库 git', (devHead.ref || '?') + ' @ ' + String(devHead.sha).slice(0, 12) + (devRemote ? ' ← ' + devRemote : ''));
if (extHead) ok('部署副本 git', (extHead.ref || '?') + ' @ ' + String(extHead.sha).slice(0, 12) + (extRemote ? ' ← ' + extRemote : ''));
else if (extManifest) info('部署副本 git', '非 git 检出（手动拷贝安装）');
if (devRemote && extRemote && devRemote !== extRemote) warn('同源核对', '两侧 origin 不同：开发 ' + devRemote + ' / 部署 ' + extRemote);

// ------------------------------------------------------------
// 4. 漂移比对（开发仓库 vs 部署副本）
// ------------------------------------------------------------
let drift = null;
if (extManifest) {
    const devInv = inventory(fsx, devRoot);
    const extInv = inventory(fsx, host.plugin.root);
    drift = diffInventory(devInv, extInv);
    const total = drift.added.length + drift.removed.length + drift.changed.length;
    const brief = '仅开发有 ' + drift.added.length + ' · 内容不同 ' + drift.changed.length + ' · 仅部署有 ' + drift.removed.length;
    if (total === 0) ok('漂移比对', '两侧发布物逐字节一致（' + devInv.size + ' 个文件）');
    else warn('漂移比对', brief + '（合计 ' + total + '）');
    const sample = (arr) => arr.slice(0, 6).join(' · ') + (arr.length > 6 ? ' …' : '');
    if (drift.added.length) info('  仅开发有', sample(drift.added));
    if (drift.changed.length) info('  内容不同', sample(drift.changed));
    if (drift.removed.length) info('  仅部署有', sample(drift.removed));
}

// ------------------------------------------------------------
// 5. 宿主启用状态（只读 settings.json 的 disabledExtensions）
// ------------------------------------------------------------
let enabled = null;
if (host.st.settingsPath && fsx.isFile(host.st.settingsPath)) {
    const disabled = readDisabledExtensions(fsx, host.st.settingsPath);
    if (disabled == null) info('启用状态', '未能抽取 disabledExtensions（文件格式变化？）');
    else {
        enabled = pluginEnabled(disabled, host.plugin.folder);
        if (enabled === true) ok('启用状态', '已在宿主启用（不在 disabledExtensions 中）');
        else warn('启用状态', '在宿主的 disabledExtensions 中 —— 面板不会加载');
    }
} else info('启用状态', '未读到宿主 settings.json，跳过');

// ------------------------------------------------------------
// 6. 部署副本的 i18n 落地（词条文件与键集一致）
// ------------------------------------------------------------
if (extManifest) {
    const zh = join(host.plugin.root, 'i18n', 'zh-cn.json');
    const en = join(host.plugin.root, 'i18n', 'en.json');
    const read = (p) => { try { return JSON.parse(fsx.readText(p)); } catch { return null; } };
    const jz = read(zh), je = read(en);
    if (!jz || !je) bad('词条落地', '部署副本缺 i18n/zh-cn.json 或 en.json');
    else {
        const kz = Object.keys(jz).length, ke = Object.keys(je).length;
        const missing = Object.keys(jz).filter((k) => !(k in je));
        if (kz === ke && !missing.length) ok('词条落地', kz + ' 条 × 2 语言，键集一致');
        else warn('词条落地', '键集不一致：zh ' + kz + ' / en ' + ke + '，en 缺 ' + missing.length + ' 条');
    }
}

// ------------------------------------------------------------
// 7. 插件用户数据（宿主原生存储）—— 只读统计，绝不修改
// ------------------------------------------------------------
if (host.st.storeRoot && fsx.isDir(host.st.storeRoot)) {
    const st = storeStats(fsx, host.st.storeRoot);
    const parts = Object.entries(st).map(([id, s]) => id + ' ' + s.files + ' 文件/' + Math.round(s.bytes / 1024) + ' KB');
    ok('插件用户数据', parts.join(' · ') + '（只读统计）');
} else info('插件用户数据', '未发现宿主原生存储目录，跳过');

// ------------------------------------------------------------
// 8. 调试开关现状（只读提示；宿主配置不由本工具代改）
// ------------------------------------------------------------
const devFlags = readDevFlags(fsx, host.tt.settingsPath);
if (devFlags) {
    if (devFlags.frontendConsoleCapture) ok('前端 console 捕获', '已开启（dev.frontend_console_capture = true）');
    else info('前端 console 捕获', '未开启 —— 需你手动把 tauritavern-settings.json 的 dev.frontend_console_capture 置 true（本工具不代改宿主配置）');
    info('LLM 请求留档', 'dev.llm_api_keep = ' + devFlags.llmApiKeep + '（日志见 ' + show(host.tt.logsRoot) + '）');
} else info('调试开关', '未读到 tauritavern-settings.json，跳过');

// ------------------------------------------------------------
// 9. 输出
// ------------------------------------------------------------
const hardFail = results.some((r) => r.level === 'bad');
const softFail = results.some((r) => r.level === 'warn');
const failed = hardFail || (STRICT && softFail);

if (AS_JSON) {
    const payload = {
        devRoot: show(devRoot),
        masked: !SHOW_PATHS,
        host: {
            ttAppRoot: show(host.tt.appRoot), exe: show(host.tt.exe),
            stUserRoot: show(host.st.userRoot), extRoot: show(host.st.extRoot),
        },
        versions: { dev: devManifest ? devManifest.version : null, deployed: extManifest ? extManifest.version : null },
        git: { dev: devHead, deployed: extHead },
        drift,
        enabled,
        results,
        failed,
    };
    console.log(JSON.stringify(payload, null, 2));
} else {
    console.log('\n===== FTT记忆组件 V2 · 本地调试自检 =====\n');
    const ICON = { ok: '✅', warn: '⚠️ ', bad: '❌', info: 'ℹ️ ' };
    for (const r of results) {
        console.log('  ' + (ICON[r.level] || '  ') + ' ' + r.title + (r.detail ? '：' + r.detail : ''));
    }
    const bads = results.filter((r) => r.level === 'bad').length;
    const warns = results.filter((r) => r.level === 'warn').length;
    console.log('\n  合计：' + bads + ' 处失败 · ' + warns + ' 处提示' + (SHOW_PATHS ? '（已显示全路径）' : '（路径已脱敏；--show-paths 看全路径）'));
    if (extManifest && drift) {
        const total = drift.added.length + drift.removed.length + drift.changed.length;
        if (total) console.log('  部署同步：npm run local -- --deploy --yes');
    }
    console.log('');
}

// ------------------------------------------------------------
// 10. 可选：存报告 / 部署
// ------------------------------------------------------------
if (SAVE) {
    mkdirSync(OUT_DIR, { recursive: true });
    const file = join(OUT_DIR, 'report-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    writeFileSync(file, JSON.stringify({ devRoot: show(devRoot), masked: !SHOW_PATHS, host: { extRoot: show(host.st.extRoot) }, results }, null, 2));
    console.log('  报告已保存：' + show(file) + '（tests/local/out/ 已 gitignore）\n');
}

if (DEPLOY) {
    if (!CONFIRMED) {
        console.log('  ❌ --deploy 需同时给 --yes 确认（会写入宿主扩展目录，且要求宿主已退出以免文件占用）\n');
        process.exit(2);
    }
    if (!extManifest) { console.log('  ❌ 目标目录不像本插件（无 manifest.json），拒绝部署\n'); process.exit(2); }
    const devInv = inventory(fsx, devRoot);
    const extInv = inventory(fsx, host.plugin.root);
    const plan = planDeploy(devInv, extInv);
    console.log('  部署计划：写入 ' + plan.copies.length + ' 个文件（' + plan.identical.length + ' 个已一致；'
        + plan.extraInDeployed.length + ' 个仅部署有 → **保持不动**；部署副本 .git 不触碰）');
    for (const rel of plan.copies) {
        const src = join(devRoot, rel);
        const dst = join(host.plugin.root, rel);
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
    }
    console.log('  ✅ 已同步 ' + plan.copies.length + ' 个文件到 ' + show(host.plugin.root) + '\n');
}

process.exit(failed ? 1 : 0);
