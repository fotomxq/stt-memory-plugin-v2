// ============================================================
// core/resume-batch.js —— **角色履历「批量合并执行」**的纯内核
//   （v3.47.0，`docs/D22` §4.16 **W16** `应-33`；设计稿 `docs/D38-履历批量完善设计稿.md`）
//
// 用户要求（原话）：「角色新增完善履历功能，该功能与修复角色平行。根据近期更新的记忆，抽取相关角色，
//   激活单一补全/修复履历的功能。注意是**批量合并执行**，以减少 AI 反复请求次数。」
//
// 与既有**个体**档（`core/character-repair.js#runResumeRepair`，角色行内「📜 补全 / 修复履历」）的关系：
//   · 个体档：一个角色 = 一次 AI 请求（N 个角色 → N 次）；
//   · **本档**：**一次请求处理一批角色**（输出按角色名分键），机械段与复核口径**逐条对齐个体档**：
//     先跑零 AI 的机械整理（`resumeMechanicalPassFor`：归一 / 去重 / 排序 / 遗弃 / 凝练）→ 再套 AI 结果 →
//     过 `resumeCanonGuard`（原作人物"剧情前生平"硬护栏）→ 逐角色落库 → **如实回报四类计数**。
//   · 两者**共用算法**（`core/resume.js` 的归一 / 排序 / 遗弃 / 凝练 / 统计 + `core/character-repair.js` 的机械段），
//     不造第二套真相；个体档行为**零变化**。
//
// 三步（对应设计稿 §3）：
//   ① **按"近期更新的记忆"抽角色**：在近期窗口内扫 `state.memories`（`date` 落在窗口内，或没有日期时按条目序取最近 N 条），
//      命中判据 = `owner` 完全相同 **或** 记忆标题 / 正文里出现该角色名 → 每个角色累计命中数与最近日期；
//   ② **打包**：为选中的角色各出一节（档案摘要 / 现有履历 / 该角色的近期记忆行），**不含楼层正文、不调 `aiFeedText`**，
//      总字数超限时按"命中数降序"截断角色并**如实计数**；
//   ③ **一次请求 → 按角色分键拆回 → 机械复核 → 预览 → 确认后逐角色落库**（落盘一次）。
//
// 本模块是**纯内核**：不碰 DOM / 宿主 / 定时器（`check-core-purity.js` 强制）。
// ============================================================
import { state, cfg, saveState, dbgLog } from './model/runtime.js';
import { storageHash } from './envelope.js';
import {
    resumeOptsFromCfg, resumeNormList, resumeCanonGuard, resumeStats, resumeSort,
} from './resume.js';
import { resumeMechanicalPassFor, resumeClockDate } from './character-repair.js';

/** 运行时槽位：批量履历记录（末 5 条；不参与跨端同步） */
export const RESUME_BATCH_LOG_MAX = 5;

/** 默认值（`cfg` 读不到时兜底） */
export const RESUME_BATCH_DEFAULTS = Object.freeze({ days: 30, maxRoles: 8, memoryPerRole: 6, packMaxChars: 24000, linesPerRole: 24, memoryLineMax: 120 });

/** 读 `cfg`（缺省回退；只读） */
export function resumeBatchCfg() {
    const c = (cfg && typeof cfg === 'object') ? cfg : {};
    const num = (k, d) => { const n = Number(c[k]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
    return {
        enabled: c.resumeBatchEnabled !== false,
        days: Math.min(num('resumeBatchDays', RESUME_BATCH_DEFAULTS.days), 3650),
        maxRoles: Math.min(num('resumeBatchMaxRoles', RESUME_BATCH_DEFAULTS.maxRoles), 30),
        memoryPerRole: Math.min(num('resumeBatchMemoryPerRole', RESUME_BATCH_DEFAULTS.memoryPerRole), 30),
    };
}

const str = (v) => String(v == null ? '' : v);
const clip = (v, n) => { const s = str(v).replace(/\s+/g, ' ').trim(); return s.length > n ? (s.slice(0, n) + '…') : s; };
const dateOf = (v) => { const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(str(v).trim()); return m ? (m[1] + '-' + m[2] + (m[3] ? ('-' + m[3]) : '')) : ''; };
/** 日期 → 天数（解析不了返回 null） */
function dayNum(d) {
    const s = dateOf(d);
    if (!s) return null;
    const p = s.split('-');
    const t = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2] || 1));
    return Number.isFinite(t) ? Math.floor(t / 86400000) : null;
}

/** 全部角色档案名（含 `name` / 中文键归一后的名字） */
export function resumeBatchRoster() {
    const out = [];
    for (const s of ((state && state.snapshots) || [])) {
        const nm = str(s && s.name).trim();
        if (nm && out.indexOf(nm) < 0) out.push(nm);
    }
    return out;
}

/**
 * ① **按近期更新的记忆抽取相关角色**（`docs/D38` §3.1）。
 * @param {{days?:number, limit?:number, nowDate?:string}} [opts]
 * @returns {Array<{name:string, hits:number, lastDate:string, memoryIds:string[], lines:string[], hasResume:boolean, resumeLen:number, canon:boolean}>}
 */
export function resumeBatchCandidates(opts) {
    const o = opts || {};
    const conf = resumeBatchCfg();
    const days = Math.max(1, Number(o.days) || conf.days);
    const nowD = dayNum(o.nowDate || resumeClockDate());
    const roster = resumeBatchRoster();
    const mems = (Array.isArray(state && state.memories) ? state.memories : []).filter((m) => m && typeof m === 'object');
    // 窗口：有日期的按「当前剧情日期 − days」过滤；没有日期的一律**不算**窗口内（避免把远古条目当"近期"）
    const within = [];
    for (const m of mems) {
        const d = dayNum(m.date);
        if (nowD == null || d == null) { within.push({ m: m, inWindow: false, d: d }); continue; }
        within.push({ m: m, inWindow: (nowD - d) <= days && (nowD - d) >= 0, d: d });
    }
    const win = within.filter((x) => x.inWindow);
    // 命中的角色 → 累计
    const byName = new Map();
    const bump = (name, m, d, text) => {
        const nm = str(name).trim();
        if (!nm || roster.indexOf(nm) < 0) return;
        const r = byName.get(nm) || { name: nm, hits: 0, lastDate: '', memoryIds: [], lines: [] };
        r.hits += 1;
        const dd = d != null ? (dateOf(m.date) || '') : '';
        if (dd && dd > r.lastDate) r.lastDate = dd;
        const id = str(m.id);
        if (id && r.memoryIds.indexOf(id) < 0 && r.memoryIds.length < 40) r.memoryIds.push(id);
        if (text && r.lines.length < RESUME_BATCH_DEFAULTS.linesPerRole) r.lines.push(clip(text, RESUME_BATCH_DEFAULTS.memoryLineMax));
        byName.set(nm, r);
    };
    for (const x of win) {
        const m = x.m, d = x.d;
        const text = (dateOf(m.date) ? (dateOf(m.date) + ' ') : '') + (str(m.owner) ? ('（' + str(m.owner) + '）') : '') + (str(m.title) ? (str(m.title) + '：') : '') + str(m.content);
        const owner = str(m.owner).trim();
        if (owner && roster.indexOf(owner) >= 0) bump(owner, m, d, text);
        // 正文 / 标题里出现角色名 → 该角色也"被涉及"（与 `characterEvidencePack` 的命中口径一致）
        const hay = str(m.title) + ' ' + str(m.content) + ' ' + (Array.isArray(m.tags) ? m.tags.join(' ') : '');
        for (const nm of roster) { if (nm !== owner && hay.indexOf(nm) >= 0) bump(nm, m, d, text); }
    }
    const out = [];
    for (const r of byName.values()) {
        const snap = ((state && state.snapshots) || []).filter((s) => s && str(s.name).trim() === r.name)[0] || null;
        const list = Array.isArray(snap && snap.resume) ? snap.resume : [];
        let canon = false;
        try { canon = !!((snap && (snap.canon === true || snap.canonFlag === true)) || (snap && snap.source === 'canon')); } catch (e) { /* 忽略 */ }
        out.push(Object.assign({}, r, { lines: r.lines.slice(0, RESUME_BATCH_DEFAULTS.linesPerRole), hasResume: list.length > 0, resumeLen: list.length, canon: canon }));
    }
    out.sort((a, b) => (b.hits - a.hits) || String(b.lastDate).localeCompare(String(a.lastDate)) || a.name.localeCompare(b.name));
    const limit = Math.max(1, Number(o.limit) || out.length || 1);
    return out.slice(0, limit);
}

/** 角色档案摘要（与个体档提示词同口径：姓名 / 出身 / 背景资料.经历 概览） */
function digestOf(snap) {
    const bg = (snap && snap.background) || {};
    const out = { name: str(snap && snap.name), origin: clip(bg.origin, 60), history: clip(bg.history, 140), identity: '' };
    try {
        const id = [];
        for (const k of ['gender', 'ageNote', 'occupation', 'title']) if (snap && snap[k]) id.push(str(k) + '=' + clip(snap[k], 16));
        out.identity = id.join(' · ');
    } catch (e) { /* 忽略 */ }
    return out;
}

/**
 * ② **打包**：为选中的角色各出一节（档案摘要 / 现有履历 / 近期相关记忆行）。
 * **只读**、不含楼层正文、超限按命中数降序截断并如实计数。
 * @param {{names?:string[], days?:number, perRole?:number}} [opts] `names` 缺省 = 候选前 `cfg.resumeBatchMaxRoles` 名
 */
export function resumeBatchPack(opts) {
    const o = opts || {};
    const conf = resumeBatchCfg();
    const cands = resumeBatchCandidates({ days: o.days, limit: Math.max(conf.maxRoles, (o.names || []).length) });
    const byName = new Map(cands.map((c) => [c.name, c]));
    const wanted = (Array.isArray(o.names) && o.names.length ? o.names.map((x) => str(x).trim()) : cands.slice(0, conf.maxRoles).map((c) => c.name));
    const rcfg = resumeOptsFromCfg(cfg || {});
    const clock = resumeClockDate();
    const lines = [];
    const roles = [];
    let truncated = 0;
    lines.push('【当前剧情日期】' + (clock ? (clock + '（**不得**写入此日之后的事）') : '未知 —— 只补剧情内已发生的事'));
    lines.push('【简述字数上限】' + rcfg.summaryMax + ' 字；【履历条数上限】' + rcfg.max + ' 条/角色');
    for (const nm of wanted) {
        const snap = ((state && state.snapshots) || []).filter((s) => s && str(s.name).trim() === nm)[0];
        if (!snap) { continue; }
        const cand = byName.get(nm) || { hits: 0, lastDate: '', lines: [] };
        if (roles.length >= conf.maxRoles) { truncated += 1; continue; }
        const dg = digestOf(snap);
        const list = resumeSort(Array.isArray(snap.resume) ? snap.resume : []);
        const sec = [];
        sec.push('===== 角色：' + dg.name + (cand.canon ? '（**原作人物**：有独立于本剧情的既有生平 —— 可写，但**只限当前剧情日期之前已成立**的事）' : '') + ' =====');
        if (dg.identity || dg.origin || dg.history) {
            sec.push('【档案摘要】' + [dg.identity, dg.origin ? ('出身：' + dg.origin) : '', dg.history ? ('背景资料.经历概览：' + dg.history) : ''].filter(Boolean).join(' · '));
        }
        sec.push(list.length
            ? ('【现有履历（' + list.length + '/' + rcfg.max + ' 条，按剧情时间倒序；**不要重复**）】\n' + list.slice(0, RESUME_BATCH_DEFAULTS.linesPerRole).map((e) => '  - ' + str(e.date) + ' ｜ ' + clip(e.summary, rcfg.summaryMax)).join('\n'))
            : '【现有履历】（无）');
        const ml = (cand.lines || []).slice(0, Math.max(1, Number(o.perRole) || conf.memoryPerRole));
        sec.push(ml.length
            ? ('【近期更新的记忆（近 ' + conf.days + ' 天内命中 ' + cand.hits + ' 条' + (cand.lastDate ? ('，最近 ' + cand.lastDate) : '') + '；**首选依据**）】\n' + ml.map((t) => '  - ' + t).join('\n'))
            : '【近期更新的记忆】（窗口内无命中 —— **不要**凭空补写；宁缺毋滥）');
        const block = sec.join('\n');
        // 总量上限：超限时**停止加入**后续角色并如实计数（不静默截断半节）
        if (lines.join('\n').length + block.length > RESUME_BATCH_DEFAULTS.packMaxChars) { truncated += 1; continue; }
        lines.push(block);
        roles.push({ name: dg.name, canon: cand.canon, hits: cand.hits, lastDate: cand.lastDate, before: list.length, memoryIds: cand.memoryIds.slice(0, 12) });
    }
    const text = lines.join('\n');
    return {
        at: Date.now(), clockDate: clock, days: conf.days, roles: roles, truncated: truncated,
        counts: { roles: roles.length, candidates: cands.length, memories: roles.reduce((s, r) => s + r.hits, 0), chars: text.length },
        fp: storageHash(roles.map((r) => r.name + '|' + r.before + '|' + r.memoryIds.join(',')).join('~')),
        text: text,
    };
}

/** 从 AI 文本里抠 JSON（容忍 ```json 包裹与前后文字；要求 `characters` 数组） */
export function resumeBatchParse(text) {
    const s = str(text).trim();
    if (!s) return null;
    const tryParse = (t) => {
        try {
            const v = JSON.parse(t);
            if (!v || typeof v !== 'object') return null;
            if (Array.isArray(v.characters)) return { characters: v.characters, notes: str(v.notes) };
            // 兼容「以角色名为键」的对象形态：{"张三":{"新增":[…]}}
            const keys = Object.keys(v).filter((k) => {
                const x = v[k];
                if (!x || typeof x !== 'object') return false;
                const b = x['履历'] || x.resume || x;
                return Array.isArray(b['新增']) || Array.isArray(b.add) || Array.isArray(b['凝练']) || Array.isArray(b.condense);
            });
            if (keys.length) return { characters: keys.map((k) => Object.assign({ name: k }, v[k])), notes: '' };
            return null;
        } catch (e) { return null; }
    };
    let v = tryParse(s);
    if (v) return v;
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) { v = tryParse(fence[1].trim()); if (v) return v; }
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) { v = tryParse(s.slice(i, j + 1)); if (v) return v; }
    return null;
}

/**
 * ③ **窄契约校验**（逐条判据）：
 *   ① 角色名必须在**本次打包集合**内（精确匹配，不做模糊）；② 新增条目必须过 `resumeEntryNorm`（日期格式 / 简述长度 / 来源）；
 *   ③ **原作人物的"剧情前生平"硬护栏**（`resumeCanonGuard`）；④ 凝练只接受「更短且非空、≤简述上限」；
 *   ⑤ 每角色新增条数 ≤ `min(上限余量, 12)`；⑥ **不得晚于当前剧情日期**（护栏已含，另单独计数）。
 * @returns {{roles:Array, rejected:Array, reasons:object}}
 */
export function resumeBatchValidate(ai, pack) {
    const rcfg = resumeOptsFromCfg(cfg || {});
    const clock = (pack && pack.clockDate) || resumeClockDate();
    const inPack = new Set(((pack && pack.roles) || []).map((r) => r.name));
    const roles = [], rejected = [], reasons = {};
    const bump = (r) => { reasons[r] = (reasons[r] || 0) + 1; };
    for (const c of ((ai && ai.characters) || [])) {
        const name = str(c && c.name).trim();
        if (!inPack.has(name)) { rejected.push({ name: name, reason: 'role-not-packed' }); bump('role-not-packed'); continue; }
        const meta = ((pack.roles || []).filter((r) => r.name === name)[0]) || { canon: false, before: 0 };
        const snap = ((state && state.snapshots) || []).filter((s) => s && str(s.name).trim() === name)[0] || null;
        const prev = Array.isArray(snap && snap.resume) ? snap.resume : [];
        // 兼容两种形态：个体版同形的嵌套 `{履历:{新增,凝练}}`，以及平铺 `{新增,凝练}`
        const box = (c && (c['履历'] || c.resume)) || c || {};
        const addRaw = Array.isArray(box['新增']) ? box['新增'] : (Array.isArray(box.add) ? box.add : []);
        const condRaw = Array.isArray(box['凝练']) ? box['凝练'] : (Array.isArray(box.condense) ? box.condense : []);
        // ③ 原作人物硬护栏 / ⑥ 晚于当前剧情日期
        let kept = [];
        let canonRejected = 0;
        try {
            if (meta.canon) {
                const g = resumeCanonGuard(addRaw, clock);
                kept = resumeNormList(g.kept || []);
                canonRejected = (g.rejected || []).length;
            } else {
                kept = resumeNormList(addRaw);
            }
        } catch (e) { kept = []; }
        if (canonRejected) { bump('canon-after-clock'); }        // 硬护栏：不得晚于**当前剧情日期**（原作人物同样适用）
        // ⑤ 条数上限：**与个体档同口径** —— 这里只守"单轮每角色最多 12 条"的合理性上限；
        //    「超过履历上限（默认 30 条）」由**应用前的机械段**按「重要性 × 剧情时间」清算
        //    （与 `runResumeRepair` 完全一致：先机械整理 → 再套 AI 结果 → 下一轮机械段继续收敛）。
        const room = Math.max(1, Math.min(rcfg.max, 12));
        if (kept.length > room) { bump('over-role-cap'); kept = kept.slice(0, room); }
        // ④ 凝练：只接受更短
        const cond = [];
        for (const x of condRaw) {
            if (!x || typeof x !== 'object') continue;
            const newText = str(x['简述'] != null ? x['简述'] : x.summary).trim();
            if (!newText) { bump('condense-empty'); continue; }
            if (newText.length > rcfg.summaryMax) { bump('condense-too-long'); continue; }
            const key = str(x['原简述'] || x.origin).slice(0, 12);
            const dkey = dateOf(x['日期'] || x.date);
            const hit = prev.find((e) => (!dkey || dateOf(e.date) === dkey)
                && (!key || str(e.summary).indexOf(key) === 0 || str(e.summary).slice(0, 12) === key));
            if (!hit) { bump('condense-no-hit'); continue; }
            if (newText.length >= str(hit.summary).length) { bump('condense-not-shorter'); continue; }
            cond.push({ date: str(hit.date), origin: str(hit.summary).slice(0, 12), text: newText });
        }
        if (!kept.length && !cond.length) { rejected.push({ name: name, reason: 'no-op' }); continue; }
        roles.push({ name: name, canon: meta.canon === true, added: kept, condense: cond, canonRejected: canonRejected });
    }
    return { roles: roles, rejected: rejected, reasons: reasons };
}

/** 幂等签名：打包指纹 + 规范化结果 */
export function resumeBatchSig(pack, roles) {
    try {
        const norm = (Array.isArray(roles) ? roles : []).map((r) => [r.name, (r.added || []).map((e) => str(e.date) + str(e.summary).slice(0, 16)).join('+'), (r.condense || []).map((c) => c.date + c.text.slice(0, 8)).join('+')].join('|')).sort();
        return storageHash(str(pack && pack.fp) + '#' + norm.join('~'));
    } catch (e) { return ''; }
}

/**
 * ④ **应用**（逐角色：先跑零 AI 机械段 → 再套校验过的 AI 结果 → 落盘一次）。
 * 与个体档 `runResumeRepair` 的机械段与复核口径**逐条对齐**（共用 `resumeMechanicalPassFor` / `resumeNormList` / `resumeCanonGuard`）。
 * @returns {{ok:boolean, before:number, after:number, added:number, condensed:number, dropped:number, rejected:number, roles:Array, changed:boolean}}
 */
export function resumeBatchApply(plan, opts) {
    const o = opts || {};
    const rcfg = resumeOptsFromCfg(cfg || {});
    const out = { ok: true, before: 0, after: 0, added: 0, condensed: 0, dropped: 0, rejected: 0, roles: [], changed: false };
    let anyChanged = false;
    for (const r of ((plan && plan.roles) || [])) {
        const snap = ((state && state.snapshots) || []).filter((s) => s && str(s.name).trim() === r.name)[0];
        if (!snap) { out.roles.push({ name: r.name, ok: false, reason: 'no-role' }); continue; }
        const before = Array.isArray(snap.resume) ? snap.resume.length : 0;
        // 机械段（零 AI）：归一 / 去重 / 排序 / 遗弃 / 凝练
        let mech = { before: before, dropped: 0, condensed: 0, changed: false };
        try {
            mech = resumeMechanicalPassFor(snap, { max: rcfg.max, triggerRatio: rcfg.triggerRatio, immune: rcfg.immune, summaryMax: rcfg.summaryMax, nowMs: Date.now() });
        } catch (e) { /* 机械段失败不阻塞（AI 结果仍可写入） */ }
        let changed = mech.changed === true;
        out.dropped += Number(mech.dropped || 0);
        out.condensed += Number(mech.condensed || 0);
        // AI 新增
        let added = 0;
        if ((r.added || []).length) {
            const prev = Array.isArray(snap.resume) ? snap.resume : [];
            const merged = resumeNormList(prev.concat(r.added));
            const grew = merged.length - prev.length;
            if (grew > 0) { snap.resume = merged; added = grew; changed = true; }
        }
        // AI 凝练（只改简述）
        let cond = 0;
        for (const c of (r.condense || [])) {
            const hit = (Array.isArray(snap.resume) ? snap.resume : []).find((e) => dateOf(e.date) === c.date
                && (str(e.summary).indexOf(c.origin) === 0 || str(e.summary).slice(0, 12) === c.origin));
            if (!hit) continue;
            if (String(c.text).length >= String(hit.summary || '').length) continue;
            hit.summary = c.text;
            cond += 1; changed = true;
        }
        out.condensed += cond;
        out.added += added;
        out.before += before;
        const after = resumeStats(Array.isArray(snap.resume) ? snap.resume : [], { max: rcfg.max, triggerRatio: rcfg.triggerRatio, immune: rcfg.immune, summaryMax: rcfg.summaryMax });
        out.after += after.total;
        out.rejected += Number(r.canonRejected || 0);
        if (changed) anyChanged = true;
        out.roles.push({ name: r.name, ok: true, added: added, condensed: cond, dropped: Number(mech.dropped || 0), before: before, after: after.total, canon: r.canon === true, changed: changed });
    }
    out.changed = anyChanged;
    if (anyChanged) { try { saveState(); } catch (e) { /* 落盘失败不阻塞 */ } }
    if (o.quiet !== true) {
        try {
            dbgLog('摘要', {
                action: '履历批量完善（一次请求）', roles: (plan && plan.roles || []).length, added: out.added, condensed: out.condensed,
                dropped: out.dropped, rejected: out.rejected, before: out.before, after: out.after,
                truncated: ((plan && plan.pack && plan.pack.truncated) || 0), changed: out.changed,
            });
        } catch (e) { /* 忽略 */ }
    }
    return out;
}

/** 追加一条批量记录（末 5 条；不参与跨端同步） */
export function resumeBatchLogPush(rec) {
    try {
        const arr = Array.isArray(state.resumeBatchLog) ? state.resumeBatchLog : (state.resumeBatchLog = []);
        arr.push(Object.assign({ at: Date.now() }, rec || {}));
        while (arr.length > RESUME_BATCH_LOG_MAX) arr.shift();
        return arr.length;
    } catch (e) { return 0; }
}
/** 只读副本 */
export function resumeBatchLogList() { try { return (Array.isArray(state.resumeBatchLog) ? state.resumeBatchLog : []).map((x) => Object.assign({}, x)); } catch (e) { return []; } }

/** 提示行（面板 `setNote` 与 toast 共用同一份措辞；与个体档的"新增 / 凝练 / 遗弃 / 现有"对齐） */
export function resumeBatchNoteText(applied, plan) {
    const a = applied || {};
    const parts = [];
    parts.push('角色 ' + Number((a.roles || []).length) + ' 名（**一次** AI 请求）');
    parts.push('新增 ' + Number(a.added || 0) + ' 条');
    parts.push('凝练 ' + Number(a.condensed || 0) + ' 条');
    parts.push('遗弃 ' + Number(a.dropped || 0) + ' 条');
    if (Number(a.rejected || 0)) parts.push('拒收 ' + Number(a.rejected) + ' 条（晚于当前剧情日期）');
    if (plan && plan.pack && Number(plan.pack.truncated || 0)) parts.push('截断 ' + Number(plan.pack.truncated) + ' 名（超出上限，未纳入本次）');
    parts.push('现有 ' + Number(a.after || 0) + ' 条');
    return '履历批量：' + parts.join('；');
}

/** 终止原因（与三域联动 / 货币融合同款口径；调用点在跑之前先问一次） */
export function resumeBatchBlockReason(roles) {
    const conf = resumeBatchCfg();
    if (!conf.enabled) return 'disabled';
    if (!Array.isArray(roles) || !roles.length) return 'no-candidates';
    return '';
}
export const RESUME_BATCH_REASON_TEXT = Object.freeze({
    disabled: '批量履历已关闭（可在设定 → 投喂范围 → 履历里打开 resumeBatchEnabled）',
    'no-candidates': '近期窗口内没有"被记忆命中"的角色（可调大窗口天数，或先用「⚡ 立即 AI 摘要」更新记忆）',
    busy: '分析管道占用中，稍后再试',
    'no-ai': 'AI 未返回结果，本次未改动任何数据',
    invalid: '方案不可用（没有可写入的履历条目）',
});
