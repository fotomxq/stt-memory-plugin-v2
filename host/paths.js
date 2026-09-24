// ============================================================
// host/paths.js —— 扩展目录名解析（安装位置无关）
// 背景（归档级终检发现的真实问题）：`renderExtensionTemplateAsync(ext, file, data)` 与
//   `/api/extensions/{version,update}` 的 `extensionName` 都必须传**实际安装目录**。
//   若写死 `third-party/ftt-memory-v2`，用户把目录改名（或 ST 用不同目录名安装）就会：
//   ① 设置面板模板渲染失败（回退 HTML）；② 更新检查/更新端点指向不存在的扩展名（静默失效）。
// 做法：优先从本模块自身的 `import.meta.url` 反推目录（`…/extensions/<name>/host/paths.js`）；
//   推导不出（Node 测试、打包环境）时回退常量；并把「来源」暴露出来便于诊断。
// ============================================================
import { EXTENSION_FOLDER } from '../core/constants.js';

/**
 * 从任意模块 URL 推导扩展目录名（纯函数，便于测试）。
 *   `http://host/scripts/extensions/third-party/foo/host/paths.js` → `third-party/foo`
 *   `…/scripts/extensions/foo/index.js` → `foo`
 * 推导不出返回 ''。
 */
const TOP_DIRS = ['host', 'core', 'ui', 'adapters', 'tests', 'i18n', 'docs', 'scripts'];

export function folderFromUrl(url) {
    try {
        const s = String(url || '');
        if (!s) return '';
        // 取 `/extensions/` 之后到文件名之前的全部目录段
        const m = s.match(/\/extensions\/(.+)$/);
        if (!m || !m[1]) return '';
        const segs = m[1].split('/').filter(Boolean);
        segs.pop();                                   // 去掉文件名
        if (!segs.length) return '';
        // 从右往左找**本扩展的已知顶层目录**（host/core/ui/adapters/tests/i18n/docs/scripts），
        // 其左侧即扩展目录（`third-party/foo/host/paths.js` → `third-party/foo`）
        for (let i = segs.length - 1; i >= 0; i--) {
            if (TOP_DIRS.indexOf(segs[i]) >= 0) return segs.slice(0, i).join('/') || segs.join('/');
        }
        return segs.join('/');
    } catch (e) { return ''; }
}

/** 本模块 URL（可能为空字符串，视打包/运行环境） */
function selfUrl() {
    try { return (typeof import.meta !== 'undefined' && import.meta && import.meta.url) ? String(import.meta.url) : ''; } catch (e) { return ''; }
}

const derived = folderFromUrl(selfUrl());
const cache = { folder: derived || String(EXTENSION_FOLDER || ''), source: derived ? 'runtime' : 'constant' };

/** 生效的扩展目录名（运行时优先，回退常量） */
export function extensionFolder() { return cache.folder; }
/** 目录名来源：runtime（从模块 URL 推导）/ constant（回退常量） */
export function folderSource() { return cache.source; }
/** 诊断：常量、推导值、生效值 */
export function folderInfo() {
    return { constant: String(EXTENSION_FOLDER || ''), derived, folder: cache.folder, source: cache.source };
}
