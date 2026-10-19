// ============================================================
// core/debug-catalog.js —— **调试面口径的单一事实源**（v3.45.4，`docs/D22` W10 · `技-41`）
//
// 设计依据：`docs/D31-调试工具统一设计稿.md`（调试工具的唯一基准）——
//   §3.2 统一命名（日志 `kind` 冻结为**枚举表**，新增需登记）· §3.4 **唯一的 CAP 汇总表** ·
//   §3.5 统一脱敏 · §3.6 统一只读纪律 · §3.7 追溯六字段 · §3.8 去重与收口 ·
//   §5 **12 类必要内容** · §8 Q4 裁决（清空型动作**永不进桥白名单**，在只读清单里显式标注）。
//
// 为什么要有这个模块（`docs/D31` §2.4 的缺口 G2/G3/G4）：
//   · **G2 口径不统一**：业务日志的 `kind` 是自由字符串、时间线有 `TRACE_CATS`、台账按来源分类 ——
//     命名 / 上限 / 脱敏 / 追溯各写各的。这里把「能有哪些 kind」「每个载体的上限与保留窗」「统一脱敏」
//     「追溯六字段」「只读清单」「12 类必要内容」全部收在**一处**，三处出口（调试页 / 调试桥 / 调试导出）
//     只做**透传**，不再各算一遍（§3.8 的「去重 + 收口」）。
//   · **G3 只读性没有统一判据**：桥是白名单（可机械验证），`FTT.*` 与 `/ftt` 命令此前只是「约定」——
//     `READONLY_OUTLETS` 就是那份可核对的清单，且**清空型动作显式标注**（Q4）。
//   · **G4 追溯字段不齐**：`TRACE_FIELDS` + `traceStamp()` 把六字段的名字与形态固定下来。
//
// 硬约束（本仓库纪律，违反即被门禁拦下）：
//   · **纯内核**：只 import `./constants.js`，不碰宿主 / DOM / `node:fs`（`scripts/check-core-purity.js`）；
//   · **零运行时依赖**；**绝不反向 import `core/debug-log.js`** —— 那会形成环（`debug-log.js` 需要本模块的
//     `DEBUG_KINDS`）。需要「未登记 kind」的**实时**读数时，由 `debug-log.js` 通过
//     `setUnregisteredKindReader()` **注入**一个只读读取器（依赖倒置：内核被观测者注册，而不是反过来依赖）；
//   · **CAP 以代码为准**：`DEBUG_CAPS` 的每个数值都是从**真实常量**读出来核对的（常量名写在 `source` 里），
//     **不抄文档**；文档与代码不一致的行在 `note` 里写「文档与代码不一致，以代码为准」。
// ============================================================
import { VERSION } from './constants.js';

// ============================================================
// 一、业务调试日志的 `kind` 枚举（§3.2 / §3.8 的「枚举化」）
//
// 收集方法（**来自实测，不凭印象**）：扫 `core/` `host/` `adapters/` `ui/` `index.js` `devtools.js` 里
//   **所有** `dbgLog('<kind>'` / `debugLogPush('<kind>'` / `debugLogPushCoalesced('<kind>'` 调用点，
//   外加「薄包装」形态（`function log(kind, data) { … debugLogPush(kind, data) … }` 之后 `log('<kind>'`）——
//   同一份收集逻辑在 `scripts/debug-coverage-lib.js#collectLogKinds`，由门禁 `scripts/check-debug-coverage.js`
//   与单测共同调用，因此**新增一条未登记的 kind 会被检查发现**（`技-41` 验收 ④）。
// 口径：**冻结既有取值 + 新增需登记**（`docs/D31` §3.2）；与时间线的 `TRACE_CATS` **互不混用**（Q6 不合并）。
// ============================================================
/** `kind` 枚举表（冻结；每条的 `note` 说明「这个类别记什么」） */
export const DEBUG_KINDS = Object.freeze([
    Object.freeze({ kind: '摘要', note: '摘要与各维修复的**结果留痕**（单楼分析、批量摘要、情节分段、记忆/概念/计划/物品/场景/状态修复完成）；量最大的一类' }),
    Object.freeze({ kind: '修复', note: '**自动修复三段**的入口与分支（机械清理 / AI 修复 / 状态修复）、提取失败自动修复触发' }),
    Object.freeze({ kind: '对账', note: '载入与同步的**对账结论**（主文件/分片、跨端合并、世界书单向镜像、存储通道切换、文件通道停用回退）' }),
    Object.freeze({ kind: '存储', note: '**存储侧事实**：落盘守门的拦与放行、本机缓冲预算与压缩留存、本地目录读写与迁移、关联层裁剪、面板渲染偏慢' }),
    Object.freeze({ kind: '载入', note: '**首屏载入链路**：本机层重试与按内容作用域找回、内核态占位注入、首屏载入完成（含等待毫秒）、落盘守门安全阀' }),
    Object.freeze({ kind: '读取', note: '**读取台账**的日志镜像（来源 / 动作 / 耗时 / 字节 / 命中 / 原因；**不含正文**）' }),
    Object.freeze({ kind: '同步', note: '**跨端同步**日志镜像与合并自检结论（待确认项迁移、冲突记录，无需用户确认）' }),
    Object.freeze({ kind: '发送记忆', note: '**发送侧**：召回注入、平行事件推演与去重、记忆遗忘与衰退清扫、注入预算分配中止' }),
    Object.freeze({ kind: '召回', note: '**召回侧诊断**：内核态尚未注入 → 本轮不召回（**低噪诊断，不视为错误**）' }),
    Object.freeze({ kind: '向量', note: '**向量层**：向量召回与缓存重建（rekey）的通道、条数、耗时' }),
    Object.freeze({ kind: '关键词', note: '**关键词层**（宿主关键词 API 通道）的召回结果与来源渠道' }),
    Object.freeze({ kind: '时钟', note: '**剧情时钟**：取值来源与理由、手工强制改写与解除锁定、修复步骤里的时间/地点/人物刷新' }),
    Object.freeze({ kind: '弱化', note: '**内容弱化（NSFW）**：固定规则替换计数、AI 弱化的提交/应用/跳过计数与等级分布' }),
    Object.freeze({ kind: '校对', note: '**提取前校对**：日期 / 时间 / 地点变化的取舍与来源（changed / skipped）' }),
    Object.freeze({ kind: '楼层', note: '**楼层**：聊天归属更新、楼层收缩与突变识别与修正、删楼备份名（含陈旧标记数）' }),
    Object.freeze({ kind: '管线', note: '**长任务管线**阶段与超时收尾、异常耗时样本（`core/pipeline.js` 的日志钩子）' }),
    Object.freeze({ kind: '异常', note: '**错误与异常**：全局 error / unhandledrejection / 面板动作失败 / 内核告警（**逐条不合并**，避免掩盖问题）' }),
    Object.freeze({ kind: '调试', note: '**调试设施自身的提示**：遇到未登记的 `kind` 时的一次性提示（本枚举的唯一「自指」类别）' }),
    // v3.45.9（`docs/D22` W5 `技-26`）：宿主侧事实的自检留痕（如「宿主输入框写入能力自检」——探针 + 克隆体演练结论）
    Object.freeze({ kind: '宿主', note: '**宿主侧事实的自检**：页面加载时对宿主能力的只读自检结论（如输入框写入能力 —— 走哪一档、克隆演练是否成功）' }),
    // v3.46.1（`docs/D22` W11）：三域联动（🔗 联动构建）—— 打包 / 校验 / 应用 / 拒绝计数的运行留痕
    Object.freeze({ kind: '联动', note: '**三域联动**（传言 / 计划 / 悬念）：打包条数、通过与被拒的动作数、拒绝原因分布、应用计数与耗时' }),
    // v3.47.0（`docs/D22` W16 `数-23`）：地图入库（空间单元 / 路径的落库读数与护栏计数）
    Object.freeze({ kind: '地图', note: '**地图库入库**的读数与护栏计数（空间单元 / 路径 / 锚点新增，未走过未建、端点或场所无法解析、上层无法解析、孤立陈设）——`core/map-ingest.js#applyMapDelta` 一处产生' }),
]);

/** 未登记 kind 的实时读取器（由 `core/debug-log.js` 注入；内核默认无） */
let unregisteredReader = null;
/**
 * 注册「未登记 kind」读取器（**依赖倒置**：`debug-log.js` 依赖本模块的枚举，本模块不依赖它）。
 * @param {null|function():Array<object>} fn 返回只读副本的读取器；传 null 注销
 */
export function setUnregisteredKindReader(fn) {
    unregisteredReader = (typeof fn === 'function') ? fn : null;
    return unregisteredReader !== null;
}

/** 该 `kind` 是否已登记（大小写敏感、逐字比对；非字符串一律未登记） */
export function debugKindRegistered(kind) {
    const k = String(kind == null ? '' : kind);
    for (const it of DEBUG_KINDS) if (it.kind === k) return true;
    return false;
}

/** `kind` 枚举副本（`[{kind, note}]`；调用方改动不影响本表） */
export function debugKindList() {
    return DEBUG_KINDS.map((it) => ({ kind: it.kind, note: it.note }));
}

// ============================================================
// 二、CAP 汇总表（§3.4 的**唯一**一张表）
//
// 纪律（§3.4 末）：**新增长期留痕必须同时给出上限与保留窗**；**任何缓冲都不得随会话无限增长**。
// 本表的每个数值都从代码常量读出并核对，`source` 写出「文件#符号」；`window` 写保留窗（内存 / 持久化键）。
// **文档与代码不一致 → 以代码为准**，并在 `note` 里写明（见「探针」「调试桥方法数」两行）。
// ============================================================
/** CAP 汇总表（每个载体一行；`cap` 内存上限 · `window` 保留窗 · `source` 事实源符号） */
export const DEBUG_CAPS = Object.freeze([
    Object.freeze({ carrier: '业务调试日志（条数）', cap: '300 条', window: '内存环形（最新在前）→ 持久化键 `SPreset_FTTMemoryDebug`，按 `at|kind` 去重后降序截断', source: 'core/debug-log.js#DEBUG_CAP', note: '与 V1 v1.49 同值' }),
    Object.freeze({ carrier: '业务调试日志（单条）', cap: '2000 字符', window: '同左（对象 `JSON.stringify` 后取前缀；字符串原样不截断）', source: 'core/debug-log.js#DEBUG_DATA_MAX', note: 'v3.1.0 由 6000 降到 2000（`docs/D13` R1/Q6）：300×6000=1.8M 字符会挤占本机缓冲配额。**同族不一致（以代码为准）**：`adapters/debug-log.js#DATA_MAX` 仍是 6000 —— 那是**读取归一**的上限（兼容历史已落盘的 6000 长度条目），写入上限只有一个：`core/debug-log.js#DEBUG_DATA_MAX`' }),
    Object.freeze({ carrier: '业务调试日志（合并窗口）', cap: '同一 key 64 个', window: '窗口 `COALESCE_WINDOW_MS` = 5000 ms（同 key 重复「成功」原地升级为 `{n,lastAt,bytes}`，失败类逐条）', source: 'core/debug-log.js#COALESCE_WINDOW_MS', note: 'v3.40.0（`docs/D16` L11）：避免同一句「成功」把 300 条环挤满' }),
    Object.freeze({ carrier: '事件时间线（分类环形）', cap: 'ui 200 / host 300 / cmd 100 / kernel 100 / ai 100 / error 100', window: '内存（会话内；不随会话增长）', source: 'core/trace.js#TRACE_CAT_CAP', note: '6 类与 `TRACE_CATS` 一一对应' }),
    Object.freeze({ carrier: '事件时间线（总量）', cap: '800 条', window: '内存（跨分类上限）', source: 'core/trace.js#TRACE_TOTAL_CAP', note: '' }),
    Object.freeze({ carrier: '事件时间线（单条）', cap: '2000 字符', window: '内存', source: 'core/trace.js#TRACE_ITEM_MAX', note: '' }),
    Object.freeze({ carrier: '事件时间线（持久化）', cap: '120 条', window: '持久化键 `SPreset_FTTMemoryTrace`：**只存摘要尾部**（id/at/cat/kind/ok/opId/站点），**不存 detail**', source: 'adapters/trace-store.js#TRACE_STORE_CAP', note: '与缓冲页展示的「交互追踪简报 120」同源' }),
    Object.freeze({ carrier: '事件时间线（去重窗口）', cap: '同类别同 kind 同摘要合并为 ×N', window: '`TRACE_DEDUPE_MS` = 800 ms', source: 'core/trace.js#TRACE_DEDUPE_MS', note: '' }),
    Object.freeze({ carrier: '事件时间线（错误上下文窗）', cap: '前后各 20 条', window: '按 opId 聚合的错误上下文', source: 'core/trace.js#TRACE_CONTEXT_SPAN', note: '§5 #10「错误与异常」的「100 条 + 上下文 20」= error 分类环形 + 本窗' }),
    Object.freeze({ carrier: '读取台账', cap: '240 条', window: '**内存（不落盘）**——「内存恒定、不随会话增长」', source: 'core/read-ledger.js#READ_LEDGER_CAP', note: '与缓冲页展示的「读取台账 240」同源' }),
    Object.freeze({ carrier: '读取台账（镜像慢阈值）', cap: '100 ms 以上标慢', window: '内存（仪表读数，非缓冲）', source: 'core/read-ledger.js#READ_LEDGER_MIRROR_SLOW_MS', note: '' }),
    Object.freeze({ carrier: '跨端待确认项', cap: '50 条', window: 'ST 扩展设置 `syncConflicts`', source: 'core/conflicts.js#CONFLICT_CAP', note: '`docs/D31` §5 #6 记「待确认项出口见 `docs/D17` U172」' }),
    Object.freeze({ carrier: '跨端记录区（无需确认）', cap: '20 条', window: 'ST 扩展设置 `syncConflictLog`', source: 'core/conflicts.js#CONFLICT_LOG_CAP', note: '' }),
    Object.freeze({ carrier: '同步日志', cap: '30 条', window: '本机环形（`ftt2_SyncLog_<scope>`）+ 服务端文件交叉**并集合并**', source: 'core/sync-log.js#SYNC_LOG_MAX', note: '与缓冲页展示的「同步日志 30」同源' }),
    Object.freeze({ carrier: '管线 ETA 样本', cap: '每个处理行为保留最近 5 次', window: 'ST 扩展设置 `pipelineEta`（随设置持久化）', source: 'core/pipeline.js#ETA_SAMPLES', note: '`host/floors.js` 里的 `slice(-5)` 是同一个 5（字面量，非独立常量）' }),
    Object.freeze({ carrier: '管线异常样本阈值', cap: '单次 > 15 分钟不采信', window: '`PIPELINE_SAMPLE_MAX_MS` = 15×60×1000 ms', source: 'core/pipeline.js#PIPELINE_SAMPLE_MAX_MS', note: '' }),
    Object.freeze({ carrier: '管线卡死撤下阈值', cap: '存活 > 15 分钟的运行就地撤下', window: '`PIPELINE_STALE_MS` = 15×60×1000 ms', source: 'core/pipeline.js#PIPELINE_STALE_MS', note: '' }),
    Object.freeze({ carrier: 'AI 用量账本', cap: '每键 200 条、最多 40 键', window: 'ST 扩展设置（随设置持久化；`core/token-cost.js`）', source: 'core/token-cost.js#AI_USAGE_KEEP / #AI_USAGE_MAX_KEYS', note: '' }),
    Object.freeze({ carrier: '删楼备份', cap: '3 槽位（轮转覆写）', window: '本机文件层（`adapters/floor-backup.js`，名字带槽位号）', source: 'adapters/floor-backup.js#FLOOR_BACKUP_SLOTS', note: '' }),
    Object.freeze({ carrier: '修复日志', cap: '5 条', window: '内存（`core/repair.js`，最新在前）', source: 'core/repair.js#REPAIR_LOG_MAX', note: 'V1 `REPAIR_LOG_MAX` 同值' }),
    Object.freeze({ carrier: '内核告警暂存', cap: '20 条', window: '内存（接线前暂存；接线时一次性补记进调试日志后清空）', source: 'core/model/runtime.js#WARN_BACKLOG_MAX', note: '' }),
    Object.freeze({ carrier: '调试桥', cap: '不适用（**不落盘**）', window: '每次页面加载回到关闭态（面板开关不持久化）', source: 'ui/debug.js#buildBridgeMethods', note: '**文档与代码不一致，以代码为准**：`docs/D31` §2.2 记「白名单 50 个」、§4.4 记「52」，实测 `ui/debug.js` 里 `T[类别.方法] =` 赋值共 **58** 个（= `ftt.*` 45 + `sys.*` 6 + `host.*` 7；v3.45.4 追加 `ftt.perf` / `ftt.perfJank` / `ftt.perfTargets` / `ftt.perfBaseline` / `ftt.readonly` / `ftt.catalog`）；`docs/README.md` §3 的「调试桥只读方法数」以实测为准' }),
    Object.freeze({ carrier: '性能 / 卡顿探针（环形）', cap: '200 条', window: '**不落盘**（会话内）；只记超阈段；同站点同 kind 去重 `PERF_DEDUPE_MS` = 800 ms', source: 'core/perf-probe.js#PERF_WINDOW / #PERF_DEDUPE_MS', note: '与 `docs/D31` §3.4 / §8 Q2「环形 200 条、去重 800ms」一致（本行在探针落地前曾记「待建」，现已按代码实测补回）' }),
    Object.freeze({ carrier: '性能 / 卡顿探针（分级阈值）', cap: 'notice ≥ 50ms · stall ≥ 200ms · freeze ≥ 1000ms', window: '单段同步耗时（`jankRate = Σ超阈段耗时 ÷ 采样窗口时长`）', source: 'core/perf-probe.js#PERF_THRESHOLDS', note: '与 `docs/D31` §4.1 的分级一致' }),
    Object.freeze({ carrier: '性能基线', cap: '只增不降棘轮（`技-39`）', window: '开发期产物 `scripts/perf-baseline.json`（**待建**，用户没跑过基线脚本时探针如实回 `available:false`）', source: 'scripts/perf-baseline.json（待建）', note: '与 `docs/D31` §3.4 一致（文档也写「待建」）' }),
]);

/** CAP 汇总表副本（`[{carrier, cap, window, source, note}]`） */
export function debugCapList() {
    return DEBUG_CAPS.map((it) => ({ carrier: it.carrier, cap: it.cap, window: it.window, source: it.source, note: it.note }));
}

// ============================================================
// 三、统一脱敏（§3.5：三处出口复用**同一个**函数）
//
// 为什么必须收在一处：脱敏只要有一处漏，正文或密钥就会经「调试桥 / 调试导出 / 调试页」外泄（R4）——
//   「新增出口必须过同一脱敏函数」是 §7 R4 的对策，本函数就是那个「同一函数」。
// 五条规则（缺一不可）：
//   ① 键名黑名单（大小写不敏感）→ `'[redacted]'`；
//   ② 字符串里的**密钥形态**（`sk-` / `Bearer ` / 长十六进制 / 长 Base64）→ 保留**前 4 与后 2**字符 + `…`；
//   ③ 正文类字段（`text/content/desc/body/message/prompt/response`）→ **只回长度** `'[len:N]'`
//      （**除非**显式 `{ allowText: true }`）；
//   ④ 深度与数组 / 键数上限（默认 depth ≤ 6、每层 ≤ 50 项）；
//   ⑤ **循环引用安全**（沿当前路径用 `WeakSet` 去环，绝不抛错）。
// **返回新对象，绝不修改入参**（调用方常常把内核态对象直接丢进来）。
// ============================================================
/** 键名黑名单（`docs/D31` §3.5 的名单；`key` 只在其为「api key」义时才危险，故用 `apikey|api_key` 而非裸 `key`） */
const REDACT_KEY_RE = /apikey|api_key|secret|token|password|passwd|authorization|cookie|session/i;
/** 正文类字段（**精确键名**、大小写不敏感）：只回长度，不回原文 */
const BODY_KEY_RE = /^(?:text|content|desc|body|message|prompt|response)$/i;
/** 默认递归深度上限（§3.5 ④） */
export const REDACT_DEPTH_MAX = 6;
/** 默认每层项数上限（数组元素 / 对象键；§3.5 ④） */
export const REDACT_ITEMS_MAX = 50;
/** 普通字符串的默认最长保留 */
export const REDACT_STR_MAX = 200;
/** `allowText:true` 时正文的最长保留 */
export const REDACT_TEXT_MAX = 2000;

/** 字符串是否「长得像密钥」（② 的判据） */
function looksSecret(s) {
    if (/^sk-/.test(s)) return true;
    if (/^Bearer\s/i.test(s)) return true;
    if (/^[0-9a-f]{32,}$/i.test(s)) return true;                 // 长十六进制（hash / key / token）
    // 长 Base64：**必须同时含有大小写与数字**（至少 3 类字符）才算 ——
    //   否则 `'x'.repeat(300)` 这类**纯小写长正文**会被误判成密钥并被打码（脱敏不能反过来咬到正常读数）。
    if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(s)) {
        const cls = (/[a-z]/.test(s) ? 1 : 0) + (/[A-Z]/.test(s) ? 1 : 0) + (/[0-9]/.test(s) ? 1 : 0) + (/[+/]/.test(s) ? 1 : 0);
        if (cls >= 3) return true;
    }
    return false;
}
/** 密钥形态 → 保留前 4 与后 2 字符 + `…`（§3.5 ②） */
function maskSecret(s) {
    const t = String(s);
    if (t.length <= 6) return '…';
    return t.slice(0, 4) + '…' + t.slice(-2);
}
/** 正文长度（③ 的 `N`：字符串取字符数，其它取安全序列化长度） */
function lenOf(v) {
    try {
        if (typeof v === 'string') return v.length;
        if (v === null || v === undefined) return 0;
        if (Array.isArray(v)) return v.length;
        const j = JSON.stringify(v);
        return (typeof j === 'string') ? j.length : 0;
    } catch (e) { return 0; }
}

/**
 * 统一脱敏（三处出口复用；**返回新对象、不改入参、绝不抛错**）。
 * @param {*} value 任意读数
 * @param {{depth?:number, items?:number, allowText?:boolean}} [opts]
 *   `allowText` **必须显式传 `true`** 才回正文原文（默认只回长度）
 * @returns {*} 脱敏后的**新**结构
 */
export function redactForOutlet(value, opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const maxDepth = Number.isFinite(Number(o.depth)) ? Math.max(1, Math.floor(Number(o.depth))) : REDACT_DEPTH_MAX;
    const maxItems = Number.isFinite(Number(o.items)) ? Math.max(1, Math.floor(Number(o.items))) : REDACT_ITEMS_MAX;
    const allowText = o.allowText === true;
    const seen = new WeakSet();

    const walk = (v, key, depth) => {
        // ① 键名黑名单 —— **先于一切**（连正文长度都不给，避免「名字里带 token 的字段」泄漏形态）
        if (key && REDACT_KEY_RE.test(key)) return '[redacted]';
        // ③ 正文类字段 —— 只回长度
        if (key && BODY_KEY_RE.test(key) && !allowText) return '[len:' + lenOf(v) + ']';
        if (v === null) return null;
        const t = typeof v;
        if (t === 'undefined') return '';
        if (t === 'number' || t === 'boolean') return v;
        if (t === 'bigint') return String(v);
        if (t === 'function') return '[fn]';
        if (t === 'symbol') return '[symbol]';
        if (t === 'string') {
            if (looksSecret(v)) return maskSecret(v);            // ② 密钥形态
            const max = allowText ? REDACT_TEXT_MAX : REDACT_STR_MAX;
            return v.length > max ? (v.slice(0, max) + '…') : v;
        }
        if (t !== 'object') return String(v);
        // ⑤ 环安全：只在**当前路径**上去环（同一个对象在兄弟位置合法重复时照常展开）
        if (seen.has(v)) return '[circular]';
        if (depth >= maxDepth) return Array.isArray(v) ? ('[Array ' + v.length + ']') : '[Object]';
        seen.add(v);
        try {
            if (Array.isArray(v)) {
                const out = v.slice(0, maxItems).map((x) => walk(x, '', depth + 1));
                if (v.length > maxItems) out.push('…+' + (v.length - maxItems));
                return out;
            }
            const out = {};
            const keys = Object.keys(v);
            for (const k of keys.slice(0, maxItems)) out[k] = walk(v[k], k, depth + 1);
            if (keys.length > maxItems) out['…'] = '+' + (keys.length - maxItems);
            return out;
        } finally { seen.delete(v); }
    };

    try { return walk(value, '', 1); } catch (e) { return '[redact-error:' + String((e && e.message) || e) + ']'; }
}

// ============================================================
// 四、追溯六字段（§3.7）
//
// 判据（§1.1 的「可追溯」硬定义）：一条读数必须能回答 ① 谁触发的（`cause`）· ② 在哪一行产生的（`site`）·
//   ③ 属于哪一版（`ver`）+ 采样窗口（`window`）；要挂到待办再加 `u`（`docs/D17` 的 `U<n>`）。
// 形态约定：六字段统一为**字符串**（缺省空串），因为三处出口只做**透传与拼接**——`at` 若在桥 JSON 里是数字、
//   在页面文本里是字符串，就会出现「同一读数两种形态」的漂移（R3）；这里一次性钉死为字符串。
// ============================================================
/** 追溯六字段的**固定顺序**（`docs/D31` §3.7；顺序固定便于三处出口逐字段比对） */
export const TRACE_FIELDS = Object.freeze(['at', 'ver', 'window', 'cause', 'site', 'u']);
/** 每个字段的值上限（字符；超出截断并加 `…`） */
const TRACE_FIELD_MAX = Object.freeze({ at: 24, ver: 24, window: 48, cause: 120, site: 120, u: 16 });

/**
 * 规范化追溯六字段：**缺省补空串 · 多余键丢弃 · 超长值截断**（§3.7）。
 * @param {object} rec 任意读数（可为 null / 非对象）
 * @returns {{at:string, ver:string, window:string, cause:string, site:string, u:string}} 新对象
 */
export function traceStamp(rec) {
    const src = (rec && typeof rec === 'object') ? rec : {};
    const out = {};
    for (const f of TRACE_FIELDS) {
        const raw = src[f];
        const s = (raw === null || raw === undefined) ? '' : String(raw);
        const max = TRACE_FIELD_MAX[f] || 64;
        out[f] = s.length > max ? (s.slice(0, Math.max(1, max - 1)) + '…') : s;
    }
    return out;
}

// ============================================================
// 五、12 类必要内容（§5 逐类机器可读化）
//
// 判据（§5 表头）：每一类「必要内容」必须同时具备 ① 有采集 · ② **有出口**（页面分节 / 桥方法 / 调试导出，
//   三选一即可）· ③ 有上限与保留；缺一即为缺口。`技-43` 把「② 有出口」做成门禁。
// `outlets` 是**可核对的标识串**，只用三种形态（与 `scripts/debug-coverage-lib.js#collectOutlets` 对齐）：
//   ① 调试页分节标记：`data-ftt-sec="xxx"`（本仓库既有写法是 `data-ftt-section="xxx"`，抽取器**两种都认**，
//      统一归一为 `data-ftt-sec="xxx"`，因此既有分节也能命中）；
//   ② 调试桥只读方法名：`ftt.*` / `sys.*` / `host.*`；
//   ③ 调试导出字段名：**裸名**（`devtools.js#buildSnapshot` 的对象键或 `FTT.*` 的键）。
// `status` 字段的含义（**读之前先看这句**）：它是**本清单对「当前代码事实」的声明** ——
//   `'ok'` = 该类在页面分节 / 桥方法 / 调试导出三处至少有一处出口；`'gap'` = 三类都没有。
//   `docs/D31` §5 的**历史结论**（#11 / #12 曾经是 ❌）保存在各自的 `note` 里，便于台账追溯（U191 / U196）。
//   **实时**判定与门禁始终是 `scripts/check-debug-coverage.js`：它读**消费侧**源码算出口是否存在，
//   `core/debug-catalog.js` 自己**不参与**证据（否则判据自证，反向探针永远绿）。
// ============================================================
/** 12 类必要内容（`{no, name, outlets, status, note}`；`status`: `'ok'` 有出口 / `'gap'` 三类出口都没有） */
export const REQUIRED_CONTENT = Object.freeze([
    Object.freeze({
        no: 1, name: '版本与构建事实', status: 'ok',
        outlets: Object.freeze(['snapshot', 'version', 'dataVersion', 'moduleName', 'ftt.snapshot']),
        note: '`VERSION` / `DATA_VERSION` / 模块名（`core/constants.js`）；§5 出口记「`FTT.snapshot` · 桥」',
    }),
    Object.freeze({
        no: 2, name: '宿主能力与探测', status: 'ok',
        outlets: Object.freeze(['probe', 'host', 'interceptor', 'inputBox', 'inputBoxSteps', 'sys.info', 'sys.host', 'sys.bridgeState']),
        note: '`host/st-api.js#probeCapabilities` · `host/input-box.js#inputBoxCapability`；桥的 `sys.*` 属「桥与环境自身」',
    }),
    Object.freeze({
        no: 3, name: '配置事实', status: 'ok',
        outlets: Object.freeze(['settings', 'ftt.config', 'deviceLocalCfgSnapshot']),
        note: '内核键 / 设备本地键 / 被预置读取的死键（`core/config.js#defaultCfg` · `adapters/config-store.js`）；§5 表里写的 `fft.config` 是笔误，实际标识是 `ftt.config`',
    }),
    Object.freeze({
        no: 4, name: '记忆数据形状与取样', status: 'ok',
        outlets: Object.freeze(['ftt.memoryShape', 'ftt.memorySample']),
        note: '条数 / 维度 / 抽样，**不含正文**（§3.5：桥只回结构化读数）',
    }),
    Object.freeze({
        no: 5, name: '存储与副本', status: 'ok',
        outlets: Object.freeze(['ftt.fileTransport', 'ftt.localDir', 'ftt.diskProbe', 'ftt.diskFiles', 'ftt.stateSize', 'ftt.writeStats']),
        note: '后端 / 通道 / 探针 / 文件列举 / 路径审计',
    }),
    Object.freeze({
        no: 6, name: '同步与对账', status: 'ok',
        outlets: Object.freeze(['ftt.syncLog', 'ftt.conflicts', 'ftt.conflictLog', 'syncLog', 'syncStatus', 'syncInfo']),
        note: '同步日志 / 跨端待确认 / 合并自检；上限见 CAP 表（同步日志 30 · 待确认 50 · 记录 20）',
    }),
    Object.freeze({
        no: 7, name: '楼层与台账', status: 'ok',
        outlets: Object.freeze(['ftt.floors', 'ftt.ledger', 'ftt.pendingScan', 'ftt.pendingFloors', 'ftt.floorDiag', 'ftt.chatReady']),
        note: '已处理 / 未摘要 / 台账健康 / 覆盖（`host/floors.js#processedStats` / `#ledgerHealth` · `core/floor-cover.js`）',
    }),
    Object.freeze({
        no: 8, name: '注入与召回事实', status: 'ok',
        outlets: Object.freeze(['ftt.chunkPlan', 'ftt.plotScope', 'inject', 'injectLength']),
        note: '§5 记「⚠️ 部分」：注入键 / 长度有；「为什么没进上下文」只有部分（`docs/D28` §3.5 的可解释口径）——出口已具备，故 status 为 ok',
    }),
    Object.freeze({
        no: 9, name: 'AI 调用与用量', status: 'ok',
        outlets: Object.freeze(['ftt.tokenCost', 'aiUsage', 'aiUsageRecent']),
        note: '模型 / token / 花费 / 失败（`core/token-cost.js` · 管线状态）',
    }),
    Object.freeze({
        no: 10, name: '错误与异常', status: 'ok',
        outlets: Object.freeze(['ftt.errors', 'ftt.trace', 'ftt.debugLog', 'ftt.debugLogStats', 'dbgErrors', 'dbgErrorCount', 'dbgLastError', 'errCaptureState']),
        note: '时间线 `error` 类（100 条）+ 上下文窗口 20；`debugLogErrors` 的 kind=异常 子集',
    }),
    Object.freeze({
        no: 11, name: '性能与卡顿', status: 'ok',
        outlets: Object.freeze(['data-ftt-sec="perf"', 'ftt.perf', 'ftt.perfJank', 'perf']),
        note: '`docs/D31` §5 的历史结论是 ❌（现状无，`docs/D17` U191）；v3.45.4 `技-39` + `技-42` 把探针接入后本类**转绿**（调试页 `data-ftt-sec="perf"` 分节 + 桥 `ftt.perf` / `ftt.perfJank` + 导出字段 `perf`）。**实时**判定仍以 `scripts/check-debug-coverage.js` 为准（它读源码算出口是否存在）',
    }),
    Object.freeze({
        no: 12, name: '优化事项清单', status: 'ok',
        outlets: Object.freeze(['data-ftt-sec="perf"', 'ftt.perfTargets', 'ftt.perfBaseline', 'perf']),
        note: '`docs/D31` §5 的历史结论是 ❌（`docs/D17` U196）；`技-39` + `技-40` + `技-42` 接入后本类**转绿**（桥 `ftt.perfTargets` / `ftt.perfBaseline` + 导出字段 `perf`）。清单**只输出候选、不自动开单**（§4.2）；实时判定以门禁脚本为准',
    }),
]);

/** 12 类必要内容副本（`[{no, name, outlets, status, note}]`） */
export function requiredContentList() {
    return REQUIRED_CONTENT.map((it) => ({
        no: it.no, name: it.name, outlets: it.outlets.slice(), status: it.status, note: it.note,
    }));
}

// ============================================================
// 六、只读清单（§3.6 统一只读纪律 · §8 Q4 裁决）
//
// 判据（§1.1）：「某入口是不是只读」不看文档措辞，看**白名单里有没有它**。因此本清单的
//   「调试桥」那一组必须与 `ui/debug.js#buildBridgeMethods` 的实际方法名**逐字对齐**
//   （单测做集合比对，差异 0）；`FTT.*` 额外列出只读子集。
// Q4 裁决（写进 `note`，且由单测做**反向判据**）：
//   **清空型动作（`dbgClear` / `traceClear` / …）保留在面板与命令里（走既有二次确认），
//   永不进桥白名单** —— 桥里出现任何一个 `kind:'clear'` 的名字就是违规。
// ============================================================
const BRIDGE_WHERE = '调试桥白名单（ui/debug.js#buildBridgeMethods）';
const FTT_WHERE = '调试导出 FTT.*（devtools.js#installDevtools）';
const PANEL_WHERE = '调试页 / 数据管理页 → 面板动作（ui/debug.js#DEBUG_ACTIONS 等，走既有二次确认）';

/** 桥方法：`ftt.*`（插件事实） */
const BRIDGE_FTT = Object.freeze([
    'ftt.snapshot', 'ftt.probe', 'ftt.stateSize', 'ftt.debugLogStats', 'ftt.debugPageInfo', 'ftt.traceStats',
    'ftt.clockTraceInfo', 'ftt.clockTraceSummary', 'ftt.fileTransport', 'ftt.localDir', 'ftt.diskProbe', 'ftt.diskFiles',
    'ftt.chatMeta', 'ftt.memoryShape', 'ftt.memorySample', 'ftt.ledger', 'ftt.chatReady', 'ftt.pendingScan',
    'ftt.pendingFloors', 'ftt.floorDiag', 'ftt.plotScope', 'ftt.chunkPlan', 'ftt.dataHealth', 'ftt.dataHealthText',
    // v3.50.1（`docs/D22` W4 `数-16`）：**卫生面**单列一行（体检四项：归属缺失 / 失锚关联 / 空壳 / 墓碑比）
    'ftt.dataHealthHygiene',
    // v3.50.28（`docs/D22` W28 `技-28`）：**全量操作节流与可观测**（扫描量 / 耗时 / 命中 / 分批 / 到期）
    'ftt.scanStats',
    'ftt.writeStats', 'ftt.loadDiag', 'ftt.reads', 'ftt.readLedgerText', 'ftt.conflicts', 'ftt.conflictLog',
    // v3.45.4（`技-40` / `技-41` ⑥）：性能卡顿只读四件套 + 只读清单 / 口径汇总（同样**只读**）
    'ftt.perf', 'ftt.perfJank', 'ftt.perfTargets', 'ftt.perfBaseline', 'ftt.readonly', 'ftt.catalog',
    // v3.46.0（`docs/D22` W9 `数-31`）：本次保存的物理写清单（只读；逐通道 次数/字节/跳过原因）
    'ftt.writeLedger',
    // v3.45.9（`docs/D22` W5 `技-26` 真机核对）：宿主输入框写入能力的**只读**出口（探针 + 候选 DOM 事实 + 克隆体演练）
    'ftt.inputBox',
    'ftt.tokenCost', 'ftt.debugLog', 'ftt.trace', 'ftt.errors', 'ftt.entries', 'ftt.search', 'ftt.config',
    'ftt.floors', 'ftt.syncLog',
]);
/** 桥方法：`sys.*`（桥与环境自身） */
const BRIDGE_SYS = Object.freeze(['sys.info', 'sys.methods', 'sys.host', 'sys.bridgeState', 'sys.batch', 'sys.ping']);
/** 桥方法：`host.*`（宿主能力，经 `api.dev` 特性检测；缺失回 `available:false`，不抛） */
const BRIDGE_HOST = Object.freeze([
    'host.frontendLogsList', 'host.consoleCaptureGet', 'host.backendLogsTail', 'host.llmLogsIndex',
    'host.llmLogsPreview', 'host.llmLogsRaw', 'host.llmLogsKeep',
]);
/** `FTT.*` 只读子集（写入口与清空型动作**不在此列**；诊断相关为主） */
const FTT_READ = Object.freeze([
    'version', 'dataVersion', 'snapshot', 'status', 'probe', 'interceptor', 'injectLength', 'inputBox', 'inputBoxSteps',
    'perf', 'perfJank', 'perfTargets', 'perfBaseline', 'readonly', 'debugCatalog', 'update', 'importStatus',
    'pendingFloors', 'extractStatus', 'lastExtract', 'lastPreflight', 'i18n', 'folderInfo', 'panelInfo', 'menuInfo',
    'floatingInfo', 'popupInfo', 'panelTabs', 'syncStatus', 'syncInfo', 'syncLog', 'syncLogServerStatus', 'syncSource',
    'slimInfo', 'crossComputeInfo', 'crossPendingGet', 'crossPendingView', 'crossPullPolicy', 'storageEnvelope',
    'storageHash', 'storageEnvValid', 'relInvalidStats', 'reads', 'readsText', 'aiUsage', 'aiUsageRecent', 'loadInfo',
    'clockUi', 'clockTrace', 'clockTraceAll', 'clockTraceSummary', 'clockSrcLabel', 'clockSrcLabels', 'clockAnchor',
    'clockScan', 'clockManual', 'clockResolve', 'clockExtractState', 'clockExtractSchedule', 'clockHeader',
    'clockScene', 'clockRepairPack', 'nsfwState', 'nsfwFixed', 'nsfwScan', 'nsfwHits', 'nsfwApply', 'nsfwKeywords',
    'nsfwRules', 'nsfwAnalyzeState', 'nsfwAnalyzePack', 'nsfwAnalyzeScan', 'nsfwAnalyzeFilter', 'nsfwAnalyzeSeen',
    'forgetState', 'lowUseGate', 'repairReport', 'repairLog', 'repairTotal', 'repairGateTake', 'repairGateDue',
    'repairIsGarbage', 'repairBanned', 'repairDedupe', 'repairPrune', 'latestFloorHash', 'repairCandidates',
    'repairPrompt', 'repairDefect', 'repairCorr', 'repairTags', 'repairJaccard', 'repairFailArmed', 'rumorTick',
    'rumorEnabled', 'rumorEveryRounds', 'rumorNeedRounds', 'rumorRoll', 'rumorDecayScore', 'rumorExpired',
    'rumorInjLine', 'flattenRumor', 'dbgDump', 'dbgErrors', 'dbgErrorCount', 'dbgLastError', 'errCaptureState',
    'apiChannelSummary', 'apiChannelAvailability', 'apiProfiles', 'apiTarget', 'apiPresetNames', 'vectorLayerInfo',
    'vectorLayerStatus', 'vectorTarget', 'vectorCacheStats', 'aiLayerInfo', 'worldbookEntries', 'worldbookKeys',
    'worldbookIsFttEntry', 'worldbookLegacyEntryName', 'worldbookTotalBytes', 'worldbookMemoryTotal',
    'worldbookSyncState', 'worldbookNames', 'relMaintCounts', 'relMaintTouched', 'relMaintSummary', 'mergeRelMaint',
    'demoteRelLinkOrphans', 'groupSpecs', 'groupSpec', 'groupRelatedness', 'groupClusters', 'groupPick',
    'memoryMergeExact', 'memoryRepairPrompt', 'conceptMergeExact', 'conceptRelatedness', 'conceptClusters',
    'conceptPickClusters', 'conceptRepairPrompt', 'sceneRepairPrompt', 'isCurrencyItemName', 'itemMergeExact',
    'itemLowUsesPurge', 'itemRepairPrompt', 'snapRepairFields', 'snapRepairFieldMap', 'snapshotAtomSize',
    'characterRepairQueue',
]);
/** 清空型 / 恢复型 / 导入覆盖型动作（Q4：**永不进桥白名单**） */
const CLEAR_ACTIONS = Object.freeze([
    'dbgClear', 'dbgTraceClear', 'readLedgerClear', 'clockTraceClear', 'debugLogClear', 'traceClear',
    'resetReadLedger', 'clearConflicts', 'resetConflicts', 'syncLogClear', 'readsClear', 'crossPendingClear',
    'clockManualClear', 'nsfwKeywordReset', 'nsfwRuleReset', 'nsfwAnalyzeSeenReset', 'clearRumors', 'clearFloors',
    'vectorCacheClear', 'syncDropCache', 'relCleanInvalid', 'importV1', 'importState',
]);

/** 清空型动作的 `note`（Q4 裁决的**原文口径**，逐字保留以便单测与门禁共用同一句话） */
const CLEAR_NOTE = '清空型动作：永不进桥白名单（`docs/D31` §8 Q4 裁决）；只在面板 / 命令里，走既有二次确认';

/** 构造一行只读清单（冻结） */
function ro(group, name, kind, where, note) {
    return Object.freeze({ group: group, name: name, kind: kind, where: where, note: note });
}
/** 「恢复 / 导入覆盖」类的补充说明（与纯清空略不同，避免一句话掩盖写面） */
const CLEAR_NOTE_WRITE = CLEAR_NOTE + '；本条属**有意为之的写入口**（导入覆盖 / 清理写墓碑），同样不进桥';

/** 只读清单（只读类别与清空型动作**分列**；只用 `kind:'read'|'clear'` 两种取值） */
export const READONLY_OUTLETS = Object.freeze(
    BRIDGE_FTT.map((n) => ro('调试桥 · 插件事实（ftt.*）', n, 'read', BRIDGE_WHERE, '只读：未登记即拒；桥**不得有写方法**（§1.1 判据）'))
        .concat(BRIDGE_SYS.map((n) => ro('调试桥 · 桥与环境（sys.*）', n, 'read', BRIDGE_WHERE, '只读：桥自身与环境读数（`sys.info` / `sys.methods` / `sys.ping` …）')))
        .concat(BRIDGE_HOST.map((n) => ro('调试桥 · 宿主能力（host.*）', n, 'read', BRIDGE_WHERE, '只读：经 `api.dev` 特性检测；宿主缺失时回 `available:false`，不抛')))
        .concat(FTT_READ.map((n) => ro('调试导出 FTT.*（只读入口）', n, 'read', FTT_WHERE, '只读入口（写入口与清空型动作不列在此组）')))
        .concat(FTT_READ.filter((n) => n === 'snapshot' || n === 'status')
            .map((n) => ro('调试导出区块（devtools.js#buildSnapshot）', n, 'read', FTT_WHERE, '调试导出区块字段（与 FTT.* 同源；§5 的「调试导出字段名」出口）')))
        .concat(CLEAR_ACTIONS.map((n) => ro(
            '清空型动作（面板 / 命令 · 不进桥）', n, 'clear', PANEL_WHERE,
            (n === 'importV1' || n === 'importState' || n === 'relCleanInvalid' || n === 'vectorCacheClear' || n === 'syncDropCache') ? CLEAR_NOTE_WRITE : CLEAR_NOTE,
        )))
        .map((it) => Object.freeze(it)),
);

/** 只读清单副本（`[{group, name, kind, where, note}]`） */
export function readonlyOutletList() {
    return READONLY_OUTLETS.map((it) => ({ group: it.group, name: it.name, kind: it.kind, where: it.where, note: it.note }));
}

// ============================================================
// 七、汇总读数与人读摘要（供桥 / 页面 / 导出**消费**，见 §3.8「一处计算 + 出口透传」）
// ============================================================
/**
 * 调试面口径汇总（三处出口共用同一形状）。
 * @returns {{version:string, kinds:number, caps:number, traceFields:string[], required:number,
 *   requiredGaps:string[], readonly:{total:number,read:number,clear:number}, unregisteredKinds:Array<object>}}
 */
export function debugCatalogReport() {
    let ro = [];
    try { ro = readonlyOutletList(); } catch (e) { ro = []; }
    let unreg = [];
    try { unreg = (typeof unregisteredReader === 'function') ? (unregisteredReader() || []) : []; } catch (e) { unreg = []; }
    let req = [];
    try { req = requiredContentList(); } catch (e) { req = []; }
    return {
        version: VERSION,
        kinds: DEBUG_KINDS.length,
        caps: DEBUG_CAPS.length,
        traceFields: TRACE_FIELDS.slice(),
        required: req.length,
        requiredGaps: req.filter((x) => x.status !== 'ok').map((x) => x.name),
        readonly: {
            total: ro.length,
            read: ro.filter((x) => x.kind === 'read').length,
            clear: ro.filter((x) => x.kind === 'clear').length,
        },
        unregisteredKinds: (Array.isArray(unreg) ? unreg : []).slice(),
    };
}

/** 人读摘要（≤ 200 字；给页面一行提示与调试包抬头用） */
export function debugCatalogText() {
    try {
        const r = debugCatalogReport();
        const gaps = r.requiredGaps.length ? r.requiredGaps.join('、') : '无';
        const un = r.unregisteredKinds.length ? String(r.unregisteredKinds.length) : '0';
        const s = '调试面口径（唯一事实源 core/debug-catalog.js · v' + r.version + '）：'
            + 'kind ' + r.kinds + ' 类（未登记 ' + un + '）· CAP ' + r.caps + ' 行 · '
            + '追溯六字段 ' + r.traceFields.join('/') + ' · 必要内容 ' + r.required + ' 类（声明缺口：' + gaps + '）· '
            + '只读出口 ' + r.readonly.read + ' 项 + 清空型 ' + r.readonly.clear + ' 项（永不进桥，Q4）';
        return s.length > 200 ? (s.slice(0, 199) + '…') : s;
    } catch (e) {
        return '调试面口径：读数失败（' + String((e && e.message) || e) + '）';
    }
}

export {
    BRIDGE_FTT, BRIDGE_SYS, BRIDGE_HOST, FTT_READ, CLEAR_ACTIONS, CLEAR_NOTE,
};
