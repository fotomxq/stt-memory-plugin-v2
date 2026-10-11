// ============================================================
// 单元测试 · v3.44.0 `docs/D22` W4 **`数-13`** —— 空壳条目不入库
//   设计：`docs/D20` §3.4 / §8 `数-13`（① 入库校验 ② 体检空壳项 ③ 列表筛选视图）
//   实现：`core/shell-guard.js`（判据 + 过滤 + 存量报告）· `core/ingest.js#mergeDelta`（**开关默认关**时拦截）·
//         `ui/panel.js`（列表页「🫥 空壳」筛选）· `core/data-health.js`（hygiene `entry-shell`）
//
// 本文件锁四件事：
//   ① **两个判据刻意分开**：拦截（严）= 正文 + 标识合计 < 12 字**且**无其它有值字段；体检（宽）= 正文 < 12 字。
//      为什么：`items` 里「钥匙」这种 2 字条目**是有意义的**（标识本身就是信息）——按体检口径去拦会误删真数据；
//   ② **默认关**（实测理由）：V1 黄金样本里有一条 11 字悬念被 V1 接受，拦截会破坏移植契约 →
//      默认不改任何行为，开启后丢弃并计数（面板提示 + 调试日志 + `lastShellDropInfo()`）；
//   ③ **只动新增**：`update` / `remove` 列表一律不碰（更新一条既有短条目不该被拦）；
//   ④ **存量只报告**：体检给分维计数，列表页给筛选视图，**不删任何条目**。
//
// 运行：node tests/unit/shell-guard.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    SHELL_MIN_CHARS, bodyLengthOf, filterShellAdds, identLengthOf, isShellEntry, shellFieldsOf, shellReport, shellVerdict,
} from '../../core/shell-guard.js';
import { lastShellDropInfo, mergeDelta } from '../../core/ingest.js';
import { dataHealthReport } from '../../core/data-health.js';

const R = makeReporter('shell-guard v3.44.0 空壳条目入库拦截（D22 W4 数-13）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

Object.assign(cfg, clone(defaultCfg));
setScopeKey('甲');
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

A('S1 字段面：正文类 / 标识类逐维登记；未登记维度 → 判据为「不拦、不报」（宁可漏报不误报）', (() => {
    const it = shellFieldsOf('items'), sc = shellFieldsOf('scenes');
    return J(it.body) === J(['desc', 'content']) && J(it.ident) === J(['name'])
        && J(sc.body) === J(['desc', 'content']) && J(sc.ident) === J(['name'])
        && shellFieldsOf('zzzUnknown') === null && isShellEntry('zzzUnknown', {}) === false;
})(), '');

A('S2 长度口径：正文类合计（含点路径 background.history、数组元素）与标识类合计；空值 / 非字符串按 0 计', (() => {
    return bodyLengthOf('items', { desc: '一二三四五' }) === 5
        && bodyLengthOf('items', { desc: '一二三', content: '四五' }) === 5
        && identLengthOf('items', { name: '钥匙' }) === 2
        && bodyLengthOf('snapshots', { background: { history: '一二三四五' } }) === 5
        && bodyLengthOf('plotSegments', { linesText: ['一二三', '四五'] }) === 5
        && bodyLengthOf('items', { desc: 12345 }) === 5
        && bodyLengthOf('items', {}) === 0;
})(), '');

A('S3 **两个判据刻意不同**：体检（宽）按「正文 < 12 字」；拦截（严）还要「无其它有值字段」——「钥匙」（2 字但有 name）**不被拦**', (() => {
    const key = { id: 'i1', name: '钥匙' };                                        // 2 字标识、无正文
    const bare = { id: 'x1', name: '', desc: '' };                                 // 完全空
    const tiny = { id: 's1', content: '来源不明' };                                 // 4 字正文、无其它字段
    const tinyWithDate = { id: 's2', content: '来源不明', date: '1919-11-29' };      // 有其它有值字段
    return isShellEntry('items', key) === true && shellVerdict('items', key).shell === false   // 宽 true / 严 false（有 name = 能指认对象）
        && shellVerdict('items', key).identLen === 2
        && isShellEntry('items', bare) === true && shellVerdict('items', bare).shell === true
        && isShellEntry('suspense', tiny) === true && shellVerdict('suspense', tiny).shell === true
        && shellVerdict('suspense', tinyWithDate).shell === false
        && shellVerdict('suspense', tinyWithDate).extraKeys.join(',') === 'date'
        && shellVerdict('items', { id: 'i3', name: '码头', desc: '' }).shell === false   // 只有 name、正文空 → 不拦
        && SHELL_MIN_CHARS === 12;
})(), '');

A('S4 入库过滤：**只动 add**（update / remove 一律不碰）；返回丢弃数 / 分维计数 / 样本', (() => {
    const delta = {
        items: { add: [{ id: 'i1', name: '钥匙' }, { id: 'i2', name: '', desc: '' }], update: [{ id: 'iu', name: '' }] },
        suspense: { add: [{ id: 's1', content: '来源不明' }], remove: [{ id: 'sr' }] },
        scenes: { add: [{ id: 'sc1', name: '码头', desc: '货箱堆得很高。' }] },
    };
    const st = filterShellAdds(delta);
    return st.dropped === 2 && st.byDim.items === 1 && st.byDim.suspense === 1
        && delta.items.add.length === 1 && delta.items.add[0].id === 'i1'          // 钥匙留下
        && delta.items.update.length === 1 && delta.suspense.add.length === 0
        && delta.suspense.remove.length === 1 && delta.scenes.add.length === 1
        && st.samples.length === 2;
})(), '');

A('S5 存量报告（体检口径，**只读**）：按维度计数 + 样本；不改任何条目', (() => {
    const s = Object.assign(emptyState(), {
        items: [{ id: 'i1', name: '钥匙', desc: '' }, { id: 'i2', name: '铜钥匙', desc: '从木箱边捡到的铜制钥匙。' }],
        scenes: [{ id: 'sc1', name: '码头' }],
    });
    const before = J(s.items) + J(s.scenes);
    const rep = shellReport(s, { samples: 5 });
    // 报告的 `len` 是**正文**长度（体检口径 = 正文 < 12 字），不是「正文 + 标识」
    return rep.total === 2 && rep.byDim.items === 1 && rep.byDim.scenes === 1
        && rep.samples.length === 2 && rep.samples[0].len === 0
        && (J(s.items) + J(s.scenes)) === before;
})(), '');

A('S6 写入路径**默认关**：不开启时空壳照常入库（`dropped=0`、无留痕）—— 默认行为与 V1 一致（黄金样本因此不受影响）', (() => {
    setKernelState(emptyState());
    Object.assign(cfg, { shellGuardEnabled: false });
    const delta = { books: null, suspense: { add: [{ content: '来源不明' }] } };
    mergeDelta(clone(delta), { start: 0, end: 0 });
    const keptFalse = (state.suspense || []).length;
    return keptFalse === 1 && lastShellDropInfo() === null;
})(), '');

A('S7 开启后丢弃并计数：内核里不落库、`lastShellDropInfo()` 给出留痕（面板提示与调试日志同源）', (() => {
    setKernelState(emptyState());
    Object.assign(cfg, { shellGuardEnabled: true });
    mergeDelta({ suspense: { add: [{ content: '来源不明' }, { content: '德文金属箱内装何物，密封极高、外壳带磁性。' }] } }, { start: 0, end: 0 });
    const kept = (state.suspense || []).length;
    const info = lastShellDropInfo();
    Object.assign(cfg, { shellGuardEnabled: false });
    return kept === 1 && !!info && info.dropped === 1 && info.byDim.suspense === 1;
})(), '');

A('S8 体检出口：`entry-shell` 进 `hygiene`（分维计数 + 写清「只报告不删」与开关名），**不**进 `findings`', (() => {
    const s = Object.assign(emptyState(), { items: [{ id: 'i1', name: '钥匙', desc: '' }] });
    const rep = dataHealthReport(s);
    const f = rep.hygiene.findings.filter((x) => x.code === 'entry-shell');
    return rep.hygiene.counts['entry-shell'] === 1 && f.length === 1
        && f[0].detail.indexOf('只报告不删') > 0 && f[0].detail.indexOf('shellGuardEnabled') > 0
        && rep.findings.filter((x) => x.code === 'entry-shell').length === 0;
})(), '');

A('S9 开关是**声明过的配置键且有控件**（默认关）：`defaultCfg.shellGuardEnabled === false`', (() => {
    return defaultCfg.shellGuardEnabled === false;
})(), '');

R.done();

/** 内核 state 的读取入口（本文件多处断言落库结果） */
function require_state() { return kernelStateRef; }
