// ============================================================
// ui/nsfw.js —— **NSFW弱化设定页与动作**（B8-4；结构与文案对齐 V1 `13-UI-设置与存储开关.js` safety 页）
//   v3.10.0（用户要求）：设定页名由「内容弱化」改为「NSFW弱化」；识别词条库与转化库扩充（扩大识别范围）
//   v3.19.0（用户要求）：「🧠 词条分析」—— 抽取**留档为强**的原子数据交 AI 找出涉敏词与柔化替换词，
//     写入**转化库**（并同批补进识别词条库），供固定规则替换与弱化流程使用。
// 覆盖：分析侧开关（`nsfwSoftenEnabled`）/ 固定规则自动开关（`nsfwReplaceAuto`）/ 转化库编辑器（匹配词 → 转化词）/
//   识别词条库编辑器（增删改 + 恢复内置）/ 状态行（扫描统计 · 命中候选 · 库规模）/ 动作按钮
//   （`nsfwSoften` 立即弱化、`nsfwRuleApply` 立即固定规则替换、`nsfwAnalyze` 词条分析、`nsfwKw*` / `nsfwRule*` 增删改恢复）。
// 动作名与 V1 逐字一致（`nsfwAnalyze` / `nsfwAnalyzeReset` 为 V2 新增）；值优先取面板 DOM（`data-ftt-nsfw-*`），
//   也支持经 payload 传入（测试/命令行）。
// v3.19.0 附带修复：库改动（词条库 / 转化库）与固定规则替换此前**没有显式落盘**——
//   现在分别在动作成功后 `saveCfg()` / `saveState()`，重开面板或重载页面不会再丢。
// ============================================================
import { cfg, saveCfg, saveState, notifyHooks } from '../core/model/runtime.js';
import { escHtml } from '../core/util.js';
import {
    nsfwSoftenState, nsfwKeywordList, nsfwKeywordsCustomized, nsfwKeywordAdd, nsfwKeywordUpdate, nsfwKeywordDelete, nsfwKeywordReset,
    nsfwRuleList, nsfwRulesCustomized, nsfwRuleAdd, nsfwRuleUpdate, nsfwRuleDelete, nsfwRuleReset, nsfwReplaceAutoOn,
    nsfwFixedReplace, runNsfwSoften, NSFW_DIM_LABEL,
    nsfwLabelStats, nsfwBackfill, nsfwClassifyItem, nsfwLevelLabel, NSFW_LEVEL_LABELS, NSFW_WEAK_SIGNALS,   // v3.8.0：NSFW 等级留档
} from '../core/nsfw.js';
// v3.19.0：NSFW 词条分析（抽强留档 → AI 找词 → 写转化库）
import { nsfwAnalyzeState, runNsfwAnalyze, nsfwAnalyzeSeenReset, NSFW_ANALYZE_BATCH, NSFW_ANALYZE_MAX_ADD, NSFW_ANALYZE_SPREAD_MAX } from '../core/nsfw-analyze.js';
import { settingsControlHtml } from './settings-pages.js';
import { hintDetailsHtml } from './hints.js';   // v3.8.0：长说明折叠（页面提示 ≤90 字的规范）

const esc = (v) => escHtml(v == null ? '' : v);
const attr = esc;

/** 通知（宿主 toast 钩子） */
function toast(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}
/**
 * v3.19.0 附带修复：库改动（识别词条库 / 转化库）**显式落盘**。
 *   此前只有内存态被改写 —— 重开面板/重载页面后改动会丢（要等别的流程顺带保存配置）。
 */
function persistCfg() { try { saveCfg(); } catch (e) { /* 落盘失败不影响内存态 */ } }
/** 面板 DOM 取值（测试/无 DOM 时回退 payload） */
function domValue(sel, payloadVal) {
    if (payloadVal !== undefined && payloadVal !== null) return String(payloadVal);
    try {
        const doc = globalThis.document;
        if (!doc || typeof doc.querySelector !== 'function') return '';
        const el = doc.querySelector(sel);
        return el ? String(el.value == null ? '' : el.value) : '';
    } catch (e) { return ''; }
}

/** 开关行（V1 `switchField` 同款结构：`data-ftt-cfg` + ftt-switch） */
function switchRow(key, label, hint) {
    const on = cfg[key] === true;
    return '<div class="ftt-field"><label>' + esc(label) + '</label>'
        + '<label class="ftt-switch"><input type="checkbox" data-ftt-cfg="' + esc(key) + '"' + (on ? ' checked' : '') + '><span class="ftt-slider"></span></label>'
        + '<span class="ftt-muted">' + (on ? '已开启' : '已关闭') + '</span>'
        + '<span style="flex:1"></span><span class="ftt-muted">' + esc(hint || '') + '</span></div>';
}

/** NSFW弱化设定页正文（v3.10.0：留档分节 + V1 四节同序） */
export function nsfwPageHtml() {
    const st = nsfwSoftenState();
    const kwList = nsfwKeywordList();
    const kwCustom = nsfwKeywordsCustomized();
    const kwRows = kwList.map((k, i) => `
<div class="ftt-row" style="align-items:center;gap:6px;margin:2px 0" data-ftt-nsfw-kw-row="${i}">
  <input type="text" data-ftt-nsfw-kw="${i}" value="${attr(k)}" style="flex:1 1 auto;min-width:120px" title="编辑该词条">
  <button class="ftt-btn ftt-sm" data-ftt-action="nsfwKwSave" data-ftt-idx="${i}" title="保存该词条">💾</button>
  <button class="ftt-btn ftt-sm ftt-err" data-ftt-action="nsfwKwDel" data-ftt-idx="${i}" title="删除该词条">🗑</button>
</div>`).join('');
    const ruleList = nsfwRuleList();
    const ruleCustom = nsfwRulesCustomized();
    const ruleRows = ruleList.map((r, i) => `
<div class="ftt-row" style="align-items:center;gap:6px;margin:2px 0" data-ftt-nsfw-rule-row="${i}">
  <input type="text" data-ftt-nsfw-rule-from="${i}" value="${attr(r.from)}" style="flex:0 1 40%;min-width:80px" title="匹配词（将被替换）">
  <span class="ftt-muted">→</span>
  <input type="text" data-ftt-nsfw-rule-to="${i}" value="${attr(r.to)}" style="flex:1 1 auto;min-width:80px" title="转化词（替换为）">
  <button class="ftt-btn ftt-sm" data-ftt-action="nsfwRuleSave" data-ftt-idx="${i}" title="保存该条规则">💾</button>
  <button class="ftt-btn ftt-sm ftt-err" data-ftt-action="nsfwRuleDel" data-ftt-idx="${i}" title="删除该条规则">🗑</button>
</div>`).join('');
    const labs = (() => { try { return nsfwLabelStats(); } catch (e) { return { none: 0, weak: 0, strong: 0, total: 0 }; } })();
    // v3.19.0：词条分析状态（只读扫描强留档字段 + 账本里的「上次分析」）
    const az = (() => { try { return nsfwAnalyzeState(); } catch (e) { return null; } })()
        || { strongItems: 0, strongFields: 0, unseen: 0, batch: NSFW_ANALYZE_BATCH, cap: NSFW_ANALYZE_MAX_ADD, rules: 0, keywords: 0, seen: 0, last: null, items: [] };
    const azWhen = (() => {
        try { return az.last ? new Date(Number(az.last.at) || 0).toLocaleString('zh-CN', { hour12: false }) : ''; } catch (e) { return ''; }
    })();
    const azState = az.last
        ? ('上次分析 ' + esc(azWhen) + '：提交 ' + Number(az.last.examined || 0) + ' 处 → 新增 <b>' + Number(az.last.added || 0) + '</b> 条'
            + (Number(az.last.dup || 0) ? ' · 已在库 ' + Number(az.last.dup) : '')
            + (Number(az.last.rejected || 0) ? ' · 丢弃 ' + Number(az.last.rejected) : '')
            + ' · 已分析进度 ' + Number(az.seen || 0) + ' 处')
        : '尚未分析（进度 0 处）';
    const azItems = (Array.isArray(az.items) ? az.items : []).map((x) => `「${esc(String(x && x.from))}」→「${esc(String(x && x.to))}」`).join(' · ');
    return [
        // v3.8.0（用户要求）：「NSFW 等级留档」——无/弱/强三级，弱化后不变（永久性留档）
        '<div class="ftt-section" data-ftt-nsfw-labels><div class="ftt-sec-title">📌 NSFW 等级留档（无 / 弱 / 强）</div>',
        '<div class="ftt-muted ftt-w-full">每条原子数据带一个 NSFW 等级标签：按<b>原文</b>判定，<b>弱化内容不会改变它</b>（永久性留档）。</div>',
        hintDetailsHtml('三级口径与补档规则', '<div>' + esc('无 = 与 NSFW 完全无关；弱 = 有部分亲密或暗示但无露骨内容；强 = 完全是露骨内容。'
            + '标签在数据写入时判定（AI 显式标注优先，其次按原文关键词与亲密/暗示信号），只升不降：'
            + '已有「强」的条目不会因为正文被弱化而降到「弱」；跨端合并取两侧较高者。'
            + '老存档与派生条目在载入时自动补档一次，也可在此手动补档。') + '</div>'),
        '<div class="ftt-row"><span class="ftt-muted" data-ftt-nsfw-label-state>当前留档：共 <b>' + labs.total + '</b> 条 —— 无 <b>' + labs.none + '</b> · 弱 <b>' + labs.weak + '</b> · 强 <b>' + labs.strong + '</b></span>',
        '<button class="ftt-btn ftt-sm" data-ftt-action="nsfwLabelBackfill" title="按原文重新判级并补齐留档标签（只升不降、幂等；老存档在载入时已自动补档一次）">🔖 立即补档</button></div>',
        '<div class="ftt-hint ftt-w-full">补档只升不降：已有「强」的条目不会因正文被弱化而降档（弱级信号词 ' + NSFW_WEAK_SIGNALS.length + ' 条内置）。</div>',
        '</div>',

        // v3.19.0（用户要求）：「🧠 词条分析」—— 抽**强留档**数据交 AI 找涉敏词与替换词 → 写入转化库
        '<div class="ftt-section" data-ftt-nsfw-analyze><div class="ftt-sec-title">🧠 词条分析（AI 找涉敏词 → 写入转化库）</div>',
        '<div class="ftt-muted ftt-w-full">抽取<b>留档为「强」</b>的原子数据交 AI：找出造成露骨的词，并各给一个柔化替换词 → 写入<b>转化库</b>（同批补进识别词条库）。</div>',
        '<div class="ftt-muted ftt-w-full">可分析：强留档 <b>' + Number(az.strongItems || 0) + '</b> 条 / 字段 <b>' + Number(az.strongFields || 0) + '</b> 处（未分析 <b>' + Number(az.unseen || 0) + '</b> 处）· 每批 ' + Number(az.batch || NSFW_ANALYZE_BATCH) + ' 处 · 单次最多落 ' + Number(az.cap || NSFW_ANALYZE_MAX_ADD) + ' 条</div>',
        '<div class="ftt-row"><button class="ftt-btn ftt-primary" data-ftt-action="nsfwAnalyze" title="抽取留档为「强」的原子数据交 AI 识别涉敏词与建议替换词，校验后写入转化库（同批补进识别词条库）；每批 12 处，可反复点">🧠 词条分析（AI 找词并写入转化库）</button>',
        '<button class="ftt-btn ftt-sm" data-ftt-action="nsfwAnalyzeReset" title="清空分析进度（下次从全部强留档数据重新开始；不动词条库与转化库）">♻ 重置分析进度</button>',
        '<span class="ftt-muted" data-ftt-nsfw-analyze-state>' + azState + '</span></div>',
        hintDetailsHtml('词条分析怎么判定（校验与误伤护栏）', '<div>' + esc('① 只提交**留档为强**的字段（已总结隐藏的情节不参与）；每批 '
            + NSFW_ANALYZE_BATCH + ' 处，未分析过的优先；已分析过的按内容指纹记账（上限 300，内容改写后视为新数据）。'
            + '② AI 必须给出 JSON：「词」要**原样出现**在该条原文里（否则丢弃，防造词）、「替换」不得仍含露骨词（按识别词条库核对）、'
            + '不得与原词相同或包含原词。③ 词长度 2 字以上（拉丁词干 3 字母以上）、不允许空白与标点、不允许日常词黑名单；'
            + '词若在**非强留档**数据里出现 ' + NSFW_ANALYZE_SPREAD_MAX + ' 条以上（判定为日常词）直接丢弃并在提示里说明。'
            + '④ 单次最多落 ' + NSFW_ANALYZE_MAX_ADD + ' 条；已在库中的词按去重跳过。⑤ 落库即写入转化库（可用于「🔁 立即固定规则替换」）'
            + '并同批补进识别词条库；两条库都可在本页逐条编辑或「恢复内置默认」还原。') + '</div>'),
        (azItems ? hintDetailsHtml('最近新增的词条（最近 10 条）', '<div>' + azItems + '</div>') : ''),
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">NSFW弱化</div>',
        switchRow('nsfwSoftenEnabled', '分析记忆时弱化露骨内容（默认关）', '追加提示词模板「NSFW弱化」'),
        '<div class="ftt-muted ftt-w-full">开启后：分析记忆时追加「NSFW弱化」模板，让新记忆不产生露骨描写（剧情与因果照实保留）。</div>',
        '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="nsfwSoften" title="按词条库扫描已有原子数据并交 AI 逐条弱化（与总览「🌶 弱化NSFW」同一套核心）">🌶 立即弱化（按词条库扫描）</button>',
        '<span class="ftt-muted" data-ftt-nsfw-state>扫描：原子 ' + st.scannedItems + ' 条 / 文本字段 ' + st.scannedFields + ' 个 → 命中 <b>' + st.candidates + '</b> 处（每批最多 ' + st.batch + ' 条，可反复运行）</span></div>',
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">固定规则替换（不调用 AI 的机械转化）</div>',
        switchRow('nsfwReplaceAuto', '自动：交给 AI 弱化前先按固定规则处理一次（默认开）', ''),
        '<div class="ftt-muted ftt-w-full">开启（默认）：弱化时先按固定规则机械替换，再把剩余命中交 AI 处置，更彻底也更省 AI 调用；关闭则只在点下面按钮时替换。</div>',
        '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="nsfwRuleApply" title="按固定规则库机械替换已有原子数据的匹配词（零 AI 消耗）">🔁 立即固定规则替换</button>',
        '<span class="ftt-muted" data-ftt-nsfw-rule-state>转化库 ' + ruleList.length + ' 条' + (ruleCustom ? '（<b>自定义</b>）' : '（<b>内置默认</b>）') + ' · 自动：' + (nsfwReplaceAutoOn() ? '<b>已开启</b>' : '已关闭') + '</span></div>',
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">转化库（匹配词 → 转化词，可在设定中管理）</div>',
        '<div class="ftt-muted ftt-w-full">内置标准转化库（与「识别词条库」一一对应，共 ' + ruleList.length + ' 条）；改任意一条即转为自定义，「恢复内置默认」可还原。</div>',
        '<div class="ftt-row" style="align-items:center;gap:6px">',
        '<input type="text" data-ftt-nsfw-rule-new-from placeholder="匹配词（如：做爱）" style="flex:0 1 40%;min-width:80px">',
        '<span class="ftt-muted">→</span>',
        '<input type="text" data-ftt-nsfw-rule-new-to placeholder="转化词（如：亲近）" style="flex:1 1 auto;min-width:80px">',
        '<button class="ftt-btn ftt-sm" data-ftt-action="nsfwRuleAdd" title="加入转化库（匹配词去重）">＋ 新增</button>',
        '<button class="ftt-btn ftt-sm" data-ftt-action="nsfwRuleReset" title="清空自定义列表，恢复内置标准转化库">♻ 恢复内置默认</button>',
        '</div>',
        '<div class="ftt-hint ftt-w-full" style="max-height:260px;overflow:auto">' + (ruleRows || '<div class="ftt-muted">（空）点「恢复内置默认」可载入内置转化库</div>') + '</div>',
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">识别词条库（用于匹配需弱化的内容）</div>',
        '<div class="ftt-muted ftt-w-full">当前生效 <b>' + kwList.length + '</b> 条' + (kwCustom ? '（自定义）' : '（内置默认）') + '；改任意一条即转为自定义，「恢复内置默认」可还原。</div>',
        '<div class="ftt-row" style="align-items:center;gap:6px">',
        '<input type="text" data-ftt-nsfw-kw-new placeholder="新增词条（如：露骨词 / explicit）" style="flex:1 1 auto;min-width:160px">',
        '<button class="ftt-btn ftt-sm" data-ftt-action="nsfwKwAdd" title="加入词条库（自动排重）">＋ 新增</button>',
        '<button class="ftt-btn ftt-sm" data-ftt-action="nsfwKwReset" title="清空自定义列表，恢复内置标准词条">♻ 恢复内置默认</button>',
        '</div>',
        '<div class="ftt-hint ftt-w-full" style="max-height:260px;overflow:auto">' + (kwRows || '<div class="ftt-muted">（空）点「恢复内置默认」可载入内置词条</div>') + '</div>',
        '</div>',

        '<div class="ftt-hint">弱化维度：' + Object.keys(NSFW_DIM_LABEL).map((k) => esc(NSFW_DIM_LABEL[k])).join(' · ') + '；已总结隐藏的情节不参与扫描与替换。</div>',
    ].join('\n');
}

/** 库条目动作读取（payload 优先 → DOM） */
function pickKwNew(p) { return domValue('[data-ftt-nsfw-kw-new]', p && p.text !== undefined ? p.text : undefined); }
function pickKwRow(idx, p) { return domValue('[data-ftt-nsfw-kw="' + idx + '"]', p && p.text !== undefined ? p.text : undefined); }
function pickRuleNewFrom(p) { return domValue('[data-ftt-nsfw-rule-new-from]', p && p.from !== undefined ? p.from : undefined); }
function pickRuleNewTo(p) { return domValue('[data-ftt-nsfw-rule-new-to]', p && p.to !== undefined ? p.to : undefined); }
function pickRuleRowFrom(idx, p) { return domValue('[data-ftt-nsfw-rule-from="' + idx + '"]', p && p.from !== undefined ? p.from : undefined); }
function pickRuleRowTo(idx, p) { return domValue('[data-ftt-nsfw-rule-to="' + idx + '"]', p && p.to !== undefined ? p.to : undefined); }

/**
 * NSFW弱化动作（V1 同名动作名）
 * @returns {Promise<{ok:boolean, action:string, note:string, detail?:object}>}
 */
export async function nsfwAction(action, payload) {
    const a = String(action || '');
    const p = payload || {};
    try {
        if (a === 'nsfwSoften') {
            const r = await runNsfwSoften({});
            let note;
            if (r.blocked) note = '弱化 NSFW：任务进行中，请稍候再试';
            else if (r.error === 'no-ai') note = '弱化 NSFW：AI 未返回内容（未改动数据）' + (r.fixed ? '（固定规则已处理 ' + r.fixed.replaced + ' 处）' : '');
            else if (r.error) note = '弱化 NSFW 失败：' + String(r.error).slice(0, 120);
            else if (r.skipped === true) {
                // 「无命中/无需 AI」的短路形态（skipped 为布尔）—— 与「丢弃不合格 N 条」区分开
                note = '弱化 NSFW：' + (r.fixed ? ('固定规则已处理 ' + r.fixed.replaced + ' 处') : '没有命中露骨关键词')
                    + '（扫描 ' + Number(r.scannedItems || 0) + ' 条 / ' + Number(r.scannedFields || 0) + ' 个字段）';
            }
            else {
                const parts = [];
                if (r.fixed) parts.push('固定规则已处理 ' + r.fixed.replaced + ' 处');
                if (r.applied) parts.push('已弱化 ' + r.applied + ' 条');
                if (r.unchanged) parts.push('无变化 ' + r.unchanged + ' 条');
                if (r.unable) parts.push('AI 无法处理 ' + r.unable + ' 条');
                if (r.skipped) parts.push('丢弃不合格 ' + r.skipped + ' 条');
                note = '弱化 NSFW：' + (parts.length ? parts.join(' · ') : '没有命中露骨关键词') + (r.applied ? '（NSFW 标签留档不变）' : '') + (r.truncated ? ' · 余 ' + r.truncated + ' 条可再点一次' : '');
            }
            return { ok: !!(r.applied || r.fixed), action: a, note, detail: r };
        }
        if (a === 'nsfwLabelBackfill') {
            const r = nsfwBackfill({});
            const labs = (() => { try { return nsfwLabelStats(); } catch (e) { return { none: 0, weak: 0, strong: 0, total: 0 }; } })();
            const note = 'NSFW 等级留档：扫描 ' + Number(r.scanned || 0) + ' 条 → 新打标 ' + Number(r.stamped || 0) + ' 条（弱 ' + Number(r.weak || 0) + ' · 强 ' + Number(r.strong || 0) + '）；'
                + '当前共 ' + labs.total + ' 条：无 ' + labs.none + ' · 弱 ' + labs.weak + ' · 强 ' + labs.strong + '（只升不降，弱化不改标签）';
            toast(r.stamped ? 'success' : 'info', note, '');
            return { ok: true, action: a, note, detail: r };
        }
        if (a === 'nsfwAnalyze') {
            // v3.18.0（用户要求）：抽取强留档数据 → AI 找涉敏词与替换词 → 写入转化库（+ 识别词条库）
            const r = await runNsfwAnalyze({});
            let note;
            if (r.blocked) note = '词条分析：任务进行中，请稍候再试';
            else if (r.error === 'no-ai') note = '词条分析：AI 未返回内容（未改动任何数据，进度也未推进）';
            else if (r.error) note = '词条分析失败：' + String(r.error).slice(0, 120);
            else if (r.skipped === 'no-strong') note = '词条分析：没有可分析的强留档数据（' + Number(r.scannedItems || 0) + ' 条里留档为「强」的 ' + Number(r.strongItems || 0) + ' 条 → 先点上面「🔖 立即补档」）';
            else if (r.skipped === 'all-seen') note = '词条分析：强留档数据都已分析过（进度 ' + Number(r.seen || 0) + ' 处）· 有新数据会自动入队，要重跑请点「♻ 重置分析进度」';
            else {
                const parts = [];
                if (r.added) parts.push('新增转化规则 ' + r.added + ' 条（同批补进识别词条库）');
                if (r.dup) parts.push('已在库跳过 ' + r.dup + ' 条');
                if (r.rejected) parts.push('丢弃不合格 ' + r.rejected + ' 条');
                if (r.capped) parts.push('超上限未落库 ' + r.capped + ' 条');
                note = '词条分析：' + (parts.length ? parts.join(' · ') : 'AI 未给出可用词条')
                    + '（提交 ' + Number(r.submitted || 0) + '/' + Number(r.examined || 0) + ' 处 · 转化库 ' + Number(r.rules || 0) + ' 条 · 识别词条库 ' + Number(r.keywords || 0) + ' 条）'
                    + (r.truncated ? ' · 余 ' + r.truncated + ' 处可再点一次' : '')
                    + (r.details && r.details.length ? '；例：' + r.details.slice(0, 3).map((d) => '「' + d.from + '」→「' + d.to + '」').join('、') : '');
            }
            return { ok: !!r.added, action: a, note, detail: r };
        }
        if (a === 'nsfwAnalyzeReset') {
            nsfwAnalyzeSeenReset();
            const st2 = (() => { try { return nsfwAnalyzeState(); } catch (e) { return null; } })();
            const note = '已重置词条分析进度：下次会重新分析全部 ' + Number((st2 && st2.strongFields) || 0) + ' 处强留档字段（未改动词条库与转化库）';
            toast('info', note, '');
            return { ok: true, action: a, note, detail: st2 };
        }
        if (a === 'nsfwRuleApply') {
            const r = nsfwFixedReplace({});
            // v3.18.0 附带修复：机械替换改的是**状态里的正文**，此前没有显式落盘（要等别的流程顺带保存）
            if (r.replaced) { try { saveState(); } catch (e) { /* 落盘失败不影响内存态 */ } }
            const note = r.replaced
                ? ('固定规则替换完成：' + r.items + ' 条 / ' + r.fields + ' 个字段 / ' + r.replaced + ' 处命中已机械转化（未调用 AI）')
                : ('固定规则替换：无可替换内容（按 ' + nsfwRuleList().length + ' 条规则扫描，没有命中匹配词）');
            toast(r.replaced ? 'success' : 'info', note, '');
            return { ok: true, action: a, note, detail: r };
        }
        if (a === 'nsfwKwAdd') {
            const r = nsfwKeywordAdd(pickKwNew(p));
            if (r && r.ok) persistCfg();
            const note = r && r.ok ? ('已加入词条库：「' + r.kw + '」· 当前生效 ' + r.n + ' 条') : (r && r.reason === 'dup' ? '已在词条库中（自动排重）' : '未加入：请输入词条内容');
            toast(r && r.ok ? 'success' : 'warning', note, '');
            return { ok: !!(r && r.ok), action: a, note, detail: r };
        }
        if (a === 'nsfwKwSave') {
            const idx = Number(p.idx !== undefined ? p.idx : p.index);
            const r = nsfwKeywordUpdate(idx, pickKwRow(idx, p));
            if (r && r.ok) persistCfg();
            const note = r && r.ok ? ('词条已更新：「' + (r.kw || '') + '」· 当前生效 ' + r.n + ' 条')
                : (r && r.reason === 'dup' ? '该词条已存在（未修改）' : '未更新：词条为空或索引无效');
            toast(r && r.ok ? 'success' : 'warning', note, '');
            return { ok: !!(r && r.ok), action: a, note, detail: r };
        }
        if (a === 'nsfwKwDel') {
            const idx = Number(p.idx !== undefined ? p.idx : p.index);
            const r = nsfwKeywordDelete(idx);
            if (r && r.ok) persistCfg();
            const note = r && r.ok ? ('已删除词条：「' + (r.removed || '') + '」· 当前生效 ' + r.n + ' 条') : '未删除：索引无效';
            toast(r && r.ok ? 'success' : 'warning', note, '');
            return { ok: !!(r && r.ok), action: a, note, detail: r };
        }
        if (a === 'nsfwKwReset') {
            const r = nsfwKeywordReset();
            persistCfg();
            const note = '已恢复内置默认词条：当前生效 ' + ((r && r.n) || 0) + ' 条（已清空自定义列表）';
            toast('success', note, '');
            return { ok: true, action: a, note, detail: r };
        }
        if (a === 'nsfwRuleAdd') {
            const r = nsfwRuleAdd(pickRuleNewFrom(p), pickRuleNewTo(p));
            if (r && r.ok) persistCfg();
            const note = r && r.ok ? ('已加入转化库：「' + r.from + '」→「' + r.to + '」· 当前生效 ' + r.n + ' 条')
                : (r && r.reason === 'dup' ? '该匹配词已在转化库中（自动排重）' : '未加入：匹配词与转化词都要填写');
            toast(r && r.ok ? 'success' : 'warning', note, '');
            return { ok: !!(r && r.ok), action: a, note, detail: r };
        }
        if (a === 'nsfwRuleSave') {
            const idx = Number(p.idx !== undefined ? p.idx : p.index);
            const r = nsfwRuleUpdate(idx, pickRuleRowFrom(idx, p), pickRuleRowTo(idx, p));
            if (r && r.ok) persistCfg();
            const note = r && r.ok ? ('规则已更新：「' + r.from + '」→「' + r.to + '」· 当前生效 ' + r.n + ' 条')
                : (r && r.reason === 'dup' ? '该匹配词已存在（未修改）' : '未更新：匹配词或转化词为空、或索引无效');
            toast(r && r.ok ? 'success' : 'warning', note, '');
            return { ok: !!(r && r.ok), action: a, note, detail: r };
        }
        if (a === 'nsfwRuleDel') {
            const idx = Number(p.idx !== undefined ? p.idx : p.index);
            const r = nsfwRuleDelete(idx);
            if (r && r.ok) persistCfg();
            const note = r && r.ok ? ('已删除规则：「' + (r.removed || '') + '」· 当前生效 ' + r.n + ' 条') : '未删除：索引无效';
            toast(r && r.ok ? 'success' : 'warning', note, '');
            return { ok: !!(r && r.ok), action: a, note, detail: r };
        }
        if (a === 'nsfwRuleReset') {
            const r = nsfwRuleReset();
            persistCfg();
            const note = '已恢复内置标准转化库：当前生效 ' + ((r && r.n) || 0) + ' 条（已清空自定义列表）';
            toast('success', note, '');
            return { ok: true, action: a, note, detail: r };
        }
        return { ok: false, action: a, note: '未知 NSFW弱化动作：' + a };
    } catch (e) {
        const note = String((e && e.message) || e).slice(0, 160);
        toast('error', 'NSFW弱化动作失败', note);
        return { ok: false, action: a, note, error: note };
    }
}

/** NSFW弱化动作名（供面板分发；动作名与 V1 逐字一致；`nsfwAnalyze` / `nsfwAnalyzeReset` 为 v3.18.0 新增） */
export const NSFW_ACTIONS = Object.freeze(['nsfwSoften', 'nsfwLabelBackfill', 'nsfwAnalyze', 'nsfwAnalyzeReset', 'nsfwRuleApply', 'nsfwKwAdd', 'nsfwKwSave', 'nsfwKwDel', 'nsfwKwReset', 'nsfwRuleAdd', 'nsfwRuleSave', 'nsfwRuleDel', 'nsfwRuleReset']);
