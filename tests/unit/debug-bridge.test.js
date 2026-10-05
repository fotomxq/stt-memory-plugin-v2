// ============================================================
// 单元测试 · 本地调试桥（v3.0.8）
//   `adapters/debug-bridge.js` + `ui/debug.js` 的桥接装配
//
// 重点覆盖用户硬要求：
//   ① **跨宿主**：酒馆原生（浏览器）与 TauriTavern 都能用；
//   ② **非 TauriTavern 不崩溃**：宿主类方法只降级返回，不抛错；
//   ③ **只读**：只派发白名单方法，改动型动作一律拒绝。
//   v3.0.8：目标主机可配（默认回环）+ 真机 bug 回归（memoryShape 维度名）
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import {
    bridgeDispatch, bridgeState, bridgeStats, bridgeResetStats, bridgeSupported, bridgeHost,
    bridgeMethodNames, setBridgeMethods, setBridgePort, bridgePort, bridgeStart, bridgeStop,
    bridgeResetProbe, setBridgeHost, bridgeTarget, isLoopbackHost, BRIDGE_PROTOCOL,
    BRIDGE_DEFAULT_PORT, BRIDGE_DEFAULT_HOST,
} from '../../adapters/debug-bridge.js';
import { ttResetSession } from '../../adapters/tt-store.js';
import { buildBridgeMethods, installDebugBridge, debugBridgeInstalled, debugBridgeSectionHtml, DEBUG_ACTIONS } from '../../ui/debug.js';
import { state, setKernelState, setLastMessageId } from '../../core/model/runtime.js';
import { emptyState } from '../../core/state.js';
import { DIMENSIONS } from '../../core/constants.js';
import { hashFloorText, processedVerTag } from '../../host/floors.js';

const R = makeReporter('debug-bridge v3.0.10 本地调试桥（跨宿主 / 只读 / 台账与载入链路诊断）');
const A = (n, c, e) => R.assert(n, !!c, e);

const doc = makeDocument([]);
const unHost = installGlobalHost(makeHost({}), doc);

/** 清空宿主特征，回到「酒馆原生」 */
function useVanilla() {
    ttResetSession();
    for (const k of ['__TAURITAVERN__', '__TAURITAVERN_MAIN_READY__', '__TAURI_RUNNING__', '__TAURI__', '__TAURI_INTERNALS__']) {
        try { delete globalThis[k]; } catch (e) { /* 忽略 */ }
        try { if (globalThis.window) delete globalThis.window[k]; } catch (e) { /* 忽略 */ }
    }
    ttResetSession();
}

/** 装一个 TauriTavern 桩（`dev` 传 null 表示该版本没有 api.dev） */
function useTauriTavern(withDev = true) {
    useVanilla();
    const dev = {
        frontendLogs: {
            list: async () => ([{ id: 1, level: 'info', message: 'hi' }]),
            getConsoleCaptureEnabled: async () => true,
        },
        backendLogs: { tail: async () => ([{ id: 2, target: 'tt', message: 'b' }]) },
        llmApiLogs: {
            index: async () => ([{ id: 7, model: 'm', ok: true }]),
            getPreview: async (p) => ({ id: (p && p.id) || null, requestReadable: 'REQ' }),
            getRaw: async (p) => ({ id: (p && p.id) || null, requestRaw: 'RAW' }),
            getKeep: async () => 5,
        },
    };
    const api = { extension: { store: {} } };
    if (withDev) api.dev = dev;
    globalThis.window.__TAURITAVERN__ = { abiVersion: 1, ready: Promise.resolve(true), api };
    ttResetSession();
    return { dev, abi: globalThis.window.__TAURITAVERN__ };
}

(async function main() {
    console.log('\n[A] 契约与端口');
    {
        useVanilla();
        A('A1 协议常量与状态快照结构完整',
            BRIDGE_PROTOCOL === 1 && BRIDGE_DEFAULT_PORT === 8791
            && (() => { const s = bridgeState(); return s.protocol === 1 && typeof s.supported === 'boolean' && typeof s.running === 'boolean'
                && typeof s.port === 'number' && typeof s.methodCount === 'number' && typeof s.calls === 'number' && !!s.host; })(),
            bridgeState());

        A('A2 setBridgePort 只接受 1-65535 的整数；非法值不改动',
            setBridgePort(8791) === true && bridgePort() === 8791
            && setBridgePort(0) === false && setBridgePort(65536) === false && setBridgePort('abc') === false && setBridgePort(1.5) === false
            && bridgePort() === 8791);

        // v3.0.8：目标主机（默认回环；可改为局域网地址以调试手机端）
        A('A3 目标主机默认回环，且 isLoopbackHost 判定正确',
            BRIDGE_DEFAULT_HOST === '127.0.0.1' && bridgeTarget() === BRIDGE_DEFAULT_HOST
            && isLoopbackHost('127.0.0.1') && isLoopbackHost('localhost') && isLoopbackHost('::1')
            && !isLoopbackHost('192.168.1.50') && !isLoopbackHost('example.local'));

        A('A4 setBridgeHost 接受主机名/IPv4/方括号 IPv6，拒绝带协议或路径的输入（非法值不改动）', (() => {
            const okCases = ['192.168.1.50', 'my-host.local', '[::1]', 'localhost'];
            const badCases = ['http://x', 'a/b', 'a b', '"x"', '', null, 'a'.repeat(300)];
            const okAll = okCases.every((h) => { const r = setBridgeHost(h); return r === true && bridgeTarget() === h; });
            setBridgeHost('10.0.0.9');
            const badAll = badCases.every((h) => setBridgeHost(h) === false);
            return okAll && badAll && bridgeTarget() === '10.0.0.9';
        })(), { target: bridgeTarget() });

        A('A5 bridgeState 暴露目标主机与是否回环（供 UI 提示与外部工具识别）', (() => {
            setBridgeHost('127.0.0.1');
            const s1 = bridgeState();
            setBridgeHost('192.168.1.50');
            const s2 = bridgeState();
            const r = s1.targetHost === '127.0.0.1' && s1.loopback === true && s2.targetHost === '192.168.1.50' && s2.loopback === false;
            setBridgeHost('127.0.0.1');
            return r;
        })(), bridgeState());
    }

    console.log('\n[B] 只读白名单与派发语义');
    {
        useVanilla();
        bridgeResetStats();
        setBridgeMethods({ 'x.ok': async () => ({ n: 1 }), 'x.boom': async () => { throw new Error('内部炸了'); } });

        const okRes = await bridgeDispatch({ id: 1, method: 'x.ok' });
        A('B1 已登记方法正常回传 {id, ok:true, result}', okRes.id === 1 && okRes.ok === true && okRes.result.n === 1, okRes);

        const denyRes = await bridgeDispatch({ id: 2, method: 'dbgClear' });
        A('B2 未登记方法被拒（E_METHOD）且计入 denied', denyRes.ok === false && denyRes.error.code === 'E_METHOD' && bridgeStats().denied === 1, denyRes);

        const boomRes = await bridgeDispatch({ id: 3, method: 'x.boom' });
        A('B3 方法内部抛错被收敛为 E_CALL（不外抛）', boomRes.ok === false && boomRes.error.code === 'E_CALL' && boomRes.error.message === '内部炸了', boomRes);

        const weird = await bridgeDispatch(null);
        A('B4 畸形请求帧（null / 无 method）也返回帧而非抛错', weird && weird.ok === false && weird.error.code === 'E_METHOD', weird);

        setBridgeMethods({ 'x.bad': 123, 'x.good': async () => 1 });
        A('B5 setBridgeMethods 过滤非函数值', bridgeMethodNames().length === 1 && bridgeMethodNames()[0] === 'x.good', bridgeMethodNames());

        // —— 真实白名单：只读、无改动型动作 ——
        const T = buildBridgeMethods();
        const names = Object.keys(T).sort();
        setBridgeMethods(T);
        A('B6 内置白名单方法名齐备（快照式断言，新增/删除需同步本断言）',
            names.join(',') === [
                'ftt.chatMeta', 'ftt.chatReady', 'ftt.clockTraceInfo', 'ftt.clockTraceSummary',
                'ftt.dataHealth', 'ftt.dataHealthText',                      // v3.11.0：数据体检（只读）
                'ftt.debugLogStats', 'ftt.debugPageInfo',
                'ftt.fileTransport', 'ftt.floorDiag', 'ftt.ledger', 'ftt.loadDiag', 'ftt.memorySample', 'ftt.memoryShape',
                'ftt.pendingFloors', 'ftt.pendingScan', 'ftt.plotScope', 'ftt.probe', 'ftt.readLedgerText', 'ftt.reads', 'ftt.snapshot', 'ftt.stateSize', 'ftt.traceStats',
                'ftt.writeStats',                                            // v3.15.1：原生写队列诊断（并发峰值 / 最近一次写）
                'host.backendLogsTail', 'host.consoleCaptureGet', 'host.frontendLogsList',
                'host.llmLogsIndex', 'host.llmLogsKeep', 'host.llmLogsPreview', 'host.llmLogsRaw',
                'sys.bridgeState', 'sys.host', 'sys.info', 'sys.methods',
            ].join(','), names);

        // 显式黑名单：已知的改动型动作 / 写入型开关，一律不得登记
        const FORBIDDEN = ['dbgClear', 'clockTraceClear', 'dbgExport', 'dbgExportLog', 'exportBundle', 'setConsoleCaptureEnabled',
            'llmLogsSetKeep', 'reset', 'repair', 'analyze', 'save', 'delete', 'clear'];
        A('B7 白名单内不含任何已知改动型动作 / 写入型开关（显式黑名单）',
            !names.some((n) => FORBIDDEN.some((f) => n === f || n.endsWith('.' + f))),
            { names, forbidden: FORBIDDEN });
        A('B8 插件调试导出里的改动型动作确实存在但**未**被登记（对照）',
            DEBUG_ACTIONS.indexOf('dbgClear') >= 0 && names.indexOf('ftt.dbgClear') < 0 && names.indexOf('dbgClear') < 0);

        // v3.0.8 回归：真机上发现 memoryShape 的维度名写错（states/roster）导致两项恒为 null
        setBridgeMethods(buildBridgeMethods());
        setKernelState(emptyState());
        state.currentStates = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
        state.npcs = [{ id: 'n1' }];
        state.atoms = [{ id: 'a1' }];
        const shape = (await bridgeDispatch({ id: 'shape', method: 'ftt.memoryShape' })).result;
        A('B9 memoryShape 键集从 DIMENSIONS 派生（+ npcs/vars/deleted），且**不含**写错的 states / roster',
            DIMENSIONS.every((d) => Object.prototype.hasOwnProperty.call(shape, d.kind))
            && ['npcs', 'vars', 'deleted'].every((k) => Object.prototype.hasOwnProperty.call(shape, k))
            && !Object.prototype.hasOwnProperty.call(shape, 'states')
            && !Object.prototype.hasOwnProperty.call(shape, 'roster'),
            Object.keys(shape));

        A('B10 memoryShape 对真实容器返回条数（currentStates / npcs 不再为 null）',
            shape.currentStates === 3 && shape.npcs === 1 && shape.atoms === 1,
            { currentStates: shape.currentStates, npcs: shape.npcs, atoms: shape.atoms });
    }

    console.log('\n[C] 跨宿主兼容（核心要求）');
    {
        // —— C1/C2 酒馆原生（无 TauriTavern）——
        useVanilla();
        const T = buildBridgeMethods();
        setBridgeMethods(T);
        const h = bridgeHost();
        A('C1 无 TauriTavern → 识别为酒馆原生（vanilla），devApi=false',
            h.kind === 'vanilla' && h.tauriTavern === false && h.devApi === false, h);

        let hostAllDegraded = true;
        const degraded = [];
        for (const name of Object.keys(T).filter((n) => n.indexOf('host.') === 0)) {
            const r = await bridgeDispatch({ id: name, method: name });
            const good = r.ok === true && r.result && r.result.available === false && typeof r.result.reason === 'string';
            if (!good) { hostAllDegraded = false; degraded.push({ name, r }); }
        }
        A('C2 酒馆原生下 host.* 全部降级为 {available:false, reason} —— 不抛、不报错', hostAllDegraded, degraded);

        const vanillaSys = await bridgeDispatch({ id: 's', method: 'sys.host' });
        A('C3 酒馆原生下 sys.host 仍可读（仅报告宿主类型）', vanillaSys.ok === true && vanillaSys.result.kind === 'vanilla');

        // —— C4/C5 TauriTavern ——
        const tt = useTauriTavern(true);
        setBridgeMethods(buildBridgeMethods());
        const h2 = bridgeHost();
        A('C4 装了 __TAURITAVERN__ → 识别为 TauriTavern，devApi=true，ABI 版本可读',
            h2.kind === 'tauritavern' && h2.tauriTavern === true && h2.devApi === true && h2.abiVersion === 1, h2);

        const logs = await bridgeDispatch({ id: 'l', method: 'host.frontendLogsList' });
        const cap = await bridgeDispatch({ id: 'c', method: 'host.consoleCaptureGet' });
        const llm = await bridgeDispatch({ id: 'm', method: 'host.llmLogsPreview', params: { id: 7 } });
        A('C5 TauriTavern 下 host.* 真的调到 api.dev 并把结果回传（不经页面 DOM）',
            logs.ok === true && Array.isArray(logs.result) && logs.result[0].message === 'hi'
            && cap.ok === true && cap.result === true
            && llm.ok === true && llm.result.requestReadable === 'REQ' && llm.result.id === 7,
            { logs: logs.result, cap: cap.result, llm: llm.result });

        useTauriTavern(false);
        setBridgeMethods(buildBridgeMethods());
        const noDev = await bridgeDispatch({ id: 'd', method: 'host.backendLogsTail' });
        A('C6 TauriTavern 但该版本没有 api.dev → 仍只降级，不抛',
            noDev.ok === true && noDev.result.available === false && /api\.dev|不可用/.test(String(noDev.result.reason)), noDev);

        // —— C7 无 WebSocket 的极端环境 ——
        useVanilla();
        setBridgeMethods(buildBridgeMethods());
        const desc = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
        let hid = false;
        try {
            Object.defineProperty(globalThis, 'WebSocket', { value: undefined, configurable: true, writable: true });
            hid = (typeof globalThis.WebSocket !== 'function');
        } catch (e) { hid = false; }
        bridgeResetProbe();
        const stNoWs = bridgeState();
        let startNoWs = null;
        try { startNoWs = bridgeStart(); } catch (e) { startNoWs = { ok: 'threw', message: String(e && e.message) }; }
        const c7 = hid
            ? (stNoWs.supported === false && startNoWs.ok === false && typeof startNoWs.reason === 'string' && /WebSocket/.test(startNoWs.reason))
            : (startNoWs && startNoWs.ok !== 'threw');   // 环境不允许隐藏时退化为「不抛」检查
        if (desc) { try { Object.defineProperty(globalThis, 'WebSocket', desc); } catch (e) { /* 忽略 */ } }
        bridgeResetProbe();
        A('C7 无 WebSocket 环境：supported=false、start 返回原因且不抛、状态仍可读',
            c7 && startNoWs.ok !== 'threw' && typeof bridgeState().methodCount === 'number',
            { hid, st: { supported: stNoWs.supported }, start: startNoWs });
    }

    console.log('\n[D] 装配与 UI 区块');
    {
        useVanilla();
        const r1 = installDebugBridge();
        const r2 = installDebugBridge();
        A('D1 installDebugBridge 幂等且登记了白名单方法', r1.ok === true && r1.methods === r2.methods && r1.methods >= 20 && debugBridgeInstalled() === true, r1);

        const html = debugBridgeSectionHtml();
        A('D2 调试桥区块渲染出开关 / 目标输入 / 状态与只读说明',
            html.indexOf('🔌 调试桥') >= 0 && html.indexOf('data-ftt-action="bridgeToggle"') >= 0
            && html.indexOf('data-ftt-bridge-port') >= 0 && html.indexOf('data-ftt-action="bridgeTargetSet"') >= 0
            && html.indexOf('只读') >= 0, html.slice(0, 240));

        A('D3 调试桥动作已登记进 DEBUG_ACTIONS（经面板分发可达）',
            DEBUG_ACTIONS.indexOf('bridgeToggle') >= 0 && DEBUG_ACTIONS.indexOf('bridgeTargetSet') >= 0
            && DEBUG_ACTIONS.indexOf('bridgePortSet') >= 0, DEBUG_ACTIONS.slice());

        A('D6 区块含目标主机输入与保存目标按钮（v3.0.8）',
            html.indexOf('data-ftt-bridge-host') >= 0 && html.indexOf('data-ftt-action="bridgeTargetSet"') >= 0
            && html.indexOf('data-ftt-bridge-port') >= 0, html.slice(0, 320));

        A('D7 目标为本机时不显示局域网告警；改为局域网地址后显示告警（只读面暴露提示）', (() => {
            setBridgeHost('127.0.0.1');
            const loop = debugBridgeSectionHtml();
            setBridgeHost('192.168.1.50');
            const lan = debugBridgeSectionHtml();
            setBridgeHost('127.0.0.1');
            return loop.indexOf('对局域网开放') < 0 && lan.indexOf('对局域网开放') >= 0;
        })());

        // 酒馆原生下区块必须如实说明「host.* 不可用但不报错」
        const vanillaHtml = debugBridgeSectionHtml();
        A('D4 酒馆原生时区块如实提示宿主日志类方法不可用（且不显示为错误）',
            vanillaHtml.indexOf('酒馆原生') >= 0 && vanillaHtml.indexOf('不可用') >= 0, vanillaHtml.length);

        const ttHtml = (() => { useTauriTavern(true); return debugBridgeSectionHtml(); })();
        A('D5 TauriTavern 时区块显示宿主与 api.dev 可用性', ttHtml.indexOf('TauriTavern') >= 0 && ttHtml.indexOf('api.dev') >= 0, ttHtml.slice(0, 200));
    }

    console.log('\n[E] 生命周期不抛错');
    {
        useVanilla();
        for (const name of ['sys.info', 'sys.methods', 'sys.host', 'sys.bridgeState', 'ftt.snapshot', 'ftt.probe', 'ftt.stateSize',
            'ftt.debugLogStats', 'ftt.debugPageInfo', 'ftt.traceStats', 'ftt.clockTraceInfo', 'ftt.clockTraceSummary',
            'ftt.fileTransport', 'ftt.chatMeta', 'ftt.memoryShape', 'ftt.reads']) {
            const r = await bridgeDispatch({ id: name, method: name });
            A('E1 酒馆原生下 ' + name + ' 返回帧且不抛', r && typeof r.ok === 'boolean', r);
        }
        const sample = await bridgeDispatch({ id: 's', method: 'ftt.memorySample', params: { dim: 'not_a_dim' } });
        A('E2 不存在的维度取样降级为 {available:false}', sample.ok === true && sample.result.available === false, sample);

        let stopped = null;
        try { stopped = bridgeStop(); } catch (e) { stopped = { threw: String(e && e.message) }; }
        A('E3 stop 在未开启时也安全（幂等）', stopped && stopped.threw === undefined && stopped.running === false, stopped);

        let started = null;
        try { started = bridgeStart(); } catch (e) { started = { threw: String(e && e.message) }; }
        const st = bridgeState();
        try { bridgeStop(); } catch (e) { /* 忽略 */ }
        A('E4 start 幂等且不抛（连不上也不影响插件主流程）', started && started.threw === undefined && typeof st.running === 'boolean', { started, running: st.running });
    }

    console.log('\n[F] 台账 / 未摘要清单的只读诊断（v3.0.9）');
    {
        // 合成聊天：偶数楼 AI（有 swipes），奇数楼用户 —— 与真实聊天同构
        const mkChat = (n) => {
            const arr = [];
            for (let i = 0; i < n; i++) {
                const isUser = i % 2 === 1;
                const text = '第' + i + '楼：' + (isUser ? '角色甲问了一句。' : '角色乙在仓库清点货物，记下账目与数目。');
                arr.push(isUser
                    ? { is_user: true, mes: text, swipes: null }
                    : { is_user: false, role: 'assistant', mes: text, swipes: [text] });
            }
            return arr;
        };
        installGlobalHost(makeHost({ chat: mkChat(10) }), doc);
        setBridgeMethods(buildBridgeMethods());
        setKernelState(emptyState());
        setLastMessageId(9);

        const h2 = hashFloorText(2);
        state.processedFloors = [{ f: 2, h: h2 }, { f: 200, h: 'stale-out-of-range' }];
        state.processedVer = processedVerTag();
        state.lastKnownFloor = 9;

        /** 走调试桥派发（与外部工具同路径） */
        const call = (m, p) => bridgeDispatch({ id: m, method: m, params: p || {} });

        const ledger = await call('ftt.ledger');
        A('F1 FTT.ledger 回传台账标记 + 签名一致性（只读）',
            ledger.ok === true && ledger.result.marks.length === 2 && ledger.result.marks[0].f === 2
            && ledger.result.marks[0].h === h2 && ledger.result.verMatches === true && ledger.result.stats.marks === 2, ledger);

        const ready = await call('ftt.chatReady');
        A('F2 FTT.chatReady 回传就绪判定与总楼层',
            ready.ok === true && ready.result.ready === true && ready.result.total === 10, ready);

        const d2 = await call('ftt.floorDiag', { i: 2 });
        A('F3 已登记且哈希一致的楼 → processed / 不进未摘要',
            d2.ok === true && d2.result.markSameHash === true && d2.result.processed === true && d2.result.wouldBePending === false, d2);

        const d4 = await call('ftt.floorDiag', { i: 4 });
        A('F4 无标记的 AI 楼 → 未摘要（且如实给出各项判据）',
            d4.ok === true && d4.result.markPresent === false && d4.result.processed === false
            && d4.result.wouldBePending === true && d4.result.analyzableLen > 0 && d4.result.hashStable !== '', d4);

        const d3 = await call('ftt.floorDiag', { i: 3 });
        A('F5 用户楼 → 即使无标记也不列为未摘要（isUser 判据）',
            d3.ok === true && d3.result.isUser === true && d3.result.wouldBePending === false, d3);

        const keepMarks = state.processedFloors;
        state.processedFloors = [{ f: 2, h: 'deadbeef' }];
        const dBad = await call('ftt.floorDiag', { i: 2 });
        state.processedFloors = keepMarks;
        A('F6 标记哈希与当前正文不符 → processed=false（内容变更需重分析）',
            dBad.result.markPresent === true && dBad.result.markSameHash === false
            && dBad.result.processed === false && dBad.result.wouldBePending === true, dBad);

        const dOut = await call('ftt.floorDiag', { i: 999 });
        A('F7 越界/不存在的楼 → 降级返回而不抛',
            dOut.ok === true && dOut.result.available === false && typeof dOut.result.reason === 'string', dOut);

        // ★ 核心不变量：诊断只读 —— 不得触发任何台账维护（migrate/drift/reconcile/shrink）
        const snapBefore = JSON.stringify({ pf: state.processedFloors, ver: state.processedVer, lk: state.lastKnownFloor });
        const scan = await call('ftt.pendingScan');
        await call('ftt.ledger');
        await call('ftt.pendingFloors');
        await call('ftt.floorDiag', { i: 2 });
        await call('ftt.floorDiag', { i: 4 });
        await call('ftt.floorDiag', { i: 999 });
        const snapAfter = JSON.stringify({ pf: state.processedFloors, ver: state.processedVer, lk: state.lastKnownFloor });
        A('F8 诊断**零副作用**：不改动台账，越界悬空标记原样保留',
            snapBefore === snapAfter && state.processedFloors.some((x) => x.h === 'stale-out-of-range') && scan.ok === true, snapAfter);

        A('F9 pendingScan 给出跳过计数与清单（processed=1 · user=5，2/3 不列入）',
            scan.ok === true && scan.result.skipped.processed === 1 && scan.result.skipped.user === 5
            && scan.result.floors.indexOf(2) < 0 && scan.result.floors.indexOf(3) < 0
            && scan.result.floors.indexOf(4) >= 0 && scan.result.floors.indexOf(0) >= 0, scan);

        const pfOnly = await call('ftt.pendingFloors');
        A('F10 pendingFloors 与 pendingScan 的清单同源一致',
            pfOnly.ok === true && Array.isArray(pfOnly.result) && JSON.stringify(pfOnly.result) === JSON.stringify(scan.result.floors), pfOnly);

        // v3.0.10：载入链路诊断（内存 / 本机缓冲 / 服务端文件 / 调试日志）
        const ld = await call('ftt.loadDiag');
        A('F11 loadDiag 给出内存台账 + 本机缓冲 + 服务端文件 + 台账日志四处（只读）',
            ld.ok === true && !!ld.result.memory && typeof ld.result.memory.marks === 'number'
            && !!ld.result.localBuffer && Object.prototype.hasOwnProperty.call(ld.result, 'file')
            && Array.isArray(ld.result.ledgerLog), ld);

        A('F12 loadDiag 也不改动台账（内存标记数前后一致）',
            ld.result.memory.marks === state.processedFloors.length, { got: ld.result.memory.marks, now: state.processedFloors.length });
    }

    try { unHost(); } catch (e) { /* 忽略 */ }
    R.done();
})();
