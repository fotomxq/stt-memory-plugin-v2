// ============================================================
// core/state-slots.js —— **存档顶层槽位登记表（单一事实源）**（v3.44.0，`docs/D22` **W4** `数-15`）
//
// 设计依据：`docs/D20` §3.4 / §8 `数-15` ——
//   事实：「空转功能位：`protagonist` 等字段存在但无接线」；
//   步骤：「对 `protagonist` 等逐项判定：**接线** 或 **从界面移除并标注「未启用」**（二选一，
//   不留"看起来能用实际无效"的位置）」；
//   验收：「`state` 里每个保留字段都有明确归属与出口说明」。
//
// 本轮把「验收」**机械化**了：`state` 的每个顶层键必须在本表里登记（`tests/unit/state-slots.test.js`
//   双向核对 `emptyState()` 的键集与本表的键集），新增槽位若不登记 → 测试红 + 体检报
//   `state-slot-unregistered`。**「有明确归属与出口说明」不再是靠人记的约定。**
//
// 逐项核实结果（本轮只读核对全仓读写点；`disposition` 就是判定）：
//   · `wired`    —— 有写入路径、有出口，正常在用；
//   · `reserved` —— **保留但未接线**：没有写入路径（或只有 best-effort 读取）→ 明确标注「未启用」；
//   · `legacy`   —— 语义已被新容器取代，仅为兼容旧存档与跨端判定而保留。
//
// 为什么 `reserved` 三项选择「**标注**」而不是「**接线**」（`docs/D20` 给的是二选一）：
//   · `protagonist`：读它的是 4 处 best-effort 的「已知角色名提示」（`core/model/money.js` /
//     `core/currency-repair.js` / `core/state-repair.js` / `core/rel-maint.js`），缺失即跳过、无副作用。
//     「谁是主角」**无法从数据机械判定**（AI 输出里没有这个字段，UI 也没有控件）→ 接线等于**新造一个
//     用户可见能力**（要有 AI 字段或设定控件），超出本批「无前置」的范围；而它是**恒为空对象**、
//     既不占体积也不产生行为，故如实标注即可。
//   · `varTemplates` / `summaries` / `sceneFocus`：三者**在任何界面都不出现**（全仓无渲染点），
//     「从界面移除」无从做起；它们唯一的可观测影响是 `core/cross-sync.js` 的容器名单与聚合判定。
//     删除它们会改变**跨端合并口径**（属 `docs/D15` §3 类别① 数据契约）→ 本批不动，**登记为保留/遗留**。
//   · 另有 `cfg.protagonistName` 这一处**死读**（`core/rel-maint.js` 读它，但该键**不在** `defaultCfg`、
//     无任何控件可写）→ 一并登记在 `RESERVED_CFG_READS`，体检的 `state-slot-reserved` 会如实列出。
// ============================================================
import { emptyState } from './state.js';

/**
 * 存档顶层槽位登记表。
 * `wired`：是否有**写入路径**（`false` = 只被读、或连读都没有）；
 * `outlets`：读取出口（谁在用；`wired:false` 时写明「谁读了它 / 是否只做 best-effort」）。
 */
export const STATE_SLOTS = Object.freeze({
    version: { label: '存档版本戳', semantics: '迁移与兼容判定用的版本号', wired: true, outlets: ['core/migrate.js'], disposition: 'wired' },
    scope: { label: '作用域键', semantics: 'char:<hash>，本存档属于哪个角色', wired: true, outlets: ['core/state.js', 'adapters/envelope.js'], disposition: 'wired' },
    state: { label: '剧情时钟与在场名单', semantics: 'time / date / location / sceneFocus', wired: true, outlets: ['core/clock*.js', 'core/ingest.js'], disposition: 'wired' },
    protagonist: { label: '主角', semantics: '主角档案（V1 遗留容器；只被当作「已知角色名」的 best-effort 提示）', wired: false, outlets: ['core/model/money.js', 'core/currency-repair.js', 'core/state-repair.js', 'core/rel-maint.js'], disposition: 'reserved' },
    items: { label: '物品库', semantics: '物品条目', wired: true, outlets: ['core/ingest.js', 'ui/panel.js'], disposition: 'wired' },
    plans: { label: '计划库', semantics: '未执行的打算（open/closed）', wired: true, outlets: ['core/ingest.js', 'core/plan-aging.js', 'ui/panel.js'], disposition: 'wired' },
    suspense: { label: '悬念库', semantics: '未揭晓的疑问（open/closed）', wired: true, outlets: ['core/ingest.js', 'core/plan-aging.js', 'ui/panel.js'], disposition: 'wired' },
    scenes: { label: '场景库', semantics: '分层场景树节点', wired: true, outlets: ['core/ingest.js', 'ui/scene-tree.js'], disposition: 'wired' },
    npcs: { label: '名册', semantics: '**遗留容器**：角色名册已并入 `snapshots`（载入期迁移清空）', wired: false, outlets: ['core/migrate.js（清空）', 'core/cross-sync.js（容器名单）', 'core/data-health.js（扫描面）'], disposition: 'legacy' },
    atoms: { label: '情节库', semantics: '已发生的事实条目', wired: true, outlets: ['core/ingest.js', 'core/recall.js', 'ui/panel.js'], disposition: 'wired' },
    currentStates: { label: '状态记录', semantics: '主体 × 字段 的当前值', wired: true, outlets: ['core/ingest.js', 'ui/panel.js'], disposition: 'wired' },
    snapshots: { label: '角色档案', semantics: '角色档案（含已并入的名册）', wired: true, outlets: ['core/model/snapshot.js', 'ui/panel.js'], disposition: 'wired' },
    memories: { label: '记忆库', semantics: '角色持有的记忆', wired: true, outlets: ['core/ingest.js', 'core/recall.js'], disposition: 'wired' },
    concepts: { label: '概念库', semantics: '客观存在的理念/发现', wired: true, outlets: ['core/ingest.js', 'ui/panel.js'], disposition: 'wired' },
    parallels: { label: '平行事件', semantics: '正文之外的推演事件', wired: true, outlets: ['core/parallel.js', 'ui/panel.js'], disposition: 'wired' },
    currencies: { label: '货币库', semantics: '持有者 × 币种 × 额度 + 收支流水', wired: true, outlets: ['core/model/money.js', 'ui/panel.js'], disposition: 'wired' },
    plotSegments: { label: '分段总结', semantics: '按剧情时间归档的分段总结（只归档不注入）', wired: true, outlets: ['core/plot-segment.js', 'ui/panel.js'], disposition: 'wired' },
    rumors: { label: '传言库', semantics: '主体 + 当前说法 + 传播链路', wired: true, outlets: ['core/model/rumor.js', 'core/rumor-evolve.js'], disposition: 'wired' },
    links: { label: '关联层', semantics: '条目 ↔ 角色的知情关联行', wired: true, outlets: ['core/model/rel.js', 'core/rel-maint.js', 'ui/rel-table.js'], disposition: 'wired' },
    vars: { label: '变量', semantics: '作用域变量（global/char/chat）', wired: true, outlets: ['core/model/scalars.js', 'ui/panel.js'], disposition: 'wired' },
    varTemplates: { label: '变量模板', semantics: '**保留未启用**：只有 `emptyState` 与跨端容器名单提到它，全仓无写入点、无渲染点', wired: false, outlets: ['core/cross-sync.js（整侧取较新名单）'], disposition: 'reserved' },
    summaries: { label: '摘要（旧）', semantics: '**遗留容器**：被 `plotSegments` 取代；仅供 `core/sync.js` 判「对端是否有数据」与跨端签名使用', wired: false, outlets: ['core/cross-sync.js（签名/容器名单）', 'core/sync.js（对端非空判定）'], disposition: 'legacy' },
    processedFloors: { label: '已处理楼层台账', semantics: '已分析楼层的 {f,h} 标记', wired: true, outlets: ['core/ingest.js', 'core/read-ledger.js'], disposition: 'wired' },
    lastKnownFloor: { label: '最近已分析楼层', semantics: '断裂检测基线（-1 = 未知）', wired: true, outlets: ['core/ingest.js', 'core/clock-patrol.js'], disposition: 'wired' },
    processedDropped: { label: '丢弃留痕台账', semantics: '被丢弃的台账标记（有界）', wired: true, outlets: ['core/read-ledger.js'], disposition: 'wired' },
    lastChatFloor: { label: '末见聊天楼层', semantics: '拆楼检测基线（可回落）', wired: true, outlets: ['core/floor-trim.js', 'core/ingest.js'], disposition: 'wired' },
    chatKey: { label: '当前聊天标识', semantics: '宿主注入的当前聊天键（条目归属的写入源）', wired: true, outlets: ['core/chat-scope.js', 'core/entry-meta.js'], disposition: 'wired' },
    stats: { label: '累计统计', semantics: 'plansClosed / suspenseResolved', wired: true, outlets: ['core/ingest.js', 'core/entries.js'], disposition: 'wired' },
    deleted: { label: '删除墓碑', semantics: '{ dim: { id: 删除时间ms } }（跨端不复活）', wired: true, outlets: ['core/merge.js', 'core/cross-sync.js'], disposition: 'wired' },
    deletedH: { label: '内容哈希墓碑', semantics: '{ dim: { 内容哈希: 删除时间ms } }', wired: true, outlets: ['core/merge.js', 'core/cross-sync.js'], disposition: 'wired' },
    updatedAt: { label: '存档更新时间', semantics: '墙钟毫秒；跨端取较新的依据', wired: true, outlets: ['core/cross-sync.js'], disposition: 'wired' },
});

/**
 * `state` 容器**内部**槽位登记（顶层登记表的一个下钻层；`数-15` 的「逐项判定」同样适用于它们）。
 * 键集由 `grep 'state\.state\.[A-Za-z_$]+ *='` 全仓实测得出（`core/clock*.js` / `core/ingest.js` /
 * `core/migrate.js`），不是凭印象列的。**这里只放 `emptyState()` 声明过的键**；
 * 运行期才写进去的（`present` / `clockSrc` / `clockManual` / `storyDay`）见 `STATE_INNER_RUNTIME_SLOTS`。
 */
export const STATE_INNER_SLOTS = Object.freeze({
    time: { label: '剧情时刻', semantics: '如「夜」/「黄昏」', wired: true, outlets: ['core/clock*.js'], disposition: 'wired' },
    date: { label: '剧情日期', semantics: 'YYYY-MM-DD', wired: true, outlets: ['core/clock*.js'], disposition: 'wired' },
    location: { label: '当前地点', semantics: '剧情发生地', wired: true, outlets: ['core/clock*.js', 'ui/scene-tree.js'], disposition: 'wired' },
    sceneFocus: { label: '场景聚焦', semantics: '**保留未启用**：只有 `emptyState` 写过它，全仓无读取点、无写入点', wired: false, outlets: ['（无）'], disposition: 'reserved' },
});

/**
 * `state` 容器内部的**运行期**槽位（`emptyState()` 不声明，但生产代码会写）。
 * 与顶层 `RUNTIME_SLOTS` 同一纪律：不登记就会天天报噪声，而**报噪声的检查等于没有检查**。
 */
export const STATE_INNER_RUNTIME_SLOTS = Object.freeze({
    present: { label: '在场名单', evidence: 'core/clock-extract.js（正文匹配出的在场角色）', disposition: 'runtime' },
    clockSrc: { label: '时钟来源', evidence: 'core/clock-patrol.js', disposition: 'runtime' },
    clockManual: { label: '手动时钟留痕', evidence: 'core/clock-patrol.js', disposition: 'runtime' },
    storyDay: { label: '剧情第几天（保留）', evidence: 'core/clock-extract.js#recordReservedStoryDay（**与时钟无关、不注入**）', disposition: 'runtime' },
});

/**
 * **运行期**写入的顶层槽位（不在 `emptyState()` 里，但生产代码确实会写）。
 * 键集同样来自全仓实测（`grep 'state\.[A-Za-z_$]+ *='`）；`evidence` 写明写入点，
 * 便于日后核对「这个槽位是谁的、还活着吗」。
 *
 * 为什么必须登记：`state-slot-unregistered` 体检若只认 `emptyState()`，这些合法槽位会天天报噪声 ——
 *   而**报噪声的检查等于没有检查**（用户会学会忽略它）。登记后，只有**真正陌生**的键才会被报出来。
 */
export const RUNTIME_SLOTS = Object.freeze({
    repairedAt: { label: '自动修复时刻', evidence: 'core/repair.js（`state.autoRepair`）', disposition: 'runtime' },
    autoRepair: { label: '自动修复状态', evidence: 'core/repair.js#runRepairMech', disposition: 'runtime' },
    repairLog: { label: '修复日志（末 5 条）', evidence: 'core/repair.js', disposition: 'runtime' },
    repairCursor: { label: '修复轮询游标', evidence: 'core/group-repair.js', disposition: 'runtime' },
    lowUseForget: { label: '低使用遗忘游标', evidence: 'core/forget.js', disposition: 'runtime' },
    coverReset: { label: '原文已移除重置留痕', evidence: 'host/floors.js', disposition: 'runtime' },
    floorJumpAt: { label: '楼层突变留痕', evidence: 'host/floors.js', disposition: 'runtime' },
    floorShrinkAt: { label: '楼层骤减留痕', evidence: 'host/floors.js', disposition: 'runtime' },
    rumorTick: { label: '传言演化轮次', evidence: 'core/rumor-evolve.js', disposition: 'runtime' },
    snapFp: { label: '快照指纹台账', evidence: 'core/snapshots.js', disposition: 'runtime' },
    snapStore: { label: '快照链（数组）', evidence: 'core/snapshots.js', disposition: 'runtime' },
    processedVer: { label: '台账版本标签', evidence: 'host/floors.js', disposition: 'runtime' },
    weaveLastFloor: { label: '上次被动推演楼层', evidence: 'core/parallel.js（`数-14` 加上界）', disposition: 'runtime' },
    parallelFloor: { label: '上次平行演化楼层', evidence: 'core/rumor-evolve.js（`数-14` 加上界）', disposition: 'runtime' },
    // v3.46.1（`docs/D22` W11 `数-36` / `docs/D32` §3.9）：三域联动记录（末 5 条；**不参与跨端同步**）
    triLinkLog: { label: '联动记录（末 5 条）', evidence: 'core/tri-link.js#triLogPush', disposition: 'runtime' },
    // v3.46.2（`docs/D22` §4.14 W13 `应-30`）：货币融合记录（末 5 条；**不参与跨端同步**）
    currencyMergeLog: { label: '货币融合记录（末 5 条）', evidence: 'core/currency-merge.js#curMergeLogPush', disposition: 'runtime' },
    // v3.47.0（`docs/D22` §4.16 W16 `应-33`）：履历批量完善记录（末 5 条；**不参与跨端同步**）
    resumeBatchLog: { label: '履历批量记录（末 5 条）', evidence: 'core/resume-batch.js#resumeBatchLogPush', disposition: 'runtime' },
});

/**
 * 已知的**死读配置键**（读了但没有任何写入路径 —— `defaultCfg` 里没有、也无控件）。
 * 登记在此而不是删代码：读取本身是 best-effort（拿不到就跳过），删掉不影响行为，
 * 但登记后**体检会如实列出**，避免它继续以「看起来能用」的形态存在（`数-15` 的同一纪律）。
 */
export const RESERVED_CFG_READS = Object.freeze([
    { key: 'protagonistName', readBy: 'core/rel-maint.js#relKnownNameSet', note: '不在 defaultCfg、无控件可写 → 恒为 undefined（读到即跳过）' },
]);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 登记表覆盖的槽位键（测试与体检共用） */
export function registeredSlotKeys() { return Object.keys(STATE_SLOTS); }

/**
 * 槽位报告（只读；体检与调试共用）。
 * @param {object} [st] 存档（缺省用 `emptyState()`，即「本版声明的槽位面」）
 * @returns {{registered:string[], unregistered:string[], reserved:Array, legacy:Array, cfgReads:Array}}
 */
export function stateSlotReport(st) {
    const out = { registered: [], unregistered: [], runtime: [], reserved: [], legacy: [], innerUnregistered: [], cfgReads: RESERVED_CFG_READS.slice() };
    try {
        const s = isObj(st) ? st : emptyState();
        const known = (k) => Object.prototype.hasOwnProperty.call(STATE_SLOTS, k) || Object.prototype.hasOwnProperty.call(RUNTIME_SLOTS, k);
        out.registered = Object.keys(s).filter((k) => Object.prototype.hasOwnProperty.call(STATE_SLOTS, k));
        out.unregistered = Object.keys(s).filter((k) => !known(k));
        for (const k of Object.keys(STATE_SLOTS)) {
            const d = STATE_SLOTS[k].disposition;
            if (d === 'reserved') out.reserved.push({ key: k, label: STATE_SLOTS[k].label, semantics: STATE_SLOTS[k].semantics });
            else if (d === 'legacy') out.legacy.push({ key: k, label: STATE_SLOTS[k].label, semantics: STATE_SLOTS[k].semantics });
        }
        // 下钻层：`state` 容器内部的未登记键（**声明层 + 运行期层**都算已登记 —— 否则真实存档里的
        //   `state.present` / `state.clockSrc` 会天天被报成「未登记槽位」，把这条检查变成噪声）
        if (isObj(s.state)) {
            const innerKnown = (k) => Object.prototype.hasOwnProperty.call(STATE_INNER_SLOTS, k)
                || Object.prototype.hasOwnProperty.call(STATE_INNER_RUNTIME_SLOTS, k);
            out.innerUnregistered = Object.keys(s.state).filter((k) => !innerKnown(k));
            for (const k of Object.keys(STATE_INNER_SLOTS)) {
                if (s.state[k] !== undefined) out.registered.push('state.' + k);
            }
        }
        for (const k of Object.keys(STATE_INNER_SLOTS)) {
            if (STATE_INNER_SLOTS[k].disposition === 'reserved') out.reserved.push({ key: 'state.' + k, label: STATE_INNER_SLOTS[k].label, semantics: STATE_INNER_SLOTS[k].semantics });
        }
        out.runtime = Object.keys(RUNTIME_SLOTS);
        // v3.44.0：**「保留未启用」只在真的装着数据时才值得报** —— 空白存档里报它是纯噪声，
        //   而「体检干净 = 无明细」是本模块与测试（`data-health.test.js` A11）都在守的不变量。
        //   判据 = 该槽位当前值 ≠ `emptyState()` 的默认值（默认值本身就是「没有数据」）。
        try {
            const base = emptyState();
            out.reservedWithData = out.reserved.filter((x) => {
                const path = String(x.key).split('.');
                let cur = s, def = base;
                for (const seg of path) { cur = (cur == null) ? undefined : cur[seg]; def = (def == null) ? undefined : def[seg]; }
                return JSON.stringify(cur === undefined ? null : cur) !== JSON.stringify(def === undefined ? null : def);
            });
        } catch (e) { out.reservedWithData = out.reserved.slice(); }
        return out;
    } catch (e) { return out; }
}

/**
 * 槽位一致性自检（**测试与运行时都能用**）：
 *   ① `emptyState()` 的键集与 `STATE_SLOTS` **双向一致**；
 *   ② `state` 容器内部键集与 `STATE_INNER_SLOTS` **双向一致**；
 *   ③ 运行期登记（`RUNTIME_SLOTS` / `STATE_INNER_RUNTIME_SLOTS`）与声明登记 **不重叠**
 *      （同一槽位只能有一种归属；重叠意味着「既声明又运行期写」，两处口径迟早分叉）。
 * @returns {{ok:boolean, missingInRegistry:string[], missingInState:string[], innerMissingInRegistry:string[], innerMissingInState:string[], runtimeCollisions:string[]}}
 */
export function stateSlotSelfCheck() {
    const st = emptyState();
    const keys = Object.keys(st);
    const reg = Object.keys(STATE_SLOTS);
    const inner = isObj(st.state) ? Object.keys(st.state) : [];
    const innerReg = Object.keys(STATE_INNER_SLOTS);
    const innerRt = Object.keys(STATE_INNER_RUNTIME_SLOTS);
    const r = {
        missingInRegistry: keys.filter((k) => reg.indexOf(k) < 0),
        missingInState: reg.filter((k) => keys.indexOf(k) < 0),
        innerMissingInRegistry: inner.filter((k) => innerReg.indexOf(k) < 0),
        innerMissingInState: innerReg.filter((k) => inner.indexOf(k) < 0),
        runtimeCollisions: Object.keys(RUNTIME_SLOTS).filter((k) => reg.indexOf(k) >= 0)
            .concat(innerRt.filter((k) => innerReg.indexOf(k) >= 0)),
    };
    r.ok = !r.missingInRegistry.length && !r.missingInState.length && !r.innerMissingInRegistry.length
        && !r.innerMissingInState.length && !r.runtimeCollisions.length;
    return r;
}
