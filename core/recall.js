// ============================================================
// core/recall.js —— **逐字移植自 V1**（src/modules/08-本地召回与向量检索.js 的全部注入逻辑）
// 覆盖：时间排序（atomTime*）、评分与命中（recallEntryScore/Hits/Hay/QueryTokens/DateAnchor/MaxFloor/Votes）、
//   匹配器（nameMatch/tagMatch/rawMatch/buildQueryText）、在场判定（matchPresentNames/injectPresentItems/
//   injectNameCore/nameAliases/injectPresentHit/injectPresentNames）、注入行（memInjectLines/planSusp*/relTag/
//   rumorInjLine/parallelInjLine/parallelExpired/parallelDecayScore/buildSceneTreeLines/atomLatestDated）、
//   **注入体装配**（buildMemoryBodyForInject：大类候选 → 预算内全局择优）与**固定约束段**（buildInjectConstraints）。
// 适配：ESM 化 + 注入视图（state/cfg + 聊天/调试钩子：getChatMessages/getAssistantText/latestAiFloorText/dbgLog）。
// 一致性由 tests/unit/recall-golden.test.js 的黄金样本强制校验（oracle = 真实 V1 插件）。
// ============================================================

import { clockDateTrim, clockDateValid, clockDateLabel, clockMonthDay, storyDateMsFromStr } from './clock.js';
import { clamp } from './util.js';
import { activeAtoms, atomIsHidden } from './merge.js';
import { recallDateNum } from './migrate.js';
import { defaultCurrencyOwner, formatMoney, isTrackedCurrencyOwner } from './model/money.js';
import { relLinksOf } from './model/rel.js';
import { cfg, dbgLog, getLastMessageId, getStoryNow, latestAiFloorText, saveState, state, warn } from './model/runtime.js';
import { normPhase } from './model/scalars.js';
import { snapshotAge, snapshotAppearanceText, snapshotSocialFutureLine } from './model/snapshot.js';
import { normalizeList, snapNameKey } from './util.js';
const DECAY_MS_HOUR = 3600 * 1000;

const DECAY_MS_DAY = 24 * DECAY_MS_HOUR;

const DECAY_MS_MONTH = 30.44 * DECAY_MS_DAY;

const DECAY_MS_YEAR = 365.25 * DECAY_MS_DAY;
// —— 通用 5 参数多级时间衰退（底层方法，供各大类复用）——
// 入参：earliestAt 大类最早更新时间 / latestAt 大类最晚更新时间 / nowAt 总览当前时间 /
//       itemAt 被判断原子自身时间 / count 大类条目数；返回衰退值 0..1

const REL_LINK_DIMS = ['memories', 'plans', 'suspense', 'parallels'];

const REL_LINK_HOW_RANK = { author: 9, involved: 9, participant: 8, witness: 7, join: 7, investigating: 6, told: 5, unspecified: 4, inferred: 3, rumor: 2, related: 1 };

const REL_LINK_HOW_LABEL = { participant: '亲历', witness: '目击', told: '被告知', inferred: '推断', rumor: '传闻', unspecified: '知情', author: '策划', join: '参与', involved: '当事人', investigating: '在查', related: '相关' };

const PLAN_PHASE_LABEL = { '': '进行中', blocked: '受阻', abandoned: '已放弃' };

const useBuffer = {};

let useFlushTimer = null;

function buildQueryText(intentText) { return String(intentText || '').trim().slice(-4000); }

// 按类目特征匹配的简化支撑（避免全文丢给 AI 分析排序，提高召回率/准确率）
// 标签相关性（情节/记忆/概念）：查询包含标签 或 标签包含查询

function tagMatch(list, q) {
    const tags = normalizeList(list);
    const ql = String(q || '').toLowerCase();
    if (!tags.length || !ql) return false;
    return tags.some(t => ql.includes(t.toLowerCase()) || t.toLowerCase().includes(ql));
}
// 角色姓名（状态/角色）：查询包含姓名 或 姓名包含查询（支持简称）

function nameMatch(name, q) {
    const n = String(name || '').toLowerCase();
    const ql = String(q || '').toLowerCase();
    if (!n || !ql) return false;
    return ql.includes(n) || n.includes(ql);
}
// 原始文本（计划/悬念）：双向包含

function rawMatch(text, q) {
    const t = String(text || '').toLowerCase();
    const ql = String(q || '').toLowerCase();
    if (!t || !ql) return false;
    return t.includes(ql) || ql.includes(t.slice(0, 12));
}
// 第二层：浏览器 JS 抽取关键词 —— 从输入文本中提取与记忆库特征词（标签/关键词/角色名/场景名/计划原文）匹配的词，无需 AI/向量/API

function planSuspLine(e, kind) {
    const desc = String(e.content || '');
    const t = String(e.title || '').trim();
    const head = t && t !== desc ? `${t}：${desc}` : desc;
    // v1.170：剧情日期一律附相对时间标注（今天 / 昨天 / N天前 / N年前），让 AI 知道内容发生在何时
    const sn = getStoryNow();
    const meta = [];
    if (e.date) meta.push(String(e.date) + relTag(e.date, sn) + (e.time && !/^\d{4}/.test(String(e.time)) ? ' ' + e.time : ''));
    else if (e.time) meta.push(e.time);
    const chars = normalizeList(e.characters);
    if (chars.length) meta.push(`角色:${chars.slice(0, 6).join('、')}`);
    if (kind === 'plan' && e.targetTime) meta.push(`目标:${String(e.targetTime)}${relTag(e.targetTime, sn)}`);
    if (kind === 'suspense' && e.resolveTime) meta.push(`揭晓:${String(e.resolveTime)}${relTag(e.resolveTime, sn)}`);
    // v1.165：计划 / 悬念的结构化字段（未填则不显示 —— 旧数据零变化）
    if (kind === 'plan') {
        const prog = Number(e.progress);
        if (Number.isFinite(prog) && prog > 0) meta.push(`进度:${Math.max(0, Math.min(100, Math.round(prog)))}%`);
        if (Array.isArray(e.blockers) && e.blockers.length) meta.push(`阻碍:${String(e.blockers[0]).slice(0, 16)}`);
        // v1.166：阶段（只写非「进行中」；不改 status 语义）+ 状态备注
        const ph = (typeof normPhase === 'function') ? normPhase(e.phase) : '';
        if (ph) meta.push(`阶段:${planPhaseLabel(ph)}`);
        if (e.statusNote) meta.push(`备注:${String(e.statusNote).slice(0, 24)}`);
    }
    if (kind === 'suspense') {
        if (Array.isArray(e.clues) && e.clues.length) meta.push(`线索:${e.clues.length} 条`);
        if (e.resolveCondition) meta.push(`揭晓条件:${String(e.resolveCondition).slice(0, 24)}`);
        const ph2 = (typeof normPhase === 'function') ? normPhase(e.phase) : '';
        if (ph2) meta.push(`阶段:${planPhaseLabel(ph2)}`);
        if (e.statusNote) meta.push(`备注:${String(e.statusNote).slice(0, 24)}`);
    }
    return meta.length ? `${head}（${meta.join(' · ')}）` : head;
}

// ==================== v1.175：情节时间序（AI 阅读顺序 = 从老到新） ====================
// 用户要求：情节记忆「无论如何抽取都必须确保顺序」——输出一律按**剧情时间从早到晚**。
//   排序键（全序、可传递）：① 是否有剧情日期（有日期的可在时间轴上定位 → 排前）
//   ② 剧情日期升序 ③ 楼层起点 ④ 楼层终点 ⑤ 数组下标（最后兜底，保证稳定）。
//   无日期的条目按楼层顺序排在**有日期条目之后**（仍然从老到新）。

function atomDateValid(d) {
    try {
        if (typeof clockDateValid === 'function') return clockDateValid(d);
        return /^-?\d{1,4}-\d{2}-\d{2}$/.test(String(d == null ? '' : d).trim());
    } catch (e) { return false; }
}

function atomTimeKey(a, idx) {
    const d = (a && atomDateValid(a.date)) ? clockDateTrim(a.date) : '';
    const ms = d ? storyDateMsFromStr(d) : NaN;   // v1.193：日期排序改走剧情日期数值（负年份安全）
    return {
        has: d ? 0 : 1,
        d,
        n: Number.isFinite(ms) ? ms : 0,
        f: Number(a && (a.floorStart != null ? a.floorStart : a.floorEnd)) || 0,
        fe: Number(a && a.floorEnd) || 0,
        idx: Number.isFinite(idx) ? Number(idx) : 0,
    };
}

function parseDate(s) {
    const m = String(s || '').match(/^(-?\d{1,4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return null;
    if (y === 0 || y < -9999 || y > 9999) return null;   // 公元前 1 年 = -1；历史上无 0 年
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { y, m: mo, d };
}
// 剧情日期 → 毫秒（与 module09 的 storyDateMs 同口径；此处独立实现便于日期工具层使用）

function atomTimeCmp(a, b, ia, ib) {
    const x = atomTimeKey(a, ia), y = atomTimeKey(b, ib);
    if (x.has !== y.has) return x.has - y.has;
    if (x.has === 0 && x.n !== y.n) return x.n < y.n ? -1 : 1;   // v1.193：数值比较
    if (x.f !== y.f) return x.f - y.f;
    if (x.fe !== y.fe) return x.fe - y.fe;
    return x.idx - y.idx;
}
// 从老到新（AI 阅读顺序）

function dateMs(y, m, d) {
    try {
        const yy = Number(y), mm = Number(m), dd = Number(d);
        if (!Number.isInteger(yy) || yy === 0 || yy < -9999 || yy > 9999) return NaN;
        if (!Number.isInteger(mm) || mm < 1 || mm > 12) return NaN;
        if (!Number.isInteger(dd) || dd < 1 || dd > 31) return NaN;
        const dt = new Date(Date.UTC(2000, 0, 1));
        dt.setUTCFullYear(yy, mm - 1, dd);           // v1.188/v1.193：setUTCFullYear 支持 0–99 与负年份
        if (dt.getUTCMonth() !== mm - 1) return NaN;
        return dt.getTime();
    } catch (e) { return NaN; }
}
// 相对时间（口语化）：今天 / 昨天 / 前天 / N天前 / N个月前 / N年前。
// 传入明确的剧情日期 nowStr 时按它折算；nowStr 为空表示剧情时钟未知 —— 此时不折算（不拿现实时间冒充剧情时间）。
// 仅当调用方完全不传第二个参数时，才退回现实日期，便于调试与手工调用。

function atomTimeAsc(a, b) { return atomTimeCmp(a, b, 0, 0); }
// 从新到老（近期档取最新用）

function atomTimeDesc(a, b) { return atomTimeCmp(b, a, 0, 0); }

// ==================== v1.165：关联感知的注入渲染 + 固定约束段（docs/11 §5） ====================
// 设计要点：
//   ① 注入行 = **联动角色 + 内容**；角色锚点永不可省（无锚点 = 渲染缺陷）；
//   ② **有差异就按角色分行**（不同角色的认知只对该作者有效，不得混用）；无差异才合并为一行 + 知情摘要；
//   ③ 计划 / 悬念标「谁策划 / 谁参与 / 谁在查」；平行事件标「相关（**角色不知情**）」——相关 ≠ 知情；
//   ④ **固定约束段**由关联层 + 在场名单 + 状态**机械生成**，**与关键词召回完全解耦**：
//      召回漏抽不会导致约束丢失（未召回的条目以聚合计数出现），避免「提取关键词的注入过程出错」。

function calcRelativeTime(dateStr, nowStr) {
    const d = parseDate(dateStr);
    if (!d) return '';
    let n = null;
    if (nowStr === undefined) n = parseDate(new Date().toISOString().slice(0, 10));
    else n = parseDate(nowStr);
    if (!n) return '';
    const diff = (() => {
        // v1.193：用 setUTCFullYear 口径（支持公元 0–99 与**公元前负数年份**）；旧写法 Date.UTC 会把 0–99 映射到 19xx
        const a = dateMs(n.y, n.m, n.d), b = dateMs(d.y, d.m, d.d);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
        return Math.round((a - b) / 86400000);
    })();
    if (!Number.isFinite(diff)) return '';
    if (diff < 0) {
        const f = -diff;
        if (f === 1) return '明天';
        if (f === 2) return '后天';
        return `${f}天后`;
    }
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff === 2) return '前天';
    if (diff < 30) return `${diff}天前`;
    const years = Math.floor(diff / 365);
    if (years <= 0) return `${Math.floor(diff / 30)}个月前`;
    const months = Math.floor((diff - years * 365) / 30);
    return months > 0 ? `${years}年${months}个月前` : `${years}年前`;
}
// 相对时间标注（含括号）：如 [1919-11-28（昨天）]；无剧情时钟或无日期时返回空串

function relHowLabelOf(how) { try { return REL_LINK_HOW_LABEL[how] || '知情'; } catch (e) { return '知情'; } }

function relDevLabel(dev) { return ({ accurate: '准确', partial: '片面', misconception: '有误', denial: '不信', unaware: '存疑' })[dev] || ''; }

function relShortName(w) { const s = String(w || ''); const i = s.indexOf('·'); return i > 0 ? s.slice(i + 1) : s; }

function relPresentList() { try { return (state.state && Array.isArray(state.state.present)) ? state.state.present.filter(Boolean) : []; } catch (e) { return []; } }

function relIsPresent(w) { try { const k = snapNameKey(w); return !!k && relPresentList().some(n => snapNameKey(n) === k); } catch (e) { return false; } }

function relRankOf(how) { try { return REL_LINK_HOW_RANK[how] || 0; } catch (e) { return 0; } }
// 知情摘要（分组压缩）：亲历：甲、乙；被告知：丙←甲·11-30；传闻：3 人

function relWhoSummary(people) {
    const groups = [];
    const foldThreshold = Math.max(1, Number(cfg && cfg.memoryChainFoldThreshold) || 2);
    const showModes = String((cfg && cfg.memoryChainShowModes) || '亲历,目击,被告知');
    const order = ['participant', 'witness', 'author', 'join', 'involved', 'investigating', 'told', 'inferred', 'rumor', 'unspecified', 'related'];
    for (const mode of order) {
        const list = people.filter(x => x.how === mode);
        if (!list.length) continue;
        const label = relHowLabelOf(mode);
        if (list.length > foldThreshold && showModes.indexOf(label) < 0) { groups.push(`${label}：${list.length} 人`); continue; }
        groups.push(`${label}：${list.map(x => (mode === 'told' && x.from) ? `${relShortName(x.who)}←${relShortName(x.from)}${x.at ? '·' + clockMonthDay(x.at) : ''}` : relShortName(x.who)).join('、')}`);
    }
    return groups.join('；');
}

function memInjectLines(m, storyNow) {
    const when = m.date ? `[${m.date}${relTag(m.date, storyNow)}]` : '';
    const content = String(m.content || '');
    const head = `${String(m.title || '')}${content ? '：' + content : ''}`;
    let rows = [];
    try { rows = relLinksOf('memories', m.id); } catch (e) { rows = []; }
    const anchor = rows.find(x => !x.who) || null;
    const people = rows.filter(x => x.who);
    if (anchor && anchor.public) return [`〔事实·公开〕${when}${head}`];
    if (!people.length) {
        // 回退：未建关联的历史数据 → 沿用现状口径（归属者 / 通用）
        const who = m.owner && m.owner !== '通用' ? `（${m.owner}）` : '';
        return [`${who}${when}${head}`];
    }
    const kind = anchor ? '〔事实〕' : (people.length >= 2 ? '〔共同〕' : '〔私密〕');
    const devs = people.filter(x => x.deviation && x.deviation !== 'accurate' && x.deviation !== 'unknown');
    const devTxt = devs.length ? `；认知：${devs.map(x => relShortName(x.who) + relDevLabel(x.deviation)).join('、')}` : '';
    const diff = people.filter(x => String(x.view || '').trim());
    const split = !cfg || cfg.memSplitOnDiff !== false;
    const maxSplit = Math.max(1, Number(cfg && cfg.memSplitMax) || 4);
    if (diff.length && split) {
        const list = people.slice().sort((a, b) => (relRankOf(b.how) - relRankOf(a.how)) || String(a.who).localeCompare(String(b.who)));
        const shown = list.slice(0, maxSplit);
        const out = shown.map(r => {
            const v = String(r.view || '').trim();
            const dv = (r.deviation && r.deviation !== 'accurate' && r.deviation !== 'unknown') ? '·' + relDevLabel(r.deviation) : '';
            const star = relIsPresent(r.who) ? '★在场 ' : '';
            const told = (r.how === 'told' && r.from) ? `←${relShortName(r.from)}${r.at ? '·' + clockMonthDay(r.at) : ''}` : '';
            return `${kind}${star}${r.who}（${relHowLabelOf(r.how)}${told}${dv}）${when}｜${head}${v ? `｜${relShortName(r.who)}：${v}` : ''}${relConceptSuffix(anchor)}`;
        });
        if (list.length > shown.length) out.push(`${kind}…等 ${list.length} 人（未展开：${list.slice(maxSplit).map(x => relShortName(x.who)).join('、')}）`);
        return out;
    }
    return [`${kind}（${relWhoSummary(people)}${devTxt}）${relConceptSuffix(anchor)}${when}${head}`];
}
// 计划 / 悬念的知情前缀（无关联 → 保守回退「涉及」，绝不暗示人人皆知）

function relTag(dateStr, nowStr) {
    if (!dateStr) return '';
    const r = calcRelativeTime(dateStr, nowStr);
    return r ? `（${r}）` : '';
}

// ==================== 父窗口/TH API 访问 ====================

function planSuspRelPrefix(dim, e, kind) {
    let rows = [];
    try { rows = relLinksOf(dim, e.id); } catch (err) { rows = []; }
    const anchor = rows.find(x => !x.who) || null;
    const people = rows.filter(x => x.who);
    const label = kind === 'plan' ? '计划' : '悬念';
    if (kind === 'plan' && anchor && anchor.public) return '〔计划·公开〕';
    if (!people.length) {
        const chars = normalizeList(e.characters);
        const scope = kind === 'plan' ? String((cfg && cfg.planLinkDefaultScope) || 'planner+join') : String((cfg && cfg.suspLinkDefaultScope) || 'involved+investigating');
        if (chars.length && scope === 'characters') return `〔${label}·涉及：${chars.slice(0, 6).join('、')}〕`;
        return `〔${label}·知情（未记录）〕`;
    }
    const parts = people.slice(0, 8).map(r => `${relShortName(r.who)}（${relHowLabelOf(r.how)}）`);
    return `〔${label}·知情：${parts.join('、')}〕`;
}
// 平行事件前缀：相关 ≠ 知情（角色一律不知情）

function buildInjectConstraints(ctx) {
    try {
        if (cfg && cfg.injectConstraintBlock === false) return '';
        const o = ctx || {};
        const maxChars = Math.max(120, Number(cfg && cfg.injectConstraintMaxChars) || 400);
        const nameAll = cfg && cfg.injectConstraintNameAll === true;
        const present = relPresentList();
        const injected = o.injected || {};
        const lines = ['【注入约束】（以下为硬约束，优先级高于上文任何区块；未列出的角色一律按「不知情」处理）'];
        lines.push(`1. 当前在场：${present.length ? present.join('、') : '（未记录）'}。`);
        // 2. 非公共信息（被召回的逐条点名；未被召回的聚合计数 —— 保证约束不随召回丢失）
        const detail = [];
        const agg = { memories: 0, plans: 0, suspense: 0, parallels: 0 };
        const inSet = (dim, id) => Array.isArray(injected[dim]) && injected[dim].indexOf(String(id)) >= 0;
        const rowsOf = (dim, id) => { try { return relLinksOf(dim, id).filter(x => x.who); } catch (e) { return []; } };
        // 记忆（公开事实不计入非公共信息）
        for (const m of (state.memories || [])) {
            if (!m || !m.id) continue;
            let rows = [], anchor = null;
            try { const all = relLinksOf('memories', m.id); rows = all.filter(x => x.who); anchor = all.find(x => !x.who) || null; } catch (e) { }
            if (anchor && anchor.public) continue;
            const title = String(m.title || m.content || '').slice(0, 24);
            if (inSet('memories', m.id)) {
                        const known = rows.length ? rows.map(x => `${relShortName(x.who)}（${relHowLabelOf(x.how)}）`).join('、') : (m.owner && m.owner !== '通用' ? `${m.owner}（归属）` : '（未记录）');
                detail.push(`· 记忆「${title}」知情者 = ${known}`);
            } else agg.memories++;
        }
        for (const p of (state.plans || [])) {
            if (!p || !p.id || p.status === 'closed') continue;
            let rows = [], anchor = null;
            try { const all = relLinksOf('plans', p.id); rows = all.filter(x => x.who); anchor = all.find(x => !x.who) || null; } catch (e) { }
            if (anchor && anchor.public) continue;
            const title = String(p.title || p.content || '').slice(0, 24);
            if (inSet('plans', p.id)) {
                const known = rows.length ? rows.map(x => `${relShortName(x.who)}（${relHowLabelOf(x.how)}）`).join('、') : '（未记录，按"涉及"保守处理）';
                detail.push(`· 计划「${title}」知情者 = ${known}`);
            } else agg.plans++;
        }
        for (const s of (state.suspense || [])) {
            if (!s || !s.id || s.status === 'closed') continue;
            let rows = [];
            try { rows = relLinksOf('suspense', s.id).filter(x => x.who); } catch (e) { }
            const title = String(s.title || s.content || '').slice(0, 24);
            if (inSet('suspense', s.id)) {
                const known = rows.length ? rows.map(x => `${relShortName(x.who)}（${relHowLabelOf(x.how)}）`).join('、') : '（未记录，按"当事人"保守处理）';
                detail.push(`· 悬念「${title}」知情者 = ${known}`);
            } else agg.suspense++;
        }
        for (const x of (state.parallels || [])) {
            if (!x || !x.id || x.promotedTo) continue;
            agg.parallels++;
        }
        const aggParts = [];
        if (agg.memories) aggParts.push(`${agg.memories} 条私密/秘密记忆`);
        if (agg.plans) aggParts.push(`${agg.plans} 条计划`);
        if (agg.suspense) aggParts.push(`${agg.suspense} 条悬念`);
        const aggLine = aggParts.length ? `另有 ${aggParts.join(' / ')}未在本轮注入：其知情范围同样受限，未列出者不得引用。` : '';
        const infoLines = [];
        infoLines.push('2. 非公共信息（未列出者不得提及 / 暗示 / 配合 / 依据）：');
        if (nameAll) {
            const allNames = [];
            for (const m of (state.memories || [])) { if (m && m.id) { try { const an = relLinksOf('memories', m.id).find(x => !x.who); if (an && an.public) continue; } catch (e) { } allNames.push(String(m.title || '').slice(0, 20)); } }
            if (allNames.length) infoLines.push(`· 记忆（共 ${allNames.length} 条）：${allNames.slice(0, 12).join('、')}`);
        }
        if (detail.length) infoLines.push(...detail);
        if (aggLine) infoLines.push('· ' + aggLine);
        if (detail.length || aggLine || nameAll) lines.push(...infoLines);
        // 3. 不得当作已发生
        lines.push('3. 不得当作已发生：计划（尚未执行）、悬念（尚未揭晓）、平行事件（正文之外推演）、传言（**未经证实的说法**，可能不实或被夸大）一律不得被角色当作已发生事实；平行事件对任何角色都不可见。');
        // 4. 未完成 / 未证实（只针对本轮注入的计划 / 悬念，逐条给事实）
        const unfin = [];
        for (const p of (state.plans || [])) {
            if (!p || !p.id || !inSet('plans', p.id)) continue;
            const prog = Number(p.progress);
            const steps = Array.isArray(p.steps) ? p.steps : [];
            const open = steps.filter(x => x && x.done !== true).length;
            // v1.166：阶段（受阻 / 已放弃）同样视为「未完成」——绝不当作已完成
            const ph = (typeof normPhase === 'function') ? normPhase(p.phase) : '';
            if ((Number.isFinite(prog) && prog > 0 && prog < 100) || open || ph) {
                const title = String(p.title || p.content || '').slice(0, 20);
                const phTxt = ph === 'blocked' ? `当前受阻${p.statusNote ? `（${String(p.statusNote).slice(0, 20)}）` : ''}，` : (ph === 'abandoned' ? '已放弃但尚未了结，' : '');
                unfin.push(`· 计划「${title}」${phTxt}${Number.isFinite(prog) ? `进度 ${Math.max(0, Math.min(100, Math.round(prog)))}%` : ''}${open ? `${Number.isFinite(prog) ? '，' : ''}尚有 ${open} 个未完成步骤` : ''}：未完成部分不得当作已完成。`);
            }
        }
        for (const s of (state.suspense || [])) {
            if (!s || !s.id || !inSet('suspense', s.id)) continue;
            const clues = Array.isArray(s.clues) ? s.clues : [];
            const title = String(s.title || s.content || '').slice(0, 20);
            if (clues.length) unfin.push(`· 悬念「${title}」现有 ${clues.length} 条线索（只证明线索本身，不得据此推出答案）${s.resolveCondition ? `；揭晓条件：${String(s.resolveCondition).slice(0, 30)}` : ''}。`);
        }
        if (unfin.length) lines.push('4. 未完成 / 未证实：', ...unfin);
        // 4.5 传言传播范围（v1.192）：只有列出的传播者 / 听闻者知道这条说法在传，且说法本身未必为真
        const rumorKnow = [];
        for (const r of (state.rumors || [])) {
            if (!r || !r.id || !inSet('rumors', r.id)) continue;
            const who = (Array.isArray(r.carriers) ? r.carriers : []).filter(c => c && c.who)
                .map(c => `${relShortName(c.who)}（${c.role || '传播者'}）`).join('、');
            rumorKnow.push(`· 传言「${String(r.subject || '').slice(0, 16)}」（${r.objectivity || '主观'}）传播者 = ${who || '（未记录，按「无人确知」处理）'}：未列出者既不知道这条说法，也不知道它在传。`);
        }
        if (rumorKnow.length) lines.push('4.5 传言传播范围（说法未必为真，任何角色都不得当作事实使用）：', ...rumorKnow);
        // 5. 平行事件（一律不可见）
        if (agg.parallels) lines.push(`5. 平行事件：本轮有 ${agg.parallels} 条平行事件未注入（仅幕后参考）—— 角色一律不知情，不得被引用或察觉。`);
        // 6. 差异分开处理（只在确实存在差异时给）
        const hasDiff = (() => {
            try {
                for (const dim of REL_LINK_DIMS) {
                    for (const it of (state[dim] || [])) {
                        if (!it || !it.id) continue;
                        const rows = relLinksOf(dim, it.id).filter(x => x.who && String(x.view || '').trim());
                        if (rows.length) return true;
                    }
                }
            } catch (e) { }
            return false;
        })();
        if (hasDiff) lines.push('6. 差异分开处理：同一条记忆 / 计划的不同角色版本不得混用（各行「差异」只对该作者有效）。');
        // 长度控制：按「非公共信息 > 不得当作已发生 > 未完成/未证实 > 平行事件 > 差异」分级降级
        //   （只整行丢弃，绝不切半句；任何降级都保留总括句 —— 未列出者一律按不知情处理）
        const TAIL = '（其余约束从略：任何未列出的角色一律按「不知情」处理。）';
        const sections = [];
        let cur = null;
        for (const l of lines) {
            if (/^\d+\./.test(l)) { cur = { head: l, body: [] }; sections.push(cur); }
            else if (cur) cur.body.push(l);
            else sections.push({ head: '', body: [l] });
        }
        const prio = (head) => {
            if (!head) return 0;                       // 段头（【注入约束】标题行）永远保留
            if (/^1\./.test(head)) return 1;
            if (/^2\./.test(head)) return 2;
            if (/^3\./.test(head)) return 3;
            if (/^4\./.test(head)) return 4;
            if (/^5\./.test(head)) return 5;
            return 6;
        };
        const render = (list) => list.map(s => [s.head].concat(s.body).filter(Boolean).join('\n')).filter(Boolean).join('\n');
        let text = render(sections);
        if (text.length > maxChars) {
            // ① 先丢最低优先级整段（6 → 5 → 4）
            let work = sections.slice();
            for (const drop of [6, 5, 4]) {
                if (text.length <= maxChars) break;
                work = work.filter(s => prio(s.head) !== drop);
                text = render(work);
            }
            // ② 仍超长 → 非公共信息明细逐条丢弃（保留段头与总括句）
            if (text.length > maxChars) {
                const info = work.find(s => prio(s.head) === 2);
                while (info && info.body.length > 1 && text.length > maxChars) {
                    const dropped = info.body.pop();
                    if (!/未在本轮注入/.test(dropped)) {
                        const last = info.body[info.body.length - 1];
                        if (last && /未在本轮注入/.test(last)) info.body.pop();
                    }
                    text = render(work);
                }
            }
            // ③ 兜底：只留 1./2.（段头 + 总括句）+ 3.，绝不切句
            if (text.length > maxChars) {
                const minimal = work.filter(s => prio(s.head) <= 3).map(s => {
                    if (prio(s.head) === 2) {
                        const agg = s.body.filter(x => /未在本轮注入/.test(x));
                        return { head: s.head, body: agg };
                    }
                    return s;
                });
                text = render(minimal);
            }
            if (text.length > maxChars) text = render(sections.filter(s => prio(s.head) <= 2)) ;
        }
        if (text.length > maxChars) text = text.slice(0, maxChars) ;   // 极端兜底（配置被调得极小）
        if (text.indexOf('其余约束从略') < 0 && text.length > maxChars * 0.8) text += '\n' + TAIL;
        return text;
    } catch (e) { return ''; }
}
// 平行事件注入行 —— 标题+描述 +（剧情日期（相对时间）· 涉及角色 · 可能走向及目标 goalOdds），按触发规则整行注入
// v1.170：**不再注入现实墙钟**「更新 2026/09/19」—— 现实时间不是剧情时间，会把 AI 的时间线带偏；
//   排序仍按 updatedAt（现实更新近度）进行，只是不写进注入正文。

function parallelInjLine(p) {
    const title = String(p.title || '').trim();
    const text = String(p.text || '').trim();
    let head = title || text;
    if (title && text && title !== text) head = `${title}：${text}`;
    const sn = getStoryNow();
    const meta = [];
    const pdate = String(p.date || '').trim();
    if (pdate) meta.push(pdate + relTag(pdate, sn) + (p.time && !/^\d{4}/.test(String(p.time)) ? ' ' + p.time : ''));
    else if (p.time) meta.push(String(p.time));
    const chars = normalizeList(p.characters);
    if (chars.length) meta.push(`角色:${chars.slice(0, 6).join('、')}`);
    const odds = (Array.isArray(p.goalOdds) ? p.goalOdds : []).filter(g => g && String(g.target || '').trim()).slice(0, 3);
    if (odds.length) meta.push(`走向:${odds.map(g => `${String(g.target).trim().slice(0, 40)}${Number(g.likelihood) != null ? '(' + Number(g.likelihood) + '%)' : ''}`).join('、')}`);
    return meta.length ? `${head}（${meta.join(' · ')}）` : head;
}

// ==================== 提取优先级机制（替代「各大类轮询均等」）====================
// 背景：注入体构建受 字数预算 + 各大类条数上限 双重约束；旧规则「按大类轮询均等分配」会把
//   每个大类里「下一个按顺序的旧条目」都塞进来 —— 预算紧张时出现 旧情节/旧记忆 挤占最新剧情。
// 改为「优先级机制」：先给候选条目打分（主 = 剧情日期近度，其次 楼层近度/实时更新，
//   再考虑 关键词命中度/重要度/调用次数），再按「大类条数上限为硬约束 + 全局按分择优」挑选，
//   预算内优先输出最新剧情/最相关条目；分数相近时按大类先后顺序自然保持一定覆盖（软均衡）。

function recallImportance(e) {
    try {
        const raw = (e && e.importance !== undefined && e.importance !== null) ? e.importance : (e && e.strength !== undefined ? Number(e.strength) / 100 : NaN);
        const v = Number(raw);
        return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
    } catch (e) { return 0.5; }
}
// 剧情日期锚点：优先 总览当前剧情日期；缺失时取全部候选条目中最新剧情日期（保证「最近」可比较）

function recallDateAnchor() {
    try {
        const story = recallDateNum(getStoryNow());
        if (Number.isFinite(story)) return story;
        let m = -1;
        const scan = (arr, pick) => { for (const x of (arr || [])) { const d = recallDateNum(pick(x)); if (Number.isFinite(d) && d > m) m = d; } };
        scan(activeAtoms(), x => x.date);   // v1.203：已总结隐藏的日期不再作为召回基准
        scan(state.memories, x => x.date);
        scan(state.currentStates, x => x.updatedAt);
        scan(state.plans, x => x.date);
        scan(state.suspense, x => x.date);
        scan(state.concepts, x => x.date);
        return Number.isFinite(m) ? m : NaN;
    } catch (e) { return NaN; }
}

function recallMaxFloor() {
    try {
        let m = 0;
        const scan = (arr) => { for (const x of (arr || [])) m = Math.max(m, Number(x.floorEnd) || 0); };
        scan(activeAtoms()); scan(state.currentStates); scan(state.snapshots); scan(state.memories); scan(state.concepts);   // v1.203
        return m > 0 ? m : 1;
    } catch (e) { return 1; }
}
// 关键词命中条数（q 非空时统计命中的 标签/关键词/实体/姓名/正文 片段个数；q 空 = 0）

function recallHits(e, q) {
    try {
        const ql = String(q || '').toLowerCase();
        if (!ql) return 0;
        const tokens = [];
        const add = (v) => { if (v) { const s = String(v).trim(); if (s) tokens.push(s); } };
        for (const t of (e.tags || [])) add(t);
        for (const k of (e.keywords || [])) add(k);
        for (const en of (e.entities || [])) add(en);
        if (e.name) add(e.name);
        if (e.subject) add(e.subject);
        if (e.content) add(String(e.content).slice(0, 24));
        if (e.text) add(String(e.text).slice(0, 24));
        if (e.desc) add(String(e.desc).slice(0, 24));
        let n = 0;
        for (const t of tokens) { const tl = t.toLowerCase(); if (ql.includes(tl) || tl.includes(ql)) n++; }
        return n;
    } catch (e) { return 0; }
}
// 候选条目优先级分数（0 ~ 1.85；主 = 日期近度，次 = 楼层/实时，再 = 命中度/重要度/调用）
// ctx: { q, anchor, maxFloor, kind }

function recallEntryScore(e, ctx) {
    try {
        const kind = (ctx && ctx.kind) || '';
        const q = (ctx && ctx.q) || '';
        const anchor = Number(ctx && ctx.anchor);
        const maxFloor = Math.max(1, Number(ctx && ctx.maxFloor) || 1);
        const dn = recallDateNum(kind === 'states' && !e.date ? e.updatedAt : e.date);
        let base;
        if (Number.isFinite(dn)) {
            // 主：剧情日期近度 —— 最新≈1.30；距锚点每满 10 年衰减至 0.30
            const a = Number.isFinite(anchor) ? anchor : dn;
            const dist = Math.max(0, a - dn);
            base = 1.30 - Math.min(dist / (365 * 10), 1);
        } else if (kind === 'parallels' && e.updatedAt) {
            // 平行事件按 现实更新时间 的近期度（30 天窗口）
            const ageMs = Math.max(0, Date.now() - Number(e.updatedAt));
            base = 0.75 * Math.max(0, 1 - ageMs / (30 * 86400000));
        } else {
            const fe = Number(e.floorEnd) || 0;
            if (fe > 0) base = 0.60 * Math.min(1, fe / maxFloor);   // 次：楼层近度
            else base = 0.20;                                        // 末：无日期无楼层
        }
        // 其它因素（在日期近度之后比较）：关键词命中度 / 重要度 / 调用次数
        const hits = Math.min(3, recallHits(e, q)) * 0.35;
        const imp = recallImportance(e) * 0.15;
        const usesB = Math.min(1, (Number(e.uses) || 0) / 8) * 0.05;
        return Number((base + hits + imp + usesB).toFixed(4));
    } catch (e) { return 0; }
}

// ==================== 关键词投票机制（本地关键词召回排序）====================
// 目标：本地关键词提取记忆时，同一条记忆被**多个关键词命中**应比只命中 1 个的排名更靠前。
// 实现：把查询拆成关键词词元（空白分隔；本地关键词流程为 keywords.join(' ') 传入），
//   逐条统计「命中的不同关键词个数」= 票数 votes —— 该条的特征文本（标签/名称/正文/描述/角色等）
//   包含该关键词即得一票；票数 > 0 时 评分 = 100000 + 票数×1000 + 原 评分（票数主导、
//   同票再按 日期近度 等次序），未得票条目不额外加码 —— 多关键词命中者排名显著靠前。

function recallQueryTokens(q) {
    try {
        return String(q || '').trim().toLowerCase().split(/\s+/).map(s => s.trim()).filter(s => s.length > 0);
    } catch (e) { return []; }
}
// 条目的可匹配特征文本（小写；标签/关键词/名称/标题/正文/描述/角色/地点/主体字段 等）

function calcTimeDecay(earliestAt, latestAt, nowAt, itemAt, count) {
    try {
        const now = Number(nowAt) || Date.now();
        const item = Number(itemAt);
        if (!Number.isFinite(item) || item <= 0) return 0;                 // 无时间信息视为新
        const age = Math.max(0, now - item);
        // 1) 多级时间尺度（小时→天→月→年，各占一段权重，1 年以上完全饱和）
        const sHours = Math.min(1, age / DECAY_MS_HOUR);
        const sDays = Math.min(1, age / DECAY_MS_DAY);
        const sMonths = Math.min(1, age / DECAY_MS_MONTH);
        const sYears = Math.min(1, age / DECAY_MS_YEAR);
        const scale = 0.20 * sHours + 0.25 * sDays + 0.30 * sMonths + 0.25 * sYears;   // ≤1
        // 2) 类别跨度相对位置：条目越接近「最早更新」越老（=1），接近「最新更新」越新（≈0）
        let relFrac = 0;
        const e = Number(earliestAt), l = Number(latestAt);
        const spanBase = Math.max(1, (Number.isFinite(e) && Number.isFinite(l) ? l : now) - (Number.isFinite(e) ? e : now));
        if (Number.isFinite(e) && now > e) {
            relFrac = Math.min(1, Math.max(0, (now - item) / (now - e)));
            // 条目晚于最新更新（正在被维护）则相对位置按 0 计（最活跃）
            if (Number.isFinite(l) && item >= l) relFrac = 0;
            relFrac = Math.min(1, Math.max(0, relFrac));
        }
        // 3) 条目拥挤度：同类条目越多，整体越易衰退（+2%/条，封顶 ×1.5）
        const n = Math.max(1, Number(count) || 1);
        const crowd = Math.min(1.5, 1 + 0.02 * (n - 1));
        const base = Math.min(1, 0.55 * scale + 0.45 * relFrac);
        return Math.min(1, Math.max(0, base * crowd));
    } catch (e) { return 0; }
}
// 单条衰退值（平行事件专用包装，注入当前类目统计与当前时间）

function recallHay(e) {
    try {
        const o = e || {};
        const parts = [];
        const add = (v) => { const s = String(v === undefined || v === null ? '' : v).toLowerCase().trim(); if (s) parts.push(s); };
        add(o.name); add(o.title); add(o.subject); add(o.field); add(o.value); add(o.owner);
        add(o.text); add(o.content); add(o.desc); add(o.type); add(o.location);
        for (const t of (o.tags || [])) add(t);
        for (const k of (o.keywords || [])) add(k);
        for (const en of (o.entities || [])) add(en);
        for (const c of (o.characters || [])) add(c);
        for (const l of (o.locations || [])) add(l);
        return parts.join('\n');
    } catch (e) { return ''; }
}
// 票数 = 查询关键词元中「命中该条目」的去重个数（特征文本包含该关键词即命中）

function recallEntryVotes(e, tokens) {
    try {
        const tl = [];
        for (const t of (tokens || [])) { const s = String(t || '').toLowerCase().trim(); if (s && !tl.includes(s)) tl.push(s); }   // 去重：同一关键词只算一票
        if (!tl.length) return 0;
        const hay = recallHay(e);
        if (!hay) return 0;
        let votes = 0;
        for (const t of tl) { if (hay.includes(t)) votes++; }
        return votes;
    } catch (e) { return 0; }
}

// ==================== /最新在场人员（注入角色/状态限制依据 · 与剧情时钟同源存储） ====================
// 在场判定（纯确定性、不调 API）；①匹配前用 JS 拆解全名「管用名」——
//   如「亨德里克·范·德·贝克」→ 全名 + 各有效片段（亨德里克/贝克 等），正文以任何常用称呼出现即识别为在场；
//   ②与当前状态(时间/地点)同源同刻解析（clockAutoExtractOnce 内联动存储），注入/总览优先读取该存储名单；
//   **v1.173：不再跨楼层聚合**（旧 INJECT_PRESENCE_FLOORS 窗口已移除）——无存储时按「最新正文 → 最新情节」实时判定。
// 姓名核 = 全名首段（用于状态主体与档案名归并/过滤）

function parallelDecayScore(p) {
    const list = state.parallels || [];
    const ts = list.map(x => Number(x && x.updatedAt) || 0).filter(t => t > 0);
    const earliest = ts.length ? Math.min.apply(null, ts) : 0;
    const latest = ts.length ? Math.max.apply(null, ts) : (Number(p && p.updatedAt) || 0);
    return calcTimeDecay(earliest, latest, Date.now(), Number(p && p.updatedAt) || 0, list.length);
}

function injectNameCore(name) { return String(name || '').split(/[·・.．\s]+/)[0].trim(); }
// 全名 → 「管用名」候选清单（按特异性降序：全名 → 各有效片段 → 首尾组合）

function parallelExpired(p) {
    if (!cfg || cfg.parallelDecayEnabled === false) return false;
    const cutoff = Number(cfg.parallelDecayCutoff) != null ? Number(cfg.parallelDecayCutoff) : 0.9;
    return parallelDecayScore(p) >= Math.min(1, Math.max(0, cutoff));
}

function nameAliases(name) {
    const full = String(name || '').trim();
    if (!full) return [];
    const out = [full];
    const segs = full.split(/[·・.．\s]+/).map(s => s.trim()).filter(Boolean);
    if (segs.length > 1) {
        const useful = segs.filter(s => s.length >= 2);        // 过短片段（范/德/·等）不单独成候选
        for (const s of useful) if (!out.includes(s)) out.push(s);
        const first = useful[0], last = useful[useful.length - 1];
        if (first && last && first !== last) {                 // 首+尾组合称呼（如 亨德里克·贝克）
            const comb = `${first}·${last}`;
            if (full.length <= 16 && comb !== full && !out.includes(comb)) out.push(comb);
        }
    }
    return out;
}
// 已知在场候选（角色档案名 + 状态主体；同一姓名核只保留最先出现者，档案优先）

function injectPresentItems() {
    const items = [];
    const seen = new Set();
    const addItem = (nm) => {
        const f = String(nm || '').trim();
        if (!f || f.length < 2) return;
        const core = injectNameCore(f);
        if (seen.has(core)) return;
        seen.add(core);
        items.push({ name: f, aliases: nameAliases(f) });
    };
    for (const s of (state.snapshots || [])) addItem(s.name);
    for (const s of (state.currentStates || [])) addItem(s.subject);
    return items;
}
// 纯 JS 文本匹配 —— 返回 { present:[全名…], known }（known=是否有已知角色名单）

function matchPresentNames(text) {
    try {
        const items = injectPresentItems();
        const t = String(text || '').toLowerCase();
        const present = [];
        for (const it of items) {
            const hit = (it.aliases || []).some(a => { const al = String(a || '').toLowerCase(); return al.length >= 2 && t.includes(al); });
            if (hit) present.push(it.name);
        }
        return { present, known: items.length > 0 };
    } catch (e) { return { present: [], known: false }; }
}
// v1.173：在场只在「最新正文」或「最新情节分析」里判定 —— **不再回退多楼层窗口**
//   （旧行为会拼接最近 INJECT_PRESENCE_FLOORS 楼 → 角色跨楼层堆叠、过期角色被误判在场）。
//   无存储名单时的实时回退顺序：最新 AI 正文 → 最新情节原子（涉及角色）→ null（不限制）
// 返回 null = 无法判定（不限制）；[] = 拿到正文但无已知角色在场（严格限制）

function injectPresentNames() {
    try {
        const last = getLastMessageId();
        if (last < 0) return null;
        let text = '';
        try { text = (typeof latestAiFloorText === 'function') ? latestAiFloorText() : ''; } catch (e) { text = ''; }
        if (String(text || '').trim()) {
            const r = matchPresentNames(text);
            if (!r.known) return [];
            if (r.present.length) return r.present;
        }
        // 最新情节分析（剧情侧的「涉及角色」）—— 同样只取最新一个节点，不跨楼层
        try {
            const plot = (typeof latestPlotByFloor === 'function') ? latestPlotByFloor() : null;
            const ents = (plot && plot.entities) || [];
            if (ents.length) {
                const r2 = matchPresentNames(ents.join('、'));
                if (r2.present.length) return r2.present;
            }
        } catch (e) { }
        const stored = (state && state.state && Array.isArray(state.state.present)) ? state.state.present.filter(Boolean) : null;
        if (stored && stored.length) return stored;      // 用与存储同源的名单（总览/注入保持一致）
        return String(text || '').trim() ? [] : null;    // 有正文但都没命中 → 严格空；完全无正文 → 不限制
    } catch (e) { return null; }
}
// 名单命中（null=不限制；支持 姓名核「·」前段 与全名两种匹配）

function injectPresentHit(present, name) {
    if (!present) return true;
    const full = String(name || '').trim();
    if (!full) return false;
    const core = injectNameCore(full);
    return present.includes(full) || present.includes(core);
}

// 注入体构建 —— 预算为上限不截断数据（单条超预算整条跳过）+ 各维度独立条数上限
// 分配机制升级 —— 各大类候选按「优先级评分」降序截取（上限不变），随后预算在**全局
//   按分择优**挑选（分数 = 优先级评分；同分按大类顺序先到），取代旧「各大类轮询均等分配」；
//   输出仍按大类分组块（[当前状态]/[情节记忆]/… 顺序不变）。
// opts.inject=true（注入场景）时 —— [角色档案]/[状态记录] 仅保留「最新在场人员」，
//   [当前状态] 块新增「在场角色：A、B、C」（顿号分割）。

function buildMemoryBodyForInject(queryText, opts) {
    try {
        const o = opts || {};
        const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
        const budget = num(o.charBudget, cfg.charBudget || 8000);
        // v1.165：为固定约束段预留字符（约束段与关键词召回解耦 —— 即使条目被截断，约束也必须注入）
        //   预留量取配置上限（确定性）：约束文本在预算分配完成后按「实际注入的条目」生成（逐条点名 + 未注入聚合）
        const constraintOn = (o.inject !== false) && !(cfg && cfg.injectConstraintBlock === false);
        const constraintCap = Math.max(120, Number(cfg && cfg.injectConstraintMaxChars) || 400);
        const reserve = constraintOn ? Math.min(constraintCap, Math.max(0, Math.floor(budget * 0.4))) : 0;
        const itemBudget = Math.max(0, budget - reserve);
        const injectedIds = { memories: [], plans: [], suspense: [], parallels: [], rumors: [] };   // v1.192：传言纳入注入自查
        // v1.169：候选记录（用于「注入自查」面板解释「为什么某条没进注入」：未进候选 = 关键词未命中；
        //   进了候选但未注入 = 条数上限 / 预算不足）
        const candIds = { memories: [], plans: [], suspense: [], parallels: [], rumors: [] };
        const markCand = (dim, id) => {
            try {
                if (dim && candIds[dim] && id !== undefined && id !== null && candIds[dim].indexOf(String(id)) < 0) candIds[dim].push(String(id));
            } catch (e) { }
        };
        const maxAtoms = num(o.maxAtoms, cfg.maxAtoms || 16);
        const maxMemories = num(o.maxMemories, cfg.maxMemories || 8);
        const maxStates = num(o.maxStates, cfg.maxStates || 30);
        const maxSnapshots = num(o.maxSnapshots, cfg.maxSnapshots || 10);
        const maxItems = num(o.maxItems, cfg.maxItems || 16);
        const maxCurrencies = num(o.maxCurrencies, cfg.maxCurrencies || 8);   // v1.181 货币注入上限
        const maxRumors = num(o.maxRumors, cfg.maxRumors || 6);                 // v1.192 传言注入上限
        const maxPlans = num(o.maxPlans, cfg.maxPlans || 8);
        const maxSuspense = num(o.maxSuspense, cfg.maxSuspense || 8);
        const maxScenes = num(o.maxScenes, cfg.maxScenes || 24);
        const maxConcepts = num(o.maxConcepts, cfg.maxConcepts || 10);
        const maxParallelsInj = num(o.maxParallelsInj, cfg.maxParallelsInj || 8);   // 平行事件注入上限
        const countUses = o.countUses !== false;
        const q = String(queryText || '').toLowerCase();
        const storyNow = getStoryNow();
        // 优先级上下文 —— 日期锚点（总览剧情日期或全局最新剧情日期）/ 最大楼层（无日期条目回退参照）
        const rcAnchor = recallDateAnchor();
        const rcMaxFloor = recallMaxFloor();
        // 查询词元与投票 —— 本地关键词召回时，命中多个关键词的条目 票数更高 → 排名显著靠前
        const qTokens = recallQueryTokens(q);
        // /注入场景（opts.inject）→ [角色档案]/[状态记录] 仅限最新在场人员；
        //   优先使用与剧情时钟联动存储的 state.state.present（时间/地点/在场同源一致），无存储时实时楼层回退
        const present = o.inject ? ((state.state && Array.isArray(state.state.present)) ? state.state.present.slice() : injectPresentNames()) : null;
        const rcScore = (kind) => (e) => {
            const base = recallEntryScore(e, { kind, q, anchor: rcAnchor, maxFloor: rcMaxFloor });
            if (!qTokens.length) return base;                       // 非关键词召回（q 空）：维持 纯优先级
            const votes = recallEntryVotes(e, qTokens);
            if (votes <= 0) return base;                            // 未得票（仅子串反向命中）：不加码
            return Number((100000 + votes * 1000 + base).toFixed(4)); // 票数主导；同票按 日期近度 等次序
        };
        // 各大类候选行：{head, rows:[{text}]}，行文本即最终输出的整条（含内部换行），顺序=类别输出顺序
        // （rows 在各类内已按 优先级评分（含关键词投票）降序并截取到该类上限；预算分配见函数尾部全局择优）
        const cats = [];
        // [当前状态]（日期/时间/地点/在场角色 锚点，很短，总是优先）
        // 四要素合并为同一块分别成行 —— 任一存在即整块输出；修复 仅日期 时整块被 time||location 门槛隐藏
        const curParts = [];
        // v1.188：日期行附「（纪年）·季节」，时间行显示区间 —— 仅在字段存在时追加
        if (state.state.date) curParts.push(`日期:${clockDateLabel(state.state.date)}${state.state.era ? `（${state.state.era}）` : ''}${state.state.season ? `·${state.state.season}` : ''}`);   // v1.193：公元前加前缀
        if (state.state.time) curParts.push(`时间:${state.state.time}${state.state.timeEnd ? `→${state.state.timeEnd}` : ''}`);
        // v2.48.0（用户要求）：「**剧情第 N 天，不允许注入**，这个设定只是在插件内校准时间用的」——
        //   V1 v1.206 11943 会把 `剧情天数:第N天` 写进注入体（V1 故障明确修正 #6），V2 起**不再注入**。
        //   `state.state.storyDay` 仍照常记录，仅供**插件内时间校准**（`clockStoryDayEpoch` 纪元首日 →
        //   「纪元首日 + (N-1) 天」换算日期，见 core/clock-extract.js 的 storyday 分支）与总览展示，
        //   任何注入/投喂/世界书文本都不得出现「第 N 天」（门禁：tests/unit/storyday-no-inject.test.js）。
        if (state.state.location) curParts.push(`地点:${state.state.location}`);
        // 在场角色（顿号分割）；与 日期/时间/地点 同行块输出，正常应四行齐全
        if (present && present.length) curParts.push(`在场角色：${present.slice(0, 10).join('、')}`);
        const curLines = curParts.length ? [curParts.join('\n')] : [];
        cats.push({ head: '[当前状态]', rows: curLines.map(t => ({ text: t })) });
        // [情节记忆]（v1.175：**两段配额切分** —— 近期档（比例 `atomsRecentRatio`，默认 0.4）只按剧情时间取最新、
        //   不受关键词门槛限制，保证 AI 一定看到最近发了什么；机制档（其余配额）按原优先级评分/关键词投票择优，
        //   平局按「最新在前」稳定序；合并去重后 **输出顺序一律按剧情时间从早到晚**（预算消费顺序仍按优先级，渲染时重排））
        const atomRows = [];
        const activeAtoms = (state.atoms || []).filter(a => a && !atomIsHidden(a) && a.validity !== 'inactive');   // v1.203：已总结隐藏的不参与注入（局部名遮蔽同名函数，故此处直接判隐藏态）
        const ratioRaw = (o.atomsRecentRatio != null) ? o.atomsRecentRatio : ((cfg && cfg.atomsRecentRatio != null) ? cfg.atomsRecentRatio : 0.4);
        const ratioRecent = Math.max(0, Math.min(1, Number(ratioRaw) || 0));
        const quotaRecent = Math.min(activeAtoms.length, Math.round(maxAtoms * ratioRecent));
        const quotaMech = Math.max(0, maxAtoms - quotaRecent);
        const atomKey = (a) => String((a && a.id) || ((a && a.text) ? String(a.text).slice(0, 40) : ''));
        const mkAtomCand = (a) => {
            const d = a.date ? `[${a.date}${relTag(a.date, storyNow)}${a.time && !/^\d{4}-\d{2}-\d{2}/.test(a.time) ? ` ${a.time}` : ''}]` : '';
            // 注入正文为纯内容 —— 不再注入检索标签/关键词（#标签串）与「未了结」标记（情节已发生即固定事实）
            return { e: a, score: rcScore('atoms')(a), text: `- ${d}${a.text}`, sort: a };
        };
        const pickedAtoms = new Map();
        const recentCands = [];
        const mechCands = [];
        // ① 近期档：按剧情时间最新（有日期按日期、无日期回退楼层）取 quotaRecent 条 —— 不受关键词门槛限制
        if (quotaRecent > 0) {
            const byRecent = activeAtoms.slice().sort((a, b) => atomTimeDesc(a, b)).slice(0, quotaRecent);
            for (const a of byRecent) { const k = atomKey(a); if (!pickedAtoms.has(k)) { pickedAtoms.set(k, true); recentCands.push(mkAtomCand(a)); } }
        }
        // ② 机制档：未被近期档选中者，按「标签相关性 + 优先级评分」择优补齐 quotaMech 条（原机制不变）
        if (quotaMech > 0) {
            const rest = [];
            for (const a of activeAtoms.slice().reverse()) {
                // 情节按标签相关性识别（tags/keywords）
                if (!q || tagMatch(a.tags, q) || tagMatch(a.keywords, q) || (a.entities || []).some(en => q.includes(String(en).toLowerCase()))) {
                    const k = atomKey(a);
                    if (pickedAtoms.has(k)) continue;
                    rest.push(mkAtomCand(a));
                }
            }
            rest.sort((a, b) => (b.score || 0) - (a.score || 0));
            for (const c of rest.slice(0, quotaMech)) { pickedAtoms.set(atomKey(c.e), true); mechCands.push(c); }
        }
        // 行数组顺序 = **近期档优先**，其后机制档（各自按优先级降序）—— 预算紧张时先保住「最近发生的情节」，
        //   机制档按余量补；显示顺序在渲染阶段统一按时间重排（两段都不改变）。
        const atomRowCands = recentCands.sort((a, b) => (b.score || 0) - (a.score || 0) || atomTimeDesc(a.e, b.e))
            .concat(mechCands.sort((a, b) => (b.score || 0) - (a.score || 0) || atomTimeDesc(a.e, b.e)));
        for (const c of atomRowCands) { if (countUses) markUsed('atoms', c.e); atomRows.push({ text: c.text, score: c.score, sort: c.e }); }
        cats.push({ head: '[情节记忆]', rows: atomRows });
        // [状态记录]：匹配的 当前状态 按优先级取最近 maxStates 条 → 按角色分组输出（分组行仍为一个候选行）
        const activeStates = (state.currentStates || []).slice().reverse().filter(s => s.status !== 'inactive');
        const stateCands = [];
        for (const s of activeStates) {
            // 注入时只保留最新在场角色 的状态记录
            if (present && !injectPresentHit(present, s.subject)) continue;
            const hay = `${s.subject} ${s.field} ${s.value}`.toLowerCase();
            if (!q || nameMatch(s.subject, q) || hay.includes(q)) stateCands.push(s);
        }
        stateCands.sort((a, b) => (rcScore('states')(b) || 0) - (rcScore('states')(a) || 0));
        const matchedStates = stateCands.slice(0, maxStates);
        const stateGroupRows = [];
        const stateGroups = {};
        for (const s of matchedStates) (stateGroups[s.subject] = stateGroups[s.subject] || []).push(s);
        for (const [subj, list] of Object.entries(stateGroups)) {
            const items = [];
            let bestS = 0;
            for (const s of list) { if (countUses) markUsed('states', s); const sc = rcScore('states')(s); if (sc > bestS) bestS = sc; items.push(`· ${s.field}: ${s.value}`); }
            stateGroupRows.push({ score: Number(bestS.toFixed(4)), text: `- ${subj}：\n${items.map(x => `  ${x}`).join('\n')}` });
        }
        cats.push({ head: '[状态记录]', rows: stateGroupRows });
        // [角色档案]（按姓名命中后按优先级取 maxSnapshots 名；无剧情日期 → 楼层/活跃度主导）
        const snapRows = [];
        const snapCands = [];
        for (const sn of (state.snapshots || []).slice().reverse()) {
            // 注入时只保留最新在场角色 的档案
            if (present && !injectPresentHit(present, sn.name)) continue;
            // 角色按角色姓名识别
            if (q && !nameMatch(sn.name, q)) continue;
            const idbits = [];
            // v1.164：已去世标记随身份一并带出（避免 AI 把已故角色当作在场/在世描写）
            if (sn.identity?.deceased === true) idbits.push('已去世');
            if (sn.identity?.gender) idbits.push(sn.identity.gender);
            const ageNow = snapshotAge(sn);      // v1.162：年龄实时由「出生日期 + 剧情日期」计算
            if (ageNow) idbits.push(`${ageNow}岁`);
            if (sn.identity?.occupation) idbits.push(sn.identity.occupation);
            if (sn.identity?.species) idbits.push(sn.identity.species);
            const ap = [];
            // v1.162：外貌为**聚合单字段文本**（身高/体型/发色发型/瞳色/肤色/特征 → 一句话），整句带上即可
            const apTxt = snapshotAppearanceText(sn);
            if (apTxt) ap.push(apTxt);
            if (sn.personality?.traits?.length) ap.push(`性格:${sn.personality.traits.slice(0, 4).join('/')}`);
            // v1.166：社交（与主角 / 态度）与未来（待办 / 承诺）合并为一行（省 token，不改数据）
            const sfTxt = (typeof snapshotSocialFutureLine === 'function') ? snapshotSocialFutureLine(sn) : '';
            if (sfTxt) ap.push(sfTxt);
            const extra = ap.length ? `（${ap.join('；')}）` : '';
            snapCands.push({ e: sn, score: rcScore('snapshots')(sn), text: `- ${sn.name}${idbits.length ? `（${idbits.join(' ')}）` : ''}${extra}` });
        }
        snapCands.sort((a, b) => (b.score || 0) - (a.score || 0));
        for (const c of snapCands.slice(0, maxSnapshots)) { if (countUses) markUsed('snapshots', c.e); snapRows.push({ text: c.text }); }
        cats.push({ head: '[角色档案]', rows: snapRows });
        // [长期记忆]（匹配候选按优先级取 maxMemories 条；平局按「最新在前」）
        const memRows = [];
        const memCands = [];
        for (const m of (state.memories || []).slice().reverse()) {
            // 记忆按标签相关性识别（tags/keywords）
            if (!q || tagMatch(m.tags, q) || tagMatch(m.keywords, q)) {
                // v1.165：关联感知渲染（角色 + 内容；有差异按角色分行；无关联时回退归属者口径）
                const lines = memInjectLines(m, storyNow);
                const text = lines.map(x => '- ' + x).join('\n');
                markCand('memories', m.id);
                memCands.push({ e: m, score: rcScore('memories')(m), text, ref: { dim: 'memories', id: m.id } });
            }
        }
        memCands.sort((a, b) => (b.score || 0) - (a.score || 0));
        for (const c of memCands.slice(0, maxMemories)) { if (countUses) markUsed('memories', c.e); memRows.push({ text: c.text, ref: c.ref }); }
        cats.push({ head: '[长期记忆]（说明：以下条目按角色给出，已标注知情方式与差异；未列出的角色对相应内容不知情。）', rows: memRows });
        // [物品]（命中的物品按优先级取 maxItems 件）—— 标签作为触发关键词与记忆一致
        const itemRows = [];
        const itemCands = [];
        for (const it of (state.items || []).slice().reverse()) {
            if (q) {
                const hay = `${it.name || ''} ${it.location || ''} ${it.desc || ''}`.toLowerCase();
                if (!(tagMatch(it.tags, q) || tagMatch(it.keywords, q) || (it.name && q.includes(String(it.name).toLowerCase())) || hay.includes(q))) continue;
            }
            // v1.170：物品附「最后见到的剧情日期 + 相对时间」（AI 据此判断物品是否还是当下的状态）
            const seen = String(it.seenDate || '').trim();
            const seenTxt = seen ? `${seen}${relTag(seen, storyNow)}` : '';
            const box = [it.location ? String(it.location) : '', seenTxt].filter(Boolean).join(' · ');
            itemCands.push({ e: it, score: rcScore('items')(it), text: `- ${it.name}${it.qty != null ? ` ×${it.qty}` : ''}${box ? `（${box}）` : ''}${it.carried ? ' 携带中' : ''}` });
        }
        itemCands.sort((a, b) => (b.score || 0) - (a.score || 0));
        for (const c of itemCands.slice(0, maxItems)) { if (countUses) markUsed('items', c.e); itemRows.push({ text: c.text }); }
        cats.push({ head: '[物品]', rows: itemRows });
        // [货币]（v1.181）：**主角的货币恒定注入**（不受关键词门槛限制）；其他角色的货币只在「被关键词/在场命中」时注入
        //   —— 符合用户要求「默认只记主角，涉及其他角色必须明确指定」；额度用 formatMoney 动态适配（万/亿/兆/京）。
        //   v1.183：用户在货币页**标定跟踪**的角色（`currencyTrackedRoles`）与主角同等待遇 —— **恒定注入**，
        //   并在行尾标「⭐已标定」，便于 AI 与用户都看得出这是被明确跟踪的对象。
        if (cfg.currencyEnabled !== false) {
            const curRows = [];
            const me = String((typeof defaultCurrencyOwner === 'function' ? defaultCurrencyOwner() : '') || '');
            const presentSet = (present && present.length) ? present : null;
            const curCands = [];
            for (const cu of (state.currencies || []).slice().reverse()) {
                if (!cu || !cu.name) continue;
                const owner = String(cu.owner || '');
                const isTracked = (typeof isTrackedCurrencyOwner === 'function') && !!owner && isTrackedCurrencyOwner(owner);
                const isMine = !owner || owner === me || owner === '主角' || owner === '我' || isTracked;
                if (!isMine) {
                    // 其他角色：需在场或关键词命中（姓名/币种/标签/备注）
                    const hitPresent = presentSet ? presentSet.some(n => nameMatch(owner, n)) : false;
                    const hay = `${owner} ${cu.name} ${cu.note || ''}`.toLowerCase();
                    const hitKw = q ? (nameMatch(owner, q) || hay.includes(q) || tagMatch(cu.tags, q)) : false;
                    if (!hitPresent && !hitKw) continue;
                    markCand('currencies', cu.id);
                }
                curCands.push({ e: cu, score: rcScore('items')(cu), tracked: isTracked });
            }
            curCands.sort((a, b) => (b.score || 0) - (a.score || 0));
            for (const c of curCands.slice(0, maxCurrencies)) {
                const cu = c.e;
                const owner = String(cu.owner || me);
                if (countUses) markUsed('currencies', cu);
                const amtTxt = formatMoney(cu.amount);
                const unit = cu.unit ? String(cu.unit) : '';
                const hist = Array.isArray(cu.history) ? cu.history.slice(-2) : [];
                const histTxt = hist.length
                    ? `（近期：${hist.map(f => `${f.date ? f.date + ' ' : ''}${f.delta >= 0 ? '收入' : '支出'}${formatMoney(Math.abs(f.delta))}${f.note ? '·' + String(f.note).slice(0, 20) : ''}`).join('；')}）`
                    : '';
                const note = cu.note ? `（${String(cu.note).slice(0, 40)}）` : '';
                const mark = c.tracked ? ' ⭐已标定' : '';
                curRows.push({ text: `- ${owner || me}·${cu.name}${unit ? '' : ''} ${amtTxt}${unit ? ` ${unit}` : ''}${note}${histTxt}${mark}`, ref: { dim: 'currencies', id: cu.id }, score: c.score });
            }
            if (curRows.length) cats.push({ head: '[货币]（说明：主角与**已标定跟踪角色**的货币恒定列出；其他角色的货币仅在其被提及/在场时列出。）', rows: curRows });
        }
        // [传言]（v1.192）：正在流传的**说法**（未经证实）—— 开关 `rumorEnabled`（默认开）；
        //   排序 = 「与在场/关键词相关」优先 + 发酵度；沉寂条目不注入；行文本自带客观性与阶段，便于 AI 以
        //   「听说 / 都在传」的方式使用（绝不当事实）。载体已停的传言仍可注入（说法还在，只是不再扩散）。
        if (cfg.rumorEnabled !== false) {
            const rumorRows = [];
            const presentSet = (present && present.length) ? present : null;
            const rumCands = [];
            for (const r of (state.rumors || []).slice().reverse()) {
                if (!r || !r.subject) continue;
                if (String(r.stage || '') === '沉寂') continue;
                const hay = `${r.subject} ${r.content || ''} ${(r.tags || []).join(' ')} ${(r.carriers || []).map(c => (c && c.who) || '').join(' ')}`;
                const hitPresent = presentSet ? (r.carriers || []).some(c => c && c.who && presentSet.some(n => nameMatch(c.who, n))) : false;
                const hitKw = q ? (rawMatch(hay, q) || tagMatch(r.tags, q) || nameMatch(r.subject, q)) : false;
                const rel = hitPresent || hitKw;
                markCand('rumors', r.id);
                rumCands.push({ e: r, rel, score: (rel ? 100000 : 0) + (Number(r.ferment) || 0) * 100 + (rcScore('concepts')(r) || 0) });
            }
            rumCands.sort((a, b) => (b.score || 0) - (a.score || 0));
            for (const c of rumCands.slice(0, maxRumors)) {
                if (countUses) markUsed('rumors', c.e);
                rumorRows.push({ text: `- ${rumorInjLine(c.e)}`, ref: { dim: 'rumors', id: c.e.id } });
            }
            if (rumorRows.length) cats.push({ head: '[传言]（说明：民间流传、**未经证实**的说法，可能不实或被夸大；客观/主观与传播者、载体一并给出，不得当作事实。）', rows: rumorRows });
        }
        // [计划]：进行中（匹配）按优先级取 maxPlans 条 —— 注入必带 时间/角色/标题/描述
        const planCands = (state.plans || []).slice().reverse().filter(p => p.status === 'open' && (!q || rawMatch(p.content, q) || rawMatch(p.title || '', q) || tagMatch(p.tags, q) || (p.characters || []).some(c => nameMatch(c, q))));
        planCands.forEach(p => markCand('plans', p.id));
        planCands.sort((a, b) => (rcScore('plans')(b) || 0) - (rcScore('plans')(a) || 0));
        const openPlans = planCands.slice(0, maxPlans);
        cats.push({ head: '[计划]（说明：以下计划按知情范围给出；未列出的角色不知道计划存在，不得配合、不得提及。）', rows: openPlans.map(p => { if (countUses) markUsed('plans', p); return { score: rcScore('plans')(p), text: `- ${planSuspRelPrefix('plans', p, 'plan')}${planSuspLine(p, 'plan')}`, ref: { dim: 'plans', id: p.id } }; }) });
        // [悬念]：未解（匹配）按优先级取 maxSuspense 条 —— 注入必带 时间/角色/标题/描述
        const suspCands = (state.suspense || []).slice().reverse().filter(s => s.status === 'open' && (!q || rawMatch(s.content, q) || rawMatch(s.title || '', q) || tagMatch(s.tags, q) || (s.characters || []).some(c => nameMatch(c, q))));
        suspCands.forEach(s => markCand('suspense', s.id));
        suspCands.sort((a, b) => (rcScore('suspense')(b) || 0) - (rcScore('suspense')(a) || 0));
        const openSusp = suspCands.slice(0, maxSuspense);
        cats.push({ head: '[悬念]（说明：以下悬念按知情范围给出；未列出的角色连「有这回事」都不知道，不得察觉、不得议论。）', rows: openSusp.map(s => { if (countUses) markUsed('suspense', s); return { score: rcScore('suspense')(s), text: `- ${planSuspRelPrefix('suspense', s, 'suspense')}${planSuspLine(s, 'suspense')}`, ref: { dim: 'suspense', id: s.id } }; }) });
        // 平行事件 —— 标题+描述与其他原子数据一致，按关键词触发并入提取记忆用于注入
        //   触发匹配：标签相关性 / 标题/描述/类型/角色/地点包含关键词；已达衰退阈值（💀 待清理）的不注入；
        //   注入正文 = 纯内容（标题：描述），不带卦象/因果线/概率等检索性字段（可在「平行」页查看）
        //   按「现实更新时间」近度 + 命中度 评分取 maxParallelsInj 条
        const parRows = [];
        const parCands = [];
        for (const p of (state.parallels || []).slice().reverse()) {
            // v1.166：已转正为情节的平行事件不再作为平行事件注入（内容已由情节承载）
            if (p && p.promotedTo) continue;
            let expired = false;
            try { expired = !!parallelExpired(p); } catch (e) { }
            if (expired) continue;
            const hay = `${p.title || ''} ${p.text || ''} ${p.type || ''} ${(p.characters || []).join(' ')} ${p.location || ''}`.toLowerCase();
            if (q && !(tagMatch(p.tags, q) || hay.includes(q))) continue;
            markCand('parallels', p.id);
            parCands.push({ e: p, score: rcScore('parallels')(p), text: `- ${parallelRelPrefix(p)}${parallelInjLine(p)}`, ref: { dim: 'parallels', id: p.id } });
        }
        parCands.sort((a, b) => (b.score || 0) - (a.score || 0));
        for (const c of parCands.slice(0, maxParallelsInj)) { if (countUses) markUsed('parallels', c.e); parRows.push({ text: c.text, ref: c.ref }); }
        cats.push({ head: '[平行事件]（说明：以下为正文之外推演，任何角色都不知情，仅作幕后参考。）', rows: parRows });
        // [场景地点]：树整体作为一块（保持层级；预算放不下整块则跳过）
        let sceneText = '';
        const scenes = (state.scenes || []).slice();
        if (scenes.length) {
            // 场景按路径和名称识别（q 非空时只保留路径/名称命中的节点）；最多 maxScenes 个场景条目构树
            const filteredScenes = (q ? scenes.filter(s => nameMatch(s.name, q) || String(s.pathStr || '').includes(q.toLowerCase()) || (Array.isArray(s.pathArr) ? s.pathArr.some(seg => nameMatch(seg, q)) : false)) : scenes).slice(0, maxScenes);
            const sceneLines = buildSceneTreeLines(filteredScenes);
            if (sceneLines.length) {
                filteredScenes.forEach(s => { if (countUses) markUsed('scenes', s); });
                sceneText = sceneLines.join('\n');
            }
        }
        cats.push({ head: '[场景地点]', rows: sceneText ? [{ text: sceneText }] : [] });
        // [概念]（命中候选按优先级取 maxConcepts 条）
        const conceptRows = [];
        const conceptCands = [];
        for (const c of (state.concepts || []).slice().reverse()) {
            // 概念按标签相关性识别（tags/keywords）
            if (!q || tagMatch(c.tags, q) || tagMatch(c.keywords, q) || nameMatch(c.name, q)) {
                // v1.170：概念日期同样附相对时间标注
                const cd = String(c.date || '').trim();
                conceptCands.push({ e: c, score: rcScore('concepts')(c), text: `- ${c.name}${c.source ? `（来源:${c.source}）` : ''}${cd ? ` [${cd}${relTag(cd, storyNow)}]` : ''}${c.content ? `：${c.content}` : ''}` });
            }
        }
        conceptCands.sort((a, b) => (b.score || 0) - (a.score || 0));
        for (const c of conceptCands.slice(0, maxConcepts)) { if (countUses) markUsed('concepts', c.e); conceptRows.push({ text: c.text }); }
        cats.push({ head: '[概念]', rows: conceptRows });

        // 预算分配 = 全局按优先级择优 —— 每次取「当前各类剩余候选里优先级最高」的一条尝试加入；
        //   大类条数上限已在各类 rows 截取时保证（硬约束）；单条放不下（超剩余预算）则整条跳过不截断。
        //   （[当前状态] 等无日期短行评分很高 → 始终最先进入；分数相近时按大类顺序保持一定的均衡覆盖。）
        const parts = [];            // {head, lines:[]}
        let used = 0;                // 精确的最终 body 字符数（含标题行与 \n\n 分隔）
        const tryAdd = (ci) => {
            const cat = cats[ci];
            if (cat.ptr >= cat.rows.length) return false;
            const line = cat.rows[cat.ptr].text;
            let part = null;
            for (const p of parts) if (p.head === cat.head) { part = p; break; }
            let inc;
            if (!part) inc = cat.head.length + 1 + line.length + (parts.length ? 2 : 0);
            else inc = 1 + line.length;
            if (used + inc > itemBudget) return false;   // 放不下：整条跳过（不截断；已为约束段预留）
            if (!part) { part = { head: cat.head, lines: [] }; parts.push(part); }
            part.lines.push({ text: line, sort: (cat.rows[cat.ptr] && cat.rows[cat.ptr].sort) || null });   // v1.175：带排序键（仅用于显示重排）
            used += inc;
            // v1.165：记录本轮真正注入的条目（约束段据此逐条点名；未注入的走聚合计数）
            try {
                const ref = cat.rows[cat.ptr] && cat.rows[cat.ptr].ref;
                if (ref && ref.dim && injectedIds[ref.dim] && injectedIds[ref.dim].indexOf(String(ref.id)) < 0) injectedIds[ref.dim].push(String(ref.id));
            } catch (e) { }
            cat.ptr++;
            return true;
        };
        cats.forEach(c => { c.ptr = 0; });
        // 每行携带优先级分：当前状态(锚点短行)给最高分；场景整块给中间偏低分（块大，晚于关键剧情仍有机会）
        const sceneHead = '[场景地点]';
        cats.forEach((c, ci) => {
            c.rows.forEach(r => { r.score = r.score === undefined ? (c.head === '[当前状态]' ? 1e9 : (c.head === sceneHead ? 0.3 : 0.5)) : r.score; });
        });
        // 显式迭代上限兜底 —— 每轮至少消费/跳过一条候选，正常至多 总候选数+1 次；
        //   一旦超限立即退出并记日志，从根上杜绝任何潜在的无限循环（防页面卡死/崩溃）。
        const allocCap = cats.reduce((n, c) => n + c.rows.length, 0) + cats.length + 1;
        let allocGuard = 0;
        for (;;) {
            if (++allocGuard > allocCap) {
                try { dbgLog('发送记忆', { action: '注入预算分配超限，已中止', guard: allocGuard, cap: allocCap }); } catch (e) { }
                break;
            }
            let bi = -1, best = -1;
            for (let ci = 0; ci < cats.length; ci++) {
                const cat = cats[ci];
                if (cat.ptr < cat.rows.length) {
                    const s = Number(cat.rows[cat.ptr].score) || 0;
                    if (s > best) { best = s; bi = ci; }
                }
            }
            if (bi < 0) break;                       // 所有候选已消费
            const before = cats[bi].ptr;
            if (tryAdd(bi)) continue;                // 加入一条 → 重新找全局最高优先级下一条
            if (cats[bi].ptr === before) cats[bi].ptr++;   // 该条放不下 → 跳过，尝试该类别下一条
        }
        if (countUses) scheduleUseFlush();
        // 注入体不经过投喂正则过滤（白名单/黑名单仅作用于投喂给摘要 API 的楼层/世界书文本）
        // v1.175：**[情节记忆] 渲染顺序 = 剧情时间从早到晚**（用户要求：无论如何抽取都必须保证 AI 阅读顺序）。
        //   预算分配仍按优先级（近度 + 命中度）消费 —— 只重排**显示**顺序，不改变「哪些条目进注入」。
        for (const p of parts) {
            if (p.head !== '[情节记忆]') continue;
            try {
                p.lines = p.lines.slice().sort((a, b) => {
                    const x = a && a.sort, y = b && b.sort;
                    if (x && y) return atomTimeAsc(x, y);
                    return 0;                       // 缺少排序键 → 保持原相对顺序（sort 稳定）
                });
            } catch (e) { }
        }
        const bodyText = parts.map(p => `${p.head}\n${p.lines.map(l => (l && l.text != null ? l.text : String(l))).join('\n')}`).join('\n\n');
        // v1.169：诊断模式（「约束自查」面板用）—— 返回结构化结果，而不是拼接后的字符串
        const capSet = { memories: maxMemories, plans: maxPlans, suspense: maxSuspense, parallels: maxParallelsInj };
        const diagOf = (cText, clipped, totalText) => ({
            ok: true, budget, itemBudget, reserve, used, caps: capSet,
            constraintOn, constraintCap,
            position: (() => { try { return String((cfg && cfg.injectConstraintPosition) || 'tail'); } catch (e) { return 'tail'; } })(),
            bodyText, constraintText: cText || '', constraintClipped: !!clipped,
            totalText: totalText || '', injected: injectedIds, candidates: candIds,
            catHeads: cats.map(c => c.head),
        });
        // v1.165：固定约束段（机械生成、与关键词召回解耦）—— 按本轮实际注入的条目逐条点名，
        //   未被召回 / 被截断的条目以聚合计数出现，保证「约束不随召回丢失」
        if (!bodyText) {
            if (o.diagnose) return diagOf('', false, '');
            return '';                        // 无任何条目 → 不注入（约束段也不单独出现）
        }
        let constraintText = '';
        if (constraintOn) { try { constraintText = buildInjectConstraints({ injected: injectedIds }); } catch (e) { constraintText = ''; } }
        // 预算钳制：约束段不得把总体积推过预算（极端情况整行丢弃，绝不切半句）
        let clipped = false;
        const room = budget - bodyText.length - 2;
        if (constraintText && room < 80) { constraintText = ''; clipped = true; }
        else if (constraintText.length > room) {
            const cut = constraintText.slice(0, Math.max(0, room)).replace(/\n[^\n]*$/, '');
            constraintText = cut.length >= 40 ? cut : '';
            clipped = true;
        }
        if (!constraintText) {
            if (o.diagnose) return diagOf('', clipped, bodyText);
            return bodyText;
        }
        let totalText = `${bodyText}\n\n${constraintText}`;
        try {
            if (String((cfg && cfg.injectConstraintPosition) || 'tail') === 'head') totalText = `${constraintText}\n\n${bodyText}`;
        } catch (e) { }
        if (o.diagnose) return diagOf(constraintText, clipped, totalText);
        return totalText;
    } catch (e) { warn('本地召回失败', e); return ''; }
}
// ==================== v1.169：注入自查（只读 · 零 AI · 与真实注入同源） ====================
// 用途（docs/11 §7.5）：回答两件事 —— ① 本轮【注入约束】段**原样**是什么（与真实注入逐字节一致）；
//   ② 库里还有哪些**非公共信息**没进注入（按维度聚合 + 标题 + 知情摘要 + 原因：
//      关键词未命中 / 候选未入选〔条数上限 / 预算不足〕）。
// 口径：复用 buildMemoryBodyForInject 的 diagnose 模式与 buildInjectConstraints（同一份代码路径）；
//   只读、零 AI、不写 state、不动 uses（countUses:false）。

function rumorInjLine(r) {
    try {
        if (!r) return '';
        const media = (Array.isArray(r.media) ? r.media : []);
        const act = media.filter(m => m && m.active !== false);
        const mediaTxt = act.length ? act.slice(0, 3).map(m => `${m.type}${m.name && m.name !== m.type ? '《' + m.name + '》' : ''}`).join('+') : '';
        const stopped = media.length - act.length;
        const who = (Array.isArray(r.carriers) ? r.carriers : []).slice(0, 4).map(c => `${c.who}${c.role && c.role !== '传播者' ? '（' + c.role + '）' : ''}`).join('、');
        const parts = [
            String(r.subject || ''),
            String(r.content || ''),
            `${r.objectivity || '主观'}·${r.stage || '萌芽'}`,
            `发酵度 ${Number(r.ferment) || 0}`,
        ];
        if (who) parts.push(`传播：${who}`);
        if (mediaTxt) parts.push(`载体：${mediaTxt}${stopped ? `（另有 ${stopped} 个载体已停）` : ''}`);
        return parts.filter(Boolean).join('｜');
    } catch (e) { return ''; }
}

// ==================== v1.72 平行事件「推进/演变」（手动 · 全部/单条） ====================
// 平行事件页顶部「全部推进」或每条右侧「推进」：把 记忆数据（最近楼层正文 + 相关原子上下文）与
// 「需推进的平行事件」现状一并交给 AI 逐一向前推进演变。
// 注意：这些事件**不一定与 user 主角直接相关**——可能只是世界背景/间接相关——提示词明确
// 「禁止强行把事件牵引向 user 主角」（仅当事件本身已涉及主角才提主角），保持各自独立视角客观推进。

function buildSceneTreeLines(scenes) {
    const root = { children: {} };
    for (const s of scenes || []) {
        const arr = Array.isArray(s.pathArr) && s.pathArr.length ? s.pathArr : [s.name];
        let cur = root;
        arr.forEach((seg, i) => {
            cur = cur.children;
            if (!cur[seg]) cur[seg] = { name: seg, desc: '', children: {}, leafDesc: i === arr.length - 1 ? (s.desc || '') : '' };
            if (i === arr.length - 1 && s.desc && !cur[seg].desc) cur[seg].desc = s.desc;
            cur = cur[seg];
        });
    }
    const lines = [];
    (function walk(node, depth) {
        if (!node) return;
        if (node.name) {
            const label = node.name;
            const extra = node.desc ? `：${node.desc}` : '';
            lines.push(`${'  '.repeat(depth)}- ${label}${extra}`);
        }
        for (const k of Object.keys(node.children)) walk(node.children[k], depth + 1);
    })(root, -1);
    return lines.filter(l => l.trim());
}
// 全局统计：总记忆数（所有类目条目之和）
// ==================== v1.203：情节「合并总结」隐藏态（用户要求） ====================
// 用户要求：「情节…增加多选模式，可以批量总结选择的情节，合并后变为一个情节并标记为 A-B 的总结。
//   被总结的情节保留但隐藏，不参与淘汰等任何操作动作，确保被总结的情节持久存储，除非人工删除。」
// 口径：被总结的原情节**不删除**，只打 `hidden` + `summarizedBy` 标记；此后
//   ① 不参与注入 / 召回（本地与向量）/ 世界书标签等任何投喂；
//   ② 不参与存储上限裁剪（淘汰）、情节总结（半自动）、修复与质检、NSFW 扫描与固定规则替换、分段总结批次、去重等**任何自动动作**；
//   ③ 仍持久保存在 `state.atoms` 中，唯一消失途径 = 人工删除（多选批量删除或逐条删除）；
//   ④ 人工删除「总结情节」时，其来源情节自动恢复显示（避免内容被永久藏起来）。

function planPhaseLabel(v) { const p = normPhase(v); return PLAN_PHASE_LABEL[p] || ''; }
// 单行关联归一（幂等）；非法 → null

function markUsed(kind, item) {
    if (!item || !item.id) return;
    try {
        useBuffer[kind] = useBuffer[kind] || new Set();
        useBuffer[kind].add(item.id);
        item.uses = (Number(item.uses) || 0) + 1;
    } catch (e) { }
}

function scheduleUseFlush() {
    if (useFlushTimer) return;
    useFlushTimer = setTimeout(() => {
        useFlushTimer = null;
        try { saveState(); } catch (e) { }
    }, 3000);
}

// 取字段值（对象路径）

function latestPlotByFloor() {
    try {
        const list = activeAtoms().filter(a => a && a.validity !== 'inactive');   // v1.203：已总结隐藏的不作为「最近情节现场」
        if (!list.length) return null;
        const sorted = list.slice().sort((a, b) => ((Number(b.floorEnd) || 0) - (Number(a.floorEnd) || 0))
            || ((Number(b.floorStart) || 0) - (Number(a.floorStart) || 0))
            || String(b.date || '').localeCompare(String(a.date || '')));
        for (const a of sorted) {
            const locs = Array.isArray(a.locations) ? a.locations.filter(Boolean) : [];
            return {
                dim: 'atoms', node: a,
                date: clockDateValid(a.date) ? String(a.date).slice(0, 10) : '',
                time: String(a.time || '').slice(0, 20),
                location: String(locs.length ? locs[locs.length - 1] : '').slice(0, 60),
                entities: normalizeList(a.entities),
            };
        }
        return null;
    } catch (e) { return null; }
}
// ③ 降级：原子数据（情节 → 记忆）里**日期最新**的节点 —— 全局兜底，作为剧情时间依据

function atomLatestDated() {
    try {
        const pickDated = (arr, dim) => {
            let best = null;
            for (const x of (arr || [])) {
                if (!x || !clockDateValid(x.date)) continue;
                if (dim === 'atoms' && x.validity === 'inactive') continue;
                const d = String(x.date).slice(0, 10);
                if (!best || d > best.date || (d === best.date && (Number(x.floorEnd) || 0) > (Number(best.node.floorEnd) || 0))) {
                    best = { dim, node: x, date: d };
                }
            }
            return best;
        };
        const a = pickDated(activeAtoms(), 'atoms');   // v1.203：排除已总结隐藏
        const m = pickDated(state.memories, 'memories');
        let best = null;
        if (a && m) best = (m.date > a.date) ? m : a;
        else best = a || m;
        if (!best) return null;
        const locs = Array.isArray(best.node.locations) ? best.node.locations.filter(Boolean) : [];
        return {
            dim: best.dim, node: best.node, date: best.date,
            time: String(best.node.time || '').slice(0, 20),
            location: String(locs.length ? locs[locs.length - 1] : '').slice(0, 60),
            entities: best.dim === 'atoms' ? normalizeList(best.node.entities) : [],
        };
    } catch (e) { return null; }
}
// 统一解析：返回 { date, time, location, present, source:{…}, degraded }
//   opts.text：显式正文（不传则内部取最新 AI 回复；再拿不到 → 最近楼层窗口，仅用于日期/时间/地点）

function relConceptSuffix(anchor) {
    try { if (anchor && anchor.conceptRef) return `｜概念：${anchor.conceptRef}`; } catch (e) { }
    return '';
}
// 记忆行（关联感知；有差异 → 按角色分行）

/**
 * 重要度（V1 `calcImportance` / `importancePct` 逐字）：`clamp(base + uses × per, 0, 1)`，百分比四舍五入。
 * 列表行展示「调用N次 · 重要度M%」依赖它（v2.47.0 补齐）。
 */
function calcImportance(item) {
    const uses = Number(item && item.uses) || 0;
    const base = Number(cfg.importanceBase) || 0.12;
    const per = Number(cfg.importancePerUse) || 0.06;
    return clamp(base + uses * per, 0, 1);
}
function importancePct(item) { return Math.round(calcImportance(item) * 100); }

export { calcImportance, importancePct, atomTimeKey, atomTimeCmp, atomTimeAsc, atomTimeDesc, atomDateValid, recallEntryScore, recallImportance, recallHits, recallHay, recallQueryTokens, recallDateAnchor, recallMaxFloor, recallEntryVotes, markUsed, useBuffer, scheduleUseFlush, useFlushTimer, nameMatch, tagMatch, rawMatch, buildQueryText, matchPresentNames, injectPresentItems, injectNameCore, nameAliases, injectPresentHit, memInjectLines, planSuspRelPrefix, planSuspLine, planPhaseLabel, PLAN_PHASE_LABEL, relTag, relShortName, relWhoSummary, relRankOf, relDevLabel, relIsPresent, relPresentList, snapNameKey, rumorInjLine, parallelInjLine, parallelExpired, parallelDecayScore, buildSceneTreeLines, atomLatestDated, buildMemoryBodyForInject, buildInjectConstraints, injectPresentNames, latestPlotByFloor, relConceptSuffix, parallelRelPrefix };

// ==================== 移植补全（内核标识符门禁发现缺失依赖） ====================
function parallelRelPrefix(p) {
    let rows = [];
    try { rows = relLinksOf('parallels', p.id).filter(x => x.who); } catch (e) { rows = []; }
    const who = rows.length ? `相关：${rows.slice(0, 6).map(x => relShortName(x.who)).join('、')}` : '仅幕后';
    return `〔平行·${who}〕（角色不知情）`;
}
// —— 固定约束段（机械生成、与关键词召回解耦）——
