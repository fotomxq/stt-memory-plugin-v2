// ============================================================
// 单元测试 · v3.19.0「设定-NSFW弱化 → 🧠 词条分析」
//
// 用户原话：「设定-NSFW弱化，新增词条分析按钮。该功能用于抽取分析被标记为强NSFW的原子数据，
//   交给AI去识别哪些词汇涉及到强NSFW，以及应该提到为什么其他词汇。
//   最后输出保存到转化库，用于后续弱化NSFW使用。」
//
// 覆盖：
//   A 抽取：只取**留档为强**的原子数据（隐藏情节排除、过短字段排除、统计与排序口径）；
//   B 打包与提示词：每批 12 处、未分析优先、截断数；提示词含 JSON 契约与用户自定义模板；
//   C **强校验**（纯函数，逐条给出丢弃原因）：词必须出现在本次原文、替换不得仍露骨/不得含原词、
//     长度与字符集、日常词黑名单、已在库去重、**误伤护栏**（词在非强留档数据里过泛）；
//   D 落地：写入**转化库** + 同批补进识别词条库 + 账本（最近明细/上次结果）+ `saveCfg()` 落盘；
//   E 端到端 `runNsfwAnalyze`：AI 返回 → 落库 → 进度推进；全部分析过后**不再调用 AI**；重置进度后重新入队；
//     AI 无返回时**不动数据也不推进进度**；忙位拒绝。
//
// 运行：node tests/unit/nsfw-analyze.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setPersistHooks, saveCfg } from '../../core/model/runtime.js';
import { defaultCfg, PROMPT_TEMPLATES_V2 } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import { nsfwRuleList, nsfwKeywordList } from '../../core/nsfw.js';
import {
    NSFW_ANALYZE_BATCH, NSFW_ANALYZE_MAX_ADD, NSFW_ANALYZE_SPREAD_MAX, NSFW_ANALYZE_BLOCKLIST,
    nsfwAnalyzeCandidates, nsfwAnalyzePack, buildNsfwAnalyzePrompt, nsfwAnalyzeSanitize, nsfwAnalyzeSpread,
    nsfwAnalyzeTermCheck, nsfwAnalyzeIsKnown, applyNsfwAnalyzeResult, nsfwAnalyzeState,
    setNsfwAnalyzeHooks, nsfwAnalyzeMarkSeen, nsfwAnalyzeSeenCount, nsfwAnalyzeSeenReset, runNsfwAnalyze,
} from '../../core/nsfw-analyze.js';
import { nsfwAction, nsfwPageHtml, NSFW_ACTIONS } from '../../ui/nsfw.js';

const R = makeReporter('nsfw-analyze v3.19.0 NSFW 词条分析（强留档 → AI 找词 → 写转化库）');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => {
    const det = () => (typeof e === 'function' ? (() => { try { return e(); } catch (err) { return String((err && err.message) || err); } })() : e);
    if (c && typeof c.then === 'function') return c.then((v) => R.assert(n, v === true, det()));
    return R.assert(n, c === true, det());
};

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const uninstall = installGlobalHost(host, doc);

let savedCfg = 0, savedState = 0;
let logStore = {};
function boot(opts) {
    const o = opts || {};
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setPersistHooks({
        saveState: () => { savedState++; return true; },
        saveCfg: () => { savedCfg++; return true; },
        log: () => undefined, warn: () => undefined,
    });
    const st = emptyState();
    // 强留档情节：含**库里已有**的强词（做爱）与新词（湿滑花瓣 / 缠丝绳）
    st.atoms = [
        { id: 'a1', title: '夜谈', text: '两人在帐中做爱，湿滑花瓣般的触感让他失控。', nsfw: 'strong', floorStart: 1, floorEnd: 1 },
        { id: 'a2', title: '绳戏', text: '她用缠丝绳把人缚在柱上，低声发号施令。', nsfw: 'strong', floorStart: 2, floorEnd: 2 },
        { id: 'a3', title: '日常', text: '清晨的集市里，湿滑花瓣被摆在木盘上称重售卖。', nsfw: 'none', floorStart: 3, floorEnd: 3 },
        { id: 'a4', title: '弱', text: '他替她理了理衣领，指尖停顿了一下。', nsfw: 'weak', floorStart: 4, floorEnd: 4 },
        { id: 'a5', title: '短', text: '做爱', nsfw: 'strong', floorStart: 5, floorEnd: 5 },
        { id: 'a6', title: '已总结', text: '两人做爱后相拥，帐中一片安静。', nsfw: 'strong', floorStart: 6, floorEnd: 6, hidden: true },
    ];
    st.memories = [{ id: 'm1', title: '记忆', content: '她记得那夜的缠丝绳与湿滑花瓣。', nsfw: 'strong' }];
    st.items = [{ id: 'i1', name: '骨笛', desc: '普通乐器。', nsfw: 'none' }];
    setKernelState(st);
    logStore = o.log || {};
    setNsfwAnalyzeHooks({ getLog: () => logStore, saveLog: (v) => { logStore = v; } });
    setAiHooks(o.ai || { callAi: async () => ({ ok: true, text: '{}' }), feedText: () => '', busy: () => false });
    savedCfg = 0; savedState = 0;
    return st;
}
boot({});

// ---------- A 组：抽取口径 ----------
A('A1 抽取只取**留档为强**的字段：weak/none 不参与；已总结隐藏的情节不参与；过短字段（<8 字）不参与；统计区分「强条目 / 强字段 / 扫描条目」',
    (() => {
        const st = boot({});
        const scan = nsfwAnalyzeCandidates();
        const ids = scan.items.map((x) => x.dim + ':' + x.id + ':' + x.path);
        // 强且未隐藏、字段够长的：a1(text) a2(text) m1(content) 共 3 处；a3(none)/a4(weak)/a5(过短)/a6(hidden)/i1(none) 都不在
        const okIds = ids.indexOf('atoms:a1:text') >= 0 && ids.indexOf('atoms:a2:text') >= 0 && ids.indexOf('memories:m1:content') >= 0
            && ids.indexOf('atoms:a3:text') < 0 && ids.indexOf('atoms:a4:text') < 0 && ids.indexOf('atoms:a5:text') < 0
            && ids.indexOf('atoms:a6:text') < 0 && ids.indexOf('items:i1:desc') < 0;
        const okA1 = scan.total === 3 && scan.strongFields === 3 && scan.unseen === 3 && okIds
            && scan.strongItems === 4 && scan.scannedItems === (st.atoms.length - 1 + st.memories.length + st.items.length)
            && scan.byDim.atoms === 2 && scan.byDim.memories === 1 && scan.seenCount === 0;
        if (!okA1) console.log('A1-DEBUG ' + J({ total: scan.total, strongFields: scan.strongFields, unseen: scan.unseen, strongItems: scan.strongItems, scanned: scan.scannedItems, byDim: scan.byDim, seen: scan.seenCount, ids: ids, okIds: okIds }));
        return okA1;
    })(),
    () => J(nsfwAnalyzeCandidates().items.map((x) => x.dim + ':' + x.id)));

A('A2 打包与提示词：每批 ≤ ' + NSFW_ANALYZE_BATCH + ' 处、带编号/维度标签/字段路径与原文；提示词含严格 JSON 契约（词条 / 编号 / 词 / 替换 / 无法处理）与「词必须原样出现」要求；用户自定义模板优先',
    (() => {
        boot({});
        const pack = nsfwAnalyzePack();
        const prompt = buildNsfwAnalyzePrompt(pack);
        const sys = String(prompt[0].content);
        const usr = String(prompt[1].content);
        const baseOk = pack.entries.length === 3 && pack.entries[0].n === 1 && pack.entries[0].label === '情节'
            && pack.entries[0].path === 'text' && pack.entries[0].text.length > 0 && pack.truncated === 0
            && pack.total === 3 && pack.strongFields === 3
            && sys.indexOf('只输出 JSON') >= 0 && usr.indexOf('#1') >= 0 && usr.indexOf('"词条"') >= 0
            && usr.indexOf('原样') >= 0 && usr.indexOf('无法处理') >= 0;
        // 自定义模板优先（用户可改口径）
        cfg.promptTemplates = Object.assign({}, cfg.promptTemplates, { nsfwAnalyze: '【自定义词条分析模板】XYZ' });
        const custom = String(buildNsfwAnalyzePrompt(pack)[0].content);
        return baseOk && custom.indexOf('自定义词条分析模板') >= 0 && custom.indexOf('XYZ') >= 0
            && String(PROMPT_TEMPLATES_V2.nsfwAnalyze).indexOf('NSFW 词条分析') >= 0;
    })(),
    () => J(nsfwAnalyzePack().entries.map((e) => e.n + ':' + e.dim)));

// ---------- B 组：强校验（纯函数） ----------
A('B1 **强校验**逐条给原因：原文里没有的词（not-in-text）、替换仍露骨（to-still-nsfw）、替换含原词（to-contains-term）、相同（same）、单字（term-too-short）、含标点（bad-chars）、日常词黑名单（blocklist）、已在库（dup-library）、同批重复（dup-batch）、替换过长（to-too-long）一律不落库',
    (() => {
        boot({});
        const pack = nsfwAnalyzePack();
        const delta = {
            '词条': [
                { '编号': 1, '词': '湿滑花瓣', '替换': '花瓣般的触感', '理由': '器官代称柔化' },   // ✓
                { '编号': 1, '词': '不存在于原文的词', '替换': '无害', '理由': '造词' },           // not-in-text
                { '编号': 1, '词': '做爱', '替换': '做爱', '理由': '没改' },                       // same
                { '编号': 1, '词': '做爱', '替换': '做爱之事', '理由': '含原词' },                 // to-contains-term
                { '编号': 1, '词': '缠丝绳', '替换': '乳房', '理由': '仍露骨' },                   // to-still-nsfw
                { '编号': 2, '词': '缚', '替换': '束住', '理由': '单字' },                         // term-too-short
                { '编号': 2, '词': '低 声', '替换': '轻声', '理由': '含空格' },                    // bad-chars
                { '编号': 2, '词': '身体', '替换': '身形', '理由': '日常词' },                     // blocklist
                { '编号': 1, '词': '做爱', '替换': '亲密之举', '理由': '已在库' },                 // dup-library（内置词条 + 本次原文里出现）
                { '编号': 1, '词': '湿滑花瓣', '替换': '别的', '理由': '同批重复' },               // dup-batch
                { '编号': 1, '词': '做爱', '替换': 'x'.repeat(40), '理由': '转换词过长' },         // to-too-long
            ],
        };
        const san = nsfwAnalyzeSanitize(pack, delta, { skipSpread: true });
        const reasons = san.rejected.map((x) => x.from + '|' + x.reason).sort();
        const want = ['不存在于原文的词|not-in-text', '做爱|same', '做爱|to-contains-term', '缠丝绳|to-still-nsfw',
            '缚|term-too-short', '低 声|bad-chars', '身体|blocklist', '做爱|dup-library', '湿滑花瓣|dup-batch', '做爱|to-too-long'].sort();
        const okB1 = J(reasons) === J(want) && san.accepted.length === 1 && san.accepted[0].from === '湿滑花瓣'
            && san.accepted[0].to === '花瓣般的触感' && san.accepted[0].why === '器官代称柔化' && san.accepted[0].from_n === 1
            && san.examined === 11 && san.rejected.length === 10;
        if (!okB1) console.log('B1-DEBUG ' + J({ reasons: reasons, want: want, accepted: san.accepted, rejected: san.rejected, examined: san.examined }));
        return okB1;
    })(),
    () => J(nsfwAnalyzeSanitize(nsfwAnalyzePack(), { '词条': [{ '词': '做爱', '替换': '做爱' }] }, { skipSpread: true }).rejected));

A('B2 **误伤护栏**：词若在**非强留档**数据里出现 ≥ ' + NSFW_ANALYZE_SPREAD_MAX + ' 条即判「wide-use」丢弃（本例「湿滑花瓣」在 5 条日常数据里出现 → 丢弃并给出条数）；未达阈值则放行',
    (() => {
        const st = boot({});
        // 造 5 条非强留档数据，都含「湿滑花瓣」
        for (let i = 0; i < NSFW_ANALYZE_SPREAD_MAX; i++) st.atoms.push({ id: 'n' + i, title: '日常' + i, text: '湿滑花瓣在' + i + '号摊位上称重。', nsfw: 'none' });
        const spread = nsfwAnalyzeSpread('湿滑花瓣');
        const san = nsfwAnalyzeSanitize(nsfwAnalyzePack(), { '词条': [{ '编号': 1, '词': '湿滑花瓣', '替换': '花瓣触感', '理由': 'x' }] }, {});
        const wide = san.rejected.filter((x) => x.reason === 'wide-use')[0] || null;
        // 阈值内（如「缠丝绳」只在 1 条强数据里出现）→ 放行
        const san2 = nsfwAnalyzeSanitize(nsfwAnalyzePack(), { '词条': [{ '编号': 2, '词': '缠丝绳', '替换': '绳索', '理由': 'y' }] }, {});
        return spread === NSFW_ANALYZE_SPREAD_MAX && san.accepted.length === 0 && !!wide && wide.spread === NSFW_ANALYZE_SPREAD_MAX
            && san2.accepted.length === 1 && san2.accepted[0].from === '缠丝绳';
    })(),
    () => J({ spread: nsfwAnalyzeSpread('湿滑花瓣'), wide: nsfwAnalyzeSanitize(nsfwAnalyzePack(), { '词条': [{ '词': '湿滑花瓣', '替换': 'x' }] }, {}).rejected.map((x) => x.reason) }));

A('B3 词与库的判定助手：`nsfwAnalyzeTermCheck`（空/超长/单字/拉丁过短/含标点/合法）、`nsfwAnalyzeIsKnown`（内置词条命中 → true；新词 → false）、黑名单常量非空',
    (() => {
        boot({});
        const t = (v) => nsfwAnalyzeTermCheck(v);
        return t('').ok === false && t('').reason === 'empty'
            && t('做爱').ok === true && t('湿滑花瓣').ok === true && t('blowjob').ok === true
            && t('奶').reason === 'term-too-short' && t('ab').reason === 'term-too-short'
            && t('a'.repeat(30)).reason === 'term-too-long' && t('低 声').reason === 'bad-chars' && t('插入，射').reason === 'bad-chars'
            && nsfwAnalyzeIsKnown('做爱') === true && nsfwAnalyzeIsKnown('呻吟') === true
            && nsfwAnalyzeIsKnown('湿滑花瓣') === false && NSFW_ANALYZE_BLOCKLIST.length >= 30
            && NSFW_ANALYZE_BLOCKLIST.indexOf('身体') >= 0 && NSFW_ANALYZE_BLOCKLIST.indexOf('kiss') >= 0;
    })(),
    () => J([nsfwAnalyzeTermCheck('奶'), nsfwAnalyzeTermCheck('低 声'), nsfwAnalyzeIsKnown('做爱')]));

// ---------- C 组：落地（写转化库 + 识别词条库 + 账本 + 落盘） ----------
A('C1 **落地**：校验通过的对写入**转化库**（`cfg.nsfwRules` 立刻含 词→替换）并同批补进**识别词条库**（`cfg.nsfwKeywords`），返回值计数如实；账本记「最近一次结果 + 最近新增明细」；`saveCfg()` 被调用（由内核流程负责，UI 动作另行落盘）',
    (() => {
        boot({});
        cfg.nsfwRules = [];
        cfg.nsfwKeywords = [];
        const pack = nsfwAnalyzePack();
        const delta = { '词条': [
            { '编号': 1, '词': '湿滑花瓣', '替换': '花瓣般的触感', '理由': '器官代称柔化' },
            { '编号': 2, '词': '缠丝绳', '替换': '细绳', '理由': '器物柔化' },
            { '编号': 1, '词': '做爱', '替换': '亲近', '理由': '已在库' },
        ] };
        const r = applyNsfwAnalyzeResult(pack, delta, { now: 1700000000000 });
        const rules = nsfwRuleList();
        const kws = nsfwKeywordList();
        const has1 = rules.some((x) => x.from === '湿滑花瓣' && x.to === '花瓣般的触感');
        const has2 = rules.some((x) => x.from === '缠丝绳' && x.to === '细绳');
        const kwOk = kws.indexOf('湿滑花瓣') >= 0 && kws.indexOf('缠丝绳') >= 0;
        const lg = logStore || {};
        const okC1 = r.ok === true && r.added === 2 && r.dup === 1 && r.rejected === 0 && has1 && has2 && kwOk
            && r.rules === rules.length && r.keywords === kws.length
            && Number(lg.at) === 1700000000000 && Number(lg.added) === 2 && Number(lg.examined) === 3
            && Array.isArray(lg.items) && lg.items.length === 2 && lg.items[0].from === '湿滑花瓣' && lg.items[0].why === '器官代称柔化';
        if (!okC1) console.log('C1-DEBUG ' + J({ r: { ok: r.ok, added: r.added, dup: r.dup, rejected: r.rejected, examined: r.examined }, has1: has1, has2: has2, kwOk: kwOk, lg: { at: lg.at, added: lg.added, examined: lg.examined, items: (lg.items || []).length } }));
        return okC1;
    })(),
    () => J({ added: 2, rules: nsfwRuleList().length }));

await A('C2 落库后**立即可用**：把新词条写进转化库后，固定规则替换能机械转化该词（同一条词也进了识别词条库 → `nsfwKeywordHits` 命中）',
    (async () => {
        const st = boot({});
        const NS = await import('../../core/nsfw.js');
        cfg.nsfwRules = [];
        cfg.nsfwKeywords = [];
        applyNsfwAnalyzeResult(nsfwAnalyzePack(), { '词条': [{ '编号': 1, '词': '湿滑花瓣', '替换': '温热的触感', '理由': '柔化' }] }, {});
        const applied = NS.nsfwApplyRules('她的湿滑花瓣贴上来。');
        const hits = NS.nsfwKeywordHits('她的湿滑花瓣贴上来。');
        return applied.text === '她的温热的触感贴上来。' && applied.hits === 1 && applied.changed === true
            && hits.indexOf('湿滑花瓣') >= 0;
    })(),
    () => J(nsfwRuleList().filter((x) => x.from === '湿滑花瓣')));

await A('C3 UI 动作 `nsfwAnalyze`（AI 桩）与 `nsfwAnalyzeReset`：动作经动作表分发 → 写入转化库并回填提示（含「新增转化规则」）；重置动作清空分析进度且**不动库**',
    (async () => {
        const st = boot({ ai: { callAi: async () => ({ ok: true, text: J({ '词条': [{ '编号': 1, '词': '湿滑花瓣', '替换': '花瓣般的触感', '理由': '柔化' }] }) }), feedText: () => '', busy: () => false } });
        cfg.nsfwRules = [];
        cfg.nsfwKeywords = [];
        const before = nsfwRuleList().length;
        const r1 = await nsfwAction('nsfwAnalyze', {});
        const afterRules = nsfwRuleList();
        const added = afterRules.some((x) => x.from === '湿滑花瓣' && x.to === '花瓣般的触感');
        const seenAfter = nsfwAnalyzeSeenCount();
        const stState = nsfwAnalyzeState();
        const r2 = await nsfwAction('nsfwAnalyzeReset', {});
        const rulesKept = nsfwRuleList().some((x) => x.from === '湿滑花瓣');
        const okC3 = NSFW_ACTIONS.indexOf('nsfwAnalyze') >= 0 && NSFW_ACTIONS.indexOf('nsfwAnalyzeReset') >= 0
            && r1.ok === true && added === true && String(r1.note).indexOf('新增转化规则 1 条') >= 0
            && seenAfter === 3 && stState.last && Number(stState.last.added) === 1 && stState.items.length === 1
            && r2.ok === true && String(r2.note).indexOf('已重置词条分析进度') >= 0 && rulesKept === true
            && nsfwAnalyzeSeenCount() === 0 && nsfwRuleList().length === afterRules.length && afterRules.length === before + 1;
        if (!okC3) console.log('C3-DEBUG ' + J({ r1: { ok: r1.ok, note: String(r1.note).slice(0, 180) }, added: added, seenAfter: seenAfter, last: stState.last, items: stState.items.length, r2: { ok: r2.ok, note: String(r2.note).slice(0, 120) }, rulesKept: rulesKept, seenNow: nsfwAnalyzeSeenCount(), before: before, after: afterRules.length }));
        return okC3;
    })(),
    () => J({ seen: nsfwAnalyzeSeenCount(), rules: nsfwRuleList().length }));

// ---------- D 组：端到端流程（runNsfwAnalyze） ----------
await A('D1 端到端：AI 返回 → 写入转化库 + 账本 + `saveCfg()` 落盘；进度按**实际提交过的字段**推进（指纹表）',
    (async () => {
        const st = boot({ ai: { callAi: async () => ({ ok: true, text: '{}' }), feedText: () => '', busy: () => false } });
        cfg.nsfwRules = [];
        cfg.nsfwKeywords = [];
        const delta = { '词条': [
            { '编号': 1, '词': '湿滑花瓣', '替换': '温热的触感', '理由': '柔化' },
            { '编号': 2, '词': '缠丝绳', '替换': '细绳', '理由': '器物' },
        ] };
        const probe = nsfwAnalyzeSanitize(nsfwAnalyzePack(), delta, {});
        const r = await runNsfwAnalyze({ silent: true, aiText: J(delta), now: 1700000001000 });
        const rules = nsfwRuleList();
        const okD1 = r.ok === true && r.added === 2 && r.submitted === 3 && r.examined === 2 && r.truncated === 0
            && rules.some((x) => x.from === '湿滑花瓣') && rules.some((x) => x.from === '缠丝绳')
            && nsfwAnalyzeSeenCount() === 3 && savedCfg === 1
            && Number((logStore || {}).at) === 1700000001000 && Number((logStore || {}).added) === 2;
        if (!okD1) console.log('D1-DEBUG ' + J({ probe: probe, r: { ok: r.ok, added: r.added, submitted: r.submitted, examined: r.examined, rejectedList: r.rejectedList, dup: r.dup, details: r.details }, seen: nsfwAnalyzeSeenCount(), savedCfg: savedCfg, lg: { at: (logStore || {}).at, added: (logStore || {}).added } }));
        return okD1;
    })(),
    () => J({ added: 2, seen: nsfwAnalyzeSeenCount(), saveCfg: savedCfg }));

await A('D2 全部分析过后**不再调用 AI**（省 token）：第二次直接回 `skipped:"all-seen"`；点「♻ 重置分析进度」后重新入队并正常分析',
    (async () => {
        let calls = 0;
        const st = boot({ ai: { callAi: async () => { calls++; return { ok: true, text: J({ '词条': [{ '编号': 1, '词': '湿滑花瓣', '替换': '温热的触感', '理由': 'x' }] }) }; }, feedText: () => '', busy: () => false } });
        cfg.nsfwRules = [];
        cfg.nsfwKeywords = [];
        const r1 = await runNsfwAnalyze({ silent: true });
        const r2 = await runNsfwAnalyze({ silent: true });
        nsfwAnalyzeResetProgress();
        const r3 = await runNsfwAnalyze({ silent: true });
        return calls === 2 && r1.added === 1 && r2.skipped === 'all-seen' && r2.seen === 3 && r3.submitted === 3;
        function nsfwAnalyzeResetProgress() { nsfwAnalyzeSeenReset(); }
    })(),
    () => J({ calls: '见断言' }));

await A('D3 失败姿态：① AI 无返回 → 不动数据、回 `error:"no-ai"`、**进度不推进**；② 忙位 → `blocked`；③ 没有强留档数据 → `skipped:"no-strong"`；④ 已分析过但传 `reanalyze:true` → 仍会提交',
    (async () => {
        // ① 无返回
        let busy = false;
        boot({ ai: { callAi: async () => ({ ok: true, text: '' }), feedText: () => '', busy: () => busy } });
        cfg.nsfwRules = [];
        cfg.nsfwKeywords = [];
        const r1 = await runNsfwAnalyze({ silent: true });
        const seen1 = nsfwAnalyzeSeenCount();
        // ② 忙位
        busy = true;
        const r2 = await runNsfwAnalyze({ silent: true });
        // ③ 没有强留档
        busy = false;
        const st3 = boot({ ai: { callAi: async () => ({ ok: true, text: '{}' }), feedText: () => '', busy: () => false } });
        for (const it of st3.atoms) it.nsfw = 'none';
        st3.memories.forEach((it) => { it.nsfw = 'none'; });
        const r3 = await runNsfwAnalyze({ silent: true });
        // ④ 已全部分析 + reanalyze
        let calls = 0;
        boot({ ai: { callAi: async () => { calls++; return { ok: true, text: J({ '词条': [{ '编号': 1, '词': '湿滑花瓣', '替换': '温热的触感', '理由': 'x' }] }) }; }, feedText: () => '', busy: () => false } });
        cfg.nsfwRules = []; cfg.nsfwKeywords = [];
        await runNsfwAnalyze({ silent: true });
        const r4a = await runNsfwAnalyze({ silent: true });
        const r4b = await runNsfwAnalyze({ silent: true, reanalyze: true });
        const okD3 = r1.ok === false && r1.error === 'no-ai' && seen1 === 0
            && r2.blocked === true && r3.skipped === 'no-strong' && r3.strongItems === 0
            && r4a.skipped === 'all-seen' && calls === 2 && r4b.submitted === 3;
        if (!okD3) console.log('D3-DEBUG ' + J({ r1: { ok: r1.ok, error: r1.error }, seen1: seen1, r2: { blocked: r2.blocked, skipped: r2.skipped }, r3: { skipped: r3.skipped, strongItems: r3.strongItems, total: r3.total }, r4a: { skipped: r4a.skipped, seen: r4a.seen, total: r4a.total }, calls: calls, r4b: r4b }));
        return okD3;
    })(),
    () => J({ r1: 'no-ai', r2: 'blocked', r3: 'no-strong', r4: 'all-seen' }));

await A('D4 分页推进：候选多于一批时按批提交、如实回报余量；提交过的批次不再重复（未分析数递减）',
    (async () => {
        const st = boot({ ai: { callAi: async () => ({ ok: true, text: '{}' }), feedText: () => '', busy: () => false } });
        cfg.nsfwRules = []; cfg.nsfwKeywords = [];
        // 造 20 条强留档情节（每条一个够长字段）→ 20 处候选（先把既有强留档记忆让开）
        st.atoms = [];
        st.memories.forEach((it) => { it.nsfw = 'none'; });
        for (let i = 0; i < 20; i++) st.atoms.push({ id: 'b' + i, title: 'T' + i, text: '第' + i + '条：湿滑花瓣与缠丝绳的记述（足够长的一段正文）。', nsfw: 'strong' });
        const before = nsfwAnalyzeCandidates();
        const r1 = await runNsfwAnalyze({ silent: true });
        const mid = nsfwAnalyzeCandidates();
        const r2 = await runNsfwAnalyze({ silent: true });
        const after = nsfwAnalyzeCandidates();
        const okD4 = before.unseen === 20 && r1.submitted === NSFW_ANALYZE_BATCH && r1.truncated === 8
            && mid.unseen === 8 && r2.submitted === 8 && r2.truncated === 0 && after.unseen === 0
            && nsfwAnalyzeSeenCount() === 20;
        if (!okD4) console.log('D4-DEBUG ' + J({ before: before.unseen, r1: { submitted: r1.submitted, truncated: r1.truncated }, mid: mid.unseen, r2: { submitted: r2.submitted, truncated: r2.truncated }, after: after.unseen, seen: nsfwAnalyzeSeenCount() }));
        return okD4;
    })(),
    () => J({ seen: nsfwAnalyzeSeenCount() }));

R.assert('D5 单次落库上限 NSFW_ANALYZE_MAX_ADD：超出的对计入 `capped` 且**不写库**（防止一次刷爆转化库）', (() => {
    boot({});
    cfg.nsfwRules = []; cfg.nsfwKeywords = [];
    const st = state;
    // 造 45 个各不相同的新词（都出现在强留档原文里）
    const words = [];
    for (let i = 0; i < (NSFW_ANALYZE_MAX_ADD + 5); i++) words.push('新词' + String.fromCharCode(0x4e00 + i) + '甲');
    st.atoms = [{ id: 'cap', title: 'C', text: words.join('，') + '。', nsfw: 'strong' }];
    const pack = nsfwAnalyzePack();
    const delta = { '词条': words.map((w, i) => ({ '编号': 1, '词': w, '替换': '柔性表述' + i, '理由': 'x' })) };
    const before = nsfwRuleList().length;
    const r = applyNsfwAnalyzeResult(pack, delta, { skipSpread: true });
    return r.added === NSFW_ANALYZE_MAX_ADD && r.capped === 5 && nsfwRuleList().length === before + NSFW_ANALYZE_MAX_ADD;
})(), () => J({ added: nsfwAnalyzeState().cap, capped: 5 }));

R.assert('D6 指纹表上限与淘汰：记账超过 NSFW_ANALYZE_SEEN_CAP 时淘汰最旧（返回值为当前条数）', (() => {
    boot({});
    logStore = {};
    for (let i = 0; i < 320; i++) nsfwAnalyzeMarkSeen(['k' + i], 1000 + i);
    const n = nsfwAnalyzeSeenCount();
    const keys = Object.keys((logStore && logStore.seen) || {});
    return n === 300 && keys.length === 300 && keys.indexOf('k0') < 0 && keys.indexOf('k319') >= 0 && keys.indexOf('k20') >= 0;
})(), () => J({ seen: nsfwAnalyzeSeenCount() }));

if (uninstall) { try { uninstall(); } catch (e) { /* 忽略 */ } }
R.done();
