// ============================================================
// core/model/money.js —— **逐字移植自 V1**（V1 src/modules/07-原子层与数据归一化.js（货币大类））
// 移植口径同 core/model/scalars.js：算法/字段名/字段顺序不变；仅 ESM 化 + 注入视图（cfg/state/getStoryNow）。
// 一致性由 tests/unit/model-golden*.test.js 的黄金样本强制校验。
// ============================================================
import { normText, normalizeList, clamp, hashText } from '../util.js';
import { cfg, defaultCfg, state, saveCfg } from './runtime.js';
import { dimCap, makeExtra, mergeTags, normalizeTrackedRoles, splitListText } from './scalars.js';

const MONEY_TIERS = [
    { v: 1e20, s: '垓' }, { v: 1e16, s: '京' }, { v: 1e12, s: '兆' }, { v: 1e8, s: '亿' }, { v: 1e4, s: '万' },
];

function formatMoney(n) {
    try {
        const num = Number(n);
        if (!Number.isFinite(num)) return '';
        const neg = num < 0;
        const abs = Math.abs(num);
        const cut = (x) => {
            const r = Math.round(x * 100) / 100;
            return String(r).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
        };
        let txt = '';
        for (const t of MONEY_TIERS) {
            if (abs >= t.v) { txt = `${cut(abs / t.v)}${t.s}`; break; }
        }
        if (!txt) {
            // 万以下：整数用千分位；小数保留最多 2 位
            const r = Math.round(abs * 100) / 100;
            const intPart = Math.trunc(r);
            const dec = Math.round((r - intPart) * 100) / 100;
            txt = String(intPart).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? String(dec).slice(1) : '');
            if (txt === '0' && r > 0) txt = String(r);
        }
        return (neg ? '-' : '') + txt;
    } catch (e) { return ''; }
}
// 金额取整（避免浮点尾差）与收支净额

function roundMoney(n) { const v = Number(n); return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0; }

function moneyNet(history) {
    try { return (Array.isArray(history) ? history : []).reduce((s, f) => s + (Number(f && f.delta) || 0), 0); } catch (e) { return 0; }
}
// 单条收支：{ 日期, 增减(收入/支出), 数额, 说明 } → 归一化（Keep last N in merge）

function normalizeMoneyFlow(raw) {
    try {
        if (!raw || typeof raw !== 'object') return null;
        const deltaRaw = raw['增减'] !== undefined ? raw['增减'] : (raw.delta !== undefined ? raw.delta : (raw.direction !== undefined ? raw.direction : raw.type));
        const dir = String(deltaRaw == null ? '' : deltaRaw).trim();
        const out = String(raw['数额'] !== undefined ? raw['数额'] : (raw.amount !== undefined ? raw.amount : raw.value)).replace(/[,，\s]/g, '');
        const amt = Number(out);
        if (!Number.isFinite(amt) || amt === 0) return null;
        const isExpense = /支出|花|付|消费|减少|扣|出账|expense|out|minus|-/i.test(dir);
        const isIncome = /收入|收|得|获|进账|增加|income|in|plus|\+/i.test(dir);
        const sign = isExpense ? -1 : (isIncome ? 1 : (amt < 0 ? -1 : 1));
        const val = Math.abs(amt) * sign;
        const note = dimCap('currencies', normText(raw['说明'] !== undefined ? raw['说明'] : (raw.note !== undefined ? raw.note : raw.desc), 80));
        const date = normText(raw['日期'] !== undefined ? raw['日期'] : raw.date, 10);
        return { date, delta: val, note };
    } catch (e) { return null; }
}

function normalizeMoneyHistory(raw) {
    try {
        const arr = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
        const out = [];
        for (const x of arr) { const f = normalizeMoneyFlow(x); if (f) out.push(f); }
        return out.slice(-12);   // 只留最近 12 笔（防条目无限膨胀）
    } catch (e) { return []; }
}
// 货币条目归一化：归属（默认主角）/ 币种 / 额度（数字）/ 单位 / 收支 / 备注

function normalizeCurrency(e) {
    const name = normText(e?.name || e?.['币种'] || e?.currency, 40);
    if (!name) return null;
    const owner = normText(e?.owner || e?.['归属'] || e?.holder, 40) || defaultCurrencyOwner();
    const ownerKey = String(owner).replace(/\s+/g, '').toLowerCase();
    const nameKey = String(name).replace(/\s+/g, '').toLowerCase();
    const amtRaw = String(e?.amount ?? e?.['额度'] ?? e?.balance ?? '').replace(/[,，\s]/g, '');
    const fs = Number(e?.floorStart), fe = Number(e?.floorEnd);
    return {
        id: String(e?.id || `cur_${hashText(ownerKey + '|' + nameKey)}`),
        owner,
        name,
        unit: normText(e?.unit || e?.['单位'], 10),
        amount: Number.isFinite(Number(amtRaw)) ? Number(amtRaw) : 0,
        note: dimCap('currencies', normText(e?.note || e?.['备注'] || e?.desc, 200)),
        history: normalizeMoneyHistory(e?.history || e?.['收支'] || e?.flows),
        date: normText(e?.date || e?.seenDate, 10),
        uses: Number(e?.uses) || 0,
        floorStart: Number.isInteger(fs) && fs > 0 ? fs : 0,
        floorEnd: Number.isInteger(fe) && fe > 0 ? fe : 0,
        tags: mergeTags(Array.isArray(e?.tags) ? e?.tags : splitListText(e?.tags), e?.keywords),
        keywords: [],
        // 原子层：标准化字段 + 可扩展插槽（title=币种、content=备注，便于导出/索引/世界书复用既有渲染）
        category: 'currencies',
        title: name,
        content: dimCap('currencies', normText(e?.note || e?.['备注'] || e?.desc, 200)),
        strength: Math.round(clamp(Number(e?.importance) || 0.5, 0, 1) * 100),
        extra: makeExtra({ owner, unit: e?.unit, history: (e?.history || []).length, keywords: e?.keywords }),
    };
}
// 货币「归属」默认值 = 当前主角名（主角档案 / 状态主体 / 主角设定；都没有则「主角」）

function trackedCurrencyRoles() {
    try {
        const list = (cfg && cfg.currencyTrackedRoles !== undefined) ? cfg.currencyTrackedRoles
            : (defaultCfg && defaultCfg.currencyTrackedRoles);
        return (typeof normalizeTrackedRoles === 'function') ? normalizeTrackedRoles(list) : (Array.isArray(list) ? list.slice(0, 12) : []);
    } catch (e) { return []; }
}
// 归属是否属于「标定跟踪」（按规范化姓名比较：去空白 + 不区分大小写；支持简称包含匹配）

function isTrackedCurrencyOwner(owner) {
    try {
        const o = String(owner == null ? '' : owner).replace(/\s+/g, '').toLowerCase();
        if (!o) return false;
        return trackedCurrencyRoles().some((n) => {
            const k = String(n).replace(/\s+/g, '').toLowerCase();
            return !!k && (k === o || k.indexOf(o) >= 0 || o.indexOf(k) >= 0);
        });
    } catch (e) { return false; }
}
// 增 / 删 / 清空标定（UI 按钮与调试共用；返回最新名单）

function addTrackedCurrencyRole(name) {
    try {
        const nm = String(name == null ? '' : name).trim();
        if (!nm) return trackedCurrencyRoles();
        cfg.currencyTrackedRoles = normalizeTrackedRoles(trackedCurrencyRoles().concat([nm]));
        saveCfg();
        return trackedCurrencyRoles();
    } catch (e) { return trackedCurrencyRoles(); }
}

function removeTrackedCurrencyRole(name) {
    try {
        const nm = String(name == null ? '' : name).replace(/\s+/g, '').toLowerCase();
        cfg.currencyTrackedRoles = trackedCurrencyRoles().filter(n => String(n).replace(/\s+/g, '').toLowerCase() !== nm);
        saveCfg();
        return trackedCurrencyRoles();
    } catch (e) { return trackedCurrencyRoles(); }
}

function clearTrackedCurrencyRoles() {
    try { const n = trackedCurrencyRoles().length; cfg.currencyTrackedRoles = []; saveCfg(); return n; } catch (e) { return 0; }
}
// 可标定的「角色大类已知角色」（角色档案姓名；按名称去重排序）

function mergeMoneyHistory(oldArr, newArr) {
    const out = [];
    const seen = new Set();
    for (const f of [].concat(Array.isArray(oldArr) ? oldArr : [], Array.isArray(newArr) ? newArr : [])) {
        if (!f) continue;
        const k = `${f.date || ''}|${f.delta || 0}|${f.note || ''}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ date: String(f.date || ''), delta: Number(f.delta) || 0, note: String(f.note || '') });
    }
    return out.slice(-12);
}
// ==================== v1.182：情节分段总结（情节页「🧩 分段总结」专用） ====================
// 用户要求：把情节打包给 AI 拆成**多段总结**；每段以 `### 时间范围` 为头（Markdown 三级标题），
//   段内逐行给出剧情线（`1. 感情线: 概述`）；**该产物不注入给 AI**（不参与召回/遗忘/质检），
//   只做归档式整理与人工查阅 —— 保存后唯一消失途径 = **手动删除**（AI 运行永不删除、永不覆盖已存在段落）。
// 段落划分口径：以**情节分拆**为准（同一件事/同一因果链/同一时间段落归一段；不同线路与阶段分段）。
// 数据结构：{ id, header(时间范围原文), start, end, lines:[{label,text}], atomIds[], atomCount,
//   floorStart, floorEnd, raw(Markdown 原文), uses, manual(手动编辑过), createdAt, updatedAt }

function defaultCurrencyOwner() {
    try {
        if (state && state.protagonist) {
            const nm = String(state.protagonist.name || state.protagonist['姓名'] || '').trim();
            if (nm) return nm;
        }
        // 角色档案里带「主角」标签或与主角关系为自身的第一个
        const snaps = (state && state.snapshots) || [];
        for (const s of snaps) {
            if (!s || !s.name) continue;
            const tags = Array.isArray(s.tags) ? s.tags.map(String) : [];
            if (tags.some(t => /主角|玩家|我$/.test(t))) return String(s.name);
        }
        try { const me = (typeof getCurrentCharacterName === 'function') ? String(getCurrentCharacterName() || '').trim() : ''; if (me) return me; } catch (e) { }
    } catch (e) { }
    return '主角';
}
// ==================== v1.183：货币「标定角色」名单（用户指定跟踪的角色） ====================
// 用户要求：「货币需新增指定角色的按钮，可指定角色大类中已知角色作为新的标定」；
//   「被标定后，后续分析记忆应同时考虑对应角色货币情况」。
// 语义：名单存于配置 `currencyTrackedRoles`（随配置跨端同步）；命中名单的角色，其货币
//   ① 注入时与主角同等待遇（**恒定注入**，不再要求关键词/在场命中）；
//   ② 提示词里**恒定**追加「货币 · 标定跟踪」段，并把「当前货币账本」（主角 + 标定角色）作为更新参照。

function knownCharacterNames() {
    try {
        const out = [];
        for (const s of (state.snapshots || [])) {
            const nm = String((s && s.name) || '').trim();
            if (!nm || out.indexOf(nm) >= 0) continue;
            out.push(nm);
        }
        return out.sort((a, b) => a.localeCompare(b));
    } catch (e) { return []; }
}
// 收支合并：同条目更新时把新流水追加到旧流水尾部（去重：同日期同额同说明视为同一笔），保留最近 12 笔

export { formatMoney, roundMoney, moneyNet, normalizeMoneyFlow, normalizeMoneyHistory, normalizeCurrency, trackedCurrencyRoles, isTrackedCurrencyOwner, addTrackedCurrencyRole, removeTrackedCurrencyRole, clearTrackedCurrencyRoles, mergeMoneyHistory, defaultCurrencyOwner, knownCharacterNames };
