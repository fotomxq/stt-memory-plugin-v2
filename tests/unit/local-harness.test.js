// ============================================================
// 单元测试 · 本地调试底座（tests/local/host.js + scripts/check-local-leak.js）
//
// 特点：**不依赖本机是否装了 TauriTavern** —— 用临时目录伪造一份宿主目录树，
//   因此本测试在作者机器与本机都跑得通（属发布门禁，见 开发守则.md §6）。
// ============================================================
import {
    mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeReporter } from '../harness/st-mock.js';
import {
    nodeFs, appDataRoots, ttAppRoots, ttExeCandidates, maskPath, discoverHost,
    readManifest, readGitHead, readGitRemote, readDisabledExtensions, pluginEnabled,
    readDevFlags, dirStats, storeStats, inventory, diffInventory, planDeploy,
    planHostSync, sha256, PLUGIN_FOLDER,
} from '../local/host.js';
import {
    findProfilePaths, scanText, maskSecret, looksBinary, isAllowedLine, scanRepo,
    ALLOW_SUBSTRINGS, ALLOW_SYNTHETIC,
} from '../../scripts/check-local-leak.js';

const R = makeReporter('local-harness v3.0.6 本地调试底座（宿主发现 / 只读读取 / 漂移 / 隐私门禁）');
const fsx = nodeFs();

// ------------------------------------------------------------
// 伪造目录树（临时，跑完即删）
// ------------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), 'ftt-local-test-'));
const APPDATA = join(TMP, 'appdata');
const TT_APP = join(APPDATA, 'com.tauritavern.client');
const ST_USER = join(TT_APP, 'data', 'default-user');
const EXT_ROOT = join(ST_USER, 'extensions');
const PLUGIN = join(EXT_ROOT, PLUGIN_FOLDER);
const STORE = join(TT_APP, 'data', '_tauritavern', 'extension-store');
const SHA = 'a'.repeat(40);

/** 写文件（自动建父目录） */
const wf = (p, content) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, content); };

// —— 宿主侧（部署副本，版本 9.9.9）——
wf(join(PLUGIN, 'manifest.json'), JSON.stringify({ version: '9.9.9', js: 'index.js' }));
wf(join(PLUGIN, 'index.js'), '// shared index\n');
wf(join(PLUGIN, 'i18n', 'zh-cn.json'), JSON.stringify({ a: '甲', b: '乙' }));
wf(join(PLUGIN, 'i18n', 'en.json'), JSON.stringify({ a: 'A', b: 'B' }));
wf(join(PLUGIN, '.git', 'HEAD'), 'ref: refs/heads/main\n');
wf(join(PLUGIN, '.git', 'refs', 'heads', 'main'), SHA + '\n');
wf(join(PLUGIN, '.git', 'config'), '[remote "origin"]\n\turl = https://example.invalid/repo.git\n\tfetch = +refs/heads/*\n');
wf(join(ST_USER, 'settings.json'), '{"disabledExtensions":["third-party/other-ext","third-party/another"]}');
wf(join(ST_USER, 'tauritavern-settings.json'), JSON.stringify({ dev: { frontend_console_capture: true, llm_api_keep: 7 } }));
wf(join(STORE, 'ftt-files', 'kv', 'main', 'a.json'), 'aaa');
wf(join(STORE, 'ftt2-files', 'blobs', 'main', 'b.bin'), 'bbbb');

// —— 开发侧（版本 9.9.10；index 与部署侧一致，另多一个 extra.js）——
const DEV = join(TMP, 'devrepo');
wf(join(DEV, 'manifest.json'), JSON.stringify({ version: '9.9.10', js: 'index.js' }));
wf(join(DEV, 'index.js'), '// shared index\n');
wf(join(DEV, 'extra.js'), '// only in dev\n');
wf(join(DEV, 'local.config.json'), '"no leak here"');
wf(join(DEV, 'out', 'report.json'), '"no leak here"');

try {
    // ------------------------------------------------------------
    // A. 平台目录解析（零硬编码）
    // ------------------------------------------------------------
    const winEnv = { APPDATA: 'C:\\A', LOCALAPPDATA: 'C:\\L' };
    R.assert('A1 Windows：应用数据根取 APPDATA / LOCALAPPDATA',
        (() => { const r = appDataRoots({ platform: 'win32', env: winEnv, home: 'C:\\H' }); return r.length === 2 && r[0] === 'C:\\A' && r[1] === 'C:\\L'; })(),
        appDataRoots({ platform: 'win32', env: winEnv, home: 'C:\\H' }));

    R.assert('A2 macOS / Linux：分别走 ~/Library 与 XDG_CONFIG_HOME（并回落 ~/.config）', (() => {
        const mac = appDataRoots({ platform: 'darwin', env: {}, home: '/Users/username' });
        const lin1 = appDataRoots({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/username' });
        const lin2 = appDataRoots({ platform: 'linux', env: {}, home: '/home/username' });
        return mac[0] === join('/Users/username', 'Library', 'Application Support')
            && lin1[0] === '/xdg' && lin2[0] === join('/home/username', '.config');
    })());

    R.assert('A3 TauriTavern 根 = 应用数据根 + bundle id（bundle id 与用户名无关，非隐私）',
        ttAppRoots({ platform: 'win32', env: { APPDATA: 'C:\\A' }, home: '' })[0] === join('C:\\A', 'com.tauritavern.client'));

    R.assert('A4 可执行文件候选仅 Windows 且有 LOCALAPPDATA 时给出',
        ttExeCandidates({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' } })[0] === join('C:\\L', 'TauriTavern', 'tauritavern.exe')
        && ttExeCandidates({ platform: 'linux', env: { LOCALAPPDATA: 'C:\\L' } }).length === 0);

    R.assert('A5 路径脱敏：主目录 → 环境变量占位符（只影响显示，不改真实读写）', (() => {
        const env = { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\someone' };
        const masked = maskPath('C:\\Users\\someone\\AppData\\Roaming\\com.tauritavern.client', { env, home: 'C:\\Users\\someone' });
        return masked.startsWith('%APPDATA%') && !masked.includes('someone');
    })());

    // ------------------------------------------------------------
    // B. 宿主发现
    // ------------------------------------------------------------
    const host = discoverHost({ config: { ttAppRoot: TT_APP, pluginFolder: PLUGIN_FOLDER }, fsx });
    R.assert('B1 discoverHost：由 ttAppRoot 推出 ST 用户目录 / 扩展目录 / 插件目录',
        host.st.userRoot === ST_USER && host.st.extRoot === EXT_ROOT && host.plugin.root === PLUGIN,
        { userRoot: host.st.userRoot, extRoot: host.st.extRoot, plugin: host.plugin.root });
    R.assert('B2 discoverHost：显式配置标注为 config，派生项标注为 auto',
        host.sources.ttAppRoot === 'config' && host.sources.stUserRoot === 'auto' && host.sources.extRoot === 'auto',
        host.sources);
    R.assert('B3 discoverHost：派生宿主设置路径与插件用户数据根',
        host.st.settingsPath === join(ST_USER, 'settings.json')
        && host.st.storeRoot === STORE
        && host.tt.settingsPath === join(ST_USER, 'tauritavern-settings.json'),
        { st: host.st.settingsPath, store: host.st.storeRoot, tt: host.tt.settingsPath });
    R.assert('B4 discoverHost：无配置时也能按平台约定自动探测到同一宿主', (() => {
        const h = discoverHost({ config: {}, fsx, platform: 'win32', env: { APPDATA, LOCALAPPDATA: APPDATA }, home: TMP });
        return h.st.userRoot === ST_USER && h.st.extRoot === EXT_ROOT;
    })());

    // ------------------------------------------------------------
    // C. 只读读取
    // ------------------------------------------------------------
    R.assert('C1 readManifest 读到部署版本', (readManifest(fsx, PLUGIN) || {}).version === '9.9.9');
    R.assert('C2 readManifest 对不存在的目录返回 null（不抛）', readManifest(fsx, join(TMP, 'nope')) === null);

    const head = readGitHead(fsx, PLUGIN);
    R.assert('C3 readGitHead：直读 .git 解 ref 得 sha（不调用 git 命令）',
        !!head && head.ref === 'refs/heads/main' && head.sha === SHA, head);
    R.assert('C4 readGitRemote 解析 origin url', readGitRemote(fsx, PLUGIN) === 'https://example.invalid/repo.git');
    R.assert('C5 readGitHead：无 .git 的目录返回 null', readGitHead(fsx, DEV) === null);

    const dis = readDisabledExtensions(fsx, host.st.settingsPath);
    R.assert('C6 readDisabledExtensions：锚定正则只取该数组', Array.isArray(dis) && dis.length === 2 && dis[0] === 'third-party/other-ext', dis);
    R.assert('C7 pluginEnabled：不在禁用表=启用 / 在表=禁用 / 列表缺失=无法判定',
        pluginEnabled(dis, PLUGIN_FOLDER) === true
        && pluginEnabled(['third-party/' + PLUGIN_FOLDER], PLUGIN_FOLDER) === false
        && pluginEnabled(null, PLUGIN_FOLDER) === null);

    const flags = readDevFlags(fsx, host.tt.settingsPath);
    R.assert('C8 readDevFlags：只读宿主 dev 段（console 捕获 / LLM 留档数）',
        !!flags && flags.frontendConsoleCapture === true && flags.llmApiKeep === 7, flags);

    const st = storeStats(fsx, STORE);
    R.assert('C9 storeStats：按容器 id 只读统计文件数与体积',
        st['ftt-files'].files === 1 && st['ftt2-files'].files === 1 && st['ftt-files'].bytes === 3, st);
    R.assert('C10 dirStats：不存在的目录归零（不抛异常）', dirStats(fsx, join(TMP, 'nope')).files === 0);

    // ------------------------------------------------------------
    // D. 漂移比对与部署计划
    // ------------------------------------------------------------
    const devInv = inventory(fsx, DEV);
    const extInv = inventory(fsx, PLUGIN);
    R.assert('D1 inventory：跳过 .git 与本地实参/产物（local.config.json、out/）',
        ![...devInv.keys()].some((k) => k.includes('.git') || k === 'local.config.json' || k.startsWith('out/'))
        && ![...extInv.keys()].some((k) => k.includes('.git')),
        [...devInv.keys()]);

    const drift = diffInventory(devInv, extInv);
    R.assert('D2 diffInventory：仅开发有 / 内容不同 / 仅部署有 三分类正确',
        drift.added.includes('extra.js')
        && drift.changed.includes('manifest.json')
        && drift.removed.includes('i18n/en.json') && drift.removed.includes('i18n/zh-cn.json'),
        drift);

    const plan = planDeploy(devInv, extInv);
    R.assert('D3 planDeploy：变化项进 copies / 一致项进 identical / 部署侧多余项保持不动 / 不触碰 .git',
        plan.copies.includes('extra.js') && plan.copies.includes('manifest.json')
        && plan.identical.includes('index.js')
        && plan.extraInDeployed.includes('i18n/en.json') && plan.keptGit === true,
        { copies: plan.copies, identical: plan.identical, extra: plan.extraInDeployed });

    R.assert('D4 sha256 稳定且能区分内容差异',
        sha256(Buffer.from('a')) === sha256(Buffer.from('a')) && sha256(Buffer.from('a')) !== sha256(Buffer.from('b')));

    // ------------------------------------------------------------
    // D5. 宿主副本同步判定（开发守则 §6.4 的纯函数：永不覆盖、只快进）
    // ------------------------------------------------------------
    const commit = 'a'.repeat(40);
    const other = 'b'.repeat(40);
    {
        const p1 = planHostSync({ deployedDir: '', isRepo: true, devSha: commit, deployedSha: other, sameRemote: true });
        const p2 = planHostSync({ deployedDir: 'X', isRepo: false, devSha: commit, deployedSha: '', sameRemote: null });
        const p3 = planHostSync({ deployedDir: 'X', isRepo: true, devSha: commit, deployedSha: other, sameRemote: true, dirtyCount: 3 });
        const p4 = planHostSync({ deployedDir: 'X', isRepo: true, devSha: commit, deployedSha: other, sameRemote: false, dirtyCount: 0 });
        const p5 = planHostSync({ deployedDir: 'X', isRepo: true, devSha: commit, deployedSha: commit, sameRemote: true, dirtyCount: 0 });
        const p6 = planHostSync({ deployedDir: 'X', isRepo: true, devSha: commit, deployedSha: other, sameRemote: true, dirtyCount: 0 });
        const p7 = planHostSync({ deployedDir: 'X', isRepo: true, devSha: commit, deployedSha: other, sameRemote: true, gitAvailable: false });
        R.assert('D5 planHostSync：无宿主/非 git 检出/有本地改动/异源/已一致/漂移/git 不可用 七态分流正确',
            p1.action === 'none' && p1.reason === 'no-host'
            && p2.action === 'deploy-copy' && p2.reason === 'not-a-git-checkout'
            && p3.action === 'refuse' && p3.reason === 'deployed-dirty' && String(p3.note).indexOf('3') > 0
            && p4.action === 'refuse' && p4.reason === 'remote-mismatch'
            && p5.action === 'none' && p5.reason === 'already-aligned'
            && p6.action === 'ff' && p6.reason === 'drift' && p6.ok === true
            && p7.action === 'deploy-copy' && p7.reason === 'git-unavailable',
            { p1: p1.action, p2: p2.action, p3: p3.action, p4: p4.action, p5: p5.action, p6: p6.action, p7: p7.action });
        R.assert('D5b planHostSync：**拒绝态一律 ok:false**（调用方据此不写任何东西），快进态不可覆盖脏副本',
            p2.ok === false && p3.ok === false && p4.ok === false && p7.ok === false
            && planHostSync({ deployedDir: 'X', isRepo: true, devSha: commit, deployedSha: other, sameRemote: true, dirtyCount: null }).action === 'ff',
            { p2: p2.ok, p3: p3.ok, p4: p4.ok, p7: p7.ok });
    }

    // ------------------------------------------------------------
    // E. 隐私门禁（scripts/check-local-leak.js）
    // ------------------------------------------------------------
    R.assert('E1 findProfilePaths：识别 Windows 与 POSIX 两种用户主目录路径', (() => {
        const w = findProfilePaths('x C:\\Users\\alice\\proj y');
        const p = findProfilePaths('x /home/bob/proj y');
        const m = findProfilePaths('x /Users/carol/proj y');
        return w[0].name === 'alice' && p[0].name === 'bob' && m[0].name === 'carol';
    })());

    R.assert('E2 占位符不算泄漏：<name> / %USERNAME% / $USER / {user} / username / 用户名', (() => {
        const cases = ['C:\\Users\\<name>\\x', 'C:\\Users\\%USERNAME%\\x', '/home/$USER/x', '/home/{user}/x', '/home/username/x', '/home/用户名/x'];
        return cases.every((c) => scanText(c).length === 0);
    })(), ['C:\\Users\\<name>\\x', '/home/%USERNAME%/x', '/home/username/x'].map((c) => scanText(c)));

    R.assert('E3 真用户名命中 user-profile-path（机器无关判据）',
        scanText('p = C:\\Users\\alice\\secret')[0].rule === 'user-profile-path');

    R.assert('E4 主机名判据：≥5 字符才判，且只判当前机器名', (() => {
        const hit = scanText('host TESTHOST-01 here', { machineHost: 'TESTHOST-01' });
        const short = scanText('host abcd here', { machineHost: 'abcd' });
        const other = scanText('host OTHERHOST here', { machineHost: 'TESTHOST-01' });
        return hit.length === 1 && hit[0].rule === 'hostname' && short.length === 0 && other.length === 0;
    })());

    R.assert('E5 maskSecret：只留首字符（门禁自身不成为泄漏渠道）',
        maskSecret('alice') === 'a****' && maskSecret('u') === '*', [maskSecret('alice'), maskSecret('u')]);

    R.assert('E6 looksBinary：含 NUL 判为二进制', looksBinary(Buffer.from([1, 0, 2])) === true && looksBinary(Buffer.from('plain')) === false);

    R.assert('E7 isAllowedLine：已公开路径与合成样本按行豁免，真路径不豁免',
        isAllowedLine('见 `' + ALLOW_SUBSTRINGS[0] + '`') === true
        && isAllowedLine('at ' + ALLOW_SYNTHETIC[0] + 'tests/a.js') === true
        && isAllowedLine('C:\\Users\\alice\\x') === false);

    R.assert('E8 scanRepo：干净树 0 命中；埋一处真泄漏即命中（两向断言）', (() => {
        const clean = scanRepo(DEV, { machineHost: 'NOHOSTNAME' });
        const repo = join(TMP, 'leaky');
        wf(join(repo, 'bad.js'), 'const p = "C:\\Users\\realuser\\proj";\n');
        const dirty = scanRepo(repo, { machineHost: 'NOHOSTNAME' });
        return clean.issues.length === 0 && dirty.issues.length === 1
            && dirty.issues[0].file === 'bad.js' && dirty.issues[0].rule === 'user-profile-path';
    })());

    R.assert('E9 scanRepo：跳过 node_modules / out / .git（本地路径可合法存在于这些位置）', (() => {
        const repo = join(TMP, 'skipcheck');
        wf(join(repo, 'ok.js'), 'no path here');
        wf(join(repo, 'node_modules', 'p.js'), 'C:\\Users\\alice\\n');
        wf(join(repo, 'out', 'r.json'), 'C:\\Users\\alice\\o');
        wf(join(repo, '.git', 'h'), 'C:\\Users\\alice\\g');
        const r = scanRepo(repo, { machineHost: 'NOHOSTNAME' });
        return r.issues.length === 0 && r.scanned === 1;
    })(), scanRepo(join(TMP, 'skipcheck'), { machineHost: 'NOHOSTNAME' }));

    R.assert('E10 repo-abs-path：仓库自身检出路径出现即命中；大小写不敏感；别处路径不命中', (() => {
        const root = '/opt/repo-under-test';
        const hit = scanText('见 ' + root + '/docs/a.md', { repoRoot: root });
        const other = scanText('见 /elsewhere/docs/a.md', { repoRoot: root });
        const win = scanText('见 D:\\REPO\\a.md', { repoRoot: 'd:\\repo' });
        return hit.length === 1 && hit[0].rule === 'repo-abs-path'
            && other.length === 0 && win.length === 1;
    })(), scanText('/opt/repo-under-test/docs/a.md', { repoRoot: '/opt/repo-under-test' }));

    R.assert('E11 scanRepo：把「仓库自身路径写进文件」判为违规（本条规则由真实漏检驱动）', (() => {
        const repo = join(TMP, 'selfpath');
        wf(join(repo, 'leaked.md'), '本机检出在 ' + repo + ' 下\n');
        const r = scanRepo(repo, { machineHost: 'NOHOSTNAME' });
        return r.issues.length === 1 && r.issues[0].rule === 'repo-abs-path' && r.issues[0].file === 'leaked.md';
    })());

} finally {
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

R.done();
