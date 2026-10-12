// ============================================================
// ui/tri-link.js —— **「🔗 联动构建」的界面层**（v3.46.1，`docs/D22` W11 `应-26`；设计稿 `docs/D32` §3.3 / §3.7）
//
// 为什么单独成模块（`docs/05-开发指南.md` §5 **C11**「新功能一律落新模块」+ `scripts/check-file-size.js` 体量棘轮）：
//   本模块是新功能（按钮 + 预览区 + 一次 AI 编排 + 应用/取消），**不应堆进 `ui/panel.js`**（那是单体大文件）；
//   `ui/panel.js` 只留**必要接线**：两处按钮调用 + 预览区渲染 + 三个动作分支（各一行）。
//
// 与内核的分工（`core/tri-link.js` 是唯一算法事实源）：
//   · 内核：打包 / 七条校验 / 应用 / 留痕 / 幂等签名（纯函数 + 注入的 AI 钩子）；
//   · 本模块：状态（预览区开关 / 待确认方案 / 上次已应用签名）+ 渲染 + 调内核 + 落盘。
//
// 纪律（`docs/D32` §3.7）：**预览不改任何数据**；应用前自动落一次快照（可整轮回退）；一次点击 = **一轮**（不递归）。
// ============================================================
import { state, saveState } from '../core/model/runtime.js';
import { snapshotCreateFull } from '../core/snapshots.js';
import {
    triPack, triParse, triValidate, triApply, triSig, triLogPush, triNoteText, triDebug, triCfg,
    triBlockReason, TRI_REASON_TEXT, TRI_DIM_LABEL,
} from '../core/tri-link.js';
import { aiCallText, aiBusy } from '../core/ai-hooks.js';
import { PROMPT_TEMPLATES_V2 } from '../core/config.js';
import { cfg } from '../core/model/runtime.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 预览区是否展开 */
let open = false;
/** 待确认方案（`{pack, accepted, rejected, reasons, sig, truncated, scope, at}`） */
let pending = null;
/** 上次**已应用**的签名（幂等：同签名再来一次直接跳过，不叠加 —— `docs/D32` §3.6） */
let appliedSig = '';

/** 状态快照（面板 / 调试导出共用；只读副本） */
export function triLinkState() {
    return {
        open: open,
        pending: pending ? { accepted: (pending.accepted || []).length, rejected: (pending.rejected || []).length, scope: pending.scope, sig: pending.sig } : null,
        appliedSig: appliedSig,
    };
}

/**
 * 两个入口（传言页 / 计划悬念页）**同一个动作** `triLinkBuild`；`data-ftt-kind` 携带入口域 → 决定
 * 打包的**视野优先级**与预览区默认展开的域（处理范围与规则完全相同）。
 */
export function triLinkButton(scope) {
    try {
        const conf = triCfg();
        const has = ['rumors', 'plans', 'suspense'].some((d) => Array.isArray(state[d]) && state[d].length > 0);
        if (!conf.enabled || !has) return '';
        return '<button class="ftt-btn ftt-sm' + (open ? ' ftt-primary' : '') + '" data-ftt-action="triLinkBuild" data-ftt-kind="' + esc(scope) + '"'
            + ' title="把三域（传言/计划/悬念）全部数据与关联交给 AI，构建符合常理的联动；先出方案，确认后落库">🔗 联动构建</button>';
    } catch (e) { return ''; }
}

/** 预览区（`docs/D32` §3.7 ④：逐条「源 → 目标 · 边 · 效果 · 字段变化 · 理由 · 证据」+ 底部确认；**零写入**） */
export function triLinkPanelHtml() {
    if (!open || !pending) return '';
    const p = pending;
    const rows = (p.accepted || []).map((o) => {
        const fields = Object.keys(o.patch || {}).map((k) => k + '=' + String(JSON.stringify(o.patch[k])).slice(0, 30)).join(' · ');
        return '<div class="ftt-muted ftt-pad-y ftt-dashed-b" data-ftt-tri-row>'
            + '<b>' + esc(String(TRI_DIM_LABEL[o.src.dim] || o.src.dim)) + '</b> ' + esc(String(o.src.id))
            + ' → <b>' + esc(String(TRI_DIM_LABEL[o.dst.dim] || o.dst.dim)) + '</b> ' + esc(String(o.dst.id))
            + ' · 边 <b>' + esc(String(o.link)) + '</b>' + (o.who ? ('（' + esc(String(o.who)) + '）') : '')
            + ' · 效果 ' + esc(String(o.effect || ''))
            + (fields ? ('<br>字段变化：<span class="ftt-mono-sm">' + esc(fields) + '</span>') : '')
            + (o.reason ? ('<br>理由：' + esc(String(o.reason))) : '')
            + (o.evidence && o.evidence.ref ? ('<br>证据：' + esc(String(o.evidence.ref)) + (o.evidence.quote ? (' 「' + esc(String(o.evidence.quote)) + '」') : '')) : '')
            + '</div>';
    }).join('');
    const rejected = (p.rejected || []).length
        ? ('<div class="ftt-muted">被拒 ' + p.rejected.length + ' 条（' + esc(Object.keys(p.reasons || {}).map((k) => k + '×' + p.reasons[k]).join(' · ')) + '）</div>')
        : '';
    return '<div class="ftt-editor" data-ftt-tri-link>'
        + '<div class="ftt-editor-title">🔗 联动构建方案 · 共 ' + (p.accepted || []).length + ' 条待确认</div>'
        + '<div class="ftt-muted ftt-w-full">本次只做三件事：<b>建关联 / 追加留痕 / 推进受限字段</b> —— 不新增、不删除、不改正文；'
        + '打包 ' + (p.pack && p.pack.counts ? (['rumors', 'plans', 'suspense'].map((d) => TRI_DIM_LABEL[d] + ' ' + (p.pack.counts[d] || 0)).join(' · ')) : '')
        + (p.truncated && p.truncated.items ? (' · 截断 ' + p.truncated.items) : '') + '。</div>'
        + rows + rejected
        + '<div class="ftt-row"><button class="ftt-btn ftt-primary" data-ftt-action="triLinkApply" title="按上面的方案落库（应用前会自动落一次快照，可整轮回退）">✅ 应用</button>'
        + '<button class="ftt-btn" data-ftt-action="triLinkClose" title="取消本次方案（数据零改动）">✖ 取消</button></div>'
        + '</div>';
}

/**
 * 跑一轮（打包 → **一次** AI 请求 → 七条校验 → 出方案；**不改任何数据**）。
 * 五种终止（`docs/D32` §3.11）：`disabled` / `busy` / `no-data` / `no-ai` / `invalid`。
 */
export async function triLinkRun(scope) {
    const hasData = ['rumors', 'plans', 'suspense'].some((d) => Array.isArray(state[d]) && state[d].length > 0);
    const blocked = triBlockReason(hasData);
    if (blocked) { open = false; pending = null; return { ok: false, reason: blocked, note: '联动构建：' + (TRI_REASON_TEXT[blocked] || blocked) }; }
    if (aiBusy()) return { ok: false, reason: 'busy', note: '联动构建：' + TRI_REASON_TEXT.busy };
    const t0 = Date.now();
    const pack = triPack({ scope: scope });
    let prompt = '';
    try {
        const tpl = String((cfg && cfg.prompts && cfg.prompts.triLink) || PROMPT_TEMPLATES_V2.triLink || '');
        prompt = tpl.replace('{{按 §3.4 打包的三段数据：条目 / 关联 / 事实锚点}}', pack.text);
    } catch (e) { prompt = pack.text; }
    let resp = '';
    try { resp = String(await aiCallText(prompt, '三域联动') || ''); } catch (e) { resp = ''; }
    const parsed = triParse(resp);
    if (!parsed) {
        open = false; pending = null;
        try { triDebug({ scope: scope, packed: pack.counts, ops: 0, applied: 0, rejected: 0, ms: Date.now() - t0, reason: 'no-ai' }); } catch (e) { /* 忽略 */ }
        return { ok: false, reason: 'no-ai', note: '联动构建：' + TRI_REASON_TEXT['no-ai'], packed: pack.counts };
    }
    const v = triValidate(parsed.ops, pack);
    const sig = triSig(pack, v.accepted);
    if (sig && sig === appliedSig) {
        open = false; pending = null;
        return { ok: false, reason: 'invalid', note: '联动构建：本轮方案与上次**完全相同**（已应用过，不叠加）', accepted: v.accepted.length };
    }
    if (!v.accepted.length) {
        open = false; pending = null;
        try { triDebug({ scope: scope, packed: pack.counts, ops: (parsed.ops || []).length, applied: 0, rejected: v.rejected.length, reasons: v.reasons, ms: Date.now() - t0 }); } catch (e) { /* 忽略 */ }
        return { ok: false, reason: 'invalid', note: '联动构建：' + TRI_REASON_TEXT.invalid + '（拒绝 ' + v.rejected.length + ' 条：' + Object.keys(v.reasons).map((k) => k + '×' + v.reasons[k]).join(' · ') + '）', rejected: v.rejected, reasons: v.reasons };
    }
    pending = { pack: pack, accepted: v.accepted, rejected: v.rejected, reasons: v.reasons, sig: sig, truncated: pack.truncated, scope: scope, at: Date.now() };
    open = true;
    return { ok: true, packed: pack.counts, truncated: pack.truncated, accepted: v.accepted.length, rejected: v.rejected.length, sig: sig,
        note: '联动构建：方案已生成（待确认 ' + v.accepted.length + ' 条 · 拒绝 ' + v.rejected.length + ' 条），确认后落库' };
}

/** 应用待确认方案（`docs/D32` §3.7 ⑤⑥⑦：先算后写 → 留痕 → 应用前落快照可整轮回退） */
export function triLinkCommit() {
    if (!pending || !pending.accepted || !pending.accepted.length) return { ok: false, note: '联动构建：没有待应用的方案' };
    const p = pending;
    try { snapshotCreateFull(); } catch (e) { /* 快照失败不阻塞（§3.7 ⑦ 是"尽力"的回退保障） */ }
    const applied = triApply(p.accepted);
    appliedSig = p.sig || '';
    try {
        triLogPush({ scope: p.scope, packed: p.pack && p.pack.counts, ops: p.accepted.length,
            rejected: (p.rejected || []).length, links: applied.links, fields: applied.fields, notes: applied.notes });
    } catch (e) { /* 忽略 */ }
    try {
        triDebug({ scope: p.scope, packed: p.pack && p.pack.counts, ops: p.accepted.length,
            applied: applied.links + applied.fields + applied.notes, rejected: (p.rejected || []).length,
            links: applied.links, fields: applied.fields, notes: applied.notes });
    } catch (e) { /* 忽略 */ }
    try { saveState(); } catch (e) { /* 忽略 */ }
    const note = triNoteText(applied, (p.rejected || []).length, p.truncated);
    open = false; pending = null;
    return { ok: true, note: note, applied: applied, links: applied.links, fields: applied.fields, notes: applied.notes };
}

/** 取消（零写入） */
export function triLinkClose() {
    open = false; pending = null;
    return { ok: true, note: '联动构建：已取消（数据未改动）' };
}
