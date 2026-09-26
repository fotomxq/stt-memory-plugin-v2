// ============================================================
// ui/clock.js —— **剧情时钟界面**（B8-1；结构与文案对齐 V1 `12-UI-编辑与面板.js` 总览时钟区 + `14` 动作）
// 覆盖：总览「📅 日期 / ⏱ 时间 / 📍 地点」（含 🔒 手工徽标、缺值时的「参考最近记忆」行）+
//   「✏️ 手工改写日期/时间/地点」工具行与编辑面板（三项输入，宽松解析）；时钟来源行说明「只取最新情节」。
// 动作名：`clockEdit` / `clockEditCancel` / `clockManualSave` / `clockManualClear` / `clockRepair`。
//   v2.51.0：`clockPatrol`（时间巡检修复）按用户决定整段移除。
// ============================================================
import { clockSrcLabel, clockDegradeLabel, clockTraceSummary, clockTraceLast } from '../core/clock-trace.js';   // v2.37.0 取值追踪
import { state, notifyHooks } from '../core/model/runtime.js';
import { clockDateLabel } from '../core/clock.js';
import { storyClockReference } from '../core/clock-extract.js';
import {
    clockManualState, setClockManual, clearClockManual,
} from '../core/clock-patrol.js';
import { runClockRepair } from '../core/clock-ai.js';

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

/** 时钟来源可解释行（v2.51.0：唯一来源 = 最新情节；不再有「降级 / 跳变 / 原子兜底」等废弃说法） */
function clockSrcHtml() {
    try {
        const cs = state && state.state && state.state.clockSrc;
        if (!cs || !(cs.date || cs.location || cs.present)) return '';
        const fmt = (v) => esc(clockSrcLabel(v));
        return '<div class="ftt-hint ftt-w-full" data-ftt-clock-src>🕒 时钟来源：日期 ' + fmt(cs.date) + ' · 时间 ' + fmt(cs.time || cs.date) + ' · 地点 ' + fmt(cs.location) + ' · 在场 ' + fmt(cs.present)
            + '<span class="ftt-muted">（唯一可信来源：最新情节；记忆/角色/计划/悬念/平行等均不参与）</span></div>';
    } catch (e) { return ''; }
}

/** 总览时钟区块（v2.51.0：日期 → 时间 → 地点 → 手工工具行/编辑面板 → 在场 → 时钟来源；巡检修复功能已移除） */
export function clockSectionHtml() {
    const lines = [];
    try {
        const c = state && state.state ? state.state : {};
        const ckRef = storyClockReference();
        const cMan = clockManualState();
        const eraTxt = c.era ? '（' + esc(c.era) + '）' : '';
        const seasonTxt = c.season ? '·' + esc(c.season) : '';
        if (c.date) lines.push('<div class="ftt-item">📅 日期：' + esc(clockDateLabel(c.date)) + eraTxt + seasonTxt + manBadge(cMan, 'date') + '</div>');
        else if (ckRef && ckRef.date) lines.push('<div class="ftt-item">📅 日期：<span class="ftt-muted">（参考最近情节：' + esc(clockDateLabel(ckRef.date)) + '）</span></div>');
        else lines.push('<div class="ftt-item">📅 日期：<span class="ftt-muted">（未记录 · 可用「✏️ 手工改写」设定锚点）</span></div>');
        if (c.time) lines.push('<div class="ftt-item">⏱ 时间：' + esc(c.timeEnd ? c.time + ' → ' + c.timeEnd : c.time) + manBadge(cMan, 'time') + '</div>');
        else if (ckRef && ckRef.time) lines.push('<div class="ftt-item">⏱ 时间：<span class="ftt-muted">（参考最近情节：' + esc(ckRef.time) + '）</span></div>');
        else lines.push('<div class="ftt-item">⏱ 时间：<span class="ftt-muted">（未记录）</span></div>');
        if (c.location) lines.push('<div class="ftt-item">📍 地点：' + esc(c.location) + manBadge(cMan, 'location') + '</div>');
        else if (ckRef && ckRef.location) lines.push('<div class="ftt-item">📍 地点：<span class="ftt-muted">（参考最近情节：' + esc(ckRef.location) + '）</span></div>');
        else lines.push('<div class="ftt-item">📍 地点：<span class="ftt-muted">（未记录）</span></div>');
        // 手工改写工具行 + 编辑面板（三项输入；日期/时间宽松解析，地点自由文本）
        lines.push('<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="clockEdit" title="手工强制改写剧情日期 / 时间 / 地点（锚点错了就在这里改）">✏️ 手工改写日期/时间/地点</button>'
            + (cMan
                ? '<span class="ftt-muted">🔒 已手工锁定' + (cMan.lock ? '' : '（未锁定：仍可被自动提取覆盖）') + '</span><button class="ftt-btn ftt-sm ftt-err" data-ftt-action="clockManualClear" title="解除手工值，恢复自动提取">🔓 解锁并恢复自动同步</button>'
                : '<span class="ftt-muted">自动同步中（日期/时间/地点只取<b>最新情节</b>；其它数据类别与正文解析都不参与）</span>') + '</div>');
        if (clockEditing) {
            lines.push('<div class="ftt-editor"><div class="ftt-editor-title">✏️ 手工强制改写剧情时钟（锚点）</div>'
                + '<div class="ftt-muted ftt-w-full">填入后点「💾 保存并锁定」即强制生效：自动同步不再覆盖这三项，直到点「🔓 解锁并恢复自动」。'
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
        // v2.37.0：最近一次取值的**一行摘要**（值 ← 来源；含落盘改动），详情见 设定→调试「🕒 时钟取值追踪」
        const tr = (() => { try { return clockTraceSummary(clockTraceLast('resolve')); } catch (e) { return ''; } })();
        if (tr) lines.push('<div class="ftt-muted ftt-w-full" data-ftt-clock-trace>' + esc(tr) + ' · 详情：设定→调试「🕒 时钟取值追踪」</div>');
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
        if (a === 'clockRepair') {
            // B8-3：「AI 结合正文修复日期时间」（V1 同名动作；只改日期与时间字段，逐条过安全闸门）
            const r = await runClockRepair({});
            let note;
            if (r.blocked && r.noAnchor) note = '日期时间修复：缺少可信锚点 → 未调用 AI、未改动数据（请先在总览手工设定剧情日期）';
            else if (r.blocked) note = '日期时间修复：任务进行中，请稍候再试';
            else if (r.skipped && r.total === 0) note = '日期时间修复：没有需要修复的日期/时间';
            else if (r.error === 'no-ai') note = '日期时间修复：AI 未返回内容（未改动数据）';
            else if (r.error) note = '日期时间修复失败：' + String(r.error).slice(0, 120);
            else {
                const parts = [];
                if (r.applied) parts.push('修正 ' + r.applied + ' 条');
                if (r.cleared) parts.push('清空 ' + r.cleared + ' 条');
                if (r.skipped) parts.push('丢弃不合格 ' + r.skipped + ' 条');
                if (r.unknown) parts.push('无法判定 ' + r.unknown + ' 条');
                note = '日期时间修复：' + (parts.length ? parts.join(' · ') : 'AI 未给出可用结果') + (r.details && r.details.length ? '；例：' + r.details.slice(0, 3).join('；') : '');
            }
            return { ok: !!(r.applied || r.cleared || (r.made > 0)), action: a, note, detail: r };
        }
        if (a === 'clockRepair') {
            // B8-3：「AI 结合正文修复日期时间」（V1 同名动作；只改日期与时间字段，逐条过安全闸门）
            const r = await runClockRepair({});
            let note;
            if (r.blocked && r.noAnchor) note = '日期时间修复：缺少可信锚点 → 未调用 AI、未改动数据（请先在总览手工设定剧情日期）';
            else if (r.blocked) note = '日期时间修复：任务进行中，请稍候再试';
            else if (r.skipped && r.total === 0) note = '日期时间修复：没有需要修复的日期/时间';
            else if (r.error === 'no-ai') note = '日期时间修复：AI 未返回内容（未改动数据）';
            else if (r.error) note = '日期时间修复失败：' + String(r.error).slice(0, 120);
            else {
                const parts = [];
                if (r.applied) parts.push('修正 ' + r.applied + ' 条');
                if (r.cleared) parts.push('清空 ' + r.cleared + ' 条');
                if (r.skipped) parts.push('丢弃不合格 ' + r.skipped + ' 条');
                if (r.unknown) parts.push('无法判定 ' + r.unknown + ' 条');
                note = '日期时间修复：' + (parts.length ? parts.join(' · ') : 'AI 未给出可用结果') + (r.details && r.details.length ? '；例：' + r.details.slice(0, 3).join('；') : '');
            }
            return { ok: !!(r.applied || r.cleared || (r.made > 0)), action: a, note, detail: r };
        }
        if (a === 'clockRepair') {
            // B8-3：「AI 结合正文修复日期时间」（V1 同名动作；只改日期与时间字段，逐条过安全闸门）
            const r = await runClockRepair({});
            let note;
            if (r.blocked && r.noAnchor) note = '日期时间修复：缺少可信锚点 → 未调用 AI、未改动数据（请先在总览手工设定剧情日期）';
            else if (r.blocked) note = '日期时间修复：任务进行中，请稍候再试';
            else if (r.skipped && r.total === 0) note = '日期时间修复：没有需要修复的日期/时间';
            else if (r.error === 'no-ai') note = '日期时间修复：AI 未返回内容（未改动数据）';
            else if (r.error) note = '日期时间修复失败：' + String(r.error).slice(0, 120);
            else {
                const parts = [];
                if (r.applied) parts.push('修正 ' + r.applied + ' 条');
                if (r.cleared) parts.push('清空 ' + r.cleared + ' 条');
                if (r.skipped) parts.push('丢弃不合格 ' + r.skipped + ' 条');
                if (r.unknown) parts.push('无法判定 ' + r.unknown + ' 条');
                note = '日期时间修复：' + (parts.length ? parts.join(' · ') : 'AI 未给出可用结果') + (r.details && r.details.length ? '；例：' + r.details.slice(0, 3).join('；') : '');
            }
            return { ok: !!(r.applied || r.cleared || (r.made > 0)), action: a, note, detail: r };
        }
        if (a === 'clockRepair') {
            // B8-3：「AI 结合正文修复日期时间」（V1 同名动作；只改日期与时间字段，逐条过安全闸门）
            const r = await runClockRepair({});
            let note;
            if (r.blocked && r.noAnchor) note = '日期时间修复：缺少可信锚点 → 未调用 AI、未改动数据（请先在总览手工设定剧情日期）';
            else if (r.blocked) note = '日期时间修复：任务进行中，请稍候再试';
            else if (r.skipped && r.total === 0) note = '日期时间修复：没有需要修复的日期/时间';
            else if (r.error === 'no-ai') note = '日期时间修复：AI 未返回内容（未改动数据）';
            else if (r.error) note = '日期时间修复失败：' + String(r.error).slice(0, 120);
            else {
                const parts = [];
                if (r.applied) parts.push('修正 ' + r.applied + ' 条');
                if (r.cleared) parts.push('清空 ' + r.cleared + ' 条');
                if (r.skipped) parts.push('丢弃不合格 ' + r.skipped + ' 条');
                if (r.unknown) parts.push('无法判定 ' + r.unknown + ' 条');
                note = '日期时间修复：' + (parts.length ? parts.join(' · ') : 'AI 未给出可用结果') + (r.details && r.details.length ? '；例：' + r.details.slice(0, 3).join('；') : '');
            }
            return { ok: !!(r.applied || r.cleared || (r.made > 0)), action: a, note, detail: r };
        }
        return { ok: false, action: a, note: '未知时钟动作：' + a };
    } catch (e) {
        const note = String((e && e.message) || e).slice(0, 160);
        toast('error', '时钟动作失败', note);
        return { ok: false, action: a, note, error: note };
    }
}

/** 时钟动作名（供面板分发；与 V1 逐字一致） */
export const CLOCK_ACTIONS = Object.freeze(['clockEdit', 'clockEditCancel', 'clockManualSave', 'clockManualClear', 'clockRepair']);

/** 巡检/锚点诊断（FTT.* 与调试用） */
export function clockUiInfo() {
    return { editing: clockEditing, manual: clockManualState() };
}
