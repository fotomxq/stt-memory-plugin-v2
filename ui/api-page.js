// ============================================================
// ui/api-page.js —— 「API」设定子页（B10-a / v2.35.0）
//
// V1 出处（`src/FTT记忆组件-v1.206.js`）：
//   · `apiBlockHtml(prefix,title,cfgObj,kind,showParams)` 24539（`data-ftt-api` / `data-ftt-api-key` /
//     `#ftt-api-result-<pfx>` / 🧪 测试 / 📦 获取模型）；`collectApiBlock` 24712
//   · API 子页正文 25529~25543（「API 分组（预设管理）」+「API 设定（主 API 配置，摘要/修复默认）」）
//   · 动作 `apiTest` 27305 / `apiModels` 27322 / `presetSave` 27373 / `presetLoad` 27385 / `presetDelete` 27400
//   · `dimensionRowsHtml` 24565（各维度分组下拉 `data-ftt-dim-preset`）；`parallelApiPreset` 25816
//   · `modelSelect` 回填 model 输入 26224
//
// V2 形态（与 V1 的差异逐条登记于 `docs/history/P10a-API页与按用途渠道对齐.md`）：
//   ① V1「API 设定」= 自建直连（地址/Key/模型/代理预设）；V2 改为**三通道**（`cfg.apiChannel`）：
//      `host`（跟随酒馆当前连接，默认）/ `profile`（酒馆连接配置）/ `direct`（自建连接，V1 等价）。
//      「代理预设」由 `profile` 通道的「连接配置」等价承载（酒馆连接配置自身带代理与预设）。
//   ② V2 的控件**即时写回**（`applySettingsControl` → 落盘），无 V1 的「💾 保存设置」批量语义；
//      故 V1 `collectApiBlock` 的「从 DOM 收集 API 块」在 V2 = **直接读 cfg**（同一份真值）。
//   ③ 「分组名」「已存分组」与 V1 **一致**：只作按钮入参，**不写入配置**（V1 26280/26692 显式跳过）。
//   ④ 「模型」下拉：V1 是把选中值回填到**模型输入框的 DOM**（26224，等 💾 保存设置才落盘）；
//      V2 即时写回 `cfg.model`（等价结果，符合 V2 的即时写回口径）。
//   ⑤ 用途渠道：本页给出 V1 有的**平行推演**与**各维度分组**两个选择器（与 V1 同键：`parallelApiPreset` /
//      `dimensionPresets`）；`kwApiPreset`/`memApiPreset` 属 V1 的**向量检索层**，该层在 V2 未实现
//      → **不给控件**（无消费者的控件即假控件），仅在本页如实登记未实现。
// ============================================================
import { cfg } from '../core/model/runtime.js';
import { escHtml } from '../core/util.js';
import { hintDetailsHtml, shortHintHtml } from './hints.js';   // v2.60.0：长说明改折叠、页面只留一句
import { DIM_LABELS } from '../core/config.js';
import { saveKernelCfg } from '../adapters/config-store.js';
import { V1_SUMMARY_DIM_KEYS } from '../host/extract.js';
import {
    API_CHANNELS, API_CHANNEL_LABELS, apiChannelSummary, apiParamsOf,
    apiPresetSave, apiPresetLoad, apiPresetDelete,
    setPurposePreset, resolveApiTarget, mainApiChannel,
} from '../core/api-channel.js';
import { listConnectionProfiles, apiChannelAvailability, probeTarget, fetchModels } from '../host/api-channel.js';
// v2.58.0：向量层（Embedding / Rerank 测试）与「提取记忆」页的层测试结果态
import { vectorTarget } from '../host/embeddings.js';
import { testLayer as runLayerTest } from '../host/extract-flow.js';
import { vectorCacheClear, vectorCacheStats } from '../adapters/vector-cache.js';
import { setVectorTestResult, setLayerResult, setBlockModelList, blockModelList } from './extract-page.js';
import { collectFloorLinesInRange } from '../host/floors.js';
import { getCtx } from '../host/st-api.js';
// v3.42.0（用户要求「设定中新增 token 预估…并结合大模型价格清单预测花费了多少人民币」）：
//   AI 用量与花费账本（内核纯函数 + 账本读写）—— 本页只读汇总、写单价覆盖与汇率
import {
    aiUsageSummary, aiUsageRecent, tokenPriceList, tokenPriceOverrides,
    setTokenPriceOverrides, setUsdCnyRate, resetAiUsage, fmtCny, fmtInt, fmtWhen,
} from '../core/token-cost.js';

const esc = (v) => escHtml(v == null ? '' : v);

/** 本页动作（V1 同名：`presetSave`/`presetLoad`/`presetDelete`/`apiTest`/`apiModels`；`dimPreset` 为 V2 的分组下拉动作） */
export const API_ACTIONS = ['presetSave', 'presetLoad', 'presetDelete', 'apiTest', 'apiModels', 'dimPreset', 'testLayer', 'vectorCacheClear',
    // v3.42.0：Token 预估与花费（保存汇率 / 保存单价覆盖 / 清空覆盖 / 建未定价条目 / 清空账本）
    'tokenRateSave', 'tokenPriceSave', 'tokenPriceReset', 'tokenDraftPrices', 'tokenReset'];

/** V1 `#ftt-api-result-<pfx>` 的结果文案（模块态；V2 由渲染写回，不直接改 DOM） */
let apiTestResult = { text: '', kind: '' };
/** 「📦 获取模型」的结果（模块态：V1 直接改 select 的 innerHTML，V2 渲染时按态输出） */
let apiModelList = { targetKey: '', models: [], error: '', at: 0 };

/** 宿主钩子（重绘；测试可替换） */
const apiHooks = { rerender: () => undefined };
export function setApiPageHooks(next) { Object.assign(apiHooks, next || {}); return apiHooks; }

/** 测试/诊断用：当前测试与模型列表态（只读快照） */
export function apiPageState() {
    return {
        test: { text: apiTestResult.text, kind: apiTestResult.kind },
        models: { targetKey: apiModelList.targetKey, count: apiModelList.models.length, error: apiModelList.error, models: apiModelList.models.slice(0, 50) },
        blockModels: { emb: blockModelList('emb'), rerank: blockModelList('rerank') },
        channel: mainApiChannel(),
        // v3.42.0：Token 预估与花费（只读快照；`draft` = 「为未定价模型建条目」生成的 0 价模板）
        tokenCost: { summary: (() => { try { return aiUsageSummary(); } catch (e) { return null; } })(), draft: tokenPriceDraft },
    };
}
/** v3.42.0：「为未定价模型建条目」生成的 0 价模板（只活在页面态里；保存后清空） */
let tokenPriceDraft = null;

/** 读面板 DOM 里某个 `data-ftt-cfg` 控件的当前值（V1 `panelEl.querySelector('[data-ftt-cfg="…"]')` 等价物） */
function domValue(key) {
    try {
        const doc = globalThis.document;
        const el = doc && typeof doc.querySelector === 'function' ? doc.querySelector('[data-ftt-cfg="' + String(key) + '"]') : null;
        return el ? String(el.value == null ? '' : el.value) : '';
    } catch (e) { return ''; }
}

/**
 * 读「屏幕上」某个向量区块的四个输入值（V1 `collectApiBlock(pfx)` 的 V2 等价物）。
 * 为什么需要它（v2.79.0 修正）：区块里的输入是**即时写回**（change 事件），但用户「刚打完字就点测试」时
 *   该事件可能还没派发 —— 此时若只读 `cfg`，测的就是上一次保存的旧值（看起来像「设定没生效/串了」）。
 *   与 V1 一致：点按钮时按**当前输入框的值**解析目标。
 * v3.0.12（用户报告「API 分组看到的是主线 API 的模型清单，获取模型无效」）：本函数**只取值、不判定**
 *   —— 此前它在这里就判「地址为空 → 失败」，把「用 API 分组配置」这条正规路子直接判死（见 `blockTarget`）。
 * @returns {{url:string,key:string,model:string,preset:string}|null} 页面上没有该区块 → null（回落 cfg）
 */
function domBlockValues(pfx) {
    const pre = pfx === 'emb' ? 'embedding' : (pfx === 'rerank' ? 'rerank' : '');
    if (!pre) return null;
    try {
        const doc = globalThis.document;
        if (!doc || typeof doc.querySelector !== 'function') return null;
        const pick = (k) => {
            const el = doc.querySelector('[data-ftt-cfg="' + k + '"]');
            return el ? String(el.value == null ? '' : el.value).trim() : '';
        };
        const probe = doc.querySelector('[data-ftt-cfg="' + pre + 'Url"]');
        if (!probe) return null;                                   // 页面上没有该区块 → 回落 cfg
        return { url: pick(pre + 'Url').replace(/\/+$/, ''), key: pick(pre + 'Key'), model: pick(pre + 'Model'), preset: pick(pre + 'ProxyPreset') };
    } catch (e) { return null; }
}

/**
 * 区块的有效连接（**屏幕值优先**，其余由 `vectorTarget` 解析 —— 自填地址 或 **API 分组**）。
 *
 * v3.0.12 修复（用户报告：「API 分组看到的是主线 API 的模型清单，📦 获取模型无效」）：
 *   此前写法是 `domBlockTarget(pfx) || vectorTarget(kind)`，而 `domBlockTarget` 在「屏幕上地址为空」时
 *   返回的是**带 ok:false 的真值对象** → `||` 被短路 → 唯一会解析「使用 API 分组」的 `vectorTarget()`
 *   **永不执行**。于是**用分组配置的向量 API 全不可用**（🧪 测试 恒报「未配置（缺少地址）」、
 *   📦 获取模型 恒失败），而页面下方的摘要行（读 `vectorLayerInfo()` → `vectorTarget()`）却显示
 *   「当前生效：<分组模型> ← 分组「x」」—— 自相矛盾，正是用户看到的现象。
 *   现改为**逐字段合并**：屏幕上填了就用屏幕值，没填的字段（含地址）由分组补齐。
 *
 * @param {'emb'|'rerank'} pfx
 * @param {'embedding'|'rerank'} kind
 * @param {{requireModel?:boolean}} [opts] `requireModel:false` 用于「📦 获取模型」——
 *   它正是**用来选模型**的前置动作（`fetchModels` 只需要地址 + Key），
 *   旧实现要求「先填模型才肯拉模型」，自相矛盾（用户报告的「获取模型无效」）。
 */
function blockTarget(pfx, kind, opts) {
    const o = opts || {};
    const requireModel = o.requireModel !== false;
    const label = kind === 'rerank' ? 'Rerank' : 'Embedding';
    const base = (() => { try { return vectorTarget(kind) || {}; } catch (e) { return {}; } })();
    const dom = domBlockValues(pfx);
    const url = String((dom && dom.url) || base.url || '').replace(/\/+$/, '');
    const key = String((dom && dom.key) || base.key || '');
    const model = String((dom && dom.model) || base.model || '');
    const preset = String((dom && dom.preset) || base.preset || '');
    // 来源标注：屏幕上填了地址算「自填」，否则沿用 `vectorTarget` 的判定（inline=cfg 自填 / preset=分组）
    const from = (dom && dom.url) ? 'dom' : String(base.from || '');
    const out = { url: url, key: key, model: model, preset: preset, from: from, apiUrl: url, apiKey: key };
    if (!url) {
        // 如实说明「是缺地址、还是分组里没地址」（V1 `getPreset` 口径的 V2 等价物）
        return Object.assign(out, { ok: false, error: label + ' API 未配置（缺少地址' + (preset ? '，且分组「' + preset + '」不含地址' : '') + '）' });
    }
    if (requireModel && !model) return Object.assign(out, { ok: false, model: '', error: label + ' API 未配置模型' });
    return Object.assign(out, { ok: true });
}

/** 持久化（内核只改内存，落盘由 UI 层负责 —— 与 settings-pages 同口径） */
function persist() { try { saveKernelCfg(); } catch (e) { /* 落盘失败不影响内存态 */ } }

/** target 的稳定标识（模型列表按它缓存，避免串台） */
function targetKey(t) {
    const x = t || {};
    return [x.channel, x.profileId, x.apiUrl, x.model].join('|');
}

/** 通道下拉选项 */
function channelOptions(cur) {
    return API_CHANNELS.map((c) => '<option value="' + esc(c) + '"' + (c === cur ? ' selected' : '') + '>' + esc(API_CHANNEL_LABELS[c] || c) + '</option>').join('');
}

/** 分组下拉选项（V1 `apiPresetSelectHtml`/`dimensionRowsHtml` 同款：空值 = 跟随主配置） */
function presetOptions(cur, emptyLabel) {
    const names = apiChannelSummary().presets.map((p) => p.name);
    const list = (names.indexOf(cur) >= 0 || !cur ? names : names.concat([cur]));
    return '<option value="">' + esc(emptyLabel) + '</option>' + list.map((n) => '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
}

/** 「API 分组（预设管理）」分节（V1 25530~25541 同结构） */
function presetSectionHtml() {
    const sum = apiChannelSummary();
    const opts = ['<option value="">（无）</option>'].concat(sum.presets.map((p) => {
        const tag = p.channel === 'profile' ? ('连接配置 ' + (p.profileId || '（未选）')) : (p.apiUrl || '（未填地址）') + (p.model ? (' · ' + p.model) : '');
        return '<option value="' + esc(p.name) + '"' + (p.name === sum.activePreset ? ' selected' : '') + '>' + esc(p.name + '（' + tag + '）') + '</option>';
    })).join('');
    return [
        '<div class="ftt-section"><div class="ftt-sec-title">API 分组（预设管理）</div>',
        '<div class="ftt-field"><label>分组名</label><input type="text" data-ftt-cfg="presetName" placeholder="如：主API / 备用"></div>',
        '<div class="ftt-row">',
        '<button class="ftt-btn ftt-sm" data-ftt-action="presetSave" title="把当前「API 设定」存成一个分组（同名覆盖）">💾 保存当前设定为分组</button>',
        '<button class="ftt-btn ftt-sm" data-ftt-action="presetLoad" title="把选中分组的连接写回「API 设定」并设为当前激活">📂 加载选中分组</button>',
        '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="presetDelete" title="删除选中分组（需二次确认）">🗑 删除选中分组</button>',
        '</div>',
        '<div class="ftt-field"><label>已存分组</label><select data-ftt-cfg="presetSelect">' + opts + '</select></div>',
        '<div class="ftt-muted">API 分组 = 一组完整<b>连接</b>设定（通道 / 连接配置 / 地址 / Key / 模型），主 API 与「提取记忆」共用。当前激活：' + esc(sum.activePreset || '主配置（未用分组）') + '。</div>',
        '<div class="ftt-muted">温度 / 上限 / top_p 是全局参数，<b>不进分组</b>；分组只记录连接设定。</div>',
        '</div>',
    ].join('\n');
}

/** 「API 设定（主 API 配置，摘要/修复默认）」分节（V1 `apiBlockHtml('main', …, 'chat', true)` 的 V2 等价物） */
function mainApiSectionHtml() {
    const sum = apiChannelSummary();
    const prm = apiParamsOf();
    const prof = listConnectionProfiles();
    const av = apiChannelAvailability();
    const profOpts = (() => {
        const cur = sum.profileId;
        const rows = prof.ok ? prof.profiles : [];
        const hit = rows.filter((p) => p.id === cur)[0];
        const head = rows.length
            ? rows.map((p) => '<option value="' + esc(p.id) + '"' + (p.id === cur ? ' selected' : '') + '>' + esc(p.name + (p.model ? '（' + p.model + '）' : '')) + '</option>').join('')
            : '<option value="">' + esc(prof.ok ? '（酒馆里还没有可用的连接配置）' : ('（读取失败：' + prof.error + '）')) + '</option>';
        const stale = (cur && !hit) ? '<option value="' + esc(cur) + '" selected>' + esc('（已失效：' + cur + '）') + '</option>' : '';
        return '<option value="">（未选择）</option>' + stale + head;
    })();
    const modelOpts = (() => {
        const cur = sum.model;
        const cached = apiModelList.targetKey === targetKey(resolveApiTarget({ purpose: 'main' })) ? apiModelList.models : [];
        const head = '<option value="">' + esc(apiModelList.error && apiModelList.targetKey === targetKey(resolveApiTarget({ purpose: 'main' })) ? ('（' + apiModelList.error + '）') : (cached.length ? '（选择模型）' : '（先点「获取模型」）')) + '</option>';
        const list = (cached.indexOf(cur) >= 0 || !cur ? cached : [cur].concat(cached));
        return head + list.map((m) => '<option value="' + esc(m) + '"' + (m === cur ? ' selected' : '') + '>' + esc(m) + '</option>').join('');
    })();
    return [
        '<div class="ftt-section"><div class="ftt-sec-title">API 设定（主 API 配置，摘要/修复默认）</div>',
        '<div class="ftt-field"><label>通道</label><select data-ftt-cfg="apiChannel">' + channelOptions(sum.channel) + '</select>'
            + '<span class="ftt-muted">' + esc(API_CHANNEL_LABELS[sum.channel] || sum.channel) + '</span></div>',
        '<div class="ftt-field"><label>酒馆连接配置</label><select data-ftt-cfg="apiProfileId">' + profOpts + '</select>'
            + '<span class="ftt-muted">' + esc(av.profile.available ? ('可选 ' + av.profile.count + ' 个') : ('不可用：' + (av.profile.reason || ''))) + '</span></div>',
        '<div class="ftt-field"><label>API 地址</label><input type="text" data-ftt-cfg="apiUrl" value="' + esc(cfg.apiUrl) + '" placeholder="自建连接用，如 https://api.example.com/v1"></div>',
        '<div class="ftt-field"><label>API Key</label><input type="password" data-ftt-cfg="apiKey" value="' + esc(cfg.apiKey) + '" autocomplete="off" spellcheck="false"></div>',
        '<div class="ftt-field"><label>模型</label><input type="text" data-ftt-cfg="model" value="' + esc(cfg.model) + '"></div>',
        '<div class="ftt-field"><label>temperature</label><input type="text" data-ftt-cfg="apiTemperature" value="' + esc(String(cfg.apiTemperature == null ? 0.2 : cfg.apiTemperature)) + '"></div>',
        '<div class="ftt-field"><label>max_tokens</label><input type="text" data-ftt-cfg="apiMaxTokens" value="' + esc(String(cfg.apiMaxTokens == null ? '' : cfg.apiMaxTokens)) + '" placeholder="留空=不限制"></div>',
        '<div class="ftt-field"><label>top_p</label><input type="text" data-ftt-cfg="apiTopP" value="' + esc(String(cfg.apiTopP == null ? '' : cfg.apiTopP)) + '" placeholder="留空=1"></div>',
        '<div class="ftt-muted">OpenAI 兼容参数。留空采用默认：<b>temperature=' + esc(String(prm.temperature)) + '</b>、<b>max_tokens=不限制</b>、<b>top_p=1</b>。</div>',
        '<div class="ftt-row">',
        '<button class="ftt-btn ftt-sm" data-ftt-action="apiTest" title="按当前通道发一条 ping 请求验证连通性">🧪 测试</button>',
        '<button class="ftt-btn ftt-sm" data-ftt-action="apiModels" title="从自建连接的 /models 拉取模型列表">📦 获取模型</button>',
        '<span class="ftt-api-test-result" id="ftt-api-result-main">' + esc(apiTestResult.kind === 'main' ? apiTestResult.text : '') + '</span>',
        '</div>',
        '<div class="ftt-field"><label>选择模型</label><select data-ftt-model-select="main">' + modelOpts + '</select></div>',
        '<div class="ftt-muted">通道：<b>跟随酒馆当前连接</b>（默认）· <b>酒馆连接配置</b>（用「连接管理」里的一条）· <b>自建连接</b>（插件直连，受 CORS 限制）。</div>',
        hintDetailsHtml('通道差异说明',
            '<div>' + esc('max_tokens 三个通道都生效；temperature / top_p 在「酒馆连接配置」与「自建连接」通道生效，在「跟随酒馆当前连接」通道无法覆盖（宿主接口没有该参数）。') + '</div>'
            + '<div>' + esc('v2.95.0：只有「酒馆连接配置」通道支持逐块流式（总览「管线状态」会显示「流式 N 块」）；跟随酒馆当前连接与自建连接都是一次性返回，管线状态仍会给 token 计数与预估倒计时。') + '</div>'),
        '</div>',
    ].join('\n');
}

/**
 * 各维度分组下拉行（V1 `dimensionRowsHtml`，v1.206 24565~24575 的等价物）——**渲染在「分析记忆」页**（V1 原位）。
 * V1 的行结构是「维度名 + 启用开关 + 分组下拉」；V2 的**维度启用开关**在「V2 附加设定 → 启用维度」
 * （既有设计，避免同页两处开关），故此处只出行名 + 分组下拉。
 */
export function dimPresetRowsHtml() {
    return V1_SUMMARY_DIM_KEYS.map((d) => {
        const cur = String((cfg.dimensionPresets || {})[d] || '');
        return '<div class="ftt-dim-row"><span class="ftt-dim-name">' + esc(DIM_LABELS[d] || d) + '</span>'
            + '<select class="ftt-dim-preset" data-ftt-dim-preset="' + esc(d) + '">' + presetOptions(cur, '跟随主配置') + '</select></div>';
    }).join('\n');
}

/** 平行推演渠道下拉（V1 `parallelApiPreset` 选择器，v1.206 25816）——**渲染在「平行」页**（V1 原位） */
export function parallelChannelFieldHtml() {
    const cur = String(cfg.parallelApiPreset || '');
    // v2.57.0：删掉「V1 同键 + 行号」这类开发说明，只留一句用途（悬停提示承载细节）
    return '<div class="ftt-field"><label title="「交织推演」与「推进分析」都使用该分组；不选则跟随主配置">推演/推进分析渠道</label>'
        + '<select data-ftt-cfg="parallelApiPreset">' + presetOptions(cur, '（默认主渠道）') + '</select></div>';
}

/** 「按用途渠道」分节（**只作索引**：各选择器按 V1 原位渲染在对应分页 / 未实现项如实登记） */
function purposeSectionHtml() {
    const sum = apiChannelSummary();
    const separate = cfg.dimensionGrouping === 'separate';
    const dimCount = Object.keys(sum.purposes.dims || {}).length;
    return [
        '<div class="ftt-section"><div class="ftt-sec-title">按用途渠道</div>',
        '<div class="ftt-muted">本页只管连接与分组；各用途的选择器在对应页面：</div>',
        '<div class="ftt-dim-row"><span class="ftt-dim-name">平行推演</span><span class="ftt-muted ftt-flex-1">'
            + esc(sum.purposes.parallel ? ('使用分组「' + sum.purposes.parallel + '」') : '跟随主渠道')
            + ' —— 在「平行」设定页选择</span></div>',
        '<div class="ftt-dim-row"><span class="ftt-dim-name">各维度分组</span><span class="ftt-muted ftt-flex-1">'
            + esc((separate ? '独立分组' : '当前为统一分组') + '；已设 ' + dimCount + ' 个维度分组')
            + ' —— 在「分析记忆」设定页选择</span></div>',
        '<div class="ftt-muted">Embedding / Rerank 与关键词提取、记忆分析分组的连接设置都在「提取记忆」页；本页只负责建分组。</div>',
        '</div>',
    ].join('\n');
}

/** 整页 HTML（无分节外的额外包装，与 V1 的 `subBody` 同层级） */
export function apiPageHtml() {
    try {
        return [presetSectionHtml(), mainApiSectionHtml(), purposeSectionHtml(), tokenCostSectionHtml()].join('\n');
    } catch (e) {
        return '<div class="ftt-hint">API 页渲染失败：' + esc(String((e && e.message) || e)) + '</div>';
    }
}

/**
 * 读一个**非 cfg 控件**（`data-ftt-token-*` 标记）的当前值。
 * 为什么不用 `domValue`：那一套以 `data-ftt-cfg` 为准，会走内核的配置控件引擎（`applySettingsControl`）；
 *   本节的两个输入（汇率 / 单价覆盖）属**运行账本的本地偏好**，不进内核 `cfg`，故另开一套只读标记。
 */
function tokenDomValue(attr) {
    try {
        const doc = globalThis.document;
        const sel = '[' + String(attr) + ']';
        const el = doc && typeof doc.querySelector === 'function' ? doc.querySelector(sel) : null;
        return el ? String(el.value == null ? '' : el.value) : '';
    } catch (e) { return ''; }
}

/**
 * v3.42.0（用户原话）：「在设定中新增token预估，尤其是请求token、接收、缓存等，并结合大模型价格清单
 *   预测花费了多少人民币。注意该功能不需要高频次，只需被动每次请求记录一下统计信息即可。」
 *
 * 本节 = **只读汇总 + 最近明细 + 价格与汇率**（三块）。口径：
 *   · 记账是**被动**的（每次真实 AI 请求结束时落一条），本节只**读**账本，不做轮询、不触发请求；
 *   · token 估算口径 = `ceil(字符数 / 4)`（与管线状态同一件）；**只有自建连接通道**能拿到真实 `usage`，
 *     其余通道按字符数估算 —— 明细里逐条标「实测 / 估算」；
 *   · **缓存 token** 只有 API 明确回报才算（估算通道记 0，不猜）；
 *   · **未定价的模型照样记 token**，但花费显示「未定价」（**不显示 ¥0.00**）→ 用户可在下面的 JSON 里按模型补单价。
 */
function tokenCostSectionHtml() {
    let s = null;
    try { s = aiUsageSummary(); } catch (e) { s = null; }
    if (!s) return '';
    const head = '<div class="ftt-sec-title">💰 Token 预估与花费</div>';
    // ① 汇总（页面只留短句；口径与来源一律进折叠说明 —— 见 `ui/hints.js` 的写法约定）
    const costText = fmtCny(s.costCny);
    const lines = [
        '<div class="ftt-hint" data-ftt-token-summary>累计 <b>' + fmtInt(s.n) + '</b> 次 · 输入 <b>' + fmtInt(s.promptTokens) + '</b> · 输出 <b>' + fmtInt(s.respTokens) + '</b> · 缓存 <b>' + fmtInt(s.cachedTokens) + '</b> token</div>',
        '<div class="ftt-hint" data-ftt-token-cost>预估花费 <b>' + esc(costText) + '</b>'
        + (s.unpricedN ? ' · 未定价 ' + fmtInt(s.unpricedN) + ' 次' : '')
        + ' · 汇率 ' + String(s.usdCny) + ' · 价目表 ' + fmtInt(s.priceCount) + ' 条</div>',
    ];
    // 口径说明（长文本一律进**折叠块**：`ui/hints.js` 的写法约定 + `ui-wording` 门禁的 ≤90 字）
    const detailFold = hintDetailsHtml('记账口径与本次读数', '<div>'
        + '① 只有真实 AI 请求才记账（成功与失败都记一条），不做轮询、不发额外请求。<br>'
        + '② token 按 <b>字符数 ÷ 4 向上取整</b>估算；只有「自建连接」通道能从响应里拿到真实 usage（明细标「实测」，其余标「估算」）。<br>'
        + '③ 缓存命中 token 只有 API 明确回报才算，估算通道记 0（不猜）。<br>'
        + '④ 探针与「🧪 测试」等诊断请求不计入；**失败的请求只记次数**（token 与花费记 0）；明细保留最近 ' + fmtInt(s.keep) + ' 条，累计不受该上限影响。<br>'
        + '⑤ 本账本属<b>运行账本</b>（落插件设置），不参与记忆数据同步。<br>'
        + '本次读数：成功 ' + fmtInt(s.okN) + ' · 失败 ' + fmtInt(s.failN) + ' · 实测 ' + fmtInt(s.measuredN) + ' / 估算 ' + fmtInt(s.estimatedN) + ' 次 · 最近一次 ' + esc(fmtWhen(s.lastAt) || '（暂无）') + '。'
        + '</div>');
    // ② 按标签（按 token 总量排序，取前 8）—— **列表行**（`docs/D9` §10 **U11**：不引入真表格）
    const labels = Object.keys(s.byLabel || {}).map((k) => ({ k: k, v: s.byLabel[k] }))
        .sort((a, b) => (b.v.promptTokens + b.v.respTokens) - (a.v.promptTokens + a.v.respTokens)).slice(0, 8);
    const labelRows = labels.length ? labels.map((x) => '<div class="ftt-item ftt-inline">'
        + '<span class="ftt-grow">' + esc(x.k) + '</span>'
        + '<span class="ftt-muted">' + fmtInt(x.v.n) + ' 次 · 入 ' + fmtInt(x.v.promptTokens) + ' · 出 ' + fmtInt(x.v.respTokens)
        + ' · 缓存 ' + fmtInt(x.v.cachedTokens) + '</span>'
        + '<span class="ftt-badge">' + esc(fmtCny(x.v.costMicro / 1e6))
        + (x.v.unpricedN ? ' <span class="ftt-muted">(未定价 ' + fmtInt(x.v.unpricedN) + ')</span>' : '') + '</span></div>').join('')
        : '<div class="ftt-empty">还没有记账（发出一次 AI 请求后这里会出现按行为的统计）</div>';
    // ③ 最近明细 —— **列表行 + 折叠明细**（行摘要：时间 · 行为 · 花费；点开看模型 / 渠道 / 各类 token / 口径）
    let recent = [];
    try { recent = aiUsageRecent(10); } catch (e) { recent = []; }
    const recentRows = recent.length ? recent.map((r, i) => '<div class="ftt-item ftt-inline">'
        + '<span class="ftt-grow">' + esc(fmtWhen(r.at)) + ' · ' + esc(r.label) + (r.ok ? '' : ' <span class="ftt-muted">(失败)</span>') + '</span>'
        + '<span class="ftt-muted">入 ' + fmtInt(r.promptTokens) + ' · 出 ' + fmtInt(r.respTokens) + (r.cachedTokens ? ' · 缓存 ' + fmtInt(r.cachedTokens) : '') + '</span>'
        + '<span class="ftt-badge">' + esc(fmtCny(r.costCny)) + '</span>'
        + hintDetailsHtml('明细', '<div>模型：' + esc(r.model) + ' · 渠道：' + esc(r.channel || '—') + ' · 口径：'
            + (r.usageSource === 'usage' ? '实测 usage' : '估算（字符 ÷ 4）') + ' · 耗时：' + fmtInt(r.ms) + 'ms'
            + ' · 输入字符：' + fmtInt(r.promptChars) + ' · 输出字符：' + fmtInt(r.respChars)
            + (r.priced ? '' : ' · <b>该模型未定价</b>（只在设定页补齐单价后才会计入花费）') + '</div>')
        + '</div>').join('') : '';
    // ④ 价格与汇率（两处可写：汇率输入 + 价格覆盖 JSON；都用 data-ftt-token-* 标记，不走 cfg 控件引擎）
    let overridesText = '{}';
    try { overridesText = JSON.stringify(tokenPriceDraft || tokenPriceOverrides(), null, 2) || '{}'; } catch (e) { overridesText = '{}'; }
    let priceTable = '';
    try {
        // 价目表同样是**列表行**（U11）；整块仍在折叠说明里（默认收起，不挤占版面）
        const priceRows = tokenPriceList().map((e) => '<div class="ftt-item ftt-inline">'
            + '<span class="ftt-grow">' + esc(e.label) + (e.builtin ? '' : ' <span class="ftt-muted">(自定义)</span>') + '</span>'
            + '<span class="ftt-muted">匹配 <code>' + esc((e.match || []).join(' / ')) + '</code> · 入 ' + esc(String(e.in))
            + ' · 缓存 ' + esc(String(e.cachedIn)) + ' · 出 ' + esc(String(e.out)) + ' · ' + esc(e.cur) + '</span>'
            + '<span class="ftt-muted">' + esc(e.src || '—') + (e.asOf ? ' · ' + esc(e.asOf) : '') + '</span></div>').join('');
        priceTable = '<details class="ftt-details ftt-hint-details"><summary class="ftt-hint">ⓘ 内置价目表（' + fmtInt(tokenPriceList().length) + ' 条 · 参考价 ' + esc(s.priceAsOf) + '）</summary>'
            + '<div class="ftt-hint ftt-hint-body">单价按 <b>每 100 万 token</b> 计；「入」= 未命中缓存的输入价，「缓存」= 命中缓存的输入价。'
            + '内置条目只收 <b>已核实来源</b> 的价目（见每行末尾的来源与日期），价格会变 —— 以官方账单为准，可在下方覆盖。</div>'
            + priceRows + '</details>';
    } catch (e) { priceTable = ''; }

    return '<div class="ftt-sec" data-ftt-token-section>' + head
        + lines.join('\n')
        + detailFold
        + labelRows
        + (recentRows ? '<div class="ftt-muted ftt-my-1">最近 10 次明细（点开看细节）</div>' + recentRows : '')
        + '<div class="ftt-row ftt-my-1">'
        + '<label class="ftt-grow">美元兑人民币汇率</label>'
        + '<input type="number" step="0.01" min="0.01" max="999" data-ftt-token-rate value="' + esc(String(s.usdCny)) + '" title="用于把 USD 价目折算成人民币（参考值，可改）">'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="tokenRateSave" title="保存汇率（只影响之后的记账展示与折算）">💾 保存汇率</button>'
        + '</div>'
        + '<div class="ftt-muted ftt-my-1">单价覆盖（JSON：条目键 → <code>{ in, out, cachedIn, cur, match }</code>；与内置同名 → 覆盖，新键 → 新增）</div>'
        + '<textarea data-ftt-token-prices rows="6" class="ftt-w-full" title="按每 100 万 token 计的单价覆盖（JSON）">' + esc(overridesText) + '</textarea>'
        + '<div class="ftt-row ftt-my-1">'
        + '<button class="ftt-btn ftt-primary ftt-sm" data-ftt-action="tokenPriceSave" title="保存上面的 JSON，之后的记账按新单价折算">💾 保存单价覆盖</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="tokenPriceReset" title="清空全部单价覆盖（内置参考价恢复生效）">↩️ 清空覆盖</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="tokenDraftPrices" title="为账本里出现过的「未定价」模型生成 0 价模板，填好数字后再保存">🧩 为未定价模型建条目</button>'
        + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="tokenReset" title="清空用量账本（明细与累计；不动单价与汇率）">🧹 清空账本</button>'
        + '</div>'
        + priceTable
        + '</div>';
}

/**
 * 本页动作（V1 同名 case 的等价物）。
 * @param {string} action
 * @param {{name?:string, preset?:string, kind?:string, target?:object}} [p]
 * @returns {Promise<{ok:boolean, note?:string, action?:string, result?:string}>}
 */
export async function apiAction(action, p) {
    const a = String(action || '');
    const params = p || {};
    if (a === 'presetSave') {
        const name = String(params.name != null && params.name !== '' ? params.name : domValue('presetName')).trim();
        const r = apiPresetSave(name);
        if (!r.ok) return { ok: false, action: a, note: '请输入分组名', reason: 'empty-name' };
        persist();
        apiHooks.rerender();
        return { ok: true, action: a, name: r.name, note: '✅ 已保存分组「' + r.name + '」' };
    }
    if (a === 'presetLoad') {
        const name = String(params.preset != null && params.preset !== '' ? params.preset : domValue('presetSelect')).trim();
        const r = apiPresetLoad(name);
        if (!r.ok) return { ok: false, action: a, note: '请选择要加载的分组', reason: 'missing' };
        persist();
        apiHooks.rerender();
        return { ok: true, action: a, name: r.name, note: '✅ 已切换到主 API 分组「' + r.name + '」' };
    }
    if (a === 'presetDelete') {
        const name = String(params.preset != null && params.preset !== '' ? params.preset : domValue('presetSelect')).trim();
        const r = apiPresetDelete(name);
        if (!r.ok) return { ok: false, action: a, note: '请选择要删除的分组', reason: 'missing' };
        persist();
        apiHooks.rerender();
        return { ok: true, action: a, name: r.name, note: '已删除分组「' + r.name + '」' };
    }
    if (a === 'dimPreset') {
        const dim = String(params.kind || params.dim || '');
        const name = String(params.preset == null ? '' : params.preset).trim();
        const r = setPurposePreset('dim', name, dim);
        if (!r.ok) return { ok: false, action: a, note: '维度分组未更新', reason: r.reason };
        persist();
        apiHooks.rerender();
        return { ok: true, action: a, dimension: r.dimension, name: r.name, note: '维度「' + dim + '」分组：' + (name || '跟随主配置') };
    }
    if (a === 'apiTest') {
        // v2.58.0：Embedding / Rerank 区块的「🧪 测试」带 `data-ftt-api-pfx`（emb / rerank）——
        //   目标连接由 `vectorTarget()` 解析（自填地址 或 本插件 API 分组），与 V1 `apiBlockHtml(kind)` 同义。
        const pfx = String(params.apiPfx || params.pfx || '');
        if (pfx === 'emb' || pfx === 'rerank') {
            // kind 由标记 `data-ftt-api-kind` 透传（缺省按 pfx 推断，与 V1 `data-ftt-api-kind` 同义）
            const kind = (String(params.apiKind || '') === 'rerank' || String(params.apiKind || '') === 'embedding')
                ? String(params.apiKind) : (pfx === 'emb' ? 'embedding' : 'rerank');
            const t = blockTarget(pfx, kind);                     // v2.79.0：以屏幕上当前值为准（V1 collectApiBlock 语义）
            setVectorTestResult(pfx, '⏳ 测试中…');
            apiHooks.rerender();
            const r = t.ok
                ? await probeTarget({ channel: 'direct', apiUrl: t.url, apiKey: t.key, model: t.model }, kind, cfg.vectorTimeoutMs)
                : { ok: false, error: t.error };
            const text = r.ok ? ('✅ 可用（' + (r.ms || 0) + 'ms）') : ('❌ ' + String(r.error || '测试失败').slice(0, 80));
            setVectorTestResult(pfx, text);
            apiHooks.rerender();
            return { ok: !!r.ok, action: a, pfx: pfx, kind: kind, result: text, ms: r.ms || 0, note: text };
        }
        const target = params.target && typeof params.target === 'object' ? params.target : resolveApiTarget({ purpose: 'main' });
        const kind = String(params.kind || 'chat');
        apiTestResult = { text: '⏳ 测试中…', kind: 'main' };
        apiHooks.rerender();
        const r = await probeTarget(target, kind);
        const text = r.ok ? ('✅ 可用（' + r.ms + 'ms）') : ('❌ ' + String(r.error || '测试失败').slice(0, 80));
        apiTestResult = { text, kind: 'main' };
        apiHooks.rerender();
        return { ok: !!r.ok, action: a, result: text, ms: r.ms || 0, channel: target.channel, note: text };
    }
    if (a === 'tokenRateSave') {
        // v3.42.0：汇率只在**之后的记账与展示**生效（不改已有明细里的花费 —— 历史按当时的汇率留痕）
        const v = String(params.rate != null && params.rate !== '' ? params.rate : tokenDomValue('data-ftt-token-rate')).trim();
        const rate = setUsdCnyRate(v);
        apiHooks.rerender();
        return { ok: true, action: a, rate: rate, note: '✅ 汇率已保存：1 USD = ' + rate + ' 元（只影响之后的记账展示）' };
    }
    if (a === 'tokenPriceSave') {
        const text = String(params.prices != null && params.prices !== '' ? params.prices : tokenDomValue('data-ftt-token-prices'));
        let obj = null;
        try { obj = JSON.parse(text || '{}'); } catch (e) {
            return { ok: false, action: a, reason: 'bad-json', note: '❌ JSON 解析失败：' + String((e && e.message) || e).slice(0, 80) };
        }
        const r = setTokenPriceOverrides(obj);
        if (!r.ok) return { ok: false, action: a, reason: r.reason, note: '❌ ' + r.reason };
        tokenPriceDraft = null;                       // 保存成功即清掉「0 价模板」态（此后以账本为准）
        apiHooks.rerender();
        return { ok: true, action: a, count: r.n, note: '✅ 单价覆盖已保存（' + r.n + ' 条）—— 之后的记账按新单价折算' };
    }
    if (a === 'tokenPriceReset') {
        setTokenPriceOverrides({});
        tokenPriceDraft = null;
        apiHooks.rerender();
        return { ok: true, action: a, note: '已清空单价覆盖（内置参考价恢复生效）' };
    }
    if (a === 'tokenDraftPrices') {
        // 为账本里出现过的「未定价」模型生成 0 价模板（用户填数字后再保存）——
        //   只看最近明细（够用且不扫描全量），已覆盖的模型不重复生成
        let draft = {};
        try { draft = tokenPriceOverrides() || {}; } catch (e) { draft = {}; }
        const seen = {};
        try {
            for (const r of aiUsageRecent(200)) {
                const m = String((r && r.model) || '').trim();
                if (!m || r.priced) continue;
                if (draft[m] || seen[m]) continue;
                seen[m] = true;
                draft[m] = { label: m, match: [m.toLowerCase()], cur: 'CNY', in: 0, cachedIn: 0, out: 0, note: '待填：请按官方账单修正单价' };
            }
        } catch (e) { /* 忽略 */ }
        const n = Object.keys(seen).length;
        if (!n) return { ok: true, action: a, count: 0, note: '账本里没有「未定价」的模型（无需新建）' };
        tokenPriceDraft = draft;                      // 写进页面态 → 重绘后出现在文本框里（**不直接落库**，等用户填完再保存）
        apiHooks.rerender();
        return { ok: true, action: a, count: n, draft: draft, note: '已生成 ' + n + ' 个 0 价模板（见下表：币种 CNY、单价 0）—— 填好数字后点「💾 保存单价覆盖」' };
    }
    if (a === 'tokenReset') {
        const s = resetAiUsage();
        apiHooks.rerender();
        return { ok: true, action: a, n: s.n, note: '已清空用量账本（明细与累计；单价覆盖与汇率保留）' };
    }
    if (a === 'testLayer') {
        // V1 `testLayer`（27340）：真实跑一层并把「命中 N 条 + 关键词 + 前 900 字预览」写回页面
        const layer = String(params.layer || params.kind || '');
        const floorText = String((params.floorText != null && params.floorText !== '') ? params.floorText : (() => {
            try {
                const last = Number((getCtx() && typeof getCtx().lastMessageId === 'number') ? getCtx().lastMessageId : -1);
                if (!Number.isFinite(last) || last < 0) return '';
                const n = 3;
                return collectFloorLinesInRange(Math.max(0, last - n + 1), last).join('\n');
            } catch (e) { return ''; }
        })());
        setLayerResult(layer, { text: '⏳ 测试中…', lines: [] });
        apiHooks.rerender();
        const r = await runLayerTest(layer, floorText);
        setLayerResult(layer, { text: ((r.ok ? '✅ ' : '❌ ') + String(r.note || '')), lines: r.lines || [] });
        apiHooks.rerender();
        return { ok: !!r.ok, action: a, layer: layer, count: r.count || 0, keywords: r.keywords || [], result: r.note, note: String(r.note || ''), ms: r.ms || 0 };
    }
    if (a === 'vectorCacheClear') {
        const before = vectorCacheStats();
        const r = await vectorCacheClear();
        const after = vectorCacheStats();
        const note = r.ok
            ? ('已清空向量缓存（内存 ' + before.memory + ' 条 → ' + after.memory + ' 条' + (r.via === 'indexeddb' ? '，IndexedDB 表已清空' : '，仅内存回退') + '）')
            : ('清空向量缓存失败：' + String(r.error || '未知'));
        apiHooks.rerender();
        return { ok: !!r.ok, action: a, note: note, cleared: r.cleared || 0, via: r.via || '' };
    }
    if (a === 'apiModels') {
        // v2.79.0 修正（用户报告「Embedding、Rerank 设定存在严重错误、串行问题」）：
        //   此前本动作用 `resolveApiTarget({purpose:'main'})` —— 于是「Embedding / Rerank」区块里的
        //   「📦 获取模型」实际去拉**主 API**（默认通道为「跟随酒馆当前连接」时报主通道的错、且一个请求都不发），
        //   结果无处可看。现在按 `data-ftt-api-pfx` 走**该区块自己的**地址/Key，并把结果回填该区块的「选择模型」下拉。
        const pfx = String(params.apiPfx || params.pfx || '');
        if (pfx === 'emb' || pfx === 'rerank') {
            const kind = pfx === 'emb' ? 'embedding' : 'rerank';
            const label = kind === 'embedding' ? 'Embedding' : 'Rerank';
            // v3.0.12：`requireModel:false` —— 「📦 获取模型」是**选模型的前置**，不该要求先填模型
            const t = blockTarget(pfx, kind, { requireModel: false });
            if (!t.ok) {
                setBlockModelList(pfx, { models: [], error: t.error });
                apiHooks.rerender();
                return { ok: false, action: a, pfx: pfx, note: '❌ ' + label + ' 获取模型失败：' + t.error, error: t.error };
            }
            const r = await fetchModels({ channel: 'direct', apiUrl: t.url, apiKey: t.key });
            if (r.ok) {
                setBlockModelList(pfx, { models: r.models, error: '' });
                apiHooks.rerender();
                return { ok: true, action: a, pfx: pfx, count: r.models.length, models: r.models, note: '✅ ' + label + ' 获取到 ' + r.models.length + ' 个模型' + (r.models.length ? '（可在本区块「选择模型」里挑）' : '') };
            }
            setBlockModelList(pfx, { models: [], error: String(r.error || '获取失败') });
            apiHooks.rerender();
            return { ok: false, action: a, pfx: pfx, note: '❌ ' + label + ' 获取模型失败：' + String(r.error || '').slice(0, 80), error: r.error };
        }
        const target = params.target && typeof params.target === 'object' ? params.target : resolveApiTarget({ purpose: 'main' });
        const r = await fetchModels(target);
        if (r.ok) {
            apiModelList = { targetKey: targetKey(target), models: r.models.slice(), error: '', at: Date.now() };
            apiHooks.rerender();
            return { ok: true, action: a, count: r.models.length, models: r.models, note: '✅ 获取到 ' + r.models.length + ' 个模型' };
        }
        apiModelList = { targetKey: targetKey(target), models: [], error: String(r.error || '获取失败'), at: Date.now() };
        apiHooks.rerender();
        const note = '❌ 获取模型失败：' + String(r.error || '').slice(0, 80);
        return { ok: false, action: a, note, error: r.error };
    }
    return { ok: false, action: a, note: '', reason: 'unknown-action' };
}

/** 测试/宿主用：复位本页模块态（模型列表与测试结果） */
export function resetApiPageState() {
    apiTestResult = { text: '', kind: '' };
    apiModelList = { targetKey: '', models: [], error: '', at: 0 };
    setBlockModelList('emb', { models: [], error: '' });
    setBlockModelList('rerank', { models: [], error: '' });
    return apiPageState();
}
