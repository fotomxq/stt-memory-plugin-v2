// ============================================================
// core/api-channel.js —— **API 通道解析与「API 分组」预设**（纯内核，无宿主依赖）
//
// V1 出处（`src/FTT记忆组件-v1.206.js`，行号为该版本）：
//   · `resolveApiFor(override)` 约 2447~2460（预设 → 代理预设 → 主配置三层回落）
//   · `resolveKwApiOverride()` 约 2462、`resolveMemApiOverride()` 约 2467、`resolveParallelApiOverride()` 约 2473
//   · 各用途实际调用点：主渠道 `overrideMain`（14789）· 维度分组 `dimensionPresets[dim]`（14795）
//     · 关键词提取 `'关键词提取'`（12575）· 记忆分析发送 `'记忆分析发送'`（12596）
//     · 平行交织 `'[平行事件·交织]'`（13124）/ 平行推进 `'平行事件推进'`（13941）
//   · 预设动作 `presetSave`/`presetLoad`/`presetDelete` 约 27373~27407；`collectApiBlock` 约 24712
//
// V2 适配（**本批的核心设计**，与 V1 的形态差异逐条登记于 `docs/P10a-API页与按用途渠道对齐.md`）：
//   ① V1 的「API 设定」= 自建 OpenAI 兼容连接（apiType/apiUrl/apiKey/model/proxyPreset）**直连**；
//      V2 有**三种通道**（`cfg.apiChannel`）：
//        · `host`   —— 跟随酒馆当前连接（走宿主 `generateRaw`，即 V2 既有行为，**默认**）；
//        · `profile` —— 酒馆**连接配置**（Connection Manager 的 profile id；经宿主官方扩展通道发送）；
//        · `direct` —— **自建连接**（V1 等价物：地址/Key/模型，插件自己直连 `/chat/completions`）。
//   ② 「API 分组」的语义与 V1 **一致**：一组**连接**设定（不是采样参数）；采样参数（温度/上限/topP）在 V1 里
//      是**全局** `cfg.apiTemperature/apiMaxTokens/apiTopP`（预设条目里没有它们），V2 保持同口径 —— 见 `apiParamsOf()`。
//   ③ 用途优先级**逐条对齐 V1**：显式 `override.preset` → 该用途的分组（`dimensionPresets[dim]` / `parallelApiPreset`
//      / `kwApiPreset` / `memApiPreset`）→ 该用途的独立内联配置（仅 `kwApi`/`memApi`，V1 语义：分组优先于内联）
//      → 当前激活分组 `activeApiPreset`（V1 `overrideMain`）→ 主配置。
//   ④ **本内核不做任何网络**（纯净度要求）：只产出 target 描述对象，宿主 `host/api-channel.js` 负责发送。
//   ⑤ 用途 `kw`（AI 关键词提取）/ `mem`（记忆分析发送）在 V1 属**向量检索层**（`cfg.useVector` 三层结构）；
//      该层在 V2 **尚未实现**，故 V2 暂不渲染这两个用途的选择控件（见文档 §5「未实现项」），但解析逻辑**已就位**，
//      向量层落地时无需再改本文件（避免"假控件"：没有消费者就不给控件）。
// ============================================================
import { cfg } from './model/runtime.js';

/** V2 通道枚举（顺序即 UI 下拉顺序） */
export const API_CHANNELS = ['host', 'profile', 'direct'];
/** 通道文案（UI 与诊断共用；`host` = V2 默认） */
export const API_CHANNEL_LABELS = {
    host: '跟随酒馆当前连接',
    profile: '酒馆连接配置',
    direct: '自建连接（V1 等价）',
};
/** 用途枚举与文案 */
export const API_PURPOSE_LABELS = {
    main: '主渠道',
    parallel: '平行推演',
    dim: '维度分组',
    kw: '关键词提取',
    mem: '记忆分析发送',
};

const str = (v) => String(v == null ? '' : v).trim();
/** V1 逐字：`String(...).trim().replace(/\/+$/, '')`（`resolveApiFor` 对 url 去尾斜杠） */
const trimUrl = (v) => str(v).replace(/\/+$/, '');

/** 已存分组名列表（V1 `Object.keys(cfg.apiPresets || {})`） */
export function apiPresetNames() {
    try { return Object.keys(cfg.apiPresets || {}); } catch (e) { return []; }
}

/** 取分组（V1 `cfg.apiPresets[name]` 存在性判定） */
export function apiPresetGet(name) {
    const n = str(name);
    if (!n) return null;
    try {
        const map = cfg.apiPresets || {};
        return Object.prototype.hasOwnProperty.call(map, n) ? map[n] : null;
    } catch (e) { return null; }
}

/** 分组名归一（V1 `?.value?.trim()`；空名 = 拒绝） */
export function apiPresetName(raw) { return str(raw); }

/**
 * 主通道判定（含**旧数据迁移**）：`cfg.apiChannel` 显式为三通道之一时直接采用；
 * 否则按 V1 老配置推断 —— `apiType==='preset' && proxyPreset` → `profile`；已填地址+模型 → `direct`；否则 `host`。
 * （迁移口径见 docs/P10a §2；`host` 是 V2 既有行为，保证未配置用户行为**完全不变**。）
 */
export function mainApiChannel() {
    const cur = str(cfg.apiChannel);
    if (API_CHANNELS.indexOf(cur) >= 0) return cur;
    // V1 老数据迁移：只要**地址 + 模型**齐备就按「自建连接」处理 —— 这正是 V1 `resolveApiFor` 在代理预设不可用时
    //   的回落结果（v1.206 2459 返回 `cfg.apiUrl/apiKey/model`，且 `callChatCompletion` 直接用它发请求）；
    //   地址/模型缺失时才落 `host`（= 用酒馆自己的连接设置）。见 docs/P10a §3。
    if (trimUrl(cfg.apiUrl) && str(cfg.model)) return 'direct';
    return 'host';
}

/**
 * 某分组条目的通道。V2 新条目直接存 `channel`；
 * **V1 老条目**（只有 `apiType`/`apiUrl`/`apiKey`/`model`/`proxyPreset`）按下列口径迁移：
 *   · 条目自带可用「地址 + 模型」→ `direct`（V1 命中已存分组时返回的正是该条目自己的 url/key/model，v1.206 2449，
 *     **不做**代理预设查表 —— 故这一支与 V1 逐字等价）；
 *   · 地址或模型为空 → `host`（V1 在「代理预设名」可用时会去查酒馆代理预设（2453~2457），V2 无法复现该查表，
 *     于是如实回落「用酒馆自己的连接」，**不伪造地址**）。
 */
export function presetChannel(pr) {
    const p = pr || {};
    const cur = str(p.channel);
    if (API_CHANNELS.indexOf(cur) >= 0) return cur;
    return (trimUrl(p.apiUrl) && str(p.model)) ? 'direct' : 'host';
}

/** 采样参数（V1 全局口径：`apiTemperature` 非数 → 0.2；`apiMaxTokens`/`apiTopP` 空 → 不发送） */
export function apiParamsOf() {
    const tRaw = cfg.apiTemperature;
    const temperature = Number.isFinite(Number(tRaw)) ? Number(tRaw) : 0.2;
    const maxRaw = str(cfg.apiMaxTokens);
    const topRaw = str(cfg.apiTopP);
    return {
        temperature,
        maxTokens: maxRaw === '' ? '' : (Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : ''),
        topP: topRaw === '' ? '' : (Number.isFinite(Number(topRaw)) ? Number(topRaw) : ''),
    };
}

/** 主配置连接（不含采样参数） */
export function mainConnection() {
    return {
        channel: mainApiChannel(),
        profileId: str(cfg.apiProfileId),
        apiUrl: trimUrl(cfg.apiUrl),
        apiKey: str(cfg.apiKey),
        model: str(cfg.model),
    };
}

/** 由「主配置」构造分组条目（V1 `presetSave` 保存的是 `collectApiBlock('main')` 的结果，V2 的主配置即 cfg） */
export function apiPresetBuild(name) {
    const c = mainConnection();
    return {
        // V2 字段
        channel: c.channel,
        profileId: c.profileId,
        // V1 同名字段（保留以便 V1 数据互通与逐字对照）
        apiType: c.channel === 'profile' ? 'preset' : 'custom',
        apiUrl: c.apiUrl,
        apiKey: c.apiKey,
        model: c.model,
        proxyPreset: str(cfg.proxyPreset),
    };
}

/** 保存分组（V1 `case 'presetSave'`：名空 → 拒绝；否则覆盖同名条目） */
export function apiPresetSave(name) {
    const n = apiPresetName(name);
    if (!n) return { ok: false, reason: 'empty-name' };
    cfg.apiPresets = Object.assign({}, cfg.apiPresets || {});
    cfg.apiPresets[n] = apiPresetBuild(n);
    return { ok: true, name: n, preset: cfg.apiPresets[n] };
}

/** 加载分组到主配置（V1 `case 'presetLoad'`：写回连接字段 + `activeApiPreset`） */
export function apiPresetLoad(name) {
    const n = apiPresetName(name);
    const pr = apiPresetGet(n);
    if (!pr) return { ok: false, reason: 'missing' };
    cfg.apiChannel = presetChannel(pr);
    cfg.apiProfileId = str(pr.profileId);
    cfg.apiType = str(pr.apiType) || (cfg.apiChannel === 'profile' ? 'preset' : 'custom');
    cfg.apiUrl = trimUrl(pr.apiUrl);
    cfg.apiKey = str(pr.apiKey);
    cfg.model = str(pr.model);
    cfg.proxyPreset = str(pr.proxyPreset);
    cfg.activeApiPreset = n;
    return { ok: true, name: n };
}

/** 删除分组（V1 `case 'presetDelete'`：**不弹确认**；删除当前激活分组时清空 `activeApiPreset`） */
export function apiPresetDelete(name) {
    const n = apiPresetName(name);
    if (!apiPresetGet(n)) return { ok: false, reason: 'missing' };
    delete cfg.apiPresets[n];
    if (str(cfg.activeApiPreset) === n) cfg.activeApiPreset = '';
    return { ok: true, name: n };
}

/** 某用途的分组名（V1 各自的 `resolve*Override` + `dimensionPresets`） */
export function purposePresetName(purpose, dimension) {
    const p = str(purpose) || 'main';
    if (p === 'kw') return str(cfg.kwApiPreset);
    if (p === 'mem') return str(cfg.memApiPreset);
    if (p === 'parallel') return str(cfg.parallelApiPreset);
    if (p === 'dim') return str((cfg.dimensionPresets || {})[dimension]);
    return '';
}

/** 组装 target（连接 + 采样参数 + 溯源信息） */
function makeTarget(conn, source, purpose, dimension, name) {
    const prm = apiParamsOf();
    return {
        name: str(name),
        source: String(source),
        purpose: String(purpose || 'main'),
        dimension: str(dimension),
        channel: API_CHANNELS.indexOf(str(conn.channel)) >= 0 ? str(conn.channel) : 'host',
        profileId: str(conn.profileId),
        apiUrl: trimUrl(conn.apiUrl),
        apiKey: str(conn.apiKey),
        model: str(conn.model),
        temperature: prm.temperature,
        maxTokens: prm.maxTokens,
        topP: prm.topP,
    };
}

/** 由分组条目构造 target（V1 `resolveApiFor` 的「命中预设」分支） */
function targetFromPreset(name, purpose, dimension) {
    const pr = apiPresetGet(name) || {};
    return makeTarget({
        channel: presetChannel(pr),
        profileId: pr.profileId,
        apiUrl: pr.apiUrl,
        apiKey: pr.apiKey,
        model: pr.model,
    }, 'preset', purpose, dimension, name);
}

/** 由 V1 的内联独立配置（`kwApi`/`memApi`）构造 target */
function targetFromInline(block, label, purpose, dimension) {
    const b = block || {};
    return makeTarget({
        // V1 的 `kwApi`/`memApi` 内联块是**显式的自建连接**（`resolveKwApiOverride` 第二分支直接返回 apiUrl/apiKey/model），
        //   且 `callChatCompletion` 在缺地址/模型时**抛错**（"API 未配置"）。故此处**不回落 host**：
        //   缺地址时保持 `direct` → 宿主如实报「未配置 API 地址」，与 V1 的失败口径一致（见 docs/P10a §4）。
        channel: API_CHANNELS.indexOf(str(b.channel)) >= 0 ? str(b.channel) : 'direct',
        profileId: b.profileId,
        apiUrl: b.apiUrl,
        apiKey: b.apiKey,
        model: b.model,
    }, 'inline:' + String(label || ''), purpose, dimension, '');
}

/**
 * 解析某用途的 API target（V1 `resolveApiFor` 家族 + 各调用点优先级的**合并等价物**）。
 * @param {{purpose?:string, dimension?:string, preset?:string}} [opts]
 * @returns {{name:string, source:string, purpose:string, dimension:string, channel:string,
 *            profileId:string, apiUrl:string, apiKey:string, model:string,
 *            temperature:number, maxTokens:number|string, topP:number|string}}
 */
export function resolveApiTarget(opts) {
    const o = opts || {};
    const purpose = str(o.purpose) || 'main';
    const dimension = str(o.dimension);
    // ① 显式 override.preset（V1 `resolveApiFor({preset})` 的第一分支）
    if (str(o.preset) && apiPresetGet(o.preset)) return targetFromPreset(o.preset, purpose, dimension);
    // ② 该用途的分组
    const byPurpose = purposePresetName(purpose, dimension);
    if (byPurpose && apiPresetGet(byPurpose)) return targetFromPreset(byPurpose, purpose, dimension);
    // ③ 该用途的内联独立配置（V1：仅 kw/mem 有；分组优先）
    if (purpose === 'kw' && cfg.kwApiEnabled) return targetFromInline(cfg.kwApi, 'kwApi', purpose, dimension);
    if (purpose === 'mem' && cfg.memApiEnabled) return targetFromInline(cfg.memApi, 'memApi', purpose, dimension);
    // ④ 当前激活分组（V1 `overrideMain = { preset: cfg.activeApiPreset || undefined, ... }`）
    const active = str(cfg.activeApiPreset);
    if (active && apiPresetGet(active)) return targetFromPreset(active, purpose, dimension);
    // ⑤ 主配置
    return makeTarget(mainConnection(), 'main', purpose, dimension, '');
}

/** V1 AI 调用标签 → V2 用途（标签原样透传，见各 `aiCallText(..., label)` 调用点） */
export function purposeOfLabel(label) {
    const s = str(label);
    if (!s) return 'main';
    if (s.indexOf('平行') >= 0) return 'parallel';
    if (s === '关键词提取') return 'kw';
    if (s === '记忆分析发送') return 'mem';
    return 'main';
}

/** 设置某用途的分组（V2 UI 用；`dim` 需给 dimension；空串 = 取消该用途的分组） */
export function setPurposePreset(purpose, name, dimension) {
    const p = str(purpose);
    const n = str(name);
    if (p === 'kw') { cfg.kwApiPreset = n; return { ok: true, purpose: p, name: n }; }
    if (p === 'mem') { cfg.memApiPreset = n; return { ok: true, purpose: p, name: n }; }
    if (p === 'parallel') { cfg.parallelApiPreset = n; return { ok: true, purpose: p, name: n }; }
    if (p === 'dim') {
        const d = str(dimension);
        if (!d) return { ok: false, reason: 'no-dimension' };
        cfg.dimensionPresets = Object.assign({}, cfg.dimensionPresets || {});
        if (n) cfg.dimensionPresets[d] = n; else delete cfg.dimensionPresets[d];
        return { ok: true, purpose: p, dimension: d, name: n };
    }
    return { ok: false, reason: 'unknown-purpose' };
}

/** API 状态摘要（UI 渲染 / `FTT.apiChannelSummary()` 诊断用；**不回显 Key**，只给 `keySet`） */
export function apiChannelSummary() {
    const main = mainConnection();
    const presets = apiPresetNames().map((n) => {
        const pr = apiPresetGet(n) || {};
        return {
            name: n,
            channel: presetChannel(pr),
            profileId: str(pr.profileId),
            apiUrl: trimUrl(pr.apiUrl),
            model: str(pr.model),
            keySet: !!str(pr.apiKey),
        };
    });
    const dims = {};
    const dp = cfg.dimensionPresets || {};
    Object.keys(dp).forEach((d) => { if (str(dp[d])) dims[d] = str(dp[d]); });
    return {
        channel: main.channel,
        channelLabel: API_CHANNEL_LABELS[main.channel] || main.channel,
        profileId: main.profileId,
        apiUrl: main.apiUrl,
        model: main.model,
        keySet: !!main.apiKey,
        activePreset: str(cfg.activeApiPreset),
        presets,
        params: apiParamsOf(),
        purposes: {
            parallel: str(cfg.parallelApiPreset),
            dims,
            kw: { enabled: !!cfg.kwApiEnabled, preset: str(cfg.kwApiPreset) },
            mem: { enabled: !!cfg.memApiEnabled, preset: str(cfg.memApiPreset) },
        },
    };
}
