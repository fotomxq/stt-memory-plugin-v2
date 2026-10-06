// ============================================================
// 单元测试 · v3.26.1「undefined 脏数据」根因修复 + 文本卫生（用户报告）
//
// 用户要求（原话）：「有传言中出现了undefined字样，其他原子数据可能也有，请核对原因并进行修复。
//   同时建议如果AI回复不可控，可以用默认值来顶上去，避免出现异常数据。」
//
// 真机取证（只读扫描真实状态文件）：命中的只有传言两条 —— 正文里的 `（说法演变为：undefined）`
//   与传导链路的 `说法完成演化（undefined）`（并随快照链复制）。
// 根因（确定性）：`core/rumor-evolve.js#rumorRoll` 把 `hashText()`（djb2 → **base36**）按 **16 进制**解析 ——
//   · 哈希串含 `g`~`z` 时 `parseInt(...,16)` = `NaN`（实测 `rum_m1|variant|…` → 0.00005，
//     `rum_v2|variant|…` / 真实那条 `rum_13oko38|variant|…` → NaN）；
//   · `NaN` 让概率判定全线失效（`NaN < chance` 恒假 → 永不裂变/变异；`NaN >= chance` 恒假 → 联动永远走「推动」）；
//   · `rumorVariantFor` 取 `RUMOR_VARIANTS[NaN]` = `undefined` → 模板把 `undefined` 拼进正文与链路 → 落盘。
// 修法（三件套）：
//   ① 掷骰按 base36 解析 + 32 位终混，恒返回 [0,1) 有限数（`rumorRoll`）；
//   ② 变体名永不返回空值（`rumorPendingVariant` / `rumorVariantFor`，异常即回落默认变体）；
//   ③ **文本卫生**：`normText` 统一清理坏占位 token（`core/util.js#scrubBadToken`）→ AI 脏值 / 机械演化 /
//      手工粘贴都不可能再落库；载入期 `core/migrate.js#healthSelfHeal` 自愈**存量**脏数据（计数 `texts`）；
//      `core/data-health.js` 新增只读发现 `text-bad-token` 供体检。
// 运行：node tests/unit/text-hygiene.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setNotifyHooks, setTimerHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg, DIMENSIONS } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    normText, hasBadToken, scrubBadToken, walkStrings,
} from '../../core/util.js';
import { rumorRoll, rumorVariantFor, rumorCommitPending, rumorApplyAiDelta, rumorStartPending } from '../../core/rumor-evolve.js';
import { RUMOR_VARIANTS } from '../../core/model/rumor.js';
import { migrateState, healthSelfHeal, lastHealInfo } from '../../core/migrate.js';
import { dataHealthReport } from '../../core/data-health.js';

const R = makeReporter('text-hygiene v3.26.1 undefined 脏数据修复（传言掷骰 + 文本卫生 + 载入自愈）');
const A = async (n, fn, e) => { let c = false, x = e; try { c = await fn(); } catch (err) { c = false; x = String((err && err.message) || err); } R.assert(n, c === true, x); };
const J = (v) => JSON.stringify(v);

/** 最小装配：内核 state/cfg + 静默钩子（不碰宿主） */
function boot(patch) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    Object.assign(cfg, patch || {});
    setScopeKey('char:hygiene');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setNotifyHooks({ toast: () => undefined, notify: () => undefined });
    setTimerHooks({ set: () => 1, clear: () => true });
    setLastMessageId(0);
    return state;
}

// ============================================================
// A 组：文本卫生（坏占位 token 的清理口径）
// ============================================================
await A('A1 `scrubBadToken`：以「值」的形态出现的 undefined / NaN / [object Object] 被清掉（整字段 / 冒号后 / 括号内 / 分隔符旁）', async () => {
    const cases = [
        ['undefined', ''],
        ['标题：undefined', '标题'],
        ['发酵度 NaN', '发酵度'],
        ['说法完成演化（undefined）', '说法完成演化'],
        ['胡商称见黑袍人（说法演变为：undefined）', '胡商称见黑袍人'],
        ['a（说法演变为：undefined）b', 'ab'],
        ['甲、undefined、乙', '甲、乙'],
        ['值是 [object Object] 与 NaN', '值是 与'],
        ['三只木箱（undefined）（再见）', '三只木箱（再见）'],
    ];
    const bad = cases.filter(([inp, want]) => scrubBadToken(inp) !== want);
    return bad.length === 0;
}, () => ({ got: ['undefined', '标题：undefined', '说法完成演化（undefined）', '甲、undefined、乙', '值是 [object Object] 与 NaN'].map((x) => [x, scrubBadToken(x)]) }));

await A('A2 `scrubBadToken` **不误伤正常正文**、幂等、且对无 token 的文本零改动', async () => {
    const keep = [
        '这里正常提到 the undefined behaviour 一次',
        '前缀undefined后缀',
        '正常文本（数值较大）',
        '两段之间\n第二段',
        '三只木箱（甲、乙）',
        '',
    ];
    const bad = keep.filter((s) => scrubBadToken(s) !== s);
    const samples = ['胡商称见黑袍人（说法演变为：undefined）', '甲、undefined、乙', '值是 [object Object] 与 NaN'];
    const idem = samples.every((s) => scrubBadToken(scrubBadToken(s)) === scrubBadToken(s));
    return bad.length === 0 && idem === true;
}, () => ({ keep: ['这里正常提到 the undefined behaviour 一次', '前缀undefined后缀'].map((s) => [s, scrubBadToken(s)]) }));

await A('A3 `normText` 是**唯一写入口径**：任何字段经它归一后都不再含坏占位 token（同值稳定性不变）', async () => {
    const r = normText('  胡商称见黑袍人（说法演变为：undefined）  ', 240);
    const r2 = normText('正常正文', 240);
    const r3 = normText('正常正文', 240);
    return r === '胡商称见黑袍人' && r.indexOf('undefined') < 0
        && r2 === r3 && hasBadToken(r) === false && hasBadToken('undefined') === true;
}, () => ({ normText: normText('胡商称见黑袍人（说法演变为：undefined）', 240) }));

await A('A4 `walkStrings` 深度遍历（含数组 / 嵌套对象）遵守深度与字符串条数上限，且只在回调返回值时替换', async () => {
    const obj = { a: 'undefined', b: { c: 'NaN', d: ['x（undefined）', { e: 'deep-undefined-keep' }] } };
    const seen = [];
    const r = walkStrings(obj, (v, p) => { seen.push(p); return undefined; }, { maxDepth: 4, maxStrings: 100 });
    const readonly = J(obj) === J({ a: 'undefined', b: { c: 'NaN', d: ['x（undefined）', { e: 'deep-undefined-keep' }] } });
    const r2 = walkStrings(obj, (v) => (hasBadToken(v) ? scrubBadToken(v) : undefined), { maxDepth: 4, maxStrings: 100 });
    const capped = walkStrings({ a: 'x', b: 'y', c: 'z' }, () => undefined, { maxDepth: 4, maxStrings: 2 });
    return readonly === true && r.visited === 4 && seen.indexOf('b.d[0]') >= 0 && seen.indexOf('b.d[1].e') >= 0
        && r2.changed === 3 && obj.a === '' && obj.b.c === '' && obj.b.d[0] === 'x'
        && obj.b.d[1].e === 'deep-undefined-keep'
        && capped.truncated === true && capped.visited === 2;
}, () => ({ visited: walkStrings({ a: 'undefined', b: { c: 'NaN', d: ['x（undefined）', { e: 'deep-undefined-keep' }] } }, () => undefined, { maxDepth: 4, maxStrings: 100 }) }));

// ============================================================
// B 组：根因（传言掷骰）—— 用户报告的 undefined 就是这里来的
// ============================================================
await A('B1 `rumorRoll` 恒返回 [0,1) 有限数（V1 在 base36 含 g~z 时得到 NaN），同 seed 可复现、分布不偏斜', async () => {
    const vals = [];
    for (let i = 0; i < 500; i++) vals.push(rumorRoll('seed-' + i));
    const illegal = vals.filter((v) => !Number.isFinite(v) || v < 0 || v >= 1);
    // 旧实现的真实病例：这三个 seed 曾是 NaN
    const wasNaN = ['rum_v2|variant|2020-06-01|1', 'rum_13oko38|variant|2020-05-01|1', 'rum_m1|variant|2020-01-01|1'].map((s) => rumorRoll(s));
    const buckets = new Array(10).fill(0);
    for (const v of vals) buckets[Math.min(9, Math.floor(v * 10))]++;
    const spread = buckets.every((n) => n > 20);
    return illegal.length === 0 && wasNaN.every((v) => Number.isFinite(v))
        && rumorRoll('same') === rumorRoll('same') && spread === true;
}, () => ({ buckets: (() => { const b = new Array(10).fill(0); for (let i = 0; i < 500; i++) b[Math.min(9, Math.floor(rumorRoll('seed-' + i) * 10))]++; return b; })() }));

await A('B2 `rumorVariantFor` **永不返回 undefined / 空值**：任意 id / 日期 / 下标都落在变体表内（用户 BUG 的直接判据）', async () => {
    const ids = ['rum_v1', 'rum_v2', 'rum_v3', 'rum_13oko38', 'rum_m1', ''];
    const dates = ['2020-06-01', '2020-05-01', '', null];
    const bad = [];
    for (const id of ids) for (const date of dates) for (let i = 0; i <= 40; i++) {
        const v = rumorVariantFor({ id, date }, i);
        if (typeof v !== 'string' || !v || RUMOR_VARIANTS.indexOf(v) < 0) bad.push([id, date, i, v]);
    }
    return bad.length === 0 && RUMOR_VARIANTS.length === 5;
}, () => ({ sample: ['rum_v2', 'rum_13oko38'].map((id) => [1, 2, 3].map((i) => rumorVariantFor({ id, date: '2020-05-01' }, i))) }));

await A('B3 提交「变异」：`pending.target` 为空 / 是历史脏 token 时，正文与链路都**不出现 undefined**（回归判据）', async () => {
    boot({ dimCharLimits: Object.assign({}, defaultCfg.dimCharLimits, { rumors: 240 }) });
    const mk = (target) => ({ id: 'rum_fix', subject: '码头失窃', content: '码头的货被偷了。', date: '2020-05-01', ferment: 70, chain: [], pending: { kind: '变异', need: 2, progress: 2, target: target, at: '2020-05-01' } });
    const r1 = rumorCommitPending(mk(''), 5);
    const r2 = rumorCommitPending(mk('undefined'), 5);
    const txt = [r1 && r1.variant, r2 && r2.variant, state.rumors].map((x) => J(x == null ? null : x)).join('|');
    return r1 && r1.variant && r1.variant.length > 0
        && r2 && r2.variant && r2.variant.length > 0
        && txt.indexOf('undefined') < 0;
}, () => ({ r1: null }));

await A('B4 「变化过程」开始 + 推进 + 提交全链路（真实三连）后，传言正文与链路里没有 `undefined`，且正文仍带「说法演变为」标记', async () => {
    boot({ dimCharLimits: Object.assign({}, defaultCfg.dimCharLimits, { rumors: 240 }), rumorChangeNeedRounds: 2 });
    const r = { id: 'rum_chain', subject: '码头失窃', content: '码头的货被偷了。', date: '2020-05-01', ferment: 70, chain: [], objectivity: '主观' };
    state.rumors = [r];
    const started = rumorStartPending(r, '变异', '', 1);       // 目标为空 → 由掷骰补默认变体
    const committed = rumorCommitPending(r, 5);
    const all = J({ r: state.rumors, started: started, committed: committed });
    return started === true && committed && typeof committed.variant === 'string' && committed.variant.length > 0
        && all.indexOf('undefined') < 0 && String(r.content).indexOf('（说法演变为：') > 0
        && (r.chain || []).some((x) => String(x.note).indexOf('说法完成演化（') === 0);
}, () => ({ chain: null }));

// ============================================================
// C 组：AI 不可控 → 默认值顶上去 + 存量自愈 + 只读体检
// ============================================================
await A('C1 AI 增量补写：字段里混入坏 token / 缺必填字段时的口径 —— 脏 token 被清、条目不因脏值变形', async () => {
    boot({ dimCharLimits: Object.assign({}, defaultCfg.dimCharLimits, { rumors: 240 }) });
    const r1 = rumorApplyAiDelta({ subject: '码头失窃', content: '码头的货（说法演变为：undefined）被偷了。', tags: ['码头'] }, {});
    const r2 = rumorApplyAiDelta({ subject: 'undefined', content: 'undefined' }, {});        // 必填字段全是脏 token → 归一后为空 → 不入库
    const dump = J(state.rumors);
    return r1 && r1.added === true && dump.indexOf('undefined') < 0
        && String((state.rumors[0] || {}).content).indexOf('被偷了') > 0
        && (r2 === null || r2.added !== true) && state.rumors.length === 1;
}, () => ({ rumors: null }));

await A('C2 载入期自愈 `healthSelfHeal`：存量脏数据（正文 + 链路 + 深度嵌套）被清掉并计入 `texts`，**不误伤正常正文**', async () => {
    boot();
    const st = emptyState();
    st.rumors = [{
        id: 'rum_dirty', subject: '码头失窃',
        content: '胡商称见黑袍人（说法演变为：undefined）',
        chain: [{ at: '2020-05-01', kind: '异变', note: '说法完成演化（undefined）' }],
        carriers: [{ who: 'undefined', role: '传播者' }],
    }];
    st.atoms = [{ id: 'a-clean', text: '正常正文 the undefined behaviour 一次', title: '正常' }];
    const changed = healthSelfHeal(st);
    const info = lastHealInfo();
    return changed === true && Number(info.texts) === 1
        && st.rumors[0].content === '胡商称见黑袍人' && st.rumors[0].chain[0].note === '说法完成演化'
        && st.rumors[0].carriers[0].who === '' && st.atoms[0].text === '正常正文 the undefined behaviour 一次'
        && healthSelfHeal(st) === false;                          // 幂等：再跑一次无改动
}, () => ({ heal: lastHealInfo() }));

await A('C3 `migrateState` 走完整迁移链后同样清掉坏 token（载入即自愈，用户无需手工清理）', async () => {
    boot();
    const st = emptyState();
    st.rumors = [{ id: 'rum_m', subject: '甲', content: '甲说（说法演变为：undefined）', chain: [{ note: 'undefined', kind: '异变' }] }];
    const out = migrateState(st);
    const dump = J(out);
    return dump.indexOf('undefined') < 0 && String(out.rumors[0].content) === '甲说';
}, () => ({ }));

await A('C4 数据体检新增只读发现 `text-bad-token`（残留时如实列出，维度 / id / 字段可定位）', async () => {
    boot();
    const rep = dataHealthReport({
        rumors: [{ id: 'rum_bad', subject: '甲', content: '甲说（说法演变为：undefined）' }],
        atoms: [{ id: 'a-ok', text: '正常正文' }],
    }, {});
    const hit = (rep.findings || []).filter((f) => f.code === 'text-bad-token');
    const clean = dataHealthReport({ atoms: [{ id: 'a-ok', text: '正常正文' }] }, {});
    return Number(rep.counts['text-bad-token']) === 1 && rep.level === 'warn'
        && hit.length === 1 && hit[0].dim === 'rumors' && hit[0].id === 'rum_bad'
        && Number(clean.counts['text-bad-token'] || 0) === 0;
}, () => ({ }));

await A('C5 维度覆盖面：所有分析维度（含情节 / 状态 / 角色 / 记忆 / 物品 / 计划 / 场景 / 概念 / 平行 / 货币）的文本字段都受同一口径保护', async () => {
    boot();
    const st = emptyState();
    const dirty = '值（占位：undefined）';
    for (const d of DIMENSIONS) {
        const kind = d.kind;
        if (!kind || kind === 'links' || kind === 'plotSegments') continue;
        st[kind] = [{ id: 'x-' + kind, subject: '主体', name: '名称', title: '标题', text: dirty, content: dirty, desc: dirty, note: dirty }];
    }
    healthSelfHeal(st);
    const dump = J(st);
    return dump.indexOf('undefined') < 0;
}, () => ({ dims: DIMENSIONS.length }));

R.done();
