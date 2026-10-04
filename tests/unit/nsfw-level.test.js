// ============================================================
// 单元测试 · v3.8.0「NSFW 等级留档（无 / 弱 / 强 · 永久性留档）」
// 用户要求（原文）：「原子数据新增字段，用于标记该信息是否包含了 NSFW 内容，同时 NSFW 分等级，分别包括无、弱、强 3 个级别。
//   其中无代表与 NSFW 完全无关、弱代表有部分但没有露骨内容、强代表完全是露骨内容。
//   当弱化 NSFW 功能修复后，**NSFW 标签不会改变，用于永久性留档**。」
//
// 覆盖：
//   A 组：判级三级（无/弱/强；中英文；AI 显式标注优先；「无」不写字段）；
//   B 组：**永久留档 = 只升不降**（弱化 / AI 改写 / 重归一化 / 去重 / 跨端合并都不降级）；
//   C 组：跨端合并与同内容去重取高；
//   D 组：**修 V1 移植缺陷** —— 状态记录（`currentStates`）此前整维被 NSFW 扫描/替换悄悄跳过（有意偏离 V1）；
//   E 组：存量补档（载入路径调用）与等级分布统计；
//   F 组：界面徽标与元字段补齐（`core/entry-meta.js`）。
// 运行：node tests/unit/nsfw-level.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { mergeDelta } from '../../core/ingest.js';
import { normalizeAtom } from '../../core/model/atom.js';
import { normalizeMemory, normalizeCurrentState } from '../../core/model/dims.js';
import { contentDedupeArray } from '../../core/migrate.js';
import { mergeDataObjects } from '../../core/cross-sync.js';
import { preserveEntryMeta } from '../../core/entry-meta.js';
import { nsfwBadgeHtml } from '../../ui/list-rows.js';
import {
    NSFW_LEVELS, NSFW_LEVEL_LABELS, NSFW_WEAK_SIGNALS, nsfwLevelNorm, nsfwLevelMax, nsfwLevelLabel,
    nsfwLevelOf, nsfwLevelFromEntry, nsfwWeakHit, nsfwStampLevel, nsfwMergeLevel,
    nsfwClassifyItem, nsfwStampItem, nsfwStampEntry, nsfwLabelStats, nsfwBackfill,
    nsfwScan, nsfwFixedReplace, nsfwKeywordList,
} from '../../core/nsfw.js';

const R = makeReporter('nsfw-level v3.8.0 NSFW 等级留档（无 / 弱 / 强）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };

function boot(st) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.stateDecayEnabled = false; cfg.memoryForgetEnabled = false; cfg.parallelDecayEnabled = false; cfg.clockAutoPatrol = false;
    setScopeKey('char:nsfwlevel');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    installGlobalHost(makeHost({ chat: [{ is_user: false, mes: '第 0 楼正文。' }] }), doc);
    setLastMessageId(0);
    setKernelState(Object.assign(emptyState(), st || {}));
    return state;
}
const plain = '甲在仓库清点编号 3 的铜箱，登记账册后交给乙。';
const strong = '两人做爱后相拥，她发出呻吟。';
const weak = '夜里两人拥抱很久，最后轻轻亲吻。';

// ---------- A 组：三级判级 ----------
A('A0 等级口径：三级取值 + 中文标签（无 / 弱 / 强）齐备', (() => {
    return J(NSFW_LEVELS) === J(['none', 'weak', 'strong'])
        && NSFW_LEVEL_LABELS.none === '无' && NSFW_LEVEL_LABELS.weak === '弱' && NSFW_LEVEL_LABELS.strong === '强'
        && nsfwLevelLabel('strong') === '强' && nsfwLevelLabel('') === '无' && nsfwLevelLabel('随便') === '无'
        && nsfwLevelNorm('强') === 'strong' && nsfwLevelNorm('弱') === 'weak' && nsfwLevelNorm('无') === 'none'
        && nsfwLevelNorm(2) === 'strong' && nsfwLevelNorm(1) === 'weak' && nsfwLevelNorm(0) === 'none';
})(), '见断言');

await A('A1 强级：命中识别词条（中文原样 / 英文词首通配）→ `strong`', (() => {
    return nsfwClassifyItem('atoms', { id: 'a1', text: strong }) === 'strong'
        && nsfwClassifyItem('atoms', { id: 'a2', text: 'An explicit scene with heavy petting and orgasm.' }) === 'strong';
})(), '见断言');

await A('A2 弱级：只有亲密 / 暗示信号（无露骨直述）→ `weak`（内置信号词 ' + NSFW_WEAK_SIGNALS.length + ' 条）', (() => {
    return nsfwClassifyItem('atoms', { id: 'a3', text: weak }) === 'weak'
        && nsfwWeakHit('两人相拥而眠') === true
        && nsfwWeakHit('They kiss under the moon.') === true
        && nsfwWeakHit('A huge ship.') === false          // 英文整词匹配：hug 不得命中 huge
        && nsfwWeakHit(plain) === false;
})(), '见断言');

await A('A3 无级：与 NSFW 完全无关 → `none`，且**不写字段**（缺省即无，不给数据加噪声）', (() => {
    const it = { id: 'a4', title: '码头清点', text: plain };
    const before = Object.keys(it).length;
    const r = nsfwStampItem('atoms', it);
    return nsfwClassifyItem('atoms', it) === 'none' && r.changed === false && r.to === 'none'
        && Object.keys(it).length === before && it.nsfw === undefined && nsfwLevelOf(it) === 'none';
})(), '见断言');

await A('A4 AI 显式标注优先：`NSFW` / `露骨程度` 等键（中英文）→ 直接按标注留档（正文平淡也认）', (() => {
    return nsfwLevelFromEntry({ NSFW: '强' }) === 'strong'
        && nsfwLevelFromEntry({ 露骨程度: '弱' }) === 'weak'
        && nsfwLevelFromEntry({ nsfw: 'none' }) === 'none'
        && nsfwLevelFromEntry({}) === 'none'
        && nsfwStampEntry('atoms', { id: 'a5', NSFW: '强' }, { id: 'a5', text: plain }).to === 'strong'
        && nsfwStampEntry('atoms', { id: 'a6', 露骨程度: '弱' }, { id: 'a6', text: plain }).to === 'weak';
})(), '见断言');

await A('A5 判级按维度字段白名单：情节 title+text、记忆 title+content、状态记录 subject+value', (() => {
    return nsfwClassifyItem('memories', { id: 'm1', title: '夜里', content: weak }) === 'weak'
        && nsfwClassifyItem('memories', { id: 'm2', title: strong, content: plain }) === 'strong'
        && nsfwClassifyItem('states', { id: 's1', subject: '角色甲', value: '赤裸上身' }) === 'strong'
        && nsfwClassifyItem('states', { id: 's2', subject: '角色甲', value: '情绪戒备' }) === 'none'
        && nsfwClassifyItem('currencies', { id: 'c1', note: strong }) === 'none';   // 货币维度不在弱化白名单内
})(), '见断言');

// ---------- B 组：只升不降（永久留档） ----------
await A('B1 留档只升不降：先记「强」，正文被弱化后再判级仍是「强」（`nsfwStampItem` 取高）', (() => {
    boot();
    const it = { id: 'b1', title: '夜里', text: strong };
    const r1 = nsfwStampItem('atoms', it);
    it.text = weak;                                  // 弱化后的正文
    const r2 = nsfwStampItem('atoms', it);
    return r1.to === 'strong' && r2.changed === false && it.nsfw === 'strong'
        && nsfwClassifyItem('atoms', it) === 'weak'   // 正文确实已弱化
        && nsfwLevelMax('strong', 'weak') === 'strong' && nsfwLevelMax('none', 'weak') === 'weak';
})(), '见断言');

await A('B2 AI 用弱化后的正文更新既有情节（`mergeDelta`）→ 标签仍是「强」（从旧条目继承 + 只升不降）', (() => {
    boot({ atoms: [{ id: 'b2', title: '夜里', text: strong, floorStart: 1, floorEnd: 1, tags: [] }] });
    state.atoms[0].nsfw = 'strong';
    mergeDelta({ atoms: { update: [{ id: 'b2', title: '夜里', text: weak + '（正文已被弱化改写，长度足够通过最小长度校验。）', date: '1919-11-02', tags: [] }] } }, { startFloor: 1, endFloor: 1 });
    const a = state.atoms[0];
    return /已被弱化改写/.test(a.text) && a.nsfw === 'strong';
})(), () => ({ atom: state.atoms[0] }));

await A('B3 重归一化不冲掉留档：`normalizeAtom` / `normalizeMemory` 原样保留 `nsfw`', (() => {
    const a = normalizeAtom({ id: 'b3', text: strong, floorStart: 1, floorEnd: 1, nsfw: 'strong' }, null);
    const m = normalizeMemory({ id: 'b3m', title: '夜里', content: weak, nsfw: 'weak' });
    const s = normalizeCurrentState({ id: 'b3s', subject: '甲', field: '状态', value: plain, nsfw: '强' });
    return a.nsfw === 'strong' && m.nsfw === 'weak' && s.nsfw === 'strong'
        && normalizeAtom({ id: 'b3b', text: strong, floorStart: 1, floorEnd: 1 }, null).nsfw === undefined;
})(), '见断言');

await A('B4 固定规则替换（零 AI）只改文本、**不动标签**：替换后 `nsfw` 仍是「强」', (() => {
    boot({ atoms: [{ id: 'b4', title: '夜里', text: strong, floorStart: 1, floorEnd: 1, tags: [], nsfw: 'strong' }] });
    const fx = nsfwFixedReplace({ silent: true });
    const a = state.atoms[0];
    return fx.replaced >= 2 && a.text.indexOf('做爱') < 0 && a.text.indexOf('呻吟') < 0
        && a.nsfw === 'strong' && a.text !== strong;
})(), () => ({ text: (state.atoms[0] || {}).text, nsfw: (state.atoms[0] || {}).nsfw }));

await A('B5 AI 弱化同样不动标签（`applyNsfwSoftenResult` 写文本路径）；提示词会带上「留档等级」供 AI 参考', (() => {
    boot({ memories: [{ id: 'b5', title: '夜里', content: strong, date: '1919-11-01', nsfw: 'strong' }] });
    const scan = nsfwScan({ dims: ['memories'] });
    const it = state.memories[0];
    it.content = weak;                              // 模拟 AI 已弱化写入
    nsfwStampItem('memories', it);
    return scan.total >= 1 && scan.items[0].level === 'strong' && it.nsfw === 'strong';
})(), '见断言');

// ---------- C 组：合并取高 ----------
await A('C1 同内容去重（`contentDedupeArray`）：一份「强」+ 一份「无」→ 合并后仍是「强」', (() => {
    const out = contentDedupeArray('atoms', [
        { id: 'c1', title: '夜里', text: strong, date: '1919-11-01', updatedAt: 100, nsfw: 'strong' },
        { id: 'c2', title: '夜里', text: strong, date: '1919-11-01', updatedAt: 200 },
    ]);
    return out.length === 1 && out[0].nsfw === 'strong';
})(), () => ({ out: contentDedupeArray('atoms', []) }));

await A('C2 跨端合并（`mergeDataObjects`）：对端才是「强」→ 胜出条目继承「强」（留档不因弱化/覆盖而丢）', (() => {
    const base = { updatedAt: 100, atoms: [{ id: 'c9', title: '夜里', text: weak, floorStart: 1, floorEnd: 1, updatedAt: 300 }] };
    const remote = { updatedAt: 200, atoms: [{ id: 'c9', title: '夜里', text: strong, floorStart: 1, floorEnd: 1, updatedAt: 50, nsfw: 'strong' }] };
    const r = mergeDataObjects(base, remote);
    const a = (r.data.atoms || []).find((x) => x.id === 'c9') || {};
    return a.nsfw === 'strong' && /拥抱/.test(String(a.text));    // 本地（较新、已弱化）胜出，但留档取对端的「强」
})(), () => ({ data: mergeDataObjects({ updatedAt: 1, atoms: [] }, { updatedAt: 2, atoms: [] }).stat }));

// ---------- D 组：修 V1 移植缺陷（状态记录整维被跳过） ----------
await A('D1 状态记录（`currentStates`）**现在参与** NSFW 扫描与固定规则替换（V1 因 `state.states` 恒空而整维跳过 —— 有意偏离 V1）', (() => {
    boot({ currentStates: [{ id: 'st1', subject: '角色甲', field: '状态', value: '赤裸上身', uses: 0, floorStart: 1, floorEnd: 1 }] });
    const scan1 = nsfwScan({ dims: ['states'] });
    const fx = nsfwFixedReplace({ silent: true });
    const v = state.currentStates[0].value;
    return scan1.total >= 1 && scan1.byDim.states >= 1 && fx.replaced >= 1
        && v.indexOf('赤裸') < 0 && v !== '赤裸上身';      // '赤裸' → 内置转化词「未着衣」
})(), () => ({ scan: nsfwScan({ dims: ['states'] }).byDim, value: (state.currentStates[0] || {}).value }));

// ---------- E 组：补档与统计 ----------
await A('E1 存量补档 `nsfwBackfill`：老数据按原文打标（强 / 弱），**幂等**（再次运行零改动），且不降级', (() => {
    boot({
        atoms: [{ id: 'e1', title: '夜里', text: strong, floorStart: 1, floorEnd: 1, tags: [], nsfw: 'strong' }],
        memories: [{ id: 'e2', title: '夜里', content: weak, date: '1919-11-01' }],
        concepts: [{ id: 'e3', name: '粮运', content: plain }],
    });
    const r1 = nsfwBackfill();
    const r2 = nsfwBackfill();
    const stats = nsfwLabelStats();
    return r1.scanned === 3 && r1.stamped === 1 && r1.weak === 1 && r1.strong === 0
        && r2.stamped === 0                                  // 幂等（已打标的不再改动）
        && state.memories[0].nsfw === 'weak' && state.concepts[0].nsfw === undefined
        && stats.strong === 1 && stats.weak === 1 && stats.total === 3
        && cfg.nsfwKeywords.length === 0;                    // 未自定义 → 用内置库
})(), () => ({ r: nsfwBackfill(), stats: nsfwLabelStats() }));

await A('E2 「强」不会被补档降级：把已弱化的正文重新补档 → 仍是「强」（留档永久）', (() => {
    boot({ atoms: [{ id: 'e4', title: '夜里', text: weak, floorStart: 1, floorEnd: 1, tags: [], nsfw: 'strong' }] });
    const r = nsfwBackfill();
    return r.stamped === 0 && state.atoms[0].nsfw === 'strong' && nsfwKeywordList().length === 63;
})(), '见断言');

// ---------- F 组：界面与元字段补齐 ----------
await A('F1 列表行徽标：强 → 「🔞强」、弱 → 「🔞弱」、无 → 不显示（标题写明「按原文判定，弱化不会改变」）', (() => {
    const s = nsfwBadgeHtml({ nsfw: 'strong' }), w = nsfwBadgeHtml({ nsfw: 'weak' });
    return s.indexOf('🔞强') > 0 && s.indexOf('弱化内容不会改变') > 0
        && w.indexOf('🔞弱') > 0 && nsfwBadgeHtml({}) === '' && nsfwBadgeHtml(null) === '';
})(), '见断言');

await A('F2 `preserveEntryMeta`（归一化统一补齐）：按原文打标 + 继承同 id 既有留档（只升不降）；楼层溯源同批保留', (() => {
    const norm = preserveEntryMeta('memories', { id: 'f2', title: '夜里', content: weak, floorNowStart: 2, floorNowEnd: 3 }, { id: 'f2', title: '夜里', content: weak });
    return norm.nsfw === 'weak' && norm.floorNowStart === 2 && norm.floorNowEnd === 3;
})(), '见断言');

const f3ok = await (async () => {
    const EN = await import('../../core/entries.js');
    boot({ memories: [{ id: 'f3', title: '夜里', content: weak, date: '1919-11-01' }] });
    EN.upsertEntry('memories', { id: 'f3', title: '夜里', content: weak, date: '1919-11-01' });
    const first = (state.memories.find((x) => x.id === 'f3') || {}).nsfw;
    EN.upsertEntry('memories', { id: 'f3', title: '夜里', content: strong + '（改写的正文，长度足够。）', date: '1919-11-02' });
    const second = (state.memories.find((x) => x.id === 'f3') || {}).nsfw;
    return first === 'weak' && second === 'strong';
})();
A('F3 手动新增/编辑（upsertEntry）同样打标：新增含亲密信号的记忆 → 弱；改写成露骨正文 → 升为强', f3ok, () => ({ memories: state.memories.map((x) => ({ id: x.id, nsfw: x.nsfw })) }));

R.done();
