// ============================================================
// 单元测试 · v3.46.4（`docs/D22` `应-31` / `docs/D9` §10 **U15**）
//   **管道请求守门**：同动作排重（防反复点击 → 重复发 AI 请求）+ 开工弹窗提示 + 在途按钮禁用
//
// 用户要求（原话）：「上一个版本修复的内容，如果发起管道请求操作，应该有弹窗提示。
//   核对相关按钮是否存在排重点击的机制，避免用户反复点击触发。」
// 用户裁决（本轮）：① 弹窗形式 = **开工弹窗提示**（沿用 `panelNotify('info','…开始…')` 惯例）；
//                  ② 覆盖面 = **全部管道请求类动作**统一纳入。
//
// 核对结论（本轮实测，见 A 组）：会发 AI 的动作**只检查共享的 `aiBusy()`**（不含自己这次请求）→
//   连点两下**真的会发两次**；`runResumeRepair` 连 `aiBusy()` 都没有；在途按钮**不 disabled**。
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { readFileSync, readdirSync } from 'node:fs';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { openPanel, panelAction, panelState, panelModalInnerHtml, setPanelHooks2 } from '../../ui/panel.js';
import {
    PIPE_ACTIONS, PIPE_ACTION_COUNT, PIPE_MAX_MS, isPipeAction, pipeLabel, pipeNoticeOf, pipeEnter, pipeLeave,
    pipeBusy, pipeInflightList, pipeGuardState, pipeDisableInFlightHtml, pipeGuardReset,
} from '../../ui/pipe-guard.js';

const R = makeReporter('pipe-guard v3.46.4 管道请求守门（排重 / 开工弹窗 / 在途禁用）');
const A = (n, c, e) => R.assert(n, !!c, e);
/** 异步用例专用（本文件的同步 `A()` 先做 `!!c`，把 Promise 变 true → 假绿；异步一律走这个） */
const AX = async (n, fn, e) => {
    let c = false, x = e;
    try { c = await fn(); } catch (err) { c = false; x = String((err && err.message) || err); }
    R.assert(n, c === true, (typeof x === 'function') ? x() : x);
};
const J = (v) => JSON.stringify(v);
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

// ---------- 装配 ----------
const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
installGlobalHost(makeHost({ chat: [] }), doc);
setContextProvider(() => makeHost({ chat: [] }).ctx);

/** 捕获弹窗（`panelNotify` → `hooks.notify`） */
let toasts = [];
function boot() {
    Object.assign(cfg, clone(defaultCfg));
    setScopeKey('char:pipe-guard');
    setKernelState(Object.assign(emptyState(), { snapshots: [{ id: 's1', name: '李瑶' }] }));
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    toasts = [];
    setPanelHooks2({ notify: (kind, text) => { toasts.push({ kind: String(kind), text: String(text) }); return true; } });
    pipeGuardReset();
    openPanel('overview');
    return true;
}
const notices = (kind) => toasts.filter((t) => !kind || t.kind === kind).map((t) => t.text);

// ==================== A 组：同动作排重 ====================
A('A1 同一动作未结束时再点 → **挡下**（`ok:false` + `reason=in-flight`），提示**明说**是重复点击而不是静默忽略', (() => {
    boot();
    const first = pipeEnter('repair');
    const second = pipeEnter('repair');
    return first.ok === true && second.ok === false && second.reason === 'in-flight'
        && second.note.indexOf('自动修复') >= 0 && second.note.indexOf('还在进行中') >= 0
        && second.note.indexOf('重复点击') >= 0;
})(), () => J({ note: pipeEnter('repair').note }));

A('A2 正常进出闸：进入后 `pipeBusy` 为真、列表可见；`pipeLeave` 后立刻可再用（**不会永久锁死**）', (() => {
    boot();
    pipeEnter('triLinkBuild');
    const busy = pipeBusy('triLinkBuild') === true && pipeInflightList().length === 1;
    const left = pipeLeave('triLinkBuild') === true;
    const free = pipeBusy('triLinkBuild') === false && pipeEnter('triLinkBuild').ok === true;
    return busy && left && free;
})(), () => J(pipeGuardState()));

A('A3 **不同动作互不阻塞**（排重按「动作名」，不是全局串行 —— 与 `aiBusy()` 的分工不变）', (() => {
    boot();
    const a = pipeEnter('repair');
    const b = pipeEnter('characterRepair');
    const c = pipeEnter('triLinkBuild');
    return a.ok && b.ok && c.ok && pipeInflightList().length === 3;
})(), () => J(pipeInflightList()));

A('A4 **非登记动作完全不介入**（`pipe:false`、不写进在途表、拿不到开工提示）—— 快速动作因此零影响', (() => {
    boot();
    const r1 = pipeEnter('tab');
    const r2 = pipeEnter('save');
    const r3 = pipeEnter('noop');
    return r1.pipe === false && r2.pipe === false && r3.pipe === false
        && r1.ok === true && r2.ok === true
        && r1.notice === '' && pipeInflightList().length === 0;
})(), () => J(pipeGuardState()));

await AX('A5 **安全阀**：占用超过 `PIPE_MAX_MS` 时自动放行本次（并如实计数 `timeouts`），提示写明已超时 —— 宁可放行也不永久锁死', async () => {
    boot();
    pipeEnter('repair');
    const real = Date.now;
    Date.now = () => real() + PIPE_MAX_MS + 1000;             // 模拟卡死超时
    try {
        const r = pipeEnter('repair');
        const st = pipeGuardState();
        return r.ok === true && st.timeouts === 1 && r.notice.indexOf('超时') >= 0;
    } finally { Date.now = real; }
}, () => J(pipeGuardState()));

// ==================== B 组：开工弹窗提示 ====================
A('B1 登记的管道动作 → 开工提示带 **🔄 + 动作名 + 「已发起 AI 请求（管道请求）」**（`docs/D9` §7 U7 进行中图标口径）', (() => {
    const s = pipeNoticeOf('triLinkBuild');
    const m = pipeNoticeOf('currencyMergePick');
    return s.indexOf('🔄') === 0 && s.indexOf('联动构建') >= 0 && s.indexOf('已发起 AI 请求') >= 0
        && m.indexOf('🔄') === 0 && m.indexOf('AI 融合货币') >= 0;
})(), () => J({ triLink: pipeNoticeOf('triLinkBuild'), cur: pipeNoticeOf('currencyMergePick') }));

A('B2 **自带开工提示的动作不重复弹**（`selfNotice`）：`parallelCustomRun` 已有「自定义推演：开始推演…」→ 本模块不再补弹', (() => {
    return pipeNoticeOf('parallelCustomRun') === '' && PIPE_ACTIONS.parallelCustomRun.selfNotice === true;
})(), '');

A('B6 **`summary` / `summaryFloor` 故意不在册**：它们自带**更细**的在途闸（`summaryFloor` 是**按楼层**判重）且自带开工提示 —— 并入统一守门会用更粗的粒度覆盖更细的（实测会让 smoke BJ1 变红）', (() => {
    return isPipeAction('summary') === false && isPipeAction('summaryFloor') === false
        && pipeNoticeOf('summary') === '' && pipeNoticeOf('summaryFloor') === '';
})(), () => J({ summary: isPipeAction('summary'), floor: isPipeAction('summaryFloor') }));

A('B3 未登记动作 → **无开工提示**（不误弹）', (() => {
    return pipeNoticeOf('tab') === '' && pipeNoticeOf('save') === '' && pipeNoticeOf('unknown-x') === ''
        && isPipeAction('tab') === false && isPipeAction('repair') === true;
})(), '');

await AX('B4 **经真实调度**：点登记的管道动作会弹一条 info 开工提示（且**只弹一条**）', async () => {
    boot();
    await panelAction('repair', {});
    const infos = notices('info').filter((t) => t.indexOf('🔄') === 0);
    return infos.length === 1 && infos[0].indexOf('自动修复') >= 0 && infos[0].indexOf('已发起 AI 请求') >= 0;
}, () => J(notices()));

await AX('B5 提取管线（`summary`）经调度**不补弹**我们的开工提示（它自带「AI 摘要：开始分析…」；且已在册外）', async () => {
    boot();
    await panelAction('summary', {});
    return notices('info').filter((t) => t.indexOf('已发起 AI 请求') >= 0).length === 0;
}, () => J(notices()));

// ==================== C 组：在途按钮禁用（视觉反馈）====================
const BTN = '<button class="ftt-btn" data-ftt-action="repair" title="自动修复">🛠 自动修复</button>'
    + '<button class="ftt-btn" data-ftt-action="saveAll">保存</button>'
    + '<a href="javascript:void(0)" data-ftt-action="repair">链接形态</a>';

A('C1 在途动作的 `<button>` 被注入 `disabled`（用户**看得见**"现在点不动"），其它动作与 `<a>` 不受影响', (() => {
    boot();
    pipeEnter('repair');
    const html = pipeDisableInFlightHtml(BTN);
    const rep = html.match(/<button[^>]*data-ftt-action="repair"[^>]*>/)[0];
    const save = html.match(/<button[^>]*data-ftt-action="saveAll"[^>]*>/)[0];
    const link = html.match(/<a[^>]*data-ftt-action="repair"[^>]*>/)[0];
    return rep.indexOf('disabled') >= 0 && save.indexOf('disabled') < 0 && link.indexOf('disabled') < 0;
})(), '');

A('C2 出闸后不再注入（禁用态随在途状态消失）；`pipeGuards 复位`也能清干净', (() => {
    boot();
    pipeEnter('repair');
    const during = pipeDisableInFlightHtml(BTN).indexOf('disabled') >= 0;
    pipeLeave('repair');
    const after = pipeDisableInFlightHtml(BTN).indexOf('disabled') < 0;
    pipeEnter('repair');
    pipeGuardReset();
    const reset = pipeDisableInFlightHtml(BTN).indexOf('disabled') < 0;
    return during && after && reset;
})(), () => J(pipeGuardState()));

await AX('C3 **经真实渲染**：在途期间面板外壳里该动作按钮带 `disabled`；出闸后恢复正常', async () => {
    boot();
    pipeEnter('repair');
    const html = String(panelModalInnerHtml({ tab: 'overview' }));
    const m = html.match(/<button[^>]*data-ftt-action="repair"[^>]*>/);
    const during = !!m && m[0].indexOf('disabled') >= 0;
    pipeLeave('repair');
    const html2 = String(panelModalInnerHtml({ tab: 'overview' }));
    const m2 = html2.match(/<button[^>]*data-ftt-action="repair"[^>]*>/);
    return during && !!m2 && m2[0].indexOf('disabled') < 0;
}, () => '');

// ==================== D 组：经真实调度的守门（集成）====================
await AX('D1 在途时经 `panelAction` 再点同一动作 → **整条动作被拒**（`reason=in-flight`），提示行写入 + 弹一条 warning', async () => {
    boot();
    pipeEnter('repair');                                   // 模拟「上一次还在跑」
    const r = await panelAction('repair', {});
    const note = String(panelState().note || '');
    const warns = notices('warning');
    return r.ok === false && r.reason === 'in-flight'
        && note.indexOf('还在进行中') >= 0
        && warns.length === 1 && warns[0].indexOf('⚠️') === 0;
}, () => J({ note: panelState().note, toasts: toasts }));

await AX('D2 **不泄漏**：任何一次真实调度结束后都会出闸（失败 / 被拒也算）→ 同一动作可以再次点击', async () => {
    boot();
    await panelAction('repair', {});                       // 未接线钩子 → 动作自己会失败/早退，但守门必须释放
    const released = pipeBusy('repair') === false;
    const wasInFlightDuringDispatch = true;                // 见 D3：调度期间确实进过闸
    const second = await panelAction('repair', {});
    return released && wasInFlightDuringDispatch && second.reason !== 'in-flight';
}, () => J(pipeGuardState()));

await AX('D3 调度**期间**确实进入在途表（守门真的挂在调度上，不只是模块自测）', async () => {
    boot();
    let seen = null;
    // 用「开工提示」这一刻证明已进闸：`pipeEnter` 先登记、再弹提示
    setPanelHooks2({
        notify: (kind, text) => { toasts.push({ kind: String(kind), text: String(text) }); seen = pipeInflightList().map((x) => x.action); return true; },
    });
    await panelAction('repair', {});
    return seen && seen.indexOf('repair') >= 0;
}, () => J({ seen: 'n/a' }));

await AX('D4 被挡下时**不改数据**：`repair` 在途时再点，只写提示、不产生任何修复结果', async () => {
    boot();
    const before = J(cfg);
    pipeEnter('repair');
    const r = await panelAction('repair', {});
    return r.ok === false && r.reason === 'in-flight' && J(cfg) === before && r.made === undefined;
}, () => J({ r: 'in-flight-expected' }));

// ==================== E 组：清单自维护哨兵 ====================
/** 收集仓库里所有「真实可调度」的动作名：`ui/panel.js` 的 `a === 'x'` + 各 ui 模块的动作组数组 */
function collectDispatchActions() {
    const names = new Set();
    const panel = readFileSync('ui/panel.js', 'utf8');
    for (const m of panel.matchAll(/a === '([A-Za-z0-9_-]+)'/g)) names.add(m[1]);
    const files = readdirSync('ui').filter((f) => f.endsWith('.js')).map((f) => 'ui/' + f);
    for (const f of files) {
        const s = readFileSync(f, 'utf8');
        for (const m of s.matchAll(/export const [A-Z_]+_ACTIONS\s*=\s*(?:Object\.freeze\()?\[([\s\S]*?)\]/g)) {
            for (const q of m[1].matchAll(/'([A-Za-z0-9_-]+)'/g)) names.add(q[1]);
        }
    }
    return names;
}

A('E1 登记表里**每个动作都真实可调度**（防写错名字 → 守门永不生效）', (() => {
    const real = collectDispatchActions();
    const missing = Object.keys(PIPE_ACTIONS).filter((a) => !real.has(a));
    return missing.length === 0;
})(), () => J({ missing: Object.keys(PIPE_ACTIONS).filter((a) => !collectDispatchActions().has(a)) }));

A('E2 登记表**恰好**是这 24 项（显式快照：增删都必须是有意为之）', (() => {
    const want = ['plotSegmentSummarySel', 'repair', 'characterRepair', 'resumeRepair',
        'stateRepair', 'memoryRepair', 'conceptRepair', 'sceneRepair', 'itemRepair', 'planSuspRepair',
        'atomCompactNow', 'atomMergeSummary', 'parallelAdvance', 'parallelAdvanceAll', 'parallelCustomRun',
        'parallelWeaveNow', 'triLinkBuild', 'currencyMergePick', 'nsfwSoften', 'nsfwAnalyze', 'clockRepair',
        'apiTest', 'apiModels', 'testLayer'];
    const got = Object.keys(PIPE_ACTIONS);
    return want.length === 24 && got.length === 24 && PIPE_ACTION_COUNT === 24 && want.every((a) => got.indexOf(a) >= 0);
})(), () => J(Object.keys(PIPE_ACTIONS)));

A('E3 每条登记都有**面向用户的动作名**（label 非空且不等于动作名本身，提示才不会露出英文标识符）', (() => {
    const bad = Object.keys(PIPE_ACTIONS).filter((a) => {
        const e = PIPE_ACTIONS[a];
        return !e || !e.label || e.label === a;
    });
    return bad.length === 0 && pipeLabel('unknown-zzz') === 'unknown-zzz';
})(), () => J(Object.keys(PIPE_ACTIONS).filter((a) => (PIPE_ACTIONS[a].label || '') === a)));

R.done();
