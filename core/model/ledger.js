// ============================================================
// core/model/ledger.js —— **收支记录（账本）**（v3.51.0，`docs/D53` §3.3 · `docs/D22` W32 `数-43`/`数-45`）
//
// 用户要求（原话）：「货币拆分子页 … 额外增加**收支记录**，类似记账… 其中记账**必须依赖于货币总览**，
//   每一笔费用无论是收入还是支出，都**必须对应一个货币**。且双方有**联动**，当出现收入、支出时，对应的货币要变动。」
// 又（v1.1 第 3 条）：「**货币消失 → 其流水跟随消失（不做孤儿记录）**」。
//
// 为什么必须新建原子容器（`docs/D53` §3.2）：`currencies` 在跨端是**非原子容器**（整容器哈希 + 整份替换），
//   把记账写在 `currencies[].history` 里会被对端整份覆盖；且 `history` 只保留最近 N 笔（摘要视图）。
//   因此：**权威账本 = `ledger`（原子容器，逐条合并 + 逐条墓碑）**，`currencies[].history` 降级为
//   「该货币条目内最近 N 笔**摘要视图**」（`N` = `cfg.currencyHistoryMax`，默认 60），派生方向**单向**：
//   `ledger` → `history`（禁止把 `history` 当记账手段）。
//
// 本模块口径：
//   · 每条流水必挂 `currencyId`（不存在 → **拒绝**，绝不生成无主流水，也绝不自动新建货币）；
//   · 记账一次 = 写 `ledger` + 更新 `currencies[i].amount` + 追加 `history` 摘要（同一入口，禁止旁路写 `amount`）；
//   · 幂等：`id = led_<hash(currencyId|date|delta|note)>` —— 重复提交得到同一条（不重复扣款）；
//   · 删除：用户显式删除才反向冲正 + 写墓碑；**因货币消失而级联删除**同样逐条写墓碑（跨端不复活）。
// ============================================================
import { cfg, state } from './runtime.js';
import { hashText, normText } from '../util.js';
import { roundMoney, normalizeMoneyHistory } from './money.js';
import { clockDateTrim } from '../clock.js';
import { BIG_DATE_FIELD_MAX } from './bigdate.js';
import { tombSet } from '../merge.js';

/** 流水来源（冻结枚举；`deal` = 长期收支触发器兑现，`migrate` = 老 `history` 回填） */
export const LEDGER_SOURCES = Object.freeze(['manual', 'quick', 'ai', 'deal', 'repair', 'migrate']);

/** 条目内摘要上限（`cfg.currencyHistoryMax`，默认 60；建议范围 10–200） */
export function currencyHistoryMax() {
    const n = Number(cfg && cfg.currencyHistoryMax);
    return Math.max(10, Math.min(200, Number.isFinite(n) ? Math.round(n) : 60));
}

/** 流水 id（幂等键：同一货币 + 同日期 + 同金额 + 同说明 → 同一条） */
export function ledgerIdOf(currencyId, date, delta, note) {
    const key = [String(currencyId || ''), String(date || '').trim(), String(Number(delta) || 0), String(note || '').trim()].join('|');
    return 'led_' + hashText(key);
}

/** 归一化一条流水（`docs/D53` §3.3）—— 缺关键字段 → `null`（调用方据此拒绝并留痕） */
export function normalizeLedgerEntry(e) {
    try {
        const src = (e && typeof e === 'object') ? e : {};
        const currencyId = normText(src.currencyId !== undefined ? src.currencyId : (src['货币'] || src.currency), 60);
        const date = clockDateTrim(normText(src.date !== undefined ? src.date : src['日期'], BIG_DATE_FIELD_MAX));
        const delta = roundMoney(Number(src.delta !== undefined ? src.delta : (src['金额'] !== undefined ? src['金额'] : src.amount)));
        if (!currencyId || !date || !Number.isFinite(delta) || delta === 0) return null;
        const note = normText(src.note !== undefined ? src.note : (src['说明'] || src.desc), 80);
        const source = LEDGER_SOURCES.indexOf(String(src.source || '')) >= 0 ? String(src.source) : 'manual';
        const owner = normText(src.owner !== undefined ? src.owner : src['归属'], 40);
        return {
            id: String(src.id || ledgerIdOf(currencyId, date, delta, note)),
            currencyId: currencyId,
            owner: owner,
            date: date,
            delta: delta,
            note: note,
            source: source,
            dealId: normText(src.dealId || '', 60),
            // 通用元字段（沿用 02 §1.3；不参与内容哈希）
            floorSeen: Number.isInteger(Number(src.floorSeen)) && Number(src.floorSeen) > 0 ? Number(src.floorSeen) : 0,
            updatedAt: Number(src.updatedAt) || 0,
        };
    } catch (e) { return null; }
}

/** 当前账本（数组；缺失即空） */
export function ledgerList() {
    try { return Array.isArray(state.ledger) ? state.ledger : []; } catch (e) { return []; }
}
/** 某货币的流水（按日期升序） */
export function ledgerOf(currencyId) {
    const id = String(currencyId || '');
    return ledgerList().filter((x) => x && String(x.currencyId) === id).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
}
/** 某货币的流水净额 */
export function ledgerSum(currencyId) {
    return roundMoney(ledgerOf(currencyId).reduce((s, x) => s + (Number(x.delta) || 0), 0));
}
/** 找货币条目 */
export function findCurrency(currencyId) {
    const id = String(currencyId || '');
    if (!id) return null;
    try { return (state.currencies || []).filter((c) => c && String(c.id) === id)[0] || null; } catch (e) { return null; }
}

/**
 * **记一笔**（唯一记账入口 · `docs/D53` §3.5）：校验货币存在 → 写 `ledger` → 更新余额 → 刷新 `history` 摘要。
 * @param {object} raw 流水（`currencyId` 必填）
 * @param {{date?:string, source?:string, dealId?:string, now?:number}} [opts]
 * @returns {{ok:boolean, entry?:object, duplicate?:boolean, error?:string, amountBefore?:number, amountAfter?:number}}
 */
export function applyLedgerEntry(raw, opts) {
    try {
        const o = opts || {};
        const entry = normalizeLedgerEntry(Object.assign({}, raw, {
            source: (raw && raw.source) || o.source || 'manual',
            dealId: (raw && raw.dealId) || o.dealId || '',
            updatedAt: Number(o.now) || Date.now(),
        }));
        if (!entry) return { ok: false, error: '流水不完整（需要货币 / 日期 / 金额且金额不为 0）' };
        const cur = findCurrency(entry.currencyId);
        if (!cur) return { ok: false, error: '找不到对应的货币记录 —— 记账必须挂在一个现存货币上（不会自动新建货币）' };
        state.ledger = Array.isArray(state.ledger) ? state.ledger : [];
        const dup = state.ledger.filter((x) => x && String(x.id) === entry.id)[0];
        if (dup) return { ok: true, duplicate: true, entry: dup, amountBefore: Number(cur.amount) || 0, amountAfter: Number(cur.amount) || 0 };
        const amountBefore = roundMoney(Number(cur.amount) || 0);
        const amountAfter = roundMoney(amountBefore + entry.delta);
        state.ledger.push(entry);
        cur.amount = amountAfter;
        cur.updatedAt = entry.updatedAt;                       // v3.50.32 口径：条目级修改时间（跨端仲裁用）
        cur.history = normalizeMoneyHistory((Array.isArray(cur.history) ? cur.history : []).concat([{ date: entry.date, delta: entry.delta, note: entry.note }]));
        if (!cur.owner && entry.owner) cur.owner = entry.owner;
        return { ok: true, entry: entry, amountBefore: amountBefore, amountAfter: amountAfter };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** 用户**显式删除**一笔（反向冲正余额 + 写墓碑）*/
export function deleteLedgerEntry(id) {
    try {
        const key = String(id || '');
        const list = ledgerList();
        const idx = list.findIndex((x) => x && String(x.id) === key);
        if (idx < 0) return { ok: false, error: '找不到这笔流水' };
        const entry = list[idx];
        const cur = findCurrency(entry.currencyId);
        list.splice(idx, 1);
        state.ledger = list;
        if (cur) {
            cur.amount = roundMoney((Number(cur.amount) || 0) - (Number(entry.delta) || 0));
            cur.updatedAt = Date.now();
            cur.history = normalizeMoneyHistory((Array.isArray(cur.history) ? cur.history : []).filter((f) => !(f && String(f.date) === String(entry.date) && Number(f.delta) === Number(entry.delta) && String(f.note || '') === String(entry.note || ''))));
        }
        try { tombSet('ledger', key); } catch (e) { /* 忽略：墓碑写失败只是留痕缺失 */ }
        return { ok: true, entry: entry };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/**
 * **货币消失 → 其流水级联删除**（`docs/D53` §3.5 · 用户 v1.1 第 3 条，`D28` 登记的例外）。
 * 只删 `ledger`；**不删** `deals`（标的物保留、触发器停摆）。逐条写墓碑防跨端复活。
 * @returns {{removed:number, ids:string[]}}
 */
/** UI 用别名：条目内摘要上限 */
export function currencyHistoryMaxOf() { return currencyHistoryMax(); }

export function cascadeDeleteLedgerForCurrency(currencyId) {
    const id = String(currencyId || '');
    const out = { removed: 0, ids: [] };
    try {
        if (!id) return out;
        const keep = [];
        for (const x of ledgerList()) {
            if (x && String(x.currencyId) === id) {
                try { tombSet('ledger', String(x.id)); } catch (e) { /* 忽略 */ }
                out.removed += 1; out.ids.push(String(x.id));
            } else keep.push(x);
        }
        if (out.removed) state.ledger = keep;
    } catch (e) { /* 忽略 */ }
    return out;
}

/** 对账（**只报不改**）：余额 vs 流水净额 */
export function reconcileLedger() {
    const rows = [];
    try {
        for (const c of (state.currencies || [])) {
            if (!c || !c.id) continue;
            const sum = ledgerSum(c.id);
            const amount = roundMoney(Number(c.amount) || 0);
            const diff = roundMoney(amount - sum);
            rows.push({ currencyId: String(c.id), owner: String(c.owner || ''), name: String(c.name || ''), amount: amount, sum: sum, diff: diff });
        }
    } catch (e) { /* 忽略 */ }
    return rows;
}

/** 孤儿流水（指向不存在的货币；正常应由级联删除清掉，这里只报）*/
export function orphanLedgerEntries() {
    const ids = new Set(((state.currencies) || []).map((c) => String(c && c.id)).filter(Boolean));
    return ledgerList().filter((x) => x && !ids.has(String(x.currencyId)));
}

/** 老存档 `history` → `ledger` 回填（`D53` Q2 裁决：**回填**，`source:'migrate'`，按 id 幂等）*/
export function backfillLedgerFromHistory() {
    const out = { added: 0, scanned: 0 };
    try {
        state.ledger = Array.isArray(state.ledger) ? state.ledger : [];
        const have = new Set(state.ledger.map((x) => String(x && x.id)));
        for (const c of (state.currencies || [])) {
            if (!c || !c.id) continue;
            for (const f of (Array.isArray(c.history) ? c.history : [])) {
                const delta = roundMoney(Number(f && f.delta));
                if (!Number.isFinite(delta) || delta === 0) continue;
                out.scanned += 1;
                const date = clockDateTrim(normText(f.date, BIG_DATE_FIELD_MAX));
                if (!date) continue;
                const note = normText(f.note, 80);
                const id = ledgerIdOf(c.id, date, delta, note);
                if (have.has(id)) continue;
                state.ledger.push(Object.assign(normalizeLedgerEntry({ id: id, currencyId: c.id, owner: c.owner, date: date, delta: delta, note: note, source: 'migrate' }) || {}, { id: id }));
                have.add(id);
                out.added += 1;
            }
        }
    } catch (e) { /* 忽略 */ }
    return out;
}
