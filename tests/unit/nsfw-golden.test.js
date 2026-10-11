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
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setNotifyHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import {
    NSFW_SOFTEN_BATCH, NSFW_KEYWORDS, NSFW_RULES, NSFW_FIELD_MAP, nsfwKeywordList, nsfwRuleList,
    nsfwKeywordAdd, nsfwKeywordUpdate, nsfwKeywordDelete, nsfwKeywordReset,
    nsfwRuleAdd, nsfwRuleUpdate, nsfwRuleDelete, nsfwRuleReset, nsfwReplaceAutoOn,
    nsfwKeywordHits, nsfwApplyRules, nsfwFixedReplace, nsfwScan, nsfwSoftenPack, buildNsfwSoftenPrompt,
    applyNsfwSoftenResult, nsfwSoftenState, nsfwSoftenRuleText, runNsfwSoften, NSFW_KEYWORDS_V1, NSFW_KEYWORDS_V310, NSFW_KEYWORDS_V312, NSFW_REPLACE_PAIRS,
    // v3.45.2（`docs/D22` W7）：投喂上限（超限判据的单一事实源）+ 运行账本钩子
    NSFW_TEXT_CAP, nsfwSoftenLogReset, setNsfwSoftenHooks,
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

/**
 * v3.10.0（用户要求「补充新的词条进去，扩大 NSFW 识别范围」）+ v3.12.0（用户要求「新增一些生僻词汇，
 * 尤其是涉及到重口味的内容」）—— **有意偏离 V1**：
 * 识别词条库与转化库在 V1 的 63 条之后**追加**了新词条（V1 的 63 条原样保留在前、顺序不变）。
 * 因此与 V1 黄金样本的「库规模 / 操作序列计数」比较需按**追加总量**归一：计数减去 `ADD` 后仍应与 V1 逐字一致。
 * 追加词条的**正向**行为（能命中、能转化、逐条有转化词）由 `tests/unit/nsfw-level.test.js` 的 G 组单独锁死。
 */
const V310 = NSFW_KEYWORDS_V310.length;
const V312 = NSFW_KEYWORDS_V312.length;
const ADD = V310 + V312;
const V1_COUNT = NSFW_KEYWORDS_V1.length;
const deshift = (v) => {
    if (Array.isArray(v)) return v.map(deshift);
    if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) o[k] = (k === 'n' || k === 'keywords' || k === 'rules') ? (Number(v[k]) - ADD) : deshift(v[k]);
        return o;
    }
    return v;
};

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
R.assert('H1 库规模与内容（v3.10.0 + v3.12.0 有意偏离 V1 · 计数已归一）：V1 的 63 条**原样在前**（头 6 / 尾部 6 逐字一致）+ 追加词条（逐条有转化词）、字段表 12 维、单批 12', (() => {
    boot({});
    const kw = nsfwKeywordList(), rl = nsfwRuleList();
    const prefixOk = V1_COUNT === 63
        && J(kw.slice(0, 6)) === J(G.lib.kwHead)                           // V1 头部原样
        && J(kw.slice(V1_COUNT - 6, V1_COUNT)) === J(G.lib.kwTail)         // V1 尾部原样（第 57–63 条）
        && kw.length === V1_COUNT + ADD && rl.length === kw.length
        && NSFW_KEYWORDS.every((k) => !!NSFW_REPLACE_PAIRS[k])             // 识别 / 转化逐条对应
        && NSFW_RULES.length === NSFW_KEYWORDS.length;
    const norm = {
        keywords: kw.length - ADD, rules: rl.length - ADD,
        kwHead: kw.slice(0, 6), kwTail: kw.slice(V1_COUNT - 6, V1_COUNT),
        ruleHead: rl.slice(0, 3), ruleTail: rl.slice(V1_COUNT - 3, V1_COUNT),
        exposedKeywords: NSFW_KEYWORDS.length - ADD, exposedRules: NSFW_RULES.length - ADD,
        exposedFieldMapKeys: Object.keys(NSFW_FIELD_MAP).length, batch: NSFW_SOFTEN_BATCH,
    };
    return prefixOk && J(norm) === J(G.lib) && NSFW_SOFTEN_BATCH === 12;
})(), (() => { boot({}); return { k: nsfwKeywordList().length, r: nsfwRuleList().length, v1: V1_COUNT, add: ADD, v310: V310, v312: V312 }; })());

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
    return J(deshift(ops)) === J(G.kwOps);   // v3.10.0：库扩容 → 计数减去追加量后与 V1 逐字一致
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
    return J(deshift(rops)) === J(G.ruleOps);   // v3.10.0：同上（有意偏离 V1）
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

// v3.45.2（`docs/D22` W7 `应-23`）**V1 偏离登记（三件套：黄金样本未改 + 测试内显式归一 + 文档说明）**：
//   `nsfwSoftenState()` 在 V1 的 11 键（enabled / candidates / byDim / scannedItems / scannedFields / batch /
//   keywords / custom / rules / rulesCustom / ruleAuto）之外**新增 `last`** —— 弱化运行账本（只读留痕，见
//   `core/nsfw.js` 的 `setNsfwSoftenHooks` 与 `adapters/settings.js#nsfwSoftenLog`）。
//   黄金样本 `G.state` **保持 V1 原样、一字未动**；此处**显式归一**：比对前剔除新增键，`last` 另由 W7 断言专门锁死。
//   文档说明见 `docs/D30` §2.8 / §8 与 `CHANGELOG.md` v3.45.2。
const V3452_STATE_KEYS = ['last', 'oversize'];
const stripNewStateKeys = (o) => { const c = clone(o); for (const k of V3452_STATE_KEYS) delete c[k]; return c; };

await A('H14 状态摘要 nsfwSoftenState（与 V1 同为「固定规则替换完成后」的快照）：候选归零、库规模与自动开关一致（**显式归一**：只比 V1 的 11 键）', async () => {
    boot(G.inputs.scenario);
    cfg.nsfwReplaceAuto = true;
    await runNsfwSoften({ silent: true });          // oracle 在同一序列后取该快照
    return J(stripNewStateKeys(deshift(nsfwSoftenState()))) === J(G.state) && nsfwReplaceAutoOn() === true && G.ruleAutoOff === true;   // v3.10.0：keywords/rules 计数归一
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
R.assert('U1 设定「NSFW弱化」页（v3.10.0 由「内容弱化」改名）：分节（NSFW 等级留档 / NSFW弱化 / 词条分析 / 固定规则替换 / 转化库 / 识别词条库）+ 动作按钮齐备（v3.8.0 增「🔖 立即补档」；v3.18.0 增「🧠 词条分析」与「♻ 重置分析进度」；v3.21.0 增转化库导出/导入 5 个动作）', (() => {
    boot(G.inputs.scenario);
    const html = nsfwPageHtml();
    return html.indexOf('>NSFW弱化</div>') >= 0 && html.indexOf('固定规则替换（不调用 AI 的机械转化）') >= 0
        && html.indexOf('🧠 词条分析（AI 找涉敏词 → 写入转化库）') >= 0 && html.indexOf('data-ftt-nsfw-analyze') >= 0
        && html.indexOf('转化库（匹配词 → 转化词，可在设定中管理）') >= 0 && html.indexOf('识别词条库（用于匹配需弱化的内容）') >= 0
        && ['nsfwSoften', 'nsfwLabelBackfill', 'nsfwAnalyze', 'nsfwAnalyzeReset', 'nsfwRuleApply', 'nsfwRuleAdd', 'nsfwRuleReset', 'nsfwKwAdd', 'nsfwKwReset', 'nsfwKwSave', 'nsfwKwDel', 'nsfwRuleSave', 'nsfwRuleDel',
            'nsfwRuleExport', 'nsfwRuleImportOpen']   // v3.21.0：转化库导出 / 展开导入框（常驻按钮）
            .every((a) => html.indexOf('data-ftt-action="' + a + '"') >= 0)
        // 导入框内的三个按钮**点开后才渲染**（省版面）→ 只要求动作在册，具体渲染由 v3.21.0 单测与冒烟 BU1 覆盖
        && ['nsfwRuleImportApply', 'nsfwRuleImportFile', 'nsfwRuleImportClose'].every((a) => NSFW_ACTIONS.indexOf(a) >= 0)
        && html.indexOf('data-ftt-nsfw-rule-import') < 0     // 未点开时不渲染粘贴框
        && html.indexOf('data-ftt-nsfw-kw-new') >= 0 && html.indexOf('data-ftt-nsfw-rule-new-from') >= 0
        && html.indexOf('data-ftt-nsfw-analyze-state') >= 0 && html.indexOf('data-ftt-nsfw-rule-io-state') >= 0
        && NSFW_ACTIONS.length === 18;   // v3.8.0：「🔖 立即补档」；v3.19.0：「🧠 词条分析」+「♻ 重置分析进度」；v3.21.0：转化库导出/导入 5 个
})(), '');

R.assert('U2 设定页接入：safety 子页渲染该页（不再是「待后续批次」占位）', (() => {
    boot(G.inputs.scenario);
    const html = settingsPageHtml('safety');
    return html.indexOf('>NSFW弱化</div>') >= 0 && html.indexOf('data-ftt-action="nsfwSoften"') >= 0
        && html.indexOf('属后续批次') < 0;
})(), '');

await A('U3 词条库动作：nsfwKwAdd / nsfwKwSave / nsfwKwDel / nsfwKwReset 改库并回填提示（payload 取值）', async () => {
    boot({});
    cfg.nsfwKeywords = [];
    // V1 口径：首次编辑会先把内置库物化为自定义列表（V1 63 条 + v3.10.0/v3.12.0 追加 → 动态取长度）再增/改/删
    const add = await nsfwAction('nsfwKwAdd', { text: '露骨词甲' });
    const afterAdd = cfg.nsfwKeywords.slice();
    const save = await nsfwAction('nsfwKwSave', { idx: 0, text: '露骨词乙' });
    const afterSave = cfg.nsfwKeywords.slice();
    const del = await nsfwAction('nsfwKwDel', { idx: 0 });
    const afterDel = cfg.nsfwKeywords.slice();
    const reset = await nsfwAction('nsfwKwReset', {});
    return add.ok === true && String(add.note).indexOf('已加入词条库') >= 0
        && afterAdd.length === V1_COUNT + ADD + 1 && afterAdd[afterAdd.length - 1] === '露骨词甲'
        && save.ok === true && afterSave.length === V1_COUNT + ADD + 1 && afterSave[0] === '露骨词乙'
        && del.ok === true && afterDel.length === V1_COUNT + ADD && afterDel.indexOf('露骨词乙') < 0
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

// ============================================================
// W 组：v3.45.2（`docs/D22` W7 · 来源稿 `docs/D30`）—— 转化库守门 / 超限保护 / 运行留痕
// ============================================================
/** 超限样本：`'做爱'` × 400 = 800 字 > `NSFW_TEXT_CAP`(600)，且确实命中关键词（故能进扫描） */
const LONG_OVER_CAP = '做爱'.repeat(400);
/** 记录通知（`notifyHooks.toast(text, kind)`）：断「回报里的超长跳过」是否真的送到用户面前 */
let toasts = [];
setNotifyHooks({ toast: (text, kind) => toasts.push([String(kind || ''), String(text || '')]) });

R.assert('W1 转化库守门（`技-36` / U181）：`NSFW_RULES` 的 `from` 无重复 · 每个识别词条都有转化词 · **源码里的 `NSFW_REPLACE_PAIRS` 字面量无重复键**（重复键在运行期不可见：后者静默覆盖前者）', (() => {
    boot({});
    const froms = NSFW_RULES.map((r) => r.from);
    const noDupFrom = new Set(froms).size === froms.length;
    const allCovered = NSFW_KEYWORDS.every((k) => !!NSFW_REPLACE_PAIRS[k]);
    // 对象字面量的**重复键**在求值后就只剩一个 —— 运行期查不出来，只能读源码核（U181 就是这么埋的）
    const src = readFileSync(join(ROOT, 'core', 'nsfw.js'), 'utf8');
    const i0 = src.indexOf('const NSFW_REPLACE_PAIRS = {');
    const i1 = src.indexOf('\n};', i0);
    const body = src.slice(i0, i1).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const keys = [];
    const re = /'([^']+)'\s*:/g;
    let m;
    while ((m = re.exec(body)) !== null) keys.push(m[1]);
    const dupKeys = keys.filter((k, idx) => keys.indexOf(k) !== idx);
    return i0 > 0 && i1 > i0 && noDupFrom && allCovered
        && NSFW_RULES.length === NSFW_KEYWORDS.length
        && keys.length === Object.keys(NSFW_REPLACE_PAIRS).length        // 字面量键数 == 求值后的键数（不相等即有重复键）
        && dupKeys.length === 0;
})(), (() => { boot({}); return { rules: NSFW_RULES.length, keywords: NSFW_KEYWORDS.length, pairs: Object.keys(NSFW_REPLACE_PAIRS).length }; })());

R.assert('W2 打包侧（`数-30` / U180）：正文长度 > `NSFW_TEXT_CAP`(600) 的字段**不入本批**并计入 `oversize`，其余照常入批', (() => {
    boot({ atoms: [{ id: 'a1', text: LONG_OVER_CAP, title: '超长' }, { id: 'a2', text: '两人做爱。', title: '短' }] });
    const p = nsfwSoftenPack();
    return NSFW_TEXT_CAP === 600 && p.total === 2 && p.oversize === 1 && p.truncated === 0
        && p.entries.length === 1 && String(p.entries[0].id) === 'a2'
        && nsfwSoftenState().oversize === 1;      // ① 只读核实口径：状态读数里也能看到「超长 N 处」
})(), (() => { boot({ atoms: [{ id: 'a1', text: LONG_OVER_CAP, title: '超长' }, { id: 'a2', text: '两人做爱。', title: '短' }] }); return nsfwSoftenPack().oversize; })());

R.assert('W3 落地侧复核（`数-30` ③）：即便拿到的是**旧清单**（含超限字段），写回前仍按实测长度拒绝 —— 正文逐字不变且 `oversize = 1`', (() => {
    boot({ atoms: [{ id: 'a1', text: LONG_OVER_CAP, title: '超长' }] });
    const before = state.atoms[0].text;
    const pack = { entries: [{ n: 1, dim: 'atoms', id: 'a1', path: 'text', text: before, hits: ['做爱'], label: '情节' }] };
    const out = applyNsfwSoftenResult(pack, { '弱化': [{ '编号': 1, '文本': '亲近' }] });
    return out.oversize === 1 && out.applied === 0 && out.skipped === 0 && state.atoms[0].text === before && before.length === 800;
})(), (() => {
    boot({ atoms: [{ id: 'a1', text: LONG_OVER_CAP, title: '超长' }] });
    const it = state.atoms[0];
    return applyNsfwSoftenResult({ entries: [{ n: 1, dim: 'atoms', id: 'a1', path: 'text', text: it.text, hits: ['做爱'] }] }, { '弱化': [{ '编号': 1, '文本': '亲近' }] });
})());

await A('W4 端到端（`数-30` ④）：超长字段被跳过、**回报与通知都写明「超长跳过 1 条」**，同批的短字段照常弱化（正文完好）', async () => {
    boot({ atoms: [{ id: 'a1', text: LONG_OVER_CAP, title: '超长' }, { id: 'a2', text: '两人做爱。', title: '短' }] });
    cfg.nsfwReplaceAuto = false;                     // 只走 AI 路（固定规则会先把关键词换掉，掩盖判定）
    aiText = J({ '弱化': [{ '编号': 1, '文本': '两人亲近。' }] });
    toasts = [];
    const r = await runNsfwSoften({});                // 非 silent：通知要真的发出来才可断言
    const a1 = state.atoms.find((x) => x.id === 'a1');
    const a2 = state.atoms.find((x) => x.id === 'a2');
    const toastTxt = toasts.map((x) => x[1]).join(' | ');
    return r.oversize === 1 && r.applied === 1 && r.submitted === 1 && r.total === 2
        && a1.text === LONG_OVER_CAP && a2.text === '两人亲近。'
        && toastTxt.indexOf('超长跳过 1 条') >= 0;
}, (() => { boot({ atoms: [{ id: 'a1', text: LONG_OVER_CAP }, { id: 'a2', text: '两人做爱。' }] }); return { cap: NSFW_TEXT_CAP }; })());

await A('W5 弱化运行留痕（`应-23` / U179）：跑完账本记下**时间与各项计数**，`nsfwSoftenState().last` 齐全，设定页状态行含时间与三项计数，且「刷新后仍在」（宿主账本被写入）', async () => {
    boot({ atoms: [{ id: 'a1', text: '两人做爱。' }, { id: 'a2', text: '又一次做爱。' }] });
    nsfwSoftenLogReset();
    let store = null;                                 // 模拟 ST 扩展设置 `nsfwSoftenLog`（宿主账本）
    setNsfwSoftenHooks({ getLog: () => store, saveLog: (v) => { store = v; } });
    cfg.nsfwReplaceAuto = false;
    aiText = J({ '弱化': [{ '编号': 1, '文本': '两人亲近。' }, { '编号': 2, '文本': '仍然做爱。' }] });
    const r = await runNsfwSoften({ silent: true });
    const last = nsfwSoftenState().last;
    setNsfwSoftenHooks({ getLog: null, saveLog: null });      // 还原（后续测试用进程内账本）
    const html = nsfwPageHtml();
    const when = (() => { try { return new Date(Number(last && last.at) || 0).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return ''; } })();
    return !!last && Number(last.at) > 0 && last.submitted === 2 && last.applied === 1 && last.skipped === 1
        && last.ok === true && Number(r.applied) === 1
        && !!store && Number(store.at) === Number(last.at) && Number(store.applied) === 1   // 账本真的落到宿主
        && html.indexOf('data-ftt-nsfw-soften-state') >= 0 && when.length > 0 && html.indexOf(when) >= 0
        && html.indexOf('提交 2 条') >= 0 && html.indexOf('已弱化 <b>1</b> 条') >= 0 && html.indexOf('丢弃 1') >= 0;
}, (() => { boot({ atoms: [{ id: 'a1', text: '两人做爱。' }] }); return nsfwSoftenState().last; })());

await A('W6 留痕口径（`应-23`）：**忙位被拒（`blocked`）的运行不记账** —— 那一次并没有真的跑，记进去会让「上次弱化」指向一次空转', async () => {
    boot({ atoms: [{ id: 'a1', text: '两人做爱。' }] });
    nsfwSoftenLogReset();
    const cur = setAiHooks({});
    setAiHooks({ busy: () => true });
    const r = await runNsfwSoften({ silent: true });
    setAiHooks({ busy: cur.busy });
    return r.blocked === true && nsfwSoftenState().last === null;
}, '');

un();
R.done();
