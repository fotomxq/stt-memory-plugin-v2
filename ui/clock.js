// ============================================================
// ui/clock.js —— **剧情时钟界面**（B8-1；结构与文案对齐 V1 `12-UI-编辑与面板.js` 总览时钟区 + `14` 动作）
// 覆盖：总览「📅 日期 / ⏱ 时间 / 📍 地点」（含 🔒 手工徽标、缺值时的「参考最近记忆」行）+
//   「✏️ 手工改写日期/时间/地点」工具行与编辑面板（三项输入，宽松解析）+「🩺 时间巡检」状态行与手动巡检按钮。
// 动作名与 V1 逐字一致：`clockEdit` / `clockEditCancel` / `clockManualSave` / `clockManualClear` / `clockPatrol`。
// ============================================================
import { state, notifyHooks } from '../core/model/runtime.js';
import { clockDateLabel } from '../core/clock.js';
import { storyClockReference } from '../core/clock-extract.js';
import {
    clockManualState, setClockManual, clearClockManual, runClockPatrolRepair, clockPatrolState,
} from '../core/clock-patrol.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = esc;

/** 手工改写面板是否展开（V1 `clockEditing`） */
let clockEditing = false;
export function clockEditingState() { return clockEditing; }
export function setClockEditing(on) { clockEditing = !!on; return clockEditing; }

/** 手工徽标（锁定中） */
function manBadge(cMan, field) {
    return (cMan && cMan[field]) ? ' <span class="ftt-badge ftt-badge--public" title="手工强制改写（锁定中，自动提取不会覆盖）">🔒 手工</span>' : '';
}

/** 时钟来源可解释行（V1 `state.state.clockSrc`） */
function clockSrcHtml() {
    try {
        const cs = state && state.state && state.state.clockSrc;
        if (!cs || !(cs.date || cs.location || cs.present)) return '';
        const L = { regex: '正则（最新正文）', plot: '最新情节', 'atom-latest': '原子数据兜底', prev: '沿用已有值', scene: '最新场景', manual: '手工改写' };
        const fmt = (v) => esc(L[v] || v || '—');
        const RM = { force: '强制降级（设定已开启）', 'anomaly:jump': '日期异常：年份远超当前时钟', 'anomaly:backward': '日期异常：剧情时间大幅倒退', 'anomaly:invalid': '日期异常：格式非法', 'no-date': '正文未识别到日期' };
        const rsn = cs.degradeReason ? (RM[cs.degradeReason] || cs.degradeReason) : '';
        return '<div class="ftt-hint ftt-w-full" data-ftt-clock-src>🕒 时钟来源：日期 ' + fmt(cs.date) + ' · 地点 ' + fmt(cs.location) + ' · 在场 ' + fmt(cs.present)
            + (cs.degraded ? ' · ⚠️ 已降级' + (rsn ? '（' + esc(rsn) + '）' : '') + ' → 采用「最新情节的日期与时间 + 最新的场景」' : '')
            + (cs.jumpYears ? ' · ⚠️ 日期较此前跳变 ' + esc(String(cs.jumpYears)) + ' 年，请确认是否为脏数据' : '') + '</div>';
    } catch (e) { return ''; }
}

/** 时间巡检状态行（V1 `clockPatrolState()`；锚点不可用/只统计时如实说明） */
function patrolRowHtml() {
    try {
        const cp = clockPatrolState();
        const cpAnchor = cp ? (cp.anchor ? esc(cp.anchor) + (cp.anchorSource ? '（' + esc(cp.anchorSource === 'manual' ? '手工改写' : cp.anchorSource === 'clock' ? '当前时钟' : cp.anchorSource === 'plot' ? '最新情节' : '原子多数派') + '）' : '') : '不可用') : '';
        const cpNote = cp ? (cp.blocked === 'no-anchor' || cp.blocked === 'ambiguous-anchor' ? ' · ⚠️ 未修改（请先手工设定剧情日期）'
            : (cp.blocked === 'scan-only' ? ' · 仅统计（未开启自动修复）'
                : (cp.blocked === 'anchor-conflict' ? ' · ⚠️ 未修改（锚点与库内多数年份冲突）' : ''))) : '';
        const cpTxt = cp
            ? '上次巡检：扫描 ' + cp.scanned + ' 条 · 异常 ' + cp.found + ' 条 · 已修复 ' + cp.fixed + ' 条' + (cp.remain ? ' · 保留原值 ' + cp.remain + ' 条' : '') + '（锚点 ' + cpAnchor + cpNote + '）'
            : '尚未巡检（开启「时间巡检」后载入时自动执行）';
        return '<div class="ftt-item ftt-inline"><b class="ftt-pipe-title">🩺 时间巡检</b> <span data-ftt-clock-patrol style="flex:1 1 auto;min-width:0" class="ftt-muted">' + cpTxt + '</span>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="clockPatrol" title="巡检并修复原子数据（情节/记忆/计划/悬念/平行事件）里格式非法或年份漂移的日期与时间（零 AI）">🩺 时间巡检修复</button></div>';
    } catch (e) { return ''; }
}

/** 总览时钟区块（V1 同序：日期 → 时间 → 地点 → 手工工具行/编辑面板 → 在场 → 时钟来源 → 时间巡检） */
export function clockSectionHtml() {
    const lines = [];
    try {
        const c = state && state.state ? state.state : {};
        const ckRef = storyClockReference();
        const cMan = clockManualState();
        const eraTxt = c.era ? '（' + esc(c.era) + '）' : '';
        const seasonTxt = c.season ? '·' + esc(c.season) : '';
        if (c.date) lines.push('<div class="ftt-item">📅 日期：' + esc(clockDateLabel(c.date)) + eraTxt + seasonTxt + manBadge(cMan, 'date') + '</div>');
        else if (ckRef && ckRef.date) lines.push('<div class="ftt-item">📅 日期：<span class="ftt-muted">（参考最近记忆：' + esc(clockDateLabel(ckRef.date)) + '）</span></div>');
        else lines.push('<div class="ftt-item">📅 日期：<span class="ftt-muted">（未记录 · 可用「✏️ 手工改写」设定锚点）</span></div>');
        if (c.time) lines.push('<div class="ftt-item">⏱ 时间：' + esc(c.timeEnd ? c.time + ' → ' + c.timeEnd : c.time) + manBadge(cMan, 'time') + '</div>');
        else if (ckRef && ckRef.time) lines.push('<div class="ftt-item">⏱ 时间：<span class="ftt-muted">（参考最近记忆：' + esc(ckRef.time) + '）</span></div>');
        else lines.push('<div class="ftt-item">⏱ 时间：<span class="ftt-muted">（未记录）</span></div>');
        if (c.location) lines.push('<div class="ftt-item">📍 地点：' + esc(c.location) + manBadge(cMan, 'location') + '</div>');
        else if (ckRef && ckRef.location) lines.push('<div class="ftt-item">📍 地点：<span class="ftt-muted">（参考最近记忆：' + esc(ckRef.location) + '）</span></div>');
        else lines.push('<div class="ftt-item">📍 地点：<span class="ftt-muted">（未记录）</span></div>');
        if (c.storyDay) lines.push('<div class="ftt-item">📆 剧情第 ' + esc(String(c.storyDay)) + ' 天' + (c.sceneDesc ? ' <span class="ftt-muted">（' + esc(c.sceneDesc) + '）</span>' : '') + '</div>');
        // 手工改写工具行 + 编辑面板（三项输入；日期/时间宽松解析，地点自由文本）
        lines.push('<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="clockEdit" title="手工强制改写剧情日期 / 时间 / 地点（锚点错了就在这里改）">✏️ 手工改写日期/时间/地点</button>'
            + (cMan
                ? '<span class="ftt-muted">🔒 已手工锁定' + (cMan.lock ? '' : '（未锁定：仍可被自动提取覆盖）') + '</span><button class="ftt-btn ftt-sm ftt-err" data-ftt-action="clockManualClear" title="解除手工值，恢复自动提取">🔓 解锁并恢复自动</button>'
                : '<span class="ftt-muted">自动提取中（日期/时间/地点来自正文正则 / 最新情节 / 原子兜底）</span>') + '</div>');
        if (clockEditing) {
            lines.push('<div class="ftt-editor"><div class="ftt-editor-title">✏️ 手工强制改写剧情时钟（锚点）</div>'
                + '<div class="ftt-muted ftt-w-full">填入后点「💾 保存并锁定」即强制生效：自动提取不再覆盖这三项，直到点「🔓 解锁并恢复自动」。'
                + '日期支持「公元1919年11月29日」「公元前221年1月2日」「1919-11-29」「-221-01-02」「三月一日」等写法（公元前 = 负年份）；'
                + '时间支持「15:20」「下午三点」「傍晚」等；留空的项目保持原值。</div>'
                + '<div class="ftt-field"><label>日期</label><input type="text" data-ftt-clock-manual="date" value="' + attr(String(c.date || '')) + '" placeholder="如 1919-11-29 / 公元1919年11月29日 / 公元前221年1月2日 / -221-01-02"></div>'
                + '<div class="ftt-field"><label>时间</label><input type="text" data-ftt-clock-manual="time" value="' + attr(String(c.time || '')) + '" placeholder="如 15:20 / 下午三点 / 傍晚"></div>'
                + '<div class="ftt-field"><label>地点</label><input type="text" data-ftt-clock-manual="location" value="' + attr(String(c.location || '')) + '" placeholder="如 城市甲·码头"></div>'
                + '<div class="ftt-row"><button class="ftt-btn ftt-primary" data-ftt-action="clockManualSave">💾 保存并锁定</button><button class="ftt-btn" data-ftt-action="clockEditCancel">取消</button></div></div>');
        }
        const pres = Array.isArray(c.present) ? c.present : null;
        if (pres && pres.length) lines.push('<div class="ftt-item">👥 在场角色：' + esc(pres.slice(0, 12).join('、')) + '</div>');
        else if (pres !== null) lines.push('<div class="ftt-item">👥 在场角色：<span class="ftt-muted">（最近正文/情节未识别到已知角色）</span></div>');
        else lines.push('<div class="ftt-item">👥 在场角色：<span class="ftt-muted">（未识别 · 不限制注入）</span></div>');
        const src = clockSrcHtml();
        if (src) lines.push(src);
        lines.push(patrolRowHtml());
    } catch (e) { /* 忽略 */ }
    return lines.join('\n');
}

/** 手工改写输入读取（面板 DOM；测试可经 payload 传入） */
function readManualInputs(payload) {
    const p = payload || {};
    const out = { date: String(p.date == null ? '' : p.date), time: String(p.time == null ? '' : p.time), location: String(p.location == null ? '' : p.location) };
    if (p.date !== undefined || p.time !== undefined || p.location !== undefined) return out;
    try {
        const doc = globalThis.document;
        if (!doc || typeof doc.querySelector !== 'function') return out;
        const get = (k) => { const el = doc.querySelector('[data-ftt-clock-manual="' + k + '"]'); return el ? String(el.value == null ? '' : el.value) : ''; };
        return { date: get('date'), time: get('time'), location: get('location') };
    } catch (e) { return out; }
}

/** 通知（宿主 toast 钩子） */
function toast(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}

/**
 * 时钟动作（V1 同名动作名）
 * @returns {Promise<{ok:boolean, action:string, note:string, detail?:object}>}
 */
export async function clockAction(action, payload) {
    const a = String(action || '');
    const p = payload || {};
    try {
        if (a === 'clockEdit') { clockEditing = true; return { ok: true, action: a, note: '手工改写面板已展开（填入后「💾 保存并锁定」）', detail: { editing: true } }; }
        if (a === 'clockEditCancel') { clockEditing = false; return { ok: true, action: a, note: '已取消手工改写', detail: { editing: false } }; }
        if (a === 'clockManualSave') {
            const r = setClockManual(readManualInputs(p));
            if (r && r.ok) {
                clockEditing = false;
                toast('success', '已强制改写剧情时钟',
                    '日期 ' + (r.date || '（保持原值）') + ' · 时间 ' + (r.time || '（保持原值）') + ' · 地点 ' + (r.location || '（保持原值）')
                    + (r.lock ? '；已锁定（自动提取不会覆盖）' : '；未锁定（仍可被自动提取覆盖）') + (r.notes.length ? '；' + r.notes.join('；') : ''));
                return { ok: true, action: a, note: '已强制改写：日期 ' + (r.date || '—') + ' · 时间 ' + (r.time || '—') + ' · 地点 ' + (r.location || '—') + (r.lock ? '（已锁定）' : ''), detail: r };
            }
            const note = (r && r.notes || []).join('；') || '三项都为空。';
            toast('warning', '未写入', note);
            return { ok: false, action: a, note, detail: r };
        }
        if (a === 'clockManualClear') {
            const had = clearClockManual();
            clockEditing = false;
            toast('info', had ? '已解除手工锁定，恢复自动提取' : '当前没有手工改写值', '');
            return { ok: true, action: a, note: had ? '已解除手工锁定（恢复自动提取）' : '当前没有手工改写值', detail: { had } };
        }
        if (a === 'clockPatrol') {
            const rep = runClockPatrolRepair({ force: true });
            const src = rep.anchorSource === 'manual' ? '手工改写' : rep.anchorSource === 'clock' ? '当前时钟' : rep.anchorSource === 'plot' ? '最新情节' : rep.anchorSource === 'atoms-majority' ? '原子多数派' : '';
            const note = '巡检 ' + rep.scanned + ' 条（锚点 ' + (rep.anchor || '不可用') + (src ? '（' + src + '）' : '') + '）：异常 ' + rep.found + ' 条 → 修复 ' + rep.fixed + ' 条'
                + (rep.remain ? ' · 保留原值 ' + rep.remain + ' 条' : '') + (rep.blocked ? ' · ' + rep.blocked : '') + (rep.snap ? '（已留快照）' : '');
            return { ok: true, action: a, note, detail: rep };
        }
        return { ok: false, action: a, note: '未知时钟动作：' + a };
    } catch (e) {
        const note = String((e && e.message) || e).slice(0, 160);
        toast('error', '时钟动作失败', note);
        return { ok: false, action: a, note, error: note };
    }
}

/** 时钟动作名（供面板分发；与 V1 逐字一致） */
export const CLOCK_ACTIONS = Object.freeze(['clockEdit', 'clockEditCancel', 'clockManualSave', 'clockManualClear', 'clockPatrol']);

/** 巡检/锚点诊断（FTT.* 与调试用） */
export function clockUiInfo() {
    return { editing: clockEditing, patrol: clockPatrolState(), manual: clockManualState() };
}
