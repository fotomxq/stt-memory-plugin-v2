// ============================================================
// 单元测试 · v3.51.4 **长期收支修复**（`docs/D53` §3.4/§3.9；用户要求「每次只取 3 条交 AI」）
//
// 覆盖：① 选取（≤3 · 优先级 · 停摆不进包）② 打包（含剧情日期/正文/待修条目）③ 提示词窄契约
//   ④ 解析（容忍噪声）⑤ 机械校验（未知 id / 未来节点 / 节点不晚于最后变动 / 预测早于最后变动 / 方向按符号纠正）
//   ⑥ 应用（只改可写字段 · 保留 trigger/currencyId/id · 追加节点排序 · updatedAt）⑦ 端到端（注入 aiText）
//   ⑧ 失败不动数据（无 AI / 占用 / 空池）
// 运行：node tests/unit/deal-repair.test.js
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId, setLoadPhase } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { setAiHooks } from '../../core/ai-hooks.js';
import { DEAL_REPAIR_BATCH, dealRepairPick, dealRepairPack, dealRepairPrompt, dealRepairParse, dealRepairValidate, dealRepairApply, runDealRepair } from '../../core/deal-repair.js';

const R = makeReporter('deal-repair v3.51.4 长期收支修复（每批 3 条 · 窄契约 · 失败不动数据）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);

installGlobalHost(makeHost({ chat: [{ is_user: false, mes: 'x' }] }), makeDocument(['ftt-panel']));
function boot(seed) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('char:dealrepair');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setLastMessageId(1);
    const st = emptyState();
    st.state.date = '1920-06-01';
    st.currencies = [{ id: 'c1', owner: '主角', name: '银元', amount: 100, unit: '枚' }];
    const mk = (id, extra) => Object.assign({
        id: id, name: '标的' + id, desc: '', kind: 'other', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly',
        outlook: { text: '', nodes: [{ date: '1919-06-01', delta: 10, note: '首期' }], forecast: { nextDate: '1920-08-01', delta: 10, direction: 'increase', note: '', source: 'ai' } },
    }, extra || {});
    st.deals = [mk('d1'), mk('d2'), mk('d3'), mk('d4'), mk('d5')];
    Object.assign(st, seed || {});
    setKernelState(st);
    setLoadPhase('ready');
    setAiHooks({ callAi: async () => ({ ok: false, error: 'no-ai-in-test' }), feedText: () => '【正文】主角在1920-05-10收到船厂分成 50 银元。', busy: () => false });
    return st;
}

// ---------- A 选取 ----------
A('A1 每批**只取 3 条**（用户要求），并如实报总数 / 剩余 / 停摆数', (() => {
    boot();
    const p = dealRepairPick();
    return DEAL_REPAIR_BATCH === 3 && p.rows.length === 3 && p.total === 5 && p.truncated === 2 && p.stalled === 0;
})(), () => dealRepairPick());
A('A2 优先级：缺内容 / 预测已到期未兑现 的排在前面；**停摆（锚定货币失效）不进 AI 包**但计入 `stalled`', (() => {
    boot({
        deals: [
            { id: 'x1', name: '完整', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', desc: '写好的约定', status: '稳定', outlook: { text: '说明', nodes: [{ date: '1919-06-01' }], forecast: { nextDate: '1920-09-01', delta: 1, direction: 'increase', source: 'ai' } } },
            { id: 'x2', name: '缺现状', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', outlook: { text: '说明', nodes: [], forecast: { nextDate: '1920-09-01', delta: 1, direction: 'increase', source: 'ai' } } },
            { id: 'x3', name: '停摆', startDate: '1919-01-01', currencyId: 'gone', cycle: 'monthly', outlook: { text: '', nodes: [], forecast: { nextDate: '1920-01-01', delta: 1, direction: 'increase', source: 'ai' } }, trigger: { skippedReason: 'currency-missing' } },
            { id: 'x4', name: '过期', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', desc: 'd', status: 's', outlook: { text: 't', nodes: [{ date: '1919-06-01' }], forecast: { nextDate: '1920-01-01', delta: 1, direction: 'increase', source: 'ai' } } },
        ],
    });
    const p = dealRepairPick();
    const ids = p.rows.map((d) => d.id);
    return p.stalled === 1 && ids.indexOf('x3') < 0 && ids.length === 3 && ids[0] === 'x2';
})(), () => dealRepairPick().rows.map((d) => d.id));
A('A3 空池：没有可修条目 → `runDealRepair` 如实说「没有可修的条目」且不调 AI', (async () => {
    boot({ deals: [] });
    let called = 0;
    setAiHooks({ callAi: async () => { called += 1; return { ok: true, text: '{}' }; }, feedText: () => '', busy: () => false });
    const r = await runDealRepair({ skipTriggers: true });
    return r.ok === true && r.reason === 'empty' && called === 0 && String(r.note).indexOf('没有需要 AI 修订') >= 0;
})(), 'n/a');

// ---------- B 打包 / 提示词 ----------
A('B1 打包文本含：当前剧情日期 / 每条 id 与关键字段 / 已发生节点（近 3） / 预测 / 正文节选', (() => {
    boot();
    const pack = dealRepairPack({ pick: dealRepairPick() });
    const t = pack.text;
    return t.indexOf('1920-06-01') >= 0 && t.indexOf('d1 ') >= 0 && t.indexOf('已发生(近3)=') >= 0
        && t.indexOf('1919-06-01|10|首期') >= 0 && t.indexOf('预测下一=') >= 0 && t.indexOf('船厂分成') >= 0
        && pack.counts.entries === 3 && pack.counts.total === 5;
})(), 'n/a');
A('B2 提示词写明**窄契约**：只回 JSON · id 必须在包内 · nodes 只追加已发生 · forecast 是预测 · source=ai', (() => {
    boot();
    const prompt = dealRepairPrompt(dealRepairPack({ pick: dealRepairPick() }));
    return prompt.indexOf('只输出一个 JSON 对象') >= 0 && prompt.indexOf('id 必须来自') >= 0
        && prompt.indexOf('只能**追加**') >= 0 && prompt.indexOf('不要把预测写成已发生') >= 0 && prompt.indexOf('source=ai') >= 0;
})(), 'n/a');

// ---------- C 解析 / 校验 ----------
A('C1 解析容忍噪声（代码块 / 前后解释）→ 仍能取出 JSON；纯噪声 → `null`', (() => {
    const ok = dealRepairParse('好的，结果如下：\n```json\n{"items":[{"id":"d1"}]}\n```\n以上。');
    return ok && Array.isArray(ok.items) && ok.items[0].id === 'd1' && dealRepairParse('没有 JSON') === null && dealRepairParse('') === null;
})(), 'n/a');
A('C2 校验：**未知 id 整条跳过**；未到期/超前的节点跳过（`node-in-future`）；不晚于最后变动的节点跳过；预测早于最后变动跳过', (() => {
    boot();
    const pack = dealRepairPack({ pick: dealRepairPick({ max: 1 }) });
    const id = pack.rows[0].id;
    const v = dealRepairValidate({ items: [
        { id: 'nope', desc: 'x' },
        { id: id, nodes: [{ date: '1920-06-01', delta: 5, note: '当天' }, { date: '1930-01-01', delta: 5, note: '未来' }, { date: '1919-01-01', delta: 5, note: '太早' }], forecast: { nextDate: '1918-01-01', delta: 1 } },
    ] }, pack);
    const reasons = v.skipped.map((s) => s.reason);
    return v.items.length === 1 && reasons.indexOf('unknown-id') >= 0 && reasons.indexOf('node-in-future') >= 0
        && reasons.indexOf('node-not-after-last') >= 0 && reasons.indexOf('forecast-not-after-last') >= 0
        && v.items[0].patch.nodes.length === 2;   // 1919-06-01 首期 + 1920-06-01 当天
})(), () => dealRepairValidate({ items: [{ id: 'nope' }] }, dealRepairPack({ pick: dealRepairPick({ max: 1 }) })).skipped);
A('C3 校验：`direction` 与 `delta` 矛盾 → **以符号纠正**；`source` 强制 `ai`；描述类字段超长截断', (() => {
    boot();
    const pack = dealRepairPack({ pick: dealRepairPick({ max: 1 }) });
    const id = pack.rows[0].id;
    const v = dealRepairValidate({ items: [{ id: id, forecast: { nextDate: '1920-09-01', delta: -30, direction: 'increase', note: 'n' }, status: 'x'.repeat(300) }] }, pack);
    const p = v.items[0].patch;
    return p.forecast.direction === 'decrease' && p.forecast.source === 'ai' && p.status.length === 200;
})(), 'n/a');
A('C4 校验：**无可应用字段** → 记 `nothing-to-apply`（不产生空改动）', (() => {
    boot();
    const pack = dealRepairPack({ pick: dealRepairPick({ max: 1 }) });
    const v = dealRepairValidate({ items: [{ id: pack.rows[0].id }] }, pack);
    return v.items.length === 0 && v.skipped.some((s) => s.reason === 'nothing-to-apply');
})(), 'n/a');

// ---------- D 应用 ----------
A('D1 应用：只改可写字段；**保留 trigger / currencyId / id**；节点按日期排序；`updatedAt` 刷新', (() => {
    boot();
    state.deals[0].trigger = { lastFiredDate: '1920-01-01', lastFiredNodeDate: '1919-06-01', catchUpTruncated: false, skippedReason: '' };
    const v = { items: [{ id: 'd1', deal: state.deals[0], patch: { desc: '新约定', nodes: [{ date: '1919-06-01', delta: 10, note: '首期' }, { date: '1920-05-01', delta: 20, note: '追加' }], forecast: { nextDate: '1920-09-01', delta: 5, direction: 'increase', note: '', source: 'ai' } } }], skipped: [] };
    const r = dealRepairApply(v, { now: 12345 });
    const d = state.deals.filter((x) => x.id === 'd1')[0];
    return r.changed === 1 && d.desc === '新约定' && d.outlook.nodes.length === 2 && d.outlook.nodes[1].date === '1920-05-01'
        && d.outlook.forecast.nextDate === '1920-09-01' && d.trigger && d.trigger.lastFiredDate === '1920-01-01'
        && d.currencyId === 'c1' && d.id === 'd1' && d.updatedAt === 12345 && d.lastChangeDate === '1920-05-01';
})(), 'n/a');

// ---------- E 端到端 ----------
A('E1 端到端（注入 aiText）：挑 3 条 → 校验 → 落库；摘要如实报「本批 N / 共 M / 已更正 K」', (async () => {
    boot();
    const pick = dealRepairPick();
    const aiText = JSON.stringify({ items: pick.rows.map((d, i) => ({ id: d.id, status: '已更正' + (i + 1), forecast: { nextDate: '1920-09-01', delta: 10 + i, direction: 'increase', note: '按剧情' } })) });
    const r = await runDealRepair({ aiText: aiText, now: 999, skipTriggers: true });
    return r.ok === true && r.batch.entries === 3 && r.batch.total === 5 && r.changed === 3
        && state.deals.filter((d) => /已更正/.test(d.status)).length === 3
        && String(r.note).indexOf('本批 3 条') >= 0 && String(r.note).indexOf('已更正 3 条') >= 0;
})(), 'n/a');
A('E2 **失败不动数据**：AI 未返回可用结果 → 不改任何条目，且明确告知', (async () => {
    boot();
    const before = J(state.deals.map((d) => [d.id, d.desc, d.status, d.updatedAt]));
    const r = await runDealRepair({ aiText: '抱歉，我无法完成', skipTriggers: true });
    return r.ok === false && r.reason === 'no-ai' && J(state.deals.map((d) => [d.id, d.desc, d.status, d.updatedAt])) === before;
})(), 'n/a');
A('E3 占用中（`aiBusy`）→ 直接拒绝且不调 AI', (async () => {
    boot();
    let called = 0;
    setAiHooks({ callAi: async () => { called += 1; return { ok: true, text: '{}' }; }, feedText: () => '', busy: () => true });
    const r = await runDealRepair({ skipTriggers: true });
    return r.ok === true && r.reason === 'busy' && called === 0 && String(r.note).indexOf('AI 修复跳过') >= 0;
})(), 'n/a');

// ---------- F v3.51.8：两段式（内置记账优先 → 再 AI 修复） ----------
A('F1 **内置段先跑**：到期/超前条目先由触发器记账 + 轮动到下一轮（不再等 AI），AI 段只处理剩余条目', async () => {
    boot({
        deals: [
            // 到期条目：nextDate 早已过去 → 内置段应兑现并轮动
            { id: 'due', name: '船厂分成', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', desc: '', status: '', outlook: { text: '', nodes: [], forecast: { nextDate: '1919-02-01', delta: 10, direction: 'increase', note: '', source: 'ai' } } },
            // 未到期 + 缺内容：交给 AI 段
            { id: 'soon', name: '地租', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', desc: '', status: '', outlook: { text: '', nodes: [], forecast: { nextDate: '1920-09-01', delta: 5, direction: 'increase', note: '', source: 'ai' } } },
        ],
    });
    const r = await runDealRepair({ aiText: JSON.stringify({ items: [{ id: 'soon', status: '稳定' }] }), skipAi: false });
    return r.ok === true && r.trigger && r.trigger.fired >= 1 && state.ledger.length === r.trigger.fired
        && state.deals[0].outlook.forecast.nextDate > '1920-06-01'   // 已轮动到下一轮
        && String(r.note).indexOf('内置记账') >= 0 && String(r.note).indexOf('AI 本批') >= 0;
}, 'n/a');
A('F2 `skipAi` 只跑内置段：如实回报「没有到期的条目 / 已记账 N 笔」', async () => {
    boot({ deals: [{ id: 'due2', name: 'A', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', outlook: { text: '', nodes: [], forecast: { nextDate: '1919-02-01', delta: 7, direction: 'increase', note: '', source: 'ai' } } }] });
    const r = await runDealRepair({ skipAi: true });
    return r.ok === true && r.trigger.fired >= 1 && r.changed === 0 && String(r.note).indexOf('AI 段已跳过') >= 0;
}, 'n/a');
A('F3 面板：点「🔧 修复」**先有中间提示**（处理中），结束后**有结果提示**（不再静默）', async () => {
    boot({ deals: [{ id: 'd1', name: 'A', startDate: '1919-01-01', currencyId: 'c1', cycle: 'monthly', desc: '', status: '', outlook: { text: '', nodes: [], forecast: { nextDate: '1920-09-01', delta: 5, direction: 'increase', note: '', source: 'ai' } } }] });
    const { setPanelHooks2, panelAction, panelState } = await import('../../ui/panel.js');
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [], lastExtract: () => null });
    const { setAiHooks } = await import('../../core/ai-hooks.js');
    setAiHooks({ callAi: async () => ({ ok: true, text: JSON.stringify({ items: [{ id: 'd1', status: '稳定' }] }) }), feedText: () => '正文', busy: () => false });
    let mid = '';
    const r = await panelAction('dealRepair', {});
    mid = String((panelState() || {}).note || '');
    return r && r.ok === true && mid.indexOf('长期收支修复') >= 0 && mid.indexOf('处理中') < 0
        && (mid.indexOf('内置记账') >= 0 || mid.indexOf('AI') >= 0) && state.deals[0].status === '稳定';
}, 'n/a');

R.done();
