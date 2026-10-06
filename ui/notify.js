// ============================================================
// ui/notify.js —— **统一用户通知出口**（v3.24.0，UI 层；纯函数为主，可单测）
//
// 用户要求（原话）：「新版本 进一步优化UI设计、优化通知效果等。」
//
// 改动前的实测缺陷（逐条核对过代码）：
//   ① `style.css` 早就写好 8 类**行为配色**（`#toast-container .ftt-toastr--info / --analysis / --success /
//      --warning / --error / --sync / --weave / --repair`，左侧色条），但**没有任何 JS 添加过这些类**
//      → 所有通知长得一模一样，「推演世界 / 同步 / 修复」的识别色从未生效（死 CSS）。
//   ② 注入点只按 4 种宿主类型分流（`info / success / warning / error`），`'weave'`（推演世界实际在传）
//      落到 `toastr.info` —— 语义更细的 kind 被抹平。
//   ③ 调用 toastr 时**不传任何选项**，于是：`escapeHtml` 默认 false（正文里的 `<...>` 会被当 HTML 渲染）、
//      无 `preventDuplicates`（同文案连发刷屏）、无长度上限（超长文案撑爆通知）、
//      错误与普通提示**停留时间一样**（用户来不及看清失败原因）。
//
// 本模块的口径（**唯一出口**：`adapters`→`index.js#setNotifyHooks` 只有这一处落地，
// 面板 `hooks.notify` 与删楼 `floorTrim.notify` 也最终走 `notifyHooks.toast`）：
//   · **kind 归一**：`warn/err/fail/ok` 等别名、以及中文（`推演/同步/修复/分析`）统一到 8 类规范 kind；
//   · **配色落地**：把 `ftt-toastr ftt-toastr--<kind>` 通过 toastr 的 `toastClass` 选项挂到通知元素上；
//   · **安全与秩序**：`escapeHtml: true`（正文不当 HTML 渲染）、`preventDuplicates: true`（同文案不叠加）、
//     文案截断到 `NOTIFY_TEXT_MAX` 字符并把连续空白压成单空格；
//   · **分级停留**：错误最久（10s）→ 警告（7s）→ 普通（4.5s）；关闭按钮与进度条统一打开
//     （进度条颜色按 kind 由 CSS 着色）。
//   · **不改宿主布局**：不传 `positionClass`（跟随酒馆自身的通知位置设定）。
// ============================================================

/** 规范 kind（与 `style.css` 的 `--ftt-toastr--*` 一一对应；顺序即优先级展示顺序） */
export const NOTIFY_KINDS = Object.freeze(['info', 'analysis', 'success', 'warning', 'error', 'sync', 'weave', 'repair']);

/** 别名 → 规范 kind（英文近义写法 + 中文类别词；未知一律 info） */
const KIND_ALIAS = {
    warn: 'warning', warning: 'warning', caution: 'warning',
    err: 'error', error: 'error', fail: 'error', failed: 'error', fatal: 'error',
    ok: 'success', success: 'success', done: 'success', pass: 'success',
    debug: 'info', log: 'info', info: 'info', notice: 'info', note: 'info',
    analysis: 'analysis', analyze: 'analysis', summarize: 'analysis',
    sync: 'sync', storage: 'sync', mirror: 'sync',
    weave: 'weave', parallel: 'weave',
    repair: 'repair', fix: 'repair',
    分析: 'analysis', 摘要: 'analysis', 同步: 'sync', 推演: 'weave', 修复: 'repair',
    提示: 'info', 成功: 'success', 警告: 'warning', 错误: 'error',
};

/** 规范 kind 对应的宿主 toastr 方法名（细粒度 kind 只体现在**配色类**上，不改语义色） */
const KIND_METHOD = {
    info: 'info', analysis: 'info', sync: 'info', weave: 'info',
    success: 'success', warning: 'warning', repair: 'warning', error: 'error',
};

/** 单个通知的文案上限（字符；超出截断并加省略号 —— 通知不是日志，超长文案只会撑爆界面） */
export const NOTIFY_TEXT_MAX = 300;
/** 通知标题（留空 = 不显示标题行，与改动前视觉一致） */
export const NOTIFY_TITLE = '';

/** kind 归一（非字符串/未知 → `'info'`） */
export function normalizeNotifyKind(kind) {
    const k = String(kind == null ? '' : kind).trim().toLowerCase();
    if (!k) return 'info';
    if (NOTIFY_KINDS.indexOf(k) >= 0) return k;
    return KIND_ALIAS[k] || 'info';
}
/** 行为配色类（`style.css` 的 `#toast-container .ftt-toastr*` 规则据此生效） */
export function notifyClassOf(kind) {
    return 'ftt-toastr ftt-toastr--' + normalizeNotifyKind(kind);
}
/** 宿主 toastr 方法名（`success` 缺失时回落 `info`，与改动前一致） */
export function notifyMethodOf(kind) {
    return KIND_METHOD[normalizeNotifyKind(kind)] || 'info';
}
/** 按级别的停留时长（毫秒）：错误 10s / 警告 7s（含修复类）/ 其余 4.5s */
export function notifyTimeoutOf(kind) {
    const k = normalizeNotifyKind(kind);
    if (k === 'error') return 10000;
    if (k === 'warning' || k === 'repair') return 7000;
    return 4500;
}
/** 通知文案归一：压空白 + 折叠换行 + 截断（空文案 → `''`，调用方应跳过） */
export function notifyTextOf(text) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > NOTIFY_TEXT_MAX ? (s.slice(0, NOTIFY_TEXT_MAX - 1) + '…') : s;
}
/**
 * toastr 选项（每次调用都带上）：
 *   · `escapeHtml`：正文不当 HTML 渲染（记忆正文/条目标题可能含 `<`）；
 *   · `preventDuplicates`：同文案不叠加（连环报错不再刷屏）；
 *   · `closeButton` / `progressBar`：可手动关、剩余时间可见；
 *   · `toastClass`：挂上行为配色类（**改动前从未挂过**）；
 *   · `onShown`：兜底 —— 宿主 toastr 若忽略 `toastClass`，在显示回调里再补一次类。
 * 不传 `positionClass`（跟随酒馆自身的通知位置设定）。
 */
export function notifyOptionsOf(kind) {
    const k = normalizeNotifyKind(kind);
    const cls = notifyClassOf(k);
    const timeOut = notifyTimeoutOf(k);
    return {
        escapeHtml: true,
        preventDuplicates: true,
        closeButton: true,
        progressBar: true,
        newestOnTop: true,
        timeOut: timeOut,
        extendedTimeOut: Math.round(timeOut / 2),
        toastClass: 'toast ' + cls,
        onShown: function () { applyToastClass(this, cls); },
    };
}

/**
 * 给通知元素补上行为配色类（兼容 DOM 元素与 jQuery 对象；拿不到元素时静默）。
 * @param {*} el 通知元素（`classList` 或 jQuery `addClass`）
 * @param {string} cls 类名字符串（空格分隔）
 * @returns {boolean} 是否确实写入
 */
export function applyToastClass(el, cls) {
    try {
        const list = String(cls || '').split(/\s+/).filter(Boolean);
        if (!el || !list.length) return false;
        if (el.classList && typeof el.classList.add === 'function') { list.forEach((c) => el.classList.add(c)); return true; }
        if (typeof el.addClass === 'function') { el.addClass(list.join(' ')); return true; }
    } catch (e) { /* 忽略 */ }
    return false;
}

/**
 * **统一通知出口**：把一次 (`kind`, `text`) 交给宿主的 toastr。
 *   · `t` 缺失 / 无对应方法 / 文案为空 → 静默返回 `false`（调用方无需判空）；
 *   · 任何异常都不抛出（通知失败绝不影响主流程）。
 * @param {*} t 宿主 `toastr`（或同形对象；测试可注入假实现）
 * @param {string} kind 行为类别（见 `NOTIFY_KINDS`）
 * @param {string} text 文案
 * @param {object} [extra] 覆盖/追加的 toastr 选项（诊断与特殊场景用）
 * @returns {boolean} 是否发出
 */
export function showToast(t, kind, text, extra) {
    try {
        if (!t) return false;
        const body = notifyTextOf(text);
        if (!body) return false;
        const opts = Object.assign({}, notifyOptionsOf(kind), extra || {});
        const name = notifyMethodOf(kind);
        const fn = (typeof t[name] === 'function') ? t[name] : (typeof t.info === 'function' ? t.info : null);
        if (!fn) return false;
        fn.call(t, body, NOTIFY_TITLE, opts);
        return true;
    } catch (e) { return false; }
}
