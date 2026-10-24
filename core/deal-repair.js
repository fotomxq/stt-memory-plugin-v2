// ============================================================
// core/deal-repair.js —— **长期收支修复**（v3.51.4，`docs/D53` §3.4/§3.9 · `docs/D22` W32 `应-47` 续）
//
// 用户要求（原话）：「长期收支页面，需增加修复按钮，可结合剧情修订、更正内容。注意每次抽取3个处理，不要全部丢给AI分析。」
//
// 设计约束（窄契约）：**每次只取 3 条**（`DEAL_REPAIR_BATCH`）→ 打包（当前记录 + 最近正文）→ **一次** AI →
//   机械校验（id 必须来自包内 / 只允许追加「已发生」节点且日期不晚于当前剧情日期 / 预测必须晚于最后变动）→ 落库。
//   · **预测 ≠ 事实**：AI 只能写 `nodes`（已发生，需正文支持）与 `forecast`（预测，`source` 强制 `ai`）；
//   · **不编造**：字段留空即不改；金额不确定就给 0；无法从正文判断的条目**原样跳过**（并在摘要里如实报「跳过」）；
//   · **不碰数据契约**：不改 `currencyId`（锚定货币需要人工重指）、不改 `id`、不改 `trigger`（运行态由代码维护）。
// ============================================================
import { cfg, state, saveState, dbgLog } from './model/runtime.js';
import { aiCallText, aiBusy, aiFeedText } from './ai-hooks.js';
import { dealList, normalizeDeal } from './model/deal.js';
import { storyDateMsFromStr } from './clock.js';
import { roundMoney } from './model/money.js';

/** 每次修复的条数（用户要求：3 条） */
export const DEAL_REPAIR_BATCH = 3;
/** 单次最多接受的新增节点数（防刷） */
const MAX_NEW_NODES = 6;
const MAX_PACK_CHARS = 6000;

const str = (v) => String(v == null ? '' : v).trim();
const cut = (v, n) => { const s = str(v); return s.length > n ? (s.slice(0, n - 1) + '…') : s; };
function curMs(d) { try { return storyDateMsFromStr(str(d)); } catch (e) { return NaN; } }
function curName(id) {
    const list = Array.isArray(state.currencies) ? state.currencies : [];
    const c = list.filter((x) => x && String(x.id) === String(id))[0];
    return c ? (str(c.owner) + '·' + str(c.name)) : '（已失效）';
}

/**
 * 选出**最该修**的 ≤3 条（优先级：有现状缺内容 > 预测到期未兑现 > 长期未动 > 其它）。
 * 停摆（锚定货币失效）不进 AI 包 —— AI 改不了货币，只在摘要里如实报数。
 */
export function dealRepairPick(max) {
    const cap = Math.max(1, Math.min(9, Number(max) || DEAL_REPAIR_BATCH));
    const today = str(state.state && state.state.date);
    const nowMs = curMs(today);
    const all = dealList();
    const stalled = all.filter((d) => d && d.trigger && str(d.trigger.skippedReason) === 'currency-missing').length;
    const scored = all.filter((d) => d && !(d.trigger && str(d.trigger.skippedReason) === 'currency-missing')).map((d) => {
        let score = 0;
        const ol = d.outlook || {}, fc = ol.forecast || {}, nodes = Array.isArray(ol.nodes) ? ol.nodes : [];
        if (!str(d.desc)) score += 25;
        if (!str(d.status)) score += 25;
        if (!str(ol.text)) score += 20;
        if (!nodes.length) score += 10;
        const fcMs = curMs(fc.nextDate);
        if (Number.isFinite(fcMs) && Number.isFinite(nowMs) && fcMs <= nowMs) score += 40;   // 预测已到期未兑现
        const lastMs = curMs(d.lastChangeDate || d.startDate);
        if (Number.isFinite(lastMs) && Number.isFinite(nowMs) && nowMs - lastMs > 0) score += Math.min(20, Math.floor((nowMs - lastMs) / (30 * 86400000)) * 5);
        if (str(d.trigger && d.trigger.catchUpTruncated)) score += 15;
        return { d: d, score: score };
    });
    scored.sort((a, b) => b.score - a.score || String(a.d.id).localeCompare(String(b.d.id)));
    const rows = scored.slice(0, cap).map((x) => x.d);
    return { rows: rows, total: all.length, stalled: stalled, truncated: Math.max(0, scored.length - rows.length) };
}

/** 打包（纯净文本；供 prompt 与校验共用） */
export function dealRepairPack(opts) {
    const o = opts || {};
    const pick = o.pick || dealRepairPick(o.max);
    const today = str(state.state && state.state.date);
    let ctx = '';
    try { ctx = String(aiFeedText(Math.max(1, Number(cfg.repairFloors) || Number(cfg.feedFloors) || 10)) || '').slice(-8000); } catch (e) { ctx = ''; }
    const lines = [];
    for (const d of pick.rows) {
        const ol = d.outlook || {}, fc = ol.forecast || {}, nodes = Array.isArray(ol.nodes) ? ol.nodes : [];
        const recent = nodes.slice(-3).map((n) => str(n.date) + '|' + (Number(n.delta) || 0) + '|' + str(n.note)).join(' ; ') || '（无）';
        lines.push([d.id, str(d.name), str(d.kind), '约定=' + cut(d.desc, 120), '现状=' + cut(d.status, 80), '货币=' + curName(d.currencyId),
            '初始=' + str(d.startDate), '最后变动=' + str(d.lastChangeDate || '—'), '截止=' + str(d.endDate || '—'), '周期=' + str(d.cycle || '未知'),
            '已发生(近3)=' + recent, '预测下一=' + (str(fc.nextDate) ? (str(fc.nextDate) + '|' + (Number(fc.delta) || 0) + '|' + str(fc.direction)) : '（无）'),
            '前景=' + cut(ol.text, 120)].join(' | '));
    }
    const rule = '【只用正文里明确写过的内容；没写就不要改。nodes 只追加已发生的事实；forecast 是预测（source=ai）。】';
    const text = ('【当前剧情日期】' + (today || '未知') + '\n' + rule + '\n【待修条目（每条一行）】\n' + lines.join('\n')
        + '\n【正文节选】\n' + (ctx || '（无正文）')).slice(0, MAX_PACK_CHARS + 8000);
    return {
        today: today, rows: pick.rows, pick: pick,
        counts: { entries: pick.rows.length, total: pick.total, stalled: pick.stalled, truncated: pick.truncated },
        chars: text.length, text: text,
    };
}

/** 提示词（窄契约：只回 JSON） */
export function dealRepairPrompt(pack) {
    return '你是「FTT 记忆」的长期收支修复器。任务：依据【正文节选】**修订/更正**给出的长期收支条目，使其与剧情一致。\n'
        + '只输出一个 JSON 对象，不要任何解释、不要代码块：\n'
        + '{"items":[{"id":"条目标识","desc":"约定内容（可选）","status":"现状（可选）","outlookText":"前景说明（可选）",'
        + '"nodes":[{"date":"年-月-日","delta":数字,"note":"说明"}],"forecast":{"nextDate":"年-月-日","delta":数字,"direction":"increase 或 decrease","note":"说明"}}]}\n'
        + '硬规则：\n'
        + '1. id 必须来自下方【待修条目】；没有需要改的条目就返回 {"items":[]}；\n'
        + '2. 只写正文里**明确出现**的事实；不确定就不写；严禁编造数字与日期；\n'
        + '3. `nodes` 只能**追加**「已发生」的变动（日期不得晚于当前剧情日期、不得与已有节点重复）；\n'
        + '4. `forecast` 是**预测**：nextDate 必须晚于该条最后变动日期；direction 与 delta 符号一致；\n'
        + '5. 不要把预测写成已发生（不要把 forecast 的内容放进 nodes）；\n'
        + '6. 每条可只给需要改的字段；留空即不修改。\n\n'
        + String((pack && pack.text) || '');
}

/** 解析（容忍代码块/前后噪声） */
export function dealRepairParse(text) {
    const s = String(text == null ? '' : text);
    if (!s.trim()) return null;
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { const obj = JSON.parse(s.slice(start, end + 1)); return (obj && typeof obj === 'object') ? obj : null; } catch (e) { return null; }
}

/** 机械校验（逐条；不合格的整条跳过并记原因） */
export function dealRepairValidate(ai, pack) {
    const out = { items: [], skipped: [] };
    const byId = new Map((pack.rows || []).map((d) => [String(d.id), d]));
    const todayMs = curMs(pack.today);
    const list = Array.isArray(ai && ai.items) ? ai.items : [];
    for (const raw of list) {
        const x = (raw && typeof raw === 'object') ? raw : {};
        const id = str(x.id);
        const d = byId.get(id);
        if (!d) { out.skipped.push({ id: id || '（空）', reason: 'unknown-id' }); continue; }
        const patch = {};
        if (str(x.desc)) patch.desc = cut(x.desc, 400);
        if (str(x.status)) patch.status = cut(x.status, 200);
        if (str(x.outlookText)) patch.outlookText = cut(x.outlookText, 400);
        // 新增节点：必须晚于该条最后变动日期、不晚于当前剧情日期、数值可省略
        const ol = d.outlook || {}, nodes = Array.isArray(ol.nodes) ? ol.nodes : [];
        const lastMs = curMs(d.lastChangeDate || d.startDate);
        const addNodes = [];
        const seen = new Set(nodes.map((n) => str(n.date) + '|' + (Number(n.delta) || 0) + '|' + str(n.note)));
        for (const n of (Array.isArray(x.nodes) ? x.nodes : []).slice(0, MAX_NEW_NODES)) {
            const nn = (n && typeof n === 'object') ? n : {};
            const date = str(nn.date);
            const dms = curMs(date);
            if (!date || !Number.isFinite(dms)) { out.skipped.push({ id: id, reason: 'bad-node-date' }); continue; }
            if (Number.isFinite(todayMs) && dms > todayMs) { out.skipped.push({ id: id, reason: 'node-in-future' }); continue; }
            if (Number.isFinite(lastMs) && dms <= lastMs) { out.skipped.push({ id: id, reason: 'node-not-after-last' }); continue; }
            const delta = Number.isFinite(Number(nn.delta)) ? roundMoney(Number(nn.delta)) : 0;
            const key = date + '|' + delta + '|' + str(nn.note);
            if (seen.has(key)) continue;
            seen.add(key);
            addNodes.push({ date: date, delta: delta, note: cut(nn.note, 80) });
        }
        if (addNodes.length) patch.nodes = nodes.concat(addNodes).sort((a, b) => String(a.date).localeCompare(String(b.date)));
        // 预测：必须晚于最后变动；方向与符号一致；source 强制 ai
        const fc = (x.forecast && typeof x.forecast === 'object') ? x.forecast : null;
        if (fc) {
            const nextDate = str(fc.nextDate);
            const nms = curMs(nextDate);
            if (!nextDate || !Number.isFinite(nms)) out.skipped.push({ id: id, reason: 'bad-forecast-date' });
            else if (Number.isFinite(lastMs) && nms <= lastMs) out.skipped.push({ id: id, reason: 'forecast-not-after-last' });
            else {
                const delta = Number.isFinite(Number(fc.delta)) ? roundMoney(Number(fc.delta)) : 0;
                const dir = delta > 0 ? 'increase' : (delta < 0 ? 'decrease' : (str(fc.direction) === 'decrease' ? 'decrease' : 'increase'));
                patch.forecast = { nextDate: nextDate, delta: delta, direction: dir, note: cut(fc.note, 80), source: 'ai' };
            }
        }
        if (!Object.keys(patch).length) { out.skipped.push({ id: id, reason: 'nothing-to-apply' }); continue; }
        out.items.push({ id: id, deal: d, patch: patch });
    }
    return out;
}

/** 应用（逐条；只改可写字段，`trigger` / `currencyId` / `id` 不动） */
export function dealRepairApply(validated, opts) {
    const o = opts || {};
    if (!validated || !Array.isArray(validated.items) || !validated.items.length) return { ok: true, changed: 0, applied: [], skipped: (validated && validated.skipped) || [] };
    const list = Array.isArray(state.deals) ? state.deals : [];
    const applied = [];
    for (const it of validated.items) {
        const idx = list.findIndex((x) => x && String(x.id) === String(it.id));
        if (idx < 0) continue;
        const old = list[idx];
        const merged = Object.assign({}, old, {
            desc: it.patch.desc !== undefined ? it.patch.desc : old.desc,
            status: it.patch.status !== undefined ? it.patch.status : old.status,
            outlook: Object.assign({}, old.outlook, {
                text: it.patch.outlookText !== undefined ? it.patch.outlookText : (old.outlook || {}).text,
                nodes: it.patch.nodes !== undefined ? it.patch.nodes : (old.outlook || {}).nodes,
                forecast: it.patch.forecast !== undefined ? it.patch.forecast : (old.outlook || {}).forecast,
            }),
            repairedAt: Number(o.now) || Date.now(),
        });
        const norm = normalizeDeal(merged);
        if (!norm) { continue; }
        // 保留运行态与条目级修改时间（跨端按它取新）
        norm.trigger = old.trigger;
        norm.updatedAt = Number(o.now) || Date.now();
        list[idx] = norm;
        applied.push(String(it.id));
    }
    if (applied.length) {
        try { saveState(); } catch (e) { /* 忽略：落盘失败由下次写入兜底 */ }
        try { dbgLog('摘要', { action: '长期收支修复（结合剧情修订，每批 3 条）', applied: applied.length, ids: applied.slice(0, 10) }); } catch (e) { /* 忽略 */ }
    }
    return { ok: true, changed: applied.length, applied: applied, skipped: (validated.skipped || []) };
}

/**
 * 跑一轮：挑 3 条 → 打包 → 一次 AI → 校验 → 落库（**不自动重试**；失败不动任何数据）。
 * @param {{aiText?:string, max?:number, now?:number}} [opts] `aiText` 供测试/离线注入
 */
export async function runDealRepair(opts) {
    const o = opts || {};
    try {
        if (aiBusy()) return { ok: false, reason: 'busy', note: '长期收支修复：分析管道占用中，稍后再试' };
        const pick = dealRepairPick(o.max);
        if (!pick.rows.length) {
            return { ok: false, reason: 'empty', note: '长期收支修复：没有可修的条目' + (pick.stalled ? ('（另有 ' + pick.stalled + ' 条锚定货币失效，需先重指货币）') : ''), pick: pick };
        }
        const pack = dealRepairPack({ pick: pick });
        let resp = '';
        if (o.aiText != null) resp = String(o.aiText);
        else { try { resp = String(await aiCallText(dealRepairPrompt(pack), '长期收支修复') || ''); } catch (e) { resp = ''; } }
        const ai = dealRepairParse(resp);
        if (!ai) return { ok: false, reason: 'no-ai', note: '长期收支修复：AI 未返回可用结果，本次未改动任何数据', pack: pack };
        const validated = dealRepairValidate(ai, pack);
        const r = dealRepairApply(validated, { now: o.now });
        const sk = (r.skipped || []).length;
        return Object.assign({ ok: true, batch: pack.counts, validated: validated.items.length, skipped: sk }, r, {
            note: '长期收支修复：本批 ' + pack.counts.entries + ' 条（共 ' + pack.counts.total + ' 条）→ 已更正 ' + r.changed + ' 条'
                + (sk ? (' · 跳过 ' + sk + ' 处（' + (r.skipped || []).slice(0, 3).map((x) => x.reason).join(' / ') + '）') : '')
                + (pack.counts.stalled ? (' · 另有 ' + pack.counts.stalled + ' 条停摆待重指货币') : ''),
        });
    } catch (e) {
        return { ok: false, reason: 'error', note: '长期收支修复异常：' + str(e && e.message) };
    }
}
