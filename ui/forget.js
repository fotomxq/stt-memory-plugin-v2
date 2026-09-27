// ============================================================
// ui/forget.js —— **遗忘设定页**（B8-5；结构与文案对齐 V1 `13-UI-设置与存储开关.js` forget 页）
// V1 五分节：状态记录衰退（只按剧情日期）/ 记忆遗忘机制（只按剧情日期）/ 存储保底·上限 / 通用遗忘清扫 / 平行事件衰退已移走。
// 说明：V1 的遗忘是**自动**行为（剧情日期推进 → 状态衰退；记忆写入 → 3s 防抖遗忘；通用清扫在「自动修复」管线内执行），
//   V1 该页只有开关与阈值、没有手动按钮；V2 额外提供一行只读诊断（当前条数/上限/冷却），便于自查「为什么没清」。
//
// v2.57.0（用户要求：「避免罗嗦的提示信息，展示内容必须言简意赅、一目了然；扩展提示信息应通过 UI 交互展示，
//   避免挤占 UI」）：每节只留**一句**短提示；详细解释与「参数含义」放进默认折叠的「ⓘ 说明」（`ui/hints.js`），
//   单个控件的说明同时作为悬停提示（`hint` 字段）；删掉跨页指路行（平行衰退 / 情节总结的去处）。
// ============================================================
import { settingsControlHtml } from './settings-pages.js';
import { hintDetailsHtml, paramListHtml, shortHintHtml } from './hints.js';
import { forgetState } from '../core/forget.js';
// v2.84.0（用户要求）：存储上限改为「总上限 + 各大类占比（滚动条拖动，动态满足 100%）」
import {
    storeEffectiveCaps, storeShareDefault, storeTotalMax, storeMinFor, STORE_LIMITS, STORE_SHARE_DIMS, STORE_TOTAL_MAX_DEFAULT,
} from '../core/ingest.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 遗忘页正文（V1 四分节 + V2 只读诊断行；每节 = 一句短提示 + 控件 + 折叠说明） */
export function forgetPageHtml(controls) {
    const list = Array.isArray(controls) ? controls : [];
    const find = (k) => list.filter((c) => String(c.key) === k)[0];
    const rows = (keys) => keys.map((k) => { const c = find(k); return c ? settingsControlHtml(c) : ''; }).filter(Boolean).join('\n');
    const st = (() => { try { return forgetState(); } catch (e) { return null; } })();
    const diag = st
        ? ('状态记录 ' + Number((st.stateDecay || {}).states || 0) + '/' + Number((st.stateDecay || {}).cap || 0)
            + ' · 长期记忆 ' + Number((st.memoryForget || {}).memories || 0) + '/' + Number((st.memoryForget || {}).cap || 0)
            + '（保底 ' + Number((st.memoryForget || {}).floor || 0) + '）'
            + ' · 清扫：上次第 ' + Number((st.lowUse || {}).lastFloor || 0) + ' 楼 / 当前第 ' + Number((st.lowUse || {}).now || 0) + ' 楼'
            + ((st.lowUse || {}).gateOk ? '（可清扫）' : ('（还需 ' + Number((st.lowUse || {}).wait || 0) + ' 楼）')))
        : '';
    /** 一节：标题 + 一句话 + 控件 + 折叠说明（说明里的参数清单由控件的 hint 自动生成） */
    const section = (title, keys, line, detail) => {
        const picked = keys.map((k) => find(k)).filter(Boolean);
        return [
            '<div class="ftt-section"><div class="ftt-sec-title">' + esc(title) + '</div>',
            shortHintHtml(line),
            rows(keys),
            hintDetailsHtml('说明', esc(detail) + paramListHtml(picked)),
            '</div>',
        ].join('\n');
    };
    return [
        '<div class="ftt-hint" data-ftt-forget-state>当前：' + esc(diag) + '</div>',
        section('状态记录衰退（只按剧情日期）',
            ['stateDecayEnabled', 'stateDecayRatio', 'stateDecayCutoff', 'stateDecaySubjectYears', 'stateDecayStaleYears',
                'stateRepairBatch', 'stateRepairMatchSim'],
            '按剧情日期老化；没有剧情时钟就不会衰退。',
            '久未出现或失效的状态达到阈值自动移除；角色停更超过年限则整组删除其状态。状态修复（状态页「🔧 修复状态」）先按档案匹配主体，再做机械清理，最后交 AI 整理。'),
        section('记忆遗忘机制（只按剧情日期）',
            ['memoryForgetEnabled', 'memoryForgetRatio', 'memoryForgetCutoff'],
            '重要性低于均值的旧记忆按剧情日期渐进遗忘。',
            '记忆被 AI 再次写入即刷新（等于想起）；达到阈值才移除，且不会跌破保底。'),
        section('存储总上限与各大类占比（防止清理与情节总结把库存打空）',
            ['storeTotalMax', 'storeMinAtoms', 'storeMinMemories', 'storeMinSnapshots', 'storeMinItems', 'storeMinConcepts'],
            '总上限 = 合计条数；各大类按占比分配，拖动即自动配平到 100%。',
            '某大类有效上限 = 四舍五入(总上限 × 占比 ÷ 100)，且不低于该维保底；合计恒等于总上限（占比合计恒为 100%）。'
            + '注入条数上限（分析 / 提取页的 maxAtoms 等）只决定每次注入几条，与库存无关。'),
        storeShareSectionHtml(),
        section('通用遗忘清扫（概念 / 场景 / 名册 / 计划 / 悬念 / 角色档案）',
            ['lowUseForgetEnabled', 'lowUseForgetRatio', 'lowUseForgetMinItems', 'lowUseForgetMinAvg', 'lowUseForgetMinFloors',
                'lowUseForgetMaxDelete', 'lowUseForgetProtectImportance', 'lowUseForgetEveryFloors'],
            '只清理长期没人用、也没再出现的条目。',
            '重要度高者、场景父节点、名册与档案中调用过的、无楼层信息者不动；移除留记录，跨端不会复活。默认缓慢：长期未现 300 楼 + 每维度每轮 1 条 + 间隔 40 楼。'),
    ].join('\n');
}

/**
 * 「各大类占比」滚动条区（v2.84.0，用户要求）：
 *   · 每维一条 `input[type=range]`（0-100，步进 1），**拖动任一条，其余按原比例自动补齐**，合计恒为 100%；
 *   · 右侧实时读数 = 「占比% · ≈N 条」（N = 四舍五入(总上限 × 占比 ÷ 100)，四舍五入口径与内核一致）；
 *   · 滚动条上的**浅色刻度 = 该维默认占比位置**，右侧文字给出「默认 x% · 保底 M」；
 *   · 合计行如实显示「合计 100% · ≈总条数」，若与总上限不一致（异常数据）会红字提示。
 */
export function storeShareSectionHtml() {
    let eff = null;
    try { eff = storeEffectiveCaps(); } catch (e) { eff = null; }
    const total = (() => { try { return storeTotalMax(); } catch (e) { return STORE_TOTAL_MAX_DEFAULT; } })();
    const shares = (eff && eff.shares) || {};
    const caps = (eff && eff.caps) || {};
    const sumPct = STORE_SHARE_DIMS.reduce((n, d) => n + Number(shares[d] || 0), 0);
    const sumCap = STORE_SHARE_DIMS.reduce((n, d) => n + Number(caps[d] || 0), 0);
    const rows = STORE_SHARE_DIMS.map((dim) => {
        const label = String((STORE_LIMITS[dim] || [])[3] || dim);
        const pct = Number(shares[dim] || 0);
        const def = (() => { try { return storeShareDefault(dim); } catch (e) { return 0; } })();
        const floor = (() => { try { return storeMinFor(dim); } catch (e) { return 0; } })();
        return '<div class="ftt-field ftt-field-range" data-ftt-share-row="' + esc(dim) + '">'
            + '<label>' + esc(label) + '</label>'
            + '<input type="range" data-ftt-share="' + esc(dim) + '" min="0" max="100" step="1" value="' + esc(pct) + '"'
            + ' style="--ftt-range-def:' + esc(Math.max(0, Math.min(100, Math.round(def)))) + '%"'
            + ' title="拖动后其余大类按原比例自动补齐，合计恒为 100%">'
            + '<output class="ftt-range-out" data-ftt-share-out="' + esc(dim) + '">' + esc(pct) + '% · ≈' + esc(Number(caps[dim] || 0)) + ' 条</output>'
            + '<span class="ftt-muted ftt-range-def">默认 ' + esc(def) + '% · 保底 ' + esc(floor) + ' 条</span></div>';
    }).join('\n');
    const warn = (sumPct === 100)
        ? ''
        : ('<div class="ftt-hint">⚠️ 占比合计为 ' + esc(sumPct) + '%（应为 100%）—— 拖动任一滚动条即会重新配平。</div>');
    return [
        '<div class="ftt-section" data-ftt-section="store-share">',
        '<div class="ftt-sec-title">各大类占比 <span class="ftt-muted">拖动任一维，其余按比例自动补齐</span></div>',
        '<div class="ftt-hint">合计 <b>' + esc(sumPct) + '%</b> · 有效上限合计 ≈ ' + esc(sumCap) + ' 条（总上限 ' + esc(total) + ' 条）</div>',
        warn,
        rows,
        '</div>',
    ].join('\n');
}
