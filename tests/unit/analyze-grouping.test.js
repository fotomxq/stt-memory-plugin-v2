// ============================================================
// 单元测试 · v2.73.0「设定 → 分析记忆：布局分组（尤其是最底部一组）」
//
// 用户要求：「新版本，分析记忆的 UI 布局需优化，合理分组，尤其是**最底部的一组设定**。」
//
// 修复前：页面 = 「维度分组（总开关）」+「各维度独立子开关与分组」两节，
//   末尾把 **5 个控件平铺**（分段读取楼层数 + 情节分段总结 4 项）——没有节标题、没有说明，和维度行混成一片。
//
// 本批（`ui/settings-pages.js#analyzePageHtml`）按 V1 的分节口径补齐：
//   ① 维度分组（总开关）② 各维度独立子开关与分组（独立分组时生效）
//   ③ **分析范围**（`summaryChunkSize` + 一句短提示）
//   ④ **情节分段总结（情节页「🧩 分段总结」）**（`plotSegment*` 4 项 + 短提示 + 折叠说明）
//   控件键一个不少（5 + 代理键 `dimensionSeparate` = 6），长解释收进折叠块（v2.60 口径）。
//
// V1 对照：v1.206 25505~25535 的 4 个 `<div class="ftt-section">` 与节标题逐字。
// 运行：node tests/unit/analyze-grouping.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { SETTINGS_CONTROLS, settingsPageHtml, analyzePageHtml } from '../../ui/settings-pages.js';

const R = makeReporter('analyze-grouping v2.73.0 分析记忆布局分组');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
function boot(extra) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    Object.assign(cfg, extra || {});
    setScopeKey('甲');
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
}
boot();
const HTML = settingsPageHtml('analyze');
const secTitles = (h) => Array.from(String(h).matchAll(/<div class="ftt-sec-title">([^<]*)<\/div>/g)).map((m) => m[1]);
const cfgKeys = (h) => Array.from(String(h).matchAll(/data-ftt-cfg="([^"]+)"/g)).map((m) => m[1]);
const at = (h, s) => String(h).indexOf(s);
const TITLES = ['维度分组（总开关）', '各维度独立子开关与分组（独立分组时生效）', '分析范围', '情节分段总结（情节页「🧩 分段总结」）'];

A('A1 四节结构与 V1 逐字：维度分组 → 各维度子开关 → 分析范围 → 情节分段总结', (() => {
    return J(secTitles(HTML)) === J(TITLES) && at(HTML, TITLES[0]) < at(HTML, TITLES[1])
        && at(HTML, TITLES[1]) < at(HTML, TITLES[2]) && at(HTML, TITLES[2]) < at(HTML, TITLES[3]);
})(), J(secTitles(HTML)));

A('A2 最底部一组已归位：「分析范围」只含分段读取楼层数；「情节分段总结」含 4 项', (() => {
    const iScope = at(HTML, '分析范围');
    const iSeg = at(HTML, TITLES[3]);
    const iChunk = at(HTML, 'data-ftt-cfg="summaryChunkSize"');
    const segKeys = ['plotSegmentBatchAtoms', 'plotSegmentProtectManual', 'plotSegmentIncremental', 'plotSegmentTextLimit']
        .map((k) => at(HTML, 'data-ftt-cfg="' + k + '"'));
    return iScope > 0 && iChunk > iScope && iChunk < iSeg
        && segKeys.every((v) => v > iSeg)
        // 「分析范围」之后到「情节分段总结」之前只有 summaryChunkSize 一个控件
        && cfgKeys(HTML.slice(iScope, iSeg)).join(',') === 'summaryChunkSize'
        && cfgKeys(HTML.slice(iSeg)).join(',') === 'plotSegmentBatchAtoms,plotSegmentProtectManual,plotSegmentIncremental,plotSegmentTextLimit';
})(), J({ scope: cfgKeys(HTML.slice(at(HTML, '分析范围'), at(HTML, TITLES[3]))) }));

A('A3 控件一个不少：5 个控件 + 代理键 `dimensionSeparate` = 6，且各出现一次', (() => {
    const need = SETTINGS_CONTROLS.analyze.map((c) => String(c.key));
    const got = cfgKeys(HTML);
    const miss = need.filter((k) => got.indexOf(k) < 0);
    const dup = need.filter((k) => got.filter((x) => x === k).length !== 1);
    return need.length === 5 && miss.length === 0 && dup.length === 0 && got.length === 6
        && got.indexOf('dimensionSeparate') === 0;
})(), J(cfgKeys(HTML)));

A('A4 两节各一句短提示（≤90 字、无历史版本字样）；长解释收进折叠块', (() => {
    const hints = [];
    const re = /<div class="ftt-muted" data-ftt-short-hint>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = re.exec(HTML)) !== null) hints.push(String(m[1]).replace(/<[^>]+>/g, '').trim());
    return hints.length === 2 && hints.every((t) => t.length > 0 && t.length <= 90)
        && hints[0].indexOf('默认 10') > 0 && hints[1].indexOf('不注入') > 0
        && hints.every((t) => t.indexOf('V1') < 0)
        && HTML.indexOf('<details') > 0 && HTML.indexOf('ftt-hint-body') > 0
        && HTML.indexOf('**') < 0;
})(), J({ hints: '2 句' }));

A('A5 折叠说明保留 V1 的四段口径（保护时间范围 / 增量 / 字数硬截断 / 不注入）', (() => {
    const i = HTML.indexOf('ftt-hint-body');
    const body = i >= 0 ? HTML.slice(i, HTML.indexOf('</details>', i)) : '';
    return body.indexOf('保护已存在的时间范围') > 0 && body.indexOf('增量') > 0
        && body.indexOf('硬截断') > 0 && body.indexOf('不注入') > 0 && body.indexOf('12 批') > 0;
})(), '见断言');

A('A6 维度分组的代理键与文案（回归）：`dimensionSeparate` 勾选态跟随配置，标签「独立分组」与状态文案齐备', (() => {
    boot({ dimensionGrouping: 'separate' });
    const on = settingsPageHtml('analyze');
    boot({ dimensionGrouping: 'unified' });
    const off = settingsPageHtml('analyze');
    return on.indexOf('data-ftt-cfg="dimensionSeparate" checked') > 0
        && on.indexOf('独立分组（各维度可单独选预设并行请求）') > 0
        && off.indexOf('data-ftt-cfg="dimensionSeparate" checked') < 0
        && off.indexOf('统一分组（一次请求全部维度）') > 0
        && on.indexOf('data-ftt-dim-preset="atoms"') > 0;
})(), '见断言');

A('A7 兜底：未登记的控件键落入末节「其它」（当前分析页没有该节 —— 分组表覆盖全部 5 项）', (() => {
    const extra = analyzePageHtml([{ key: 'zzzUnknown', label: '未知项', type: 'text' }]);
    return extra.indexOf('<div class="ftt-sec-title">其它</div>') > 0 && extra.indexOf('data-ftt-cfg="zzzUnknown"') > 0
        && HTML.indexOf('<div class="ftt-sec-title">其它</div>') < 0;
})(), '见断言');

A('A8 控件表仍是 V1 原标签（渲染层未改文案）：5 项标签逐字一致', (() => {
    const labels = SETTINGS_CONTROLS.analyze.map((c) => String(c.label));
    const want = ['分段读取楼层数（每段分析量）', '每次打包给 AI 的情节条数（默认 30）',
        '保护已存在的时间范围（不覆盖）', '只整理未覆盖的情节（增量）', '单条剧情线概述字数上限（默认 400）'];
    return J(labels) === J(want) && want.every((l) => HTML.indexOf(l) > 0);
})(), J(SETTINGS_CONTROLS.analyze.map((c) => c.label)));

A('A9 节容器完整：四个 `.ftt-section` 都闭合，且每节内至少一个控件或内容块', (() => {
    const opens = (HTML.match(/<div class="ftt-section">/g) || []).length;
    const closes = (HTML.match(/<\/div>\n?<div class="ftt-section">|<\/div>$/g) || []).length;
    return opens === 4 && closes >= 3 && secTitles(HTML).length === 4
        && HTML.indexOf('ftt-section"><div class="ftt-sec-title">分析范围') > 0;
})(), '见断言');

R.done();
