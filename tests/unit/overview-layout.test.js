// ============================================================
// 单元测试 · v2.66.0「总览 UI 调整」
//
// 用户要求：「新版本，UI 调整：① 总览的最后一次提取应该放到**最后末端**；② 查看提取内容**高度不足**；
//   ③ 时钟来源这些提示信息**完全没用**；④ 最后总览的整体 UI 布局**微调优化**。」
//
// 本批（`ui/panel.js#overviewBody` + `ui/clock.js#clockSectionHtml` + `style.css`）：
//   ① 「📤 最后一次提取」整块移到总览**最末端**（回顾性质，不占首屏）；
//   ② 「查看提取内容」此前误用 `.ftt-scroll-40`（上限 40px，只够两行）→ 改为 `.ftt-extract-pre`
//      （min-height 160px / max-height 46vh，见 style.css）；
//   ③ 总览移除「🕒 时钟来源」「最近一次取值」两行提示（`data-ftt-clock-src` / `data-ftt-clock-trace`）；
//      取值过程仍在 设定 → 调试「🕒 时钟取值追踪」里可查；
//   ④ 布局微调：总览统一容器 `.ftt-overview`（收紧区块间距）+ 时钟四行合并为一个紧凑块 `.ftt-clock-line`
//      + 未摘要楼层列表 `.ftt-pend-list` 限高可滚（40+ 按钮不再无限撑高）。
//
// 运行：node tests/unit/overview-layout.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { panelBodyHtml, openPanel, setPanelHooks2 } from '../../ui/panel.js';
import { clockSectionHtml } from '../../ui/clock.js';
import { clockTraceStart, clockTraceText, clockTraceFinish, clockTraceLast } from '../../core/clock-trace.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const R = makeReporter('overview-layout v2.66.0 总览 UI 调整');
const A = (n, c, e) => R.assert(n, !!c, e);
const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', '..', 'style.css'), 'utf8');

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
setScopeKey('char:overview-layout');

function boot(extra) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    setKernelState(Object.assign(emptyState(), extra || {}));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    // v2.75.0：折叠块展示**注入内容** → 提供注入读取钩子（与宿主 `hooks.injectText` 同源）
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => [3, 5, 7], lastExtract: () => LAST, injectText: () => INJECT, flushDrain: () => 0 });
}
const INJECT = '【FTT记忆注入】以下为该角色的长期记忆库。\n[情节记忆] 甲打开木箱取出账册。\n记忆结束。';
const LAST = {
    at: Date.now(), via: 'segment', trigger: 'manual', floors: '3-5', added: 2, made: 1, chars: 1234,
    dims: ['atoms', 'memories'], keywords: ['木箱', '账册'], text: '甲打开木箱取出账册。\n'.repeat(30),
};
boot();
const TR = clockTraceStart('probe', '摘要自检');
clockTraceText(TR, { mode: 'given', floors: '调用方给定', chars: 12 });
clockTraceFinish(TR);
openPanel('overview');
const H = panelBodyHtml('overview');

A('O1 总览统一容器与顺序：「最后一次提取」在最末端（时钟 → 管线 → 注入 → 工具 → 统计 → 未摘要/已处理 → 最后提取）', (() => {
    const at = (s) => H.indexOf(s);
    return H.indexOf('<div class="ftt-overview">') === 0
        && at('data-ftt-clock') > 0 && at('data-ftt-pipeline-label') > at('data-ftt-clock')
        && at('data-ftt-inject') > at('data-ftt-pipeline-label') && at('ftt-summary-btn') > at('data-ftt-inject')
        && at('📚 共 ') > at('ftt-summary-btn') && at('⏳ 未摘要') > at('📚 共 ')
        && at('✅ 已处理') > at('⏳ 未摘要') && at('data-ftt-last-extract') > at('✅ 已处理')
        // 末端：最后提取之后不再有其它组件（只有 </div> 收尾）
        && H.slice(at('data-ftt-last-extract-line')).indexOf('<div class="ftt-item') < 0;
})(), '见断言');

A('O2 「查看注入内容」用足高度：`.ftt-extract-pre`（不再用 40px 上限的 `.ftt-scroll-40`）', (() => {
    // v2.75.0：折叠块内容改为**注入内容**（`data-ftt-inject-preview`），高度类仍是 `.ftt-extract-pre`
    const a = H.indexOf('查看注入内容');
    const b = H.indexOf('</details>', a);
    const det = (a >= 0 && b > a) ? H.slice(a, b) : '';
    const css = (CSS.match(/[^\n]*\.ftt-extract-pre\s*\{[^}]*\}/) || [''])[0];
    const minH = Number((css.match(/min-height:\s*(\d+)px/) || [])[1] || 0);
    const maxH = Number((css.match(/max-height:\s*(\d+)px/) || [])[1] || 0);
    return det.indexOf('ftt-pre ftt-extract-pre') >= 0 && det.indexOf('data-ftt-inject-preview') >= 0
        && det.indexOf('【FTT记忆注入】') >= 0 && det.indexOf('记忆结束。') >= 0
        && det.indexOf('ftt-scroll-40') < 0
        && minH >= 120 && maxH === 0 && css.indexOf('max-height: 46vh') > 0;
})(), '见断言');

A('O3 时钟提示精简：总览不再有「时钟来源 / 最近一次取值」，取值过程只在调试页', (() => {
    const clock = clockSectionHtml();
    return H.indexOf('data-ftt-clock-src') < 0 && H.indexOf('data-ftt-clock-trace') < 0
        && H.indexOf('时钟来源') < 0 && clock.indexOf('data-ftt-clock-src') < 0
        && clock.indexOf('data-ftt-clock-trace') < 0 && H.indexOf('设定→调试「🕒 时钟取值追踪」') < 0
        && !!clockTraceLast('probe');
})(), '见断言');

A('O4 时钟块紧凑：单个 `data-ftt-clock` 容器 + 四条 `.ftt-clock-line`（不再占四条独立分隔行）', (() => {
    const clock = clockSectionHtml();
    const lines = (clock.match(/ftt-clock-line/g) || []).length;
    return clock.indexOf('data-ftt-clock') >= 0 && lines === 4
        && clock.indexOf('📅 日期：') > 0 && clock.indexOf('⏱ 时间：') > 0
        && clock.indexOf('📍 地点：') > 0 && clock.indexOf('👥 在场角色：') > 0
        // 四行在同一个 .ftt-item 容器里（紧凑块）：容器只有一个
        && (clock.match(/class="ftt-item ftt-item--col" data-ftt-clock/g) || []).length === 1;
})(), '见断言');

A('O5 布局微调 CSS 齐备：总览间距收紧 + 未摘要列表限高可滚 + 时钟行分隔', (() => {
    return /#ftt-panel \.ftt-overview > \.ftt-item \{ padding: 4px 0; \}/.test(CSS)
        && /#ftt-panel \.ftt-overview \.ftt-row \{ margin: 6px 0; \}/.test(CSS)
        && /#ftt-panel \.ftt-clock-line \{ padding: 1px 0; \}/.test(CSS)
        && /#ftt-panel \.ftt-pend-list \{[^}]*max-height: 32vh;[^}]*overflow-y: auto;/.test(CSS);
})(), '见断言');

A('O6 未摘要楼层 40+ 按钮不再无限撑高：列表类名在渲染里，限高由 CSS 承担', (() => {
    const many = Array.from({ length: 45 }, (_, i) => i + 1);
    setPanelHooks2({ busy: () => false, batchProgress: () => ({}), pending: () => many, lastExtract: () => null });
    const h2 = panelBodyHtml('overview');
    return h2.indexOf('ftt-pend-list') > 0 && h2.indexOf('…+5') > 0
        && (h2.match(/data-ftt-action="summaryFloor"/g) || []).length === 40
        && /#ftt-panel \.ftt-pend-list \{[^}]*max-height: 32vh;/.test(CSS);
})(), '见断言');

R.done();
