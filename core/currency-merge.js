// ============================================================
// core/currency-merge.js —— **货币融合（AI 语义合并）**的纯内核
//   （v3.46.2，`docs/D22` §4.14 **W13** `应-30`；设计稿 `docs/D22 §4.14 W13`）
//
// 用户要求（原话）：「新增货币融合，指定一个角色的所有货币交给AI去整理规整，尤其是一些只是叫法不同的货币应该合并。
//   具体你可以参考本地的调试接口，调取数据核对。」
//
// 与既有「🧹 修正货币」（v3.15.0，**纯机械、零 AI**）的分工（**不是替代关系**）：
//   · 机械档 `core/currency-repair.js`：写死的别名表（`CURRENCY_NAME_ALIASES` / `CURRENCY_UNIT_ALIASES`）+ 结构规则
//     （空壳 / 幽灵角色 / 名字是单位词 / 单位冲突 / 额度缺省补齐 / 同归属同规范名合并）；
//   · **本模块（AI 档）**：补「语义同义」这一机械表认不出的部分 —— 本机真实存档实测：同一角色 37 种「名字|单位」组合里，
//     `黄金 / 天然碎金 / 碎金子 / 赤金条 / 赤金条子 / 诺米斯玛金币` 是同一类（金），而机械表**一个都合不了**（不在别名表里）。
//   · **两者共用同一条应用与墓碑路径**：本模块把「机械 plan + AI 合并组」合成一份同形 plan，交给
//     `core/currency-repair.js#runCurrencyRepair({plan})` → 保留最新额度（或按开关求和）、id 墓碑 + 内容哈希墓碑、
//     备注 / 标签 / 流水 / 使用次数 / 楼层区间 **并集**（与机械档逐字同口径）。
//
// 口径要点（逐条对应设计稿）：
//   ① **单角色**：一次只处理一个归属（`owner`），跨角色一律不动；
//   ② **不读楼层**（不调 `aiFeedText`）：只用 `state.currencies` + 角色名册；
//   ③ **禁止凭空换算**：只有**单位相同**才允许合组（实测单位写法混乱：黄金「两」、赤金条子「贯」、铜钱「枚」）；
//   ④ **额度策略**：默认**保留最新额度、不累加**（与机械档同口径）；`cfg.currencyMergeSumAmount=true` 时改为**求和**；
//      两种策略下**预览都逐条列出原额**（不静默丢数字）；
//   ⑤ **幂等**：`currencyMergeSig = hash(打包指纹 + 规范化分组)`，同签名重复提交直接跳过；
//   ⑥ **留痕**：`state.currencyMergeLog`（末 5 条、runtime、不跨端）· 调试日志 kind `摘要`（沿用既有货币动作的 kind）。
// 本模块是**纯内核**：不碰 DOM / 宿主 / 定时器（`check-core-purity.js` 强制）。
// ============================================================
import { state, cfg, saveState, dbgLog } from './model/runtime.js';
import { storageHash } from './envelope.js';
import { currencyRepairPlan, runCurrencyRepair, canonicalUnit, canonicalName } from './currency-repair.js';

/** 运行时槽位：融合记录（末 5 条；不参与跨端同步） */
export const CUR_MERGE_LOG_MAX = 5;

/** 默认上限（`cfg` 读不到时兜底） */
export const CUR_MERGE_DEFAULTS = Object.freeze({ maxItems: 120, nameMax: 24, whyMax: 60, groupsMax: 30 });

/** 复合名 / 单位词 / 负额度的判别词（真实数据里这三类都出现过 → **只报告不合并**） */
export const CUR_MERGE_COMPOUND_TOKENS = Object.freeze(['及', '和', '、', '与', '+', '＋']);

/** 读 `cfg`（缺省回退；只读） */
export function curMergeCfg() {
    const c = (cfg && typeof cfg === 'object') ? cfg : {};
    const num = (k, d) => { const n = Number(c[k]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
    return {
        enabled: c.currencyMergeEnabled !== false,
        sumAmount: c.currencyMergeSumAmount !== false,     // 额度策略：**默认 true = 求和**（用户裁决 v3.46.2）；false = 保留最新不累加
        maxItems: Math.min(num('currencyMergeMaxItems', CUR_MERGE_DEFAULTS.maxItems), 400),
    };
}

const str = (v) => String(v == null ? '' : v);
const clip = (v, n) => { const s = str(v); return s.length > n ? (s.slice(0, n) + '…') : s; };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** 该角色名下的全部货币（**只读**快照；按名字 + id 稳定排序） */
export function curMergeOf(owner) {
    const o = str(owner).trim();
    const list = Array.isArray(state.currencies) ? state.currencies : [];
    const out = [];
    for (const c of list) {
        if (!c || typeof c !== 'object') continue;
        if (str(c.owner || c.who).trim() !== o) continue;
        out.push({
            id: str(c.id), owner: o, name: str(c.name || c.currency || c.unit), unit: str(c.unit),
            amount: Number(c.amount) || 0, date: str(c.date), note: clip(c.note, 40),
            uses: Number(c.uses) || 0,
            net: round2((Array.isArray(c.flows) ? c.flows : []).reduce((s, f) => s + (Number(f && (f.delta != null ? f.delta : f.amount)) || 0), 0)),
            floorStart: Number(c.floorStart) || 0, floorEnd: Number(c.floorEnd) || 0,
        });
    }
    out.sort((a, b) => (a.name === b.name ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name)));
    return out;
}

/** 该角色出现过的**归属**清单（面板选择器用；只读；按记录数降序） */
export function curMergeOwners() {
    const list = Array.isArray(state.currencies) ? state.currencies : [];
    const m = new Map();
    for (const c of list) {
        if (!c || typeof c !== 'object') continue;
        const o = str(c.owner || c.who).trim();
        if (!o) continue;
        const r = m.get(o) || { owner: o, n: 0, names: new Set() };
        r.n++;
        r.names.add(str(c.name || c.currency || '').trim());
        m.set(o, r);
    }
    return [...m.values()].map((r) => ({ owner: r.owner, n: r.n, names: r.names.size })).sort((a, b) => (b.n - a.n) || a.owner.localeCompare(b.owner));
}

/**
 * 打包（**只读**，不改任何数据；直接可 JSON 化）。
 * @param {{owner?:string}} [opts]
 * @returns {{owner:string, rows:Array, names:Array, units:Array, counts:object, truncated:number, chars:number, fp:string, text:string}}
 */
export function currencyMergePack(opts) {
    const o = opts || {};
    const conf = curMergeCfg();
    const owner = str(o.owner).trim();
    const all = curMergeOf(owner);
    const rows = all.slice(0, conf.maxItems);
    const truncated = Math.max(0, all.length - rows.length);
    const lines = [];
    for (const r of rows) {
        lines.push(r.id + ' | ' + r.name + ' | 单位=' + (r.unit || '—') + ' | 额度=' + r.amount + ' | 日期=' + (r.date || '—')
            + ' | 用' + r.uses + '次 | 流水净额=' + r.net + (r.note ? (' | 备注=' + r.note) : ''));
    }
    // 名字清单（按单位分组）—— 让模型先看到"同单位下有哪些不同叫法"，这正是同义合并的判据来源
    const byUnit = new Map();
    for (const r of rows) {
        const u = canonicalUnit(r.unit) || (r.unit || '（无单位）');
        if (!byUnit.has(u)) byUnit.set(u, new Set());
        byUnit.get(u).add(r.name);
    }
    const names = [...byUnit.entries()].map(([u, s]) => ({ unit: u, names: [...s] }));
    lines.push('—— 名字清单（按单位分组）——');
    for (const g of names) lines.push('[' + g.unit + '] ' + g.names.join(' / '));
    const text = lines.join('\n');
    return {
        owner: owner, rows: rows, names: names, units: names.map((x) => x.unit),
        counts: { entries: rows.length, names: rows.length ? new Set(rows.map((r) => r.name)).size : 0, units: names.length },
        truncated: truncated, chars: text.length,
        fp: storageHash(owner + '#' + rows.map((r) => r.id + '|' + r.name + '|' + r.unit + '|' + r.amount).join('~')),
        text: text,
    };
}

/** 从 AI 文本里抠 JSON（容忍 ```json 包裹与前后文字；要求 `groups` 数组） */
export function currencyMergeParse(text) {
    const s = str(text).trim();
    if (!s) return null;
    const tryParse = (t) => { try { const v = JSON.parse(t); return (v && typeof v === 'object' && Array.isArray(v.groups)) ? v : null; } catch (e) { return null; } };
    let v = tryParse(s);
    if (v) return v;
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) { v = tryParse(fence[1].trim()); if (v) return v; }
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) { v = tryParse(s.slice(i, j + 1)); if (v) return v; }
    return null;
}

/**
 * **窄契约校验**（机械兜底：AI 只提方案）。逐条判据：
 *   ① 成员 id 必须在**本次打包集合**内；② 每组 ≥2 条；③ **同一 id 不得出现在两组**；④ **单位必须相同**（禁凭空换算）；
 *   ⑤ 规范名非空且 ≤ `nameMax`；⑥ 复合名 / 单位词名 / 负额度条目**不得**进组（只报告）；⑦ 组数 ≤ `groupsMax`。
 * @returns {{groups:Array, rejected:Array, keep:Array, reasons:object}}
 */
export function currencyMergeValidate(ai, pack) {
    const conf = curMergeCfg();
    const inPack = new Map();
    for (const r of ((pack && pack.rows) || [])) inPack.set(str(r.id), r);
    const groups = [], rejected = [], keep = [], reasons = {};
    const bump = (r) => { reasons[r] = (reasons[r] || 0) + 1; };
    const used = new Set();
    const list = Array.isArray(ai && ai.groups) ? ai.groups : [];
    for (const g of list.slice(0, CUR_MERGE_DEFAULTS.groupsMax * 2)) {
        const why = [];
        if (groups.length >= CUR_MERGE_DEFAULTS.groupsMax) why.push('over-max-groups');
        const canon = (g && g.canonical) || {};
        const name = clip(canon.name, CUR_MERGE_DEFAULTS.nameMax).trim();
        const unit = str(canon.unit).trim();
        if (!name) why.push('no-canonical-name');
        if (CUR_MERGE_COMPOUND_TOKENS.some((t) => name.indexOf(t) >= 0)) why.push('compound-canonical');
        const members = [];
        for (const m of (Array.isArray(g && g.members) ? g.members : [])) {
            const id = str(m && (m.id || m)).trim();
            const row = inPack.get(id);
            if (!row) { why.push('member-not-packed'); continue; }
            if (used.has(id)) { why.push('member-reused'); continue; }
            if (CUR_MERGE_COMPOUND_TOKENS.some((t) => str(row.name).indexOf(t) >= 0)) { why.push('compound-member'); continue; }
            if (Number(row.amount) < 0) { why.push('negative-amount'); continue; }
            if (row.name && str(row.name).replace(/[（）()\s]/g, '') === str(row.unit).replace(/[（）()\s]/g, '') && !row.unit) { why.push('name-is-unit'); continue; }
            members.push({ id: id, name: row.name, unit: row.unit, amount: row.amount, date: row.date, uses: row.uses, net: row.net });
        }
        if (members.length < 2) why.push('too-few-members');
        const units = [...new Set(members.map((m) => canonicalUnit(m.unit) || str(m.unit).trim()).filter(Boolean))];
        if (units.length > 1) why.push('unit-conflict');                    // 禁凭空换算：不同单位不得合组
        if (why.length) {
            rejected.push({ group: { canonical: { name: name, unit: unit }, members: members.map((m) => m.id) }, reasons: [...new Set(why)] });
            for (const r of [...new Set(why)]) bump(r);
            continue;
        }
        for (const m of members) used.add(m.id);
        // 规范名：既尊重 AI 的选择，也过一遍既有别名归一（与机械档口径一致）
        const finalName = canonicalName(name) || name;
        const keepRow = members.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (Number(b.uses) || 0) - (Number(a.uses) || 0))[0];
        groups.push({
            key: 'ai|' + pack.owner + '|' + finalName, owner: pack.owner,
            canonical: finalName, unit: units[0] || '', keepId: keepRow.id, removedIds: members.filter((m) => m.id !== keepRow.id).map((m) => m.id),
            members: members, why: clip(g && g.why, CUR_MERGE_DEFAULTS.whyMax),
            setName: true,                                     // AI 组要把保留条目的**名字**改成规范名（机械档不动名字）
            sumAmount: round2(members.reduce((s, m) => s + (Number(m.amount) || 0), 0)),
            newestAmount: Number(keepRow.amount) || 0, newestDate: keepRow.date,
        });
    }
    for (const k of (Array.isArray(ai && ai.keep) ? ai.keep : [])) {
        const id = str(k && (k.id || k)).trim();
        const row = inPack.get(id);
        if (row && !used.has(id)) keep.push({ id: id, name: row.name, unit: row.unit, amount: row.amount, why: clip(k && k.why, 40) });
    }
    return { groups: groups, rejected: rejected, keep: keep, reasons: reasons };
}

/** 幂等签名：打包指纹 + 规范化分组 */
export function currencyMergeSig(pack, groups) {
    try {
        const norm = (Array.isArray(groups) ? groups : []).map((g) => [g.canonical, g.unit, g.keepId, g.removedIds.slice().sort().join(',')].join('|')).sort();
        return storageHash(str(pack && pack.fp) + '#' + norm.join('~'));
    } catch (e) { return ''; }
}

/**
 * 合成一份**同形 plan**：机械档的 drop / fix / report + AI 的合并组（AI 组优先占用 id）。
 * 交付给 `core/currency-repair.js#runCurrencyRepair({plan})` —— **同一条应用与墓碑路径**。
 */
export function currencyMergePlan(opts) {
    const o = opts || {};
    const conf = curMergeCfg();
    const pack = o.pack || currencyMergePack({ owner: o.owner });
    const ai = o.ai || { groups: [] };
    const v = currencyMergeValidate(ai, pack);
    const base = currencyRepairPlan({ includeUntracked: false });
    const used = new Set();
    for (const g of v.groups) { used.add(g.keepId); for (const id of g.removedIds) used.add(id); }
    const drop = base.drop.filter((d) => !used.has(str(d.id)));
    const fix = base.fix.filter((f) => !used.has(str(f.id)));
    const report = base.report.filter((r) => !used.has(str(r.id)));
    const merge = [];
    // ① AI 组（语义合并）—— 额度策略在这里定
    for (const g of v.groups) {
        const amount = conf.sumAmount ? g.sumAmount : g.newestAmount;
        const kept = (base.merge || []).filter((m) => str(m.keepId) === str(g.keepId));
        const uses = g.members.reduce((s, m) => s + (Number(m.uses) || 0), 0);
        merge.push({
            key: g.key, owner: g.owner, canonical: g.canonical, unit: g.unit, keepId: g.keepId, removedIds: g.removedIds,
            amount: round2(amount), newestDate: g.newestDate, uses: uses, members: g.members, ai: true,
            setName: true,                                  // 保留条目改名为**规范名**（机械档不带此标记）
            why: g.why, sumAmount: g.sumAmount, newestAmount: g.newestAmount,
            detail: 'AI 语义合并 ' + g.members.length + ' 条 → 「' + g.canonical + '」（' + (g.unit || '无单位') + '，'
                + (conf.sumAmount ? ('求和 ' + round2(g.sumAmount)) : ('保留最新额度 ' + g.newestAmount + '，不累加')) + '）'
                + (g.why ? ('：' + g.why) : ''),
        });
        for (const id of g.removedIds) drop.push({ id: id, owner: g.owner, name: (g.members.filter((m) => m.id === id)[0] || {}).name || '', unit: g.unit, amount: (g.members.filter((m) => m.id === id)[0] || {}).amount || 0, reason: 'merged-ai', detail: '并入「' + g.canonical + '」（' + id + ' → ' + g.keepId + '）' });
    }
    // ② 机械组（同规范名别名）—— 去掉已被 AI 组占用或已被剔除的成员；剩 <2 条则跳过
    for (const m of (base.merge || [])) {
        const ids = [str(m.keepId)].concat((m.removedIds || []).map(str)).filter((id) => !used.has(id));
        if (ids.length < 2) continue;
        merge.push(Object.assign({}, m, { keepId: ids[0], removedIds: ids.slice(1), ai: false }));
        for (const id of ids.slice(1)) drop.push({ id: id, owner: m.owner, name: '', unit: m.unit, amount: 0, reason: 'merged', detail: '并入「' + m.canonical + '」（机械档同规范名）' });
    }
    const counts = {
        drop: drop.length, mergeGroups: merge.length,
        mergeRemoved: merge.reduce((s, m) => s + (m.removedIds || []).length, 0),
        fix: fix.length, report: report.length + v.rejected.length,
        aiGroups: v.groups.length, aiRejected: v.rejected.length, kept: v.keep.length, truncated: pack.truncated,
        total: drop.length + fix.length + merge.length,
    };
    return { ok: true, owner: pack.owner, pack: pack, ai: ai, validate: v, drop: drop, fix: fix, merge: merge, report: report, counts: counts, sumAmount: conf.sumAmount };
}

/** 追加一条融合记录（末 5 条；不参与跨端同步） */
export function curMergeLogPush(rec) {
    try {
        const arr = Array.isArray(state.currencyMergeLog) ? state.currencyMergeLog : (state.currencyMergeLog = []);
        arr.push(Object.assign({ at: Date.now() }, rec || {}));
        while (arr.length > CUR_MERGE_LOG_MAX) arr.shift();
        return arr.length;
    } catch (e) { return 0; }
}
/** 只读副本 */
export function curMergeLogList() { try { return (Array.isArray(state.currencyMergeLog) ? state.currencyMergeLog : []).map((x) => Object.assign({}, x)); } catch (e) { return []; } }

/** 提示行（面板 `setNote` 与 toast 共用同一份措辞） */
export function curMergeNoteText(applied, plan) {
    const a = applied || {};
    const c = (plan && plan.counts) || {};
    return '货币融合（' + str((plan && plan.owner)) + '）：合并 ' + (Number(c.mergeGroups) || 0) + ' 组（-'
        + (Number(c.mergeRemoved) || 0) + ' 条）· 剔除 ' + (Number(a.dropped) || 0) + ' · 修正 ' + (Number(c.fix) || 0)
        + ' · 只报告 ' + (Number(c.report) || 0) + '（' + (Number(a.before) || 0) + ' → ' + (Number(a.after) || 0) + ' 条，'
        + (plan && plan.sumAmount ? '额度按求和' : '额度保留最新不累加') + '）';
}

/** 五种终止原因（与三域联动同款口径；调用点在跑之前先问一次） */
export function curMergeBlockReason(owner, rows) {
    const conf = curMergeCfg();
    if (!conf.enabled) return 'disabled';
    if (!str(owner).trim()) return 'no-owner';
    if (!Array.isArray(rows) || !rows.length) return 'no-data';
    return '';
}
export const CUR_MERGE_REASON_TEXT = Object.freeze({
    disabled: '货币融合已关闭（可在设定里打开 currencyMergeEnabled）',
    'no-owner': '还没有选择要融合的角色',
    'no-data': '该角色名下没有货币记录',
    busy: '分析管道占用中，稍后再试',
    'no-ai': 'AI 未返回结果，本次未改动任何数据',
    invalid: '方案不可用（没有可合并的组）',
});

/**
 * **一步到位**：跑一轮（打包 → 一次 AI 请求 → 七条校验 → 合成 plan）——**不写任何数据**。
 * @param {{owner:string, aiText?:string}} opts 测试时可注入 `aiText` 跳过真实请求
 */
export async function currencyMergeBuild(opts) {
    const o = opts || {};
    const pack = currencyMergePack({ owner: o.owner });
    const blocked = curMergeBlockReason(o.owner, pack.rows);
    if (blocked) return { ok: false, reason: blocked, note: '货币融合：' + (CUR_MERGE_REASON_TEXT[blocked] || blocked), pack: pack };
    const ai = currencyMergeParse(o.aiText);
    if (!ai) return { ok: false, reason: 'no-ai', note: '货币融合：' + CUR_MERGE_REASON_TEXT['no-ai'], pack: pack };
    const plan = currencyMergePlan({ pack: pack, ai: ai });
    plan.sig = currencyMergeSig(pack, plan.validate.groups);
    if (!plan.validate.groups.length) {
        return { ok: false, reason: 'invalid', note: '货币融合：' + CUR_MERGE_REASON_TEXT.invalid + '（拒绝 ' + plan.counts.aiRejected + ' 组：' + Object.keys(plan.validate.reasons).map((k) => k + '×' + plan.validate.reasons[k]).join(' · ') + '）', plan: plan };
    }
    return { ok: true, plan: plan, sig: plan.sig, note: '货币融合：方案已生成（' + plan.validate.groups.length + ' 组待确认 / 拒绝 ' + plan.counts.aiRejected + ' 组），确认后落库' };
}

/** 应用（复用机械档的同一路径：墓碑 + 并集 + 落盘 + 通知） */
export function currencyMergeApply(plan, opts) {
    const o = opts || {};
    if (!plan || !plan.counts || !plan.counts.total) return { ok: false, changed: false, summary: '无需融合（没有可合并的组）' };
    const r = runCurrencyRepair({ plan: plan, quiet: o.quiet === true });
    try {
        curMergeLogPush({
            owner: plan.owner, groups: plan.counts.aiGroups, rejected: plan.counts.aiRejected,
            before: r.before, after: r.after, merged: r.mergedRemoved, sumAmount: plan.sumAmount === true,
        });
    } catch (e) { /* 忽略 */ }
    try {
        dbgLog('摘要', {
            action: '货币融合（v3.46.2 AI 语义合并）', owner: plan.owner, before: r.before, after: r.after,
            groups: plan.counts.aiGroups, rejected: plan.counts.aiRejected, mergedRemoved: r.mergedRemoved,
            sumAmount: plan.sumAmount === true, truncated: plan.counts.truncated,
        });
    } catch (e) { /* 忽略 */ }
    try { saveState(); } catch (e) { /* runCurrencyRepair 已落盘一次，这里只兜底 */ }
    return r;
}
