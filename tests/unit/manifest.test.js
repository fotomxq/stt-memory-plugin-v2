// ============================================================
// 单元测试 · 扩展清单与装配一致性（manifest ↔ 入口导出 ↔ 版本三处一致）
// ============================================================
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
import { folderFromUrl, folderInfo } from '../../host/paths.js';
import { panelFolderInfo } from '../../ui/settings-panel.js';
import * as entry from '../../index.js';
import { VERSION, DATA_VERSION, EXTENSION_FOLDER, MODULE_NAME } from '../../core/constants.js';

const R = makeReporter('manifest 清单与装配一致性');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));

R.assert('M1 manifest 必填字段齐全', !!(manifest.display_name && manifest.js && manifest.css && manifest.author && manifest.version && manifest.homePage && manifest.minimum_client_version), Object.keys(manifest));
R.assert('M2 js/css 文件存在', existsSync(join(ROOT, manifest.js)) && existsSync(join(ROOT, manifest.css)), [manifest.js, manifest.css]);
R.assert('M3 i18n 词条文件存在（zh-cn + en）', (() => {
    const langs = Object.keys(manifest.i18n || {});
    return langs.length >= 2 && langs.every(l => existsSync(join(ROOT, manifest.i18n[l])));
})(), manifest.i18n);
// M4 修复（v2.11.1）：auto_update=true 会让**酒馆自身**在加载期对第三方扩展做 git 版本校验
//   （POST /api/extensions/version → 后端 git handshake）；无 git 能力的宿主（TauriTavern 原生移植）
//   会因此弹出「后端错误：Failed to get extension version: Git handshake failed」。故置 false，
//   改由本插件自己的 HTTP 更新检查（GitHub raw 清单）承担；需要宿主代做 git 更新时用设置开关显式开启。
R.assert('M4 auto_update=false（避免宿主加载期 git 校验弹「后端错误」；更新检查走本插件 HTTP 通道）', manifest.auto_update === false, manifest.auto_update);
R.assert('M5 generate_interceptor 指向全局函数且模块加载后已挂载', (() => {
    const nm = manifest.generate_interceptor;
    return !!nm && typeof globalThis[nm] === 'function';
})(), [manifest.generate_interceptor, typeof globalThis[manifest.generate_interceptor]]);
R.assert('M6 hooks 全部对应入口具名导出函数', (() => {
    const hooks = manifest.hooks || {};
    const names = Object.keys(hooks);
    return names.length >= 7 && names.every(k => typeof entry[hooks[k]] === 'function');
})(), Object.entries(manifest.hooks || {}).map(([k, v]) => k + ':' + typeof entry[v]));
R.assert('M7 版本四处一致（manifest / package / constants / 入口导出）',
    manifest.version === pkg.version && manifest.version === VERSION && entry.__internals.VERSION === VERSION, [manifest.version, pkg.version, VERSION]);
R.assert('M8 数据版本为独立整数（与代码版本解耦）', Number.isInteger(DATA_VERSION) && DATA_VERSION >= 1, DATA_VERSION);
R.assert('M9 扩展目录名解析（安装位置无关）：常量约定 third-party/* + URL 推导 + 面板与更新共用解析值', (() => {
    const info = folderInfo();
    const panel = panelFolderInfo();
    const dirName = basename(ROOT);
    // ① 常量是仓库约定（发行目录命名口径），不以「当前检出目录名」为条件
    const conventionOk = EXTENSION_FOLDER.indexOf('third-party/') === 0 && String(EXTENSION_FOLDER).split('/').pop().length > 3;
    // ② 推导函数对 ST 真实加载形态成立：无论扩展目录叫什么，都能反推出正确目录名
    const a = folderFromUrl('http://127.0.0.1:8000/scripts/extensions/third-party/' + dirName + '/host/paths.js');
    const b = folderFromUrl('https://x/scripts/extensions/renamed-ext/ui/console.js');
    const c = folderFromUrl('https://x/scripts/extensions/single/index.js');
    const d = folderFromUrl('/not/an/extension/path.js');
    // ③ 面板与更新使用同一个解析值（改名安装时两者同步生效）
    return conventionOk && a === 'third-party/' + dirName && b === 'renamed-ext'
        && c === 'single' && d === '' && !!info.folder && panel.folder === info.folder
        && (info.source === 'runtime' || info.folder === EXTENSION_FOLDER);
})(), (() => { const i = folderInfo(); return [i.constant, i.derived, i.folder, i.source, basename(ROOT)]; })());
R.assert('M10 模块名唯一且为 extensionSettings 键', MODULE_NAME === 'ftt_memory_v2', MODULE_NAME);
R.assert('M11 入口导出装配面（init/teardown/runtimeState/状态摘要）', ['init', 'teardown', 'runtimeState', 'extraForStatus'].every(k => typeof entry[k] === 'function'), '');
R.assert('M12 许可一致：LICENSE 为 AGPL-3.0 官方文本且 package.json 声明一致', (() => {
    if (!existsSync(join(ROOT, 'LICENSE'))) return false;
    const lic = read('LICENSE');
    return /GNU AFFERO GENERAL PUBLIC LICENSE/.test(lic) && /Version 3, 19 November 2007/.test(lic)
        && /How to Apply These Terms/.test(lic) && pkg.license === 'AGPL-3.0' && lic.length > 30000;
})(), pkg.license);
R.assert('M13 未接宿主时导入不产生副作用（runtimeState.ready=false）', entry.runtimeState().ready === false, entry.runtimeState());

R.done();
