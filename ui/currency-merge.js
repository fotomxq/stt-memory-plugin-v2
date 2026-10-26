// ============================================================
// ui/currency-merge.js —— **「🔀 AI 融合货币」的界面层**（v3.46.2，`docs/D22` §4.14 W13 `应-30`）
//
// 用户要求（原话）：「新增货币融合，指定一个角色的所有货币交给AI去整理规整，尤其是一些只是叫法不同的货币应该合并。
//   具体你可以参考本地的调试接口，调取数据核对。」
//
// 分工（`docs/05-开发指南.md` §5 **C11** + 体量棘轮：新功能落新模块，`ui/panel.js` 只留必要接线）：
//   · `core/currency-merge.js` = 算法事实源（打包 / 窄契约校验 / 合成 plan / 幂等 / 留痕）；
//   · 本模块 = 状态（面板开关 / 待确认 plan / 上次已应用签名）+ 渲染 + 调内核 + 落盘；
//   · `ui/panel.js` = 2 处按钮调用 + 1 处预览渲染 + 3 个动作分支。
//
// 与既有「🧹 修正货币」的关系：**并列的两个入口** —— 机械档零 AI、秒级、只认写死的别名表；本档花一次 AI 请求，
//   认「语义同义」（真实数据实测：`黄金 / 天然碎金 / 碎金子 / 赤金条 / 诺米斯金币` 机械表一个都合不了）。
//   两者共用同一条应用与墓碑路径（`core/currency-repair.js#runCurrencyRepair({plan})`）。
// ============================================================
import { state, cfg, saveState } from '../core/model/runtime.js';
import { snapshotCreateFull } from '../core/snapshots.js';
import { aiCallText, aiBusy } from '../core/ai-hooks.js';
import { PROMPT_TEMPLATES_V2 } from '../core/config.js';
import {
    currencyMergePack, currencyMergeParse, currencyMergePlan, currencyMergeBuild, currencyMergeApply,
    currencyMergeSig, curMergeOwners, curMergeCfg, curMergeBlockReason, curMergeNoteText, CUR_MERGE_REASON_TEXT,
} from '../core/currency-merge.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => Number(v) || 0;

/** 面板开关 */
let open = false;
/** 待确认方案（`currencyMergePlan()` 的结果） */
let pending = null;
/** 上次**已应用**的签名（幂等：同签名再来一次直接跳过） */
let appliedSig = '';
/** 预览里被拒绝的组（供展示原因分布） */
let rejected = [];
let reasons = {};
/**
 * v3.49.2（用户要求「点击图标触发后，该条目应有滚动或加载效果，同时显示提交 AI 的提示状态」）：
 * **正在跑 AI 的角色名** —— 点击瞬间由 `currencyMergeBegin()` 置位（`ui/panel.js` 随即 `setNote` + **立刻重绘**），
 * 该条目渲染为「转圈 + 按钮禁用 + ⏳ 已提交 AI…」；AI 返回后由收尾重绘复原（成功 / 失败 / 异常都清位）。
 */
let runningOwner = '';

/** 状态快照（面板 / 调试 / 测试用） */
export function currencyMergeState() {
    return {
        open: open, owner: pending ? pending.owner : '', appliedSig: appliedSig,
        pending: pending ? { owner: pending.owner, groups: (pending.merge || []).length, counts: pending.counts } : null,
    };
}

/**
 * 货币页工具行的「🔀 AI 融合」按钮（与「🧹 修正货币」并列）。
 * 显隐口径：`cfg.currencyMergeEnabled !== false` 且**至少有一个角色名下有货币**。
 */
export function currencyMergeButton() {
    try {
        const conf = curMergeCfg();
        if (!conf.enabled) return '';
        const owners = curMergeOwners();
        if (!owners.length) return '';
        return '<button class="ftt-btn ftt-sm' + (open ? ' ftt-primary' : '') + '" data-ftt-action="currencyMergeOpen"'
            + ' title="指定一个角色，把它名下的全部货币交给 AI 整理：只合并「叫法不同、其实是同一种」的货币（同单位才可合，不凭空换算）；先出方案、确认后落库">🔀 AI 融合货币</button>';
    } catch (e) { return ''; }
}

/** 预览区（**只读**：选角色 → 列方案 → 确认 / 取消；未确认零写入） */
export function currencyMergePanelHtml() {
    if (!open) return '';
    const owners = curMergeOwners();
    const picked = pending ? pending.owner : String((owners[0] || {}).owner || '');
    const rows = owners.map((o) => {
        const on = o.owner === picked;
        const run = !!(runningOwner && o.owner === runningOwner);      // v3.49.2：正在为该角色请求 AI
        /**
         * v3.50.2（用户报告「AI 融合货币的列表内动效、布局设计存在缺陷，挤压到了一起，且没有看到动效」）：
         *   ① **布局**：状态行曾在 `.ftt-item-main` **之外**（且用了当时并不存在的 `.ftt-w-full`）→ 它成了行的第三个
         *      flex 子项，把 `.ftt-item-ops`（🔧）挤到下一行。现在状态行放在 `.ftt-item-main` **内部**（`.ftt-item-sub`），
         *      于是「名称 + 徽标 + 计数 + 状态」占满剩余宽度，🔧 始终留在**同一行右侧**。
         *   ② **动效**：`.ftt-loading` 此前只给 `.ftt-floor-btn` 写过样式 → 挂在行/`.ftt-op` 上什么都不显示。
         *      现在行用 `.ftt-item-loading`（底色 + 左侧强调条 + 呼吸，**关掉动画也看得见状态**），
         *      并配一个通用 `.ftt-spin` 转圈；按钮仍是 `.ftt-op.ftt-loading`（转圈 + 禁用）。
         */
        return '<div class="ftt-item' + (run ? ' ftt-item-loading' : '') + '"><div class="ftt-item-main">'
            + '<b>' + esc(o.owner) + '</b>'
            + (run ? ' <span class="ftt-badge">⏳ 已提交 AI…</span>' : (on ? ' <span class="ftt-badge">当前目标</span>' : ''))
            + ' <span class="ftt-muted">' + num(o.n) + ' 条 · ' + num(o.names) + ' 种叫法</span>'
            + (run ? '<div class="ftt-item-sub ftt-muted"><span class="ftt-spin" aria-hidden="true"></span> 正在整理这个角色的货币（同义叫法合并）—— AI 返回后本区就地展开方案。</div>' : '')
            + '</div>'
            + '<div class="ftt-item-ops"><button class="ftt-op' + (on ? ' ftt-ok' : '') + (run ? ' ftt-loading' : '') + '" data-ftt-action="currencyMergePick" data-name="' + esc(o.owner) + '"'
            + (run ? ' disabled' : '')                                                      // v3.49.2：在途禁用，避免重复点击
            + ' title="' + (run ? '正在整理：已提交 AI，等返回（避免重复点击）' : ('按 AI 生成「' + esc(o.owner) + '」的货币融合方案（整理同义叫法；先出方案、确认后落库）')) + '">'
            + (run ? '⏳' : '🔧') + '</button></div></div>';       // v3.49.2：图标改为**修复含义**的 🔧（原先 ➕ 读起来像「新增」）
    }).join('\n');
    const runTip = runningOwner
        ? ('<div class="ftt-muted ftt-w-full"><b>⏳ 已提交 AI 分析</b>：正在整理「' + esc(runningOwner) + '」的货币（同义叫法合并）—— 返回后本区就地展开只读方案，未确认前不改任何数据。</div>')
        : '';
    const head = '<div class="ftt-editor-title">🔀 AI 融合货币 · 共 ' + owners.length + ' 个角色名下有货币</div>'
        + runTip
        + '<div class="ftt-muted ftt-w-full">一次只处理**一个角色**：AI 只做「语义同义的合并」（同一物品的不同叫法），'
        + '<b>不读楼层正文</b>、不跨角色、**不凭空换算**（单位不同的只报告不合并）；额度默认<b>求和</b>'
        + '（可在设定里改为「保留最新额度、不累加」）。应用前会自动落一次快照，可整轮回退。</div>'
        + '<div class="ftt-hint">点角色右侧 <b>🔧</b> 出方案（会等一次 AI 返回；点击后该条目转圈并禁用，避免重复点击）。</div>'
        + '<div>' + (owners.length ? rows : '<div class="ftt-empty">还没有任何角色的货币记录。</div>') + '</div>';
    if (!pending) return '<div class="ftt-editor ftt-preview-card">' + head
        + '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="currencyMergeClose">取消</button></div></div>';
    const groups = (pending.merge || []).filter((m) => m.ai === true);
    const body = groups.map((m) => {
        const members = (m.members || []).map((x) => esc(x.name) + '（' + esc(x.unit || '—') + ' ' + num(x.amount) + '）').join(' / ');
        return '<div class="ftt-muted ftt-pad-y ftt-dashed-b">'
            + '<b>' + esc(m.canonical) + '</b>' + (m.unit ? ('（' + esc(m.unit) + '）') : '')
            + ' ← ' + members
            + '<br>额度：' + (pending.sumAmount ? ('求和 <b>' + num(m.amount) + '</b>（各组员原额见上）') : ('保留最新 <b>' + num(m.amount) + '</b>，不累加（各组员原额见上）'))
            + ((m.otherAmounts || []).length
                ? ('<br>并入其它单位（<b>不换算</b>，原额记入备注）：' + (m.otherAmounts || []).map((x) => esc(String(x.name)) + '(' + esc(String(x.unit || '—')) + ') ' + num(x.amount)).join('、'))
                : '')
            + (m.why ? ('<br>依据：' + esc(String(m.why))) : '')
            + '</div>';
    }).join('');
    const rej = rejected.length
        ? ('<div class="ftt-muted">AI 提了但被拒 ' + rejected.length + ' 组（' + esc(Object.keys(reasons).map((k) => k + '×' + reasons[k]).join(' · ')) + '）</div>')
        : '';
    const counts = pending.counts || {};
    return '<div class="ftt-editor ftt-preview-card">' + head
        + '<div class="ftt-editor-title">方案（' + esc(pending.owner) + '）：待确认合并 ' + groups.length + ' 组 · 机械档另有 ' + Math.max(0, num(counts.mergeGroups) - groups.length) + ' 组</div>'
        + body + rej
        + '<div class="ftt-row">'
        + (groups.length ? '<button class="ftt-btn ftt-primary" data-ftt-action="currencyMergeApply" title="按上面的方案落库（会再次弹确认框；应用前自动落快照）">✅ 应用融合</button>' : '')
        + '<button class="ftt-btn" data-ftt-action="currencyMergeClose">取消</button></div></div>';
}

/**
 * v3.49.2（用户要求「点击图标触发，则图标自动禁用，避免重复点击」「该条目应有滚动或加载效果，
 *   同时显示提交 AI 的提示状态」）：**点击瞬间**的可见反馈 —— 置在途归属并给出提示文案。
 *   `ui/panel.js` 拿到 `note` 后 `setNote()` + **立刻重绘**（重绘时该条目带 `.ftt-loading` 转圈、
 *   按钮被渲染为 `disabled`；**管道守门** `pipeDisableInFlightHtml()` 另会对在途动作注入 `disabled`）。
 *   AI 返回后由收尾的那次重绘复原。
 * @param {string} action 动作名（非 `currencyMergePick` → 返回 null，不打扰其它动作）
 * @param {{name?:string}} [payload]
 * @returns {{note:string}|null}
 */
export function currencyMergeBegin(action, payload) {
    const a = String(action || '');
    const q = payload || {};
    if (a !== 'currencyMergePick') return null;
    const nm = String(q.name || '').trim();
    runningOwner = nm;
    return { note: '⏳ 已提交 AI 分析：正在整理「' + (nm || '当前角色') + '」的货币（同义叫法合并）…请等本次返回' };
}
/** 正在跑 AI 的角色名（渲染在途态 / 调试 / 测试用） */
export function currencyMergeRunning() { return runningOwner; }

/** 跑一轮：打包 → **一次** AI 请求 → 窄契约校验 → 出方案（**不改任何数据**） */
export async function currencyMergeRun(owner) {
    const owners = curMergeOwners();
    const own = String(owner || (owners[0] || {}).owner || '').trim();
    const pack = currencyMergePack({ owner: own });
    const blocked = curMergeBlockReason(own, pack.rows);
    if (blocked) { pending = null; return { ok: false, reason: blocked, note: '货币融合：' + (CUR_MERGE_REASON_TEXT[blocked] || blocked) }; }
    if (aiBusy()) return { ok: false, reason: 'busy', note: '货币融合：' + CUR_MERGE_REASON_TEXT.busy };
    let prompt = '';
    try {
        const tpl = String((cfg && cfg.prompts && cfg.prompts.currencyMerge) || PROMPT_TEMPLATES_V2.currencyMerge || '');
        prompt = tpl.replace('{{该角色货币账本的逐条清单 + 名字清单（按单位分组）}}', pack.text);
    } catch (e) { prompt = pack.text; }
    let resp = '';
    try { resp = String(await aiCallText(prompt, '货币融合') || ''); } catch (e) { resp = ''; }
    const r = await currencyMergeBuild({ owner: own, aiText: resp });
    if (!r.ok) { pending = null; rejected = []; reasons = {}; return { ok: false, reason: r.reason, note: r.note, pack: pack, plan: r.plan }; }
    if (r.sig && r.sig === appliedSig) {
        pending = null;
        return { ok: false, reason: 'invalid', note: '货币融合：本轮方案与上次**完全相同**（已应用过，不叠加）' };
    }
    pending = r.plan;
    rejected = (r.plan.validate && r.plan.validate.rejected) || [];
    reasons = (r.plan.validate && r.plan.validate.reasons) || {};
    open = true;
    return { ok: true, note: r.note, plan: r.plan, sig: r.sig, groups: (r.plan.merge || []).filter((m) => m.ai === true).length, rejected: rejected.length };
}

/** 应用待确认方案（先落快照 → 复用机械档的应用与墓碑路径 → 留痕 → 落盘） */
export function currencyMergeCommit() {
    if (!pending || !pending.counts || !pending.counts.total) return { ok: false, note: '货币融合：没有待应用的方案' };
    const plan = pending;
    try { snapshotCreateFull(); } catch (e) { /* 快照失败不阻塞 */ }
    const r = currencyMergeApply(plan, { quiet: true });
    appliedSig = plan.sig || '';
    try { saveState(); } catch (e) { /* 忽略 */ }
    const note = curMergeNoteText(r, plan);
    pending = null; open = false; rejected = []; reasons = {};
    return { ok: r.ok !== false, note: note, applied: r, owner: plan.owner };
}

/** 一键分发（面板动作 → 本模块函数；`ui/panel.js` 只留**一个分支**，见 `docs/05` §5 C11 的"必要接线"） */
export const CUR_MERGE_ACTIONS = Object.freeze(['currencyMergeOpen', 'currencyMergePick', 'currencyMergeApply', 'currencyMergeClose']);

/**
 * 按动作名分发（面板唯一入口）。
 * @param {string} action `currencyMergeOpen` / `currencyMergePick` / `currencyMergeApply` / `currencyMergeClose`
 * @param {{name?:string}} [payload] `currencyMergePick` 用 `payload.name` = 要整理的角色
 */
export async function runCurrencyMergeAction(action, payload) {
    const a = String(action || '');
    const p = payload || {};
    /**
     * v3.46.3 修复（用户报告「🔀 AI 融合货币**无法正常使用**」）：此分支原先**只返回提示文案**、
     *   没有把 `open` 置真 —— 于是点「🔀 AI 融合货币」时：提示有了、**预览区却始终是空的**
     *   （`currencyMergePanelHtml()` 在 `!open` 时返回空串）→ 角色列表不出现、无法选角色 → 功能等于不可用。
     *   现在改为**走真正的开面板函数**（`currencyMergeOpen()` 置 `open = true`），与 `currencyMergePick`
     *   在 `currencyMergeRun()` 里置真同口径。
     */
    if (a === 'currencyMergeOpen') return Object.assign({ action: a }, currencyMergeOpen());
    if (a === 'currencyMergePick') {
        runningOwner = String(p.name || '').trim();                                 // v3.49.2：跑之前置位（渲染在途态）
        try { const r = await currencyMergeRun(String(p.name || '')); return Object.assign({ action: a }, r); }
        finally { runningOwner = ''; }                                              // 收尾清位（成功 / 失败 / 异常都要清）
    }
    if (a === 'currencyMergeApply') { const r = currencyMergeCommit(); return Object.assign({ action: a }, r); }
    if (a === 'currencyMergeClose') { const r = currencyMergeClose(); return Object.assign({ action: a }, r); }
    return { ok: false, note: '货币融合：未知动作 ' + a, action: a };
}

/** 打开 / 取消（零写入） */
export function currencyMergeOpen() {
    open = true; runningOwner = '';
    return { ok: true, note: '货币融合：请选择要整理的角色（不会立刻改动数据）' };
}
export function currencyMergeClose() {
    open = false; pending = null; rejected = []; reasons = {}; runningOwner = '';
    return { ok: true, note: '货币融合：已取消（数据未改动）' };
}
