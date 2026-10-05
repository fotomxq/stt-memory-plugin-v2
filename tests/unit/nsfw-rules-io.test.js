// ============================================================
// 单元测试 · v3.21.0「NSFW弱化的转化库新增支持导出和导入」
//
// 用户要求（原话）：「NSFW弱化的转化库新增支持导出和导入。」
//
// 口径（`core/nsfw.js` + `ui/nsfw.js`）：
//   · 导出 = 当前**生效**转化库（`nsfwRuleList()`：自定义非空用它，否则内置）→ 带信封的 JSON
//     （`kind` 防止误导入别的库、`schema` 备将来换格式、`count`/`rules` 为数据本体）；
//   · 导入 = **合并**（只新增，不覆盖既有匹配词、绝不删除）—— 逐条走 `nsfwRuleAdd()`，
//     与「手工新增」同一套修剪/长度上限/大小写不敏感去重口径；
//   · 宽容解析：信封 / 裸数组 / `{rules|nsfwRules|…}` / 逐行「匹配词→转化词」/ 字段别名；
//   · 如实回报：新增 / 已在库 / 缺词 / 格式不合格 / 写入失败 / 超长截断 各自计数。
//
// 覆盖：A 导出信封与文本；B 合并语义（不覆盖、去重、不删除）；C 宽容解析与计数；
//       D 失败路径（空 / 非清单 / 没规则数组 / kind 不符）且**不改动库**；E 界面动作（真实下载 / 粘贴 / 选文件）。
// 运行：node tests/unit/nsfw-rules-io.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    nsfwRuleList, nsfwRulesCustomized, nsfwRuleAdd, nsfwRulesExportPayload, nsfwRulesExportText,
    nsfwRulesParseImport, nsfwRulesImportText,
} from '../../core/nsfw.js';
import { nsfwPageHtml, nsfwAction, nsfwRuleIoReset, NSFW_ACTIONS } from '../../ui/nsfw.js';

const R = makeReporter('nsfw-rules-io v3.21.0 转化库导出 / 导入（合并）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({});
installGlobalHost(host, doc);

let cfgSaves = 0;
function boot(customRules) {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char-nsfw-io');
    setLastMessageId(3);
    setKernelState(emptyState());
    setPersistHooks({ saveState: () => true, saveCfg: () => { cfgSaves++; return true; }, log: () => undefined, warn: () => undefined });
    cfg.nsfwRules = clone(customRules || []);
    nsfwRuleIoReset();
    return state;
}
const libOf = () => nsfwRuleList().map((r) => r.from + '→' + r.to);

// ---------- A 组：导出 ----------
A('A1 导出信封：app / kind / schema / count / rules 齐备，`rules` 与**生效库**逐条一致', (() => {
    boot([]);
    const p = nsfwRulesExportPayload(0);
    const lib = nsfwRuleList();
    return p.app === 'ftt-memory-v2' && p.kind === 'nsfwRules' && p.schema === 1
        && p.count === lib.length && p.rules.length === lib.length
        && p.rules.every((r, i) => r.from === lib[i].from && r.to === lib[i].to)
        && /^\d{4}-\d{2}-\d{2}T/.test(String(p.exportedAt));
})(), () => J(nsfwRulesExportPayload(0)).slice(0, 200));

A('A2 `source` 如实区分内置 / 自定义；导出文本是合法 JSON 且可原样解析回来', (() => {
    boot([]);
    const builtin = nsfwRulesExportPayload(0);
    boot([{ from: '甲', to: '甲改' }]);
    const custom = nsfwRulesExportPayload(0);
    const text = nsfwRulesExportText();
    const parsed = JSON.parse(text);
    const back = nsfwRulesParseImport(text);
    return builtin.source === 'builtin' && custom.source === 'custom'
        && parsed.kind === 'nsfwRules' && Array.isArray(parsed.rules)
        && back.ok === true && back.list.length === 1 && back.mode === 'json';
})(), '');

A('A3 自定义为空时导出的是**内置**库（不是空库）；自定义非空时导出**自定义**库（不掺内置）', (() => {
    boot([]);
    const n1 = nsfwRulesExportPayload(0).count;
    boot([{ from: '甲', to: '甲改' }, { from: '乙', to: '乙改' }]);
    const p2 = nsfwRulesExportPayload(0);
    return n1 > 100 && p2.count === 2 && J(p2.rules) === J([{ from: '甲', to: '甲改' }, { from: '乙', to: '乙改' }]);
})(), '');

// ---------- B 组：导入合并（只新增，不覆盖、不删除） ----------
A('B1 合并：已在库的匹配词**跳过且不覆盖**原文（`to` 保持既有），新匹配词才新增', (() => {
    boot([{ from: '甲', to: '甲改' }, { from: '乙', to: '乙改' }]);
    const r = nsfwRulesImportText(JSON.stringify([{ from: '甲', to: '别的' }, { from: '丙', to: '丙改' }]));
    const lib = libOf();
    return r.ok === true && r.added === 1 && r.dup === 1 && r.total === 3
        && lib.indexOf('甲→甲改') >= 0 && lib.indexOf('乙→乙改') >= 0 && lib.indexOf('丙→丙改') >= 0
        && lib.indexOf('甲→别的') < 0;
})(), () => J({ r: nsfwRulesImportText('[]'), lib: libOf() }));

A('B2 匹配词去重**大小写不敏感**（与手工新增同口径）；导入**绝不删除**既有条目', (() => {
    boot([{ from: 'ABC', to: 'x' }, { from: '丁', to: '丁改' }]);
    const before = libOf().length;
    const r = nsfwRulesImportText(JSON.stringify([{ from: 'abc', to: 'y' }, { from: '戊', to: '戊改' }]));
    const lib = libOf();
    return r.added === 1 && r.dup === 1 && lib.length === before + 1
        && lib.indexOf('ABC→x') >= 0 && lib.indexOf('丁→丁改') >= 0 && lib.indexOf('戊→戊改') >= 0;
})(), () => J(libOf()));

A('B3 内置默认状态下导入 → 先物化内置库再追加（不丢内置），并标记为自定义', (() => {
    boot([]);
    const builtinCount = nsfwRuleList().length;
    const r = nsfwRulesImportText(JSON.stringify([{ from: '己', to: '己改' }]));
    return r.added === 1 && r.total === builtinCount + 1 && nsfwRulesCustomized() === true && libOf().indexOf('己→己改') >= 0;
})(), '');

A('B4 重复导入同一份导出文本 → 全部按「已在库」跳过（幂等，不产生重复条目）', (() => {
    boot([{ from: '庚', to: '庚改' }]);
    const text = nsfwRulesExportText();
    const r1 = nsfwRulesImportText(text);
    const after1 = libOf().length;
    const r2 = nsfwRulesImportText(text);
    return r1.added === 0 && r1.dup === 1 && r2.added === 0 && r2.dup === 1 && libOf().length === after1;
})(), '');

// ---------- C 组：宽容解析与计数 ----------
A('C1 宽容解析：裸数组 / `{rules}` / `{nsfwRules}` / `{list}` / 中文键 `规则` 都认', (() => {
    const forms = [
        [{ from: '甲', to: 'x' }],
        { rules: [{ from: '甲', to: 'x' }] },
        { nsfwRules: [{ from: '甲', to: 'x' }] },
        { list: [{ from: '甲', to: 'x' }] },
        { 规则: [{ from: '甲', to: 'x' }] },
    ];
    return forms.every((f) => { const p = nsfwRulesParseImport(J(f)); return p.ok && p.list.length === 1; });
})(), '');

A('C2 字段别名逐条认（match/replace、匹配词/替换词、source/target、词/转化词）与字符串条目「甲→乙」', (() => {
    const forms = [
        [{ match: '甲', replace: 'x' }],
        [{ 匹配词: '甲', 替换词: 'x' }],
        [{ source: '甲', target: 'x' }],
        [{ 词: '甲', 转化词: 'x' }],
        ['甲→x'], ['甲->x'], ['甲=>x'],
    ];
    boot([]);
    return forms.every((f) => {
        boot([{ from: '占位', to: '占位' }]);
        const r = nsfwRulesImportText(J(f));
        return r.ok === true && r.added === 1 && libOf().indexOf('甲→x') >= 0;
    });
})(), '');

A('C3 逐行文本模式：`#` 注释与空行跳过，`→` / `->` / 制表符都认（一条都没成形 → 报错，不伪装成功）', (() => {
    boot([{ from: '占位', to: '占位' }]);
    const r = nsfwRulesImportText('# 这是注释\n\n甲→甲改\n乙 -> 乙改\n丙\t丙改\n');
    const bad = nsfwRulesImportText('这不是清单\n随便两行字\n');
    return r.ok === true && r.added === 3 && r.mode === 'lines'
        && libOf().indexOf('甲→甲改') >= 0 && libOf().indexOf('乙→乙改') >= 0 && libOf().indexOf('丙→丙改') >= 0
        && bad.ok === false && bad.reason === 'bad-json';
})(), () => J({ r: nsfwRulesImportText('甲→甲改'), lib: libOf() }));

A('C4 如实计数：缺匹配词/转化词 → `empty`；不是对象/数组 → `shape`；超长 → 截断并计数（`from` 存 40 字上限）', (() => {
    boot([{ from: '占位', to: '占位' }]);
    const long = 'x'.repeat(60);
    const r = nsfwRulesImportText(J([
        { from: '甲', to: '甲改' },          // ✓ 新增
        { from: '乙' },                      // ✗ 缺转化词
        { to: '丙改' },                      // ✗ 缺匹配词
        123,                                 // ✗ 格式不合格（数字无分隔符）
        null,                                // ✗ 格式不合格
        { from: long, to: '长改' },          // ✓ 新增但截断
        { from: '丁', to: long },            // ✓ 新增但截断
    ]));
    const stored = nsfwRuleList().find((x) => x.to === '长改');
    return r.ok === true && r.added === 3 && r.empty === 2 && r.shape === 2 && r.truncated === 2 && r.total === 4
        && stored && stored.from.length === 40;
})(), () => J(nsfwRulesImportText('[]')));

// ---------- D 组：失败路径（且**不改动**库） ----------
A('D1 空文本 → `empty`；非 JSON 且非清单 → `bad-json`；JSON 但没有规则数组 → `shape`；kind 不符 → `kind`（四种都零副作用）', (() => {
    boot([{ from: '甲', to: '甲改' }]);
    const before = J(cfg.nsfwRules);
    const a = nsfwRulesImportText('');
    const b = nsfwRulesImportText('随便一段文字，没有箭头');
    const c = nsfwRulesImportText('{"a":1}');
    const d = nsfwRulesImportText(JSON.stringify({ kind: 'otherLib', rules: [{ from: '乙', to: '乙改' }] }));
    return a.ok === false && a.reason === 'empty'
        && b.ok === false && b.reason === 'bad-json'
        && c.ok === false && c.reason === 'shape'
        && d.ok === false && d.reason === 'kind'
        && J(cfg.nsfwRules) === before;
})(), () => J({ a: nsfwRulesImportText(''), d: nsfwRulesImportText('{"kind":"x","rules":[]}') }));

A('D2 解析失败时如实给出「当前生效条数」，界面文案能直接复用（不返回 undefined 计数）', (() => {
    boot([{ from: '甲', to: '甲改' }]);
    const r = nsfwRulesImportText('{ 坏掉的 JSON');
    return r.ok === false && r.total === 1 && r.added === 0 && r.dup === 0 && Array.isArray(r.samples);
})(), () => J(nsfwRulesImportText('{ 坏掉的 JSON')));

// ---------- E 组：界面动作（真实下载 / 粘贴导入 / 选文件导入） ----------
A('E1 页面：转化库分节有两个入口按钮 + 状态行；未点开时不渲染导入框', (() => {
    boot([{ from: '甲', to: '甲改' }]);
    const html = String(nsfwPageHtml() || '');
    return html.indexOf('data-ftt-action="nsfwRuleExport"') >= 0
        && html.indexOf('data-ftt-action="nsfwRuleImportOpen"') >= 0
        && html.indexOf('data-ftt-nsfw-rule-io-state') >= 0
        && html.indexOf('data-ftt-nsfw-rule-import') < 0
        && NSFW_ACTIONS.indexOf('nsfwRuleExport') >= 0 && NSFW_ACTIONS.indexOf('nsfwRuleImportApply') >= 0
        && NSFW_ACTIONS.indexOf('nsfwRuleImportFile') >= 0 && NSFW_ACTIONS.indexOf('nsfwRuleImportClose') >= 0;
})(), () => String(nsfwPageHtml() || '').slice(0, 160));

A('E2 `nsfwRuleExport`：真实下载一个 `FTT转化库_*.json` 文件 + 复制到剪贴板 + 页面渲染出导出文本框', (async () => {
    boot([{ from: '甲', to: '甲改' }]);
    const saveCreate = doc.createElement;
    const saveURL = globalThis.URL;
    const saveBlob = globalThis.Blob;
    const savedNav = globalThis.navigator;
    const downloads = [];
    try {
        globalThis.Blob = function (parts) { this.parts = parts; };
        globalThis.URL = { createObjectURL: () => 'blob:test-1', revokeObjectURL: () => { } };
        globalThis.navigator = { clipboard: { writeText: async () => { } } };
        doc.createElement = (tag) => ({
            tagName: String(tag).toUpperCase(), style: {}, dataset: {}, listeners: {},
            click() { downloads.push({ download: this.download, href: this.href }); },
            remove() { },
        });
        const r = await nsfwAction('nsfwRuleExport', {});
        const html = String(nsfwPageHtml() || '');
        return r.ok === true && r.count === 1 && r.downloaded === true && r.copied === true
            && /^FTT转化库_\d{8}-\d{6}\.json$/.test(String(r.filename))
            && downloads.length === 1 && downloads[0].download === r.filename
            && html.indexOf('data-ftt-nsfw-rule-export') >= 0 && html.indexOf('"kind": "nsfwRules"') >= 0;
    } finally {
        doc.createElement = saveCreate;
        if (saveURL === undefined) delete globalThis.URL; else globalThis.URL = saveURL;
        if (saveBlob === undefined) delete globalThis.Blob; else globalThis.Blob = saveBlob;
        if (savedNav === undefined) delete globalThis.navigator; else globalThis.navigator = savedNav;
    }
})(), '');

A('E3 `nsfwRuleImportOpen` 展开粘贴框（含三个按钮与合并口径说明）；`nsfwRuleImportClose` 收起且不动库', (async () => {
    boot([{ from: '甲', to: '甲改' }]);
    const open = await nsfwAction('nsfwRuleImportOpen', {});
    const htmlOpen = String(nsfwPageHtml() || '');
    const close = await nsfwAction('nsfwRuleImportClose', {});
    const htmlClose = String(nsfwPageHtml() || '');
    return open.ok === true && htmlOpen.indexOf('data-ftt-nsfw-rule-import') >= 0
        && htmlOpen.indexOf('data-ftt-action="nsfwRuleImportApply"') >= 0
        && htmlOpen.indexOf('data-ftt-action="nsfwRuleImportFile"') >= 0
        && htmlOpen.indexOf('不覆盖已有条目、不删除任何条目') >= 0
        && close.ok === true && htmlClose.indexOf('data-ftt-nsfw-rule-import') < 0 && libOf().length === 1;
})(), '');

A('E4 `nsfwRuleImportApply`（粘贴文本）：合并成功 → 落盘（`saveCfg`）+ 提示如实回报 + 收起导入框', (async () => {
    boot([{ from: '甲', to: '甲改' }]);
    cfgSaves = 0;
    const r = await nsfwAction('nsfwRuleImportApply', { text: J({ kind: 'nsfwRules', schema: 1, rules: [{ from: '辛', to: '辛改' }] }) });
    const html = String(nsfwPageHtml() || '');
    return r.ok === true && r.added === 1 && r.total === 2 && cfgSaves >= 1
        && String(r.note).indexOf('新增 1 条') >= 0 && String(r.note).indexOf('当前生效 2 条') >= 0
        && libOf().indexOf('辛→辛改') >= 0 && html.indexOf('data-ftt-nsfw-rule-import') < 0;
})(), '');

A('E5 `nsfwRuleImportApply`（空文本）：拒绝并如实说明，库一条不动、不落盘', (async () => {
    boot([{ from: '甲', to: '甲改' }]);
    cfgSaves = 0;
    const r = await nsfwAction('nsfwRuleImportApply', { text: '   ' });
    return r.ok === false && String(r.note).indexOf('导入失败') >= 0 && String(r.note).indexOf('文本框是空的') >= 0
        && libOf().length === 1 && cfgSaves === 0;
})(), '');

A('E6 `nsfwRuleImportFile`：走宿主文件选择器（真实 `<input type=file accept=.json>`）读取导出文本并合并', (async () => {
    boot([{ from: '甲', to: '甲改' }]);
    const text = nsfwRulesExportText();
    cfgSaves = 0;
    const saveCreate = doc.createElement;
    let fileInput = null;
    try {
        doc.createElement = (tag) => {
            const el = {
                tagName: String(tag).toUpperCase(), style: {}, dataset: {}, listeners: {}, files: null, accept: '', type: '',
                click() {
                    if (this.type !== 'file') return;
                    this.files = [{ name: '我的转化库.json', size: text.length, text: async () => text }];
                    if (typeof this.onchange === 'function') this.onchange();
                },
                remove() { this.removed = true; },
            };
            if (String(tag).toLowerCase() === 'input') fileInput = el;
            return el;
        };
        const r = await nsfwAction('nsfwRuleImportFile', {});
        return r.ok === true && String(r.note).indexOf('已读取文件 我的转化库.json') >= 0
            && !!fileInput && fileInput.type === 'file' && String(fileInput.accept).indexOf('.json') >= 0
            && r.fileName === '我的转化库.json';
    } finally {
        doc.createElement = saveCreate;
    }
})(), '');

R.done();
