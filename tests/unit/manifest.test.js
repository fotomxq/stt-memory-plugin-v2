// ============================================================
// 单元测试 · 扩展清单与装配一致性（manifest ↔ 入口导出 ↔ 版本三处一致）
// ============================================================
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../harness/st-mock.js';
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
R.assert('M4 auto_update=true（第三方扩展随 ST 包版本自动更新；docs/P0 已核对源码）', manifest.auto_update === true, manifest.auto_update);
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
R.assert('M9 扩展目录名与仓库目录一致（renderExtensionTemplateAsync 依赖）', (() => {
    const folder = String(EXTENSION_FOLDER).split('/').pop();
    return folder === basename(ROOT) && EXTENSION_FOLDER.indexOf('third-party/') === 0;
})(), [EXTENSION_FOLDER, basename(ROOT)]);
R.assert('M10 模块名唯一且为 extensionSettings 键', MODULE_NAME === 'ftt_memory_v2', MODULE_NAME);
R.assert('M11 入口导出装配面（init/teardown/runtimeState/状态摘要）', ['init', 'teardown', 'runtimeState', 'extraForStatus'].every(k => typeof entry[k] === 'function'), '');
R.assert('M12 未接宿主时导入不产生副作用（runtimeState.ready=false）', entry.runtimeState().ready === false, entry.runtimeState());

R.done();
