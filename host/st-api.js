// ============================================================
// host/st-api.js —— 宿主适配层唯一入口：SillyTavern 上下文访问与能力探测
// 规则：只有 host/ adapters/ ui/ index.js 允许触达宿主；core/ 严禁引用本文件。
// 事实源：docs/P0-探针报告.md（getContext 172 键 / setExtensionPrompt 签名 / 更新端点）
// ============================================================

import { hashText } from '../core/util.js';
// v2.42.0：宿主调用追踪（把每次经 `getCtx()` 的 API 调用记进 trace —— 「插件交互」层）
import { traceEvent, traceSite, traceSummarize } from '../core/trace.js';
import { cfg } from '../core/model/runtime.js';

function defaultProvider() {
    try {
        const g = globalThis.SillyTavern;
        return (g && typeof g.getContext === 'function') ? g.getContext() : null;
    } catch (e) {
        return null;
    }
}

let provider = defaultProvider;

/** 注入上下文提供者（仅测试用；生产走 globalThis.SillyTavern.getContext()） */
export function setContextProvider(fn) {
    provider = (typeof fn === 'function') ? fn : defaultProvider;
}

/** 恢复默认上下文提供者 */
export function resetContextProvider() {
    provider = defaultProvider;
}

/** 已包装的上下文（按原始 ctx 身份缓存，避免每次 `getCtx()` 重建 Proxy） */
let tracedCtx = null;
let tracedFrom = null;

/**
 * v2.42.0：给宿主上下文套一层**只包装函数属性**的追踪代理 ——
 *   于是「所有插件↔宿主交互」自动入流（方法名 / 参数摘要 / 返回摘要 / 耗时 / 失败原因 / **调用站点 file:line**），
 *   无需在几十个调用点手写日志；非函数属性原样透传（不影响任何既有语义与身份比较）。
 * 关闭 `cfg.debugTraceHost` 时直接返回原始 ctx（零开销）。
 */
function wrapCtx(ctx) {
    if (!ctx || typeof ctx !== 'object') return ctx;
    try { if (cfgTraceOff()) return ctx; } catch (e) { /* 忽略 */ }
    if (tracedCtx && tracedFrom === ctx) return tracedCtx;
    try {
        const cache = new Map();
        const proxy = new Proxy(ctx, {
            get(target, prop) {
                const v = target[prop];
                if (typeof v !== 'function') return v;
                const key = String(prop);
                if (cache.has(key)) return cache.get(key);
                const wrapped = function (...args) {
                    // 站点必须在**调用点**采集（此时栈里就是调用者）
                    const site = traceSite(undefined, ['host/st-api.js']);   // 跳过本包装层 → 站点 = 真正的调用点
                    const t0 = Date.now();
                    // v2.42.0：**调用时重新读取**目标方法 —— 宿主/测试在运行期替换 `ctx.xxx` 时依然生效
                    //   （只缓存包装器本身，不缓存被包装的函数引用）
                    const fn = target[prop];
                    if (typeof fn !== 'function') return undefined;
                    let out; let err = null;
                    try { out = fn.apply(target, args); } catch (e) { err = e; }
                    const ms = Date.now() - t0;
                    const isPromise = !!(out && typeof out.then === 'function');
                    const done = (ok, val, e2) => {
                        try {
                            traceEvent({
                                cat: 'host', kind: key, ok, ms: Date.now() - t0,
                                reason: ok ? '' : String((e2 && e2.message) || e2 || ''),
                                detail: {
                                    args: traceSummarize(args, 0),
                                    ret: ok ? traceSummarize(val, 0) : undefined,
                                },
                                site,
                            });
                        } catch (e3) { /* 追踪失败不影响调用 */ }
                    };
                    if (isPromise) {
                        return out.then((val) => { done(true, val); return val; },
                            (e2) => { done(false, undefined, e2); throw e2; });
                    }
                    done(!err, out, err);
                    if (err) throw err;
                    return out;
                };
                try { Object.defineProperty(wrapped, 'name', { value: key }); } catch (e) { /* 忽略 */ }
                cache.set(key, wrapped);
                return wrapped;
            },
        });
        tracedCtx = proxy; tracedFrom = ctx;
        return proxy;
    } catch (e) { return ctx; }   // Proxy 不可用（极老宿主）→ 原样返回
}
function cfgTraceOff() {
    try { return !!(cfg && cfg.debugTraceHost === false); } catch (e) { return false; }
}

/** 取宿主上下文（永不在失败时抛出）；v2.42.0 起返回**带追踪的代理** */
export function getCtx() {
    try {
        const ctx = provider() || null;
        return ctx ? wrapCtx(ctx) : null;
    } catch (e) {
        return null;
    }
}

/** 是否运行在酒馆扩展环境（非酒馆环境：只做纯逻辑，不碰 DOM 与注入） */
export function hasHost() {
    return !!getCtx();
}

/** 安全调用上下文的某个方法（返回统一结果对象，不抛异常） */
export function safeCall(name, ...args) {
    const ctx = getCtx();
    if (!ctx || typeof ctx[name] !== 'function') return { ok: false, reason: 'missing:' + name };
    try {
        return { ok: true, value: ctx[name].apply(ctx, args) };
    } catch (e) {
        return { ok: false, reason: String((e && e.message) || e) };
    }
}

/**
 * V1 `thApi(name)` 等价：**只认酒馆助手（TavernHelper）** 暴露的函数。
 * V1 的世界书写接口（`updateWorldbookWith` / `deleteWorldbookEntries` / `createWorldbookEntries`）
 * 正是此口径 —— 无 TavernHelper 时返回 null（V1 原样如此，写入静默失败）。
 */
export function tavernApi(name) {
    try {
        const g = globalThis.TavernHelper;
        if (g && typeof g[name] === 'function') return g[name].bind(g);
    } catch (e) { /* 忽略 */ }
    return null;
}

/** V1 `getFn(name)` 等价：TavernHelper → 宿主 ctx（SillyTavern.getContext()）→ 全局 */
export function hostFn(name) {
    const a = tavernApi(name);
    if (a) return a;
    const ctx = getCtx();
    if (ctx && typeof ctx[name] === 'function') return ctx[name].bind(ctx);
    try { if (typeof globalThis[name] === 'function') return globalThis[name].bind(globalThis); } catch (e) { /* 忽略 */ }
    return null;
}

/**
 * 世界书 API 包装（V1 `thApi(name) || getFn(name)` 取值口径，逐项对应）：
 *   `names`（getWorldbookNames）/ `get`（getWorldbook）—— 读取与 `test()` 用；
 *   `update`（updateWorldbookWith）/ `del`（deleteWorldbookEntries）/ `create`（createWorldbookEntries）
 *   —— **V1 写路径只用 `thApi`**，故这里也只用 `tavernApi`（逐字对齐；放宽会改变「无 TavernHelper 时的失败语义」）。
 *
 * ⚠️ 待接线：ST 原生世界书接口（P0 已确证 `loadWorldInfo` / `saveWorldInfo` / `getWorldInfoNames`）到
 *   TH 词条格式（`name` / `strategy` / `position` / `extra`）的**转换层未实现** —— V1 无此路径，
 *   TH→ST 词条字段映射需单独立项。因此纯 ST 环境（无酒馆助手）下世界书通道 `test()` 返回 false。
 */
export function worldbookApi() {
    return {
        names: tavernApi('getWorldbookNames') || hostFn('getWorldbookNames'),
        get: tavernApi('getWorldbook') || hostFn('getWorldbook'),
        update: tavernApi('updateWorldbookWith'),
        del: tavernApi('deleteWorldbookEntries'),
        create: tavernApi('createWorldbookEntries'),
    };
}

/**
 * 能力探测：P0 探针的可执行版本 —— 启动时跑一次，结果进 window.FTT 与调试日志。
 * 只做「有无 / 类型」判定，不产生副作用（不调用会改数据的接口）。
 */
export function probeCapabilities() {
    const ctx = getCtx();
    const need = {
        // 上下文与事件
        context: !!ctx,
        eventSource: !!(ctx && ctx.eventSource && typeof ctx.eventSource.on === 'function'),
        eventTypes: !!(ctx && ctx.eventTypes && typeof ctx.eventTypes === 'object'),
        // 注入
        setExtensionPrompt: !!(ctx && typeof ctx.setExtensionPrompt === 'function'),
        extensionPrompts: !!(ctx && ctx.extensionPrompts && typeof ctx.extensionPrompts === 'object'),
        // 生成
        generateRaw: !!(ctx && typeof ctx.generateRaw === 'function'),
        generateQuietPrompt: !!(ctx && typeof ctx.generateQuietPrompt === 'function'),
        ConnectionManagerRequestService: !!(ctx && ctx.ConnectionManagerRequestService),
        // 存储
        extensionSettings: !!(ctx && ctx.extensionSettings && typeof ctx.extensionSettings === 'object'),
        saveSettingsDebounced: !!(ctx && typeof ctx.saveSettingsDebounced === 'function'),
        chatMetadata: !!(ctx && ctx.chatMetadata && typeof ctx.chatMetadata === 'object'),
        saveMetadata: !!(ctx && typeof ctx.saveMetadata === 'function'),
        accountStorage: !!(ctx && ctx.accountStorage),
        // 会话数据
        chat: !!(ctx && Array.isArray(ctx.chat)),
        characters: !!(ctx && Array.isArray(ctx.characters)),
        characterId: !!(ctx && ctx.characterId !== undefined && ctx.characterId !== null),
        // 世界书
        loadWorldInfo: !!(ctx && typeof ctx.loadWorldInfo === 'function'),
        saveWorldInfo: !!(ctx && typeof ctx.saveWorldInfo === 'function'),
        getWorldInfoNames: !!(ctx && typeof ctx.getWorldInfoNames === 'function'),
        // UI / i18n / 命令 / 宏
        renderExtensionTemplateAsync: !!(ctx && typeof ctx.renderExtensionTemplateAsync === 'function'),
        callGenericPopup: !!(ctx && typeof ctx.callGenericPopup === 'function'),
        addLocaleData: !!(ctx && typeof ctx.addLocaleData === 'function'),
        SlashCommandParser: !!(ctx && ctx.SlashCommandParser && typeof ctx.SlashCommandParser.addCommandObject === 'function'),
        macros: !!(ctx && ctx.macros && typeof ctx.macros.register === 'function'),
        // 变量与宏替换（替代 TH 的 getVariables / replaceVariables）
        variables: !!(ctx && ctx.variables),
        substituteParams: !!(ctx && typeof ctx.substituteParams === 'function'),
        // 更新（ST 原生 git 更新通道）
        getExtensionManifest: !!(ctx && typeof ctx.getExtensionManifest === 'function'),
        fetch: typeof globalThis.fetch === 'function',
    };
    // 必需能力（缺失即视为「宿主不支持」，probe.ok=false）
    const REQUIRED = ['context', 'eventSource', 'eventTypes', 'setExtensionPrompt', 'extensionSettings', 'saveSettingsDebounced', 'generateRaw', 'chat'];
    const missing = Object.keys(need).filter(k => !need[k]);
    const missingRequired = missing.filter(k => REQUIRED.indexOf(k) >= 0);
    const missingOptional = missing.filter(k => REQUIRED.indexOf(k) < 0);
    return { need, missing, missingRequired, missingOptional, ok: missingRequired.length === 0 };
}

/** getExtensionManifest 包装（读取自身扩展清单，用于版本/更新提示） */
export function ownManifest(name) {
    const r = safeCall('getExtensionManifest', name);
    return r.ok ? r.value : null;
}

/**
 * 当前角色作用域键：`char:<hashText(角色稳定标识)>`（**哈希口径与 V1 一致**）。
 * 稳定标识优先级：`characters[characterId].avatar`（ST 的角色文件名，最接近 TH 的角色 id）
 * → `name2`（角色名）→ `characterId`（索引，仅兜底）。
 * 注：ST 的 `characterId` 是数组下标（官方文档明确其非唯一 id），因此不优先使用；
 *     V1→V2 数据导入时若需对齐历史作用域，用导入器的显式 scope 覆盖（P2）。
 */
export function currentCharScope() {
    const ctx = getCtx();
    if (!ctx) return 'default';
    let stable = '';
    try {
        const idx = ctx.characterId;
        const ch = (Array.isArray(ctx.characters) && idx !== undefined && idx !== null) ? ctx.characters[Number(idx)] : null;
        if (ch && ch.avatar) stable = String(ch.avatar);
    } catch (e) { /* 忽略 */ }
    if (!stable) stable = String(ctx.name2 || '').trim();
    if (!stable && ctx.characterId !== undefined && ctx.characterId !== null) stable = String(ctx.characterId);
    if (!stable) return 'default';
    return 'char:' + hashText(stable);
}
