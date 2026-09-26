// ============================================================
// 单元测试 · v2.59.0「总览：最后一次提取记忆内容组件」
//
// 用户报告：「概览缺少展示**最后一次提取记忆内容**的组件。」
// 核对：V1 总览（`overviewHtml` ≈23892~23905）有「当前注入预览（与实际注入一致）」块，统计行含
//   「📄 字数 / 🔢 token 估算 / 🕒 **最后提取/更新** 时间 / 🔑 最近提取关键词」并铺开预览正文；
//   V2 总览（v2.52.0 精简后）只留一句「🧷 注入 N 字 · 命中/未命中 · 预算」—— 缺这块。
// 本批：`host/extract.js` 记录**最后一次提取**（时间/来源/楼层范围/新增条数/维度/关键词/AI 回复正文，正文截 4000 字），
//   总览新增「📤 最后一次提取」一行 + 默认收起的折叠块。
// v2.75.0（用户要求）：折叠块展示的改为**注入内容**（当前注入给 AI 的正文），不再是 AI 回复的 JSON 原文。
// 覆盖：R 记录（单楼 / 分段 / 批量 + 关键词登记 + 截断）｜U 总览渲染（空态 / 有记录 / 折叠内容 / 来源与范围）。
// 运行：node tests/unit/overview-last-extract.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setLastMessageId } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import { analyzeFloor, analyzeSegment, runAutoSummary, lastExtractRecord, LAST_EXTRACT_TEXT_CAP } from '../../host/extract.js';
import { parallelLastKeywords } from '../../core/parallel.js';
import { openPanel, panelBodyHtml, setPanelHooks2, panelState } from '../../ui/panel.js';
import { pushMemoryInject, readInject } from '../../host/inject.js';

const R = makeReporter('overview-last-extract v2.59.0 总览「最后一次提取」');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
const host = makeHost({});
installGlobalHost(host, doc);
setKernelState(emptyState());
setScopeKey('char:last-extract-test');

/** 造一小段聊天 + 一条带关键词的情节（让本地关键词抽取有料可抽） */
function seed(text, id) {
    setKernelState(emptyState());
    state.atoms = [{ id: 'kw-' + id, text: '甲有铜钥匙。', date: '1919-11-01', floorStart: 0, floorEnd: 0, tags: [], keywords: ['木箱', '账册'], validity: 'active' }];
    state.processedFloors = [];
    host.ctx.chat = [{ is_user: true, mes: '你好', name: 'User' }, { is_user: false, mes: String(text), name: '角色甲' }];
    setLastMessageId(1);
}
const AI_DELTA = { atoms: { add: [{ id: 'new-a1', text: '甲打开木箱取出账册。', floorStart: 1, floorEnd: 1 }] }, memories: { add: [{ id: 'new-m1', owner: '甲', title: '账册', content: '记录转运。' }] } };

// ---- R 组：记录写入 ----
await (async () => {
    setKernelState(emptyState());
    A('R1 无提取记录时返回 null（总览据此显示空态）', lastExtractRecord() === null, J(lastExtractRecord()));
    setPanelHooks2({ lastExtract: () => lastExtractRecord(), busy: () => false, batchProgress: () => ({}) });
    openPanel('overview');
    const emptyHtml0 = panelBodyHtml('overview');
    A('R1b 无记录时总览仍渲染该组件并给出空态说明（不是「什么都没有」）', emptyHtml0.indexOf('data-ftt-last-extract') >= 0
        && emptyHtml0.indexOf('📤 最后一次提取') >= 0 && emptyHtml0.indexOf('尚无提取记录') >= 0,
        '见断言');
    setPanelHooks2({});

    seed('甲打开木箱取出账册，仓库里堆着货箱。', '1');
    const r = await analyzeFloor(1, { ai: async () => ({ ok: true, text: JSON.stringify(AI_DELTA) }) });
    const rec = lastExtractRecord();
    A('R2 单楼分析 → 记录来源/楼层/新增/维度/字数/AI 回复正文（关键词由本地抽取）', r.ok === true && !!rec
        && rec.via === 'floor' && rec.trigger === 'manual' && rec.floors === '1'
        && rec.added >= 1 && rec.total >= 1 && rec.chars > 0
        && J(rec.dims) === J(['atoms', 'memories'])
        && rec.text.indexOf('new-a1') >= 0
        && J(rec.keywords) === J(['木箱', '账册']),
        J({ ok: r.ok, rec: rec && { via: rec.via, added: rec.added, dims: rec.dims, keywords: rec.keywords } }));

    A('R3 关键词同步登记到推演模块（V1 `lastExtractKeywords` 同源）', J(parallelLastKeywords()) === J(['木箱', '账册']), J(parallelLastKeywords()));

    seed('甲打开木箱取出账册。', '2');
    const seg = await analyzeSegment(1, 2, { ai: async () => ({ ok: true, text: JSON.stringify(AI_DELTA) }), trigger: 'manual' });
    const rec2 = lastExtractRecord();
    A('R4 分段分析 → 记录 via=segment 与楼层范围 a-b', seg.ok === true && rec2.via === 'segment'
        && rec2.floors === '1-2' && rec2.added >= 1 && rec2.text.indexOf('new-a1') >= 0,
        J({ ok: seg.ok, via: rec2.via, floors: rec2.floors }));

    seed('甲打开木箱取出账册。', '3');
    const batch = await runAutoSummary({ ai: async () => ({ ok: true, text: JSON.stringify(AI_DELTA) }), limit: 2 });
    const rec3 = lastExtractRecord();
    A('R5 批量摘要 → 汇总记录（via=batch、段数、新增、楼层范围）且保留最后一段的 AI 回复', batch.ok === true
        && rec3.via === 'batch' && rec3.segments >= 1 && rec3.floors.indexOf('-') > 0
        && rec3.added >= 1 && rec3.text.indexOf('new-a1') >= 0,
        J({ ok: batch.ok, via: rec3.via, segments: rec3.segments, floors: rec3.floors, added: rec3.added }));

    seed('甲打开木箱取出账册。', '4');
    const longText = JSON.stringify(AI_DELTA) + 'x'.repeat(LAST_EXTRACT_TEXT_CAP + 500);
    await analyzeFloor(1, { ai: async () => ({ ok: true, text: longText }) });
    const rec4 = lastExtractRecord();
    A('R6 AI 回复正文按上限截断（默认 4000 字），记录体量可控', rec4.text.length === LAST_EXTRACT_TEXT_CAP
        && rec4.chars === longText.length && LAST_EXTRACT_TEXT_CAP === 4000,
        J({ len: rec4.text.length, chars: rec4.chars }));

    seed('甲打开木箱取出账册。', '5');
    const fail = await analyzeFloor(1, { ai: async () => ({ ok: false, error: 'boom' }) });
    const rec5 = lastExtractRecord();
    A('R7 失败不覆盖成功记录（记录只反映**最后一次成功提取**）', fail.ok === false && !!rec5 && rec5.added >= 1 && rec5.via === 'floor',
        J({ fail: fail.ok, rec: rec5 && rec5.via }));
    const recCopy = lastExtractRecord();
    recCopy.added = 999;
    A('R8 记录为只读快照（调用方改不动内部态）', lastExtractRecord().added !== 999, J(lastExtractRecord().added));
})();

// ---- U 组：总览渲染 ----
await (async () => {
    seed('甲打开木箱取出账册，仓库里堆着货箱。', '6');
    setPanelHooks2({ lastExtract: () => lastExtractRecord(), busy: () => false, batchProgress: () => ({}), injectText: () => readInject() });
    openPanel('overview');
    await analyzeFloor(1, { ai: async () => ({ ok: true, text: JSON.stringify(AI_DELTA) }) });
    // v2.75.0：折叠块展示的是**注入内容** → 先按开关推一次注入（注入开关 = injectCurrentPrompt）
    cfg.injectCurrentPrompt = true;
    await pushMemoryInject({});
    openPanel('overview');
    const h = panelBodyHtml('overview');
    const line = (h.match(/data-ftt-last-extract-line>([^<]*)</) || [])[1] || '';
    A('U2 有记录 → 一行给出「时间 · 来源（手动/自动）· 楼层 · 新增 N 条 · AI 字数 · 维度 · 关键词」', h.indexOf('📤 最后一次提取') >= 0
        && /单楼分析（手动）/.test(line) && line.indexOf('第 1 楼') > 0 && /新增 \d+ 条/.test(line)
        && line.indexOf('AI ') > 0 && line.indexOf('atoms/memories') > 0 && line.indexOf('🔑 木箱、账册') > 0,
        J(line));

    A('U3 折叠块展示**注入内容**（v2.75.0）：默认收起，点开是当前注入给 AI 的正文，而不是 AI 回复的 JSON', (() => {
        const inj = readInject();
        return h.indexOf('ftt-hint-details') >= 0
            && h.indexOf('查看注入内容（当前注入给 AI 的正文，' + inj.length + ' 字）') >= 0
            && h.indexOf('data-ftt-inject-preview') >= 0
            && inj.indexOf('【FTT记忆注入】') === 0 && h.indexOf(inj.slice(0, 24).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')) >= 0
            && h.indexOf('new-a1') < 0 && h.indexOf('&quot;atoms&quot;') < 0;
    })(), J({ inj: readInject().length }));

    A('U4 v2.66.0：组件移到总览**最末端**（时钟 → 管线 → 注入 → 工具行 → 统计 → 未摘要/已处理 → 最后一次提取）', (() => {
        const at = (s) => h.indexOf(s);
        return at('data-ftt-inject') > 0 && at('ftt-summary-btn') > at('data-ftt-inject')
            && at('data-ftt-last-extract') > at('ftt-summary-btn')
            && at('data-ftt-last-extract') > at('⏳ 未摘要') && at('data-ftt-last-extract') > at('✅ 已处理')
            && at('data-ftt-last-extract') > at('📚 共 ');
    })(), '见断言');

    A('U4b 无注入时如实说明原因（注入开关关闭 / 未命中 / 空库），不展示 AI JSON', (() => {
        const hooks = { lastExtract: () => lastExtractRecord(), busy: () => false, batchProgress: () => ({}), injectText: () => '' };
        setPanelHooks2(hooks);
        openPanel('overview');
        const h2 = panelBodyHtml('overview');
        return h2.indexOf('查看注入内容') >= 0 && h2.indexOf('当前没有注入内容') >= 0
            && h2.indexOf('data-ftt-inject-preview') >= 0 && h2.indexOf('new-a1') < 0;
    })(), '见断言');

    A('U5 与注入概览是两个组件（不合并、不互相覆盖）', h.indexOf('data-ftt-inject') >= 0 && h.indexOf('data-ftt-last-extract') >= 0
        && h.indexOf('🧷 注入 ') >= 0 && h.indexOf('📤 最后一次提取') >= 0,
        '见断言');

    setPanelHooks2({ lastExtract: () => ({ at: Date.now() - 60000, via: 'batch', trigger: 'auto', floors: '20-29', made: 3, segments: 3, added: 7, chars: 2400, dims: ['atoms'], keywords: ['码头'], text: '{}' }) });
    openPanel('overview');
    const h2 = panelBodyHtml('overview');
    const line2 = (h2.match(/data-ftt-last-extract-line>([^<]*)</) || [])[1] || '';
    A('U6 批量自动提取的文案：批量摘要（自动）· 第 20-29 楼 · 3 段 · 新增 7 条 · AI 2.4k 字', /批量摘要（自动）/.test(line2)
        && line2.indexOf('第 20-29 楼') > 0 && line2.indexOf('3 段') > 0 && line2.indexOf('新增 7 条') > 0
        && line2.indexOf('AI 2.4k 字') > 0,
        J(line2));
})();

setPanelHooks2({});
A('U7 面板态无副作用：`panelState()` 仍可读（组件不引入新的面板态字段）', typeof panelState().tab === 'string', J(panelState().tab));

R.done();
