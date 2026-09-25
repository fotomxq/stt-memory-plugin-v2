// ============================================================
// 单元测试 · v2.45.0「投喂白/黑名单的按钮与联动」修复（用户报告）
// 背景（用户原话）：「投喂标签自动分析存在BUG，请核对加入白名单、黑名单的按钮功能，以及是否联动生效等细节。」
//
// 定位结论（三段）：
//   ① **按钮本身没错**：`rxPushFeedTag` 与 V1 逐字一致（排重/大小写/`n` 计数/`other` 提示），
//      面板委托把 `data-ftt-kind`/`data-ftt-tag` 正确透传（v2.41.0 修过入参透传），文本域 change 会整表排重。
//   ② **真缺陷（v2.44.0 引入，v2.45.0 修复）**：v2.44.0「HTML 标签不得污染数据」把去标签放在了
//      **投喂过滤之前**（`host/floors.js#collectFloorLinesInRange` 直接清洗）→ `applyFeedRegex` 的白名单
//      「按标签名提取 `<content>…</content>`」与黑名单「按行匹配标签」**永远匹配不到** →
//      点「＋白 / ＋黑」后**不联动生效**（投喂文本与不过滤时一模一样），是本批用户报告的直接原因。
//      修复：取文保留标签 → `applyFeedRegex` 过滤 → 再 `cleanText` 去掉标签交 AI。
//   ③ **同时暴露的第二个真缺陷**：白名单存在但整楼无标签时，V1 会**回退原文**（并写调试日志），
//      该回退在 v2.44.0 期间返回的是「已去标签的原文」—— 修复后回退仍成立，且输出仍去标签（不再把 `<br>` 带给 AI）。
//
// oracle：`tests/fixtures/v1-golden-feed-filter.json`（生成器 `gen-v1-golden-feed-filter.cjs`，V1 v1.206，
//   每例独立实例经 `getChatMessages` 注入楼层；两次运行逐字节一致）。
// 覆盖：
//   G 组：与 V1 逐项比对（有名单 → **逐字一致**；无名单/白名单未命中 → V2 = V1 去掉 HTML，有意差异）；
//   L 组：**联动生效**（按钮/文本域改完，下一次投喂立即变化，无需重启或二次保存）；
//   B 组：真实点击委托下的 ＋白/＋黑（落库、提示、文本框可见、高亮、重复点击 dup、双侧同名提示）；
//   T 组：文本域 change 委托（整表排重 + 数组写回）、`isFeedTagKey` 判定；
//   E 组：边角（空标签、清空结果、无正文提示、黑名单全灭、HTML 与纯文本等价性）。
// 运行：node tests/unit/feed-tag-link.test.js
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setLastMessageId, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { buildFeedFloorText, buildFeedFloorTextRange, collectFloorLinesInRange, floorAnalyzableText } from '../../host/floors.js';
import { cleanText } from '../../core/html-text.js';
import {
    feedScanAction, rxPushFeedTag, rxFeedTagLists, rxDedupeTagList, isFeedTagKey,
    rxTagScanState, setRxTagScan, FEED_SCAN_ACTIONS,
} from '../../ui/feed-scan.js';
import { panelAction, panelBodyHtml, setPanelHooks2, openPanel, bindOverlay } from '../../ui/panel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-feed-filter.json'), 'utf8'));
const R = makeReporter('feed-tag-link v2.45.0 投喂白/黑名单按钮与联动');
const J = (v) => JSON.stringify(v);
const A = (n, c, e) => R.assert(n, !!c, e);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));
/** V1 输出 → 期望的 V2 输出：过滤结果取 V1，随后按 v2.44.0 约定去掉 HTML（`cleanText` 同一实现） */
const expectV2 = (v1Out) => cleanText(String(v1Out == null ? '' : v1Out));

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
const un = installGlobalHost(host, doc);
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

function boot(floors) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('甲');
    host.ctx.chat = clone(floors);
    setLastMessageId(Array.isArray(floors) ? floors.length - 1 : -1);
    setKernelState(emptyState());
    cfg.feedRegexWhitelist = [];
    cfg.feedRegexBlacklist = [];
    cfg.feedFloors = 10;
    return state0();
}
function state0() { return undefined; }

/** oracle 用例 → V2 侧输入 */
const FLOORS = G.floorSamples;

// ---------- G 组：与 V1 oracle 逐项比对 ----------
A('G1 oracle 自证：V1 在有名单时**确实按标签过滤生效**（白名单提取内部内容 / 黑名单丢行）', (() => {
    const pick = (n) => (G.cases.filter((c) => c.name === n)[0] || {}).out || {};
    return pick('白名单 content').feed === '甲走进仓库。'
        && pick('白名单 content + 黑名单 system').feed === '甲走进仓库。'
        && pick('仅黑名单 system').feed === '[第0楼 用户] 用户：继续。<br>'
        && pick('白名单大小写不敏感（CONTENT）').feed === '甲走进仓库。'
        && pick('白名单未命中（应回退原文）').feed.indexOf('<content>') >= 0;
})(), J(G.cases.map((c) => [c.name, c.out.feed.slice(0, 40)])));

A('G2 **联动修复**：V2 与 V1 的**过滤结果等价**（V2 = V1 去掉 HTML）—— 白名单提取 / 黑名单丢行 / 大小写不敏感全部生效', (() => {
    const bad = [];
    for (const c of G.cases) {
        boot(FLOORS[c.floors]);
        cfg.feedRegexWhitelist = c.white.slice();
        cfg.feedRegexBlacklist = c.black.slice();
        const feed = String(buildFeedFloorText(10));
        const range = String(buildFeedFloorTextRange(10, host.ctx.chat.length - 1));
        if (feed !== expectV2(c.out.feed)) bad.push([c.name, 'feed', feed, expectV2(c.out.feed)]);
        if (range !== expectV2(c.out.range)) bad.push([c.name, 'range', range, expectV2(c.out.range)]);
        if (/<\/?[a-zA-Z][^>]*>/.test(feed)) bad.push([c.name, '仍有标签', feed]);
    }
    return bad.length === 0;
})(), (() => {
    const out = [];
    for (const c of G.cases) {
        boot(FLOORS[c.floors]);
        cfg.feedRegexWhitelist = c.white.slice(); cfg.feedRegexBlacklist = c.black.slice();
        const v2 = String(buildFeedFloorText(10));
        if (v2 !== expectV2(c.out.feed)) out.push([c.name, v2, expectV2(c.out.feed)]);
    }
    return J(out);
})());

A('G2b 白名单**确实按标签名提取内部内容**（而不是回退「行内包含」）：V1 与该 V2 结果都不含标签、且等于内层文本', (() => {
    const c = G.cases.filter((x) => x.name === '白名单 content')[0];
    boot(FLOORS[c.floors]);
    cfg.feedRegexWhitelist = ['content'];
    const feed = String(buildFeedFloorText(10));
    return c.out.feed === '甲走进仓库。' && feed === c.out.feed && feed.indexOf('旁白') < 0;
})(), (() => { boot(FLOORS.HTML); cfg.feedRegexWhitelist = ['content']; return J(buildFeedFloorText(10)); })());

A('G3 **有意差异**（v2.44.0 目标）：无名单 / 白名单未命中时，V2 = V1 去掉 HTML（V1 原样把 `<br>` 交给 AI）', (() => {
    const bad = [];
    for (const name of ['无名单（HTML 楼层）', '白名单未命中（应回退原文）']) {
        const c = G.cases.filter((x) => x.name === name)[0];
        boot(FLOORS[c.floors]);
        cfg.feedRegexWhitelist = c.white.slice();
        cfg.feedRegexBlacklist = c.black.slice();
        const feed = String(buildFeedFloorText(10));
        if (feed !== expectV2(c.out.feed)) bad.push([name, feed, expectV2(c.out.feed)]);
        if (/<\/?[a-zA-Z][^>]*>/.test(feed)) bad.push([name, '仍有标签', feed]);
    }
    return bad.length === 0;
})(), (() => {
    const c = G.cases.filter((x) => x.name === '无名单（HTML 楼层）')[0];
    boot(FLOORS[c.floors]);
    return J({ v1: c.out.feed, v2: String(buildFeedFloorText(10)) });
})());

A('G4 纯文本楼层：V1 与 V2 逐字一致（清洗不得改动无标签文本）', (() => {
    const c = G.cases.filter((x) => x.name === '无名单（纯文本楼层）')[0];
    boot(FLOORS[c.floors]);
    return String(buildFeedFloorText(10)) === c.out.feed && String(buildFeedFloorTextRangeSafe(10)) === c.out.range;
})(), (() => {
    const c = G.cases.filter((x) => x.name === '无名单（纯文本楼层）')[0];
    boot(FLOORS[c.floors]);
    return J({ v1: c.out.feed, v2: String(buildFeedFloorText(10)) });
})());

/** 指定结束楼层的投喂文本（等价 `buildFeedFloorTextRange(10, last)`） */
function buildFeedFloorTextRangeSafe(n) {
    try { return buildFeedFloorTextRange(n, Number(host.ctx.chat.length) - 1); } catch (e) { return 'ERR:' + String(e.message); }
}

// ---------- L 组：联动生效（改完立即生效，不需重启/二次保存） ----------
A('L1 联动：点「＋白」后**下一次投喂立即只保留标签内容**（无需重启或额外保存）', (() => {
    boot(FLOORS.HTML);
    const before = String(buildFeedFloorText(10));
    const r = rxPushFeedTag('white', 'content');
    const after = String(buildFeedFloorText(10));
    return r.added === true && before.indexOf('旁白') >= 0 && before.indexOf('<') < 0 && after === '甲走进仓库。';
})(), (() => { boot(FLOORS.HTML); const b = String(buildFeedFloorText(10)); rxPushFeedTag('white', 'content'); return J({ before: b, after: String(buildFeedFloorText(10)) }); })());

A('L2 联动：再点「＋黑」后**该标签行被丢弃**；`floorAnalyzableText`（真正送 AI 的正文）同步生效', (() => {
    boot(FLOORS.HTML);
    rxPushFeedTag('black', 'system');
    const feedBlack = String(buildFeedFloorText(10));
    rxPushFeedTag('white', 'content');
    const feedBoth = String(buildFeedFloorText(10));
    const an = String(floorAnalyzableText(1) || '');
    return feedBlack.indexOf('旁白：铜箱是空的') < 0 && feedBlack.indexOf('用户：继续') >= 0
        && feedBoth === '甲走进仓库。' && an === '甲走进仓库。';
})(), (() => { boot(FLOORS.HTML); rxPushFeedTag('black', 'system'); const a = String(buildFeedFloorText(10)); rxPushFeedTag('white', 'content'); return J({ blackOnly: a, both: String(buildFeedFloorText(10)), analyzable: floorAnalyzableText(1) }); })());

A('L3 联动：清空名单后回到「不过滤（但仍去标签）」', (() => {
    boot(FLOORS.HTML);
    rxPushFeedTag('white', 'content');
    const filtered = String(buildFeedFloorText(10));
    cfg.feedRegexWhitelist = [];
    const unfiltered = String(buildFeedFloorText(10));
    return filtered === '甲走进仓库。' && unfiltered.indexOf('旁白') >= 0 && unfiltered.indexOf('<') < 0;
})(), (() => { boot(FLOORS.HTML); rxPushFeedTag('white', 'content'); const a = String(buildFeedFloorText(10)); cfg.feedRegexWhitelist = []; return J({ filtered: a, unfiltered: String(buildFeedFloorText(10)) }); })());

A('L4 取文契约：原始楼层行**保留标签**（过滤需要），交 AI 的文本已去标签 —— 顺序不可颠倒', (() => {
    boot(FLOORS.HTML);
    const raw = collectFloorLinesInRange(0, 1).join('\n');
    const feed = String(buildFeedFloorText(10));
    return raw.indexOf('<content>') >= 0 && /<br>/.test(raw) && feed.indexOf('<') < 0;
})(), (() => { boot(FLOORS.HTML); return J({ raw: collectFloorLinesInRange(0, 1), feed: buildFeedFloorText(10) }); })());

// ---------- B 组：真实点击委托下的按钮 ----------
await (async () => {
    boot(FLOORS.HTML);
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'feed' });
    bindOverlay();
    const el = doc.getElementById('ftt-panel');
    const click = (el && el.listeners && el.listeners.click) || [];
    const fire = (dataset) => {
        const tg = { dataset, closest: (sel) => (String(sel).indexOf('data-ftt-action') >= 0 ? tg : null) };
        click.forEach((fn) => fn({ target: tg, preventDefault() { }, stopPropagation() { } }));
        return new Promise((r) => setTimeout(r, 0));
    };
    // ① 分析 → 候选渲染出「＋白 / ＋黑」
    await fire({ fttAction: 'rxScanTags' });
    const html = String(panelBodyHtml('settings') || '');
    const hasChips = html.indexOf('data-ftt-action="rxAddTag"') >= 0 && html.indexOf('data-ftt-kind="white"') >= 0
        && html.indexOf('data-ftt-kind="black"') >= 0 && html.indexOf('data-ftt-tag="content"') >= 0;

    // ② 点「＋白 content」→ 落库 + 提示 + 文本框可见 + 高亮
    await fire({ fttAction: 'rxAddTag', fttKind: 'white', fttTag: 'content' });
    const wl = rxFeedTagLists().white;
    const noteW = String(panelBodyHtml('settings') || '');
    const state = (await panelAction('refresh', {})).state;
    const noteText = String((state && state.note) || '');
    // ③ 再点一次 → dup（不重复计入）
    await fire({ fttAction: 'rxAddTag', fttKind: 'white', fttTag: 'CONTENT' });
    const st2 = (await panelAction('refresh', {})).state;
    const noteDup = String((st2 && st2.note) || '');
    const wlDup = rxFeedTagLists().white;
    // ④ 点「＋黑 system」→ 黑名单 + 双侧同名提示（再把 system 也加白名单验证 other）
    await fire({ fttAction: 'rxAddTag', fttKind: 'black', fttTag: 'system' });
    const bl = rxFeedTagLists().black;
    // 再把同名标签加入白名单 → 提示「也存在于另一侧名单」（`other` 标记）
    const st3 = (await panelAction('rxAddTag', { kind: 'white', tag: 'system' })).state;
    const otherNote = String((st3 && st3.note) || '');

    A('B1 分析后渲染候选：「＋白 / ＋黑」按钮带 kind 与 tag（面板委托能取到参数）', hasChips && FEED_SCAN_ACTIONS.length === 3,
        J({ hasChips, html: html.slice(html.indexOf('rxAddTag') - 60, html.indexOf('rxAddTag') + 120) }));

    A('B2 点「＋白」→ 落库（大小写不敏感排重）+ 面板提示 + 白名单文本框可见 + 高亮类生效',
        J(wl) === J(['content']) && noteText.indexOf('已加入白名单') >= 0 && noteText.indexOf('content') >= 0
        && noteW.indexOf('>content<') >= 0 && noteW.indexOf('ftt-chip-btn--on-w') >= 0,
        J({ wl, noteText: noteText.slice(0, 80), textareaHas: noteW.indexOf('>content<') >= 0, onW: noteW.indexOf('ftt-chip-btn--on-w') >= 0 }));

    A('B3 重复点击（且大小写不同）→ 命中 dup 提示、名单不增长',
        J(wlDup) === J(['content']) && noteDup.indexOf('已在白名单中（自动排重）') >= 0,
        J({ wlDup, noteDup: noteDup.slice(0, 80) }));

    A('B4 点「＋黑」→ 黑名单落库；同名标签存在于两侧时提示「也存在于另一侧名单」',
        J(bl) === J(['system']) && otherNote.indexOf('也存在于另一侧名单') >= 0,
        J({ bl, otherNote: otherNote.slice(0, 90) }));

    // ---------- T 组：文本域 change 委托 ----------
    const change = (el && el.listeners && el.listeners.change) || [];
    const fireChange = (dataset, value) => {
        change.forEach((fn) => fn({ target: { dataset, value, type: 'textarea' } }));
        return new Promise((r) => setTimeout(r, 0));
    };
    cfg.feedRegexWhitelist = [];
    await fireChange({ fttCfg: 'feedRegexWhitelist' }, ' a \nA\n\nb\n【战斗】\n战斗\n');
    const deduped = clone(cfg.feedRegexWhitelist);

    A('T1 文本域 change → **整表排重**（大小写不敏感、去空行、去括号包裹）并写回**数组**',
        J(deduped) === J(['a', 'b', '战斗']) && isFeedTagKey('feedRegexWhitelist') === true
        && isFeedTagKey('feedRegexBlacklist') === true && isFeedTagKey('enabled') === false,
        J({ deduped, raw: cfg.feedRegexWhitelist }));

    A('T2 `rxDedupeTagList` 与 V1 逐字一致（21 例覆盖在 golden 内，这里锁边界）',
        J(rxDedupeTagList(['<content>', 'CONTENT', '【战斗】', '战斗', '', '  '])) === J(['content', '战斗'])
        && J(rxDedupeTagList(null)) === J([]),
        J(rxDedupeTagList(['<content>', 'CONTENT', '【战斗】', '战斗', '', '  '])));

    // ---------- E 组：边角 ----------
    A('E1 空标签不收录（reason=empty），未知动作不崩', (() => {
        boot(FLOORS.HTML);
        const r1 = rxPushFeedTag('white', '   ');
        const r2 = feedScanAction('rxAddTagNope', {});
        return r1.added === false && r1.reason === 'empty' && r2.ok === false && r2.text.indexOf('未知投喂标签动作') >= 0;
    })(), J([rxPushFeedTag('white', ' '), feedScanAction('nope', {})]));

    A('E2 `rxScanClear` 清空结果（V1 同款无提示）；无正文时给出 warning 文案', (() => {
        boot(FLOORS.HTML);
        rxAnalyzeLatestTextSafe();
        const had = !!rxTagScanState();
        const c = feedScanAction('rxScanClear', {});
        const cleared = rxTagScanState() === null;
        boot([{ is_user: true, role: 'user', mes: '只有用户楼。' }]);
        const noText = feedScanAction('rxScanTags', {});
        setRxTagScan(null);
        return had && cleared && c.ok === true && c.note === '' && noText.ok === false && noText.title.indexOf('未取到最新正文') >= 0;
    })(), '');

    A('E3 黑名单命中全部行 → 投喂为空（V1 同口径），且不残留标签', (() => {
        boot(FLOORS.MARKER);
        cfg.feedRegexBlacklist = ['状态'];
        const feed = String(buildFeedFloorText(10));
        cfg.feedRegexBlacklist = [];
        return feed === '' && G.cases.filter((x) => x.name === '行内标记黑名单（状态）')[0].out.feed === '';
    })(), (() => { boot(FLOORS.MARKER); cfg.feedRegexBlacklist = ['状态']; const f = String(buildFeedFloorText(10)); cfg.feedRegexBlacklist = []; return J(f); })());
})();

/** 安全分析（无正文时也不抛） */
function rxAnalyzeLatestTextSafe() {
    try { return feedScanAction('rxScanTags', {}); } catch (e) { return null; }
}

un();
R.done();
