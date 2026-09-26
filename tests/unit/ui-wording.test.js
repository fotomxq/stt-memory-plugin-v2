// ============================================================
// 单元测试 · v2.60.0「全站页面提示体检：去罗嗦 / 去历史 / 措辞一致」
//
// 用户要求：「检查 V2 插件页面中存在**多余提示**的内容，精简确保**措辞一致性**，避免**罗嗦、历史等多余内容**。」
//
// 本测试把「页面提示」当门禁来跑：渲染**所有**面板分页与设定子页，逐页检查四件事 ——
//   ① 不含开发/历史字样（V1 / v1.2xx / docs 路径 / 批次 / 黄金样本 / oracle / 逐字 / 同键 / 适配 / 未实现 …）；
//   ② 不出现 Markdown 粗体字面量 `**…**`（浏览器会把星号原样显示 —— 统一走 `ui/hints.js#mdBold` 或 `<b>`）；
//   ③ 每条提示 ≤ 90 字（**折叠块与状态行不计**：折叠块默认收起、状态行是数据不是提示）；
//   ④ 同一页面内不出现**完全重复**的提示文案（复制粘贴留下的重复句）。
// 排除项（有意保留，逐条给理由）：折叠说明 `<details>` 内容、注入/模板文本域内容、代码站点与文件名、
//   调试页的类别标签（含「内核」）、关系表等数据行。
// 运行：node tests/unit/ui-wording.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import * as settings from '../../ui/settings-pages.js';
import * as panel from '../../ui/panel.js';

const R = makeReporter('ui-wording v2.60.0 全站页面提示体检');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
installGlobalHost(makeHost({}), doc);
setKernelState(emptyState());
setScopeKey('char:wording');
globalThis.window = Object.assign({}, globalThis.window, { localStorage: { getItem: () => null, setItem: () => true, removeItem: () => true, clear: () => true } });

/** 去掉折叠块 / 文本域 / 输入值（这些不是「页面提示」） */
function hintsOnly(html) {
    let h = String(html);
    for (let i = 0; i < 20; i++) h = h.replace(/<details[\s\S]*?<\/details>/g, ' ');
    h = h.replace(/<textarea[\s\S]*?<\/textarea>/g, ' ');
    h = h.replace(/\svalue="[^"]*"/g, ' ');
    return h;
}
const strip = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** 页面上的提示块文本（`ftt-muted` / `ftt-hint` div） */
function hintBlocks(html) {
    const out = [];
    const re = /<div class="ftt-(?:muted|hint)[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = re.exec(String(html)))) {
        const full = m[0];
        // 状态行/数据行不是提示
        if (/data-ftt-(state-file-status|sync-log-status|slim-gzip|forget-state|last-extract-line|vector-cache|nsfw-state|nsfw-rule-state|clock-src|clock-trace|layers)/.test(full)) continue;
        const text = strip(m[1]);
        if (text) out.push({ text, html: full });
    }
    return out;
}

const DEV_PATTERNS = [
    { re: /V1/, why: '历史版本引用' },
    { re: /V2\s*适配|适配差异|V2 现阶段|见 docs\/|docs\//, why: '开发/文档引用' },
    { re: /v1\.\d+/, why: '历史版本号' },
    { re: /批次接入|后续批次|按批次推进|批次纪律/, why: '开发批次' },
    { re: /黄金样本|oracle|逐字/, why: '测试/实现口径' },
    { re: /同键|同名同序/, why: '实现映射' },
    { re: /未实现|尚未实现|后续批次/, why: '开发进度' },
    { re: /命名取自|全量登记表/, why: '实现细节' },
    { re: /内核 (配置|键)/, why: '内部术语' },
];

/** 渲染所有页面（面板 13 分页 + 设定 14 子页，均走真实渲染路径） */
async function collectPages() {
    const pages = [];
    panel.openPanel('overview');
    for (const t of panel.panelTabs()) {
        const id = String((t && t.id) || t);
        await panel.panelAction('tab', { tab: id });
        pages.push(['panel:' + id, panel.panelBodyHtml(id)]);
    }
    await panel.panelAction('tab', { tab: 'settings' });
    for (const t of settings.SETTINGS_TABS) {
        await panel.panelAction('settingsSub', { sub: t.id });
        pages.push(['settings:' + t.id, panel.panelBodyHtml('settings')]);
    }
    await panel.panelAction('tab', { tab: 'overview' });
    return pages;
}

const pages = await collectPages();
A('P0 体检覆盖面：面板 13 分页 + 设定 14 子页全部渲染成功（不是抽样）', pages.length === 27
    && pages.every((p) => String(p[1]).length > 100), J(pages.map((p) => p[0])));

// ---- D 组：开发 / 历史内容 ----
A('D1 全站页面不含开发与历史字样（V1 引用 / v1.x / docs 路径 / 批次 / 黄金样本 / 同键 / 未实现 …）', (() => {
    const bad = [];
    for (const [id, html] of pages) {
        const text = strip(hintsOnly(html));
        for (const p of DEV_PATTERNS) {
            const m = text.match(p.re);
            if (m) bad.push(id + ' → ' + p.why + '：' + text.slice(Math.max(0, m.index - 20), m.index + 40));
        }
    }
    return bad.length === 0;
})(), (() => {
    const bad = [];
    for (const [id, html] of pages) {
        const text = strip(hintsOnly(html));
        for (const p of DEV_PATTERNS) { const m = text.match(p.re); if (m) bad.push(id + ':' + p.why); }
    }
    return J(bad.slice(0, 8));
})());

// ---- B 组：措辞一致性（Markdown 粗体字面量） ----
A('B1 全站页面不出现字面量 `**…**`（统一用 `<b>` / `mdBold`，避免星号原样显示）', (() => {
    const bad = [];
    for (const [id, html] of pages) {
        const hits = strip(hintsOnly(html)).match(/\*\*[^*]{1,60}\*\*/g);
        if (hits) bad.push(id + '：' + hits.slice(0, 2).join(' '));
    }
    return bad.length === 0;
})(), (() => {
    const bad = [];
    for (const [id, html] of pages) { const hits = strip(hintsOnly(html)).match(/\*\*[^*]{1,60}\*\*/g); if (hits) bad.push(id + ':' + hits[0]); }
    return J(bad.slice(0, 8));
})());

// ---- L 组：罗嗦（单条提示长度） ----
A('L1 每条页面提示 ≤ 90 字（折叠说明与状态行不计；超出说明该写进 `hintDetailsHtml`）', (() => {
    const bad = [];
    for (const [id, html] of pages) for (const b of hintBlocks(hintsOnly(html))) if (b.text.length > 90) bad.push(id + '(' + b.text.length + ')：' + b.text.slice(0, 50));
    return bad.length === 0;
})(), (() => {
    const bad = [];
    for (const [id, html] of pages) for (const b of hintBlocks(hintsOnly(html))) if (b.text.length > 90) bad.push(id + '=' + b.text.length);
    return J(bad.slice(0, 10));
})());

A('L2 统计口径：全站页面提示条数与最长提示（体检可见，便于回归对比）', (() => {
    let n = 0, max = 0, where = '';
    for (const [id, html] of pages) for (const b of hintBlocks(hintsOnly(html))) { n += 1; if (b.text.length > max) { max = b.text.length; where = id; } }
    return n >= 20 && max <= 90 && !!where;
})(), (() => {
    let n = 0, max = 0, where = '';
    for (const [id, html] of pages) for (const b of hintBlocks(hintsOnly(html))) { n += 1; if (b.text.length > max) { max = b.text.length; where = id; } }
    return J({ blocks: n, max, where });
})());

// ---- R 组：重复文案（复制粘贴留下的整句重复） ----
A('R1 同一页面内不出现完全重复的提示整句', (() => {
    const bad = [];
    for (const [id, html] of pages) {
        const seen = new Set();
        for (const b of hintBlocks(hintsOnly(html))) {
            if (b.text.length < 20) continue;
            if (seen.has(b.text)) bad.push(id + '：' + b.text.slice(0, 40));
            seen.add(b.text);
        }
    }
    return bad.length === 0;
})(), '见断言');

// ---- S 组：折叠说明仍然可用（精简不能把信息删光） ----
A('S1 被精简掉的长说明已改由折叠说明承载：全站 `<details class="ftt-details ftt-hint-details">` ≥ 8 处', (() => {
    let n = 0;
    for (const [, html] of pages) n += (String(html).match(/ftt-hint-details/g) || []).length;
    return n >= 8;
})(), J((() => { let n = 0; for (const [, html] of pages) n += (String(html).match(/ftt-hint-details/g) || []).length; return n; })()));

R.done();
