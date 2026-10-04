// ============================================================
// core/currency-repair.js —— **货币修正**（v3.15.0，用户要求）
//
// 用户原话：「货币增加修正按钮，剔除不应该被记录的角色，以及修正错乱的单位计价和冗余的数据合并问题。」
//
// 定位：货币页「🧹 修正货币」专用。**纯机械（零 AI）、确定性、可预演** ——
//   先 `currencyRepairPlan()` 出一份完整计划（界面把计划原样列给用户看），用户确认后才 `runCurrencyRepair()` 落库。
//
// 三类修正（与用户的三句话一一对应）：
//   ① **剔除不应该被记录的角色**：
//      · `ghost-owner`：归属不在「已知角色名册」（角色档案 / 名册 / 状态记录主体 / 主角设定 / 标定角色）→ 幽灵角色，剔除；
//      · `untracked-owner`：归属在名册里，但既不是默认归属（主角）也不是「⭐ 标定跟踪」→ **默认只报告**，
//        由用户在预览面板里显式勾选「同时剔除未标定角色」后才剔除（避免把主角判定兜底成字面「主角」时误删全部）；
//   · `name-is-unit`：币种名本身就是计价单位词（如「贯」「两」）且没写单位 —— 提取错误，无法还原意图 → 剔除；
//      · `empty`：无额度 / 无单位 / 无备注 / 无流水 的空壳条目 → 剔除。
//   ② **修正错乱的单位计价**：
//      · `unit-alias`：单位写法归一到规范写法（银圆/大洋→银元、缗→贯、銀兩→两 …，见 `CURRENCY_UNIT_ALIASES`）；
//      · `amount-from-history`：额度缺失（0）而流水有净额 → 用流水净额补齐（**只补 0，绝不动非零额度**）；
//      · 只报告不改：`unit-nonstandard`（单位不在已知计价单位表，如「粒」「块」）、
//        `amount-mismatch`（额度为负而流水净额为正 —— 符号矛盾，语义无法确定，交人工）。
//   ③ **冗余数据合并**：同归属 + 同规范币种名（别名表 `CURRENCY_NAME_ALIASES`：黄金/金子/赤金→黄金，
//      飞钱/飞钱凭证→飞钱 …）+ **单位相容** → 合成一条：
//      · 保**最新一条**的 id 与额度（额度是「余额快照」而非可累加库存 → **不累加**，避免凭空造钱）；
//      · 流水合并去重（`mergeMoneyHistory`，保留最近 12 笔）、`uses` 累加、标签并集、备注取更长者、
//        楼层取 `min(floorStart) / max(floorEnd)`、`date` 取最新；
//      · **单位不相容 → 不合并**，只报告 `unit-conflict`（例如同归属的「开元通宝」既有 `枚` 又有 `贯`，
//        直接相加会得出错误金额）。
//
// 纪律：
//   · 被剔除 / 被合并掉的条目一律**留删除墓碑**（`core/merge.js#tombMany` + `#tombEntries`）→ 跨端不会复活；
//     注：货币条目在 `core/model/hash.js` 里**没有内容哈希口径**（`atomIdentityHash('currencies', …)` 返回空）→
//     实际生效的是 **id 墓碑**；而货币 id 由「归属 + 币种」派生（`cur_<hash(owner|name)>`），
//     所以跨端同一条货币会得到**同一个 id**，id 墓碑足以拦住复活。此限制如实登记在批次档里。
//   · **只删该删的**：任何一条剔除都在计划里逐条列出（归属 / 币种 / 单位 / 额度 / 原因），用户确认后才执行；
//   · **幂等**：跑完后同一份数据再跑一次计划应为空（单测锁死）；
//   · 绝不新增货币条目（合并只减不增）。
// ============================================================
import { state, saveState, notifyHooks, dbgLog, warn } from './model/runtime.js';
import { roundMoney, moneyNet, mergeMoneyHistory, defaultCurrencyOwner, trackedCurrencyRoles } from './model/money.js';
import { tombMany, tombEntries } from './merge.js';

/** 用户提示（经宿主钩子；与 `core/item-repair.js` 既有写法一致） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}

/** 归一：全角 → 半角、去空白、小写（归属 / 币种 / 单位的比较键统一走它） */
function normKey(v) {
    return String(v == null ? '' : v)
        .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/[\u3000\s]/g, '')
        .toLowerCase();
}
/** 币种名比较键：再去掉括号说明与常见分隔符号（「银元（大洋）」→「银元」） */
function nameKey(v) {
    return normKey(v).replace(/[（(][^）)]*[）)]/g, '').replace(/[·・，,。.、\/\\|:：;；'"“”‘’\-—_+*]/g, '');
}

/**
 * 计价单位别名 → 规范写法（**只收无歧义的写法**：不把「元 / 圆 / 块」这类现代与民国都能用的词
 * 强行归到某一边 —— 那会把「银元」错算成「人民币」）。
 */
const CURRENCY_UNIT_ALIASES = Object.freeze({
    '两': ['两', '両', '銀兩', '银两', '俩'],
    '钱': ['钱'],
    '分': ['分'],
    '厘': ['厘'],
    '文': ['文', '文钱', '制钱'],
    '贯': ['贯', '贯钱', '缗', '緡', '串'],
    '银元': ['银元', '银圆', '大洋', '鹰洋', '洋元', '银洋', '龙洋', '袁大头'],
    '人民币': ['人民币', 'rmb', 'cny', '￥', '¥'],
    '美元': ['美元', '美金', 'usd', '$'],
    '日元': ['日元', '日圆', 'jpy', '円'],
    '金币': ['金币', '金元'],
    '金条': ['金条', '金锭'],
    '克': ['克', 'g'],
    '公斤': ['公斤', 'kg', '千克'],
});

/** 已知计价单位（规范写法 + 允许原样保留的计数/度量单位；不在此表 → 报 `unit-nonstandard`）
 *  注意：**「粒」「块」刻意不在此表** —— 它们用于金属货币（碎银/碎金）属非标准计价（宜为 两 / 钱），
 *  体检会逐条报告但不擅自改写。 */
const CURRENCY_UNIT_KNOWN = Object.freeze([
    '两', '钱', '分', '厘', '文', '贯', '串', '缗', '枚', '锭',
    '银元', '人民币', '美元', '日元', '欧元', '英镑', '金币', '金条',
    '克', '公斤', '吨', '石', '斗', '升', '匹', '刀', '元', '圆', '角',
]);

/**
 * **币种名本身就是单位词**（提取错误）的判定表 —— 只收「不可能作为币种名」的单位词：
 * 「银元 / 人民币 / 金币」这类本身就是合法币种名，一律不在此表。
 */
const CURRENCY_BARE_UNIT_NAMES = Object.freeze(['贯', '贯钱', '缗', '緡', '串', '文', '文钱', '制钱', '两', '钱', '分', '厘', '枚', '粒', '块']);

/**
 * 币种同义名 → 规范名（**冗余合并**用；同一归属下才合并）。
 * 只收「明显是同一种东西的不同叫法」；跨材质/跨档次的（碎金 vs 碎银、黄金 vs 白银）绝不互并。
 */
const CURRENCY_NAME_ALIASES = Object.freeze({
    '黄金': ['黄金', '金子', '赤金', '足金', '纯金', '金'],
    '银两': ['银两', '银子', '白银', '纹银', '银锭', '碎银', '银'],
    '铜钱': ['铜钱', '制钱', '铜板', '现铜', '现钱', '铜元'],
    '飞钱': ['飞钱', '飞钱凭证', '汇票', '银票', '交子'],
});

const UNIT_LOOKUP = (() => {
    const m = Object.create(null);
    for (const [canon, list] of Object.entries(CURRENCY_UNIT_ALIASES)) for (const a of list) m[normKey(a)] = canon;
    return m;
})();
const NAME_LOOKUP = (() => {
    const m = Object.create(null);
    for (const [canon, list] of Object.entries(CURRENCY_NAME_ALIASES)) for (const a of list) m[nameKey(a)] = canon;
    return m;
})();
const BARE_UNIT_SET = new Set(CURRENCY_BARE_UNIT_NAMES.map(normKey));
const KNOWN_UNIT_SET = new Set(CURRENCY_UNIT_KNOWN.map(normKey));

/** 单位 → 规范写法；无别名命中时返回去空白的原值 */
function canonicalUnit(u) {
    const raw = String(u == null ? '' : u).trim();
    if (!raw) return '';
    return UNIT_LOOKUP[normKey(raw)] || raw;
}
/** 币种名 → 规范名（别名命中时）；否则返回去括号/符号后的名称键 */
function canonicalName(n) {
    const key = nameKey(n);
    return NAME_LOOKUP[key] || key;
}
/** 单位是否已知（在别名表或已知单位表里） */
function unitIsKnown(u) {
    const k = normKey(u);
    return !!k && (!!UNIT_LOOKUP[k] || KNOWN_UNIT_SET.has(k));
}

/** 归属比较：去空白小写后相同，或**互相包含**（与 `isTrackedCurrencyOwner` 同口径，宽松优先） */
function ownerLike(a, b) {
    const x = normKey(a), y = normKey(b);
    if (!x || !y) return false;
    return x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
}

/** 已知角色名册（角色档案 / 名册 / 状态记录主体 / 记忆归属 / 主角设定 / 标定角色） */
function currencyOwnerRoster() {
    const out = [];
    const seen = new Set();
    const add = (v) => {
        const nm = String(v == null ? '' : v).trim();
        const k = normKey(nm);
        if (!nm || !k || seen.has(k)) return;
        seen.add(k);
        out.push(nm);
    };
    try { for (const s of (state.snapshots || [])) add(s && s.name); } catch (e) { /* 忽略 */ }
    try { for (const n of (state.npcs || [])) add(n && (n.name || n.title)); } catch (e) { /* 忽略 */ }
    try {
        for (const x of (state.currentStates || [])) {
            const s = String((x && x.subject) || '');
            add(s);
            if (s.indexOf('·') > 0) add(s.split('·')[0]);
        }
    } catch (e) { /* 忽略 */ }
    try { for (const m of (state.memories || [])) add(m && m.owner); } catch (e) { /* 忽略 */ }
    try { add(state.protagonist && (state.protagonist.name || state.protagonist['姓名'])); } catch (e) { /* 忽略 */ }
    try { for (const t of trackedCurrencyRoles()) add(t); } catch (e) { /* 忽略 */ }
    return out;
}

/** 额度（数字）/ 流水净额（只读快照，供计划与界面展示） */
function snapOf(c) {
    const hist = Array.isArray(c && c.history) ? c.history : [];
    return {
        id: String((c && c.id) || ''),
        owner: String((c && c.owner) || ''),
        name: String((c && c.name) || ''),
        unit: String((c && c.unit) || ''),
        amount: Number((c && c.amount) || 0),
        note: String((c && c.note) || ''),
        date: String((c && c.date) || ''),
        uses: Number((c && c.uses) || 0) || 0,
        floorStart: Number((c && c.floorStart) || 0) || 0,
        floorEnd: Number((c && c.floorEnd) || 0) || 0,
        flows: hist.length,
        net: roundMoney(moneyNet(hist)),
    };
}

/** 合并后取「最新」的排序键：date 优先，其次 floorEnd（缺失时 0） */
function newerThan(a, b) {
    const da = String(a.date || ''), db = String(b.date || '');
    if (da !== db) return da > db;
    return Number(a.floorEnd || 0) >= Number(b.floorEnd || 0);
}

/**
 * **货币修正计划**（只读，零副作用）。
 * @param {{includeUntracked?:boolean}} [opts] `includeUntracked=true` → 未标定角色的货币也列入剔除
 * @returns {{ok:boolean, scanned:number, me:string, meConfirmed:boolean, roster:string[], includeUntracked:boolean,
 *   drop:Array, merge:Array, fix:Array, report:Array, counts:object}}
 */
function currencyRepairPlan(opts) {
    const o = opts || {};
    const includeUntracked = o.includeUntracked === true;
    const list = Array.isArray(state.currencies) ? state.currencies : [];
    const me = String(defaultCurrencyOwner() || '主角');
    const meConfirmed = normKey(me) !== normKey('主角') && normKey(me) !== '';
    const roster = currencyOwnerRoster();
    const tracked = (() => { try { return trackedCurrencyRoles(); } catch (e) { return []; } })();
    const out = {
        ok: true, scanned: list.length, me: me, meConfirmed: meConfirmed, roster: roster, tracked: tracked,
        includeUntracked: includeUntracked, untrackedAvailable: meConfirmed,
        drop: [], merge: [], fix: [], report: [],
        counts: { drop: 0, mergeGroups: 0, mergeRemoved: 0, fix: 0, report: 0, total: 0 },
    };
    const snaps = list.map(snapOf);
    const dropped = new Set();

    // ---------- ① 逐条判定：剔除 / 修正 / 报告 ----------
    for (const c of snaps) {
        if (!c.id) continue;
        // 空壳（无额度 / 无单位 / 无备注 / 无流水）
        if (c.amount === 0 && !c.unit && !c.note && !c.flows) {
            out.drop.push({ id: c.id, owner: c.owner, name: c.name, unit: c.unit, amount: c.amount, reason: 'empty', detail: '空壳条目（无额度 / 单位 / 备注 / 流水）' });
            dropped.add(c.id);
            continue;
        }
        // 币种名本身就是单位词且未写单位 → 提取错误，无法还原意图
        if (BARE_UNIT_SET.has(normKey(c.name)) && !c.unit) {
            out.drop.push({ id: c.id, owner: c.owner, name: c.name, unit: c.unit, amount: c.amount, reason: 'name-is-unit', detail: '币种名是计价单位词（「' + c.name + '」）且未写单位 → 提取错误' });
            dropped.add(c.id);
            continue;
        }
        // 归属
        const known = roster.some((n) => ownerLike(n, c.owner)) || tracked.some((n) => ownerLike(n, c.owner));
        const isMe = ownerLike(me, c.owner);
        const isTracked = tracked.some((n) => ownerLike(n, c.owner));
        if (!known) {
            out.drop.push({ id: c.id, owner: c.owner, name: c.name, unit: c.unit, amount: c.amount, reason: 'ghost-owner', detail: '归属不在已知角色名册（幽灵角色）' });
            dropped.add(c.id);
            continue;
        }
        if (!isMe && !isTracked) {
            // **护栏**：默认归属若是兜底字面量「主角」（= 主角身份没确证），就**不允许**按「未标定」剔除 ——
            //   否则一个角色都对不上号（全都不等于「主角」）→ 会把**全部**货币误删（真机数据实测：20 → 0 条）。
            if (includeUntracked && meConfirmed) {
                out.drop.push({ id: c.id, owner: c.owner, name: c.name, unit: c.unit, amount: c.amount, reason: 'untracked-owner', detail: '未标定角色，且非默认归属（已勾选一并剔除）' });
                dropped.add(c.id);
                continue;
            }
            out.report.push({
                id: c.id, owner: c.owner, name: c.name, unit: c.unit, amount: c.amount, reason: 'owner-untracked',
                blocked: !meConfirmed,
                detail: meConfirmed
                    ? '未标定角色且非默认归属（默认保留；勾选「同时剔除未标定角色」可剔除，或先在货币页标定）'
                    : '未标定且非默认归属；但默认归属是兜底值「主角」（主角身份未确证）→ **只报告不剔除**（请先给主角打「主角/玩家」标签，或用「👥 指定角色」标定要跟踪的角色）',
            });
        }
        // ② 计价单位归一
        const cu = canonicalUnit(c.unit);
        if (cu && cu !== c.unit.trim()) {
            out.fix.push({ id: c.id, owner: c.owner, name: c.name, field: 'unit', from: c.unit, to: cu, reason: 'unit-alias', detail: '单位写法归一：' + c.unit + ' → ' + cu });
        } else if (c.unit && !unitIsKnown(c.unit)) {
            out.report.push({ id: c.id, owner: c.owner, name: c.name, unit: c.unit, amount: c.amount, reason: 'unit-nonstandard', detail: '非标准计价单位「' + c.unit + '」（建议改为 两 / 枚 / 文 一类）' });
        }
        // ② 额度缺省 → 用流水净额补齐（只补 0）
        if (c.amount === 0 && c.flows && c.net !== 0) {
            out.fix.push({ id: c.id, owner: c.owner, name: c.name, field: 'amount', from: 0, to: roundMoney(c.net), reason: 'amount-from-history', detail: '额度缺省 → 用流水净额补齐（' + roundMoney(c.net) + '）' });
        } else if (c.amount < 0 && c.net > 0) {
            out.report.push({ id: c.id, owner: c.owner, name: c.name, unit: c.unit, amount: c.amount, reason: 'amount-mismatch', detail: '额度为负（' + c.amount + '）而流水净额为正（' + c.net + '）→ 符号矛盾，交人工核对' });
        }
    }

    // ---------- ③ 冗余合并（只对未被剔除的条目分组） ----------
    const groups = new Map();
    for (const c of snaps) {
        if (!c.id || dropped.has(c.id)) continue;
        const key = normKey(c.owner) + '|' + canonicalName(c.name);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
    }
    for (const [key, members] of groups) {
        if (members.length < 2) continue;
        const units = [...new Set(members.map((m) => canonicalUnit(m.unit)).filter(Boolean))];
        if (units.length > 1) {
            for (const m of members) {
                out.report.push({ id: m.id, owner: m.owner, name: m.name, unit: m.unit, amount: m.amount, reason: 'unit-conflict', detail: '同归属同币种却存在多种单位（' + units.join(' / ') + '）→ 不相加，只报告' });
            }
            continue;
        }
        const keep = members.slice().sort((a, b) => (newerThan(a, b) ? -1 : 1))[0];
        const rest = members.filter((m) => m.id !== keep.id);
        const merged = {
            key: key, owner: keep.owner, canonical: canonicalName(keep.name), unit: units[0] || '',
            keepId: keep.id, removedIds: rest.map((m) => m.id),
            amount: roundMoney(keep.amount), newestDate: keep.date, uses: members.reduce((s, m) => s + (Number(m.uses) || 0), 0),
            members: members.map((m) => ({ id: m.id, name: m.name, unit: m.unit, amount: m.amount, date: m.date, flows: m.flows, net: m.net })),
            detail: '同归属同币种 ' + members.length + ' 条 → 合 1 条（保留最新额度 ' + roundMoney(keep.amount) + '，不累加）',
        };
        out.merge.push(merged);
        for (const m of rest) {
            out.drop.push({ id: m.id, owner: m.owner, name: m.name, unit: m.unit, amount: m.amount, reason: 'merged', detail: '并入「' + keep.name + '」（' + m.id + ' → ' + keep.id + '）' });
            dropped.add(m.id);
        }
    }

    out.counts.drop = out.drop.length;
    out.counts.mergeGroups = out.merge.length;
    out.counts.mergeRemoved = out.merge.reduce((s, m) => s + m.removedIds.length, 0);
    // 被剔除 / 被合并掉的条目不再出现在「修正」与「报告」里（否则预览会列出对已删条目的修正，误导用户）
    out.fix = out.fix.filter((f) => !dropped.has(f.id));
    out.report = out.report.filter((r) => !dropped.has(r.id));
    out.counts.fix = out.fix.length;
    out.counts.report = out.report.length;
    out.counts.total = out.counts.drop + out.counts.fix + out.counts.mergeGroups;
    return out;
}

/**
 * **应用货币修正**（写盘 + 留墓碑 + 通知）。
 * @param {{includeUntracked?:boolean, dryRun?:boolean, quiet?:boolean}} [opts]
 * @returns {{ok:boolean, changed:boolean, before:number, after:number, dropped:number, merged:number, mergedRemoved:number, fixed:number, summary:string, plan:object}}
 */
function runCurrencyRepair(opts) {
    const o = opts || {};
    const plan = currencyRepairPlan(o);
    const before = (Array.isArray(state.currencies) ? state.currencies.length : 0);
    const empty = {
        ok: true, changed: false, before: before, after: before, dropped: 0, merged: 0, mergedRemoved: 0, fixed: 0,
        summary: '未发现需要修正的货币条目', plan: plan,
    };
    if (o.dryRun === true || !plan.counts.total) return empty;
    try {
        const dropIds = new Set(plan.drop.map((d) => d.id));
        // 同一条目可能**同时**有单位归一与额度补齐两条修正 → 键必须是 `id|字段`（按 id 建 Map 会互相覆盖）
        const fixOf = new Map(plan.fix.map((f) => [f.id + '|' + f.field, f]));
        const mergeKeep = new Map(plan.merge.map((m) => [m.keepId, m]));
        const src = Array.isArray(state.currencies) ? state.currencies : [];
        const droppedEntries = [];
        const next = [];
        for (const c of src) {
            const id = String((c && c.id) || '');
            if (dropIds.has(id)) { droppedEntries.push(c); continue; }
            if (!c || typeof c !== 'object') { next.push(c); continue; }
            const m = mergeKeep.get(id);
            if (m) {
                const members = src.filter((x) => x && (String(x.id) === id || m.removedIds.indexOf(String(x.id)) >= 0));
                const note = members.map((x) => String((x && x.note) || '')).sort((a, b) => b.length - a.length)[0] || '';
                const tags = (() => {
                    const seen = new Set(); const outTags = [];
                    for (const x of members) for (const t of (Array.isArray(x && x.tags) ? x.tags : [])) { const k = String(t); if (!k || seen.has(k)) continue; seen.add(k); outTags.push(k); }
                    return outTags.slice(0, 8);
                })();
                let hist = [];
                for (const x of members) hist = mergeMoneyHistory(hist, Array.isArray(x && x.history) ? x.history : []);
                const starts = members.map((x) => Number((x && x.floorStart) || 0) || 0).filter((n) => n > 0);
                const ends = members.map((x) => Number((x && x.floorEnd) || 0) || 0).filter((n) => n > 0);
                const dates = members.map((x) => String((x && x.date) || '')).filter(Boolean).sort();
                next.push(Object.assign({}, c, {
                    unit: m.unit || c.unit || '',
                    note: note,
                    tags: tags,
                    history: hist,
                    uses: members.reduce((s, x) => s + (Number(x && x.uses) || 0), 0),
                    date: dates.length ? dates[dates.length - 1] : c.date,
                    floorStart: starts.length ? Math.min.apply(null, starts) : (c.floorStart || 0),
                    floorEnd: ends.length ? Math.max.apply(null, ends) : (c.floorEnd || 0),
                    title: c.title || c.name,
                    content: note || c.content || '',
                }));
                continue;
            }
            const fUnit = fixOf.get(id + '|unit');
            const fAmt = fixOf.get(id + '|amount');
            if (fUnit || fAmt) {
                const patched = Object.assign({}, c);
                if (fUnit) patched.unit = fUnit.to;
                if (fAmt) patched.amount = Number(fAmt.to) || 0;
                next.push(patched);
            } else next.push(c);
        }
        state.currencies = next;
        // 删除留痕：id 墓碑 + 内容哈希墓碑（跨端不会复活）
        try { tombMany('currencies', droppedEntries.map((x) => String((x && x.id) || '')).filter(Boolean)); } catch (e) { /* 忽略 */ }
        try { tombEntries('currencies', droppedEntries); } catch (e) { /* 忽略 */ }
        try { saveState(); } catch (e) { /* 落盘失败不阻塞 */ }
        const after = next.length;
        const parts = [];
        if (plan.counts.drop) parts.push('剔除 ' + plan.counts.drop + ' 条（幽灵角色 / 未标定 / 提取错误 / 空壳 / 合并并入）');
        if (plan.counts.mergeGroups) parts.push('合并 ' + plan.counts.mergeGroups + ' 组冗余（- ' + plan.counts.mergeRemoved + ' 条）');
        if (plan.counts.fix) parts.push('修正 ' + plan.counts.fix + ' 处计价（单位归一 / 额度补齐）');
        if (plan.counts.report) parts.push('另 ' + plan.counts.report + ' 处只报告未改（单位冲突 / 非标准单位 / 未标定角色 / 额度矛盾）');
        const summary = (parts.length ? parts.join('；') : '无需修正') + '（' + before + ' → ' + after + ' 条）';
        if (o.quiet !== true) notify('success', '货币修正完成', summary);
        try {
            dbgLog('摘要', {
                action: '货币修正（v3.15.0 机械修正）', before: before, after: after,
                dropped: plan.counts.drop, mergeGroups: plan.counts.mergeGroups, merged: plan.counts.mergeRemoved,
                fixed: plan.counts.fix, report: plan.counts.report, includeUntracked: plan.includeUntracked === true,
            });
        } catch (e) { /* 忽略 */ }
        return {
            ok: true, changed: true, before: before, after: after,
            dropped: plan.counts.drop, merged: plan.counts.mergeGroups, mergedRemoved: plan.counts.mergeRemoved,
            fixed: plan.counts.fix, summary: summary, plan: plan,
        };
    } catch (e) {
        try { warn('货币修正失败', e); } catch (e2) { /* 忽略 */ }
        notify('error', '货币修正失败', String((e && e.message) || e).slice(0, 100));
        return { ok: false, changed: false, before: before, after: before, error: String((e && e.message) || e), plan: plan };
    }
}

export {
    CURRENCY_UNIT_ALIASES, CURRENCY_UNIT_KNOWN, CURRENCY_NAME_ALIASES, CURRENCY_BARE_UNIT_NAMES,
    canonicalUnit, canonicalName, unitIsKnown, currencyOwnerRoster, currencyRepairPlan, runCurrencyRepair,
};
