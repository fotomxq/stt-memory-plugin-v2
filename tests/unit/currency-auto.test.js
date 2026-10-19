// ============================================================
// 单元测试 · v3.50.30 **货币无法自动变更**（用户报告）
//
// 用户原话：「剧情明明提到了资金变化，且关键词也有，但货币完全没反应。请核对注入机制、提示词设计缺陷等问题。」
//   补充：「货币可以手动添加，这个没异常。只是注入机制、提示词变更机制存在缺陷，AI无法正常自动变更货币。」
//
// 三处根因（本轮逐条修）：
//   ① **注入机制**：非主角货币的匹配写成 `hay.includes(q)`（拿**整段正文**去比「归属+币种+备注」）→ 永远不命中
//      → 该货币**从不注入** → AI 没有账本参照，改不动；
//   ② **提示词变更机制**：`buildSummaryPrompt` 用 `else if (pt[d])` 取维度模板 —— 模板为空 / 缺失（旧存档、
//      误清空、迁移缺键）时**整维说明静默消失**（货币块整段不见），AI 收不到「记录货币」的指令；
//   ③ **提示词设计**：【货币】块没有「资金变化 → 必须记录」的触发规则，AI 遇到「说不清具体数字」就整条不记。
//
// 运行：node tests/unit/currency-auto.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { buildSummaryPrompt } from '../../core/prompt.js';
import { summaryDimsForPrompt } from '../../host/extract.js';
import { buildMemoryBodyForInject } from '../../core/recall.js';
import { mergeDelta } from '../../core/ingest.js';
import { PROMPT_TEMPLATES_V2 } from '../../core/prompts-v2.js';
import { defaultCurrencyOwner } from '../../core/model/money.js';

const R = makeReporter('currency-auto v3.50.30 货币自动变更（注入 / 提示词兜底 / 触发规则）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

const host = makeHost({ chat: [{ is_user: false, mes: '她掏出三枚银币买了面包，钱袋见底。' }] });
installGlobalHost(host, makeDocument(['ftt-panel']));
function boot(seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:currency-auto');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(1);
    const st = emptyState();
    st.atoms = [{ id: 'a1', title: '买面包', text: '她掏出三枚银币买了面包，钱袋见底。', date: '1919-11-29', floorStart: 1, floorEnd: 1, tags: ['银币'] }];
    Object.assign(st, seed || {});
    setKernelState(st);
    setLoadPhase('ready');
    return st;
}

// ---------- ① 注入机制 ----------
A('A1 **非主角货币按「正文提到币种/单位」注入**：正文「三枚银币」→ 李瑶·银元（单位 枚）此前不注入，现在注入', (() => {
    boot({ currencies: [
        { id: 'c1', owner: '主角', name: '银元', amount: 62, unit: '枚', tags: ['现金'], date: '1919-11-29' },
        { id: 'c2', owner: '李瑶', name: '银元', amount: 5, unit: '枚', tags: ['现金'], date: '1919-11-29' },
    ] });
    const body = String(buildMemoryBodyForInject('她掏出三枚银币买了面包，钱袋见底。'));
    return body.indexOf('李瑶·银元') >= 0 && body.indexOf('主角·银元') >= 0;
})(), 'n/a');
A('A2 正文**没提**该角色与币种时仍不注入（不制造噪音）：只有「主角」恒定列出', (() => {
    boot({ currencies: [
        { id: 'c1', owner: '主角', name: '银元', amount: 62, unit: '枚', tags: ['现金'], date: '1919-11-29' },
        { id: 'c2', owner: '李瑶', name: '金条', amount: 2, unit: '根', tags: ['藏宝'], date: '1919-11-29' },
    ] });
    const body = String(buildMemoryBodyForInject('天气很好，他去公园散步。'));
    return body.indexOf('主角·银元') >= 0 && body.indexOf('李瑶·金条') < 0;
})(), 'n/a');
A('A3 归属名被正文提及时注入（`nameMatch` 方向正确）', (() => {
    boot({ currencies: [{ id: 'c2', owner: '李瑶', name: '金条', amount: 2, unit: '根', tags: ['藏宝'], date: '1919-11-29' }] });
    const body = String(buildMemoryBodyForInject('李瑶把东西收进箱子。'));
    return body.indexOf('李瑶·金条') >= 0;
})(), 'n/a');

// ---------- ② 提示词兜底 ----------
A('B1 **模板被清空**（旧存档 / 误清空）时【货币】块**不再静默消失**：回落默认模板并在提示词中出现', (async () => {
    boot({});
    cfg.promptTemplates = Object.assign({}, cfg.promptTemplates, { currencies: '' });
    const msgs = await buildSummaryPrompt('她掏出三枚银币。', summaryDimsForPrompt());
    const sys = (msgs || []).map((m) => m.content).join('\n');
    return sys.indexOf('【货币】') >= 0 && sys.indexOf('记录什么：正文出现的持有货币信息') >= 0;
})(), 'n/a');
A('B2 模板**缺键**（undefined）时同样兜底；有自定义内容时**以用户为准**（不被默认覆盖）', (async () => {
    boot({});
    cfg.promptTemplates = Object.assign({}, cfg.promptTemplates);
    delete cfg.promptTemplates.currencies;
    const a = ((await buildSummaryPrompt('x', summaryDimsForPrompt())) || []).map((m) => m.content).join('\n');
    cfg.promptTemplates.currencies = '【货币】自定义口径：只记金币。';
    const b = ((await buildSummaryPrompt('x', summaryDimsForPrompt())) || []).map((m) => m.content).join('\n');
    return a.indexOf('【货币】') >= 0 && b.indexOf('【货币】自定义口径：只记金币。') >= 0 && b.indexOf('记录什么：正文出现的持有货币信息') < 0;
})(), 'n/a');

// ---------- ③ 提示词设计 ----------
A('C1 【货币】块含**强制触发规则**（资金变化必须记录 + 无精确总额也要记）', (() => {
    const blk = String(PROMPT_TEMPLATES_V2.currencies || '');
    return blk.indexOf('触发（**强制**）') >= 0 && blk.indexOf('没有精确总额也要记') >= 0
        && blk.indexOf('资金的收 / 支 / 转移 / 找零 / 报数 / 余额变化') >= 0;
})(), 'n/a');

// ---------- ④ 落库：AI 输出「更新」能真正改额度 ----------
A('D1 AI 给出「更新」（同归属 + 同币种 + 新额度）→ **覆盖额度**并追加收支（不是新增一条）', (() => {
    boot({ currencies: [{ id: 'c1', owner: '主角', name: '银元', amount: 62, unit: '枚', tags: ['现金'], date: '1919-11-29' }] });
    mergeDelta({ 货币: { 更新: [{ 归属: '主角', 币种: '银元', 额度: 12, 单位: '枚', 收支: [{ 日期: '1919-11-30', 增减: '支出', 数额: 50, 说明: '买面包' }] }] } });
    const rows = state.currencies || [];
    const mine = rows.filter((x) => x.owner === '主角' && x.name === '银元');
    return rows.length === 1 && mine.length === 1 && Number(mine[0].amount) === 12
        && Array.isArray(mine[0].history) && mine[0].history.length === 1;
})(), J(state.currencies));
A('D2 AI 只给「收支」不给额度 → 额度按「旧额度 + 净额」推算（不会丢失变化）', (() => {
    boot({ currencies: [{ id: 'c1', owner: '主角', name: '银元', amount: 62, unit: '枚', tags: ['现金'], date: '1919-11-29' }] });
    mergeDelta({ 货币: { 更新: [{ 归属: '主角', 币种: '银元', 收支: [{ 日期: '1919-11-30', 增减: '支出', 数额: 50, 说明: '买面包' }] }] } });
    const mine = (state.currencies || []).find((x) => x.owner === '主角' && x.name === '银元');
    return !!mine && Number(mine.amount) === 12;
})(), J(state.currencies));
A('D3 主角归属按 `defaultCurrencyOwner()` 归一：AI 写「主角」也能命中真实主角名的条目（同一账本）', (() => {
    const me = String(defaultCurrencyOwner() || '');
    boot({ currencies: [{ id: 'c1', owner: me, name: '银元', amount: 62, unit: '枚', tags: ['现金'] }] });
    mergeDelta({ 货币: { 新增: [{ 归属: '主角', 币种: '银元', 额度: 40 }] } });
    const rows = (state.currencies || []).filter((x) => x.name === '银元');
    return rows.length === 1 && Number(rows[0].amount) === 40;
})(), J({ me: defaultCurrencyOwner(), rows: state.currencies }));

R.done();
