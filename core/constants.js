// ============================================================
// core/constants.js —— 纯内核常量（零宿主依赖）
// 事实源：docs/P0-探针报告.md（对齐 SillyTavern release 分支源码）
// ============================================================

/** 扩展标识（extensionSettings 的键名，全局唯一） */
export const MODULE_NAME = 'ftt_memory_v2';

/** 代码版本（与 manifest.json 的 version 必须一致，由 scripts/check-version-sync.js 校验） */
export const VERSION = '2.24.0';

/** 扩展目录名（ST 挂载路径：/scripts/extensions/third-party/<folder>；用于模板渲染与自检） */
export const EXTENSION_FOLDER = 'third-party/ftt-memory-v2';

/** 数据模型版本（与代码版本解耦：只在需要数据迁移时递增） */
export const DATA_VERSION = 1;

/** 注入键（setExtensionPrompt 的 key，禁用/关闭时必须显式置空避免残留） */
export const INJECT_ID = 'ftt_memory_v2';

/**
 * setExtensionPrompt 的位置枚举。
 * 事实源：SillyTavern public/script.js `extension_prompt_types`
 * （NONE: -1 / IN_PROMPT: 0 / IN_CHAT: 1 / BEFORE_PROMPT: 2）—— 硬编码以避免 import 宿主内部模块。
 */
export const PROMPT_POSITION = Object.freeze({ NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 });

/** setExtensionPrompt 的角色枚举（script.js `extension_prompt_roles`：SYSTEM/USER/ASSISTANT = 0/1/2） */
export const PROMPT_ROLE = Object.freeze({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });

/**
 * 记忆维度（与 V1 `ATOM_DIM_KEYS` + 货币容器对齐，共 14 类）。
 * kind 为运行时容器名（state[kind]），part 为持久化分区名。
 */
export const DIMENSIONS = Object.freeze([
    { kind: 'atoms', part: 'atoms', label: '情节' },
    { kind: 'currentStates', part: 'currentStates', label: '状态记录' },
    { kind: 'snapshots', part: 'snapshots', label: '角色档案' },
    { kind: 'memories', part: 'memories', label: '长期记忆' },
    { kind: 'items', part: 'items', label: '物品' },
    { kind: 'plans', part: 'plans', label: '计划' },
    { kind: 'suspense', part: 'suspense', label: '悬念' },
    { kind: 'scenes', part: 'scenes', label: '场景' },
    { kind: 'concepts', part: 'concepts', label: '概念' },
    { kind: 'parallels', part: 'parallels', label: '平行事件' },
    { kind: 'links', part: 'links', label: '关联层' },
    { kind: 'plotSegments', part: 'plotSegments', label: '分段总结' },
    { kind: 'rumors', part: 'rumors', label: '传言' },
    { kind: 'currencies', part: 'currencies', label: '货币' },
]);

/** 更新检查默认仓库地址（用户要求：以 GitHub 项目地址作为更新检查地址；可在设置里改） */
export const DEFAULT_UPDATE_REPO = 'https://github.com/fotomxq/stt-memory-plugin-v2';
/** 更新检查默认分支 */
export const DEFAULT_UPDATE_BRANCH = 'main';
/** 自动检查间隔（小时） */
export const DEFAULT_UPDATE_INTERVAL_HOURS = 24;

/** 各维度单条字数硬上限（**逐字移植自 V1 `defaultCfg.dimCharLimits`**；可用 `setDimCharLimits` 覆盖） */
export const DIM_CHAR_LIMITS = Object.freeze({
    atoms: 360,
    states: 130,
    snapshots: 600,
    memories: 260,
    items: 160,
    plans: 200,
    suspense: 200,
    currencies: 200,
    rumors: 240,
    scenes: 260,
    concepts: 320,
    parallels: 560,
});

/** 参与「原子层」内容哈希 / 快照链 / 跨端逐条合并的维度键（**逐字取自 V1**） */
export const ATOM_DIM_KEYS = Object.freeze(['atoms', 'currentStates', 'snapshots', 'memories', 'items', 'plans', 'suspense', 'scenes', 'concepts', 'parallels', 'links', 'plotSegments', 'rumors']);

/** 绑定到宿主的酒馆事件（与 V1 九事件对齐） */
export const HOST_EVENTS = Object.freeze([
    'USER_MESSAGE_RENDERED',
    'GENERATION_STARTED',
    'GENERATION_ENDED',
    'MESSAGE_RECEIVED',
    'MESSAGE_EDITED',
    'MESSAGE_DELETED',
    'MESSAGE_SWIPED',
    'CHAT_CHANGED',
    'CHARACTER_MESSAGE_RENDERED',
]);

/** 数据容器键（用于空状态构建） */
export const STATE_KEYS = Object.freeze(DIMENSIONS.map(d => d.kind));
