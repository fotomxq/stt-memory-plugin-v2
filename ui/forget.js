// ============================================================
// ui/forget.js —— **遗忘设定页**（B8-5；结构与文案对齐 V1 `13-UI-设置与存储开关.js` forget 页）
// V1 五分节：状态记录衰退（只按剧情日期）/ 记忆遗忘机制（只按剧情日期）/ 存储保底·上限 / 通用遗忘清扫 / 平行事件衰退已移走。
// 说明：V1 的遗忘是**自动**行为（剧情日期推进 → 状态衰退；记忆写入 → 3s 防抖遗忘；通用清扫在「自动修复」管线内执行），
//   V1 该页只有开关与阈值、没有手动按钮；V2 额外提供一行只读诊断（当前条数/上限/冷却），便于自查「为什么没清」。
// ============================================================
import { settingsControlHtml } from './settings-pages.js';
import { forgetState } from '../core/forget.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 遗忘页正文（V1 五分节 + V2 只读诊断行） */
export function forgetPageHtml(controls) {
    const list = Array.isArray(controls) ? controls : [];
    const find = (k) => list.filter((c) => String(c.key) === k)[0];
    const rows = (keys) => keys.map((k) => { const c = find(k); return c ? settingsControlHtml(c) : ''; }).filter(Boolean).join('\n');
    const st = (() => { try { return forgetState(); } catch (e) { return null; } })();
    const diag = st
        ? ('状态记录 ' + Number((st.stateDecay || {}).states || 0) + ' / 上限 ' + Number((st.stateDecay || {}).cap || 0)
            + ' · 长期记忆 ' + Number((st.memoryForget || {}).memories || 0) + ' / 上限 ' + Number((st.memoryForget || {}).cap || 0)
            + ' / 保底 ' + Number((st.memoryForget || {}).floor || 0)
            + ' · 清扫冷却：上次第 ' + Number((st.lowUse || {}).lastFloor || 0) + ' 楼 / 当前第 ' + Number((st.lowUse || {}).now || 0) + ' 楼'
            + ((st.lowUse || {}).gateOk ? '（本轮可清扫）' : ('（还需 ' + Number((st.lowUse || {}).wait || 0) + ' 楼）')))
        : '';
    return [
        '<div class="ftt-hint" data-ftt-forget-state>当前：' + esc(diag) + '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">状态记录衰退（只按剧情日期）</div>',
        rows(['stateDecayEnabled', 'stateDecayRatio', 'stateDecayCutoff', 'stateDecaySubjectYears', 'stateDecayStaleYears']),
        '<div class="ftt-muted">按剧情日期老化：无剧情时钟不衰退；久未出现或失效的状态达阈值自动移除，角色停更超年限整组移除。</div>',
        '<div class="ftt-muted">状态修复（状态页「🔧 修复状态」）：自动匹配角色（对不上档案/名册/主角/在场的主体整组删除）→ 机械清理与字段规范化 → 抽取交 AI 修复整理。</div>',
        rows(['stateRepairBatch', 'stateRepairMatchSim']),
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">记忆遗忘机制（只按剧情日期）</div>',
        rows(['memoryForgetEnabled', 'memoryForgetRatio', 'memoryForgetCutoff']),
        '<div class="ftt-muted">再次被 AI 写入即刷新（想起）；只按剧情日期，重要性低于均值的旧记忆渐进遗忘，达阈值移除（不跌破保底）。</div>',
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">存储保底 / 上限（防止清理与情节总结把库存打空）</div>',
        rows(['storeMinAtoms', 'storeMaxAtoms', 'storeMinMemories', 'storeMaxMemories', 'storeMinSnapshots', 'storeMaxSnapshots', 'storeMinItems', 'storeMaxItems', 'storeMinConcepts', 'storeMaxConcepts']),
        '<div class="ftt-muted">保底 = 自动机制不跌破的条数；上限 = 常规裁剪目标。注入条数上限（分析/提取页的 maxAtoms 等）只决定每次注入几条，与库存无关。</div>',
        '</div>',

        '<div class="ftt-section"><div class="ftt-sec-title">通用遗忘清扫（概念 / 场景 / 名册 / 计划 / 悬念 / 角色档案）</div>',
        rows(['lowUseForgetEnabled', 'lowUseForgetRatio', 'lowUseForgetMinItems', 'lowUseForgetMinAvg', 'lowUseForgetMinFloors', 'lowUseForgetMaxDelete', 'lowUseForgetProtectImportance', 'lowUseForgetEveryFloors']),
        '<div class="ftt-muted">只清理长期没人用、也没再出现的条目；重要度高者、场景父节点、名册与档案中调用过的、无楼层信息者不动；移除留墓碑（跨端不复活）。默认缓慢处理：长期未现 300 楼 + 每维度每轮 1 条 + 清扫间隔 40 楼。</div>',
        '</div>',

        '<div class="ftt-muted">📌 平行事件衰退设置已移至「平行」子页；情节总结（半自动）设置在「提示词」子页底部。</div>',
    ].join('\n');
}
