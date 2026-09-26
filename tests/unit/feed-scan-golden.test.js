// ============================================================
// 单元测试 · B9-c 投喂标签自动分析（`rxScanTags` / `rxAddTag` / `rxScanClear`）
//   （**与真实 V1 插件 v1.206 逐项比对** + V2 面板编排/接线）
// 黄金样本：tests/fixtures/v1-golden-feed-scan.json
//   oracle = 真实 V1 插件 v1.206：latestAiFloorInfo / rxAnalyzeLatestText / rxNormTag / rxDedupeTagList /
//   rxPushFeedTag / rxTagScanHtml 直接调 `__FTT` 导出函数；动作 rxScanTags / rxAddTag / rxScanClear 与
//   设定页切页 / 子页切换走**真实点击委托**（openPanel() 后派发伪事件 → V1 `handleAction` 真实执行）；
//   设定页「投喂」静态片段取自 V1 导出函数 `F.settingsHtml()`。另存 V1 源码片段作口径证据。
// 覆盖：
//   R 组（与 V1 逐项比对）：样本与源码证据 / latestAiFloorInfo 四态（含 60 楼回溯窗口） / rxNormTag 21 例 /
//     rxDedupeTagList 6 例 / rxPushFeedTag 9 步（返回值 + 两侧名单）/ rxAnalyzeLatestText 6 例（成对优先·截 30·
//     大小写计数·无正文·实义字符判定·超长标记）/ rxTagScanHtml 5 态 / 设定页静态片段 / 动作序（9 步）/ 无正文提示；
//   V 组（V2 编排/接线）：投喂页接线（扫描节 + 真实键文本域）/ 面板 `rxScanTags` 读宿主楼层并渲染候选 /
//     `rxAddTag` 落库 + 文本域可见 / `rxScanClear` 清空与**结果跨重渲染保留** / 文本域 change 委托整表排重 /
//     宿主楼层接线（改 ctx.chat 立即反映）。
// 与 V1 的**必要偏离**（本文件断言其差异，登记于 docs/P9b-B9投喂标签与货币追踪.md）：
//   ① 设定页文本域的 `data-ftt-cfg` 用 V2 规范键 `feedRegexWhitelist`/`feedRegexBlacklist`
//      （V1 用别名 `rx_whitelist`/`rx_blacklist` + `settingsApplyAll` 映射）；排重改在面板 change 委托内完成。
//   ② V1 `notify(title, text)` 的 V2 等价：`feedScanAction()` 返回 `title`/`text`（逐字）并由面板组一行 note。
// 运行：node tests/unit/feed-scan-golden.test.js（或由 run.js 统一调用）
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    latestAiFloorInfo, rxAnalyzeLatestText, rxNormTag, rxDedupeTagList, rxPushFeedTag,
    rxTagScanHtml, rxTagScanState, setRxTagScan, rxFeedTagLists, isFeedTagKey, feedScanAction,
} from '../../ui/feed-scan.js';
import { panelAction, panelBodyHtml, setPanelHooks2, openPanel, bindOverlay } from '../../ui/panel.js';
import { settingsPageHtml } from '../../ui/settings-pages.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-feed-scan.json'), 'utf8'));
const R = makeReporter('feed-scan-golden B9-c 投喂标签自动分析（V1 黄金样本逐项比对）');
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
/** 去掉 `Date.now()` 的 ts（黄金样本已归一为删除） */
const projScan = (s) => { if (!s) return null; const o = clone(s); delete o.ts; return o; };

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };

/** 正文样本（与 oracle 生成器同一份） */
const TAGGED = [
    '<content>',
    '第1楼：角色甲在地点丁发现了被破坏的物品戊。',
    '【战斗】角色甲拔出武器，断口整齐。',
    '<thinking>他在想：是谁动的手？</thinking>',
    '<br>',
    '[状态] 体力 70',
    '<a b="c">链接</a>',
    '</content>',
].join('\n');
const MANY_TAGS = Array.from({ length: 32 }, (_, i) => `<x${String(i + 1).padStart(2, '0')}/>`).join('\n')
    + '\n【提示】只有 30 个标签能进结果。\n';
const DUP_MIX = [
    '<content>内容一</content>',
    '<CONTENT>内容二</CONTENT>',
    '<Content>内容三</Content>',
    '【战斗】战斗一',
    '【战斗】战斗二',
    '[状态]状态一',
    '（说明）说明一',
].join('\n');

/** 与 oracle 同构的楼层场景（normal / userOnly / none / far） */
function floorsFor(sc) {
    if (sc === 'none') return { last: -1, chat: [] };
    if (sc === 'userOnly') return { last: 0, chat: [{ is_user: true, role: 'user', mes: '用户输入：第0楼' }] };
    if (sc === 'far') {
        const chat = [];
        for (let i = 0; i <= 70; i++) {
            chat.push(i === 5
                ? { is_user: false, role: 'assistant', mes: TAGGED, swipes: null }
                : { is_user: true, role: 'user', mes: '用户第' + i + '楼' });
        }
        return { last: 70, chat: chat };
    }
    return {
        last: 5,
        chat: [
            { is_user: true, role: 'user', mes: '用户输入：第0楼' },
            { is_user: false, role: 'assistant', mes: TAGGED, swipes: null },
            { is_user: false, role: 'assistant', mes: '   \n  ', swipes: null },
            { is_user: false, role: 'assistant', is_hidden: true, mes: '<hidden>隐藏楼</hidden>' },
            { is_user: false, role: 'system', mes: '系统楼正文' },
            { is_user: true, role: 'user', mes: '用户输入：第5楼' },
        ],
    };
}

/** 单楼层场景（正文直接放第 0 楼 AI） */
function singleTextChat(text) {
    return { last: 0, chat: [{ is_user: false, role: 'assistant', mes: text, swipes: null }] };
}

let host = null;
let un = null;
/** 断言失败时的现场（detail 惰性读取） */
let R6FAILS = [];
let V3CONDS = [];
/** 复位：与 oracle 同一场景（楼层 + 空白/黑名单） */
function boot(sc, text) {
    const f = text !== undefined ? singleTextChat(text) : floorsFor(sc || 'normal');
    host = makeHost({ chat: f.chat });
    un = installGlobalHost(host, doc);
    Object.assign(cfg, clone(defaultCfg));
    cfg.feedRegexWhitelist = [];
    cfg.feedRegexBlacklist = [];
    cfg.feedFloors = 10;
    setScopeKey('角色甲');
    setLastMessageId(f.last);
    setKernelState(Object.assign(emptyState(), {
        state: { date: '1919-11-29', time: '', location: '', sceneFocus: null, present: ['角色甲'] },
    }));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setPanelHooks2({});
    setRxTagScan(null);
    return state;
}

/** detail 传**函数**（惰性求值：只在失败时收集现场） */
const A = async (name, fn, detailFn) => {
    let cond = false, extra = '';
    try { cond = await fn(); } catch (e) { cond = false; extra = String((e && e.message) || e); }
    if (cond !== true && !extra && typeof detailFn === 'function') { try { extra = detailFn(); } catch (e) { extra = String((e && e.message) || e); } }
    R.assert(name, cond === true, extra);
};

boot();

// ============================================================
// R 组：与 V1 逐项比对
// ============================================================

await A('R1 黄金样本与 V1 源码证据齐备（v1.206 / 十个片段 / 归一与排重口径 / 怪癖 7 条）', () => {
    const s = G.meta.v1SourceSnips || {};
    const need = ['latestAiFloorInfo', 'rxNormTag', 'rxAnalyzeLatestText', 'rxDedupeTagList', 'rxPushFeedTag',
        'rxTagScanHtml', 'rxScanTags', 'rxAddTag', 'rxScanClear', 'feedSection'];
    return G.meta.v1Version === 'v1.206'
        && need.every((k) => typeof s[k] === 'string' && s[k].length > 40)
        // 回溯窗口 60 楼（`i >= last - 60`）
        && s.latestAiFloorInfo.indexOf('i >= last - 60') > 0
        // 归一：先剥尖括号包裹、再剥括号/引号；限长 40
        && s.rxNormTag.indexOf('/^<\\s*\\/?\\s*/') > 0 && s.rxNormTag.indexOf('.slice(0, 40)') > 0
        // 排序：成对优先 → 次数降序 → 名称 localeCompare；各取前 30
        && s.rxAnalyzeLatestText.indexOf('(b.paired - a.paired) || (b.count - a.count) || a.name.localeCompare(b.name)') > 0
        && (s.rxAnalyzeLatestText.match(/\.slice\(0, 30\)/g) || []).length === 2
        // 排重：大小写不敏感、保序
        && s.rxDedupeTagList.indexOf('x.toLowerCase() === tag.toLowerCase()') > 0
        // 收录：未知 kind 一律按 white；空标签 n 不计算；other 另一侧
        && s.rxPushFeedTag.indexOf("kind === 'black'") > 0 && s.rxPushFeedTag.indexOf("out.reason = 'empty'") > 0
        && s.rxPushFeedTag.indexOf('out.other') > 0
        // 动作：三个 case 的提示与分支
        && s.rxScanTags.indexOf('已分析最新正文结构') > 0 && s.rxScanTags.indexOf('未取到最新正文') > 0
        && s.rxAddTag.indexOf('自动排重') > 0 && s.rxAddTag.indexOf('标签为空，未收录。') > 0
        && s.rxScanClear.indexOf('rxTagScan = null') > 0
        // 设定页节：两个按钮（无 title）+ 说明
        && s.feedSection.indexOf('rxScanTags') > 0 && s.feedSection.indexOf('rxScanClear') > 0
        && s.feedSection.indexOf('扫描<b>最近一条 AI 正文</b>') > 0
        // V1 保存路径别名键（偏离证据）
        && s.settingsApplyFeedTags.indexOf('rx_whitelist') > 0 && s.settingsApplyFeedTags.indexOf('rxDedupeTagList') > 0
        && (G.meta.notes || []).some((n) => n.indexOf('60 楼') >= 0);
}, () => Object.keys(G.meta.v1SourceSnips || {}));

await A('R2 `latestAiFloorInfo`：四态（末楼落点 / 仅用户楼 / last=-1 / 超出 60 楼窗口）与 V1 逐值一致', () => {
    const fails = [];
    for (const c of G.latestAiFloor.cases) {
        boot(c.name);
        const info = latestAiFloorInfo();
        const got = { floor: info.floor, chars: String(info.text || '').length, textHead: String(info.text || '').slice(0, 24) };
        if (J(got) !== J(c.info)) fails.push(c.name + ':' + J(got) + '≠' + J(c.info));
    }
    return fails.length === 0 && G.latestAiFloor.cases.length === 4
        && G.latestAiFloor.cases.filter((c) => c.name === 'far')[0].info.floor === -1;
}, () => ({ got: G.latestAiFloor.cases.map((c) => c.name + '=' + c.info.floor) }));

await A('R3 `rxNormTag`：21 例（尖括号/包裹括号/引号/书名号/限长 40/空与 null/数字）与 V1 逐值一致', () => {
    boot('userOnly');
    const got = G.normTag.cases.map((c) => String(rxNormTag(c.in === '__undefined__' ? undefined : c.in)));
    const want = G.normTag.cases.map((c) => String(c.out));
    return J(got) === J(want) && G.normTag.cases.length === 21
        && got[15].length === 40;                       // '甲'×50 → 截 40
}, () => ({ got: G.normTag.cases.map((c) => String(rxNormTag(c.in === '__undefined__' ? undefined : c.in))), want: G.normTag.cases.map((c) => String(c.out)) }));

await A('R4 `rxDedupeTagList`：6 例（大小写/空白/空项/包裹归一/null/非数组/保序）与 V1 逐值一致', () => {
    boot('userOnly');
    const got = G.dedupe.cases.map((c) => rxDedupeTagList(c.in));
    const want = G.dedupe.cases.map((c) => c.out);
    return J(got) === J(want) && G.dedupe.cases.length === 6
        && J(got[3]) === J([]) && J(got[5]) === J(['乙', '甲']);
}, () => ({ got: G.dedupe.cases.map((c) => rxDedupeTagList(c.in)) }));

await A('R5 `rxPushFeedTag`：9 步（首次收录 / 同名与大小写 dup / 空标签 n=0 / 带括号归一 / other 双向 / 未知 kind 按白）返回值与两侧名单逐步一致', () => {
    boot('userOnly');
    const fails = [];
    G.pushFeed.steps.forEach((s, i) => {
        const out = clone(rxPushFeedTag(s.kind, s.raw === '__undefined__' ? undefined : s.raw));
        if (J(out) !== J(s.out)) fails.push(i + ' out ' + J(out) + '≠' + J(s.out));
        if (J(cfg.feedRegexWhitelist) !== J(s.wlAfter)) fails.push(i + ' wl');
        if (J(cfg.feedRegexBlacklist) !== J(s.blAfter)) fails.push(i + ' bl');
    });
    return fails.length === 0 && G.pushFeed.steps.length === 9
        && G.pushFeed.steps[3].out.n === 0                    // V1 原生：空标签分支 n 恒为 0
        && G.pushFeed.steps[6].out.other === true && G.pushFeed.steps[7].out.other === true;
}, () => ({ got: G.pushFeed.steps.map((s) => s.name), wl: cfg.feedRegexWhitelist }));

await A('R6 `rxAnalyzeLatestText`：6 例（成对优先 / 32 标签截 30 / 大小写计数 / 空白无正文 / 纯符号被过滤 / 超长标记不入候选）与 V1 逐值一致', () => {
    const fails = [];
    let manyChars = 0;
    for (const c of G.analyze.cases) {
        const base = c.name.indexOf('TAGGED') === 0;
        const textOf = base ? undefined
            : (c.name.indexOf('MANY_TAGS') === 0 ? MANY_TAGS
                : (c.name.indexOf('DUP_MIX') === 0 ? DUP_MIX
                    : (c.name.indexOf('空正文') === 0 ? '   \n  '
                        : (c.name.indexOf('纯符号') === 0 ? '【!!!】\n[***]\n【战斗】' : '【' + '甲'.repeat(30) + '】'))));
        // TAGGED 走 oracle 的**多楼层场景**（正文在第 1 楼）；其余为「单楼正文」场景（第 0 楼）
        boot('normal', textOf);
        const got = projScan(rxAnalyzeLatestText());
        if (c.name.indexOf('MANY_TAGS') === 0) manyChars = got.chars;
        if (J(got) !== J(c.scan)) fails.push(c.name + ' → ' + J(got));
    }
    const many = G.analyze.cases.filter((c) => c.name.indexOf('MANY_TAGS') === 0)[0];
    R6FAILS = fails;
    return fails.length === 0 && G.analyze.cases.length === 6
        && many.scan.tags.length === 30 && manyChars === MANY_TAGS.trim().length;
}, () => ({ fails: R6FAILS }));

await A('R7 `rxTagScanHtml`：5 态（未分析 / 无正文 / 有结果 / 白高亮 / 白+黑高亮）HTML 与 V1 **逐字节一致**', () => {
    boot('normal');
    const got = [];
    got.push(rxTagScanHtml());
    rxAnalyzeLatestText();
    got.push(rxTagScanHtml());
    rxPushFeedTag('white', 'content');
    got.push(rxTagScanHtml());
    rxPushFeedTag('black', 'thinking');
    got.push(rxTagScanHtml());
    boot('userOnly');
    rxAnalyzeLatestText();
    got.push(rxTagScanHtml());
    const want = G.tagScanHtml.states.map((s) => s.html);
    const fails = [];
    got.forEach((h, i) => { if (h !== want[i]) fails.push('state' + i + '(len ' + h.length + '≠' + want[i].length + ')'); });
    return fails.length === 0 && got.length === 5
        && got[0].indexOf('尚未分析') >= 0 && got[4].indexOf('⚠️ 未取到最近一条 AI 正文，无法分析。') >= 0
        && got[2].indexOf('ftt-chip-btn--on-w') >= 0 && got[3].indexOf('ftt-chip-btn--on-b') >= 0
        && want[2].indexOf('data-ftt-tag="content"') >= 0;
}, () => ({ got: { states: G.tagScanHtml.states.map((s) => s.name) } }));

await A('R8 「投喂标签自动分析」设定节：节标题 / 两个按钮（无 title）/ 说明文案 / 未分析占位 与 V1 逐字一致', () => {
    boot('normal');
    const fp = G.feedPage;
    // V1 两个按钮无 title → V2 同（逐字）
    const wantButtons = '<button class="ftt-btn ftt-sm" data-ftt-action="rxScanTags">🔍 分析最新正文结构</button><button class="ftt-btn ftt-sm" data-ftt-action="rxScanClear">清空结果</button>';
    // V1 的静态片段 → V2 同一个节里的等价片段（节容器同结构）
    const wantSection = '<div class="ftt-section"><div class="ftt-sec-title">投喂标签自动分析</div>'
        + '<div class="ftt-row">' + wantButtons + '</div>'
        // v2.60.0（用户要求：去罗嗦）：说明文案精简为一句（V1 原文见 fixture `feedPage.scanNoteInner`）
        + '<div class="ftt-muted ftt-my-1">扫描<b>最近一条 AI 正文</b>：列出 HTML 标签与行内标记；点「＋白 / ＋黑」收录，自动排重。</div>'
        + fp.scanHtml
        + '</div>';
    const gotSection = (() => {
        const html = settingsPageHtml('feed');
        const i = html.indexOf('<div class="ftt-section"><div class="ftt-sec-title">投喂标签自动分析</div>');
        const j = html.indexOf('<div class="ftt-section"><div class="ftt-sec-title">投喂白名单标签');
        return (i >= 0 && j > i) ? html.slice(i, j) : '';
    })();
    return gotSection === wantSection && fp.scanSectionTitle === '投喂标签自动分析'
        && fp.settingsSub === 'feed' && fp.scanButtons.length === 2;
}, () => ({ got: settingsPageHtml('feed').slice(settingsPageHtml('feed').indexOf('投喂标签自动分析'), settingsPageHtml('feed').indexOf('投喂标签自动分析') + 320) }));

await A('R9 动作序（真实点击委托 9 步）：`rxScanTags`/`rxAddTag` 白黑/重复/空标签/`rxScanClear` 的提示（title+text）与名单逐步一致', async () => {
    boot('normal');
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'feed' });
    const fails = [];
    for (const s of G.actionFlow.steps) {
        let r;
        if (s.ds.fttTab) r = await panelAction('tab', { tab: s.ds.fttTab });
        else if (s.ds.fttSubtab) r = await panelAction('settingsSub', { sub: s.ds.fttSubtab });
        else r = await panelAction(s.ds.fttAction, { kind: s.ds.fttKind, tag: s.ds.fttTag });
        // 提示（V1 notify 的 title/text 逐字）
        const t = (s.toasts || [])[0] || null;
        const gotTitle = r && r.title !== undefined ? String(r.title) : '';
        const gotText = r && r.text !== undefined ? String(r.text) : '';
        if (t) { if (gotTitle !== t.title || gotText !== t.text) fails.push(s.name + ' toast ' + J([gotTitle, gotText]) + '≠' + J([t.title, t.text])); }
        else if (gotTitle !== '' || gotText !== '') fails.push(s.name + ' 期望无提示');
        if (J(cfg.feedRegexWhitelist) !== J(s.wl)) fails.push(s.name + ' wl');
        if (J(cfg.feedRegexBlacklist) !== J(s.bl)) fails.push(s.name + ' bl');
    }
    const last = G.actionFlow.steps[G.actionFlow.steps.length - 1];
    const html = String(panelBodyHtml('settings'));
    return fails.length === 0 && G.actionFlow.steps.length === 9
        && last.scanIdle === true && last.hasAddBtns === false
        && html.indexOf('尚未分析') >= 0;                       // rxScanClear 后回到占位
}, () => ({ fails: G.actionFlow.steps.map((s) => s.name), wl: cfg.feedRegexWhitelist }));

await A('R10 无正文时的动作提示：`rxScanTags` 走 warning 分支（title/text 逐字）+ 结果区渲染「未取到」占位', async () => {
    boot('userOnly');
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'feed' });
    const r = await panelAction('rxScanTags', {});
    const want = G.noTextAction.toasts[0];
    const html = String(panelBodyHtml('settings'));
    return String(r.title) === want.title && String(r.text) === want.text && r.ok === false
        && html.indexOf('⚠️ 未取到最近一条 AI 正文，无法分析。') >= 0
        && rxTagScanState() && rxTagScanState().ok === false && rxTagScanState().reason === 'no-text';
}, () => ({ r: { title: G.noTextAction.toasts[0].title } }));

// ============================================================
// V 组：V2 编排 / 接线
// ============================================================

await A('V1 投喂页接线：控件行之后追加扫描节 + 白/黑名单两节；文本域用 V2 规范键并回显 cfg（V1 别名键的映射差异见文件头）', () => {
    boot('normal');
    cfg.feedRegexWhitelist = ['content', '战斗'];
    cfg.feedRegexBlacklist = ['系统消息'];
    const html = settingsPageHtml('feed');
    const iScan = html.indexOf('投喂标签自动分析');
    const iWl = html.indexOf('投喂白名单标签（只保留含这些标签的行，每行一个标签名）');
    const iBl = html.indexOf('投喂黑名单标签（屏蔽含这些标签的行，每行一个标签名）');
    const iFirstCtl = html.indexOf('data-ftt-cfg="feedFloors"');
    const wl = G.feedPage.wlTitle, bl = G.feedPage.blTitle;
    return iFirstCtl >= 0 && iScan > iFirstCtl && iWl > iScan && iBl > iWl
        && String(G.feedPage.wlTitle) === '投喂白名单标签（只保留含这些标签的行，每行一个标签名）'
        && String(G.feedPage.blTitle) === '投喂黑名单标签（屏蔽含这些标签的行，每行一个标签名）'
        && html.indexOf('data-ftt-cfg="feedRegexWhitelist" class="ftt-textarea">content\n战斗</textarea>') >= 0
        && html.indexOf('data-ftt-cfg="feedRegexBlacklist" class="ftt-textarea">系统消息</textarea>') >= 0
        && html.indexOf(String(G.feedPage.wlNote)) >= 0 && html.indexOf(String(G.feedPage.blNote)) >= 0
        && isFeedTagKey('feedRegexWhitelist') && isFeedTagKey('feedRegexBlacklist') && !isFeedTagKey('feedFloors')
        && wl === G.feedPage.wlTitle && bl === G.feedPage.blTitle;
}, () => ({ feed: settingsPageHtml('feed').slice(0, 80) }));

await A('V2 面板 `rxScanTags` 读**宿主楼层**并渲染候选：落点/字数/种类进 note 与结果区，「＋白 / ＋黑」按钮齐备', async () => {
    boot('normal');
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'feed' });
    const r = await panelAction('rxScanTags', {});
    const html = String(panelBodyHtml('settings'));
    const sc = rxTagScanState();
    return r.ok === true && String(r.title) === '已分析最新正文结构'
        && String(r.text) === ('第 1 楼 · ' + TAGGED.length + ' 字 · HTML 标签 4 种 / 行内标记 2 种；点标签右侧「＋白」/「＋黑」即可收录。')
        && String(r.state.note) === String(r.title) + '：' + String(r.text)
        && sc.ok === true && sc.floor === 1 && sc.chars === TAGGED.length
        && J(sc.tags.map((x) => x.name)) === J(['a', 'content', 'thinking', 'br'])
        && html.indexOf('📄 第 1 楼 AI 正文 · ' + TAGGED.length + ' 字 · 标签 4 种 / 标记 2 种（已收录高亮）') >= 0
        && (html.match(/data-ftt-action="rxAddTag"/g) || []).length === 12;      // (4 标签 + 2 标记) × 2 按钮
}, () => ({ sc: rxTagScanState(), note: '' }));

await A('V3 `rxAddTag` 面板编排：落库 + 结果区高亮 + 文本域即时可见；重复与空标签如实回报', async () => {
    boot('normal');
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'feed' });
    await panelAction('rxScanTags', {});
    const a1 = await panelAction('rxAddTag', { kind: 'white', tag: '<content>' });
    const a2 = await panelAction('rxAddTag', { kind: 'white', tag: 'CONTENT' });
    const a3 = await panelAction('rxAddTag', { kind: 'black', tag: '【战斗】' });
    const a4 = await panelAction('rxAddTag', { kind: 'white', tag: '   ' });
    const html = String(panelBodyHtml('settings'));
    const conds = [
        a1.ok === true && String(a1.title) === '已加入白名单' && String(a1.text) === 'content · 当前共 1 项',
        a2.ok === false && String(a2.title) === '已在白名单中（自动排重）' && String(a2.text) === 'CONTENT · 当前共 1 项',
        a3.ok === true && J(rxFeedTagLists()) === J({ white: ['content'], black: ['战斗'] }),
        a4.ok === false && String(a4.title) === '未收录' && String(a4.text) === '标签为空，未收录。' && a4.note === '未收录：标签为空，未收录。',
        html.indexOf('class="ftt-btn ftt-sm ftt-chip-btn ftt-chip-btn--on-w" data-ftt-action="rxAddTag" data-ftt-kind="white" data-ftt-tag="content"') >= 0,
        html.indexOf('ftt-chip-btn--on-b" data-ftt-action="rxAddTag" data-ftt-kind="black" data-ftt-tag="战斗"') >= 0,
        html.indexOf('data-ftt-cfg="feedRegexWhitelist" class="ftt-textarea">content</textarea>') >= 0,
        String(a1.state.note) === '已加入白名单：content · 当前共 1 项',
    ];
    V3CONDS = conds.map((x, i) => i + ':' + x);
    return conds.every(Boolean);
}, () => ({ conds: V3CONDS, lists: rxFeedTagLists() }));

await A('V4 `rxScanClear` 清空结果（面板回占位、`rxTagScanState()` 为 null）；结果**跨重渲染/切页保留**', async () => {
    boot('normal');
    openPanel('settings');
    await panelAction('settingsSub', { sub: 'feed' });
    await panelAction('rxScanTags', {});
    const before = String(panelBodyHtml('settings'));
    await panelAction('tab', { tab: 'overview' });                 // 切走
    await panelAction('tab', { tab: 'settings' });                 // 切回（子页仍为 feed）
    const after = String(panelBodyHtml('settings'));
    const cl = await panelAction('rxScanClear', {});
    const cleared = String(panelBodyHtml('settings'));
    return before.indexOf('📄 第 1 楼 AI 正文') >= 0 && after.indexOf('📄 第 1 楼 AI 正文') >= 0
        && cl.ok === true && cl.title === '' && cl.text === '' && cl.note === ''
        && rxTagScanState() === null && cleared.indexOf('尚未分析') >= 0
        && cleared.indexOf('data-ftt-action="rxAddTag"') < 0;
}, () => ({ scan: rxTagScanState() }));

await A('V5 文本域 change 委托整表排重（V1 `settingsApplyAll` 的 `rxDedupeTagList(value.split(\'\\n\'))` 等价）', () => {
    boot('normal');
    openPanel('settings');
    bindOverlay();                       // 桩 DOM 预注册了 `#ftt-panel` → `ensureOverlay` 不会自动绑定委托，显式绑定（宿主同款入口）
    const el = doc._els['ftt-panel'];
    const onChange = (el && el.listeners && el.listeners.change) ? el.listeners.change[0] : null;
    if (typeof onChange !== 'function') return false;
    onChange({ target: { dataset: { fttCfg: 'feedRegexWhitelist' }, type: 'textarea', value: ' content \nContent\n\n【战斗】\n战斗\n系统消息' } });
    const wl = cfg.feedRegexWhitelist.slice();
    onChange({ target: { dataset: { fttCfg: 'feedRegexBlacklist' }, type: 'textarea', value: '' } });
    const bl = cfg.feedRegexBlacklist.slice();
    return J(wl) === J(['content', '战斗', '系统消息']) && J(bl) === J([])
        && rxDedupeTagList([' content ', 'Content', '', '【战斗】', '战斗', '系统消息']).join(',') === 'content,战斗,系统消息';
}, () => ({ wl: cfg.feedRegexWhitelist, bl: cfg.feedRegexBlacklist }));

await A('V6 宿主楼层接线：改 `ctx.chat` / `setLastMessageId` 后分析结果立即反映（隐藏楼 / 用户楼 / role 非 assistant 均跳过）', () => {
    // 隐藏楼在末位 → 回溯到前面的 AI 楼
    boot('normal');
    host.ctx.chat = [
        { is_user: false, role: 'assistant', mes: '<content>早先的 AI 楼</content>', swipes: null },
        { is_user: false, role: 'assistant', is_hidden: true, mes: '<hidden>隐藏</hidden>', swipes: null },
    ];
    setLastMessageId(1);
    const a = latestAiFloorInfo();
    const scA = projScan(rxAnalyzeLatestText());
    // 全部替换为用户楼 → 无正文
    host.ctx.chat = [{ is_user: true, role: 'user', mes: '用户楼' }];
    setLastMessageId(0);
    const b = latestAiFloorInfo();
    const scB = rxAnalyzeLatestText();
    return a.floor === 0 && a.text === '<content>早先的 AI 楼</content>' && scA.floor === 0
        && J(scA.tags.map((x) => x.name)) === J(['content'])
        && b.floor === -1 && b.text === '' && scB.ok === false && scB.reason === 'no-text';
}, () => ({ a: latestAiFloorInfo() }));

await A('V7 只读诊断与动作常量：`FEED_SCAN_ACTIONS` / 白黑名单键常量与 V1 逐字一致；未知动作如实失败', async () => {
    const mod = await import('../../ui/feed-scan.js');
    const acts = mod.FEED_SCAN_ACTIONS.slice();
    const unknown = mod.feedScanAction('rxNope', {});
    const feedHtml = G.meta.v1SourceSnips.feedPageHead || '';
    return J(acts) === J(['rxScanTags', 'rxAddTag', 'rxScanClear'])
        && unknown.ok === false && unknown.note.indexOf('未知投喂标签动作') === 0
        && mod.RX_WHITELIST_KEY === 'feedRegexWhitelist' && mod.RX_BLACKLIST_KEY === 'feedRegexBlacklist'
        && J(mod.RX_TAG_TEXT_KEYS) === J(['feedRegexWhitelist', 'feedRegexBlacklist'])
        // V1 设定页把白/黑名单读成 cfg.feedRegexWhitelist / feedRegexBlacklist（同一落点）
        && feedHtml.indexOf('cfg.feedRegexWhitelist') > 0 && feedHtml.indexOf('cfg.feedRegexBlacklist') > 0;
}, () => ({ acts: 'see-code' }));

un();
R.done();
