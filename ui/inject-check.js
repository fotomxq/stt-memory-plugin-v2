// ============================================================
// ui/inject-check.js —— **约束自查面板**（对齐 V1 `injectCheckPanelHtml` / `injectCheckData`）
// 回答两件事（V1 v1.169 口径）：
//   ① 本轮【注入约束】段**原样**是什么（与真实注入同一代码路径：`buildMemoryBodyForInject(..., {diagnose:true})`）；
//   ② 库里还有哪些**非公共信息**没进注入，以及原因（关键词未命中 / 候选未入选〔条数上限或预算不足〕）。
// 特性：只读、零 AI、不写 state、不动 uses（`countUses:false`）；两种预览口径（按最近关键词 / 按本地召回）。
// ============================================================
import { cfg, state } from '../core/model/runtime.js';
import { buildMemoryBodyForInject } from '../core/recall.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = esc;
const DIMS = ['memories', 'plans', 'suspense', 'parallels'];
const DIM_CN = { memories: '记忆', plans: '计划', suspense: '悬念', parallels: '平行事件' };

const checkState = { useKeywords: true, query: '', keywords: [], runs: 0, lastAt: 0 };
/** 指定预览口径（V1 `checkMode`：'kw' | 'bare'） */
export function setCheckMode(mode) { checkState.useKeywords = (String(mode) !== 'bare'); return checkState.useKeywords; }
/** 设定关键词（面板调用；空则按本地召回） */
export function setCheckKeywords(list) { checkState.keywords = Array.isArray(list) ? list.slice(0, 20) : []; checkState.query = checkState.keywords.join(' '); return checkState.query; }
/** 自查状态（诊断/测试） */
export function checkInfo() { return Object.assign({}, checkState); }

/**
 * 生成自查数据（只读）。
 * @param {object} [opts] useKeywords / keywords / query
 * @returns {object} 结构化诊断：约束段原文、注入/候选条目、未召回非公共信息及原因
 */
export function injectCheckData(opts) {
    const o = opts || {};
    const useKeywords = (o.useKeywords === undefined) ? checkState.useKeywords : (o.useKeywords !== false && String(o.useKeywords) !== 'bare');
    const keywords = Array.isArray(o.keywords) ? o.keywords : checkState.keywords;
    const query = String(o.query !== undefined ? o.query : (useKeywords ? (keywords.join(' ') || checkState.query) : ''));
    try {
        const diag = buildMemoryBodyForInject(query, {
            diagnose: true, countUses: false, inject: true,
            charBudget: cfg.charBudget, maxAtoms: cfg.maxAtoms, maxMemories: cfg.maxMemories,
        });
        if (!diag || diag.ok !== true) return { ok: false, error: '本地召回诊断不可用', useKeywords, query, keywords };
        const injected = diag.injected || {};
        const candidates = diag.candidates || {};
        const recalledCounts = {};
        DIMS.forEach((d) => { recalledCounts[d] = Array.isArray(injected[d]) ? injected[d].length : 0; });
        // 未召回的非公共信息（V1：非公共 = 存在关联行且没有 public 行；无关联行视为「仅幕后」）
        const notRecalled = [];
        const notRecalledCounts = {};
        DIMS.forEach((d) => { notRecalledCounts[d] = 0; });
        try {
            const links = Array.isArray(state.links) ? state.links : [];
            for (const d of DIMS) {
                const candSet = new Set((Array.isArray(candidates[d]) ? candidates[d] : []).map(String));
                const injSet = new Set((Array.isArray(injected[d]) ? injected[d] : []).map(String));
                for (const e of ((state[d] || []))) {
                    const id = String((e && e.id) || '');
                    if (!id || injSet.has(id)) continue;
                    const rows = links.filter((x) => x && String(x.dim) === d && String(x.refId) === id);
                    const isPublic = rows.some((x) => x && x.public);
                    if (isPublic) continue;                                   // 公共信息不进「非公共未召回」清单
                    const reason = candSet.has(id) ? 'candidate-not-selected' : 'not-matched';
                    notRecalled.push({
                        dim: d, id, reason,
                        title: String((e && (e.title || e.content || e.text || e.name)) || id).replace(/\s+/g, ' ').slice(0, 40),
                        how: rows.filter((x) => x && x.who).map((x) => String(x.who)).slice(0, 6),
                    });
                    notRecalledCounts[d] += 1;
                }
            }
        } catch (e) { /* 忽略：清单失败不影响约束段预览 */ }
        checkState.runs += 1;
        checkState.lastAt = Date.now();
        return {
            ok: true, useKeywords, query, keywords,
            budget: diag.budget, itemBudget: diag.itemBudget, reserve: diag.reserve, used: diag.used, caps: diag.caps,
            constraintOn: diag.constraintOn !== false,
            constraintCap: diag.constraintCap, constraintText: String(diag.constraintText || ''),
            constraintClipped: !!diag.constraintClipped, constraintLen: String(diag.constraintText || '').length,
            constraintPosition: String(diag.position || 'tail'),
            bodyChars: String(diag.bodyText || '').length, totalChars: String(diag.totalText || '').length,
            catHeads: Array.isArray(diag.catHeads) ? diag.catHeads : [],
            recalledCounts, notRecalledCounts, notRecalled,
        };
    } catch (e) { return { ok: false, error: String((e && e.message) || e), useKeywords, query, keywords }; }
}

/** 自查面板 HTML（V1 结构：统计条 + 工具行 + 约束段原文 + 未召回清单） */
export function injectCheckPanelHtml(opts) {
    const d = injectCheckData(opts);
    if (!d || d.ok === false) return '<div class="ftt-empty">注入自查不可用：' + esc(String((d && d.error) || '未知错误')) + '</div>';
    const notRecTotal = DIMS.reduce((n, k) => n + (d.notRecalledCounts[k] || 0), 0);
    const chip = '<div class="ftt-cat-stat ftt-chip">约束段 ' + d.constraintLen + ' 字' + (d.constraintOn ? (' / 上限 ' + d.constraintCap + ' 字') : '（未启用）')
        + ' · 已召回 ' + DIMS.map((k) => (DIM_CN[k] + ' ' + (d.recalledCounts[k] || 0))).join(' / ')
        + ' · 未召回非公共信息 ' + notRecTotal + ' 条</div>';
    const tools = '<div class="ftt-toolbar ftt-rel-tools">'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="checkRefresh" title="按当前数据重新生成预览">🔄 刷新预览</button>'
        + '<button class="ftt-btn ftt-sm' + (d.useKeywords ? ' ftt-primary' : '') + '" data-ftt-action="checkMode" data-ftt-mode="kw" title="按最近一次提取的关键词预览">🔑 按最近关键词</button>'
        + '<button class="ftt-btn ftt-sm' + (d.useKeywords ? '' : ' ftt-primary') + '" data-ftt-action="checkMode" data-ftt-mode="bare" title="不看关键词，按本地召回（优先级）预览">🧭 按本地召回</button>'
        + '<span class="ftt-hint">只读 · 零 AI · 与真实注入同一代码路径（' + (d.useKeywords ? '关键词' : '本地召回') + '口径）</span></div>';
    const legend = '<div class="ftt-hint ftt-rel-legend">查询词：' + (d.query ? esc(String(d.query).slice(0, 80)) : '（无关键词 → 按优先级召回全部候选）')
        + (d.keywords && d.keywords.length ? (' · 关键词 ' + d.keywords.length + ' 个') : '')
        + ' · 预算 ' + d.budget + ' 字（条目可用 ' + d.itemBudget + '，约束预留 ' + d.reserve + '，已用 ' + d.used + '）。</div>';
    const body = [];
    body.push('<h4 class="ftt-sec-title">🧷 【注入约束】原样预览</h4>');
    if (!d.constraintOn) body.push('<div class="ftt-empty">固定约束段已关闭（设定 → 分析记忆 → <b>injectConstraintBlock</b>）：注入体末尾不会出现【注入约束】段。</div>');
    else if (!d.constraintText) body.push('<div class="ftt-empty">本轮未生成约束段：库里暂无可注入条目（无条目时注入体与约束段都不输出）。</div>');
    else {
        body.push('<div class="ftt-pre-box"><div class="ftt-pre">' + esc(d.constraintText) + '</div></div>');
        body.push('<div class="ftt-hint">' + (d.constraintClipped ? '⚠️ 已被预算压缩（整段降级，未切半句）· ' : '')
            + '字数 ' + d.constraintLen + ' / 上限 ' + d.constraintCap + ' · 位置 ' + (d.constraintPosition === 'head' ? '开头' : '末尾') + '</div>');
    }
    body.push('<h4 class="ftt-sec-title">📉 未进注入的非公共信息</h4>');
    if (!notRecTotal) body.push('<div class="ftt-empty">没有遗漏：库内非公共信息均已进入本轮注入（或库为空）。</div>');
    else {
        const rows = d.notRecalled.slice(0, 60).map((x) => '<div class="ftt-item ftt-inline"><span class="ftt-grow"><b>' + esc(x.title) + '</b> <span class="ftt-muted">' + esc(DIM_CN[x.dim] || x.dim)
            + (x.how && x.how.length ? (' · 知情：' + esc(x.how.join('、'))) : '')
            + ' · ' + (x.reason === 'candidate-not-selected' ? '候选未入选（条数上限 / 预算不足）' : '关键词未命中') + '</span></span></div>').join('');
        body.push(rows);
        if (d.notRecalled.length > 60) body.push('<div class="ftt-muted">…等 ' + d.notRecalled.length + ' 条</div>');
    }
    return '<div class="ftt-inject-check">' + chip + tools + legend + body.join('\n') + '</div>';
}

/** 面板动作入口（V1 `checkRefresh` / `checkMode`） */
export function injectCheckAction(action, payload) {
    const p = payload || {};
    const a = String(action || '');
    if (a === 'checkMode') { setCheckMode(String(p.mode || 'kw')); return { ok: true, useKeywords: checkState.useKeywords, html: injectCheckPanelHtml() }; }
    if (a === 'checkRefresh' || a === 'refresh') { return { ok: true, html: injectCheckPanelHtml() }; }
    return { ok: false, reason: 'unknown-action' };
}

/** 自查统计（诊断） */
export function injectCheckStats() { return Object.assign({}, checkState); }
