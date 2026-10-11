// ============================================================
// 单元测试 · v3.45.0 `docs/D22` W5 **`技-26`** —— 宿主输入框写入探针 + 降级链
//   设计：`docs/D21` §8 `技-26`（「宿主输入框写入能力前置验证（**无既有先例**）+ 降级链确定」）；
//         事实 `docs/D17` **U160**（`docs/D27` §3.6 / §8 里 `应-21` 地图点击插入套话的前置）
//   实现：`host/input-box.js`（探针 / 尾部追加 / 剪贴板 / 降级链 / 真机验证步骤）+ `devtools.js#FTT.inputBox()`
//
// 本文件锁五件事：
//   ① **只追加不覆盖**：既有内容原样保留、新文本接在尾部（`D27` §3.6 的用户要求）；
//   ② **不写任何数据**：模块只碰 DOM / 剪贴板 —— 调完 `cfg` / `state` 逐字不变（「点击不写数据」）；
//   ③ **降级链有序且每档带原因**：宿主输入框 → 剪贴板 → 人工；**走到哪一档都可读**，绝不静默失败；
//   ④ **绝不抛错**：坏输入 / 取不到文档 / 剪贴板拒绝 → 一律 `{ok:false, reason:可读}`；
//   ⑤ **真机边界如实登记**：选择器表是**待验证假设**（本机无真机），验证步骤由 `FTT.inputBox()` 给出。
//
// 运行：node tests/unit/input-box.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import {
    INPUT_BOX_SELECTORS, INPUT_FALLBACK_CHAIN, appendToHostInput, inputBoxCapability, inputBoxVerifySteps, insertTextToHost, writeClipboard,
} from '../../host/input-box.js';

const R = makeReporter('input-box v3.45.0 宿主输入框探针与降级链（D22 W5 技-26）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

Object.assign(cfg, clone(defaultCfg));
setScopeKey('甲');
setKernelState(emptyState());
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

/** 伪宿主文档：`querySelector` 只认登记过的选择器（够用且可控） */
function makeDoc(map) {
    return {
        querySelector(sel) { return Object.prototype.hasOwnProperty.call(map, sel) ? map[sel] : null; },
    };
}
/** 伪输入框元素（记录派发的事件，便于断言「宿主 UI 能同步」） */
function makeTextarea(value) {
    return {
        value: String(value == null ? '' : value),
        events: [],
        focused: false,
        dispatchEvent(e) { this.events.push(e && e.type); return true; },
        focus() { this.focused = true; },
    };
}
const makeClipboard = (fail) => ({ calls: [], writeText(t) { if (fail) return Promise.reject(new Error('权限被拒')); this.calls.push(String(t)); return Promise.resolve(true); } });

A('K1 探针（只读）：命中输入框 → `host-textarea` 并报出命中的选择器；只有剪贴板 → `clipboard`；都没有 → `manual`；**不写任何东西**', (() => {
    const ta = makeTextarea('既有内容');
    const withTa = inputBoxCapability({ doc: makeDoc({ '#send_textarea': ta }), clipboard: makeClipboard(false) });
    const onlyClip = inputBoxCapability({ doc: makeDoc({}), clipboard: makeClipboard(false) });
    const none = inputBoxCapability({ doc: makeDoc({}), clipboard: null });
    const bad = inputBoxCapability({ doc: { querySelector() { throw new Error('boom'); } }, clipboard: null });
    return withTa.textarea === true && withTa.selector === INPUT_BOX_SELECTORS[0] && withTa.via === 'host-textarea'
        && ta.value === '既有内容' && ta.events.length === 0                  // 探针不写、不派发事件
        && onlyClip.textarea === false && onlyClip.clipboard === true && onlyClip.via === 'clipboard'
        && none.via === 'manual' && String(none.reason).indexOf('手动复制') >= 0
        // 单个选择器查询抛错 → 仍降级到 manual，但**原因里如实附上**抛错计数（不与「就是没有输入框」混为一谈）
        && bad.via === 'manual' && bad.errors === INPUT_BOX_SELECTORS.length
        && String(bad.reason).indexOf('手动复制') >= 0 && String(bad.reason).indexOf('查询抛错') > 0;
})(), J(INPUT_FALLBACK_CHAIN));

A('K2 **只追加不覆盖**：既有内容保留、新文本接在**尾部**，并派发一次 `input` 事件（宿主 UI 得以同步）；`focus` 可显式要求', (() => {
    const ta = makeTextarea('甲的话：');
    const r = appendToHostInput('（补充）', { doc: makeDoc({ '#send_textarea': ta }), focus: true });
    const empty = appendToHostInput('只有新文本', { doc: makeDoc({ '#send_textarea': makeTextarea('') }) });
    return r.ok === true && r.via === 'host-textarea' && r.chars === 4
        && ta.value === '甲的话：（补充）' && ta.events.join(',') === 'input' && ta.focused === true
        && empty.ok === true
        && String(r.reason).indexOf('原 4 字 → 8 字') > 0;
})(), '');

A('K3 探针与写入**共用同一张选择器表**（有序）：第一个命中的即可写；表里没有的输入框一律不碰（不猜 DOM）', (() => {
    const second = makeTextarea('');
    const doc = makeDoc({ [INPUT_BOX_SELECTORS[1]]: second });
    const cap = inputBoxCapability({ doc: doc, clipboard: null });
    const w = appendToHostInput('x', { doc: doc });
    const foreign = appendToHostInput('x', { doc: makeDoc({ '#some_other_textarea': makeTextarea('') }) });
    return cap.selector === INPUT_BOX_SELECTORS[1] && w.ok === true && second.value === 'x'
        && foreign.ok === false && String(foreign.reason).indexOf('找不到宿主输入框') >= 0
        && INPUT_BOX_SELECTORS.length >= 2;
})(), J(INPUT_BOX_SELECTORS));

A('K4 降级链第一档成功即返回：不会再去写剪贴板（避免「既插入又复制」的重复副作用）', async () => {
    const ta = makeTextarea('A');
    const clip = makeClipboard(false);
    const r = await insertTextToHost('B', { doc: makeDoc({ '#send_textarea': ta }), clipboard: clip });
    return r.ok === true && r.via === 'host-textarea' && ta.value === 'AB' && clip.calls.length === 0 && r.manual === false;
});

A('K5 降级链第二档：输入框不在 → 写剪贴板并如实说明；剪贴板**拒绝** → 落到 `manual` 且两档原因都带上', async () => {
    const clip = makeClipboard(false);
    const r1 = await insertTextToHost('要插入的文本', { doc: makeDoc({}), clipboard: clip });
    const r2 = await insertTextToHost('要插入的文本', { doc: makeDoc({}), clipboard: makeClipboard(true) });
    const r3 = await insertTextToHost('要插入的文本', { doc: makeDoc({}), clipboard: null });
    return r1.ok === true && r1.via === 'clipboard' && clip.calls.join('') === '要插入的文本'
        && r2.ok === false && r2.via === 'manual' && r2.manual === true
        && String(r2.reason).indexOf('找不到宿主输入框') > 0 && String(r2.reason).indexOf('剪贴板写入失败') > 0
        && r3.via === 'manual' && String(r3.reason).indexOf('未提供剪贴板接口') > 0;
});

A('K6 `manual` 档回调可拿到文本与原因（供界面显示只读文本框让人自己复制）；坏入参（空文本 / 非字符串）不抛错', async () => {
    let seen = null;
    const r = await insertTextToHost('正文', { doc: makeDoc({}), clipboard: null, onManual: (t, why) => { seen = { t: t, why: why }; } });
    const empty = await insertTextToHost('', { doc: makeDoc({}), clipboard: null });
    const nil = await insertTextToHost(null, { doc: null, clipboard: undefined });
    const clipEmpty = await writeClipboard('', { clipboard: makeClipboard(false) });
    return r.manual === true && seen && seen.t === '正文' && String(seen.why).indexOf('手动复制') > 0
        && empty.ok === false && String(empty.reason).indexOf('空文本') > 0
        && nil.ok === false && typeof nil.reason === 'string'
        && clipEmpty.ok === false && String(clipEmpty.reason).indexOf('空文本') > 0;
});

A('K7 **不写任何数据**（`D27` §3.6「点击不写数据」）：跑完整条链后 `cfg` 与 `state` **逐字不变**', async () => {
    const beforeCfg = J(cfg), beforeState = J(state);
    await insertTextToHost('不写数据', { doc: makeDoc({ '#send_textarea': makeTextarea('x') }), clipboard: makeClipboard(false) });
    await insertTextToHost('不写数据', { doc: makeDoc({}), clipboard: makeClipboard(true) });
    return J(cfg) === beforeCfg && J(state) === beforeState;
});

A('K8 **真机边界如实**：验证步骤由函数给出（含选择器假设与回填要求），且只读探针经 `FTT.inputBox()` 暴露 —— 本机无真机，故**不声称已验证**', (() => {
    const steps = inputBoxVerifySteps();
    return steps.indexOf('FTT.inputBox()') > 0 && steps.indexOf('#send_textarea') < 0        // 步骤里不硬编码选择器
        && steps.indexOf('未验证前不得写成已验证') > 0
        && steps.indexOf('尾部') > 0 && steps.indexOf('manual') > 0;
})(), '');

R.done();
