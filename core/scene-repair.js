// ============================================================
// core/scene-repair.js —— **场景修复管道**（B8-6c-2，逐字移植自 V1 `src/modules/09-AI摘要与楼层处理.js`）
//
// 定位（V1 v1.89 场景页专用 · 复用「立即修复」管道）：
//   修正场景树 结构错乱 / 用词不当，走与 `runAutoRepair` 相同的管道（长任务互斥 + `busy.repair` +
//   `callChatCompletion` + 归一/合并 + 通知 + 渲染），按序排队执行（不并发）；提示词独立可编辑
//   （设定-提示词 → ④质检维护 → 场景修复（场景页专用），键 `promptTemplates.sceneRepair`）。
//
// V1 实现要点（本文件逐字对应）：
//   ① `buildSceneRepairPrompt`：**整库场景清单**（`- 名称 ｜ 路径 ｜ 描述`，无数据则「（无场景数据）」）
//      + 模板（`cfg.promptTemplates.sceneRepair` → `defaultCfg` → 内置兜底）+「只输出 JSON，不要解释。」；
//   ② AI 契约：`{"场景库":{"重建":[{"名称","路径","描述"}…]}}`（`normalizeDeltaKeys` 兼容中文键）；
//   ③ `applySceneRebuild`：以 AI 给出的**最终节点列表**为准 —— 归一化（`normalizeScene`）+ 同路径去重
//      + **逐级补全中间层**；路径未变时保留原 `id`/`uses`/`floorSeen`，描述为空时兜底旧描述；
//      返回 `{ ok, list }` 或 `{ ok:false, reason:'empty'|'invalid'|'error' }`；
//   ④ 落库后立刻再跑一次**场景并集归并**（v1.135 升级为「精确同路径 + 相似地名」两级归并，
//      V2 复用既有 `core/ingest.js#scenesUnionMergeAll`），杜绝「纽约 / 纽约市」两套相似分支；
//   ⑤ 通知里的「节点 X → Y」用的是**并集前的** `r.list.length`（V1 原生怪癖，原样保留）。
//
// 适配（与 V1 的差异，逐条见 docs/P8s-B8-6c-2概念与场景修复.md）：
//   ① ESM 化 + 视图注入（state/cfg/saveState/dbgLog/notifyHooks）；
//   ② AI 走注入钩子 `core/ai-hooks.js#aiCallText`（V1 `callChatCompletion` 不移植）；互斥走 `aiBusy()`；
//   ③ V1 的 `pipeStart/pipeUpdate/pipeEnd`/`abortTick`/`newTaskStart`/`renderPanel` 未移植
//      （V2 无任务管线 UI，重绘由 UI 层负责）；
//   ④ `notify(kind, title, text)` 与 `core/repair.js` 既有写法逐字一致（经 `notifyHooks.toast`）；
//   ⑤ `runSceneRepair(opts)` 增设可选 `opts.aiText` 注入点（与 `runRepair`/`runMemoryRepair` 同约定）。
// 一致性由 tests/unit/scene-repair-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { state, cfg, saveState, notifyHooks, dbgLog, warn } from './model/runtime.js';
import { normalizeScene } from './model/dims.js';
import { defaultCfg, normalizeDeltaKeys } from './config.js';
import { extractJsonObject } from './util.js';
import { repairReport } from './repair.js';
import { scenesUnionMergeAll } from './ingest.js';
import { aiCallText, aiBusy } from './ai-hooks.js';

/** 用户提示（经宿主钩子；与 core/repair.js 既有写法一致） */
function notify(kind, title, text) {
    try {
        const msg = [String(title || ''), String(text || '')].filter(Boolean).join(' ');
        if (msg) notifyHooks.toast(msg, String(kind || 'info'));
    } catch (e) { /* 忽略 */ }
}

/** ① 窄契约提示词（V1 `buildSceneRepairPrompt`）：**整库**场景清单（与概念/记忆的「只发高相关组」不同）。
 *  模板取 `cfg.promptTemplates.sceneRepair` → 兜底 `defaultCfg.promptTemplates.sceneRepair` → 兜底内置一句话。
 *  V1 的 try/catch 兜底分支（内联两句固定文案）一并保留。 */
function buildSceneRepairPrompt() {
    try {
        const scenes = state.scenes || [];
        const dump = scenes.length
            ? scenes.map(s => `- ${s.name || ''} ｜ 路径：${s.pathStr || ''} ｜ 描述：${s.desc || ''}`).join('\n')
            : '（无场景数据）';
        const tpl = String((cfg.promptTemplates && cfg.promptTemplates.sceneRepair) || (defaultCfg.promptTemplates && defaultCfg.promptTemplates.sceneRepair) || '').trim()
            || '修正场景树：输出「场景库」的「重建」完整节点列表（名称/路径/描述），修复结构错乱与用词不当。';
        const sysMsg = `${tpl}\n只输出 JSON，不要解释。`;
        const userMsg = [
            '当前场景节点清单：',
            dump,
            '输出：只包含场景树的修正（重建 完整最终列表），不要改动其它维度。',
        ].join('\n');
        return [{ role: 'system', content: sysMsg }, { role: 'user', content: userMsg }];
    } catch (e) { return [{ role: 'system', content: '修正场景树结构错乱与用词，输出「场景库」重建完整节点列表（名称/路径/描述）。' }, { role: 'user', content: '请输出修正后的场景树（JSON）。' }]; }
}

/** ③ 场景全量重建（V1 `applySceneRebuild`）：以 AI 给出的「最终节点列表」为准 ——
 *  归一化 + 同路径去重；逐级补全中间层；路径未变时保留原 `id`/`uses`/`floorSeen`/描述兜底。
 *  @returns {{ok:boolean, list?:Array, reason?:string}} reason ∈ 'empty' | 'invalid' | 'error' */
function applySceneRebuild(rawEntries) {
    try {
        const arr = Array.isArray(rawEntries) ? rawEntries : [];
        if (!arr.length) return { ok: false, reason: 'empty' };
        const byKey = new Map();
        for (const old of (state.scenes || [])) {
            const k = Array.isArray(old.pathArr) ? old.pathArr.join('>') : String(old.pathStr || '');
            if (k) byKey.set(k, old);
        }
        const out = [];
        const seen = new Set();
        const push = (name, pathArr, desc) => {
            const n = normalizeScene({ name, pathArr, desc });
            if (!n) return;
            const k = n.pathStr;
            if (seen.has(k)) return;
            seen.add(k);
            const old = byKey.get(k);
            if (old) { n.id = old.id; n.uses = Number(old.uses) || 0; n.floorSeen = Math.max(n.floorSeen, Number(old.floorSeen) || 0); if (!n.desc && old.desc) n.desc = old.desc; }
            out.push(n);
        };
        for (const e of arr) {
            const ne = normalizeDeltaKeys(e || {});   // 兼容中文键（名称/路径/描述）
            const n = normalizeScene(ne);
            if (!n || !n.pathArr.length) continue;
            push(n.name, n.pathArr, n.desc);
            for (let i = 1; i < n.pathArr.length; i++) { const anc = n.pathArr.slice(0, i); if (!seen.has(anc.join('>'))) push(anc[anc.length - 1], anc, ''); }
        }
        if (!out.length) return { ok: false, reason: 'invalid' };
        return { ok: true, list: out };
    } catch (e) { return { ok: false, reason: 'error' }; }
}

/**
 * 场景修复主流程（V1 `runSceneRepair`，手动按钮；与「立即修复」同管道，互斥 → 按序执行不并发）：
 *   空库 → `{made:0, skipped:true}`；`aiBusy()` → `{made:0, blocked:true}`；
 *   AI 未给出可用「重建」列表 → `{made:0, error:'no-rebuild'}`（数据不变）；
 *   重建结果校验失败 → `{made:0, error:'invalid:<reason>'}`（数据不变）；
 *   成功 → `state.scenes = r.list` → `scenesUnionMergeAll()` → `saveState()` → `{made:1, before, after}`。
 * @param {object} [opts] aiText（V2 注入）
 * @returns {Promise<object>} V1 同形返回结构
 */
async function runSceneRepair(opts) {
    const o = opts || {};
    try {
        const scenes = state.scenes || [];
        if (!scenes.length) { notify('info', '场景修复：暂无场景', '请先通过「AI 摘要」生成场景或手动添加后再修复。'); return { made: 0, skipped: true }; }
        // V1：`busy.repair` 与 `busy.summary || busy.compact || weaveBusy || advanceBusy || syncOcc()` 都返回 blocked；
        //   V2 由宿主 `aiBusy()` 钩子统一表达（与 `core/repair.js#runRepair` 同一写法）。
        if (aiBusy()) { notify('warning', '修复进行中', '已有修复任务在运行，请稍候（本操作会排队等待）。'); return { made: 0, blocked: true }; }
        const beforeCount = scenes.length;
        // V1 `notify('repair', …)` → TOAST_KINDS.repair.type === 'warning'（V2 notifyHooks 只认 info/success/warning/error）
        notify('warning', '开始修复场景结构/用词…', `当前 ${beforeCount} 个场景节点 · 与「立即修复」同一管道按序执行`);
        const prompt = buildSceneRepairPrompt();
        const resp = String(o.aiText != null ? o.aiText : await aiCallText(prompt, '场景修复'));
        // V1 此处**不兜底 `|| {}`**：`extractJsonObject` 失败即 delta 为空值 → 走 no-rebuild 分支
        const delta = normalizeDeltaKeys(extractJsonObject(resp));
        const rebuild = delta && delta.scenes && Array.isArray(delta.scenes.rebuild) ? delta.scenes.rebuild : null;
        if (!rebuild || !rebuild.length) { notify('warning', '场景修复未取得有效结果', 'AI 未返回可用的场景重建列表（场景库/重建），请重试或检查提示词设定。'); return { made: 0, error: 'no-rebuild' }; }
        const r = applySceneRebuild(rebuild);
        if (!r || !r.ok || !r.list || !r.list.length) { notify('warning', '场景修复结果无效', `重建结果校验失败（${(r && r.reason) || 'unknown'}），未作改动。`); return { made: 0, error: 'invalid:' + ((r && r.reason) || '?') }; }
        state.scenes = r.list;
        // v1.113：修复后再做一次重复地址并集（同路径多记录合并，杜绝 纽约 重复层级）
        // v1.135：并集升级为「精确同路径 + 相似地名」两级归并（V2 复用既有 `core/ingest.js#scenesUnionMergeAll`）
        try { scenesUnionMergeAll(); } catch (e) { }
        saveState();
        // 注意（V1 原样）：这里的条数用**并集前的** r.list.length，并集若再合并节点，提示里的数字不会随之更新
        notify('success', '场景修复完成', `节点 ${beforeCount} → ${r.list.length}；名称/路径/描述已按 AI 校正（原 id/使用统计在路径未变时保留）；${repairReport({ before: beforeCount, after: r.list.length, checked: r.list.length, extra: '提交内容＝全库场景重建列表' })}。`);
        try { dbgLog('摘要', { action: '场景修复完成', before: beforeCount, after: r.list.length, nodes: r.list.map(x => x.pathStr) }); } catch (e) { }
        return { made: 1, before: beforeCount, after: r.list.length };
    } catch (e) {
        warn('场景修复失败', e);
        notify('error', '场景修复失败', String((e && e.message) || e).slice(0, 100));
        return { made: 0, error: String((e && e.message) || e) };
    }
}

export { buildSceneRepairPrompt, applySceneRebuild, runSceneRepair };
