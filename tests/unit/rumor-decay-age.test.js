// ============================================================
// 单元测试 · v2.70.0「传言衰退系数增加时间判断（发生越久远衰退越快）」
//
// 用户要求：「传言的衰退系数增加时间判断，如果发生时间越久远，衰退速度越快。」
//
// 原口径（V1 v1.192 原样）：`rumorDecayScore` 只按**现实墙钟**的 `updatedAt` 走 `calcTimeDecay`
//   （多级时间尺度 + 类目相对位置 + 拥挤度）；而 `updatedAt` 会在机械演化 / 平行联动 / 裂变 / AI 更新时被
//   `Date.now()` 刷新 —— **越老的传言只要还在被提及就永远不消退**。
//
// 本批（`core/rumor-evolve.js`）：在原有系数之上叠加**剧情时间久远度**：
//   · 发生时间 = 该说法的 `date` 与各载体 `at` 中**最早**的有效剧情日期；
//   · `speed = min(1, (剧情当下 - 发生时间) / 365 天)`（无剧情时钟 / 无发生日期 / 发生在未来 → 0，完全保持原行为）；
//   · `score = min(1, base × (1 + speed) + 0.5 × speed)` —— 乘法加速（最多 ×2）+ 加法下限（满额 +0.5），
//     于是**久远传言即便墙钟上刚被刷新过也会被推向移除阈值**，新传言分数不变；
//   · `rumorDecayBreakdown(r)` 暴露 `{base, speed, boost, add, score, date, ageDays}`，衰退日志逐条给出。
//
// 运行：node tests/unit/rumor-decay-age.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rumorAgeSpeed, rumorDecayBreakdown, rumorDecayScore, rumorExpired, runRumorDecay, RUMOR_AGE_HORIZON_DAYS } from '../../core/rumor-evolve.js';

const R = makeReporter('rumor-decay-age v2.70.0 传言衰退的时间判断');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const DAY = 86400000;
const HERE = dirname(fileURLToPath(import.meta.url));

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);

/** 造一条传言（`updatedAt` 固定 1 天前，衬托「墙钟相同、只有发生时间不同」） */
let rumorSeq = 0;
function rumor(date, extra) {
    rumorSeq += 1;
    return Object.assign({
        id: 'rum_t' + rumorSeq, subject: '主体' + rumorSeq, content: '说法' + rumorSeq,
        date: date, media: [], updatedAt: Date.now() - DAY,
    }, extra || {});
}
function boot(storyDate, rumors) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setScopeKey('甲');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    const st = emptyState();
    st.state = Object.assign({}, st.state, { date: String(storyDate || '') });
    st.rumors = Array.isArray(rumors) ? rumors : [];
    setKernelState(st);
    return st;
}

A('A1 剧情时间久远度：4 天 → ≈0.011；1 年 → 1（拉满）；无发生日期 / 无剧情时钟 → 0', (() => {
    boot('1919-11-29', []);
    const fresh = rumorAgeSpeed(rumor('1919-11-25'));
    const oneYear = rumorAgeSpeed(rumor('1918-11-29'));
    const noDate = rumorAgeSpeed(rumor(''));
    const future = rumorAgeSpeed(rumor('1920-01-01'));
    boot('', []);
    const noClock = rumorAgeSpeed(rumor('1900-01-01'));
    return Math.abs(fresh - 4 / RUMOR_AGE_HORIZON_DAYS) < 0.01 && oneYear === 1
        && noDate === 0 && future === 0 && noClock === 0;
})(), J({ fresh: rumorAgeSpeed(rumor('1919-11-25')), oneYear: rumorAgeSpeed(rumor('1918-11-29')) }));

A('A2 发生时间取「说法日期与载体日期中最早者」（载体更早 → 更久远）', (() => {
    boot('1919-11-29', []);
    const own = rumor('1919-11-28', { media: [{ type: '报刊', name: '甲报', at: '1919-11-27' }] });
    const viaMedia = rumor('1919-11-28', { media: [{ type: '刻字', name: '石碑', at: '1900-01-01' }] });
    return rumorAgeSpeed(own) < 0.1 && rumorAgeSpeed(viaMedia) === 1;
})(), J({ own: rumorAgeSpeed(rumor('1919-11-28', { media: [{ at: '1919-11-27' }] })).toFixed(3) }));

A('A3 拆解可核对：base（V1 口径）/ speed / boost / add / score 齐备且 score = min(1, base×(1+speed)+0.5×speed)', (() => {
    boot('1919-11-29', [rumor('1910-01-01')]);
    const b = rumorDecayBreakdown(state.rumors[0]);
    const expect = Math.min(1, b.base * (1 + b.speed) + 0.5 * b.speed);
    return b.horizonDays === RUMOR_AGE_HORIZON_DAYS && b.speed === 1 && b.boost === 2 && Math.abs(b.add - 0.5) < 1e-9
        && Math.abs(b.score - expect) < 1e-9 && b.ageDays > 3000 && b.date === '1910-01-01'
        && Math.abs(rumorDecayScore(state.rumors[0]) - b.score) < 1e-9;
})(), J(rumorDecayBreakdown(rumor('1910-01-01'))));

A('A4 单调性：同一条列表中，发生时间越久远 → 系数越高（衰退越快）', (() => {
    const list = [rumor('1919-11-27'), rumor('1919-01-01'), rumor('1915-01-01'), rumor('1900-01-01')];
    boot('1919-11-29', list);
    const scores = list.map((r) => rumorDecayScore(r));
    // 单调不减（越久远越高；封顶 1 后允许并列）
    return scores[0] < scores[1] && scores[1] <= scores[2] && scores[2] <= scores[3] && scores[3] === 1;
})(), J((() => { const l = [rumor('1919-11-27'), rumor('1919-01-01'), rumor('1915-01-01'), rumor('1900-01-01')]; boot('1919-11-29', l); return l.map((r) => Number(rumorDecayScore(r).toFixed(3))); })()));

A('A5 新传言几乎不受影响：与「无剧情时钟」（= 关闭时间判断）相比，系数差 ≤ 0.01 且久远度 ≤ 0.01', (() => {
    const r = rumor('1919-11-28');                       // 剧情当下 1919-11-29 → 距今 1 天
    boot('1919-11-29', [r]);
    const withClock = rumorDecayScore(r);
    const speed = rumorAgeSpeed(r);
    boot('', [r]);
    const without = rumorDecayScore(r);
    return speed <= 0.01 && withClock >= without && (withClock - without) <= 0.01;
})(), J({ withClock: rumorDecayScore(rumor('1919-11-28')), speed: rumorAgeSpeed(rumor('1919-11-28')) }));

A('A6 无发生日期的传言完全保持原行为（不受时间判断影响）', (() => {
    const withDate = rumor('1900-01-01');
    const noDate = rumor('');
    boot('1919-11-29', [withDate, noDate]);
    const b1 = rumorDecayBreakdown(withDate), b2 = rumorDecayBreakdown(noDate);
    return b2.speed === 0 && b2.add === 0 && Math.abs(b2.score - b2.base) < 1e-9 && b1.score > b2.score;
})(), '见断言');

A('A7 阈值联动：久远传言达到移除阈值；新传言不达（`rumorExpired` 与 `score` 同源）', (() => {
    const oldR = rumor('1910-01-01');
    const newR = rumor('1919-11-28');
    boot('1919-11-29', [oldR, newR]);
    cfg.rumorDecayCutoff = 0.9;
    const oldExpired = rumorExpired(oldR);
    const newExpired = rumorExpired(newR);
    // 对照：把久远那条的剧情日期挪到「刚刚发生」→ 不再达阈值（证明差异来自时间判断）
    const moved = Object.assign({}, oldR, { date: '1919-11-29' });
    boot('1919-11-29', [moved, newR]);
    cfg.rumorDecayCutoff = 0.9;
    return oldExpired === true && newExpired === false && rumorExpired(moved) === false;
})(), J({ old: rumorDecayBreakdown(rumor('1910-01-01')), moved: rumorDecayBreakdown(rumor('1919-11-29')) }));

await (async () => {
    // 端到端：一次衰退清扫只移除久远的那条，墓碑留痕
    const oldR = rumor('1900-01-01');
    const newR = rumor('1919-11-28');
    boot('1919-11-29', [oldR, newR]);
    cfg.rumorDecayCutoff = 0.9;
    const res = await runRumorDecay({ force: true });
    const remain = (state.rumors || []).map((x) => x.id);
    A('A8 端到端：衰退清扫移除久远传言、保留新传言，且留删除墓碑',
        res.removed === 1 && remain.length === 1 && remain[0] === newR.id
        && !!((state.deleted || {}).rumors || {})[oldR.id],
        J({ res: res, remain: remain, tomb: Object.keys((state.deleted || {}).rumors || {}) }));
})();

A('A9 边界：发生时间正好 1 年 → speed = 1；29 天差 1 天 → 严格小于 1（阈值即 365 天）', (() => {
    boot('1919-11-29', []);
    const exactly = rumorAgeSpeed(rumor('1918-11-29'));
    const justUnder = rumorAgeSpeed(rumor('1918-11-30'));
    return exactly === 1 && justUnder < 1 && Math.abs(justUnder - 364 / 365) < 0.01;
})(), J({ exactly: rumorAgeSpeed(rumor('1918-11-29')), justUnder: Number(rumorAgeSpeed(rumor('1918-11-30')).toFixed(4)) }));

A('A10 设定页口径同步：衰退开关/移除阈值提示与传言页短提示都写明「发生越久远消退越快」', (() => {
    const src = readFileSync(join(HERE, '..', '..', 'ui', 'settings-pages.js'), 'utf8');
    // 三条文案都在：控件表 hint ×2 + 传言页短提示 ×1
    const a = src.indexOf('超出存储上限后按保留度淘汰旧传言；发生越久远消退越快') >= 0;
    const b = src.indexOf('系数含剧情时间久远度') >= 0;
    const c = src.indexOf('发酵可裂变，发生越久远消退越快') >= 0;
    return a && b && c;
})(), '见断言');

R.done();
