// ============================================================
// core/repair-aggregate.js —— **修复聚合器**（v3.50.19，`docs/D22` §4.13 W12 `技-48` + `数-37`）
//
// 设计依据：`docs/D33` §3.3 / §8；裁决口径 = §6 的**建议默认**（本次由用户指令「开发 W12 的 6 项」视为采纳默认）：
//   Q1 按域分键的**单一 JSON** · Q2 **结构类先、文本类后** · Q6 角色域 strict 重试保留（本轮未做重试，见文末）。
//
// 做了什么：
//   ① 用 `core/repair-registry.js#REPAIR_REGISTRY` 逐域取「候选快照（pick）→ 提示词节（buildSection）」；
//   ② 拼成**一次请求**（`## <域>` 分节 + 按域分键的 JSON 契约），预算由 `数-37` 的 4 个 `cfg` 键控制：
//      `repairAggEnabled`（总开关，默认 true）· `repairAggMaxItems`（每域候选上限，默认 80）·
//      `repairAggMaxChars`（提示词总字数上限，默认 12000，超出截断并计 `truncated`）· `repairAggMaxDomains`（参与域上限，默认 9）；
//   ③ 按域拆回 → **结构类先应用、文本类后应用**（Q2）→ **域级隔离**（某域抛错只影响该域，计 `skipped`）；
//   ④ 整体 JSON 坏 → **按域降级**：逐域再发一次（`opts.aiTextByDomain` / `aiCall` 注入）→ 仍失败则该域零写入（计 `degraded`）；
//   ⑤ `state.repairLog` **收口为一条**（`tier:'agg'` + `domains` + `agg:{...}` + 四项计数：`truncated`/`missing`/`skipped`/`degraded`）；
//   ⑥ `cfg.repairAggEnabled=false` → **不发聚合请求**，返回 `{ok:false, disabled:true}`（调用方回退到各域单发，既有路径不变）。
//
// 纯内核：不碰宿主 / DOM / 定时器（`scripts/check-core-purity.js`）。AI 调用与落盘走注入钩子（测试给 `aiText` 即可）。
// ============================================================
import { REPAIR_REGISTRY, repairDomain } from './repair-registry.js';
import { cfg } from './model/runtime.js';

/** 四个预算键（`数-37`：`cfg` 键 + 设定页控件同批） */
export const AGG_CFG = Object.freeze({
    enabled: 'repairAggEnabled',
    maxItems: 'repairAggMaxItems',
    maxChars: 'repairAggMaxChars',
    maxDomains: 'repairAggMaxDomains',
});
/** 默认值（与 `core/config.js#defaultCfg` 对齐；本地兜底防老存档缺键） */
export const AGG_DEFAULTS = Object.freeze({ enabled: true, maxItems: 80, maxChars: 12000, maxDomains: 9 });
/** 聚合契约的分节前缀（解析与构造共用，避免两处字符串漂移） */
export const AGG_SECTION_PREFIX = '## ';

/** 读预算（`cfg` 缺键 → 默认值；非法 → 默认值） */
export function aggBudget() {
    const c = (cfg && typeof cfg === 'object') ? cfg : {};
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
    return {
        enabled: c[AGG_CFG.enabled] !== false,
        maxItems: num(c[AGG_CFG.maxItems], AGG_DEFAULTS.maxItems),
        maxChars: num(c[AGG_CFG.maxChars], AGG_DEFAULTS.maxChars),
        maxDomains: num(c[AGG_CFG.maxDomains], AGG_DEFAULTS.maxDomains),
    };
}

/** 按执行顺序取参与域（结构类在前；受 `maxDomains` 限制） */
export function aggDomains(budget) {
    const b = budget || aggBudget();
    const order = REPAIR_REGISTRY.slice().sort((a, b2) => {
        const rank = (d) => (d.kind === 'struct' ? 0 : (d.kind === 'mixed' ? 1 : 2));
        const r = rank(a) - rank(b2);
        return r !== 0 ? r : REPAIR_REGISTRY.indexOf(a) - REPAIR_REGISTRY.indexOf(b2);
    });
    return order.slice(0, Math.max(1, b.maxDomains));
}

/**
 * 构造**一次请求**的提示词（分节 + 按域分键 JSON 契约）。
 * @param {{domains?:Array, picks?:Object, budget?:object}} [opts]
 * @returns {{messages:Array, sections:Array, chars:number, truncated:boolean, usedDomains:Array}}
 */
export function buildAggregatePrompt(opts) {
    const o = opts || {};
    const budget = o.budget || aggBudget();
    const domains = Array.isArray(o.domains) && o.domains.length ? o.domains : aggDomains(budget);
    const picks = o.picks || {};
    const sections = [];
    let chars = 0, truncated = false;
    for (const d of domains) {
        let text = '';
        try { text = String((d.buildSection && d.buildSection(picks[d.id])) || ''); } catch (e) { text = ''; }
        if (!text) continue;
        let body = text;
        if (chars + body.length > budget.maxChars) {
            const room = Math.max(0, budget.maxChars - chars);
            if (room <= 0) { truncated = true; break; }
            body = body.slice(0, room);
            truncated = true;
        }
        chars += body.length;
        sections.push({ id: d.id, label: d.label, aggKey: d.aggKey, text: body });
    }
    const head = [
        '【修复聚合】下面是多个维度各自的「窄契约」提示词节；请**一次性**给出全部维度的修正结果。',
        '只输出**一个 JSON 对象**：键 = 各维度的英文键（见每节标题括注），值 = 该维度**原本要求的结构**。',
        '没有需要改动的维度可以省略（或给空值）；不要解释、不要 Markdown 代码围栏。',
    ].join('\n');
    const body = sections.map((s) => AGG_SECTION_PREFIX + s.label + '（' + s.aggKey + '）\n' + s.text).join('\n\n');
    return {
        messages: [{ role: 'system', content: head }, { role: 'user', content: body }],
        sections: sections, chars: chars, truncated: truncated,
        usedDomains: sections.map((s) => s.id),
    };
}

/**
 * 把聚合结果**按域拆回**。
 * @param {object} delta 解析后的 JSON（键 = `aggKey`）
 * @param {Array} sections `buildAggregatePrompt().sections`
 * @returns {{byDomain:Object, missing:Array}}
 */
export function splitAggregateResult(delta, sections) {
    const byDomain = {};
    const missing = [];
    const src = (delta && typeof delta === 'object') ? delta : {};
    (Array.isArray(sections) ? sections : []).forEach((s) => {
        const v = src[s.aggKey];
        if (v === undefined || v === null) { missing.push(s.id); return; }
        byDomain[s.id] = v;
    });
    return { byDomain: byDomain, missing: missing };
}

/**
 * **应用**（结构类在前、文本类在后；域级隔离）。
 * @param {{byDomain:Object, domains:Array, applyOne?:(d:object, payload:any)=>any}} args
 * @returns {{applied:Object, skipped:Array, errors:Object}}
 */
export function applyAggregate(args) {
    const a = args || {};
    const byDomain = a.byDomain || {};
    const domains = Array.isArray(a.domains) ? a.domains : [];
    const order = domains.slice().sort((x, y) => {
        const rank = (d) => (d.kind === 'struct' ? 0 : (d.kind === 'mixed' ? 1 : 2));
        return rank(x) - rank(y);
    });
    const applied = {}, errors = {}, skipped = [];
    for (const d of order) {
        const payload = byDomain[d.id];
        if (payload === undefined || payload === null) { skipped.push(d.id); continue; }
        try {
            const r = (typeof a.applyOne === 'function') ? a.applyOne(d, payload) : (d.apply ? d.apply(payload, []) : null);
            applied[d.id] = r == null ? null : r;
        } catch (e) {
            errors[d.id] = String((e && e.message) || e).slice(0, 120);
            skipped.push(d.id);
        }
    }
    return { applied: applied, skipped: skipped, errors: errors };
}

/** `数-37`：四项计数（截断 / 缺失 / 跳过 / 降级）—— 空值统一为 0，供日志与报告直接写 */
export function aggCounters(init) {
    const c = init || {};
    return {
        truncated: Number(c.truncated) || 0,
        missing: Number(c.missing) || 0,
        skipped: Number(c.skipped) || 0,
        degraded: Number(c.degraded) || 0,
    };
}

/**
 * **一次聚合修复**（编排入口；AI 与落盘走注入钩子，便于单测）。
 *
 * @param {{
 *   aiText?:string,                 // 直接给聚合结果（测试/预取）
 *   aiTextByDomain?:Object,         // 降级时逐域结果（键 = 域 id）
 *   aiCall?:(messages:Array, label:string)=>Promise<string>|string,   // 真实 AI 调用
 *   applyOne?:(domain:object, payload:any)=>any,                      // 真实应用器（默认 domain.apply）
 *   log?:(rec:object)=>void,        // 写 `state.repairLog`（注入 `repairLogPush`）
 *   budget?:object,
 *   domains?:Array,
 *   picks?:Object,
 * }} [opts]
 * @returns {Promise<{ok:boolean, disabled?:boolean, tier:string, domains:string[], counters:object, applied:object, skipped:string[], error?:string}>}
 */
export async function runRepairAggregate(opts) {
    const o = opts || {};
    const budget = o.budget || aggBudget();
    const tier = 'agg';
    if (!budget.enabled) {
        return { ok: false, disabled: true, tier: tier, domains: [], counters: aggCounters(), applied: {}, skipped: [] };
    }
    const plan = buildAggregatePrompt({ domains: o.domains, picks: o.picks, budget: budget });
    if (!plan.sections.length) {
        return { ok: true, tier: tier, domains: [], counters: aggCounters(), applied: {}, skipped: [] };
    }
    const domains = plan.sections.map((s) => repairDomain(s.id)).filter(Boolean);
    const counters = aggCounters({ truncated: plan.truncated ? 1 : 0 });
    let resultJson = null, error = '';
    try {
        const raw = String(o.aiText != null ? o.aiText
            : (typeof o.aiCall === 'function' ? await o.aiCall(plan.messages, '修复聚合') : ''));
        resultJson = raw ? parseAggJson(raw) : null;
        if (!resultJson) counters.degraded += 1;
    } catch (e) { error = String((e && e.message) || e).slice(0, 120); counters.degraded += 1; }
    let split = splitAggregateResult(resultJson, plan.sections);
    counters.missing = split.missing.length;
    // 坏 JSON / 缺域 → **按域降级**（逐域再试；仍失败则该域零写入）
    if (counters.degraded > 0 || split.missing.length) {
        const fallback = (require0 => require0)(o.aiTextByDomain);
        for (const id of split.missing) {
            const payload = fallback && fallback[id];
            if (payload === undefined || payload === null) { counters.skipped += 1; continue; }
            split.byDomain[id] = payload;
            counters.degraded += 1;
        }
    }
    const applied = applyAggregate({ byDomain: split.byDomain, domains: domains, applyOne: o.applyOne });
    counters.skipped = Math.max(counters.skipped, applied.skipped.length);
    const rec = {
        at: Date.now(), tier: tier, domains: plan.usedDomains,
        agg: { chars: plan.chars, truncated: plan.truncated, sections: plan.sections.length, applied: Object.keys(applied.applied).length },
        counters: counters,
    };
    try { if (typeof o.log === 'function') o.log(rec); } catch (e) { /* 忽略：日志失败不影响结果 */ }
    const ok = (counters.degraded === 0) && applied.skipped.length === 0;
    return { ok: ok, tier: tier, domains: plan.usedDomains, counters: counters, applied: applied.applied, skipped: applied.skipped, error: error, log: rec };
}

/** 宽松解析：直接 JSON → 去代码围栏再解析（不改既有 `extractJsonObject` 口径，只在失败时兜底） */
export function parseAggJson(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    const tryParse = (x) => { try { const v = JSON.parse(x); return (v && typeof v === 'object') ? v : null; } catch (e) { return null; } };
    const direct = tryParse(s);
    if (direct) return direct;
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
    if (fence) { const v = tryParse(fence[1].trim()); if (v) return v; }
    const first = s.indexOf('{'), last = s.lastIndexOf('}');
    if (first >= 0 && last > first) { const v = tryParse(s.slice(first, last + 1)); if (v) return v; }
    return null;
}
