// ============================================================
// core/model/segment.js —— **逐字移植自 V1**（V1 src/modules/07-原子层与数据归一化.js（情节分段总结））
// 移植口径同 core/model/scalars.js：算法/字段名/字段顺序不变；仅 ESM 化 + 注入视图（cfg/state/getStoryNow）。
// 一致性由 tests/unit/model-golden*.test.js 的黄金样本强制校验。
// ============================================================
import { normText, normalizeList, clamp, hashText } from '../util.js';
import { cfg } from './runtime.js';
import { clockDateTrim, dimCap, splitListText } from './scalars.js';
import { clockDateParts, clockDateStr, clockDateValid, clockParseDateText, storyDateMsFromStr } from '../clock.js';
import { defaultCfg } from '../config.js';

function plotSegmentId(e) {
    const t = e || {};
    const seed = String(t.header || t['时间范围'] || t.title || '').trim() || String(t.raw || '').slice(0, 120);
    return `seg_${hashText(seed || 'plot')}`;
}
// 从时间范围文本里解析起止日期（YYYY-MM-DD；支持 ~ / - / ～ / 至 连接；楼层写法不解析日期）

function plotSegmentRange(text) {
    const out = { start: '', end: '' };
    try {
        const s = String(text || '');
        const dates = s.match(/-?\d{1,4}[-/.]\d{1,2}[-/.]\d{1,2}/g);   // v1.193：负年份（公元前）
        if (dates && dates.length) {
            const norm = (d) => { const p = clockDateParts(clockDateTrim(d)); return p ? clockDateStr(p.y, p.m, p.d) : ''; };
            out.start = norm(dates[0]);
            out.end = dates.length > 1 ? norm(dates[dates.length - 1]) : out.start;
        } else {
            // v1.193：没有「-」写法时按文本「年月日」解析（含「公元前221年1月2日」；区间用 ~/～/至/— 分隔）
            const head = s.split(/\s*(?:~|～|至|—|–|--)\s*/).map(x => clockParseDateText(x, '')).filter(Boolean);
            if (head.length) { out.start = head[0]; out.end = head.length > 1 ? head[head.length - 1] : out.start; }
        }
    } catch (e) { }
    return out;
}
// 一行剧情线：`1. 感情线: 概述` / `- **感情线**：概述` → { label, text }

function normalizePlotSegmentLine(raw) {
    try {
        if (raw && typeof raw === 'object') {
            const label = normText(raw.label || raw['线路'] || raw.name || raw.title, 40);
            const text = normText(raw.text || raw['概述'] || raw.content || raw.desc, 1200);
            if (!label && !text) return null;
            return { label: label || '剧情线', text };
        }
        const s = String(raw == null ? '' : raw).trim();
        if (!s) return null;
        const m = /^(?:[-*+]|\d+[.、)）]|\*\*)?\s*(?:\*\*)?([^:：*]{1,40}?)(?:\*\*)?\s*[:：]\s*([\s\S]+)$/.exec(s);
        if (m) return { label: normText(m[1], 40) || '剧情线', text: normText(m[2], 1200) };
        return { label: '剧情线', text: normText(s, 1200) };
    } catch (e) { return null; }
}

function normalizePlotSegmentLines(raw, limit) {
    try {
        const arr = Array.isArray(raw) ? raw : splitListText(raw);
        const cap = Math.max(1, Number(limit) || 12);
        const max = Math.max(40, Number((cfg && cfg.plotSegmentTextLimit) || (defaultCfg && defaultCfg.plotSegmentTextLimit) || 400));
        const out = [];
        for (const x of arr) {
            const ln = normalizePlotSegmentLine(x);
            if (!ln) continue;
            // 概述本体按上限硬截断（label 单独存；label 本身已限 40 字）
            out.push({ label: ln.label, text: ln.text.slice(0, max) });
            if (out.length >= cap) break;
        }
        return out;
    } catch (e) { return []; }
}

function normalizePlotSegment(e) {
    try {
        const t = e || {};
        // v1.190：header 里的前导 `#…`（编辑器/粘贴时可能连标题符一起写进来）一律剥掉，
        //   否则渲染与 raw 会出现「### ### …」重复标题符
        const header = normText(t.header || t['时间范围'] || t.title, 80).replace(/^#{1,6}\s*/, '');
        const lines = normalizePlotSegmentLines(t.lines !== undefined ? t.lines : (t['线路'] !== undefined ? t['线路'] : t.items), 12);
        const rawText = String(t.raw || '').trim();
        if (!header && !lines.length && !rawText) return null;
        const rg = plotSegmentRange(header);
        const rng = plotSegmentRange(header || rawText.slice(0, 120));
        const fs = Number(t.floorStart), fe = Number(t.floorEnd);
        const atomIds = (Array.isArray(t.atomIds) ? t.atomIds : []).map(x => String(x || '')).filter(Boolean).slice(0, 300);
        const head = header || (rg.start ? (rg.end && rg.end !== rg.start ? `${rg.start} ~ ${rg.end}` : rg.start) : '未标注时间范围');
        const out = {
            id: String(t.id || plotSegmentId({ header: head, raw: rawText })),
            header: head,
            start: rg.start || rng.start || '',
            end: rg.end || rng.end || '',
            lines,
            atomIds,
            atomCount: Number(t.atomCount) || atomIds.length,
            floorStart: Number.isInteger(fs) && fs > 0 ? fs : 0,
            floorEnd: Number.isInteger(fe) && fe > 0 ? fe : 0,
            raw: rawText,
            manual: !!t.manual,
            uses: Number(t.uses) || 0,
            createdAt: Number(t.createdAt) || Date.now(),
            updatedAt: Number(t.updatedAt) || Number(t.createdAt) || Date.now(),
        };
        if (!out.raw) out.raw = plotSegmentsToText([out]);
        return out;
    } catch (e) { return null; }
}
// v1.190：分段总结的**展示排序键**（默认倒序 = 时间范围最晚的在前，早期的靠后）
//   排序依据（从强到弱）：① 时间范围结束日 `end` → ② 起始日 `start` → ③ （无日期时）更新/创建时间戳。
//   日期为 `YYYY-MM-DD`（年份补零到 4 位）→ 可与时间戳一并拼成可直接字符串比较的键。

function plotSegmentTimeKey(s) {
    try {
        const t = s || {};
        const end = clockDateValid(t.end) ? clockDateTrim(t.end) : '';
        const start = clockDateValid(t.start) ? clockDateTrim(t.start) : '';
        const day = end || start || '';
        const ts = Number(t.updatedAt) || Number(t.createdAt) || 0;
        // v1.193：日期部分改用**剧情日期数值**（偏移后补零，保证字典序 = 时间序）；负年份（公元前）同样正确
        const ms = day ? storyDateMsFromStr(day) : NaN;
        const dk = Number.isFinite(ms) ? String(Math.round(ms) + 1e15).padStart(17, '0') : '';
        // 有日期：日期优先；同日期按时间戳；无日期：纯时间戳（排在所有有日期之后）
        return (day ? `1|${dk}` : '0|') + `|${String(ts).padStart(15, '0')}`;
    } catch (e) { return '0||000000000000000'; }
}

function plotSegmentTimeDesc(a, b) { const x = plotSegmentTimeKey(a), y = plotSegmentTimeKey(b); return x === y ? 0 : (x < y ? 1 : -1); }
// 升序（「最早在前」）：**有日期的仍排在无日期之前**，然后才按日期 / 时间戳升序 —— 避免「未标注」跑到最上面

function plotSegmentTimeAsc(a, b) {
    const ka = plotSegmentTimeKey(a), kb = plotSegmentTimeKey(b);
    const da = ka.charAt(0) === '1', db = kb.charAt(0) === '1';
    if (da !== db) return da ? -1 : 1;
    if (ka === kb) return 0;
    return ka < kb ? -1 : 1;
}
// 默认倒序（最新时间范围在前、早期靠后）；mode: 'desc'（默认）| 'asc' | 'default'

function sortPlotSegments(list, mode) {
    const a = Array.isArray(list) ? list.slice() : [];
    if (mode === 'default') return a;
    return mode === 'asc' ? a.sort(plotSegmentTimeAsc) : a.sort(plotSegmentTimeDesc);
}
// 段落 → Markdown 原文（`### 时间范围` + `N. 线路: 概述`）；导出/编辑回填/展示共用

function plotSegmentsToText(list) {
    try {
        const arr = (Array.isArray(list) ? list : [list]).filter(Boolean);
        return arr.map((s) => {
            const head = `### ${s.header || '未标注时间范围'}`;
            const body = (s.lines || []).map((ln, i) => `${i + 1}. ${ln.label}：${ln.text}`).join('\n');
            return body ? `${head}\n${body}` : head;
        }).join('\n\n');
    } catch (e) { return ''; }
}
// AI 返回的 Markdown → 段落数组（按 `### ` 头切段；头之间逐行解析剧情线）

function parsePlotSegmentText(text) {
    const out = [];
    try {
        const s = String(text || '').replace(/\r\n?/g, '\n').replace(/```[a-zA-Z]*\n?/g, '').trim();
        if (!s) return out;
        const lines = s.split('\n');
        let cur = null;
        const push = () => {
            if (!cur) return;
            const norm = normalizePlotSegment(cur);
            if (norm) out.push(norm);
            cur = null;
        };
        for (const line of lines) {
            const t = String(line).trim();
            const hm = /^(#{1,6})\s*(.+)$/.exec(t);
            if (hm && hm[1].length >= 2) {   // `##`/`###` 作段落头（AI 偶尔写成 ##）
                push();
                cur = { header: normText(hm[2], 80), lines: [] };
                continue;
            }
            if (!t) continue;
            if (!cur) {
                // 头之前的散句（AI 未给 ### 头）：先攒成一段，头出现后归位
                if (/^(?:\[?输出要求\]?|以下是|总结如下)/.test(t)) continue;
                cur = { header: '', lines: [] };
            }
            const ln = normalizePlotSegmentLine(t);
            if (ln) cur.lines.push(ln);
        }
        push();
        return out;
    } catch (e) { return out; }
}

export { plotSegmentId, plotSegmentRange, normalizePlotSegmentLine, normalizePlotSegmentLines, normalizePlotSegment, plotSegmentTimeKey, plotSegmentTimeDesc, plotSegmentTimeAsc, sortPlotSegments, plotSegmentsToText, parsePlotSegmentText };
