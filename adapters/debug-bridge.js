// ============================================================
// adapters/debug-bridge.js —— 本地调试桥（**插件内的服务端**）
//
// 背景（为什么是这个方向）：
//   WebView 页面**无法监听端口**，TauriTavern 也没有打包任何 http-server 类 Tauri 插件，
//   所以「插件自己起一个本地端口」物理上做不到。可行等价物是**反向桥**：
//   本机由调试工具监听端口，插件（真实宿主里的页面）**拨出**连接过去。
//   数据面一致 —— 外部工具照样能通过一个本地端口调用插件内置好的只读 API。
//
// 跨宿主兼容（硬要求）：
//   · **酒馆原生**（浏览器）与 **TauriTavern** 都能跑：本模块只依赖 `WebSocket`（两端都有）；
//   · **非 TauriTavern 不崩溃**：`host.*` 那层要经 `__TAURITAVERN__.api.dev` 特性检测，
//     没有就返回 `{ available:false, reason }`，**绝不抛错**、绝不在加载期触碰宿主全局；
//   · 不支持 `WebSocket` 的极端环境（老 WebView / 无浏览器的单测）→ `bridgeStart()` 返回
//     明确原因，UI 照常渲染，不抛。
//   · 目标主机默认**回环**（只连本机）；v3.0.8 起可改为局域网地址，用于调试**手机端**的
//     TauriTavern —— 该用法会把只读调试面暴露在局域网，UI 会显著提示，故默认绝不放开。
//
// 安全约定：
//   · **只读**：只派发显式登记的方法（白名单）；未登记一律拒绝。
//     登记表由 `ui/debug.js` 组装，只挑只读导出（不含 dbgClear / reset 这类改动型动作）；
//   · **默认关闭、且不持久化**：每次页面加载都回到关闭态，不会「上次开了这次自动开」；
//   · 不写宿主配置、不写插件数据 —— 本模块只做「读 + 回传」。
// ============================================================
import { VERSION, MODULE_NAME } from '../core/constants.js';
import { ttDetected, ttAbi } from './tt-store.js';

/** 协议版本（外部工具据此判断兼容） */
export const BRIDGE_PROTOCOL = 1;
/** 默认端口（与 `tests/local/bridge.mjs` 的默认值一致；端口只存内存，不落配置） */
export const BRIDGE_DEFAULT_PORT = 8791;
/** 默认目标主机（**回环**：只连本机；v3.0.8 起可改为局域网地址以调试手机端） */
export const BRIDGE_DEFAULT_HOST = '127.0.0.1';
/** 断线重连间隔 */
export const BRIDGE_RETRY_MS = 3000;
/** 未登记方法一律拒绝；此列表仅用于报错文案与单测断言 */
export const BRIDGE_DENY_PREFIX = '拒绝：方法未登记（调试桥只派发白名单内的只读方法）';

let ctorCache;                 // WebSocket 构造器（undefined = 未探测）
let methods = Object.create(null);   // 白名单：name -> fn(params) => any
let socket = null;
let running = false;
let port = BRIDGE_DEFAULT_PORT;
let target = BRIDGE_DEFAULT_HOST;
let retryTimer = null;
let connSeq = 0;
const stats = { calls: 0, errors: 0, denied: 0, byMethod: Object.create(null) };
let lastCall = null;
let lastError = '';
let lastHello = 0;

/** 取 WebSocket 构造器（**不做任何假设**：老 WebView/无浏览器环境返回 null） */
function wsCtor() {
    if (ctorCache === undefined) {
        try {
            ctorCache = (typeof WebSocket === 'function') ? WebSocket : ((typeof globalThis !== 'undefined' && typeof globalThis.WebSocket === 'function') ? globalThis.WebSocket : null);
        } catch (e) { ctorCache = null; }
    }
    return ctorCache;
}

/** 单测/宿主切换时重置构造器探测缓存 */
export function bridgeResetProbe() { ctorCache = undefined; }

/** 本环境是否具备调试桥的传输能力 */
export function bridgeSupported() { return !!wsCtor(); }

/**
 * 宿主识别（**只读探测，不触碰任何会抛的 API**）。
 * 与 `adapters/tt-store.js` 同源：TauriTavern 判定用 `ttDetected()`。
 */
export function bridgeHost() {
    let tauriTavern = false;
    let abiVersion = null;
    let apiKeys = [];
    try {
        tauriTavern = !!ttDetected();
        const abi = tauriTavern ? ttAbi() : null;
        if (abi) {
            abiVersion = (abi.abiVersion === undefined ? null : abi.abiVersion);
            apiKeys = (abi.api && typeof abi.api === 'object') ? Object.keys(abi.api) : [];
        }
    } catch (e) { /* 宿主探测失败按「非 TauriTavern」处理，绝不外抛 */ }
    return {
        kind: tauriTavern ? 'tauritavern' : 'vanilla',       // vanilla = 酒馆原生（浏览器）
        tauriTavern,
        abiVersion,
        apiKeys,
        devApi: apiKeys.indexOf('dev') >= 0,
    };
}

/** 登记/替换白名单方法表（由 `ui/debug.js` 组装） */
export function setBridgeMethods(table) {
    const next = Object.create(null);
    if (table && typeof table === 'object') {
        for (const k of Object.keys(table)) {
            if (typeof table[k] === 'function') next[k] = table[k];
        }
    }
    methods = next;
    return Object.keys(next).length;
}

/** 已登记方法名（排序） */
export function bridgeMethodNames() {
    try { return Object.keys(methods).sort(); } catch (e) { return []; }
}

/** 设置端口（1–65535；非法值返回 false 且不改动） */
export function setBridgePort(p) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return false;
    port = n;
    return true;
}

export function bridgePort() { return port; }

/** 目标主机（回环 = 只连本机） */
export function bridgeTarget() { return target; }

/** 该主机是否回环（非回环意味着把只读调试面暴露在局域网上，UI 会提示） */
export function isLoopbackHost(h) {
    const s = String(h == null ? '' : h).trim().toLowerCase();
    return s === '127.0.0.1' || s === 'localhost' || s === '::1' || s === '[::1]';
}

/**
 * 设置目标主机（默认 `127.0.0.1`）。
 * 只接受主机名 / IPv4 / 方括号 IPv6 —— 拒绝带协议、路径、空格或引号的输入，
 * 以免拼出意料之外的 URL。非法值返回 false 且**不改动**。
 */
export function setBridgeHost(h) {
    const s = String(h == null ? '' : h).trim();
    if (!s || s.length > 253) return false;
    const ok = /^[A-Za-z0-9._-]+$/.test(s) || /^\[[0-9A-Fa-f:.]+\]$/.test(s);
    if (!ok) return false;
    target = s;
    return true;
}

/** 只读状态快照（供 UI 与外部工具读取；不含任何函数引用） */
export function bridgeState() {
    const host = bridgeHost();
    return {
        supported: bridgeSupported(),
        running,
        connected: !!(socket && socket.readyState === 1),
        // 注意：`host` 这个键在既有契约里表示**宿主类型**（vanilla / tauritavern），
        // 目标主机另用 `targetHost` —— v3.0.8 初版曾键名撞车导致目标主机读不到。
        targetHost: target,
        loopback: isLoopbackHost(target),
        port,
        protocol: BRIDGE_PROTOCOL,
        version: VERSION,
        moduleName: MODULE_NAME,
        host: host.kind,
        tauriTavern: host.tauriTavern,
        devApi: host.devApi,
        methodCount: bridgeMethodNames().length,
        calls: stats.calls,
        errors: stats.errors,
        denied: stats.denied,
        lastCall,
        lastError,
        lastHello,
    };
}

export function bridgeStats() {
    return { calls: stats.calls, errors: stats.errors, denied: stats.denied, byMethod: Object.assign({}, stats.byMethod) };
}

/** 供单测/诊断：重置统计 */
export function bridgeResetStats() {
    stats.calls = 0; stats.errors = 0; stats.denied = 0; stats.byMethod = Object.create(null);
    lastCall = null; lastError = ''; lastHello = 0;
}

/**
 * 派发一帧请求（**纯逻辑，不经网络**：单测直接调它即可覆盖白名单与只读语义）。
 * 请求形如 `{ id, method, params? }`；返回响应帧 `{ id, ok, result|error }`。
 * 任何异常都被收敛成 `ok:false` 帧 —— 调试桥**永不把异常抛给调用方**。
 */
export async function bridgeDispatch(frame) {
    const id = (frame && frame.id !== undefined) ? frame.id : null;
    const method = String((frame && frame.method) || '');
    const params = (frame && frame.params) || {};
    try {
        const fn = methods[method];
        if (typeof fn !== 'function') {
            stats.denied++;
            lastError = '未登记方法：' + method;
            return { id, ok: false, error: { code: 'E_METHOD', message: BRIDGE_DENY_PREFIX + '：' + method } };
        }
        stats.calls++;
        stats.byMethod[method] = (stats.byMethod[method] || 0) + 1;
        const startedAt = Date.now();
        let result;
        try {
            result = await fn(params);
        } catch (e) {
            stats.errors++;
            const msg = String((e && e.message) || e);
            lastCall = { method, at: startedAt, ms: Date.now() - startedAt, ok: false };
            lastError = msg;
            return { id, ok: false, error: { code: 'E_CALL', message: msg } };
        }
        lastCall = { method, at: startedAt, ms: Date.now() - startedAt, ok: true };
        lastError = '';
        return { id, ok: true, result: (result === undefined ? null : result) };
    } catch (e) {
        // 兜底：连派发框架自身出错也不外抛
        stats.errors++;
        const msg = String((e && e.message) || e);
        lastError = msg;
        return { id, ok: false, error: { code: 'E_FATAL', message: msg } };
    }
}

function send(payload) {
    try {
        if (socket && socket.readyState === 1) { socket.send(JSON.stringify(payload)); return true; }
    } catch (e) { lastError = String((e && e.message) || e); }
    return false;
}

/** 握手：把插件与宿主信息交给外部工具（不含任何用户数据） */
function helloPayload() {
    const host = bridgeHost();
    return {
        type: 'hello',
        protocol: BRIDGE_PROTOCOL,
        plugin: { name: 'FTT记忆组件 V2', moduleName: MODULE_NAME, version: VERSION },
        host: { kind: host.kind, tauriTavern: host.tauriTavern, abiVersion: host.abiVersion, devApi: host.devApi },
        methods: bridgeMethodNames(),
    };
}

function scheduleRetry() {
    if (!running || retryTimer) return;
    try {
        retryTimer = setTimeout(() => { retryTimer = null; if (running) open(); }, BRIDGE_RETRY_MS);
    } catch (e) { retryTimer = null; }
}

function open() {
    const C = wsCtor();
    if (!running || !C) return;
    const url = 'ws://' + target + ':' + port;
    let ws;
    try { ws = new C(url); } catch (e) {
        lastError = '无法创建 WebSocket：' + String((e && e.message) || e);
        scheduleRetry();
        return;
    }
    socket = ws;
    const seq = ++connSeq;
    try {
        ws.onopen = () => {
            if (seq !== connSeq) return;
            lastError = '';
            lastHello = Date.now();
            send(helloPayload());
        };
        ws.onmessage = (ev) => { void handleMessage(ev); };
        ws.onerror = () => { if (seq === connSeq) lastError = '连接错误（' + target + ':' + port + '）'; };
        ws.onclose = () => {
            if (seq !== connSeq) return;
            socket = null;
            scheduleRetry();
        };
    } catch (e) {
        lastError = '绑定 WebSocket 回调失败：' + String((e && e.message) || e);
        socket = null;
        scheduleRetry();
    }
}

async function handleMessage(ev) {
    let frame = null;
    try { frame = JSON.parse(String((ev && ev.data) || '')); } catch (e) { return; }
    if (!frame || frame.method === undefined) return;
    const res = await bridgeDispatch(frame);
    send(res);
}

/**
 * 启动（幂等）。返回状态快照 —— **任何失败都只体现在状态里，不抛**。
 * @returns {{ok:boolean, reason?:string, state:object}}
 */
export function bridgeStart() {
    if (!bridgeSupported()) {
        lastError = '当前环境不支持 WebSocket（无法建立调试桥）';
        return { ok: false, reason: lastError, state: bridgeState() };
    }
    if (running) return { ok: true, state: bridgeState() };
    running = true;
    lastError = '';
    open();
    return { ok: true, state: bridgeState() };
}

/** 停止（幂等）。同样不抛。 */
export function bridgeStop() {
    running = false;
    connSeq++;
    if (retryTimer) { try { clearTimeout(retryTimer); } catch (e) { /* 忽略 */ } retryTimer = null; }
    try {
        if (socket) { socket.onclose = null; socket.close(); }
    } catch (e) { /* 关闭失败不影响停止语义 */ }
    socket = null;
    return bridgeState();
}
