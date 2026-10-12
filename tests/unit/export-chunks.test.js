// ============================================================
// 单元测试 · **导出的分段组装**（v3.45.7；用户报告「数据导出功能会直接卡死」）
//
// 真机取证：宿主同一份存档的主文件约 **10 MB**（`ftt.fileTransport.lastWrite.bytes = 10432694`）。
//   旧导出（`index.js#exportStateJson`）= `JSON.parse(JSON.stringify(state))` 深拷贝 + `JSON.stringify(…, null, 2)` 美化
//   + 整串进 `<textarea>` + 整串写剪贴板 —— 四件重活叠加，一点「导出」就卡死，且与数据量正相关。
//
// 本版口径（`core/export.js`）：
//   · **分段组装**（生成器逐段产出 JSON 片段）→ 分片可直接交给 `Blob(parts)`，**不拼一整串**；UI 可逐段让出主线程；
//   · 大存档**不美化**（`EXPORT_PRETTY_MAX` 以内仍给人读格式，历史行为不变）；
//   · 超过 `EXPORT_INLINE_MAX` **不进文本框、不写剪贴板**（判据 `exportInlineAllowed`）。
//
// 硬判据（本文件的 A 组）：**分段拼接与 `JSON.stringify(信封)` 逐字节相同** —— 语义与旧实现零差异。
// 运行：node tests/unit/export-chunks.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { setKernelState, setScopeKey, setPersistHooks, setLoadPhase } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import {
    EXPORT_FORMAT, EXPORT_INLINE_MAX, EXPORT_PRETTY_MAX,
    exportChunks, exportParts, exportTextOf, exportEnvelopeValue, exportSectionKeys, exportInlineAllowed,
} from '../../core/export.js';

const R = makeReporter('export-chunks v3.45.7 导出分段组装（不深拷贝 / 不美化大存档 / 不拼一整串）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const META = { version: '3.45.7', scope: 'char:ab12cd', at: 1791800000000 };

// ---------- A 组：逐字节等价（与旧实现语义零差异） ----------
A('A1 分段拼接 == `JSON.stringify(信封值)`（普通对象 / 空对象 / null / 数组 / 含 undefined 值的键 / 转义字符 / 嵌套）', (() => {
    const cases = [
        { atoms: [{ id: 'a1', text: '甲在码头' }], memories: [], vars: { a: 1 } },
        {},
        null,
        undefined,
        [1, 2, 3],
        { u: undefined, k: 1, z: undefined },
        { s: '引号"与\\反斜杠\n换行\t制表', cn: '中文😀' },
        { nested: { deep: { deeper: [{ x: 1, y: null }] } } },
    ];
    let bad = 0;
    for (const st of cases) {
        const want = J(exportEnvelopeValue(st, META));
        if (exportTextOf(st, META) !== want) bad++;
    }
    return bad === 0;
})(), (() => exportTextOf({ atoms: [{ id: 'a1' }] }, META))());

A('A2 分段仍可被 `JSON.parse` 正常解析（片段边界不产生非法 JSON），且解析结果与源对象**深等**', (() => {
    const st = { atoms: [{ id: 'a1', text: '甲' }, { id: 'a2', text: '乙' }], deleted: { atoms: { x: 1 } }, updatedAt: 123 };
    const parsed = JSON.parse(exportTextOf(st, META));
    const back = JSON.parse(J(exportEnvelopeValue(st, META)));
    return J(parsed) === J(back) && parsed.format === EXPORT_FORMAT
        && parsed.state.atoms.length === 2 && parsed.version === '3.45.7' && parsed.at === META.at;
})(), (() => JSON.parse(exportTextOf({ atoms: [{ id: 'a1' }] }, META)).format)());

A('A3 分段结构：`@meta` → `@state-open` → 每个状态键一段 → `@end`；`exportSectionKeys` 与状态键一致', (() => {
    const st = { atoms: [], memories: [1], vars: {} };
    const chunks = Array.from(exportChunks(st, META));
    const sections = chunks.map((c) => c.section);
    const keys = exportSectionKeys(st);
    return J(sections) === J(['@meta', '@state-open', 'atoms', 'memories', 'vars', '@end'])
        && J(keys) === J(['atoms', 'memories', 'vars'])
        && chunks[0].index === 0 && chunks[chunks.length - 1].index === chunks.length - 1
        && chunks.every((c) => c.total === chunks.length);
})(), (() => Array.from(exportChunks({ atoms: [], memories: [1] }, META)).map((c) => c.section))());

// ---------- B 组：不拼一整串 / 只读数 ----------
A('B1 `exportParts` 不拼接（返回片段数组）+ `chars` == 各片段长度之和；`total` 为**键数含 undefined 键**的上界', (() => {
    const st = { a: 1, b: undefined, c: [1, 2, 3] };
    const p = exportParts(st, META);
    const sum = p.parts.reduce((n, s) => n + s.length, 0);
    return Array.isArray(p.parts) && p.parts.length === 5 && p.chars === sum
        && p.total === 6                       // 头 + 开括号 + 3 个键 + 尾（`b` 值为 undefined → 产出时跳过）
        && p.parts.join('') === exportTextOf(st, META);
})(), (() => exportParts({ a: 1, b: undefined }, META))());

A('B2 导出**不修改入参**（分段组装只读；旧实现那份深拷贝因此可以省掉）', (() => {
    const st = { atoms: [{ id: 'a1', text: '甲' }], nested: { k: [1, 2] } };
    const before = J(st);
    exportParts(st, META);
    exportTextOf(st, META);
    Array.from(exportChunks(st, META));
    return J(st) === before;
})(), '见断言');

// ---------- C 组：内联上限判据（文本框 / 剪贴板只服务小数据） ----------
A('C1 `exportInlineAllowed` 判据唯一且边界正确；`EXPORT_PRETTY_MAX ≤ EXPORT_INLINE_MAX`（美化上限必须更严）', (() => {
    return exportInlineAllowed(0) === true && exportInlineAllowed(EXPORT_INLINE_MAX) === true
        && exportInlineAllowed(EXPORT_INLINE_MAX + 1) === false && exportInlineAllowed('x') === true
        && exportInlineAllowed(NaN) === true && EXPORT_PRETTY_MAX <= EXPORT_INLINE_MAX
        && EXPORT_INLINE_MAX === 1024 * 1024;
})(), (() => ({ inline: EXPORT_INLINE_MAX, pretty: EXPORT_PRETTY_MAX }))());

// ---------- D 组：宿主接线（`index.js#exportStateJson` 三模式 + 大小分流） ----------
const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({}), doc);
const entry = await import('../../index.js');
setScopeKey('char:export-test');
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
setLoadPhase('ready');

A('D1 `exportStateJson()` 默认仍是**字符串**（历史契约不变：devtools / 命令 / 测试都用它），且可被解析', (() => {
    setKernelState(Object.assign(emptyState(), { atoms: [{ id: 'a1', text: '甲在码头' }] }));
    const t = entry.exportStateJson();
    const parsed = JSON.parse(t);
    return typeof t === 'string' && parsed.format === EXPORT_FORMAT && parsed.state.atoms.length === 1
        && t.indexOf('\n') > 0;                       // 小存档 → 保留 2 空格**美化**（历史行为不变）
})(), (() => entry.exportStateJson().slice(0, 60))());

A('D2 `{parts:true}` 返回**已分段**（不拼接）：`chars` == 各片段之和、拼接后可解析；`{stream:true}` 给出**生成器**且逐段拼接与分段结果**同形**', (() => {
    setKernelState(Object.assign(emptyState(), { atoms: [{ id: 'a1', text: '甲' }, { id: 'a2', text: '乙' }], vars: { v: 1 } }));
    const parts = entry.exportStateJson({ parts: true });
    const stream = entry.exportStateJson({ stream: true });
    const joined = Array.from(stream.source).map((c) => c.part).join('');
    const pj = parts.parts.join('');
    const a = JSON.parse(pj), b = JSON.parse(joined);
    // 两次调用的 `at` 时间戳可以不同 —— 比对**除 at 外**的结构（分段与生成器必须同形同值）
    delete a.at; delete b.at;
    return Array.isArray(parts.parts) && parts.chars === parts.parts.reduce((n, s) => n + String(s).length, 0)
        && parts.parts.length >= 4 && parts.total >= parts.parts.length
        && typeof stream.source[Symbol.iterator] === 'function'
        && J(a) === J(b) && b.state.atoms.length === 2 && b.format === EXPORT_FORMAT
        && stream.chars === null;                     // 「源」不算长度（真正的活由调用方按段驱动）
})(), (() => { const p = entry.exportStateJson({ parts: true }); return { chars: p.chars, parts: p.parts.length, total: p.total }; })());

A('D3 **大存档不美化**（旧的 2 空格美化正是卡死主因之一）：超过 `EXPORT_PRETTY_MAX` 时默认导出为紧凑单行，且美化版明显更大', (() => {
    const big = [];
    for (let i = 0; i < 3000; i++) big.push({ id: 'a' + i, text: '情节正文占位'.repeat(40), tags: ['甲', '乙'], uses: 0 });
    setKernelState(Object.assign(emptyState(), { atoms: big }));
    const out = entry.exportStateJson();                 // 默认路径
    const pretty = entry.exportStateJson({ pretty: true });   // 显式美化（仅诊断 / 测试用）
    return out.length > EXPORT_PRETTY_MAX               // 前提：这份数据确实超过「美化上限」
        && out.indexOf('\n') < 0                        // 大存档 → 紧凑单行
        && pretty.indexOf('\n') > 0 && pretty.length > out.length + 100000   // 美化确实大得多（当年卡死的来源）
        && JSON.parse(out).state.atoms.length === 3000;
})(), (() => { const out = entry.exportStateJson(); const p = entry.exportStateJson({ pretty: true }); return { compact: out.length, pretty: p.length, prettyCap: EXPORT_PRETTY_MAX }; })());

R.done();
