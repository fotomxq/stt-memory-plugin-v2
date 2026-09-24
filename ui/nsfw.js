// ============================================================
// ui/nsfw.js —— **内容弱化（NSFW）设定页与动作**（B8-4；结构与文案对齐 V1 `13-UI-设置与存储开关.js` safety 页）
// 覆盖：分析侧开关（`nsfwSoftenEnabled`）/ 固定规则自动开关（`nsfwReplaceAuto`）/ 转化库编辑器（匹配词 → 转化词）/
//   识别词条库编辑器（增删改 + 恢复内置）/ 状态行（扫描统计 · 命中候选 · 库规模）/ 动作按钮
//   （`nsfwSoften` 立即弱化、`nsfwRuleApply` 立即固定规则替换、`nsfwKw*` / `nsfwRule*` 增删改恢复）。
// 动作名与 V1 逐字一致；值优先取面板 DOM（`data-ftt-nsfw-*`），也支持经 payload 传入（测试/命令行）。
// ============================================================
import { cfg, notifyHooks } from '../core/model/runtime.js';
import { escHtml } from '../core/util.js';
import {
    nsfwSoftenState, nsfwKeywordList, nsfwKeywordsCustomized, nsfwKeywordAdd, nsfwKeywordUpdate, nsfwKeywordDelete, nsfwKeywordReset,
    nsfwRuleList, nsfwRulesCustomized, nsfwRuleAdd, nsfwRuleUpdate, nsfwRuleDelete, nsfwRuleReset, nsfwReplaceAutoOn,
    nsfwFixedReplace, runNsfwSoften, NSFW_DIM_LABEL,
} from '../core/nsfw.js';
import { settingsControlHtml } from './settings-pages.js';

const esc = (v) => escHtml(v == null ? '' : v);
const attr = esc;

/** 通知（宿主 toast 钩子） */
function toast(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}
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

/** 内容弱化设定页正文（V1 四节同序） */
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
    return [
        '<div class="ftt-section"><div class="ftt-sec-title">内容弱化（NSFW）</div>',
        switchRow('nsfwSoftenEnabled', '分析记忆时弱化露骨内容（默认关）', '追加提示词模板「内容弱化（NSFW）」'),
        '<div class="ftt-muted ftt-w-full">开启后：每次分析记忆都会把提示词模板「内容弱化（NSFW）」（提示词面板可编辑）追加进系统提示词，让「读正文 → 分析成记忆」这一步就不产生露骨描写：'
        + '剧情、关系、因果一律照实保留，只把性行为与性器官的直述换成柔性、克制、留白的表述。关闭（默认）时完全不追加，既有行为不变。</div>',
        '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="nsfwSoften" title="按词条库扫描已有原子数据并交 AI 逐条弱化（与总览「🌶 弱化NSFW」同一套核心）">🌶 立即弱化（按词条库扫描）</button>',
        '<span class="ftt-muted" data-ftt-nsfw-state>扫描：原子 ' + st.scannedItems + ' 条 / 文本字段 ' + st.scannedFields + ' 个 → 命中 <b>' + st.candidates + '</b> 处（每批最多 ' + st.batch + ' 条，可反复运行）</span></div>',
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">固定规则替换（不调用 AI 的机械转化）</div>',
        switchRow('nsfwReplaceAuto', '自动：交给 AI 弱化前先按固定规则处理一次（默认开）', ''),
        '<div class="ftt-muted ftt-w-full">开启（默认）时：点「🌶 立即弱化」或总览「🌶 弱化NSFW」，会先用固定规则库把匹配词机械替换成转化词，再把剩余命中交 AI 处置第二次，弱化更彻底且省一档 AI 负担；'
        + '关闭后固定规则只在手动点下面按钮时执行。固定规则零 AI、纯字面替换（中文原样、英文忽略大小写并避开 cumulative 一类普通词），'
        + '写完即刷新条目的 <span class="ftt-mono">updatedAt</span>（跨端合并取较新）。</div>',
        '<div class="ftt-row"><button class="ftt-btn" data-ftt-action="nsfwRuleApply" title="按固定规则库机械替换已有原子数据的匹配词（零 AI 消耗）">🔁 立即固定规则替换</button>',
        '<span class="ftt-muted" data-ftt-nsfw-rule-state>转化库 ' + ruleList.length + ' 条' + (ruleCustom ? '（<b>自定义</b>）' : '（<b>内置默认</b>）') + ' · 自动：' + (nsfwReplaceAutoOn() ? '<b>已开启</b>' : '已关闭') + '</span></div>',
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">转化库（匹配词 → 转化词，可在设定中管理）</div>',
        '<div class="ftt-muted ftt-w-full">内置一套标准转化库，默认词条与下方「识别词条库」的匹配词一一对应（共 <b>' + ruleList.length + '</b> 条）。'
        + '可改转化词、可增删条目；增删改任意一条即切换为自定义列表，「恢复内置默认」清空自定义并回到内置库。</div>',
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
        '<div class="ftt-muted ftt-w-full">内置一套标准词条（中文原样匹配、英文忽略大小写并按词界匹配）。当前生效 <b>' + kwList.length + '</b> 条' + (kwCustom ? '（<b>自定义</b>）' : '（<b>内置默认</b>，未自定义）') + '：'
        + '增删改任意一条即自动切换为自定义列表；「恢复内置默认」清空自定义并回到内置库。</div>',
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
 * 内容弱化动作（V1 同名动作名）
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
                note = '弱化 NSFW：' + (parts.length ? parts.join(' · ') : '没有命中露骨关键词') + (r.truncated ? ' · 余 ' + r.truncated + ' 条可再点一次' : '');
            }
            return { ok: !!(r.applied || r.fixed), action: a, note, detail: r };
        }
        if (a === 'nsfwRuleApply') {
            const r = nsfwFixedReplace({});
            const note = r.replaced
                ? ('固定规则替换完成：' + r.items + ' 条 / ' + r.fields + ' 个字段 / ' + r.replaced + ' 处命中已机械转化（未调用 AI）')
                : ('固定规则替换：无可替换内容（按 ' + nsfwRuleList().length + ' 条规则扫描，没有命中匹配词）');
            toast(r.replaced ? 'success' : 'info', note, '');
            return { ok: true, action: a, note, detail: r };
        }
        if (a === 'nsfwKwAdd') {
            const r = nsfwKeywordAdd(pickKwNew(p));
            const note = r && r.ok ? ('已加入词条库：「' + r.kw + '」· 当前生效 ' + r.n + ' 条') : (r && r.reason === 'dup' ? '已在词条库中（自动排重）' : '未加入：请输入词条内容');
            toast(r && r.ok ? 'success' : 'warning', note, '');
            return { ok: !!(r && r.ok), action: a, note, detail: r };
        }
        if (a === 'nsfwKwSave') {
            const idx = Number(p.idx !== undefined ? p.idx : p.index);
            const r = nsfwKeywordUpdate(idx, pickKwRow(idx, p));
            const note = r && r.ok ? ('词条已更新：「' + (r.kw || '') + '」· 当前生效 ' + r.n + ' 条')
                : (r && r.reason === 'dup' ? '该词条已存在（未修改）' : '未更新：词条为空或索引无效');
            toast(r && r.ok ? 'success' : 'warning', note, '');
            return { ok: !!(r && r.ok), action: a, note, detail: r };
        }
        if (a === 'nsfwKwDel') {
            const idx = Number(p.idx !== undefined ? p.idx : p.index);
            const r = nsfwKeywordDelete(idx);
            const note = r && r.ok ? ('已删除词条：「' + (r.removed || '') + '」· 当前生效 ' + r.n + ' 条') : '未删除：索引无效';
            toast(r && r.ok ? 'success' : 'warning', note, '');
            return { ok: !!(r && r.ok), action: a, note, detail: r };
        }
        if (a === 'nsfwKwReset') {
            const r = nsfwKeywordReset();
            const note = '已恢复内置默认词条：当前生效 ' + ((r && r.n) || 0) + ' 条（已清空自定义列表）';
            toast('success', note, '');
            return { ok: true, action: a, note, detail: r };
        }
        if (a === 'nsfwRuleAdd') {
            const r = nsfwRuleAdd(pickRuleNewFrom(p), pickRuleNewTo(p));
            const note = r && r.ok ? ('已加入转化库：「' + r.from + '」→「' + r.to + '」· 当前生效 ' + r.n + ' 条')
                : (r && r.reason === 'dup' ? '该匹配词已在转化库中（自动排重）' : '未加入：匹配词与转化词都要填写');
            toast(r && r.ok ? 'success' : 'warning', note, '');
            return { ok: !!(r && r.ok), action: a, note, detail: r };
        }
        if (a === 'nsfwRuleSave') {
            const idx = Number(p.idx !== undefined ? p.idx : p.index);
            const r = nsfwRuleUpdate(idx, pickRuleRowFrom(idx, p), pickRuleRowTo(idx, p));
            const note = r && r.ok ? ('规则已更新：「' + r.from + '」→「' + r.to + '」· 当前生效 ' + r.n + ' 条')
                : (r && r.reason === 'dup' ? '该匹配词已存在（未修改）' : '未更新：匹配词或转化词为空、或索引无效');
            toast(r && r.ok ? 'success' : 'warning', note, '');
            return { ok: !!(r && r.ok), action: a, note, detail: r };
        }
        if (a === 'nsfwRuleDel') {
            const idx = Number(p.idx !== undefined ? p.idx : p.index);
            const r = nsfwRuleDelete(idx);
            const note = r && r.ok ? ('已删除规则：「' + (r.removed || '') + '」· 当前生效 ' + r.n + ' 条') : '未删除：索引无效';
            toast(r && r.ok ? 'success' : 'warning', note, '');
            return { ok: !!(r && r.ok), action: a, note, detail: r };
        }
        if (a === 'nsfwRuleReset') {
            const r = nsfwRuleReset();
            const note = '已恢复内置标准转化库：当前生效 ' + ((r && r.n) || 0) + ' 条（已清空自定义列表）';
            toast('success', note, '');
            return { ok: true, action: a, note, detail: r };
        }
        return { ok: false, action: a, note: '未知内容弱化动作：' + a };
    } catch (e) {
        const note = String((e && e.message) || e).slice(0, 160);
        toast('error', '内容弱化动作失败', note);
        return { ok: false, action: a, note, error: note };
    }
}

/** 内容弱化动作名（供面板分发；与 V1 逐字一致） */
export const NSFW_ACTIONS = Object.freeze(['nsfwSoften', 'nsfwRuleApply', 'nsfwKwAdd', 'nsfwKwSave', 'nsfwKwDel', 'nsfwKwReset', 'nsfwRuleAdd', 'nsfwRuleSave', 'nsfwRuleDel', 'nsfwRuleReset']);
