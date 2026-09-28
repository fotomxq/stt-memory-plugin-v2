// ============================================================
// 单元测试 · 本地调试桥（v3.0.7）
//   `adapters/debug-bridge.js` + `ui/debug.js` 的桥接装配
//
// 重点覆盖用户硬要求：
//   ① **跨宿主**：酒馆原生（浏览器）与 TauriTavern 都能用；
//   ② **非 TauriTavern 不崩溃**：宿主类方法只降级返回，不抛错；
//   ③ **只读**：只派发白名单方法，改动型动作一律拒绝。
// ============================================================
import { makeReporter, makeDocument, makeHost, installGlobalHost } from '../harness/st-mock.js';
import {
    bridgeDispatch, bridgeState, bridgeStats, bridgeResetStats, bridgeSupported, bridgeHost,
    bridgeMethodNames, setBridgeMethods, setBridgePort, bridgePort, bridgeStart, bridgeStop,
    bridgeResetProbe, BRIDGE_PROTOCOL, BRIDGE_DEFAULT_PORT,
} from '../../adapters/debug-bridge.js';
import { ttResetSession } from '../../adapters/tt-store.js';
import { buildBridgeMethods, installDebugBridge, debugBridgeInstalled, debugBridgeSectionHtml, DEBUG_ACTIONS } from '../../ui/debug.js';

const R = makeReporter('debug-bridge v3.0.7 本地调试桥（跨宿主 / 只读 / 非 TauriTavern 不崩）');
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
                'ftt.chatMeta', 'ftt.clockTraceInfo', 'ftt.clockTraceSummary', 'ftt.debugLogStats', 'ftt.debugPageInfo',
                'ftt.fileTransport', 'ftt.memorySample', 'ftt.memoryShape', 'ftt.probe', 'ftt.snapshot', 'ftt.stateSize', 'ftt.traceStats',
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
        A('D2 调试桥区块渲染出开关 / 端口输入 / 状态与只读说明',
            html.indexOf('🔌 调试桥') >= 0 && html.indexOf('data-ftt-action="bridgeToggle"') >= 0
            && html.indexOf('data-ftt-bridge-port') >= 0 && html.indexOf('data-ftt-action="bridgePortSet"') >= 0
            && html.indexOf('只读') >= 0, html.slice(0, 240));

        A('D3 调试桥动作已登记进 DEBUG_ACTIONS（经面板分发可达）',
            DEBUG_ACTIONS.indexOf('bridgeToggle') >= 0 && DEBUG_ACTIONS.indexOf('bridgePortSet') >= 0, DEBUG_ACTIONS.slice());

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
            'ftt.fileTransport', 'ftt.chatMeta', 'ftt.memoryShape']) {
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

    try { unHost(); } catch (e) { /* 忽略 */ }
    R.done();
})();
