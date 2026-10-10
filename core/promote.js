// ============================================================
// core/promote.js —— **通用提升契约**（`docs/D6-维度提升阶梯设计稿.md` §3 / §7 P0）
//
// 定位：把「平行事件 → 情节」这一个特例（V1 v1.166 / v1.196 的 `promoteParallelEvent`）
//   抽成**通用、逐级、可人工确认**的提升入口 `promoteToAtom(source, opts)`。
//   提升 = 人工确认某条衍生条目所描述的事「已经发生」，以它为来源**写入一条情节**（事实锚）——
//   产生新事实，而不是修改旧事实（`docs/D5` A2/M1：衍生层永远不得改写 `atoms` 正文）。
//
// 七个环节（`docs/D6` §3 通用规则；各维度只提供差异）：
//   ① 触发        —— **仅人工**（按钮 / 命令 / 多选批量）；本函数不做任何自动触发（§2.3 P1）
//   ② 前置校验    —— `spec.check`（内容长度 / 必要字段 / 来源是否已提升过）
//   ③ 证据要求    —— 来源条目 id + 剧情日期或楼层（无锚点不允许提升）
//   ④ 字段映射    —— `spec.map`（生成 `atoms` 草稿；`text` 必填，其余尽力填）
//   ⑤ 写入        —— `core/entries.js#upsertEntry('atoms', raw)`（复用既有落库与墓碑口径）
//   ⑥ 原条处置    —— `spec.disposition`：`removed`（移除 + 墓碑）/ `promoted`（保留 + 标 `promotedTo`）/ `kept`
//   ⑦ 留痕与审计  —— `promotedTo` / `promotedAt` 写在来源条上；审计走 `spec.audit`
//
// **P0 口径（本版）**：**纯重构** —— `parallels` 一条路径**行为逐字不变**（黄金样本与冒烟零变化）。
//   · 唯一接线的维度是 `parallels`（`wired: true`）；其余 8 个开放维度的映射与处置按 `docs/D6` §7
//     的 **P1（一级直提）/ P2（传言二级阶梯）/ P4（可选维度）** 逐个接线，未接线的维度**如实拒绝**，
//     不静默降级、不假装支持。
//   · `derived-from` 边与 `sourceRefs` 属 `docs/D6` §5 的关系层容器（`docs/D22` `业-1` 未落地），P0 不写入。
//   · 平行路径**不写调试日志**（`spec.audit = null`）以保持 V1 行为逐字不变；§3 环节 7 的审计
//     随 P1 为**新**维度启用。
//
// 一致性：`tests/unit/promote-contract.test.js`（通用契约与规格表）＋
//   `tests/unit/parallel-golden.test.js` P 组（平行路径与真实 V1 oracle 逐字一致）。
// ============================================================
import { state, saveState, warn, getStoryNow } from './model/runtime.js';
import { normalizeList } from './util.js';
import { mergeTags } from './model/scalars.js';
import { upsertEntry, deleteEntry } from './entries.js';
import { tombEntry } from './merge.js';

/** 原子层正文最小长度（`docs/D6` §3 环节 2；V1 `promoteParallelEvent` 逐字沿用） */
const ATOM_MIN_TEXT = 8;

/**
 * 逐维提升规格表（`docs/D6` §4 的 14 维度规格表，逐行对应）。
 *
 * | 字段 | 口径 |
 * | --- | --- |
 * | `open` | `docs/D6` §4 裁决**是否开放提升**（设计事实；14 维全覆盖） |
 * | `wired` | 本版是否**已接线**（P0 只有 `parallels`；其余按 §7 P1/P2/P4 落地） |
 * | `phase` | 该维度归属的落地阶段（`docs/D6` §7） |
 * | `disposition` | 默认原条处置：`removed` / `promoted` / `kept`（§8.2 Q2 裁决） |
 * | `condition` | 人工确认时展示的**提升条件** |
 * | `check` / `map` | 环节 ② / ④ 的逐维差异（未接线维度不提供） |
 * | `audit` | 环节 ⑦ 的审计出口（`null` = 不写；平行路径保持 V1 行为不变） |
 */
export const PROMOTE_SPECS = {
    // ---------- 不适用 / 不开放 / 不参与（`docs/D6` §4；一律如实拒绝） ----------
    atoms: { open: false, reason: '情节已是事实锚 —— 需要的是编辑，不是提升' },
    snapshots: { open: false, reason: '角色档案是持续状态而非事件，不开放提升' },
    links: { open: false, reason: '关联层是认知元信息而非事件，不开放提升' },
    currencies: { open: false, reason: '货币是独立账本，不参与提升' },
    plotSegments: { open: false, reason: '分段总结只归档不注入，不参与提升' },

    // ---------- 一级直提（`docs/D6` §7 P1；`promoted` 处置） ----------
    currentStates: { open: true, wired: false, phase: 'P1', disposition: 'promoted', label: '状态记录', condition: '状态被事实固定（如「左臂骨折」）且已稳定若干轮' },
    memories: { open: true, wired: false, phase: 'P1', disposition: 'promoted', label: '长期记忆', condition: '记忆已被事实支撑（有日期 / 有来源情节）' },
    items: { open: true, wired: false, phase: 'P1', disposition: 'promoted', label: '物品', condition: '物品的获得 / 失去 / 转移已发生' },
    plans: { open: true, wired: false, phase: 'P1', disposition: 'promoted', label: '计划', condition: '计划到达终态（完成 / 受阻 / 放弃）' },
    suspense: { open: true, wired: false, phase: 'P1', disposition: 'promoted', label: '悬念', condition: '悬念揭晓（`resolveCondition` 满足）' },

    // ---------- 二级阶梯（`docs/D6` §7 P2；传言先落推演再转事实） ----------
    rumors: { open: true, wired: false, phase: 'P2', disposition: 'promoted', label: '传言', condition: '传言被证实' },

    // ---------- 可选 · 低优先（`docs/D6` §7 P4） ----------
    scenes: { open: true, wired: false, phase: 'P4', disposition: 'promoted', label: '场景', condition: '场景确立 / 转移作为事实' },
    concepts: { open: true, wired: false, phase: 'P4', disposition: 'promoted', label: '概念', condition: '概念被确认为设定事实' },

    // ---------- 现有通道（P0 唯一接线；行为逐字沿用 V1 v1.166 / v1.196） ----------
    parallels: {
        open: true, wired: true, phase: 'P0', disposition: 'removed', label: '平行事件',
        condition: '人工确认该推演已成事实',
        notFoundReason: '未找到该平行事件',
        removeWarn: '转正后移除平行记录失败',
        catchReason: '转正异常',
        placeholder: '情节',
        /** 环节 ②：正文 ≥8 字，过短时用标题补足（标题本身不重复进正文） */
        check: (src, o) => {
            const title0 = String(src.title || '').trim();
            let text = String((o && o.text) || src.text || '').trim();
            if (text.length < ATOM_MIN_TEXT && title0 && title0 !== text) text = `${title0}：${text}`.replace(/：$/, '').trim();
            if (text.length < ATOM_MIN_TEXT) return { ok: false, reason: '内容过短：情节正文需 ≥8 字（请先补全平行事件描述）' };
            return { ok: true, text };
        },
        /** 环节 ④：平行事件 → 情节草稿（`docs/D6` §1 字段映射，逐字沿用 V1） */
        map: (src, o, ctx) => {
            const text = String(ctx.text || '');
            const title = String(src.title || '').trim();
            const date = String(src.date || '').trim();
            const prevAtom = ctx.prevAtom;
            return {
                title: (title && title !== text) ? title : '',
                text,
                type: String(src.type || '').trim() || '转折',
                date: date || (prevAtom ? String(prevAtom.date || '') : ''),
                time: String(src.time || '').trim(),
                entities: normalizeList(src.characters),
                locations: src.location ? [String(src.location).trim()] : [],
                tags: mergeTags(Array.isArray(src.tags) ? src.tags.slice(0, 5) : [], []),
                importance: Number(src.importance) || 0.6,
            };
        },
        /** 环节 ⑦：V1 的平行转正**不写调试日志** → 保持行为不变（新维度在 P1 起启用审计） */
        audit: null,
    },
};

/** 规格表覆盖的维度键（便于测试与诊断逐条核对 `docs/D6` §4） */
export function promoteSpecDims() { return Object.keys(PROMOTE_SPECS); }

/** 已接线（`wired`）的维度键 */
export function promoteWiredDims() {
    return Object.keys(PROMOTE_SPECS).filter(k => PROMOTE_SPECS[k] && PROMOTE_SPECS[k].wired);
}

/**
 * **通用提升入口**（`docs/D6` §3 七环节）。
 *
 * @param {{dim:string, id:string}|string} source 来源（`{dim, id}`；也接受裸 id + `opts.dim`）
 * @param {{text?:string, at?:string, dim?:string, id?:string}} [opts] 可覆盖正文与提升时间（落 `promotedAt`）
 * @returns {{ok:boolean, atomId?:string, updated?:boolean, removed?:boolean, promotedAt?:string, reason?:string}}
 */
export function promoteToAtom(source, opts) {
    let spec = null;
    try {
        const o = opts || {};
        const dim = String((source && source.dim) || o.dim || '').trim();
        const id = String((source && source.id) || o.id || '').trim();
        spec = PROMOTE_SPECS[dim] || null;
        // 环节 ①：维度必须存在且「开放 + 已接线」，否则如实拒绝（不静默降级）
        if (!spec) return { ok: false, reason: '未知维度：' + (dim || '(空)') };
        if (!spec.open) return { ok: false, reason: spec.reason || '该维度不开放提升' };
        if (!spec.wired) return { ok: false, reason: `${spec.label || dim}的提升通道尚未落地（docs/D6 §7 ${spec.phase || 'P1'}）` };
        // 环节 ③：来源必须存在（证据锚点 = `{dim, id}`）
        const list = Array.isArray(state[dim]) ? state[dim] : [];
        const src = list.find(x => x && String(x.id) === id);
        if (!src) return { ok: false, reason: spec.notFoundReason || '未找到来源条目' };
        // 环节 ②：逐维前置校验
        const pre = spec.check ? spec.check(src, o, state) : { ok: true };
        if (!pre || !pre.ok) return { ok: false, reason: (pre && pre.reason) || '前置校验未通过' };
        // 幂等键 `source: {dim, id}`：同一来源二次提升 → 更新上次生成的那条情节（§3 幂等键）
        const prevId = String(src.promotedTo || '').trim();
        const prevAtom = prevId ? (state.atoms || []).find(x => x && String(x.id) === prevId) : null;
        // 环节 ④：字段映射
        const ctx = { text: pre.text, dim: dim, prevAtom: prevAtom };
        const raw = spec.map ? spec.map(src, o, ctx) : null;
        if (!raw) return { ok: false, reason: '字段映射失败' };
        if (prevAtom) raw.id = prevAtom.id;                       // 幂等：原地更新既有情节
        // 环节 ⑤：写入（复用既有落库与墓碑口径）
        if (!upsertEntry('atoms', raw)) return { ok: false, reason: '情节写入失败' };
        const hit = ((state.atoms) || []).slice().reverse().find(x => x && String(x.text || '').trim() === String(ctx.text) && (!raw.id || String(x.id) === String(raw.id)));
        const atomId = hit ? String(hit.id) : (raw.id || prevId || '');
        // 环节 ⑦：留痕（先写 `promotedTo` / `promotedAt`，供本次调用与迁移判断）
        src.promotedTo = atomId || spec.placeholder || '情节';
        let at = String(o.at || '').trim();
        // ⚠ V1 怪癖逐字保留：`(getStoryNow() || {}).date` —— V1/V2 的 `getStoryNow()` 返回**字符串**，
        //   取其 `.date` 恒为 undefined → 实际总是回落到 `state.state.date`。
        if (!at) { try { at = String((typeof getStoryNow === 'function' ? (getStoryNow() || {}).date : '') || (state.state && state.state.date) || ''); } catch (e) { at = ''; } }
        src.promotedAt = at || src.promotedAt || '';
        src.updatedAt = Date.now();
        // 环节 ⑥：原条处置（`removed` = 移除 + 墓碑；`promoted` = 保留 + 已标 `promotedTo`；`kept` = 原样保留）
        let removed = false;
        if (spec.disposition === 'removed') {
            try {
                const before = (state[dim] || []).length;
                if (typeof deleteEntry === 'function') removed = !!deleteEntry(dim, src.id);
                else {
                    // ⚠ V1 该兜底分支在真实路径上**不可达**（`deleteEntry` 恒为函数）；逐字保留以备移植对照
                    state[dim] = (state[dim] || []).filter(x => !(x && String(x.id) === String(src.id)));
                    try { tombEntry(dim, src); } catch (e) { /* 忽略 */ }
                    removed = (state[dim] || []).length < before;
                }
            } catch (e) { warn(spec.removeWarn || '提升后移除来源记录失败', e); }
        }
        saveState();
        if (typeof spec.audit === 'function') {
            try { spec.audit({ dim: dim, id: id, atomId: src.promotedTo, updated: !!prevAtom, removed: removed }, spec); } catch (e) { /* 忽略 */ }
        }
        return { ok: true, atomId: src.promotedTo, updated: !!prevAtom, removed: removed, promotedAt: src.promotedAt };
    } catch (e) {
        return { ok: false, reason: (spec && spec.catchReason) || '提升异常' };
    }
}
