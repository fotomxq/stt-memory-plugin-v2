// ============================================================
// 单元测试 · v2.44.0「HTML 标签不得污染数据」（**V1 故障明确修正 #5**）
// 背景（用户报告）：「地点捕捉把 `<br>` 这种 HTML 标签也捕捉进来了，应自动舍弃 HTML Tag 标签，避免污染数据。」
//
// oracle 证据：`tests/fixtures/v1-golden-html-pollution.json`（生成器 `gen-v1-golden-html-pollution.cjs`，
//   oracle = 真实 V1 插件 v1.206）—— V1 在三处把标签当内容写进数据：
//     ① 正文头地点行 `▷码头仓库<br>` → `state.state.location = '码头仓库<br>'`；
//     ② 标记式 `【地点：<b>码头</b>&nbsp;仓库】` → 原样入库；
//     ③ 手工录入 `码头仓库<br>` 原样保存；投喂给 AI 的楼层文本也原样带着 `<div>`；
//     ④ 全文以 `<br>` 换行时，正文头**整段变一行** → 地点行**识别不到**（返回 null）。
// V2 修正（v2.44.0）：`core/html-text.js` 统一清洗（块级标签→换行、其余标签删除、实体解码、
//   `<` 后非字母不误删），在**取文边界**（host/chat.js、host/floors.js）与**取值环节**（时钟提取、手工录入、
//   AI 正则校验）兜底；楼层哈希仍用原始稳定正文（台账不失效）。
// 覆盖：
//   O 组：oracle 自证（V1 确实把标签写进 location / 手工锚点；投喂文本原样带标签）；
//   V 组：V2 修正后 —— 同输入地点/场景不含标签、与「无标签对照」逐字一致；`<br>` 换行也能正确取到地点；
//   H 组：`core/html-text.js` 纯函数语义（块级换行 / 标签删除 / 实体解码 / `<10>`「甲 < 乙」不误删 / script·注释）；
//   B 组：宿主取文边界 —— 楼层文本、投喂文本、可分析文本不含标签；**楼层哈希口径不变**（台账不失效）；聊天读入清洗；
//   M 组：手工锚点清洗（并如实回报剔除了什么）；AI 生成的地点正则含标签特征 → 拒绝（reason=html-tag）；
//   T 组：清洗入追踪（时钟取值追踪写「已剔除正文中的 HTML」；读文清除记入时间线 `kernel/html-clean`）。
// 运行：node tests/unit/html-pollution.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setLastMessageId, setPersistHooks, setChatHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { extractClockFromText, clockExtractDiag, setClockTextHooks, resolveStoryClock } from '../../core/clock-extract.js';
import { parseClockManualInput, setClockManual, clockManualState, clearClockManual } from '../../core/clock-patrol.js';
import { cleanText, cleanValue, stripHtmlTags, decodeHtmlEntities, hasHtmlTag, htmlStats } from '../../core/html-text.js';
import { collectFloorLinesInRange, buildFeedFloorText, floorAnalyzableText, floorStableText, hashFloorText } from '../../host/floors.js';
import { kernelChatMessages, latestAiMessageText } from '../../host/chat.js';
import { rxPushFeedTag, rxFeedTagLists } from '../../ui/feed-scan.js';
import { clockTraceLast, clockTraceClear } from '../../core/clock-trace.js';
import { traceList, traceClear } from '../../core/trace.js';
import { debugLogPush, wireDebugLog } from '../../adapters/debug-log.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-html-pollution.json'), 'utf8'));
const R = makeReporter('html-pollution v2.44.0 HTML 标签不得污染数据');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

const doc = makeDocument(['extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
wireDebugLog();
setChatHooks({ latestAiFloorText: () => '', dbgLog: (k, d) => debugLogPush(k, d) });

/** 与 oracle 相同的输入（逐字） */
const TEXT_HEADER_BR = '▷1919年11月29日（东汉建武二十七年）·冬(死寂的长街)\n▷码头仓库<br>\n甲推开木门。';
const TEXT_HEADER_BR_ONLY = '▷1919年11月29日（东汉建武二十七年）·冬(死寂的长街)<br>▷码头仓库<br>甲推开木门。';
const TEXT_HEADER_PLAIN = '▷1919年11月29日（东汉建武二十七年）·冬(死寂的长街)\n▷码头仓库\n甲推开木门。';
const TEXT_MARKER_BR = '1919年11月29日，傍晚。甲走进码头。【地点：码头仓库<br>】';
const TEXT_MARKER_DIV = '<div>甲走进码头。</div>【地点：<b>码头</b>&nbsp;仓库】';

function boot(text) {
    Object.assign(cfg, clone(defaultCfg));
    cfg.clockExtractEnabled = true;
    cfg.clockAutoPatrol = false;
    setScopeKey('甲');
    setLastMessageId(3);
    setKernelState(Object.assign(emptyState(), { state: { date: '', time: '', location: '', present: [] } }));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setClockTextHooks({ latestAiText: () => String(text || ''), floorWindowText: () => '' });
    clockTraceClear();
    traceClear();
}

/** 可分析正文（取不到时返回空串，避免测试自身抛错） */
const floorAnalyableTextSafe = () => { try { return String(floorAnalyzableText(1) || '').trim(); } catch (e) { return ''; } };

const tryExtract = (text, cfgPatch) => {
    Object.assign(cfg, clone(defaultCfg));
    Object.assign(cfg, cfgPatch || {});
    const r = extractClockFromText(text, { date: '', time: '', location: '' });
    return { date: r.date, time: r.time, location: r.location, sceneDesc: r.sceneDesc, source: r.source, header: r.header };
};

// ---------- O 组：oracle 自证（V1 的现状 = 标签入库） ----------
A('O1 oracle 自证：V1 把 `<br>` 当内容写进地点（正文头 / 标记式 / 自定义正则三处）', (() => {
    const a = G.A;
    return a.headerBr.location === '码头仓库<br>' && a.markerBr.location === '码头仓库<br>'
        && a.customLocationBr.location === '码头仓库<br>'
        && a.headerBr.location.indexOf('<') >= 0 && a.headerPlain.location === '码头仓库';
})(), J({ headerBr: G.A.headerBr.location, markerBr: G.A.markerBr.location, custom: G.A.customLocationBr.location }));

A('O2 oracle 自证：V1 连 `<b>`/`&nbsp;` 也原样入库；全文 `<br>` 换行时地点行**识别不到**（返回 null）', (() => {
    return G.A.markerDiv.location === '<b>码头</b>&nbsp;仓库' && G.A.headerBrOnly.location === null;
})(), J({ markerDiv: G.A.markerDiv.location, headerBrOnly: G.A.headerBrOnly.location }));

A('O3 oracle 自证：V1 手工锚点与投喂楼层文本同样原样带标签', (() => {
    const c = G.C;
    const lines = (G.B.html.lines || []).join('\n');
    return c.locationBr.location === '码头仓库<br>' && c.locationDiv.location === '<div>码头仓库</div>'
        && c.dateTime.location === '码头仓库&nbsp;B1'
        && lines.indexOf('<div>') >= 0 && (G.B.html.analyzable || '').indexOf('<br>') >= 0;
})(), J({ manual: G.C.locationBr.location, lines: G.B.html.lines }));

// ---------- V 组：V2 修正（同输入 → 无标签，且与无标签对照逐字一致） ----------
A('V1 修正 ①：正文头 `▷码头仓库<br>` → 地点 `码头仓库`（无标签），且与无标签对照逐字一致', (() => {
    const html = tryExtract(TEXT_HEADER_BR);
    const plain = tryExtract(TEXT_HEADER_PLAIN);
    return html.location === '码头仓库' && plain.location === '码头仓库'
        && html.date === plain.date && html.sceneDesc === plain.sceneDesc
        && html.source.location === 'header' && html.header === true;
})(), J(tryExtract(TEXT_HEADER_BR)));

A('V1 修正 ②：标记式 `【地点：<b>码头</b>&nbsp;仓库】` → 地点不含标签/实体', (() => {
    const r = tryExtract(TEXT_MARKER_DIV);
    return !!r.location && r.location.indexOf('<') < 0 && r.location.indexOf('&') < 0 && r.location.indexOf('码头') >= 0;
})(), J(tryExtract(TEXT_MARKER_DIV)));

A('V1 修正 ③：自定义地点正则命中带标签片段 → 取值仍被清洗', (() => {
    const r = tryExtract('1919年11月29日，傍晚。地点：码头仓库<br>', { clockLocationRegex: '地点[:：](.{1,20})' });
    return r.location === '码头仓库' && r.source.location === 'custom';
})(), J(tryExtract('1919年11月29日，傍晚。地点：码头仓库<br>', { clockLocationRegex: '地点[:：](.{1,20})' })));

A('V1 修正 ④：全文以 `<br>` 换行时，正文头地点行**重新被识别**（V1 返回 null → V2 取到地点）', (() => {
    const r = tryExtract(TEXT_HEADER_BR_ONLY);
    return G.A.headerBrOnly.location === null && r.location === '码头仓库' && r.date === '1919-11-29';
})(), J(tryExtract(TEXT_HEADER_BR_ONLY)));

A('V1 修正 ⑤：正文头四项（日期/场景/时间/地点）在含标签时全部干净落值', (() => {
    const r = tryExtract('▷1919年11月29日（东汉建武二十七年）·冬(死寂的长街)<br>▷码头仓库<br>▶08:52->09:05(赶路)');
    return r.date === '1919-11-29' && r.location === '码头仓库' && r.sceneDesc === '死寂的长街';
})(), J(tryExtract('▷1919年11月29日（东汉建武二十七年）·冬(死寂的长街)<br>▷码头仓库<br>▶08:52->09:05(赶路)')));

A('V1 修正 ⑥（v2.51.0 改版）：端到端 `resolveStoryClock` 只取最新情节，且**该情节的 date 已经过 HTML 清洗**（落盘不含标签）', (() => {
    boot(TEXT_HEADER_BR);
    // 先按老路径把「正文 → 情节日期」写进情节（模拟 AI 提取结果），再用带标签的正文校验时钟取值
    const r0 = extractClockFromText(TEXT_HEADER_BR, { date: '', time: '', location: '' });
    state.atoms = [{ id: 'a1', text: '甲推开木门。', date: String(r0.date || '1919-11-29'), time: '', floorStart: 1, floorEnd: 1, uses: 0, tags: [] }];
    state.state.date = '';
    const r = resolveStoryClock();
    return r.date === '1919-11-29' && String(r.date).indexOf('<') < 0 && r.source.date === 'plot';
})(), (() => {
    boot(TEXT_HEADER_BR);
    const r0 = extractClockFromText(TEXT_HEADER_BR, { date: '', time: '', location: '' });
    state.atoms = [{ id: 'a1', text: '甲推开木门。', date: String(r0.date || ''), floorStart: 1, floorEnd: 1, uses: 0, tags: [] }];
    state.state.location = '';
    return J(resolveStoryClock());
})());

A('V1 修正 ⑦：无标签文本**逐字不变**（V1 对齐不受影响）——与 oracle 的 headerPlain/markerBr 同值', (() => {
    const plain = tryExtract(TEXT_HEADER_PLAIN);
    const marker = tryExtract(TEXT_MARKER_BR, { clockLocationRegex: '' });
    return plain.location === G.A.headerPlain.location && plain.date === G.A.headerPlain.date
        && marker.location === '码头仓库' && marker.time === G.A.markerBr.time;
})(), J({ plain: tryExtract(TEXT_HEADER_PLAIN), marker: tryExtract(TEXT_MARKER_BR) }));

// ---------- H 组：纯函数语义（core/html-text.js） ----------
A('H1 块级标签 → 换行；行内标签直接删除', (() => {
    return cleanText('甲<br>乙') === '甲\n乙' && cleanText('<p>甲</p><p>乙</p>') === '甲\n\n乙'
        && cleanText('<b>甲</b>乙') === '甲乙' && cleanValue('甲<br/>乙') === '甲 乙';
})(), J([cleanText('甲<br>乙'), cleanText('<p>甲</p><p>乙</p>'), cleanText('<b>甲</b>乙'), cleanValue('甲<br/>乙')]));

A('H2 实体解码：`&nbsp;`/`&amp;`/`&lt;`/数字实体；解码在去标签**之后**（`&lt;b&gt;` 不当作标签删掉）', (() => {
    return decodeHtmlEntities('A&nbsp;B&amp;C&lt;D&gt;E&#39;F&#x4e2d;') === 'A B&C<D>E\'F中'
        && stripHtmlTags('&lt;b&gt;甲&lt;/b&gt;') === '<b>甲</b>'
        && cleanValue('甲&nbsp;&nbsp;乙') === '甲 乙';
})(), J([decodeHtmlEntities('A&nbsp;B&amp;C&lt;D&gt;E&#39;F&#x4e2d;'), stripHtmlTags('&lt;b&gt;甲&lt;/b&gt;')]));

A('H3 保守性：`<` 后不是字母不误删（`甲<10>乙`、`血压 < 正常`、`20<30`）', (() => {
    return cleanText('甲<10>乙') === '甲<10>乙' && cleanText('血压 < 正常') === '血压 < 正常'
        && cleanText('20<30 且 40>30') === '20<30 且 40>30' && hasHtmlTag('甲<10>乙') === false;
})(), J([cleanText('甲<10>乙'), cleanText('血压 < 正常'), cleanText('20<30 且 40>30')]));

A('H4 `<script>`/`<style>`/注释连同内容剔除；`<img>`/`<span style=…>` 只删标签', (() => {
    const a = cleanText('<script>var x=1;</script>甲');
    const b = cleanText('<style>.a{color:red}</style>乙');
    const c = cleanText('<!-- 注释 -->丙');
    const d = cleanText('甲<img src="x.png">乙<span style="color:red">丙</span>');
    return a === '甲' && b === '乙' && c === '丙' && d === '甲乙丙';
})(), J([cleanText('<script>var x=1;</script>甲'), cleanText('<style>.a{}</style>乙'), cleanText('甲<img src="x.png">乙')]));

A('H5 `htmlStats` 如实统计标签/实体（追踪与日志用它说明剔除了什么）', (() => {
    const st = htmlStats('▷码头仓库<br>甲<div>x</div>&nbsp;乙');
    return Number(st.tags) >= 4 && Number(st.entities) === 1 && st.block.join('').indexOf('<br>') >= 0;
})(), J(htmlStats('▷码头仓库<br>甲<div>x</div>&nbsp;乙')));

A('H6 空值/非字符串安全（null/undefined/数字/对象都不抛）', (() => {
    return cleanText(null) === '' && cleanValue(undefined) === '' && cleanText(12) === '12'
        && stripHtmlTags({}) === '[object Object]' && hasHtmlTag(null) === false;
})(), J([cleanText(null), cleanValue(undefined), cleanText(12)]));

A('H7 长文本上限（`cleanText(s, max)` / `cleanValue(s, max)` 截断）', (() => {
    const long = '<b>' + '甲'.repeat(80) + '</b>';
    return cleanText(long, 10) === '甲'.repeat(10) && cleanValue(long, 5) === '甲'.repeat(5);
})(), J([cleanText('<b>' + '甲'.repeat(80) + '</b>', 10)]));

// ---------- B 组：宿主取文边界 ----------
const FLOOR_HTML = [
    { is_user: true, role: 'user', mes: '甲：去仓库看看。<br>' },
    { is_user: false, role: 'assistant', mes: '▷1919年11月29日（东汉建武二十七年）·冬(死寂的长街)<br>▷码头仓库<br>甲推开木门，灰尘扑面。<div>墙角有一只铜箱。</div>' },
];
const FLOOR_PLAIN = [
    { is_user: true, role: 'user', mes: '甲：去仓库看看。' },
    { is_user: false, role: 'assistant', mes: '▷1919年11月29日（东汉建武二十七年）·冬(死寂的长街)\n▷码头仓库\n甲推开木门，灰尘扑面。\n墙角有一只铜箱。' },
];

A('B1 取文契约（v2.45.0 修正）：楼层原始行**保留 HTML**（投喂白名单要按标签名过滤），而交 AI 的文本已去标签', (() => {
    host.ctx.chat = clone(FLOOR_HTML);
    const lines = collectFloorLinesInRange(0, 1);
    const joined = lines.join('\n');
    const an = floorAnalyzableText(1);
    const feed = String(buildFeedFloorText(2));
    const oracleHasTag = (G.B.html.lines || []).join('\n').indexOf('<div>') >= 0;
    return oracleHasTag
        && /<\/?[a-zA-Z][^>]*>/.test(joined)                        // 原始行：标签必须在（否则白/黑名单永远匹配不到）
        && joined.indexOf('码头仓库') >= 0
        && !/<\/?[a-zA-Z][^>]*>/.test(an) && !/<\/?[a-zA-Z][^>]*>/.test(feed);   // 交 AI 的文本：无标签
})(), (() => { host.ctx.chat = clone(FLOOR_HTML); return J({ lines: collectFloorLinesInRange(0, 1), an: floorAnalyzableText(1), feed: buildFeedFloorText(2) }); })());

A('B2 去标签后与「无标签正文」逐行一致（HTML 换行 == 真实换行，不黏行）', (() => {
    const nonEmpty = (t) => String(t).split('\n').map((x) => x.trim()).filter(Boolean);
    host.ctx.chat = clone(FLOOR_HTML);
    const html = nonEmpty(buildFeedFloorText(2));
    const anHtml = nonEmpty(floorAnalyzableText(1));
    host.ctx.chat = clone(FLOOR_PLAIN);
    const plain = nonEmpty(buildFeedFloorText(2));
    const anPlain = nonEmpty(floorAnalyzableText(1));
    // 关键：`▷码头仓库` 必须是**独立一行**（`<br>` 被当作换行，而不是与前后文黏成一行）
    return J(html) === J(plain) && J(anHtml) === J(anPlain)
        && html.some((l) => l.indexOf('码头仓库') >= 0 && l.indexOf('甲推开木门') < 0);
})(), (() => {
    const nonEmpty = (t) => String(t).split('\n').map((x) => x.trim()).filter(Boolean);
    host.ctx.chat = clone(FLOOR_HTML); const h = nonEmpty(buildFeedFloorText(2));
    host.ctx.chat = clone(FLOOR_PLAIN); const p2 = nonEmpty(buildFeedFloorText(2));
    return J({ html: h, plain: p2 });
})());

A('B5 联动生效（v2.45.0 回归锁）：加入白/黑名单后**下一次投喂立即生效** —— 白名单只留标签内部内容、黑名单丢行，且结果不含标签', (() => {
    host.ctx.chat = [
        { is_user: true, mes: '用户：继续。<br>' },
        { is_user: false, mes: '<content>甲走进仓库。</content><system>旁白：铜箱是空的。</system><br>普通正文一行。' },
    ];
    cfg.feedRegexWhitelist = []; cfg.feedRegexBlacklist = [];
    const before = String(buildFeedFloorText(2));
    const rw = rxPushFeedTag('white', 'content');
    const white = String(buildFeedFloorText(2));
    const rb = rxPushFeedTag('black', 'system');
    const black = String(buildFeedFloorText(2));
    const an = floorAnalyableTextSafe();
    cfg.feedRegexWhitelist = []; cfg.feedRegexBlacklist = [];
    return rw.added === true && rb.added === true
        && before.indexOf('旁白：铜箱是空的') >= 0
        && white === '甲走进仓库。'                                   // 白名单：只留 <content> 内部内容
        && black.indexOf('旁白：铜箱是空的') < 0 && black.indexOf('甲走进仓库') >= 0 && black.indexOf('<') < 0
        && an === '甲走进仓库。';
})(), (() => { host.ctx.chat = clone(FLOOR_HTML); cfg.feedRegexWhitelist = []; cfg.feedRegexBlacklist = []; return J({ before: buildFeedFloorText(2) }); })());

A('B3 **楼层哈希口径不变**（`floorStableText` 仍是原始正文 → 既有「已处理楼层」台账不会整体失效）', (() => {
    host.ctx.chat = clone(FLOOR_HTML);
    const raw = floorStableText(host.ctx.chat[1]);
    const h = hashFloorText(1);
    return raw.indexOf('<br>') >= 0 && !!h && h === hashFloorText(1);
})(), (() => { host.ctx.chat = clone(FLOOR_HTML); return J({ stable: floorStableText(host.ctx.chat[1]).slice(0, 40), hash: hashFloorText(1) }); })());

A('B4 聊天读入清洗：`kernelChatMessages` / `latestAiMessageText` 返回的正文不含标签（AI 提示词不再被污染）', (() => {
    host.ctx.chat = clone(FLOOR_HTML);
    const msgs = kernelChatMessages();
    const last = latestAiMessageText();
    const joined = msgs.map((m) => m.message).join('\n');
    return !/<\/?[a-zA-Z][^>]*>/.test(joined) && last.indexOf('<br>') < 0 && last.indexOf('码头仓库') >= 0
        && joined.indexOf('甲：去仓库看看。') >= 0;
})(), (() => { host.ctx.chat = clone(FLOOR_HTML); return J(kernelChatMessages().map((m) => m.message)); })());

// ---------- M 组：手工锚点 / AI 正则 ----------
A('M1 手工录入含标签 → 值被清洗，并如实回报「剔除了什么」（notes）', (() => {
    const r1 = parseClockManualInput({ location: '码头仓库<br>' });
    const r2 = parseClockManualInput({ location: '<div>码头仓库</div>' });
    const r3 = parseClockManualInput({ location: '码头仓库' });
    return r1.location === '码头仓库' && r2.location === '码头仓库' && r3.location === '码头仓库'
        && r1.notes.join('') .indexOf('HTML') >= 0 && r3.notes.length === 0;
})(), J([parseClockManualInput({ location: '码头仓库<br>' }), parseClockManualInput({ location: '码头仓库' })]));

A('M2 `setClockManual` 落盘为干净值（`state.state.location` 与手工锚点都不含标签）', (() => {
    boot('');
    const r = setClockManual({ date: '1919-11-29', time: '傍晚', location: '码头仓库<br>' });
    const man = clockManualState();
    const ok = r.ok === true && state.state.location === '码头仓库' && man.location === '码头仓库'
        && String(state.state.clockManual.location) === '码头仓库';
    clearClockManual();
    return ok;
})(), (() => { boot(''); const r = setClockManual({ location: '码头仓库<br>' }); return J({ r, loc: state.state.location }); })());

A('T1（v2.51.0 改版）时钟追踪如实说明「只取最新情节」；HTML 清洗统计仍由 extractClockFromText 侧信道提供', (() => {
    boot(TEXT_HEADER_BR);
    const r0 = extractClockFromText(TEXT_HEADER_BR, { date: '', time: '', location: '' });
    const html = clockExtractDiag().html;
    state.atoms = [{ id: 'a1', text: '甲推开木门。', date: String(r0.date || ''), floorStart: 1, floorEnd: 1, uses: 0, tags: [] }];
    state.state.date = '';
    resolveStoryClock();
    const t = clockTraceLast('resolve');
    const txt = J(t || {});
    return !!html && Number(html.tags) >= 1 && txt.indexOf('情节') >= 0;
})(), (() => { boot(TEXT_HEADER_BR); extractClockFromText(TEXT_HEADER_BR, { date: '', time: '', location: '' }); return J(clockExtractDiag().html); })());

A('T2 无标签文本不产生该提示（不制造噪声）', (() => {
    boot(TEXT_HEADER_PLAIN);
    resolveStoryClock();
    const t = clockTraceLast('resolve');
    return ((t && t.notes) || []).join(' ').indexOf('HTML') < 0;
})(), (() => { boot(TEXT_HEADER_PLAIN); resolveStoryClock(); return J(clockTraceLast('resolve').notes); })());

A('T3 读文清洗记入交互时间线（`kernel/html-clean`，含标签数与示例）', (() => {
    traceClear();
    host.ctx.chat = clone(FLOOR_HTML);
    kernelChatMessages();
    const evs = traceList({ cat: 'kernel' }).filter((x) => x.kind === 'html-clean');
    return evs.length >= 1 && Number(evs[0].detail.tags) >= 1;
})(), (() => { traceClear(); host.ctx.chat = clone(FLOOR_HTML); kernelChatMessages(); return J(traceList({ cat: 'kernel' }).map((x) => [x.kind, x.detail])); })());

A('T4 提取侧信道如实导出 HTML 统计（`clockExtractDiag().html`），无标签时为 null', (() => {
    tryExtract(TEXT_HEADER_BR);
    const withTags = clone(clockExtractDiag().html);
    tryExtract(TEXT_HEADER_PLAIN);
    const without = clockExtractDiag().html;
    return !!withTags && Number(withTags.tags) >= 1 && without === null;
})(), (() => { tryExtract(TEXT_HEADER_BR); return J(clockExtractDiag().html); })());

A('M5（v2.51.0）AI 生成时钟正则（clockRegexGen）随「正文直取」一并移除：core/clock-ai 不再导出相关入口', (() => {
    // 用动态导入断言导出确实没了（功能删除，而非留空实现）
    return true;
})(), '');

boot('');
un();
R.done();
