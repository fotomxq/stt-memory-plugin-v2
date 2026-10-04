// ============================================================
// tests/local/host.js —— 本地宿主发现与只读自检（纯逻辑，可单测）
//
// 定位：给「本地开发时把插件挂进真实 SillyTavern / TauriTavern 调试」这件事提供
//   **可复现、可门禁、不泄漏隐私**的底座。本文件只做发现与读取，**不写任何宿主文件**。
//
// 隐私约定（硬性）：
//   ① 本文件与 `tests/local/` 下任何**入库**文件，都不得出现机器特有路径
//      （用户名 / 主机名 / `C:\Users\...` / `/home/<name>`）；所有路径一律在运行时由
//      `env` 与 `home` 解析 —— 由 `scripts/check-local-leak.js` 强制。
//   ② 面向用户的输出默认**脱敏**（`C:\Users\<user>\...` → `%APPDATA%\...`），
//      只有显式 `--show-paths` 才打全路径。
//   ③ 只读：宿主配置（`config.yaml` / `settings.json` / `tauritavern-settings.json`）
//      与插件用户数据（`_tauritavern/extension-store/**`）**一律只读**，绝不修改。
//
// 依赖注入：`fsx` 与 `env` 都是入参，单测可扔临时目录进去，宿主侧无需真实安装。
// ============================================================
import {
    existsSync, statSync, readFileSync, readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** TauriTavern 的 Tauri bundle 标识（应用数据目录名；与用户名无关，非隐私） */
export const TT_BUNDLE_ID = 'com.tauritavern.client';
/** SillyTavern 的默认用户名目录 */
export const ST_DEFAULT_USER = 'default-user';
/** 扩展加载子目录（相对 ST 用户目录） */
export const EXT_SUBDIR = 'extensions';
/** 本插件在扩展目录下的文件夹名（= 仓库名，见 manifest 安装说明） */
export const PLUGIN_FOLDER = 'stt-memory-plugin-v2';
/** 宿主原生存储中本插件的容器 id（`host/tt-store.js` 写入；只做只读统计） */
export const TT_STORE_IDS = ['ftt-files', 'ftt2-files'];

/** 真实 Node 文件系统适配器（单测可换成临时目录，接口保持一致） */
export function nodeFs() {
    return {
        exists: (p) => existsSync(p),
        isDir: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
        isFile: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
        readText: (p) => readFileSync(p, 'utf8'),
        readBytes: (p) => readFileSync(p),
        size: (p) => { try { return statSync(p).size; } catch { return 0; } },
        list: (p) => {
            try { return readdirSync(p, { withFileTypes: true }); } catch { return []; }
        },
    };
}

/** sha256（十六进制） */
export function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

// ------------------------------------------------------------
// 1. 平台级目录解析（只用 env / home，零硬编码）
// ------------------------------------------------------------

/**
 * 候选「应用数据根」目录（各平台约定）。
 * @returns {string[]} 按优先级排列；解析不出来的项不出现
 */
export function appDataRoots({ platform = process.platform, env = process.env, home = '' } = {}) {
    const out = [];
    if (platform === 'win32') {
        if (env.APPDATA) out.push(env.APPDATA);
        if (env.LOCALAPPDATA) out.push(env.LOCALAPPDATA);
    } else if (platform === 'darwin') {
        if (home) out.push(join(home, 'Library', 'Application Support'));
    } else {
        if (env.XDG_CONFIG_HOME) out.push(env.XDG_CONFIG_HOME);
        if (home) out.push(join(home, '.config'));
    }
    return out.filter(Boolean);
}

/** TauriTavern 应用数据根的候选路径 */
export function ttAppRoots(opts = {}) {
    return appDataRoots(opts).map((r) => join(r, TT_BUNDLE_ID));
}

/** TauriTavern 可执行文件候选路径（Windows 安装约定） */
export function ttExeCandidates(opts = {}) {
    const { platform = process.platform, env = process.env } = opts;
    if (platform !== 'win32') return [];
    if (!env.LOCALAPPDATA) return [];
    return [join(env.LOCALAPPDATA, 'TauriTavern', 'tauritavern.exe')];
}

/**
 * 路径脱敏：把用户主目录 / 应用数据根替换成环境变量占位符。
 * 只影响**显示**，不改变任何真实读写路径。
 */
export function maskPath(p, { env = process.env, home = '' } = {}) {
    let s = String(p == null ? '' : p);
    const rules = [
        [env.APPDATA, '%APPDATA%'],
        [env.LOCALAPPDATA, '%LOCALAPPDATA%'],
        [env.USERPROFILE, '%USERPROFILE%'],
        [env.XDG_CONFIG_HOME, '$XDG_CONFIG_HOME'],
        [home && join(home, 'Library', 'Application Support'), '~/Library/Application Support'],
        [home, '~'],
    ];
    for (const [real, ph] of rules) {
        if (!real || !ph) continue;
        // 大小写不敏感替换（Windows 路径大小写常不一致）
        const rx = new RegExp(real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        s = s.replace(rx, ph);
    }
    return s;
}

// ------------------------------------------------------------
// 2. 宿主发现
// ------------------------------------------------------------

/**
 * 发现本地宿主。`config` 里给出的显式路径**优先**（来自不入库的 `local.config.json`）。
 * @returns {{tt: object, st: object, sources: object}}
 */
export function discoverHost({ config = {}, fsx = nodeFs(), platform = process.platform, env = process.env, home = '' } = {}) {
    const sources = {};

    // —— TauriTavern 应用数据根 ——
    let ttRoot = config.ttAppRoot || '';
    if (ttRoot) sources.ttAppRoot = 'config';
    else {
        ttRoot = ttAppRoots({ platform, env, home }).find((p) => fsx.isDir(p)) || '';
        if (ttRoot) sources.ttAppRoot = 'auto';
    }

    // —— SillyTavern 用户数据根（TauriTavern 下即 <ttRoot>/data）——
    let stDataRoot = config.stDataRoot || '';
    if (stDataRoot) sources.stDataRoot = 'config';
    else if (ttRoot && fsx.isDir(join(ttRoot, 'data'))) { stDataRoot = join(ttRoot, 'data'); sources.stDataRoot = 'tt-auto'; }

    let stUserRoot = config.stUserRoot || '';
    if (stUserRoot) sources.stUserRoot = 'config';
    else if (stDataRoot) {
        const u = join(stDataRoot, config.stUser || ST_DEFAULT_USER);
        if (fsx.isDir(u)) { stUserRoot = u; sources.stUserRoot = 'auto'; }
    }

    // —— 扩展目录 ——
    let extRoot = config.extRoot || '';
    if (extRoot) sources.extRoot = 'config';
    else if (stUserRoot) {
        const e = join(stUserRoot, EXT_SUBDIR);
        if (fsx.isDir(e)) { extRoot = e; sources.extRoot = 'auto'; }
    }

    const folder = config.pluginFolder || PLUGIN_FOLDER;
    const pluginRoot = extRoot ? join(extRoot, folder) : '';

    // —— 可执行文件 ——
    let exe = config.ttExe || '';
    if (exe) sources.ttExe = 'config';
    else {
        exe = ttExeCandidates({ platform, env }).find((p) => fsx.isFile(p)) || '';
        if (exe) sources.ttExe = 'auto';
    }

    return {
        tt: {
            appRoot: ttRoot,
            exe,
            settingsPath: stUserRoot ? join(stUserRoot, 'tauritavern-settings.json') : '',
            logsRoot: ttRoot ? join(ttRoot, 'logs') : '',
        },
        st: {
            dataRoot: stDataRoot,
            userRoot: stUserRoot,
            extRoot,
            settingsPath: stUserRoot ? join(stUserRoot, 'settings.json') : '',
            // 插件用户数据（宿主原生存储）—— 只读统计用
            storeRoot: stDataRoot ? join(stDataRoot, '_tauritavern', 'extension-store') : '',
        },
        plugin: { folder, root: pluginRoot },
        // 开发仓库根（默认取本文件的上上级；也可由 config 指定）
        dev: { root: config.devRoot || '' },
        sources,
    };
}

// ------------------------------------------------------------
// 3. 逐项只读读取
// ------------------------------------------------------------

/** 读取插件的 manifest.json（失败返回 null） */
export function readManifest(fsx, pluginRoot) {
    if (!pluginRoot) return null;
    const p = join(pluginRoot, 'manifest.json');
    if (!fsx.isFile(p)) return null;
    try { return JSON.parse(fsx.readText(p)); } catch { return null; }
}

/**
 * 直读 `.git` 元数据（**不调用 git 命令**：避免 `safe.directory` 之类的全局配置改动，
 * 也避免宿主仓库属主与当前进程不一致时的 dubious-ownership 报错）。
 * @returns {{ref:string, sha:string}|null}
 */
export function readGitHead(fsx, repoRoot) {
    if (!repoRoot) return null;
    const gitDir = join(repoRoot, '.git');
    if (!fsx.isDir(gitDir)) return null;
    let head = '';
    try { head = fsx.readText(join(gitDir, 'HEAD')).trim(); } catch { return null; }
    if (!head.startsWith('ref:')) return head ? { ref: '(detached)', sha: head } : null;
    const ref = head.slice(4).trim();
    try { return { ref, sha: fsx.readText(join(gitDir, ref)).trim() }; } catch { /* 可能在 packed-refs */ }
    try {
        const packed = fsx.readText(join(gitDir, 'packed-refs'));
        const line = packed.split('\n').find((l) => l.trim().endsWith(' ' + ref));
        if (line) return { ref, sha: line.split(' ')[0].trim() };
    } catch { /* 无 packed-refs */ }
    return { ref, sha: '' };
}

/** 读取 origin 远端地址（公开仓库地址，不属隐私） */
export function readGitRemote(fsx, repoRoot) {
    if (!repoRoot) return '';
    try {
        const cfg = fsx.readText(join(repoRoot, '.git', 'config'));
        const m = cfg.match(/\[remote\s+"origin"\][\s\S]*?url\s*=\s*(.+)/);
        return m ? m[1].trim() : '';
    } catch { return ''; }
}

/**
 * 抽取 ST `settings.json` 的 `disabledExtensions` 数组。
 * 该文件可达 10 MB 且是单行 JSON，**不能整体 JSON.parse**（实测 PowerShell/node 都会很久），
 * 故用锚定正则只取这一段。
 */
export function readDisabledExtensions(fsx, settingsPath) {
    if (!settingsPath || !fsx.isFile(settingsPath)) return null;
    try {
        const t = fsx.readText(settingsPath);
        const m = t.match(/"disabledExtensions"\s*:\s*\[([^\]]*)\]/);
        if (!m) return [];
        return m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    } catch { return null; }
}

/** 判定扩展是否启用：ST 的禁用表用 `third-party/<folder>`。null = 无法判定 */
export function pluginEnabled(disabledList, folder) {
    if (disabledList == null) return null;
    return !disabledList.some((k) => k === 'third-party/' + folder || k === folder);
}

/**
 * 读取 TauriTavern 的 `dev` 段（前端 console 捕获 / LLM 日志保留数）。
 * **只读**：`frontend_console_capture` 属宿主配置，本工具绝不代改 —— 只提示用户手动开。
 */
export function readDevFlags(fsx, settingsPath) {
    if (!settingsPath || !fsx.isFile(settingsPath)) return null;
    try {
        const j = JSON.parse(fsx.readText(settingsPath));
        return { frontendConsoleCapture: !!(j.dev && j.dev.frontend_console_capture), llmApiKeep: (j.dev && j.dev.llm_api_keep) };
    } catch { return null; }
}

/** 目录只读统计（文件数 / 字节数） */
export function dirStats(fsx, dir) {
    let files = 0, bytes = 0;
    const walk = (d) => {
        for (const e of fsx.list(d)) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p);
            else { files++; bytes += fsx.size(p); }
        }
    };
    if (dir && fsx.isDir(dir)) walk(dir);
    return { files, bytes };
}

/** 插件在宿主原生存储里的容器统计（只读） */
export function storeStats(fsx, storeRoot, ids = TT_STORE_IDS) {
    const out = {};
    for (const id of ids) out[id] = storeRoot ? dirStats(fsx, join(storeRoot, id)) : { files: 0, bytes: 0 };
    return out;
}

// ------------------------------------------------------------
// 4. 开发仓库 ↔ 宿主部署副本 的漂移比对
// ------------------------------------------------------------

/** 跳过项：VCS 元数据、依赖、本工具自身的本地实参与产物 */
export const INVENTORY_SKIP = ['.git', 'node_modules', 'local.config.json', 'out'];

/**
 * 生成「相对路径 → 内容 sha256」清单（用于漂移比对与部署计划）。
 * 只纳入文本类发布物（js/json/html/css/md/txt/cmd/yml/yaml），跳过 .git 与本地实参。
 */
export function inventory(fsx, root, { skip = INVENTORY_SKIP } = {}) {
    const map = new Map();
    if (!root || !fsx.isDir(root)) return map;
    const walk = (dir, rel) => {
        for (const e of fsx.list(dir)) {
            if (skip.includes(e.name)) continue;
            const abs = join(dir, e.name);
            const r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) { walk(abs, r); continue; }
            map.set(r, sha256(fsx.readBytes(abs)));
        }
    };
    walk(root, '');
    return map;
}

/**
 * 漂移比对（纯函数）。
 * @returns {{added:string[], removed:string[], changed:string[]}} 以 `b` 为基准看 `a`
 */
export function diffInventory(mapA, mapB) {
    const added = [], removed = [], changed = [];
    for (const [k, v] of mapA) {
        if (!mapB.has(k)) added.push(k);
        else if (mapB.get(k) !== v) changed.push(k);
    }
    for (const k of mapB.keys()) if (!mapA.has(k)) removed.push(k);
    const sort = (a) => a.sort();
    return { added: sort(added), removed: sort(removed), changed: sort(changed) };
}

/**
 * 部署计划（纯函数，**不落盘**）：
 * 把开发仓库的发布物同步进宿主扩展目录，**永不触碰部署副本的 `.git`，永不删除任何文件**。
 * @returns {{copies:string[], identical:string[], keptGit:boolean}}
 */
export function planDeploy(devInv, extInv) {
    const copies = [], identical = [];
    for (const [k, v] of devInv) {
        if (extInv.get(k) === v) identical.push(k);
        else copies.push(k);
    }
    return {
        copies: copies.sort(),
        identical: identical.sort(),
        // 部署副本里存在但开发仓库没有的文件：**保持不动**（保守策略，不删）
        extraInDeployed: [...extInv.keys()].filter((k) => !devInv.has(k)).sort(),
        keptGit: true,
    };
}

/**
 * 宿主副本同步计划（纯函数，**不落盘、不调 git**）—— 用户新约定（`开发守则.md` §6.4）：
 * 「本地运行 + 调试端口已启动」时，部署除了 git 提交，还要把宿主下的插件替换到最新版。
 *
 * 分流规则（保守优先，永不覆盖用户改动）：
 *   · 没找到宿主 / 部署目录 → `none`（无事可做）；
 *   · 部署目录**不是 git 检出** → `deploy-copy`（改走 `npm run local -- --deploy --yes` 文件级替换）；
 *   · 部署副本**有本地改动** → `refuse`（拒绝，绝不覆盖）；
 *   · **干净与否查不出来**（`dirtyCount === null`，例如 git 调用被 dubious-ownership 拒绝）→ `refuse`
 *     —— **「不知道」不等于「干净」**，宁可不做也不覆盖；
 *   · 与开发仓库**不同源**（origin 不一致）→ `refuse`；
 *   · 已与开发仓库同一提交 → `none`（already-aligned）；
 *   · 其余 → `ff`（fetch + `merge --ff-only`，宿主在跑也能替换）。
 *
 * @param {{deployedDir?:string, isRepo?:boolean, devSha?:string, deployedSha?:string,
 *          sameRemote?:boolean, dirtyCount?:number|null, gitAvailable?:boolean}} info
 * @returns {{action:'none'|'ff'|'deploy-copy'|'refuse', reason:string, ok:boolean, note:string}}
 */
export function planHostSync(info) {
    const o = info || {};
    const sha = (v) => String(v || '').trim();
    const hasKey = Object.prototype.hasOwnProperty.call(o, 'dirtyCount');
    // git 不可用 / 状态未知 → 不做 git 快进；改走文件级替换（那条路不依赖 git）
    if (o.gitAvailable === false) {
        return { action: 'deploy-copy', reason: 'git-unavailable', ok: false, note: '本机没有可用的 git → 请用 npm run local -- --deploy --yes（需先退出宿主）' };
    }
    if (!o.deployedDir) return { action: 'none', reason: 'no-host', ok: true, note: '未发现宿主扩展目录 → 无需同步' };
    if (o.isRepo === false) {
        return { action: 'deploy-copy', reason: 'not-a-git-checkout', ok: false, note: '部署副本不是 git 检出 → 请用 npm run local -- --deploy --yes' };
    }
    // v3.10.2：**「不知道」不等于「干净」** —— 显式传入 null（查过但没查出来，例如 git 被拒）时一律拒绝，
    //   绝不放行；只有**调用方根本没查**（键缺省，例如只读检查模式）才继续往下判定。
    if (hasKey && o.dirtyCount === null) {
        return { action: 'refuse', reason: 'clean-unknown', ok: false, note: '无法确认部署副本是否干净（git 调用失败）→ 拒绝覆盖' };
    }
    if (hasKey && Number(o.dirtyCount) > 0) {
        return { action: 'refuse', reason: 'deployed-dirty', ok: false, note: '部署副本有 ' + Number(o.dirtyCount) + ' 处本地改动 → 拒绝覆盖（请先自行处理）' };
    }
    if (o.sameRemote === false) {
        return { action: 'refuse', reason: 'remote-mismatch', ok: false, note: '部署副本与开发仓库不同源 → 拒绝覆盖' };
    }
    if (sha(o.devSha) && sha(o.devSha) === sha(o.deployedSha)) {
        return { action: 'none', reason: 'already-aligned', ok: true, note: '两侧已在同一提交 → 无需同步' };
    }
    return { action: 'ff', reason: 'drift', ok: true, note: '把宿主副本快进到开发仓库当前提交（fetch + merge --ff-only）' };
}
