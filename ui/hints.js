// ============================================================
// ui/hints.js —— **提示信息组件**（v2.57.0）
//
// 用户要求：「（设定页）避免罗嗦的提示信息，展示内容必须言简意赅，让用户能一目了然；
//   其次扩展提示信息，应通过 **UI 交互或其他方式**展示，避免挤占 UI。」
//
// 做法：
//   ① 页面上只留**一句话**（≤ 40 字）说明「这是什么 / 会怎样」；
//   ② 详细解释与参数含义放进**默认折叠**的 `<details>`（原生交互，触屏也能点开，不占版面）；
//   ③ 单个控件的说明同时作为 `title`（桌面端悬停即见，`settingsControlHtml` 支持 `hint` 字段）。
// ============================================================
import { escHtml } from '../core/util.js';

const esc = (v) => escHtml(v == null ? '' : v);

/**
 * 可折叠说明块（默认收起）。
 * @param {string} summary 折叠标题（如「说明」「参数说明」）
 * @param {string} bodyHtml 内部 HTML（调用方负责转义）
 * @param {{open?:boolean}} [opts]
 * @returns {string} 空 body → 空串（不渲染空块）
 */
export function hintDetailsHtml(summary, bodyHtml, opts) {
    const body = String(bodyHtml == null ? '' : bodyHtml).trim();
    if (!body) return '';
    const o = opts || {};
    return '<details class="ftt-details ftt-hint-details"' + (o.open ? ' open' : '') + '>'
        + '<summary class="ftt-hint">ⓘ ' + esc(summary || '说明') + '</summary>'
        + '<div class="ftt-hint ftt-hint-body">' + body + '</div>'
        + '</details>';
}

/**
 * 由控件表生成「参数含义」清单（只列带 `hint` 的控件：短标签 + 说明）。
 * 单一来源：控件自己的 `hint` 字段——页面上不重复维护一份参数说明。
 * @param {Array} controls
 * @returns {string} 无带 hint 的控件 → 空串
 */
export function paramListHtml(controls) {
    const list = Array.isArray(controls) ? controls : [];
    const rows = list.filter((c) => c && String(c.hint || '').trim()).map((c) => {
        const label = String(c.label || c.key || '');
        return '<div class="ftt-dim-row"><span class="ftt-dim-name">' + esc(label) + '</span>'
            + '<span class="ftt-muted" style="flex:1">' + esc(String(c.hint)) + '</span></div>';
    });
    return rows.join('');
}

/** 一行短提示（页面上唯一的说明行；超出 40 字请改放 `hintDetailsHtml`） */
export function shortHintHtml(text) {
    return '<div class="ftt-muted" data-ftt-short-hint>' + esc(text) + '</div>';
}
