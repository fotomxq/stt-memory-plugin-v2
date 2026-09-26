// ============================================================
// ui/extract-page.js —— **「提取记忆」设定页**（v2.58.0：三层结构与 Embedding / Rerank API 设置对齐 V1）
//
// 用户报告：「提取信息的向量 API 设置在哪里？这些内容与 V1 完全没对齐，请核对并修复。」
// 核对结论（V1 v1.206 `activeSettingsSub === 'extract'` 分支，约 25630~25675）：
//   · V1 该页是**三层结构**：🟢 向量检索（`useVector`）/ 🟡 浏览器 JS 抽取（`jsExtractEnabled`）/ 🔴 AI 分析（`useKeywordFlow`）；
//   · 向量层带 **Embedding API**（`embeddingUrl/Key/Model/ProxyPreset`）与 **Rerank API**（`rerankUrl/Key/Model/ProxyPreset`）
//     两个 `apiBlockHtml` 区块（地址 / Key / 模型 / 代理预设名 / 🧪 测试 / 📦 获取模型）与「检索参数」三个输入；
//   · 第三层带「关键词提取 API（独立分组）」与「记忆分析 API（独立分组）」两个 `groupStrategyHtml` 区块；
//   · 还有「召回参数」（注入预算 / 各大类注入上限 / 单条字数上限）等。
// V2 此前只渲染了控件表（useVector/vectorTopN/… 一排输入），**没有 Embedding / Rerank API 区块、没有测试按钮、
//   也没有 kw/mem 分组选择**，向量层更是完全未接线 → 本批补齐（实现见 `host/embeddings.js` / `host/vector-recall.js`）。
//
// 说明（诚实登记）：V1 的「代理预设名」取自 TavernHelper 预设；V2 原生扩展拿不到该清单 →
//   V2 的等价物是**本插件自己的 API 分组**（`cfg.apiPresets`，含地址/Key/模型），键名与 V1 相同
//   （`embeddingProxyPreset` / `rerankProxyPreset`）。页面用下拉选择分组，避免让用户手打名字。
// ============================================================
import { cfg } from '../core/model/runtime.js';
import { apiPresetNames, API_CHANNEL_LABELS } from '../core/api-channel.js';
import { hintDetailsHtml, shortHintHtml } from './hints.js';
import { vectorLayerInfo } from '../host/embeddings.js';
import { aiLayerInfo } from '../host/ai-recall.js';
import { vectorCacheStats } from '../adapters/vector-cache.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 本页各层的控件键（其余键归「召回参数」） */
const LAYER_KEYS = ['useVector', 'vectorTopN', 'vectorMinScore', 'vectorTimeoutMs', 'jsExtractEnabled', 'useKeywordFlow'];
/** 重要性计算键（v2.78.0：属**召回打分**，从「基础」页迁来 → 单独分节，不进「其它召回行为」） */
const IMP_KEYS = ['importanceBase', 'importancePerUse'];

/** 分组下拉（V1 `apiBlockHtml` 的「代理预设名」在 V2 的等价物：本插件 API 分组） */
function presetSelect(key, cur) {
    const names = apiPresetNames();
    const opts = ['<option value="">（不使用分组）</option>'].concat(names.map((n) => '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>')).join('');
    return '<div class="ftt-field"><label>使用 API 分组</label><select data-ftt-cfg="' + esc(key) + '">' + opts + '</select>'
        + '<span class="ftt-muted">' + (names.length ? (names.length + ' 个分组可用') : '（还没建分组：可在「API」页创建）') + '</span></div>';
}

/** V1 `apiBlockHtml` 的 V2 等价物（Embedding / Rerank）：地址 / Key / 模型 / 分组 + 测试 + 获取模型 */
function apiBlockHtml(pfx, title, keys, kind, info) {
    const url = String(cfg[keys.url] || '');
    const key = String(cfg[keys.key] || '');
    const model = String(cfg[keys.model] || '');
    const preset = String(cfg[keys.preset] || '');
    const usable = info && info.ok;
    return [
        '<div class="ftt-api-block">',
        '<div class="ftt-api-title">' + esc(title) + '</div>',
        '<div class="ftt-field"><label>API 地址</label><input type="text" data-ftt-cfg="' + esc(keys.url) + '" value="' + esc(url) + '" placeholder="如 https://api.example.com/v1"></div>',
        '<div class="ftt-field"><label>API Key</label><input type="password" data-ftt-cfg="' + esc(keys.key) + '" value="' + esc(key) + '" autocomplete="off" spellcheck="false"></div>',
        '<div class="ftt-field"><label>模型</label><input type="text" data-ftt-cfg="' + esc(keys.model) + '" value="' + esc(model) + '" placeholder="' + esc(kind === 'embedding' ? '如 text-embedding-3-small' : '如 bge-reranker-v2-m3') + '"></div>',
        presetSelect(keys.preset, preset),
        '<div class="ftt-row">',
        '<button class="ftt-btn ftt-sm" data-ftt-action="apiTest" data-ftt-api-pfx="' + esc(pfx) + '" data-ftt-api-kind="' + esc(kind) + '">🧪 测试</button>',
        '<button class="ftt-btn ftt-sm" data-ftt-action="apiModels" data-ftt-api-pfx="' + esc(pfx) + '">📦 获取模型</button>',
        '<span class="ftt-api-test-result" data-ftt-api-result="' + esc(pfx) + '">' + esc(apiResultText(pfx)) + '</span>',
        '</div>',
        '<div class="ftt-muted">' + (usable
            ? ('当前生效：' + esc(info.model) + ' ← ' + (info.from === 'preset' ? ('分组「' + esc(info.preset) + '」') : '上方自填地址'))
            : ('尚未可用：' + esc((info && info.error) || '未配置'))) + '</div>',
        '</div>',
    ].join('\n');
}

/** 测试结果（由 `ui/api-page.js` 的动作写入；此处读同一份模块态，避免两处各写一套） */
let apiResults = {};
export function setVectorTestResult(pfx, text) { apiResults = Object.assign({}, apiResults, { [String(pfx)]: String(text == null ? '' : text) }); return apiResults; }
export function vectorTestResults() { return Object.assign({}, apiResults); }
function apiResultText(pfx) { return String(apiResults[pfx] || ''); }

/** 单层测试结果 / 预览（V1 `[data-ftt-layer-result]` / `[data-ftt-layer-preview]`） */
let layerResults = {};
export function setLayerResult(layer, res) {
    layerResults = Object.assign({}, layerResults, { [String(layer)]: { text: String((res && res.text) || ''), lines: Array.isArray(res && res.lines) ? res.lines : [] } });
    return layerResults;
}
export function layerTestResults() { return Object.assign({}, layerResults); }
function layerResultHtml(layer) {
    const r = layerResults[layer] || { text: '', lines: [] };
    const prev = r.lines.length
        ? ('<div class="ftt-note ftt-pre-inline ftt-pre-box"><div class="ftt-muted">命中内容预览（前 900 字）：</div>' + esc(r.lines.join('\n').slice(0, 900)) + '</div>')
        : '';
    return '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="testLayer" data-ftt-layer="' + esc(layer) + '">🧪 测试' + esc(layer === 'vector' ? '向量提取' : (layer === 'js' ? 'JS 抽取' : 'AI 分析')) + '</button>'
        + '<span class="ftt-muted" data-ftt-layer-result="' + esc(layer) + '">' + esc(r.text) + '</span></div>'
        + '<div data-ftt-layer-preview="' + esc(layer) + '">' + prev + '</div>';
}

/**
 * 提取页正文。
 * @param {Array} controls `SETTINGS_CONTROLS.extract`
 */
export function extractPageHtml(controls, renderControl) {
    const list = Array.isArray(controls) ? controls : [];
    const settingsControlHtml = typeof renderControl === 'function' ? renderControl : (c) => '';
    const find = (k) => list.filter((c) => String(c.key) === k)[0];
    const rows = (keys) => keys.map((k) => { const c = find(k); return c ? settingsControlHtml(c) : ''; }).filter(Boolean).join('\n');
    const rest = list.filter((c) => LAYER_KEYS.indexOf(String(c.key)) < 0);
    // v2.76.0：召回参数再分三组（预算 / 条数上限 / 其它召回行为）
    const CAP_KEYS = ['maxAtoms', 'atomsRecentRatio', 'maxStates', 'stateMinPerSubject', 'stateMaxPerSubject',
        'maxSnapshots', 'maxMemories', 'maxItems', 'maxPlans', 'maxSuspense', 'maxScenes', 'maxConcepts', 'maxParallelsInj', 'maxCurrencies'];
    const budget = rest.filter((c) => String(c.key) === 'charBudget');
    const caps = rest.filter((c) => CAP_KEYS.indexOf(String(c.key)) >= 0);
    const imp = rest.filter((c) => IMP_KEYS.indexOf(String(c.key)) >= 0);
    const other = rest.filter((c) => budget.indexOf(c) < 0 && caps.indexOf(c) < 0 && imp.indexOf(c) < 0);
    const vec = (() => { try { return vectorLayerInfo(); } catch (e) { return { embedding: { ok: false, error: '读取失败' }, rerank: { ok: false, error: '读取失败' }, rerankActive: false }; } })();
    const ai = (() => { try { return aiLayerInfo(); } catch (e) { return { kw: {}, mem: {} }; } })();
    const cache = (() => { try { return vectorCacheStats(); } catch (e) { return { memory: 0, indexedDb: false, fallback: '' }; } })();
    const layerOn = cfg.useVector === true;
    const kw = find('useVector') || { key: 'useVector', label: '启用向量检索', type: 'checkbox' };
    const kwCh = (k) => { const c = find(k); return c ? settingsControlHtml(c) : ''; };
    return [
        '<div class="ftt-section"><div class="ftt-sec-title">提取记忆 · 三层结构</div>',
        shortHintHtml('发送前按层级依次尝试，命中即返回：向量检索 → 本地 JS 抽取 → AI 分析。'),
        hintDetailsHtml('说明',
            '<div>' + esc('🟢 向量检索：关键词 embedding → 余弦 TopN（配置了 Rerank 时再精排）。') + '</div>'
            + '<div>' + esc('🟡 浏览器 JS 抽取：本地匹配，零 API 消耗。') + '</div>'
            + '<div>' + esc('🔴 AI 分析：调「记忆分析 API」从记忆库里挑要发送的条目。') + '</div>'),
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">🟢 第一层 · 向量检索（优先级最高）</div>',
        kwCh('useVector'),
        shortHintHtml(layerOn ? '已启用：优先用关键词 embedding 检索记忆库，失败自动进入下一层。' : '未启用：发送前直接进入下一层（JS 抽取 / AI 分析）。'),
        layerResultHtml('vector'),
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">Embedding</div>',
        apiBlockHtml('emb', 'Embedding API', { url: 'embeddingUrl', key: 'embeddingKey', model: 'embeddingModel', preset: 'embeddingProxyPreset' }, 'embedding', vec.embedding),
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">Rerank</div>',
        apiBlockHtml('rerank', 'Rerank API', { url: 'rerankUrl', key: 'rerankKey', model: 'rerankModel', preset: 'rerankProxyPreset' }, 'rerank', vec.rerank),
        '<div class="ftt-muted">' + (vec.rerankActive ? '已配置：向量召回后会用它精排（V1 只提供设置与测试，未接入搜索路径 —— V2 生效）。' : '未配置：向量召回只按余弦相似度排序。') + '</div>',
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">检索参数</div>',
        rows(['vectorTopN', 'vectorMinScore', 'vectorTimeoutMs']),
        '<div class="ftt-muted" data-ftt-vector-cache>向量缓存：内存 ' + cache.memory + ' 条 · IndexedDB ' + (cache.indexedDb ? '可用' : '不可用（退化为内存缓存）')
        + (cache.fallback ? (' · 最近降级：' + esc(cache.fallback)) : '') + '</div>',
        '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="vectorCacheClear" title="清空本机向量缓存（下次召回会重新请求 embedding）">🧹 清空向量缓存</button>'
        + '<span class="ftt-muted">缓存键为「类别:id」；无 IndexedDB 时退化为内存缓存。</span></div>',
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">🟡 第二层 · 浏览器 JS 抽取记忆</div>',
        kwCh('jsExtractEnabled'),
        shortHintHtml('向量层不可用或未命中时，本地 JS 抽取与召回（零 API 消耗）。'),
        layerResultHtml('js'),
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">🔴 第三层 · AI 分析</div>',
        kwCh('useKeywordFlow'),
        shortHintHtml('向量 / JS 层都未命中时，交由「记忆分析 API」挑要发送的条目。'),
        layerResultHtml('ai'),
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">关键词提取 API（独立分组）</div>',
        '<div class="ftt-field"><label>API 分组</label><select data-ftt-cfg="kwApiPreset">' + presetOptions('kwApiPreset', cfg.kwApiPreset) + '</select>'
        + '<span class="ftt-muted">未选 = 跟随主配置。当前通道：' + esc(API_CHANNEL_LABELS[ai.kw && ai.kw.channel] || '主配置') + '</span></div>',
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">记忆分析 API（独立分组）</div>',
        '<div class="ftt-field"><label>API 分组</label><select data-ftt-cfg="memApiPreset">' + presetOptions('memApiPreset', cfg.memApiPreset) + '</select>'
        + '<span class="ftt-muted">未选 = 跟随主配置。当前通道：' + esc(API_CHANNEL_LABELS[ai.mem && ai.mem.channel] || '主配置') + '</span></div>',
        '</div>',

        // v2.76.0（用户要求）：「设定-提取记忆中很多设置根本不是召回处理用的」→ 非召回项已搬到「分析记忆」页
        //   （货币记录开关 + 各大类单条字数上限）。本页只留**召回**相关，并再分三组：
        //   注入预算（真正的上限）/ 召回上限（各大类注入条数）/ 其它召回行为。
        '<div class="ftt-section"><div class="ftt-sec-title">注入预算</div>',
        budget.map((c) => settingsControlHtml(c)).join('\n'),
        shortHintHtml('预算才是注入体的真正上限：按优先级择优填充，单条放不下整条跳过（不截断条目）。'),
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">召回上限（各大类注入条数）</div>',
        caps.map((c) => settingsControlHtml(c)).join('\n'),
        shortHintHtml('这里的条数只是候选上限；默认已按 2000-3000 条库存规模放宽，预算不足时按优先级截取。'),
        '</div>',

        // v2.78.0（用户要求）：「重要性计算」是**提取记忆**（召回打分）用的 —— 从「基础」页迁到本页。
        //   公式与 V1 同口径（`core/recall.js#calcImportance`）：重要度 = 初始值 + 调用次数 × 每次增量，
        //   其中「调用次数」在条目被召回命中时累加（`markUsed`），随后参与排序与遗忘判定。
        (imp.length
            ? '<div class="ftt-section"><div class="ftt-sec-title">重要性计算（调用次数驱动）</div>'
            + imp.map((c) => settingsControlHtml(c)).join('\n')
            + shortHintHtml('重要度 = 初始值 + 调用次数 × 每次增量；被召回命中一次即累加一次。')
            + hintDetailsHtml('说明', '<div>' + esc('结果夹取在 0-1：初始值 0-1、每次增量 0-0.5。重要度参与召回排序（列表行的「重要度M%」也读它），并被遗忘机制用作保护阈值参考。') + '</div>')
            + '</div>'
            : ''),

        (other.length
            ? '<div class="ftt-section"><div class="ftt-sec-title">其它召回行为</div>' + other.map((c) => settingsControlHtml(c)).join('\n') + '</div>'
            : ''),
    ].join('\n');
}

/** 分组下拉选项（含「跟随主配置」空值） */
function presetOptions(key, cur) {
    const names = apiPresetNames();
    const c = String(cur || '');
    return ['<option value="">跟随主配置</option>'].concat(names.map((n) => '<option value="' + esc(n) + '"' + (n === c ? ' selected' : '') + '>' + esc(n) + '</option>')).join('');
}
