// ============================================================
// ui/currency-pick.js —— 货币页「👥 指定跟踪角色」**选择器面板**
//   （v3.47.0 由 `ui/panel.js` 内外移；功能与文案**逐字不变**，只把页面搜索词改为**入参**）
//
// 为什么外移：`ui/panel.js` 受 `docs/D22` W5 `技-14` **单体文件体量棘轮**约束（基线 + 40 行宽限），
//   v3.47.0 加「📜 批量完善履历」接线后**恰好贴到上限（余量 0）** —— 按仓内既有做法（v3.46.4 把
//   `resumeRepairAction` 外移腾出体量），把这块自成一体的选择器面板搬出来，**不上调基线**。
//
// 口径（与搬家前逐字一致）：
//   · 名单来源 = 「角色」大类（`knownCharacterNames()`）；已标定的排前显示徽标；
//   · 搜索词走 V1 同源的**页面搜索词槽**（`ps.q['currencyTrackPick']`）—— 现由调用方作为入参传入；
//   · 动作：`curTrackToggle`（勾选 / 取消标定）与 `curTrackClose`（关闭），仍由 `ui/panel.js` 的动作分发处理。
// ============================================================
import { trackPickState, trackedCurrencyRoles, knownCharacterNames } from '../core/model/money.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = esc;

/**
 * 「👥 指定跟踪角色」选择器面板（打开时才有内容）。
 * @param {string} query 当前搜索词（来自页面搜索词槽 `ps.q.currencyTrackPick`）
 */
export function currencyPickPanelHtml(query) {
    if (!trackPickState()) return '';
    const q0 = String(query == null ? '' : query);
    const names = (() => { try { return knownCharacterNames(); } catch (e) { return []; } })();
    const tracked = (() => { try { return trackedCurrencyRoles(); } catch (e) { return []; } })();
    const key = (nm) => String(nm).replace(/\s+/g, '').toLowerCase();
    const isOn = (nm) => tracked.some((t) => key(t) === key(nm));
    const q = q0.trim().toLowerCase();
    const shown = q ? names.filter((nm) => String(nm).toLowerCase().indexOf(q) >= 0) : names;
    let body;
    if (!names.length) body = '<div class="ftt-empty">「角色」大类暂无已知角色：先运行「AI 摘要」生成角色档案，或在角色页添加角色。</div>';
    else if (!shown.length) body = '<div class="ftt-empty">无匹配角色（搜索：' + esc(q0) + '）</div>';
    else {
        body = shown.map((nm) => {
            const on = isOn(nm);
            return '<div class="ftt-item" data-ftt-curpick-name="' + attr(nm) + '"><div class="ftt-item-main"><b>' + esc(nm) + '</b>'
                + (on ? ' <span class="ftt-badge ftt-badge--fact">已标定</span>' : '') + '</div>'
                + '<div class="ftt-item-ops"><button class="ftt-op' + (on ? ' ftt-ok' : '') + '" data-ftt-action="curTrackToggle" data-name="' + attr(nm) + '" title="' + (on ? '取消标定' : '标定为跟踪对象') + '">' + (on ? '✅' : '➕') + '</button></div></div>';
        }).join('\n');
    }
    return '<div class="ftt-editor"><div class="ftt-editor-title">👥 指定跟踪角色 · 从「角色」大类选择（已标定 ' + tracked.length + ' 名）</div>'
        + '<div class="ftt-muted ftt-w-full">被标定的角色：后续<b>分析记忆</b>会恒定把他们的货币纳入考虑（追加「货币 · 标定跟踪」提示词 + 投喂当前货币账本作为更新参照），<b>注入</b>时与主角一样恒定列出（行尾标 ⭐已标定）。</div>'
        + '<input class="ftt-input" type="text" data-ftt-search="currencyTrackPick" value="' + attr(q0) + '" placeholder="搜索角色名…">'
        + '<div class="ftt-hint">角色档案 ' + names.length + ' 名 · 显示 ' + shown.length + ' 名</div>'
        + '<div data-ftt-cur-list="currencyTrackPick">' + body + '</div>'
        + '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="curTrackClose">关闭</button></div></div>';
}
