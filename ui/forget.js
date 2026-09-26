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
        section('存储保底 / 上限（防止清理与情节总结把库存打空）',
            ['storeMinAtoms', 'storeMaxAtoms', 'storeMinMemories', 'storeMaxMemories', 'storeMinSnapshots', 'storeMaxSnapshots',
                'storeMinItems', 'storeMaxItems', 'storeMinConcepts', 'storeMaxConcepts'],
            '保底 = 清理不跌破的条数；上限 = 常规裁剪目标。',
            '注入条数上限（分析 / 提取页的 maxAtoms 等）只决定每次注入几条，与库存无关。'),
        section('通用遗忘清扫（概念 / 场景 / 名册 / 计划 / 悬念 / 角色档案）',
            ['lowUseForgetEnabled', 'lowUseForgetRatio', 'lowUseForgetMinItems', 'lowUseForgetMinAvg', 'lowUseForgetMinFloors',
                'lowUseForgetMaxDelete', 'lowUseForgetProtectImportance', 'lowUseForgetEveryFloors'],
            '只清理长期没人用、也没再出现的条目。',
            '重要度高者、场景父节点、名册与档案中调用过的、无楼层信息者不动；移除留记录，跨端不会复活。默认缓慢：长期未现 300 楼 + 每维度每轮 1 条 + 间隔 40 楼。'),
    ].join('\n');
}
