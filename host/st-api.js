// ============================================================
// host/st-api.js —— 宿主适配层唯一入口：SillyTavern 上下文访问与能力探测
// 规则：只有 host/ adapters/ ui/ index.js 允许触达宿主；core/ 严禁引用本文件。
// 事实源：docs/P0-探针报告.md（getContext 172 键 / setExtensionPrompt 签名 / 更新端点）
// ============================================================

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

/** 取宿主上下文（永不在失败时抛出） */
export function getCtx() {
    try {
        return provider() || null;
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

/** 取当前角色作用域键（char:<hash> 口径与 V1 一致；无角色时用 'default'） */
export function currentCharScope() {
    const ctx = getCtx();
    if (!ctx) return 'default';
    const name = String(ctx.name2 || '').trim();
    const chid = (ctx.characterId === undefined || ctx.characterId === null) ? '' : String(ctx.characterId);
    const raw = name || chid;
    if (!raw) return 'default';
    let h = 0x811c9dc5;
    for (let i = 0; i < raw.length; i++) {
        h ^= raw.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return 'char:' + h.toString(16).padStart(8, '0');
}
