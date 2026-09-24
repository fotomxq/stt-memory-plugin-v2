// ============================================================
// core/state.js —— **逐字移植自 V1**（src/modules/05-记忆状态与存储抽象.js）
// 覆盖：角色作用域键 / 存档键 / 空状态容器（14 类维度 + 墓碑账本 + 时钟 + 主角 + 快照链）。
// 适配：① ESM 化；② `scopeId()` 的「角色标识」改为**注入视图** `getScopeKey()`
//   （V1 用 TH 的 `getCurrentCharacterId()`；V2 由 host 注入角色文件名/名，见 host/st-api.js）；
//   ③ 结构迁移 `migrateState` **不在此文件** —— 它依赖完整配置（`CN_KEY_MAP`）与时钟族，随「配置与时钟」批次移植。
// ============================================================
import { hashText } from './util.js';
import { VERSION, getScopeKey } from './model/runtime.js';

/**
 * 角色作用域键（V1：`char:${hashText(getCurrentCharacterId())}`）。
 * V2：角色标识由宿主注入（`setScopeKey`），未注入时用 'default' 兜底（不臆造角色）。
 */
function scopeId() { return `char:${hashText(getScopeKey() || 'default')}`; }

/** 存档键（V1 原样） */
function stateKey() { return `SPreset_FTTMemory_${scopeId()}`; }

function emptyState() {
    return {
        version: VERSION,
        scope: scopeId(),
        state: { time: '', date: '', location: '', sceneFocus: null },
        protagonist: {},
        items: [], plans: [], suspense: [], scenes: [], npcs: [],
        atoms: [], currentStates: [], snapshots: [], memories: [], concepts: [], parallels: [],   // 平行事件（正文之外、八卦推演的潜在事件）
        currencies: [],   // v1.181：货币大类（谁持有多少钱 —— 归属 + 币种 + 额度 + 收支流水）
        plotSegments: [],  // v1.182：情节分段总结（### 时间范围 + 逐条剧情线；只归档不注入，仅手动删除）
        rumors: [],        // v1.192：传言（主体 + 当前说法 + 客观性 + 传播者 + 载体 + 传导链路/裂变谱系）
        // v1.165：通用知情关联层（一行 = 一个「条目 ↔ 角色」关联）—— 记忆 / 计划 / 悬念 / 平行事件共用
        links: [],
        vars: {},
        varTemplates: { global: { json: {}, meaning: '', rule: '' }, char: { json: {}, meaning: '', rule: '' }, chat: { json: {}, meaning: '', rule: '' } },
        summaries: [],
        processedFloors: [],        // 已处理楼层哈希标记 [{f, h}]（h=楼层内容哈希，防重复/防内容变更误判）
        lastKnownFloor: -1,         // 最近见过的最大楼层号（断裂检测基线）
        // 已完结计划 / 已揭晓悬念 —— 只留统计数据（原文直接删除，见 merge/UI 了结路径）
        stats: { plansClosed: 0, suspenseResolved: 0 },
        // 跨端删除墓碑 —— { dim: { id: 删除时间ms } }，随信封持久化；合并时对方条目
        //   更新时间 ≤ 墓碑时间 → 双方一并删除（删除跨端传播，不再被“纯并集”复活）。
        deleted: {},
        // 内容哈希墓碑 —— { dim: { 内容哈希: 删除时间ms } }。按 id 的墓碑挡不住「对端把同一条
        //   内容以新 id 重新写入」（AI 重生成 / 内容哈希去重换 id / 快照还原），故删除时按内容哈希再记一份：
        //   合并时同内容条目（墙钟 ≤ 墓碑时间）一律剔除 → 真正的「删了就不会被任何一端唤醒」。
        deletedH: {},
        updatedAt: 0,
    };
}

export { scopeId, stateKey, emptyState };
