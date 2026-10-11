// ============================================================
// 单元测试 · v3.44.0 `docs/D22` W4 **`数-11`** —— 关联行不再普遍失锚
//   设计：`docs/D20` §3.4 / §8 `数-11`（① 提示词强制锚点 ② 机械回填 ③ 体检「失锚关联」 ④ 关系表标注「无依据」）
//   实现：`core/rel-maint.js#backfillRelLinkAnchors` / `#relAnchorGaps` · `core/data-health.js`（`hygiene`）·
//         `ui/rel-table.js#relAnchorNote`（行内「依据」列）· `core/prompt.js`（可选补丁位）
//
// 本文件锁四件事（**回填口径是本项最容易做错的地方**）：
//   ① **只回填能确定的**：`at` 仅在「当时在场」的四种知情方式下 = 归属条目的剧情日期；
//      `被告知 / 推断 / 传闻` **一律不回填**（他们的知情时间晚于事发，拿条目日期顶上就是编数据）；
//   ② **幂等 + 绝不覆盖**：已有 `at` 的行不动；连跑两次第二次 `filled=0`、数据逐字不变；
//   ③ **可区分来源**：回填写进 `note`（既有字段、被 V1 归一化器保留），空白注才写、绝不覆盖既有说明；
//   ④ **提示词补丁默认关**：默认输出与 V1 **逐字节相同**（黄金样本不受影响），开启才追加锚点规则。
//
// 运行：node tests/unit/rel-anchors.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg, REL_ANCHOR_RULE_DEFAULT } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { migrateState, lastHealInfo } from '../../core/migrate.js';
import { REL_ANCHOR_PRESENT_HOWS, REL_AT_BACKFILL_NOTE, backfillRelLinkAnchors, relAnchorGaps } from '../../core/rel-maint.js';
import { dataHealthReport, dataHealthHygieneText } from '../../core/data-health.js';

const R = makeReporter('rel-anchors v3.44.0 关联行锚点（D22 W4 数-11）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

Object.assign(cfg, clone(defaultCfg));
setScopeKey('甲');
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

/** 一份含「在场 / 被告知」两类关联行的存档（`memories` 有剧情日期） */
const SEED = () => Object.assign(emptyState(), {
    memories: [{ id: 'm1', owner: '甲', content: '甲记得昨夜有人在巷口徘徊。', date: '1919-11-28' }],
    links: [
        { id: 'l1', dim: 'memories', refId: 'm1', who: '甲', how: 'participant', from: '', at: '', view: '' },
        { id: 'l2', dim: 'memories', refId: 'm1', who: '乙', how: 'told', from: '', at: '', view: '' },
        { id: 'l3', dim: 'memories', refId: 'm1', who: '丙', how: 'witness', from: '', at: '1919-11-29', view: '觉得可疑' },
    ],
});

A('R1 「在场」集合：亲历 / 目击 / 策划 / 当事人（这些人的知情时间 = 事发时间）；其余方式不在集合内', (() => {
    return J(REL_ANCHOR_PRESENT_HOWS.slice().sort()) === J(['author', 'involved', 'participant', 'witness'])
        && REL_ANCHOR_PRESENT_HOWS.indexOf('told') < 0 && REL_ANCHOR_PRESENT_HOWS.indexOf('rumor') < 0;
})(), J(REL_ANCHOR_PRESENT_HOWS));

A('R2 缺口统计（体检口径）：`at` / `from` / `view` 三类分别计数，并单独给出「当时在场却没有知情时间」的条数', (() => {
    const s = SEED();
    const g = relAnchorGaps(s);
    return g.total === 3 && g.at === 2 && g.from === 3 && g.view === 2 && g.atPresent === 1 && g.byDim.memories === 1;
})(), J(relAnchorGaps(SEED())));

A('R3 **机械回填只回填「在场」那一种**：亲历者拿到条目日期；被告知者**不回填**（知情晚于事发）；已有 `at` 的行不动', (() => {
    const s = SEED();
    const r = backfillRelLinkAnchors(s);
    const by = (id) => s.links.filter((x) => x.id === id)[0];
    return r.changed === true && r.filled === 1 && r.skipped === 1
        && by('l1').at === '1919-11-28' && by('l1').note === REL_AT_BACKFILL_NOTE      // 回填 + 来源标记
        && by('l2').at === ''                                                          // 被告知 → 不回填
        && by('l3').at === '1919-11-29' && String(by('l3').note || '') === ''          // 已有值 + 既有说明不动（注缺省 = 空）
        && r.byDim.memories === 1;
})(), '');

A('R4 幂等 + 不覆盖：连跑两次，第二次 `filled=0` 且数据逐字不变；既有 `note` 绝不被来源标记覆盖', (() => {
    const s = SEED();
    backfillRelLinkAnchors(s);
    const snap = J(s.links);
    const r2 = backfillRelLinkAnchors(s);
    // 有注的行：填 at 但不改注
    const s2 = SEED();
    s2.links[0].how = 'participant'; s2.links[0].note = 'AI 给的说明';
    backfillRelLinkAnchors(s2);
    return r2.changed === false && r2.filled === 0 && J(s.links) === snap
        && s2.links[0].at === '1919-11-28' && s2.links[0].note === 'AI 给的说明';
})(), '');

A('R5 归属条目没有剧情日期 / 引用已消失 → 不回填（宁可留空，也不编一个日期）', (() => {
    const s = SEED();
    s.memories = [{ id: 'm1', owner: '甲', content: '无日期的记忆' }];
    const r1 = backfillRelLinkAnchors(s);
    const s2 = SEED();
    s2.memories = [];                                        // 归属条目不存在 → 查不到日期
    const r2 = backfillRelLinkAnchors(s2);
    return r1.filled === 0 && r1.skipped === 2 && s.links[0].at === ''
        && r2.filled === 0 && s2.links[0].at === '';
})(), '');

A('R6 载入期接线：`migrateState` 走完**关联层归一之后**再回填（否则来源标记会被 V1 口径的 `normalizeRelLink` 抹掉）—— 数据里同时留下 `at` 与来源注', (() => {
    const s = SEED();
    migrateState(s);
    const l1 = s.links.filter((x) => x.who === '甲')[0];
    const l2 = s.links.filter((x) => x.who === '乙')[0];
    const h = lastHealInfo();
    return !!l1 && l1.at === '1919-11-28' && l1.note === REL_AT_BACKFILL_NOTE
        && !!l2 && l2.at === '' && h.anchors === 1;
})(), '');

A('R7 体检出口：三个字段各自的缺口进 `hygiene`（**不**进 `findings`，不抬高 `level`），并能渲染成一行卫生摘要', (() => {
    const rep = dataHealthReport(SEED());
    const txt = dataHealthHygieneText(rep);
    return rep.hygiene.counts['link-missing-anchor'] === 7        // at 2 + from 3 + view 2（三类各自计数并汇总到同一 code）
        && rep.findings.filter((f) => f.code === 'link-missing-anchor').length === 0
        && txt.indexOf('link-missing-anchor') >= 0;
})(), '');

A('R8 提示词补丁：文本是**常量**且默认**不**追加 —— 默认 `cfg.promptTemplates` 里没有它、开关默认 false；开启后才生效', (() => {
    const hasKey = Object.keys(defaultCfg.promptTemplates || {}).indexOf('relAnchorRule') >= 0;
    const on = defaultCfg.relAnchorRuleEnabled;
    return hasKey === false && on === false
        && REL_ANCHOR_RULE_DEFAULT.indexOf('知情时间') > 0 && REL_ANCHOR_RULE_DEFAULT.indexOf('告知者') > 0
        && REL_ANCHOR_RULE_DEFAULT.indexOf('差异') > 0
        && REL_ANCHOR_RULE_DEFAULT.indexOf('亲密') < 0;
})(), '');

R.done();
