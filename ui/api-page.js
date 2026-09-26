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
// V2 形态（与 V1 的差异逐条登记于 `docs/P10a-API页与按用途渠道对齐.md`）：
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
import { setVectorTestResult, setLayerResult } from './extract-page.js';
import { collectFloorLinesInRange } from '../host/floors.js';
import { getCtx } from '../host/st-api.js';

const esc = (v) => escHtml(v == null ? '' : v);

/** 本页动作（V1 同名：`presetSave`/`presetLoad`/`presetDelete`/`apiTest`/`apiModels`；`dimPreset` 为 V2 的分组下拉动作） */
export const API_ACTIONS = ['presetSave', 'presetLoad', 'presetDelete', 'apiTest', 'apiModels', 'dimPreset', 'testLayer', 'vectorCacheClear'];

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
        channel: mainApiChannel(),
    };
}

/** 读面板 DOM 里某个 `data-ftt-cfg` 控件的当前值（V1 `panelEl.querySelector('[data-ftt-cfg="…"]')` 等价物） */
function domValue(key) {
    try {
        const doc = globalThis.document;
        const el = doc && typeof doc.querySelector === 'function' ? doc.querySelector('[data-ftt-cfg="' + String(key) + '"]') : null;
        return el ? String(el.value == null ? '' : el.value) : '';
    } catch (e) { return ''; }
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
        '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="presetDelete" title="删除选中分组（不弹确认，与 V1 一致）">🗑 删除选中分组</button>',
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
            '<div>' + esc('max_tokens 三个通道都生效；temperature / top_p 在「酒馆连接配置」与「自建连接」通道生效，在「跟随酒馆当前连接」通道无法覆盖（宿主接口没有该参数）。') + '</div>'),
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
        return [presetSectionHtml(), mainApiSectionHtml(), purposeSectionHtml()].join('\n');
    } catch (e) {
        return '<div class="ftt-hint">API 页渲染失败：' + esc(String((e && e.message) || e)) + '</div>';
    }
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
            const t = vectorTarget(kind);
            setVectorTestResult(pfx, '⏳ 测试中…');
            apiHooks.rerender();
            const r = t.ok
                ? await probeTarget({ channel: 'direct', apiUrl: t.url, apiKey: t.key, model: t.model }, kind)
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
    return apiPageState();
}
