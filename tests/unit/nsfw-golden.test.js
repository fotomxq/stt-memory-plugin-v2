// ============================================================
// 单元测试 · B8-4 内容弱化（NSFW）（与**真实 V1 插件**逐项比对）
// 黄金样本：tests/fixtures/v1-golden-nsfw.json（oracle = 真实 V1 插件 v1.206 + stubFetch 固定 AI 返回）
// 覆盖：识别词条库 / 转化库增删改查、nsfwApplyRules（单遍不链式 / 长词优先 / 英文词界 / 误伤名单）、nsfwKeywordHits、
//   nsfwScan（隐藏情节排除 / 嵌套字段与数组展开）、nsfwSoftenPack、buildNsfwSoftenPrompt、nsfwFixedReplace（含镜像同步）、
//   applyNsfwSoftenResult（强校验：仍含关键词 / 过长 / 无变化 / 未知编号 / 无法处理）、runNsfwSoften（固定规则先跑 + AI 二次）、
//   nsfwSoftenState + 分析侧规则文本（供 buildSummaryPrompt 追加）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import {
    NSFW_SOFTEN_BATCH, NSFW_KEYWORDS, NSFW_RULES, NSFW_FIELD_MAP, nsfwKeywordList, nsfwRuleList,
    nsfwKeywordAdd, nsfwKeywordUpdate, nsfwKeywordDelete, nsfwKeywordReset,
    nsfwRuleAdd, nsfwRuleUpdate, nsfwRuleDelete, nsfwRuleReset, nsfwReplaceAutoOn,
    nsfwKeywordHits, nsfwApplyRules, nsfwFixedReplace, nsfwScan, nsfwSoftenPack, buildNsfwSoftenPrompt,
    applyNsfwSoftenResult, nsfwSoftenState, nsfwSoftenRuleText, runNsfwSoften,
} from '../../core/nsfw.js';
import { buildSummaryPrompt } from '../../core/prompt.js';
import { nsfwPageHtml, nsfwAction, NSFW_ACTIONS } from '../../ui/nsfw.js';
import { panelAction, panelBodyHtml, openPanel, setPanelHooks2, panelState } from '../../ui/panel.js';
import { settingsPageHtml } from '../../ui/settings-pages.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-nsfw.json'), 'utf8'));
const R = makeReporter('nsfw-golden B8-4 内容弱化（V1 对齐）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
/** 按给定键序规范化（JSON 字符串比较对键序敏感；oracle 的键序与函数返回可能不同） */
const canon = (obj, keys) => { const o = {}; keys.forEach((k) => { o[k] = obj[k]; }); return o; };
const getByPath = (obj, path) => { try { let cur = obj; for (const seg of String(path).split('.')) { if (cur == null) return undefined; cur = cur[seg]; } return cur; } catch (e) { return undefined; } };

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);

/** AI 桩（当前返回文本 + 调用计数） */
let aiText = '';
let aiCalls = 0;
setAiHooks({ callAi: async () => { aiCalls++; return { ok: true, text: aiText }; }, feedText: () => '', busy: () => false });

const A = async (name, fn, detail) => {
    let cond = false, extra = detail;
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    R.assert(name, cond === true, extra);
};

function boot(stateLike) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    setLastMessageId(1);
    setKernelState(Object.assign(emptyState(), clone(stateLike || {})));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    aiText = ''; aiCalls = 0;
    return state;
}

// ============================================================
// H 组：与 V1 逐项比对
// ============================================================
R.assert('H1 库规模与内容：识别词条 63 条 / 转化库 63 条（逐条对应）、字段表 12 维、单批 12 —— 与 V1 一致', (() => {
    boot({});
    const lib = {
        keywords: nsfwKeywordList().length, rules: nsfwRuleList().length,
        kwHead: nsfwKeywordList().slice(0, 6), kwTail: nsfwKeywordList().slice(-6),
        ruleHead: nsfwRuleList().slice(0, 3), ruleTail: nsfwRuleList().slice(-3),
        exposedKeywords: NSFW_KEYWORDS.length, exposedRules: NSFW_RULES.length,
        exposedFieldMapKeys: Object.keys(NSFW_FIELD_MAP).length, batch: NSFW_SOFTEN_BATCH,
    };
    return J(lib) === J(G.lib) && NSFW_SOFTEN_BATCH === 12;
})(), (() => { boot({}); return { k: nsfwKeywordList().length, r: nsfwRuleList().length }; })());

R.assert('H2 固定规则替换 nsfwApplyRules：6 组文本（中文 / 英文词形 / 普通词误伤 / 混合 / 无命中）逐字符与 V1 一致', (() => {
    boot({});
    const bad = G.inputs.applyCases.filter((t, i) => J(nsfwApplyRules(t)) !== J(G.apply[i].out));
    return bad.length === 0;
})(), (() => { boot({}); return G.inputs.applyCases.map((t) => [t, nsfwApplyRules(t)]); })());

R.assert('H3 命中判定 nsfwKeywordHits：与替换同一口径（英文词界 + 误伤名单），6 组结果与 V1 一致', (() => {
    boot({});
    const bad = G.inputs.applyCases.filter((t, i) => J(nsfwKeywordHits(t)) !== J(G.hits[i].hits));
    return bad.length === 0;
})(), (() => { boot({}); return nsfwKeywordHits('Cum drainage and cumulative growth in a document; masturbation noted.'); })());

R.assert('H4 单遍替换语义：自定义规则 A→B、B→C 不链式；重叠按「长词优先」—— 与 V1 一致', (() => {
    boot({});
    cfg.nsfwRules = [{ from: '甲', to: '乙' }, { from: '乙', to: '丙' }, { from: '插入', to: '进入' }, { from: '插', to: '戳' }];
    const a = nsfwApplyRules('甲与乙，插入与插');
    const b = nsfwApplyRules('他插入');
    cfg.nsfwRules = [];
    return J(a) === J(G.noChain) && J(b) === J(G.overlap);
})(), '');

R.assert('H5 词条库操作序列（新增/查重/改名/改名冲突/删除/恢复内置）6 步结果与 V1 一致', (() => {
    boot({});
    const ops = [];
    cfg.nsfwKeywords = [];
    ops.push(['add', nsfwKeywordAdd('自定义词甲')]);
    ops.push(['add-dup', nsfwKeywordAdd('自定义词甲')]);
    ops.push(['update', nsfwKeywordUpdate(0, '自定义词乙')]);
    ops.push(['update-dup', nsfwKeywordUpdate(0, '自定义词乙')]);
    ops.push(['delete', nsfwKeywordDelete(0)]);
    ops.push(['reset', nsfwKeywordReset()]);
    cfg.nsfwKeywords = [];
    return J(ops) === J(G.kwOps);
})(), (() => { boot({}); const ops = []; cfg.nsfwKeywords = []; ops.push(['add', nsfwKeywordAdd('自定义词甲')]); return ops; })());

R.assert('H6 转化库操作序列（新增/查重/改名/删除/恢复内置）5 步结果与 V1 一致', (() => {
    boot({});
    const rops = [];
    cfg.nsfwRules = [];
    rops.push(['add', nsfwRuleAdd('测试词', '替换词')]);
    rops.push(['add-dup', nsfwRuleAdd('测试词', '别的')]);
    rops.push(['update', nsfwRuleUpdate(0, '测试词2', '替换词2')]);
    rops.push(['delete', nsfwRuleDelete(0)]);
    rops.push(['reset', nsfwRuleReset()]);
    cfg.nsfwRules = [];
    return J(rops) === J(G.ruleOps);
})(), (() => { boot({}); const rops = []; cfg.nsfwRules = []; rops.push(['add', nsfwRuleAdd('测试词', '替换词')]); return rops; })());

R.assert('H7 扫描 nsfwScan：命中总数/按维度/扫描条目与字段数/逐条（维度·id·路径·命中词）与 V1 一致（隐藏情节被排除）', (() => {
    boot(G.inputs.scenario);
    const s = nsfwScan();
    const got = { total: s.total, byDim: s.byDim, scannedItems: s.scannedItems, scannedFields: s.scannedFields, items: s.items.map(x => [x.dim, x.id, x.path, x.hits]) };
    return J(got) === J(G.scan) && s.total === 9 && s.scannedItems === 6;
})(), (() => { boot(G.inputs.scenario); const s = nsfwScan(); return { total: s.total, byDim: s.byDim, scannedItems: s.scannedItems, scannedFields: s.scannedFields }; })());

R.assert('H8 打包 nsfwSoftenPack：条目结构（编号·标签·路径·命中·标题）+ 总量/截断/维度统计与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const p = nsfwSoftenPack();
    const keys = ['entries', 'total', 'truncated', 'byDim', 'scannedItems', 'scannedFields'];
    return J(canon(p, keys)) === J(canon(G.pack, keys));
})(), (() => { boot(G.inputs.scenario); const p = nsfwSoftenPack(); return { total: p.total, entries: p.entries.length }; })());

R.assert('H9 弱化提示词 buildNsfwSoftenPrompt：system（模板）+ user（清单/命中词/原文截断/输出契约）与 V1 逐字符一致', (() => {
    boot(G.inputs.scenario);
    const p = nsfwSoftenPack();
    return J(buildNsfwSoftenPrompt(p)) === J(G.prompt);
})(), '');

R.assert('H10 固定规则替换落地 nsfwFixedReplace：字段/处数/条目数与改写后的状态（含 text↔content 镜像同步、隐藏情节不动）与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const fx = nsfwFixedReplace({ silent: true });
    const keys = ['ok', 'fields', 'replaced', 'items', 'skipped', 'details'];
    const gotState = {
        a1text: state.atoms[0].text, a1content: state.atoms[0].content,
        a2text: state.atoms[1].text, a3text: state.atoms[2].text,
        m1: state.memories[0].text, snapTraits: state.snapshots[0].personality.traits, snapAppearance: state.snapshots[0].appearance,
        segLine0: state.plotSegments[0].lines[0].text, segLine1: state.plotSegments[0].lines[1].text,
        sceneDesc: state.scenes[0].desc,
        a1updated: Number(state.atoms[0].updatedAt) > 0,
    };
    return J(canon(fx, keys)) === J(G.fixed) && J(gotState) === J(G.fixedState);
})(), '');

R.assert('H11 应用 AI 结果 applyNsfwSoftenResult：合格 1 / 无变化 1 / 丢弃 3（仍含关键词·过长）/ 无法判定 1，状态与 V1 一致', (() => {
    boot(G.inputs.scenario);
    const p = nsfwSoftenPack();
    const delta = {
        '弱化': [
            { '编号': 1, '文本': '两人亲近之后相拥，她低声呢喃，他替她理好衣襟。', '说明': '改写露骨描写' },
            { '编号': 2, '文本': String(p.entries[1].text).trim() },
            { '编号': 3, '文本': '这一段仍在描写做爱的细节。', '说明': '仍含关键词' },
            { '编号': 4, '文本': '这是一段非常长的文本'.repeat(30) },
            { '编号': 99, '文本': '不存在的编号' },
        ],
        '无法处理': [2],
    };
    const ap = applyNsfwSoftenResult(p, delta);
    const keys = ['applied', 'skipped', 'unchanged', 'unable', 'failed', 'details'];
    const gotState = {
        entries: p.entries.map(e => [e.n, e.dim, e.path, String(e.text).slice(0, 18)]),
        after: p.entries.map(e => {
            const it = (state[e.dim] || []).find(x => String(x.id) === String(e.id));
            return [e.n, String(getByPath(it, e.path)).slice(0, 18)];
        }),
    };
    return J(canon(ap, keys)) === J(G.applyAi) && J(gotState) === J(G.applyAiState);
})(), '');

await A('H12 runNsfwSoften（固定规则自动阶段开启）：先机械转化全部命中 → 无剩余交 AI，made=0 且状态与 V1 一致', async () => {
    boot(G.inputs.scenario);
    cfg.nsfwReplaceAuto = true;
    const r = await runNsfwSoften({ silent: true });
    const keys = ['made', 'applied', 'unchanged', 'unable', 'skipped', 'failed', 'total', 'submitted', 'truncated', 'fixed', 'details'];
    const gotState = {
        a1text: state.atoms[0].text, a1content: state.atoms[0].content, a2text: state.atoms[1].text,
        m1: state.memories[0].text, snapTraits: state.snapshots[0].personality.traits,
    };
    return J(canon(r, keys)) === J(G.run) && J(gotState) === J(G.runState) && aiCalls === 0;
}, '');

await A('H13 runNsfwSoften（关闭固定规则自动阶段）：AI 二次弱化 —— 应用 1 / 丢弃 2（仍含关键词·过长）/ 无法判定 1，状态与 V1 一致', async () => {
    boot(G.inputs.scenario);
    cfg.nsfwReplaceAuto = false;
    aiText = G.inputs.aiSoften;
    const r = await runNsfwSoften({ silent: true });
    const keys = ['made', 'applied', 'unchanged', 'unable', 'skipped', 'failed', 'total', 'submitted', 'truncated', 'fixed', 'details'];
    const gotState = {
        a1text: state.atoms[0].text, a1content: state.atoms[0].content,
        a2text: state.atoms[1].text, m1title: state.memories[0].title,
    };
    return J(canon(r, keys)) === J(G.runAiOnly) && J(gotState) === J(G.runAiOnlyState) && aiCalls === 1;
}, '');

await A('H14 状态摘要 nsfwSoftenState（与 V1 同为「固定规则替换完成后」的快照）：候选归零、库规模与自动开关一致', async () => {
    boot(G.inputs.scenario);
    cfg.nsfwReplaceAuto = true;
    await runNsfwSoften({ silent: true });          // oracle 在同一序列后取该快照
    return J(nsfwSoftenState()) === J(G.state) && nsfwReplaceAutoOn() === true && G.ruleAutoOff === true;
}, (() => { boot(G.inputs.scenario); return nsfwSoftenState(); })());

// ============================================================
// P 组：分析侧开关与 V2 自身行为
// ============================================================
await A('P1 分析侧规则：开关关闭 → 不追加；开启 → buildSummaryPrompt 追加「内容弱化（NSFW）」模板（V1 同口径）', async () => {
    boot({});
    cfg.nsfwSoftenEnabled = false;
    const off = nsfwSoftenRuleText();
    cfg.nsfwSoftenEnabled = true;
    const on = nsfwSoftenRuleText();
    const prompt = await buildSummaryPrompt('【第1楼 AI】正文', ['atoms']);
    const txt = J(prompt);
    return off === '' && on.indexOf('内容弱化') >= 0 && txt.indexOf('内容弱化') >= 0;
}, '');

await A('P2 无命中且固定规则自动开启：固定阶段无事可做 → AI 不被调用，如实回报 scanned 统计', async () => {
    boot({});
    state.atoms = [{ id: 'a1', text: '平静的日常对话。', title: '平静的日常对话。', tags: [], uses: 0, floorStart: 1, floorEnd: 2 }];
    const r = await runNsfwSoften({ silent: true });
    return r.skipped === true && r.total === 0 && aiCalls === 0 && r.scannedItems >= 1;
}, '');

await A('P3 长任务在途（busy 钩子）→ 拒绝且不调用 AI（V2 以「拒绝」替代 V1 的管线提示）', async () => {
    boot(G.inputs.scenario);
    const cur = setAiHooks({});
    setAiHooks({ busy: () => true });
    const r = await runNsfwSoften({ silent: true });
    setAiHooks({ busy: cur.busy });
    return r.blocked === true && r.made === 0;
}, '');

await A('P4 AI 无返回：如实回报 error=no-ai 且不改数据（固定规则阶段若已改写则照实回报 fixed）', async () => {
    boot(G.inputs.scenario);
    cfg.nsfwReplaceAuto = false;
    aiText = '';
    const before = J(state.atoms.map(x => x.text));
    const r = await runNsfwSoften({ silent: true });
    return r.error === 'no-ai' && J(state.atoms.map(x => x.text)) === before && r.fixed === null;
}, '');

// ============================================================
// U 组：设定页与动作接线
// ============================================================
R.assert('U1 设定「内容弱化」页：分节（内容弱化 / 固定规则替换 / 转化库 / 识别词条库）+ V1 同名动作按钮齐备', (() => {
    boot(G.inputs.scenario);
    const html = nsfwPageHtml();
    return html.indexOf('内容弱化（NSFW）') >= 0 && html.indexOf('固定规则替换（不调用 AI 的机械转化）') >= 0
        && html.indexOf('转化库（匹配词 → 转化词，可在设定中管理）') >= 0 && html.indexOf('识别词条库（用于匹配需弱化的内容）') >= 0
        && ['nsfwSoften', 'nsfwRuleApply', 'nsfwRuleAdd', 'nsfwRuleReset', 'nsfwKwAdd', 'nsfwKwReset', 'nsfwKwSave', 'nsfwKwDel', 'nsfwRuleSave', 'nsfwRuleDel']
            .every((a) => html.indexOf('data-ftt-action="' + a + '"') >= 0)
        && html.indexOf('data-ftt-nsfw-kw-new') >= 0 && html.indexOf('data-ftt-nsfw-rule-new-from') >= 0 && NSFW_ACTIONS.length === 10;
})(), '');

R.assert('U2 设定页接入：safety 子页渲染该页（不再是「待后续批次」占位）', (() => {
    boot(G.inputs.scenario);
    const html = settingsPageHtml('safety');
    return html.indexOf('内容弱化（NSFW）') >= 0 && html.indexOf('data-ftt-action="nsfwSoften"') >= 0
        && html.indexOf('属后续批次') < 0;
})(), '');

await A('U3 词条库动作：nsfwKwAdd / nsfwKwSave / nsfwKwDel / nsfwKwReset 改库并回填提示（payload 取值）', async () => {
    boot({});
    cfg.nsfwKeywords = [];
    // V1 口径：首次编辑会先把内置库物化为自定义列表（63 条）再增/改/删
    const add = await nsfwAction('nsfwKwAdd', { text: '露骨词甲' });
    const afterAdd = cfg.nsfwKeywords.slice();
    const save = await nsfwAction('nsfwKwSave', { idx: 0, text: '露骨词乙' });
    const afterSave = cfg.nsfwKeywords.slice();
    const del = await nsfwAction('nsfwKwDel', { idx: 0 });
    const afterDel = cfg.nsfwKeywords.slice();
    const reset = await nsfwAction('nsfwKwReset', {});
    return add.ok === true && String(add.note).indexOf('已加入词条库') >= 0
        && afterAdd.length === 64 && afterAdd[afterAdd.length - 1] === '露骨词甲'
        && save.ok === true && afterSave.length === 64 && afterSave[0] === '露骨词乙'
        && del.ok === true && afterDel.length === 63 && afterDel.indexOf('露骨词乙') < 0
        && reset.ok === true && String(reset.note).indexOf('已恢复内置默认词条') >= 0 && cfg.nsfwKeywords.length === 0;
}, '');

await A('U4 转化库与执行动作：nsfwRuleAdd / nsfwRuleApply / nsfwSoften 经面板分发执行并回填提示', async () => {
    boot(G.inputs.scenario);
    cfg.nsfwRules = [];
    openPanel('settings');
    setPanelHooks2({});
    await panelAction('settingsSub', { sub: 'safety' });
    const page = panelBodyHtml('settings');
    const add = await panelAction('nsfwRuleAdd', { from: '呻吟声', to: '低声' });   // 自定义匹配词（不与内置重复）
    aiText = G.inputs.aiSoften;                    // 「弱化」动作走 AI（固定规则关自动阶段，保留候选给 AI）
    cfg.nsfwReplaceAuto = false;
    const soft = await panelAction('nsfwSoften', {});
    const apply = await panelAction('nsfwRuleApply', {});
    const st = panelState();
    return page.indexOf('data-ftt-settings-page="safety"') >= 0 && page.indexOf('data-ftt-action="nsfwSoften"') >= 0
        && add.ok === true && soft.ok === true && String(soft.note).indexOf('弱化 NSFW') >= 0
        && apply.ok === true && String(apply.note).indexOf('固定规则替换') >= 0
        && String(st.note).length > 0;
}, '');

un();
R.done();
