// ============================================================
// ui/resume-batch.js —— **「📜 批量完善履历」的界面层**
//   （v3.47.0，`docs/D22` §4.16 **W16** `应-33`；设计稿 `docs/D38-履历批量完善设计稿.md`）
//
// 用户要求（原话）：「角色新增完善履历功能，该功能与修复角色平行。根据近期更新的记忆，抽取相关角色，
//   激活单一补全/修复履历的功能。注意是**批量合并执行**，以减少 AI 反复请求次数。」
//
// 分工（`docs/05-开发指南.md` §5 **C11** + 体量棘轮：新功能落新模块，`ui/panel.js` 只留必要接线）：
//   · `core/resume-batch.js` = 算法事实源（抽角色 / 打包 / 窄契约校验 / 应用 / 幂等 / 留痕）；
//   · 本模块 = 状态（面板开关 / 勾选的角色 / 待确认方案 / 上次已应用签名）+ 渲染 + 调内核 + 落盘；
//   · `ui/panel.js` = 1 处按钮调用 + 1 处预览渲染 + 1 个动作分支（`RESUME_BATCH_ACTIONS` 统一分发）。
//
// 与**个体档**（角色行内「📜 补全 / 修复履历」，`ui/resume-repair.js`）的关系：
//   同一个算法的两种入口 —— 个体档 = 一个角色一次请求；本档 = **一批角色一次请求**（用户要的"减少反复请求"）。
// ============================================================
import { state, cfg, saveState } from '../core/model/runtime.js';
import { snapshotCreateFull } from '../core/snapshots.js';
import { aiCallText, aiBusy } from '../core/ai-hooks.js';
import { PROMPT_TEMPLATES_V2 } from '../core/config.js';
import {
    resumeBatchCfg, resumeBatchCandidates, resumeBatchPack, resumeBatchParse, resumeBatchValidate,
    resumeBatchSig, resumeBatchApply, resumeBatchLogPush, resumeBatchNoteText, resumeBatchBlockReason,
    RESUME_BATCH_REASON_TEXT,
} from '../core/resume-batch.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => Number(v) || 0;

/** 面板开关 */
let open = false;
/** 勾选的角色（名字数组；空 = 用候选前 N 名） */
let picked = [];
/** 待确认方案（`{pack, roles, validate, sig}`） */
let pending = null;
/** 上次**已应用**的签名（幂等：同签名再来一次直接跳过） */
let appliedSig = '';
/** 最近一次候选快照（面板渲染用；避免每次渲染重扫记忆） */
let candCache = null;

/** 状态快照（面板 / 调试 / 测试用） */
export function resumeBatchState() {
    return {
        open: open, picked: picked.slice(), appliedSig: appliedSig,
        pending: pending ? { roles: (pending.roles || []).map((r) => r.name), counts: pending.pack && pending.pack.counts } : null,
    };
}

/** 候选刷新（面板打开时 / 勾选变化时调用） */
function refreshCands() {
    try { candCache = resumeBatchCandidates({}); } catch (e) { candCache = []; }
    return candCache;
}

/** 有效的勾选（勾选者 ∩ 候选；空勾选 = 候选前 `resumeBatchMaxRoles` 名） */
function effectivePicked() {
    const conf = resumeBatchCfg();
    const cands = candCache || refreshCands();
    const names = cands.map((c) => c.name);
    const sel = picked.filter((n) => names.indexOf(n) >= 0);
    return (sel.length ? sel : names.slice(0, conf.maxRoles));
}

/**
 * 角色页工具行的「📜 批量完善履历」按钮（与「🧹 修复角色」**平行**：同一行、紧邻）。
 * 显隐：`cfg.resumeBatchEnabled !== false` 且履历总开关开着 且**近期窗口内有候选角色**。
 */
export function resumeBatchButton() {
    try {
        const conf = resumeBatchCfg();
        if (!conf.enabled) return '';
        if (cfg && cfg.snapshotResumeEnabled === false) return '';
        const cands = resumeBatchCandidates({});
        if (!cands.length) return '';
        return '<button class="ftt-btn ftt-sm' + (open ? ' ftt-primary' : '') + '" data-ftt-action="resumeBatchOpen"'
            + ' title="按「近期更新的记忆」抽出相关角色，把一批角色**合并成一次 AI 请求**补全 / 凝练履历（与「修复角色」平行；先出方案、确认后落库）">📜 批量完善履历</button>';
    } catch (e) { return ''; }
}

/** 预览区（**只读**：勾角色 → 列方案 → 确认 / 取消；未确认零写入） */
export function resumeBatchPanelHtml() {
    if (!open) return '';
    const conf = resumeBatchCfg();
    const cands = candCache || refreshCands();
    const sel = effectivePicked();
    const rows = cands.map((c) => {
        const on = sel.indexOf(c.name) >= 0;
        return '<div class="ftt-item"><div class="ftt-item-main">'
            + '<b>' + esc(c.name) + '</b>' + (c.canon ? ' <span class="ftt-badge">原作</span>' : '')
            + ' <span class="ftt-muted">命中 ' + num(c.hits) + ' 条' + (c.lastDate ? (' · 最近 ' + esc(c.lastDate)) : '')
            + ' · 现有履历 ' + num(c.resumeLen) + ' 条</span></div>'
            + '<div class="ftt-item-ops"><button class="ftt-op' + (on ? ' ftt-ok' : '') + '" data-ftt-action="resumeBatchToggle" data-name="' + esc(c.name) + '"'
            + ' title="' + (on ? '取消勾选' : '勾选进本次批量') + '">' + (on ? '✅' : '➕') + '</button></div></div>';
    }).join('\n');
    const head = '<div class="ftt-editor-title">📜 批量完善履历 · 近 ' + num(conf.days) + ' 天内有记忆命中的角色 ' + cands.length + ' 名</div>'
        + '<div class="ftt-muted ftt-w-full">一次点击 = <b>一次</b> AI 请求处理<b>本批全部角色</b>（选中 ' + sel.length + ' 名，上限 ' + num(conf.maxRoles) + '）：'
        + '先跑零 AI 的机械整理，再交给 AI 补全 / 凝练，逐角色复核后落库。**不读楼层正文**、**不得**写当前剧情日期之后的事（原作人物可写剧情前生平）、'
        + '**不重复**已有条目、凝练只允许更短。应用前会自动落一次快照，可整轮回退。</div>'
        + '<div class="ftt-hint">点角色右侧 ➕ / ✅ 勾选；下方「🚀 生成方案」会等一次 AI 返回（未确认前不写任何数据）。</div>'
        + '<div>' + (cands.length ? rows : '<div class="ftt-empty">近期窗口内没有「被记忆命中」的角色：可调大窗口天数，或先用「⚡ 立即 AI 摘要」更新记忆。</div>') + '</div>';
    if (!pending) {
        return '<div class="ftt-editor">' + head
            + '<div class="ftt-row">'
            + (sel.length ? '<button class="ftt-btn ftt-primary" data-ftt-action="resumeBatchRun" title="按勾选的角色生成方案（一次 AI 请求）">🚀 生成方案</button>' : '')
            + '<button class="ftt-btn" data-ftt-action="resumeBatchClose">取消</button></div></div>';
    }
    const roles = pending.roles || [];
    const body = roles.map((r) => {
        const adds = (r.added || []).map((e) => '<div class="ftt-muted">＋ ' + esc(String(e.date || '')) + ' ｜ ' + esc(String(e.summary || '')) + '</div>').join('');
        const conds = (r.condense || []).map((c) => '<div class="ftt-muted ftt-dashed-b">凝练 ' + esc(String(c.date || '')) + '：' + esc(String(c.origin || '')) + '… → ' + esc(String(c.text || '')) + '</div>').join('');
        return '<div class="ftt-muted ftt-pad-y"><b>' + esc(r.name) + '</b>' + (r.canon ? '（原作：已过剧情前护栏）' : '')
            + ' · 新增 ' + num((r.added || []).length) + ' 条 · 凝练 ' + num((r.condense || []).length) + ' 条'
            + (num(r.canonRejected) ? (' · <span class="ftt-err">护栏拒收 ' + num(r.canonRejected) + ' 条</span>') : '')
            + adds + conds + '</div>';
    }).join('');
    const rej = (pending.validate && (pending.validate.rejected || []).length)
        ? ('<div class="ftt-muted">被拒 ' + pending.validate.rejected.length + ' 名（' + esc(Object.keys(pending.validate.reasons || {}).map((k) => k + '×' + pending.validate.reasons[k]).join(' · ')) + '）</div>')
        : '';
    const counts = (pending.pack && pending.pack.counts) || {};
    return '<div class="ftt-editor">' + head
        + '<div class="ftt-editor-title">方案：' + roles.length + ' 名可写入（打包 ' + num(counts.roles) + ' 名 / 命中记忆 ' + num(counts.memories) + ' 条'
        + (num((pending.pack || {}).truncated) ? (' · 截断 ' + num(pending.pack.truncated) + ' 名') : '') + '）</div>'
        + body + rej
        + '<div class="ftt-row">'
        + (roles.length ? '<button class="ftt-btn ftt-primary" data-ftt-action="resumeBatchApply" title="按上面的方案落库（应用前自动落快照）">✅ 应用</button>' : '')
        + '<button class="ftt-btn" data-ftt-action="resumeBatchClose">取消</button></div></div>';
}

/** 生成方案：打包 → **一次** AI 请求 → 窄契约校验（**不改任何数据**） */
export async function resumeBatchRun() {
    const conf = resumeBatchCfg();
    const cands = refreshCands();
    const sel = effectivePicked();
    const blocked = resumeBatchBlockReason(cands);
    if (blocked) { pending = null; return { ok: false, reason: blocked, note: '履历批量：' + (RESUME_BATCH_REASON_TEXT[blocked] || blocked) }; }
    if (!sel.length) { pending = null; return { ok: false, reason: 'no-candidates', note: '履历批量：没有勾选角色' }; }
    if (aiBusy()) return { ok: false, reason: 'busy', note: '履历批量：' + RESUME_BATCH_REASON_TEXT.busy };
    const t0 = Date.now();
    const pack = resumeBatchPack({ names: sel, days: conf.days, perRole: conf.memoryPerRole });
    if (!pack.roles.length) { pending = null; return { ok: false, reason: 'no-candidates', note: '履历批量：打包为空（角色档案缺失或窗口内无命中）' }; }
    let prompt = '';
    try {
        const tpl = String((cfg && cfg.prompts && cfg.prompts.resumeBatch) || PROMPT_TEMPLATES_V2.resumeBatch || '');
        prompt = tpl.replace('{{按角色分节的档案摘要 + 现有履历 + 近期相关记忆}}', pack.text);
    } catch (e) { prompt = pack.text; }
    let resp = '';
    try { resp = String(await aiCallText(prompt, '履历批量') || ''); } catch (e) { resp = ''; }
    const ai = resumeBatchParse(resp);
    if (!ai) { pending = null; return { ok: false, reason: 'no-ai', note: '履历批量：' + RESUME_BATCH_REASON_TEXT['no-ai'], pack: pack.counts, ms: Date.now() - t0 }; }
    const v = resumeBatchValidate(ai, pack);
    const sig = resumeBatchSig(pack, v.roles);
    if (sig && sig === appliedSig) { pending = null; return { ok: false, reason: 'invalid', note: '履历批量：本轮方案与上次**完全相同**（已应用过，不叠加）' }; }
    if (!v.roles.length) {
        pending = null;
        return { ok: false, reason: 'invalid', note: '履历批量：' + RESUME_BATCH_REASON_TEXT.invalid + '（拒绝 ' + v.rejected.length + ' 名：' + Object.keys(v.reasons).map((k) => k + '×' + v.reasons[k]).join(' · ') + '）', validate: v };
    }
    pending = { pack: pack, roles: v.roles, validate: v, sig: sig };
    return { ok: true, sig: sig, roles: v.roles.length, ms: Date.now() - t0,
        note: '履历批量：方案已生成（' + v.roles.length + ' 名 / 新增 ' + v.roles.reduce((s, r) => s + r.added.length, 0) + ' 条 · 拒绝 ' + v.rejected.length + ' 名），确认后落库' };
}

/** 应用（应用前自动落快照 → 逐角色机械段 + AI 结果 → 落盘一次） */
export function resumeBatchCommit() {
    if (!pending || !pending.roles.length) return { ok: false, note: '履历批量：没有待应用的方案' };
    const plan = { roles: pending.roles, pack: pending.pack };
    try { snapshotCreateFull(); } catch (e) { /* 快照失败不阻塞 */ }
    const r = resumeBatchApply(plan, {});
    appliedSig = pending.sig || '';
    try {
        resumeBatchLogPush({ roles: plan.roles.length, added: r.added, condensed: r.condensed, dropped: r.dropped,
            rejected: r.rejected, after: r.after, truncated: (plan.pack && plan.pack.truncated) || 0 });
    } catch (e) { /* 忽略 */ }
    try { saveState(); } catch (e) { /* 忽略 */ }
    const note = resumeBatchNoteText(r, plan);
    pending = null; open = false; picked = [];
    return { ok: r.ok !== false, note: note, applied: r, roles: plan.roles.length, added: r.added };
}

/** 面板动作统一分发（`ui/panel.js` 只留**一个**分支） */
export const RESUME_BATCH_ACTIONS = Object.freeze(['resumeBatchOpen', 'resumeBatchToggle', 'resumeBatchRun', 'resumeBatchApply', 'resumeBatchClose']);

/**
 * 按动作名分发。
 * @param {string} action `resumeBatchOpen` / `resumeBatchToggle` / `resumeBatchRun` / `resumeBatchApply` / `resumeBatchClose`
 * @param {{name?:string}} [payload] `resumeBatchToggle` 用 `payload.name`
 */
export async function runResumeBatchAction(action, payload) {
    const a = String(action || '');
    const p = payload || {};
    if (a === 'resumeBatchOpen') { open = true; picked = []; pending = null; refreshCands(); return { ok: true, action: a, note: '履历批量：已打开（勾选角色后点「🚀 生成方案」；未确认前不写数据）' }; }
    if (a === 'resumeBatchToggle') {
        const nm = String(p.name || '');
        if (nm) picked = (picked.indexOf(nm) >= 0) ? picked.filter((x) => x !== nm) : picked.concat([nm]);
        return { ok: true, action: a, note: '履历批量：已勾选 ' + effectivePicked().length + ' 名' };
    }
    if (a === 'resumeBatchRun') { const r = await resumeBatchRun(); return Object.assign({ action: a }, r); }
    if (a === 'resumeBatchApply') { const r = resumeBatchCommit(); return Object.assign({ action: a }, r); }
    if (a === 'resumeBatchClose') { open = false; pending = null; picked = []; return { ok: true, action: a, note: '履历批量：已取消（数据未改动）' }; }
    return { ok: false, action: a, note: '履历批量：未知动作 ' + a };
}
