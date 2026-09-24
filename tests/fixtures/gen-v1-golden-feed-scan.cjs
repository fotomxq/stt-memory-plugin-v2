'use strict';
// ============================================================
// B9-c oracle（投喂标签自动分析）：真实 V1 插件 v1.206 直调，生成
//   tests/fixtures/v1-golden-feed-scan.json
//   （latestAiFloorInfo / rxAnalyzeLatestText / rxNormTag / rxDedupeTagList / rxPushFeedTag / rxTagScanHtml
//     + 动作 rxScanTags / rxAddTag / rxScanClear）
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致（ts 归一为 0）。
//   动作类（rxScanTags / rxAddTag / rxScanClear / 切页 / 切设定子页）走**真实点击委托**：
//   `F.openPanel()` → `panel.listeners.click` 逐监听器派发伪事件（V1 `handleAction` 真实执行）；
//   纯函数直接调 `__FTT` 导出函数；设定页静态片段取自 `F.settingsHtml()`（V1 导出，按 activeSettingsSub 构建）。
// ============================================================
const fs = require('fs');
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin, pluginToasts } = require(path.join(V1, 'tests/unit/helpers.js'));

const realStdoutWrite = process.stdout.write.bind(process.stdout);
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');

const OUT = process.argv[2] || '';
const SRC_FILE = path.join(V1, 'src', 'FTT记忆组件-v1.206.js');
const SRC = fs.readFileSync(SRC_FILE, 'utf8');
const proj = (o) => (o === null || o === undefined ? null : JSON.parse(JSON.stringify(o)));

/** 取两个锚点之间的源码片段（含起、不含止；maxLen 兜底）；找不到返回 '' */
function snip(from, to, maxLen) {
    const i = SRC.indexOf(from);
    if (i < 0) return '';
    const j = to ? SRC.indexOf(to, i + from.length) : -1;
    const seg = (j > i ? SRC.slice(i, j) : SRC.slice(i, i + (maxLen || 1400)));
    return seg.trim();
}
/** 取 [from, to) 之间的片段；找不到返回 '' */
function between(text, from, to) {
    const i = String(text).indexOf(from);
    if (i < 0) return '';
    const j = to ? String(text).indexOf(to, i + from.length) : -1;
    return j > i ? String(text).slice(i, j) : String(text).slice(i);
}

/** 分析结果投影（去掉 Date.now 的 ts，保证逐字节可复现） */
const projScan = (s) => {
    if (!s) return null;
    const o = proj(s);
    delete o.ts;
    return o;
};

// ---------------- 正文样本 ----------------
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

/** 楼层场景：index → 消息（模拟 V1 `getChatMessages(i)` 返回 [msg]） */
function floorsFor(sc) {
    if (sc === 'none') return { last: -1, floors: [] };
    if (sc === 'userOnly') return { last: 0, floors: [{ is_user: true, role: 'user', mes: '用户输入：第0楼' }] };
    if (sc === 'far') {
        // AI 正文只在第 5 楼，最后楼层 70 → 超出 60 楼回溯窗口
        const floors = [];
        for (let i = 0; i <= 70; i++) {
            floors.push(i === 5
                ? { is_user: false, role: 'assistant', mes: TAGGED, swipes: null }
                : { is_user: true, role: 'user', mes: '用户第' + i + '楼' });
        }
        return { last: 70, floors };
    }
    return {
        last: 5,
        floors: [
            { is_user: true, role: 'user', mes: '用户输入：第0楼' },
            { is_user: false, role: 'assistant', mes: TAGGED, swipes: null },
            { is_user: false, role: 'assistant', mes: '   \n  ', swipes: null },              // 空白 → 跳过
            { is_user: false, role: 'assistant', is_hidden: true, mes: '<hidden>隐藏楼</hidden>' },   // 隐藏 → 跳过
            { is_user: false, role: 'system', mes: '系统楼正文' },                              // role 非 assistant → 跳过
            { is_user: true, role: 'user', mes: '用户输入：第5楼' },
        ],
    };
}

/** 用一个独立环境加载 V1（每次全新 cfg / state） */
async function bootWith(sc, text) {
    const f = floorsFor(sc);
    const env = makeTavernEnv({
        ctx: {
            getLastMessageId: () => f.last,
            getChatMessages: (i) => [f.floors[i] === undefined ? null : f.floors[i]],
            ...(text !== undefined ? {} : {}),
        },
    });
    const F = await loadPlugin(env);
    ['indexedDB', 'folder', 'localFolder', 'chatVariable', 'worldbook', 'chatFloor'].forEach(k => { F.cfg.storage[k] = false; });
    F.cfg.storage.localStorage = true; F.cfg.storage.syncOnSave = false; F.cfg.storage.autoIdleCheck = false;
    F.cfg.feedRegexWhitelist = []; F.cfg.feedRegexBlacklist = [];
    F.cfg.feedFloors = 10;
    return { F, env };
}

async function main() {
    const g = global;
    const savedRaf = g.requestAnimationFrame;
    g.requestAnimationFrame = (fn) => { try { fn(); } catch (e) { } return 0; };   // mock 缺 rAF：同步执行

    const result = { meta: { v1Version: '', notes: [], sourceFile: 'src/FTT记忆组件-v1.206.js' } };

    // ---------------- 零、V1 源码片段（动作序/口径证据） ----------------
    result.meta.v1SourceSnips = {
        latestAiFloorInfo: snip('function latestAiFloorInfo() {', '// 标签名归一化'),
        rxNormTag: snip('function rxNormTag(raw) {', '// 正文结构分析'),
        rxAnalyzeLatestText: snip('function rxAnalyzeLatestText() {', '// 保存时的整表排重'),
        rxDedupeTagList: snip('function rxDedupeTagList(list) {', '// 收录一个标签到白/黑名单'),
        rxPushFeedTag: snip('function rxPushFeedTag(kind, raw) {', '// ==================== 「关于」页'),
        rxTagScanHtml: snip('function rxTagScanHtml() {', '// 「关于」页 —— 插件介绍'),
        rxScanTags: snip("case 'rxScanTags': {", "case 'rxAddTag': {"),
        rxAddTag: snip("case 'rxAddTag': {", "case 'rxScanClear': {"),
        rxScanClear: snip("case 'rxScanClear': {", '// v1.179/v1.180'),
        feedSection: snip('<div class="ftt-section"><div class="ftt-sec-title">投喂标签自动分析</div>', '<div class="ftt-section"><div class="ftt-sec-title">投喂世界书</div>'),
        feedPageHead: snip("} else if (activeSettingsSub === 'feed') {", 'subBody = `', 400),
        settingsApplyFeedTags: snip('const wlTa = panelEl?.querySelector(\'[data-ftt-cfg="rx_whitelist"]\');', 'const mainApi = collectApiBlock', 700),
        exports: snip('latestAiFloorInfo, rxAnalyzeLatestText, rxNormTag, rxDedupeTagList, rxPushFeedTag, rxTagScanHtml,', '\n', 200),
    };

    // ---------------- 一、latestAiFloorInfo（取最新 AI 楼） ----------------
    {
        const cases = [];
        for (const sc of ['normal', 'userOnly', 'none', 'far']) {
            const { F } = await bootWith(sc);
            const info = F.latestAiFloorInfo();
            cases.push({ name: sc, info: { floor: info.floor, chars: String(info.text || '').length, textHead: String(info.text || '').slice(0, 24) } });
        }
        result.latestAiFloor = { cases };
    }

    // ---------------- 二、rxAnalyzeLatestText（正文结构分析） ----------------
    {
        const cases = [];
        const { F } = await bootWith('normal');
        cases.push({ name: 'TAGGED（成对 + 非成对 + 行内标记）', scan: projScan(F.rxAnalyzeLatestText()) });

        // 用户指定正文：直接改写楼层
        const obs = (text, last) => {
            const env = makeTavernEnv({ ctx: { getLastMessageId: () => last, getChatMessages: (i) => (i === 0 ? [{ is_user: false, role: 'assistant', mes: text, swipes: null }] : [null]) } });
            return env;
        };
        const runText = async (text) => {
            const env = obs(text, 0);
            const F2 = await loadPlugin(env);
            ['indexedDB', 'folder', 'localFolder', 'chatVariable', 'worldbook', 'chatFloor'].forEach(k => { F2.cfg.storage[k] = false; });
            F2.cfg.storage.localStorage = true; F2.cfg.storage.syncOnSave = false; F2.cfg.storage.autoIdleCheck = false;
            F2.cfg.feedRegexWhitelist = []; F2.cfg.feedRegexBlacklist = [];
            return projScan(F2.rxAnalyzeLatestText());
        };
        cases.push({ name: 'MANY_TAGS（32 个标签 → 截前 30）', scan: await runText(MANY_TAGS) });
        cases.push({ name: 'DUP_MIX（大小写 + 重复标记计数）', scan: await runText(DUP_MIX) });
        cases.push({ name: '空正文 → no-text', scan: await runText('   \n  ') });
        cases.push({ name: '纯符号标记 → 被实义字符判定过滤', scan: await runText('【!!!】\n[***]\n【战斗】') });
        cases.push({ name: '超长行内标记（>24 字不入候选）', scan: await runText('【' + '甲'.repeat(30) + '】') });
        result.analyze = { cases };
    }

    // ---------------- 三、rxNormTag ----------------
    {
        const { F } = await bootWith('userOnly');
        const inputs = [
            '<content>', '</content>', '< content >', '<br/>', '<a b="c">', '<thinking>',
            '【战斗】', '  [状态] ', '「引号」', '『角引号』', '（括号）', '"双引号"', "'单引号'",
            '[[双层]]', '《书名》', '甲'.repeat(50), '', '   ', null, undefined, 123,
        ];
        result.normTag = {
            cases: inputs.map((x) => ({ in: x === undefined ? '__undefined__' : x, out: String(F.rxNormTag(x)) })),
        };
    }

    // ---------------- 四、rxDedupeTagList ----------------
    {
        const { F } = await bootWith('userOnly');
        const cases = [
            { name: '空白/大小写/空项', in: [' a ', 'A', '', 'b', 'b', '  '] },
            { name: '包裹与重复（content/战斗）', in: ['<content>', 'CONTENT', '【战斗】', '战斗'] },
            { name: 'null', in: null },
            { name: '字符串（非数组）→ 空', in: 'content' },
            { name: '空数组', in: [] },
            { name: '保留首次出现顺序', in: ['乙', '甲', '乙', '甲'] },
        ];
        result.dedupe = {
            cases: cases.map((c) => ({ name: c.name, in: c.in, call: c.in === null ? 'rxDedupeTagList(null)' : 'rxDedupeTagList(' + JSON.stringify(c.in) + ')', out: proj(F.rxDedupeTagList(c.in)) })),
        };
    }

    // ---------------- 五、rxPushFeedTag（收录 + 排重） ----------------
    {
        const { F } = await bootWith('userOnly');
        F.cfg.feedRegexWhitelist = []; F.cfg.feedRegexBlacklist = [];
        const steps = [];
        const push = (name, kind, raw) => {
            const out = proj(F.rxPushFeedTag(kind, raw));
            steps.push({
                name, kind, raw: raw === undefined ? '__undefined__' : raw, out,
                wlAfter: proj(F.cfg.feedRegexWhitelist), blAfter: proj(F.cfg.feedRegexBlacklist),
            });
            return out;
        };
        push('白·首次收录', 'white', '<content>');
        push('白·同名重复 → dup', 'white', 'content');
        push('白·大小写不同 → dup', 'white', 'CONTENT');
        push('白·空白 → empty', 'white', '   ');
        push('白·null → empty', 'white', null);
        push('黑·首次收录（带括号 → 归一）', 'black', '【系统消息】');
        push('黑·收录已在白名单的标签 → other=true', 'black', 'content');
        push('白·收录已在黑名单的标签 → other=true', 'white', '系统消息');
        push('未知 kind（非 black 一律按 white）', 'weird', '中立标签');
        result.pushFeed = { steps, final: { wl: proj(F.cfg.feedRegexWhitelist), bl: proj(F.cfg.feedRegexBlacklist) } };
    }

    // ---------------- 六、rxTagScanHtml（三态渲染） ----------------
    {
        const { F } = await bootWith('normal');
        const states = [];
        states.push({ name: 'state0 未分析', html: F.rxTagScanHtml() });
        F.rxAnalyzeLatestText();
        states.push({ name: 'state2 有结果', html: F.rxTagScanHtml() });
        F.rxPushFeedTag('white', 'content');
        states.push({ name: 'state3 已收录高亮（白）', html: F.rxTagScanHtml() });
        F.rxPushFeedTag('black', 'thinking');
        states.push({ name: 'state4 已收录高亮（白+黑）', html: F.rxTagScanHtml() });
        const { F: F2 } = await bootWith('userOnly');
        F2.rxAnalyzeLatestText();
        states.push({ name: 'state1 无正文（ok=false）', html: F2.rxTagScanHtml() });
        result.tagScanHtml = { states };
    }

    // ---------------- 七、设定页「投喂」静态片段（F.settingsHtml()） ----------------
    {
        const { F } = await bootWith('normal');
        F.cfg.feedRegexWhitelist = ['content', '战斗'];
        F.cfg.feedRegexBlacklist = ['系统消息'];
        F.setSettingsSub('feed');                       // V1 导出：设定页按子页构建（测试用）
        const html = String(F.settingsHtml());
        const scanSection = between(html, '<div class="ftt-section"><div class="ftt-sec-title">投喂标签自动分析</div>', '<div class="ftt-section"><div class="ftt-sec-title">投喂白名单标签');
        const wlSection = between(html, '<div class="ftt-section"><div class="ftt-sec-title">投喂白名单标签', '<div class="ftt-section"><div class="ftt-sec-title">投喂黑名单标签');
        const blSection = between(html, '<div class="ftt-section"><div class="ftt-sec-title">投喂黑名单标签', '<div class="ftt-section"><div class="ftt-sec-title">投喂世界书');
        const grabAll = (h, re) => (String(h).match(re) || []);
        result.feedPage = {
            settingsSub: F.settingsSubState(),
            scanSectionTitle: (scanSection.match(/<div class="ftt-sec-title">([^<]*)<\/div>/) || [])[1] || null,
            scanButtons: grabAll(scanSection, /<button[^>]*data-ftt-action="rxScan\w+"[^>]*>[^<]*<\/button>/g),
            scanNoteInner: (scanSection.match(/<div class="ftt-muted ftt-my-1">([\s\S]*?)<\/div>/) || [])[1] || null,
            scanHtml: (scanSection.match(/<div class="ftt-muted">尚未分析[\s\S]*?<\/div>/) || [])[0] || null,
            wlTitle: (wlSection.match(/<div class="ftt-sec-title">([^<]*)<\/div>/) || [])[1] || null,
            wlTextarea: (wlSection.match(/<textarea[^>]*data-ftt-cfg="rx_whitelist"[^>]*>[\s\S]*?<\/textarea>/) || [])[0] || null,
            wlNote: (wlSection.match(/<div class="ftt-muted">([\s\S]*?)<\/div>/) || [])[1] || null,
            blTitle: (blSection.match(/<div class="ftt-sec-title">([^<]*)<\/div>/) || [])[1] || null,
            blTextarea: (blSection.match(/<textarea[^>]*data-ftt-cfg="rx_blacklist"[^>]*>[\s\S]*?<\/textarea>/) || [])[0] || null,
            blNote: (blSection.match(/<div class="ftt-muted">([\s\S]*?)<\/div>/) || [])[1] || null,
        };
    }

    // ---------------- 八、动作序（真实点击委托） ----------------
    {
        const { F, env } = await bootWith('normal');
        F.openPanel();
        const panel = env.parentWin.document.body.children.find(c => c.id === 'ftt-panel');
        panel.classList.contains = (c) => c === 'ftt-open' || c === 'ftt-tab' || c === 'ftt-subtab';
        const listeners = (panel.listeners && panel.listeners.click) ? panel.listeners.click : [];
        /** 伪点击：cls = 额外命中的 class（V1 用 classList.contains 分流 ftt-tab / ftt-subtab） */
        const clickFake = async (ds, cls) => {
            const classes = ['ftt-open'].concat(cls || []);
            const keepContains = panel.classList.contains;
            panel.classList.contains = (c) => classes.indexOf(c) >= 0;
            const fake = {
                target: { dataset: ds, classList: { contains: (c) => classes.indexOf(c) >= 0 }, closest: () => panel, tagName: 'A' },
                preventDefault() { }, stopPropagation() { },
            };
            try {
                for (const fn of listeners) { try { await fn(fake); } catch (e) { /* 与 V1 委托同容错 */ } }
            } finally { panel.classList.contains = keepContains; }
        };
        const htmlHas = (s) => String(panel.innerHTML || '').indexOf(s) >= 0;
        const scanToast = () => pluginToasts(F).map((t) => ({ kind: t.kind, title: t.title, text: t.text }));
        const steps = [];
        const step = async (name, ds, cls, extra) => {
            const t0 = pluginToasts(F).length;
            await clickFake(ds, cls);
            const o = {
                ds: ds,
                toasts: pluginToasts(F).slice(t0).map((t) => ({ kind: t.kind, title: t.title, text: t.text })),
                wl: proj(F.cfg.feedRegexWhitelist), bl: proj(F.cfg.feedRegexBlacklist),
            };
            Object.assign(o, extra ? extra() : {});
            steps.push(Object.assign({ name }, o));
        };
        await step('切到设定页', { fttTab: 'settings' }, ['ftt-tab'], () => ({ tab: 'settings' }));
        await step('切到「投喂范围」子页', { fttSubtab: 'feed' }, ['ftt-subtab'], () => ({ sub: F.settingsSubState() }));
        steps[steps.length - 1].scanIdle = htmlHas('尚未分析');
        await step('rxScanTags（有正文）', { fttAction: 'rxScanTags' }, [], () => ({
            scanFloor: htmlHas('第 1 楼 AI 正文'),
            hasAddBtns: htmlHas('data-ftt-action="rxAddTag"'),
            onWhite: htmlHas('ftt-chip-btn--on-w'),
        }));
        await step('rxAddTag 白 content', { fttAction: 'rxAddTag', fttKind: 'white', fttTag: 'content' }, [], () => ({ onWhite: htmlHas('ftt-chip-btn--on-w') }));
        await step('rxAddTag 白 content（重复）', { fttAction: 'rxAddTag', fttKind: 'white', fttTag: 'content' }, [], () => ({ onWhite: htmlHas('ftt-chip-btn--on-w') }));
        await step('rxAddTag 黑 战斗', { fttAction: 'rxAddTag', fttKind: 'black', fttTag: '【战斗】' }, [], () => ({ onBlack: htmlHas('ftt-chip-btn--on-b') }));
        await step('rxAddTag 无 kind（默认 white）', { fttAction: 'rxAddTag', fttTag: '状态' }, []);
        await step('rxAddTag 空标签', { fttAction: 'rxAddTag', fttKind: 'white', fttTag: '  ' }, []);
        await step('rxScanClear', { fttAction: 'rxScanClear' }, [], () => ({ scanIdle: htmlHas('尚未分析'), hasAddBtns: htmlHas('data-ftt-action="rxAddTag"') }));
        result.actionFlow = { steps };
        result.actionFlow.scanToastSample = scanToast().slice(-1)[0] || null;
    }

    // ---------------- 九、无正文时的动作提示 ----------------
    {
        const { F, env } = await bootWith('userOnly');
        F.openPanel();
        const panel = env.parentWin.document.body.children.find(c => c.id === 'ftt-panel');
        panel.classList.contains = (c) => c === 'ftt-open' || c === 'ftt-tab';
        const listeners = (panel.listeners && panel.listeners.click) ? panel.listeners.click : [];
        const clickFake = async (ds, cls) => {
            const classes = ['ftt-open'].concat(cls || []);
            const fake = {
                target: { dataset: ds, classList: { contains: (c) => classes.indexOf(c) >= 0 }, closest: () => panel, tagName: 'A' },
                preventDefault() { }, stopPropagation() { },
            };
            for (const fn of listeners) { try { await fn(fake); } catch (e) { } }
        };
        const t0 = pluginToasts(F).length;
        await clickFake({ fttAction: 'rxScanTags' }, []);
        result.noTextAction = {
            toasts: pluginToasts(F).slice(t0).map((t) => ({ kind: t.kind, title: t.title, text: t.text })),
            scanHtmlHasWarn: String(panel.innerHTML || '').indexOf('未取到最近一条 AI 正文') >= 0,
        };
    }

    // ---------------- 十、原生怪癖记录 ----------------
    result.meta.notes.unshift('本 fixture 由 tests/fixtures/gen-v1-golden-feed-scan.cjs **直调真实 V1 插件 v1.206** 生成'
        + '（`node tests/fixtures/gen-v1-golden-feed-scan.cjs tests/fixtures/v1-golden-feed-scan.json`，连跑两次逐字节一致；'
        + '`ts` 为 Date.now()，已在投影中删除）。其中 rxScanTags / rxAddTag / rxScanClear / 切页 / 切设定子页 走**真实点击委托**'
        + '（openPanel() 后在 panel.listeners.click 上派发伪事件 → V1 handleAction 真实执行）；'
        + 'latestAiFloorInfo / rxAnalyzeLatestText / rxNormTag / rxDedupeTagList / rxPushFeedTag / rxTagScanHtml 直接调 __FTT 导出函数；'
        + '设定页静态片段取自 V1 导出函数 F.settingsHtml()（setSettingsSub(\'feed\') 后构建）。');
    result.meta.notes.push('V1 原生怪癖（oracle 实测，原样保留）：'
        + '① `latestAiFloorInfo` 只回溯 **60 楼**（`i >= last - 60`），AI 正文更早时视为「无正文」（fixture 的 far 场景：last=70、正文在 5 楼 → floor=-1）。'
        + '② 空白正文楼、隐藏楼、`role` 非 assistant 的楼都会被跳过（normal 场景落到第 1 楼）。'
        + '③ `rxPushFeedTag` 对**未知 kind** 一律按 `white` 处理（`isBlack = kind === \'black\'`）。'
        + '④ `rxPushFeedTag` 的 `saveCfg()` 被 try/catch 包住，落盘失败也不影响内存写入与返回值。'
        + '⑤ `rxTagScanHtml` 对已收录标签只做**高亮**（`ftt-chip-btn--on-w/-b`），不阻止重复点击（重复点击由 `rxPushFeedTag` 的 dup 分支回报）。'
        + '⑥ 结果缓存在模块级 `rxTagScan`（跨 `renderPanel` 保留），只有 `rxScanClear` 或再次分析才改变；`ts` 为 `Date.now()`（黄金样本中归一为删除）。'
        + '⑦ 设定页的「投喂白/黑名单」文本域用的 `data-ftt-cfg` 是别名 `rx_whitelist` / `rx_blacklist`，'
        + '由 `settingsApplyAll` 映射到 `cfg.feedRegexWhitelist` / `cfg.feedRegexBlacklist` 并在保存时 `rxDedupeTagList(value.split(\'\\n\'))` 整表排重。');
    result.meta.notes.push('设定页静态片段取自 V1 导出函数 `F.settingsHtml()`（`setSettingsSub(\'feed\')` 后构建），非手写。');

    if (savedRaf === undefined) delete g.requestAnimationFrame; else g.requestAnimationFrame = savedRaf;
    result.meta.v1Version = 'v1.206';
    return result;
}

main().then((r) => {
    const text = JSON.stringify(r, null, 2) + '\n';
    if (OUT) fs.writeFileSync(OUT, text);
    realStdoutWrite(text);
    process.exit(0);
}).catch((e) => { process.stderr.write('ORACLE FAIL: ' + ((e && e.stack) || e) + '\n'); process.exit(2); });
