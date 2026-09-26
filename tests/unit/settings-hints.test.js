// ============================================================
// 单元测试 · v2.57.0「遗忘 / 传言 / 平行：提示言简意赅 + 扩展提示走 UI 交互」
//
// 用户要求：「设定的遗忘、传言、平行的提示信息需全面完善，避免罗嗦的提示信息，展示内容必须言简意赅，
//   让用户能一目了然；其次扩展提示信息，应通过 **UI 交互或其他方式**展示，避免挤占 UI。」
//
// 做法（本测试逐项锁定）：
//   ① 每节 / 每页只留**一句**短提示（`data-ftt-short-hint`，≤ 40 字）；
//   ② 详细解释与参数含义放进**默认折叠**的 `<details class="ftt-details ftt-hint-details">`
//      （触屏可点开、桌面可悬停：控件标签带 `title` 悬停提示 + 「ⓘ」标记）；
//   ③ 参数清单由控件自己的 `hint` 字段生成（`ui/hints.js#paramListHtml`），不重复维护；
//   ④ 页面上不再出现长段落解释、跨页指路、V1/行号等开发说明。
// 运行：node tests/unit/settings-hints.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { setKernelState } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import { settingsPageHtml, SETTINGS_CONTROLS, settingsControlHtml } from '../../ui/settings-pages.js';
import { forgetPageHtml } from '../../ui/forget.js';
import { hintDetailsHtml, paramListHtml, shortHintHtml } from '../../ui/hints.js';
import { escHtml } from '../../core/util.js';

const R = makeReporter('settings-hints v2.57.0 遗忘/传言/平行 提示精简 + 交互展开');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

installGlobalHost(makeHost({}), makeDocument(['ftt-panel']));
setKernelState(emptyState());

const PAGE_IDS = ['forget', 'rumors', 'parallels'];
const htmlOf = (pid) => settingsPageHtml(pid, '');
/** 可见文本（去掉标签；折叠块内容也算，因为它们默认不渲染时本来就在 DOM 里） */
const textOf = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
/** 短提示行的文本与长度 */
const shortHints = (h) => (h.match(/<div class="ftt-muted" data-ftt-short-hint>([^<]*)<\/div>/g) || [])
    .map((x) => x.replace(/<[^>]+>/g, '').trim());

// ---- S 组：结构（精简不能把功能删掉） ----
A('S1 三页仍渲染（设定页容器 + 各自分节）；遗忘四分节标题与关键控件、传言/平行全部控件都在', (() => {
    const f = htmlOf('forget'), r = htmlOf('rumors'), p = htmlOf('parallels');
    return f.indexOf('状态记录衰退（只按剧情日期）') >= 0 && f.indexOf('记忆遗忘机制（只按剧情日期）') >= 0
        && f.indexOf('存储保底 / 上限') >= 0 && f.indexOf('通用遗忘清扫') >= 0
        && f.indexOf('data-ftt-cfg="stateDecayEnabled"') >= 0 && f.indexOf('data-ftt-cfg="lowUseForgetEnabled"') >= 0
        && SETTINGS_CONTROLS.rumors.every((c) => r.indexOf('data-ftt-cfg="' + c.key + '"') >= 0)
        && SETTINGS_CONTROLS.parallels.every((c) => p.indexOf('data-ftt-cfg="' + c.key + '"') >= 0)
        && p.indexOf('data-ftt-cfg="parallelApiPreset"') >= 0;
})(), '见断言');

A('S2 每节/每页只留一句短提示：遗忘 4 句、传言 1 句、平行 1 句，且每句 ≤ 40 字', (() => {
    const got = { forget: shortHints(htmlOf('forget')), rumors: shortHints(htmlOf('rumors')), parallels: shortHints(htmlOf('parallels')) };
    return got.forget.length === 4 && got.rumors.length === 1 && got.parallels.length === 1
        && [].concat(got.forget, got.rumors, got.parallels).every((t) => t.length > 0 && t.length <= 40);
})(), J({ forget: shortHints(htmlOf('forget')), rumors: shortHints(htmlOf('rumors')), parallels: shortHints(htmlOf('parallels')) }));

// ---- I 组：扩展提示走 UI 交互 ----
A('I1 详细介绍都在折叠块里（`<details class="ftt-details ftt-hint-details">`，**默认收起**）：遗忘 4 块、传言 1 块、平行 1 块', (() => {
    const count = (h) => (h.match(/<details class="ftt-details ftt-hint-details">/g) || []).length;
    return count(htmlOf('forget')) === 4 && count(htmlOf('rumors')) === 1 && count(htmlOf('parallels')) === 1;
})(), '见断言');

A('I2 折叠块里有真内容：标题「ⓘ 说明 / ⓘ 参数说明」+ 正文（不是空壳）', (() => {
    const f = htmlOf('forget'), r = htmlOf('rumors'), p = htmlOf('parallels');
    const bodyOk = (h) => (h.match(/<div class="ftt-hint ftt-hint-body">[\s\S]{20,}?<\/div><\/details>/g) || []).length >= 1;
    return f.indexOf('ⓘ 说明') >= 0 && r.indexOf('ⓘ 参数说明') >= 0 && p.indexOf('ⓘ 参数说明') >= 0
        && bodyOk(f) && bodyOk(r) && bodyOk(p);
})(), '见断言');

A('I3 每个参数都有悬停提示：控件带 `title`（hint）且标签后有「ⓘ」标记；参数清单与 hint 同源', (() => {
    const f = htmlOf('forget');
    const withHints = SETTINGS_CONTROLS.forget.filter((c) => String(c.hint || '').trim());
    return withHints.length >= 20
        && withHints.every((c) => {
            const h = settingsControlHtml(c);
            return h.indexOf('title="' + escHtml(String(c.hint)) + '"') >= 0 && h.indexOf('ⓘ') >= 0;
        })
        // 参数清单：折叠块里用的是转义后的同一条 hint（单一来源，不重复维护）
        && withHints.every((c) => f.indexOf(escHtml(String(c.hint))) >= 0)
        && paramListHtml(withHints).indexOf(escHtml(String(withHints[0].hint))) >= 0;
})(), '见断言');

A('I4 组件契约：hintDetailsHtml 空正文不渲染；paramListHtml 只收有 hint 的控件；shortHintHtml 带 data 标记', (() => {
    const controls = [{ key: 'a', label: '甲', hint: '甲的说明' }, { key: 'b', label: '乙' }];
    const pl = paramListHtml(controls);
    return hintDetailsHtml('说明', '') === '' && hintDetailsHtml('', '') === ''
        && hintDetailsHtml('', '正文').indexOf('ⓘ 说明') >= 0   // 标题缺省 = 「说明」
        && hintDetailsHtml('说明', '正文').indexOf('ⓘ 说明') >= 0
        && pl.indexOf('甲的说明') >= 0 && pl.indexOf('乙') < 0
        && shortHintHtml('一句话').indexOf('data-ftt-short-hint') >= 0;
})(), '见断言');

// ---- N 组：罗嗦内容必须消失 ----
A('N1 页面上不再有长段落解释（≤ 40 字的短提示以外的说明文字都在折叠块内）', (() => {
    // 取出折叠块正文，剩下的可见文本里不应出现旧的长句
    const longSentences = [
        '按剧情日期老化：无剧情时钟不衰退',
        '状态修复（状态页「🔧 修复状态」）：自动匹配角色',
        '再次被 AI 写入即刷新（想起）；只按剧情日期，重要性低于均值的旧记忆渐进遗忘',
        '保底 = 自动机制不跌破的条数；上限 = 常规裁剪目标',
        '只清理长期没人用、也没再出现的条目；重要度高者',
    ];
    const outside = (h) => {
        // 去掉所有 details 块（含正文）后再找长句
        let out = h;
        for (let i = 0; i < 10; i++) out = out.replace(/<details[\s\S]*?<\/details>/g, '');
        return out;
    };
    const f = outside(htmlOf('forget'));
    return longSentences.every((s) => f.indexOf(s) < 0) && textOf(htmlOf('forget')).indexOf('按剧情日期老化：无剧情时钟不衰退') < 0
        // 但内容没丢：折叠块里仍能查到
        && htmlOf('forget').indexOf('久未出现或失效的状态达到阈值自动移除') >= 0;
})(), '见断言');

A('N2 不再出现跨页指路与开发说明：遗忘页脚「已移至」、平行渠道的 V1 同键/行号都不在', (() => {
    const f = htmlOf('forget'), p = htmlOf('parallels'), r = htmlOf('rumors');
    return f.indexOf('已移至') < 0 && f.indexOf('📌') < 0
        && p.indexOf('V1 同键') < 0 && p.indexOf('v1.206') < 0 && r.indexOf('V1') < 0
        && [f, r, p].every((h) => h.indexOf('docs/') < 0 && h.indexOf('v1.2') < 0);
})(), '见断言');

A('N3 控件标签短小：遗忘 / 传言 / 平行三页的标签都不含「（默认 …）」这类默认值长尾（默认值改到悬停提示）', (() => {
    const bad = [];
    for (const pid of PAGE_IDS) {
        for (const c of (SETTINGS_CONTROLS[pid] || [])) {
            const label = String(c.label || '');
            if (/（默认|\(默认/.test(label)) bad.push(pid + ':' + label);
        }
    }
    return bad.length === 0;
})(), '见断言（bad 为空）');

// ---- L 组：遗忘页的直接调用与设定页一致 ----
A('L1 forgetPageHtml(controls) 与设定页渲染一致（同一份内容，避免两处各写一套）', (() => {
    const a = forgetPageHtml(SETTINGS_CONTROLS.forget);
    const b = htmlOf('forget');
    return a === b && a.indexOf('data-ftt-forget-state') >= 0 && b.indexOf('data-ftt-short-hint') >= 0;
})(), '见断言');

A('L2 只读诊断行仍在（一句话给出「为什么没清」）', (() => {
    const h = htmlOf('forget');
    return h.indexOf('data-ftt-forget-state') >= 0 && /当前：状态记录 \d+\/\d+/.test(textOf(h));
})(), textOf(htmlOf('forget')).slice(0, 120));

R.done();
