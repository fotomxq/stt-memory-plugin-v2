// ============================================================
// ui/debug.js —— **调试页（日志查看器 + 清空）**（B9-a）
//
// V1 出处（`src/FTT记忆组件-v1.206.js`）：
//   · 内核日志：`DBG_KEY/DEBUG_CAP/dbgLog/dbgGet/dbgClear/dbgPersist`（约 545~613，v1.49 口径）
//   · 查看器：`debugHtml()`（约 24657~24712，类别标签/配色 + 摘要 + 逐条 `<details>`）
//   · 设定页：`activeSettingsSub === 'debug'` 分支（约 25946~25954：开关 + 说明 + 日志区）
//   · 动作：`case 'dbgClear'`（约 27245：`dbgClear(); renderPanel(); toast('已清空调试日志','info')`）
//
// V2 适配（逐条）：
//   ① 内核数据源：V1 直读全局 `debugLogs`（`dbgGet()`）；V2 读 `adapters/debug-log.js#debugLogList`
//      （内核环形缓冲 `core/debug-log.js` + localStorage 接线），UI 不碰持久层；
//   ② `formatBytes` V1 是模块内私有函数（未导出），此处**按 V1 逐字复制**（与 `ui/sync.js#fmtBytes` 同实现）；
//   ③ V1 的 `toast(...)` 在 V2 统一写面板 note（读 `r.state.note`）；`renderPanel()` 由 `ui/panel.js` 收尾统一重绘；
//   ④ V1 把「最多 300 条」硬编码在文案里；V2 用内核常量 `DEBUG_CAP`（值同为 300）。
// ============================================================
import { escHtml } from '../core/util.js';
import { DEBUG_CAP } from '../core/debug-log.js';
import { debugLogList, debugLogClear } from '../adapters/debug-log.js';
import { settingsControlHtml } from './settings-pages.js';

const esc = (v) => escHtml(v == null ? '' : v);

/** V1 `formatBytes()`（约 325，逐字复制：B / KB / MB 三档） */
function formatBytes(n) {
    try {
        const b = Number(n) || 0;
        if (b >= 1048576) return `${(b / 1048576).toFixed(2)} MB`;
        if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
        return `${b} B`;
    } catch (e) { return '0 B'; }
}

/** V1 `debugHtml()` 内的类别标签映射（逐字） */
export const DEBUG_KIND_LABEL = Object.freeze({
    '摘要': '🧠 分析记忆', '发送记忆': '📤 提取记忆', '关键词': '🔑 关键词提取', '向量': '🔗 向量检索',
    '请求': '🌐 API 请求', '修复': '🛠 质检修复', '投喂': '📥 投喂文本', '对账': '🔄 存储对账',
});
/** V1 `debugHtml()` 内的类别配色（逐字） */
export const DEBUG_KIND_COLOR = Object.freeze({
    '关键词': '#7db0e8', '向量': '#8ad08a', '发送记忆': '#e0b06a', '请求': '#c98ad0',
    '摘要': '#f0c060', '修复': '#f0c060', '投喂': '#8aa7c8', '对账': '#8ad08a',
});

/** V1 `debugHtml()` 内的单条摘要（逐字：从 `data` JSON 里挑关键字段拼一行） */
function debugSummary(l) {
    try {
        const d = JSON.parse(l.data);
        if (typeof d === 'object' && d !== null) {
            const parts = [];
            if (d.label) parts.push(d.label);
            if (d.stage) parts.push(d.stage);
            if (d.action) parts.push(d.action);
            if (d.source) parts.push(d.source);
            if (d.error !== undefined) parts.push(`❌${String(d.error).slice(0, 40)}`);
            if (d.status !== undefined) parts.push(`HTTP${d.status}`);
            if (d.chars !== undefined) parts.push(`${d.chars}字`);
            if (d.count !== undefined) parts.push(`×${d.count}`);
            if (d.floors !== undefined) parts.push(`${d.floors}楼`);
            if (d.topN !== undefined) parts.push(`Top${d.topN}`);
            if (d.ms !== undefined) parts.push(`${d.ms}ms`);
            if (parts.length) return parts.join(' · ');
        }
    } catch (e) { /* 非 JSON 文本 → 无摘要（V1 原样） */ }
    return '';
}

/**
 * 日志列表 HTML（V1 `debugHtml()` 逐字结构：操作行 + 类别统计行 + 逐条 `<details class="ftt-dbg-item">`）
 * @returns {string}
 */
export function debugLogHtml() {
    const logs = debugLogList();
    if (!logs.length) return '<div class="ftt-empty">暂无日志。运行「AI 摘要」或「自动修复」后在此显示。</div>';
    // 日志统计（各 kind 计数；顺序 = 首次出现顺序，V1 原样）
    const statCount = {};
    for (const l of logs) statCount[l.kind] = (statCount[l.kind] || 0) + 1;
    const statHtml = Object.keys(statCount).map((k) => '<span class="ftt-stat">' + esc(DEBUG_KIND_LABEL[k] || k) + ' ' + statCount[k] + '</span>').join('');
    // 每条日志大小 + 总占用
    let totalBytes = 0;
    for (const l of logs) { try { totalBytes += (l.data || '').length; } catch (e) { /* 忽略 */ } }
    const sizeNote = ' · 总占用 ' + formatBytes(totalBytes);
    return '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="dbgClear">🗑 清空日志</button><span class="ftt-muted">共 ' + logs.length + ' 条' + sizeNote + '（最多 ' + DEBUG_CAP + ' 条，最新在上；点击展开详情）</span></div><div class="ftt-row">' + statHtml + '</div>' + logs.map((l) => {
        // 日期+时间（不只记录时间；V1 用 toLocaleString('zh-CN', { hour12: false })）
        const t = new Date(l.at).toLocaleString('zh-CN', { hour12: false });
        const color = DEBUG_KIND_COLOR[l.kind] || '#b8b3ac';
        const label = DEBUG_KIND_LABEL[l.kind] || l.kind;
        const size = formatBytes((l.data || '').length);
        let data = l.data;
        try { data = JSON.stringify(JSON.parse(l.data), null, 1); } catch (e) { /* 原样展示 */ }
        const sum = debugSummary(l);
        return '<details class="ftt-dbg-item"><summary class="ftt-dbg-head"><span class="ftt-dbg-kind" style="color:' + esc(color) + '">' + esc(label) + '</span><span class="ftt-dbg-time">' + esc(t) + '</span><span class="ftt-dbg-size">' + esc(size) + '</span>' + (sum ? '<span class="ftt-dbg-sum">' + esc(sum) + '</span>' : '') + '</summary><div class="ftt-dbg-data">' + esc(data) + '</div></details>';
    }).join('\n');
}

/**
 * 调试页正文（V1 `activeSettingsSub === 'debug'` 分支逐字两节）。
 * @param {Array} controls `SETTINGS_CONTROLS.debug`（本页唯一控件 `debugEnabled`）
 */
export function debugPageHtml(controls) {
    const list = Array.isArray(controls) ? controls : [];
    const sw = list.filter((c) => String(c.key) === 'debugEnabled').map((c) => settingsControlHtml(c)).join('\n');
    return [
        '<div class="ftt-section"><div class="ftt-sec-title">调试日志</div>',
        sw,
        '<div class="ftt-muted">关闭后不再记录新日志；已存日志仍可查看。</div>',
        '</div>',
        '<div class="ftt-section"><div class="ftt-sec-title">调试日志（上一轮请求的关键词 / 向量提取 / 发送记忆 / 请求日志）</div>',
        debugLogHtml(),
        '</div>',
    ].join('\n');
}

/**
 * 调试页动作（V1 同名：`dbgClear`）
 * @returns {{ok:boolean, action:string, note:string, cleared?:number}}
 */
export function debugAction(action, payload) {
    const a = String(action || '');
    try {
        if (a === 'dbgClear') {
            const n = debugLogClear();     // V1 `dbgClear()`：清内存 + 清宿主持久层
            return { ok: true, action: a, note: '已清空调试日志', cleared: n, stats: { n: 0, cap: DEBUG_CAP } };
        }
        return { ok: false, action: a, note: '未知调试动作：' + a };
    } catch (e) {
        return { ok: false, action: a, note: '调试动作失败：' + String((e && e.message) || e) };
    }
}

/** 调试页动作名判定（供面板分发；与 V1 同名逐字一致） */
export const DEBUG_ACTIONS = Object.freeze(['dbgClear']);

/** 调试页只读诊断（测试/排障用） */
export function debugPageInfo() {
    let logs = [];
    try { logs = debugLogList(); } catch (e) { logs = []; }
    const kinds = {};
    logs.forEach((l) => { const k = String((l && l.kind) || ''); kinds[k] = (kinds[k] || 0) + 1; });
    return { n: logs.length, cap: DEBUG_CAP, kinds: kinds, bytes: logs.reduce((a, l) => a + String((l && l.data) || '').length, 0) };
}
