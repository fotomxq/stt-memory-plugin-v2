// ============================================================
// 单元测试 · v2.72.0「设定 → 投喂范围：UI 布局优化分组」
//
// 用户要求：「新版本，设定的**投喂范围**，UI 布局做**优化分组**。」
//
// 修复前：`settingsPageHtml('feed')` 把 37 个控件**平铺**成一长条（无分节标题；四域修复参数还各自重复
//   「概念修复…」「记忆修复…」前缀），用户要滚很久才能找到一项。
//
// 本批（`ui/settings-pages.js#feedPageHtml` + `style.css`）：按用途分节 + 组内短标签：
//   ① 📥 投喂楼层 →（紧跟）🏷 投喂标签自动分析 / 投喂白名单标签 / 投喂黑名单标签（同属「投什么进分析」）
//   ② 🛠 自动修复（总开关与节奏）③ 🎯 候选筛选 ④ 🧑 角色修复
//   ⑤ 🧩 各域相关组修复（概念 / 记忆 / 悬念 / 物品 四个**子组**，前缀挪进子组标题）
//   ⑥ 🧹 低调用清理
//   **控件键一个不少**（`SETTINGS_CONTROLS.feed` 与渲染结果双向一致）；控件表本身保持 V1 原样。
//
// 运行：node tests/unit/feed-grouping.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { SETTINGS_CONTROLS, settingsPageHtml, feedPageHtml, settingsControlHtml } from '../../ui/settings-pages.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const R = makeReporter('feed-grouping v2.72.0 投喂范围分组');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', '..', 'style.css'), 'utf8');

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
setScopeKey('甲');
setKernelState(emptyState());
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

const HTML = settingsPageHtml('feed');
const secTitles = (h) => Array.from(String(h).matchAll(/<div class="ftt-sec-title">([^<]*)<\/div>/g)).map((m) => m[1]);
const subTitles = (h) => Array.from(String(h).matchAll(/<div class="ftt-group-title">([^<]*)<\/div>/g)).map((m) => m[1]);
const cfgKeys = (h) => Array.from(String(h).matchAll(/data-ftt-cfg="([^"]+)"/g)).map((m) => m[1]);
const at = (h, s) => String(h).indexOf(s);

A('G1 分组结构：投喂楼层 → 标签范围（扫描/白/黑名单）→ 自动修复 → 候选筛选 → 角色修复 → 各域修复 → 低调用清理', (() => {
    const t = secTitles(HTML);
    return J(t) === J(['📥 投喂楼层', '投喂标签自动分析', '投喂白名单标签（只保留含这些标签的行，每行一个标签名）',
        '投喂黑名单标签（屏蔽含这些标签的行，每行一个标签名）', '🛠 自动修复（总开关与节奏）',
        '🎯 候选筛选（相关性阈值与抽查）', '🧑 角色修复', '🧩 各域相关组修复', '🧹 低调用清理（物品）']);
})(), J(secTitles(HTML)));

A('G2 五节顺序稳定：每节标题按用途先后出现（楼层 → 标签 → 修复三段 → 清理）', (() => {
    const order = ['📥 投喂楼层', '投喂标签自动分析', '投喂白名单标签', '投喂黑名单标签', '🛠 自动修复', '🎯 候选筛选', '🧑 角色修复', '🧩 各域相关组修复', '🧹 低调用清理'];
    const idx = order.map((s) => at(HTML, s));
    return idx.every((v) => v >= 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]);
})(), '见断言');

A('G3 子组层次：「各域相关组修复」下按 概念 / 记忆 / 悬念 / 物品 四组，用 `.ftt-group-title` 两级标题', (() => {
    return J(subTitles(HTML)) === J(['概念修复', '记忆修复', '悬念修复', '物品修复'])
        && HTML.indexOf('ftt-group-title') > 0
        && at(HTML, '🧩 各域相关组修复') < at(HTML, '概念修复')
        && at(HTML, '概念修复') < at(HTML, '记忆修复') && at(HTML, '记忆修复') < at(HTML, '悬念修复')
        && at(HTML, '悬念修复') < at(HTML, '物品修复')
        && at(HTML, '物品修复') < at(HTML, '🧹 低调用清理');
})(), J(subTitles(HTML)));

A('G4 控件一个不少：37 个控件键全部渲染且只出现一次（+ 白/黑名单两个文本域 = 39）', (() => {
    const need = SETTINGS_CONTROLS.feed.map((c) => String(c.key));
    const got = cfgKeys(HTML);
    const miss = need.filter((k) => got.indexOf(k) < 0);
    const dup = need.filter((k) => got.filter((x) => x === k).length !== 1);
    return need.length === 37 && miss.length === 0 && dup.length === 0 && got.length === 39;
})(), J({ need: SETTINGS_CONTROLS.feed.length, got: cfgKeys(HTML).length }));

A('G5 组内短标签：子组的四个旋钮不再重复「概念/记忆/悬念/物品 修复」前缀（表内 V1 标签不动）', (() => {
    const sims = ['conceptRepairSim', 'memoryRepairSim', 'suspenseRepairSim', 'itemRepairSim'];
    const rendered = sims.map((k) => {
        const i = HTML.indexOf('data-ftt-cfg="' + k + '"');
        return HTML.slice(Math.max(0, i - 120), i);
    });
    // 渲染层：标签为「相关性阈值（0.1-0.95，默认 0.45）」（前缀在子组标题里）
    const shortOk = rendered.every((seg) => seg.indexOf('相关性阈值（0.1-0.95，默认 0.45）') > 0 && seg.indexOf('修复相关性阈值') < 0);
    // 控件表（V1 原样）：仍带「<域>修复相关性阈值」前缀
    const tableOk = sims.every((k) => String(SETTINGS_CONTROLS.feed.filter((c) => c.key === k)[0].label).indexOf('修复相关性阈值') > 0);
    return shortOk && tableOk
        && HTML.indexOf('相关性阈值（0.1-0.95，默认 0.45）') > 0
        && settingsControlHtml(SETTINGS_CONTROLS.feed.filter((c) => c.key === 'memoryRepairSim')[0]).indexOf('记忆修复相关性阈值') > 0;
})(), '见断言');

A('G6 每节一句短提示（≤90 字），细节不再铺在页面上', (() => {
    const hints = [];
    const re = /<div class="ftt-muted" data-ftt-short-hint>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = re.exec(HTML)) !== null) hints.push(String(m[1]).replace(/<[^>]+>/g, '').trim());
    // 六节各一句（楼层 / 自动修复 / 候选筛选 / 角色修复 / 各域修复 / 低调用清理）
    return hints.length === 6 && hints.every((t) => t.length > 0 && t.length <= 90)
        && hints[0].indexOf('最近 N 楼') > 0 && hints.some((t) => t.indexOf('相关性') >= 0)
        && hints.some((t) => t.indexOf('清理') >= 0) && hints.every((t) => t.indexOf('V1') < 0);
})(), '见断言');

A('G7 危险/空映射兜底：未登记的键会落到末节「其它」（当前为零 —— 分组表已覆盖全部 37 项）', (() => {
    const extra = feedPageHtml([{ key: 'zzzNotMapped', label: '未知项', type: 'text' }], { tagSections: () => '' });
    const normal = feedPageHtml(SETTINGS_CONTROLS.feed, { tagSections: () => '' });
    return extra.indexOf('其它') > 0 && extra.indexOf('data-ftt-cfg="zzzNotMapped"') > 0
        && normal.indexOf('其它') < 0 && cfgKeys(normal).length === 37;
})(), '见断言');

A('G8 样式：`.ftt-group-title` 提供两级层次（左侧色条 + 紧凑间距），`.ftt-section` 仍是节容器', (() => {
    return /#ftt-panel \.ftt-group-title \{[^}]*border-left: 3px solid var\(--ftt-accent\)[^}]*\}/.test(CSS)
        && /#ftt-panel \.ftt-group-title \{[^}]*margin: 10px 0 4px/.test(CSS)
        && CSS.indexOf('#ftt-panel .ftt-section ') > 0;
})(), '见断言');

A('G9 标签范围节保持 V1 形态与相邻关系（扫描 → 白名单 → 黑名单，文本域仍是 V2 规范键）', (() => {
    const iScan = at(HTML, '<div class="ftt-section"><div class="ftt-sec-title">投喂标签自动分析</div>');
    const iWl = at(HTML, '<div class="ftt-section"><div class="ftt-sec-title">投喂白名单标签');
    const iBl = at(HTML, '<div class="ftt-section"><div class="ftt-sec-title">投喂黑名单标签');
    return iScan >= 0 && iWl > iScan && iBl > iWl
        && HTML.indexOf('data-ftt-action="rxScanTags"') > 0
        && HTML.indexOf('data-ftt-cfg="feedRegexWhitelist"') > iWl
        && HTML.indexOf('data-ftt-cfg="feedRegexBlacklist"') > iBl
        && at(HTML, 'data-ftt-cfg="feedFloors"') < iScan;
})(), '见断言');

R.done();
