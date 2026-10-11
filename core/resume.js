// ============================================================
// core/resume.js —— **角色履历（`snapshots[].resume`）的唯一算法源**（v3.45.5，`docs/D22` W4 `数-19`/`数-20`/`数-21`，设计稿 `docs/D26`）
//
// 定位：履历是**角色档案（`snapshots`）内的第 9 个区块**（不是新维度，`docs/D26` §3.2）——
//   `resume: ResumeEntry[]`，每条 = 该角色按**剧情时间**的一条「大事记」。
//   本模块是**纯内核**：只做归一 / 排序 / 去重 / 留存（遗弃）/ 凝练 / 统计 / 体检读数 / 提示词文本，
//   **不读任何宿主**（无 DOM / 无定时器 / 不读现实墙钟），时间一律由调用方传入「剧情时间」。
//
// 为什么不写进 `core/model/snapshot.js`（与 `docs/D26` §8 的落点写法有一处**有意差异**，已登记）：
//   · `core/model/snapshot.js` 是**逐字移植自 V1** 的档案模块（算法/字段顺序被 `tests/unit/model-golden*.test.js`
//     与 `snapshot-golden.test.js` 逐字符锁定）；把约 300 行**新算法**塞进去会让「V1 移植面」与「V2 新增面」
//     在同一文件里互相干扰，也让 golden 的失败无法区分「移植面被改坏」还是「新增面写错」；
//   · 履历算法要被 `core/model/snapshot.js`（归一）、`core/character-repair.js`（修复编排）、
//     `core/data-health.js`（体检）、`ui/*`（展示）**四处** import —— 独立叶子模块是最小耦合形态。
//   落点差异与理由已写进 `docs/D26` v1.2 §8 与 `docs/history/P10c85`，并按 `docs/D22` §0 的口径登记。
//
// 口径来源（`docs/D26` §3.2 / §3.3 / §3.4 / §6 决策记录）：
//   · `ResumeEntry` = `{ date, time, summary, importance, refs?, source? }`；`date`/`summary` **必填**（缺则不入库）；
//   · **进内容副本（身份指纹）**：`date` + `summary` + `source`；`importance` / `refs` **不进**（Q1）；
//   · **不递增 `DATA_VERSION`**（加可选字段 + 归一补默认 `[]`；老存档读到 `undefined` 视为空）；
//   · **无墓碑 / 无复活抑制**（Q2）：遗弃就是数组变短，跨端随档案整体按 `updatedAt` 取新；
//   · 上限 **30** 为**软阈值**（Q3）：`≤ 上限` **从不**自动遗弃，仅在**超限**时清算；
//   · 凝练目标 **≤ 60 字**（Q4），**幂等**，只压 `summary`，不动 `date` / `time` / `importance` / `refs`；
//   · `identity.canon` 为**新增三态字段**（Q5），历史 / 同人预填的硬护栏见 §3.4（上界 = 剧情当下）。
//
// ⚠️ 一处**设计稿自相矛盾**（本轮实测发现，已按纪律登记为 `docs/D17` **U218**）：
//   `docs/D26` §3.3 的「触发」写「条数 > 上限 × 触发比例 时清算」，而其 §6 决策记录 Q3 又写「≤ 30 时**从不**自动遗弃」——
//   两者在 `25..30` 条区间**不能同真**（比例 0.8 × 30 = 24，按前者会在 25 条就开删，按后者一条不删）。
//   本模块取**对用户数据更安全**的那条（Q3 优先）：**只有 `len > max` 才真的遗弃**；
//   `triggerRatio` 保留其**非破坏性**语义 —— ① 体检 / 面板的「接近上限」预警线；② 进入清算检查的阈值（`25..30` 时检查结果是空操作）。
import { storyDateMsFromStr } from './clock.js';
import { calcTimeDecay } from './decay.js';

export const RESUME_FIELD = 'resume';
/** 履历条目的来源枚举（`docs/D26` §3.2 字段表 `source` 行） */
export const RESUME_SOURCES = Object.freeze(['story', 'canon', 'manual']);
/** 默认上限（`cfg.snapshotResumeMax` 的兜底；`docs/D26` Q3：**软阈值**） */
export const RESUME_DEFAULT_MAX = 30;
/** 默认「接近上限」预警比例（`cfg.snapshotResumeTriggerRatio` 的兜底） */
export const RESUME_DEFAULT_TRIGGER_RATIO = 0.8;
/** 默认「重要性免疫」阈值（`cfg.snapshotResumeImmune` 的兜底；`docs/D26` §3.3 建议 0.7） */
export const RESUME_DEFAULT_IMMUNE = 0.7;
/** 默认凝练目标长度（`cfg.snapshotResumeSummaryMax` 的兜底；`docs/D26` Q4：≤60 字） */
export const RESUME_DEFAULT_SUMMARY_MAX = 60;
/** `date` / `time` 归一上限（与剧情时钟的写法一致：`1919-11-29` / `-0221-01-02`） */
export const RESUME_DATE_MAX = 12;
export const RESUME_TIME_MAX = 30;
/** `summary` 的**归一硬上限**（防 AI 一次写进一整段；凝练目标另由 `summaryMax` 控制，默认 60） */
export const RESUME_SUMMARY_HARD_MAX = 200;
/** 单条履历最多登记的关联记忆 id 数（`refs`；引用类字段，不进哈希） */
export const RESUME_REFS_MAX = 8;
/** 凝练时优先取词的**句读边界**（先句末，再分句，最后顿号级；都没有才硬截） */
const RESUME_CUT_MARKS = ['。', '！', '？', '；', '…', '.', '!', '?', ';', '，', ',', '、'];

const clamp01 = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};
const str = (v, max) => {
    const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    return max ? s.slice(0, max) : s;
};

/**
 * `source` 归一为枚举；未知 / 缺省 → `'story'`（剧情内抽取是默认来源）。
 * @param {*} v
 * @returns {'story'|'canon'|'manual'}
 */
export function resumeSourceNorm(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return 'story';
    if (RESUME_SOURCES.indexOf(s) >= 0) return s;
    // 中文 / 别名宽容（AI 输出与用户手填都可能写中文）
    if (/^(canon|原作|史实|设定|官方|原著|既有生平|历史)$/.test(s)) return 'canon';
    if (/^(manual|手填|手动|用户|人工|编辑)$/.test(s)) return 'manual';
    if (/^(story|剧情|抽取|正文|本剧情)$/.test(s)) return 'story';
    return 'story';
}

/**
 * 单条履历归一（`docs/D26` §3.2 字段表）。
 *   · `date` / `summary` **必填** —— 任一为空 → 返回 `null`（该条**不予入库**，设计稿明确要求）；
 *   · `importance` 缺省 `null`（**不猜**）：缺省条目在遗弃判据里按 `0` 参与，但免疫判定要求显式 ≥ 阈值；
 *   · `refs` 去重、去空、夹取 `RESUME_REFS_MAX` 条；
 *   · `time` 可空；`source` 归一为枚举。
 * @param {object} raw
 * @returns {{date:string,time:string,summary:string,importance:(number|null),refs:string[],source:string}|null}
 */
export function resumeEntryNorm(raw) {
    try {
        if (!raw || typeof raw !== 'object') return null;
        // 宽容吃中文键（AI / 手填都可能写中文；与 `core/character-repair.js` 的中文点路径口径一致）
        const src = raw;
        const date = str(src.date != null ? src.date : (src['日期'] != null ? src['日期'] : src['剧情日期']), RESUME_DATE_MAX);
        const summary = str(src.summary != null ? src.summary : (src['简述'] != null ? src['简述'] : src['内容']), RESUME_SUMMARY_HARD_MAX);
        if (!date || !summary) return null;                      // 必填缺失 → 不入库
        const time = str(src.time != null ? src.time : src['时刻'], RESUME_TIME_MAX);
        const impRaw = src.importance != null ? src.importance : src['重要性'];
        let importance = null;
        if (impRaw !== undefined && impRaw !== null && String(impRaw).trim() !== '') {
            const n = Number(impRaw);
            if (Number.isFinite(n)) importance = clamp01(n);
            else if (typeof impRaw === 'string' && /%$/.test(impRaw.trim())) importance = clamp01(Number(impRaw.trim().replace('%', '')) / 100);
        }
        const refsRaw = src.refs != null ? src.refs : (src['关联'] != null ? src['关联'] : src['关联记忆']);
        const refs = [];
        for (const r of (Array.isArray(refsRaw) ? refsRaw : (refsRaw ? [refsRaw] : []))) {
            const id = str(r, 64);
            if (id && refs.indexOf(id) < 0) refs.push(id);
            if (refs.length >= RESUME_REFS_MAX) break;
        }
        return { date: date, time: time, summary: summary, importance: importance, refs: refs, source: resumeSourceNorm(src.source != null ? src.source : src['来源']) };
    } catch (e) { return null; }
}

/**
 * 履历数组归一：逐条校验 → 去重（`date + summary` 哈希键）→ 剧情时间倒序。
 * **幂等**：归一后的数组再归一逐字一致（`数-19` 验收）。
 * @param {*} raw
 * @param {{max?:number}} [opts] `max` = 只保留前 N 条（缺省不截断 —— 截断由 `resumeCull` 按留存判据做）
 * @returns {Array<object>}
 */
export function resumeNormList(raw, opts) {
    const o = opts || {};
    const arr = Array.isArray(raw) ? raw : [];
    const out = [];
    const seen = Object.create(null);
    for (const it of arr) {
        const e = resumeEntryNorm(it);
        if (!e) continue;
        const key = resumeDedupeKey(e);
        if (seen[key]) continue;                                  // 数组内去重（不跨条目，`docs/D26` §3.2 第 4 项）
        seen[key] = 1;
        out.push(e);
    }
    const sorted = resumeSort(out);
    const max = Number(o.max);
    return (Number.isFinite(max) && max > 0) ? sorted.slice(0, Math.floor(max)) : sorted;
}

/** 数组内去重键：`date + summary` 的确定性哈希（`docs/D26` §3.2 第 4 项 —— 不引入独立 id） */
export function resumeDedupeKey(e) {
    try { return String((e && e.date) || '') + '\u0001' + String((e && e.summary) || ''); } catch (x) { return ''; }
}

/** 条目的剧情时间毫秒（`date` 为主，`time` 无法参与 → 缺省 `NaN`；公元前为负值是合法的） */
export function resumeStoryMs(e) {
    try {
        if (!e || !e.date) return NaN;
        const ms = storyDateMsFromStr(e.date);
        return Number.isFinite(ms) ? ms : NaN;
    } catch (x) { return NaN; }
}

/**
 * 排序：**剧情时间倒序**（`docs/D26` §3.5 展示口径），确定性 tie-break：
 *   ① `date` 晚者在前；② 同日期时 `importance` 高者在前（`null` 记 0）；③ 再同则 `summary` 字典序升序。
 *   `date` 解析不出毫秒的条目**排在最后**（不静默丢弃），组内仍按 ②③ 排。
 * @param {Array} list
 * @returns {Array} 新数组（不改入参）
 */
export function resumeSort(list) {
    const arr = (Array.isArray(list) ? list : []).slice();
    const key = (e) => { const ms = resumeStoryMs(e); return Number.isFinite(ms) ? ms : -Infinity; };
    return arr.sort((a, b) => {
        const ka = key(a), kb = key(b);
        if (ka !== kb) return kb - ka;
        const ia = a && a.importance != null ? Number(a.importance) : 0;
        const ib = b && b.importance != null ? Number(b.importance) : 0;
        if (ia !== ib) return ib - ia;
        return String((a && a.summary) || '') < String((b && b.summary) || '') ? -1
            : (String((a && a.summary) || '') > String((b && b.summary) || '') ? 1 : 0);
    });
}

/**
 * 留存分：`keep = importance × timeWeight(剧情时间距今)`（`docs/D26` §3.3）。
 *   时间基准**一律剧情时间**；时间权重复用既有多级衰退函数（`core/decay.js#calcTimeDecay`，`docs/D18` §4），
 *   取 `1 - decay` —— 越接近剧情当下越接近 1，越久远越接近 0。
 *   `importance` 缺省按 0（**不猜**：没有标注就没有留存分，由时间决定）。
 * @param {object} e 履历条目
 * @param {{nowMs?:number, earliestMs?:number, count?:number}} [ctx] 全部为**剧情时间毫秒**
 * @returns {number} 0..1
 */
export function resumeKeepScore(e, ctx) {
    try {
        const c = ctx || {};
        const nowMs = Number(c.nowMs);
        if (!Number.isFinite(nowMs)) return 0;                    // 无剧情时钟 → 不判（调用方应整体短路）
        const ms = resumeStoryMs(e);
        const decay = Number.isFinite(ms) ? calcTimeDecay(c.earliestMs, nowMs, nowMs, ms, c.count) : 0;
        const w = Math.min(1, Math.max(0, 1 - decay));
        const imp = (e && e.importance != null) ? clamp01(e.importance) : 0;
        return clamp01(imp * w);
    } catch (x) { return 0; }
}

/** 从配置取履历口径（缺省/非法一律回落默认值 —— 与其它维「上限 × 比例」同款宽容度） */
export function resumeOptsFromCfg(c) {
    const cfg = c || {};
    const num = (v, def) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : def; };
    return {
        enabled: cfg.snapshotResumeEnabled !== false,
        max: Math.floor(num(cfg.snapshotResumeMax, RESUME_DEFAULT_MAX)),
        triggerRatio: Math.min(1, Math.max(0.1, num(cfg.snapshotResumeTriggerRatio, RESUME_DEFAULT_TRIGGER_RATIO))),
        immune: clamp01(cfg.snapshotResumeImmune != null ? cfg.snapshotResumeImmune : RESUME_DEFAULT_IMMUNE),
        summaryMax: Math.floor(num(cfg.snapshotResumeSummaryMax, RESUME_DEFAULT_SUMMARY_MAX)),
        canonFill: cfg.snapshotResumeCanonFill !== false,
    };
}

/**
 * **遗弃清算**（`docs/D26` §3.3；`数-20` 验收：构造 40 条 → 裁到 ≤ 上限且高重要条目全留；同输入两次结果一致；≤ 上限时不动）。
 *
 * 触发（本模块的实际口径，见文件头那段「设计稿自相矛盾」）：
 *   · `len <= max` → **不动**（Q3 硬规则；此时 `checked:false`）；
 *   · `len > max` → 清算到 `max` 条。
 * 遗弃顺序（确定性）：`keep` 最低者先走 → 同分**更久远者**先走 → 再同分按 `summary` 字典序。
 * 免疫：`importance >= immune` 的条目**永不**自动遗弃（无论多久远）。
 * @param {Array} list 已归一的履历数组
 * @param {{max?:number, immune?:number, triggerRatio?:number, nowMs?:number}} [opts]
 * @returns {{list:Array, dropped:Array, checked:boolean, nearLimit:boolean, max:number, immuneKept:number}}
 */
export function resumeCull(list, opts) {
    const o = opts || {};
    const max = Math.max(1, Math.floor(Number(o.max) || RESUME_DEFAULT_MAX));
    const immune = (o.immune != null) ? clamp01(o.immune) : RESUME_DEFAULT_IMMUNE;
    const ratio = Math.min(1, Math.max(0.1, Number(o.triggerRatio) || RESUME_DEFAULT_TRIGGER_RATIO));
    const sorted = resumeSort(Array.isArray(list) ? list : []);
    const nearLimit = sorted.length >= Math.max(1, Math.ceil(max * ratio));
    if (sorted.length <= max) {
        return { list: sorted, dropped: [], checked: false, nearLimit: nearLimit, max: max, immuneKept: 0 };
    }
    const nowMs = Number(o.nowMs);
    const msList = sorted.map((e) => resumeStoryMs(e)).filter((x) => Number.isFinite(x));
    const earliestMs = msList.length ? Math.min.apply(null, msList) : undefined;
    const count = sorted.length;
    // 免疫者先摘出（永不参与遗弃），其余按 keep 升序排队
    const protectedIdx = [];
    const candidates = [];
    sorted.forEach((e, i) => {
        const imp = (e && e.importance != null) ? clamp01(e.importance) : 0;
        if (imp >= immune) { protectedIdx.push(i); return; }
        candidates.push({ i: i, keep: resumeKeepScore(e, { nowMs: nowMs, earliestMs: earliestMs, count: count }), ms: resumeStoryMs(e), summary: String((e && e.summary) || '') });
    });
    candidates.sort((a, b) => (a.keep - b.keep)
        || ((Number.isFinite(a.ms) ? a.ms : Infinity) - (Number.isFinite(b.ms) ? b.ms : Infinity))
        || (a.summary < b.summary ? -1 : (a.summary > b.summary ? 1 : 0))
        || (a.i - b.i));
    const need = Math.max(0, sorted.length - max);
    const dropSet = Object.create(null);
    for (let k = 0; k < candidates.length && k < need; k++) dropSet[candidates[k].i] = 1;
    // 极端情况：需要删的比可删的还多（几乎所有条目都免疫）→ 免疫优先，少删也不能删免疫项
    const kept = [];
    const dropped = [];
    sorted.forEach((e, i) => { (dropSet[i] ? dropped : kept).push(e); });
    return { list: kept, dropped: dropped, checked: true, nearLimit: nearLimit, max: max, immuneKept: protectedIdx.length };
}

/**
 * **机械凝练**（`docs/D26` §3.3 / Q4；`数-20` 验收：凝练二次运行无变化）。
 *   只压 `summary`，**不新增信息**、不动 `date` / `time` / `importance` / `refs` / `source`；
 *   优先在**句读边界**收口（先句末 → 分句 → 顿号级），都找不到才硬截并在末尾加 `…`；
 *   **幂等**：结果长度 ≤ 目标 → 再跑一次逐字不变。
 * @param {string} summary
 * @param {number} [max] 目标长度（默认 60）
 * @returns {{text:string, changed:boolean}}
 */
export function resumeCondenseText(summary, max) {
    const limit = Math.max(8, Math.floor(Number(max) || RESUME_DEFAULT_SUMMARY_MAX));
    const s = String(summary == null ? '' : summary).replace(/\s+/g, ' ').trim();
    if (!s || s.length <= limit) return { text: s, changed: false };
    let cut = -1;
    for (const mk of RESUME_CUT_MARKS) {
        const at = s.lastIndexOf(mk, limit - 1);
        if (at >= Math.floor(limit / 2)) { const end = at + mk.length; if (end > cut) cut = end; }
    }
    if (cut > 0) return { text: s.slice(0, cut), changed: true };
    return { text: s.slice(0, Math.max(1, limit - 1)) + '…', changed: true };
}

/**
 * 对整份履历做凝练（`数-20` 步骤⑤）。
 * @param {Array} list
 * @param {{summaryMax?:number}} [opts]
 * @returns {{list:Array, condensed:number}} 新数组 + 实际改动的条数
 */
export function resumeCondense(list, opts) {
    const o = opts || {};
    const limit = Math.max(8, Math.floor(Number(o.summaryMax) || RESUME_DEFAULT_SUMMARY_MAX));
    let condensed = 0;
    const out = (Array.isArray(list) ? list : []).map((e) => {
        const r = resumeCondenseText(e && e.summary, limit);
        if (!r.changed) return e;
        condensed++;
        return Object.assign({}, e, { summary: r.text });
    });
    return { list: out, condensed: condensed };
}

/**
 * **历史 / 同人预填的上界护栏**（`docs/D26` §3.4 硬护栏①；`数-21` 验收：产出条目**全部**在上界之前）。
 *   · 上界 = **剧情时钟当前日期**；无上界（无剧情时钟）→ **一律拒绝**（没有上界就无法保证「不写未来」）；
 *   · `date > clockDate` → 拒收；
 *   · 顺带把该批条目的 `source` 强制为 `'canon'`（护栏②：与剧情内条目在界面上可区分）。
 * @param {Array} list
 * @param {string} clockDate 剧情当下日期（`YYYY-MM-DD` / 公元前负年份写法）；空 → 全部拒绝
 * @returns {{kept:Array, rejected:Array, clockDate:string}}
 */
export function resumeCanonGuard(list, clockDate) {
    const cd = str(clockDate, RESUME_DATE_MAX);
    const kept = [], rejected = [];
    for (const raw of (Array.isArray(list) ? list : [])) {
        const e = resumeEntryNorm(raw);
        if (!e) { rejected.push({ entry: raw, reason: 'invalid' }); continue; }
        if (!cd) { rejected.push({ entry: e, reason: 'no-clock' }); continue; }
        const ms = resumeStoryMs(e), cms = storyDateMsFromStr(cd);
        if (!Number.isFinite(ms) || !Number.isFinite(cms)) { rejected.push({ entry: e, reason: 'bad-date' }); continue; }
        if (ms > cms) { rejected.push({ entry: e, reason: 'future' }); continue; }   // 硬护栏①：不得写入剧情内尚未发生的事
        kept.push(Object.assign({}, e, { source: 'canon' }));                        // 硬护栏②：一律标 canon
    }
    return { kept: resumeSort(kept), rejected: rejected, clockDate: cd };
}

/**
 * 履历统计（单角色；体检 / 面板 / 回报共用，**唯一算法源**）。
 * @param {Array} list
 * @param {{max?:number, triggerRatio?:number, immune?:number, summaryMax?:number, historyText?:string, memoryTexts?:string[]}} [opts]
 * @returns {{total:number, max:number, over:boolean, nearLimit:boolean, immune:number,
 *            bySource:object, orphanRefs:number, dupSuspects:number, longest:number,
 *            condensed:number, clockless:number, dupWithHistory:number}}
 */
export function resumeStats(list, opts) {
    const o = opts || {};
    const max = Math.max(1, Math.floor(Number(o.max) || RESUME_DEFAULT_MAX));
    const ratio = Math.min(1, Math.max(0.1, Number(o.triggerRatio) || RESUME_DEFAULT_TRIGGER_RATIO));
    const immune = (o.immune != null) ? clamp01(o.immune) : RESUME_DEFAULT_IMMUNE;
    const summaryMax = Math.max(8, Math.floor(Number(o.summaryMax) || RESUME_DEFAULT_SUMMARY_MAX));
    const arr = Array.isArray(list) ? list : [];
    const bySource = { story: 0, canon: 0, manual: 0 };
    let imm = 0, orphan = 0, longest = 0, condensed = 0, clockless = 0, dupWithHistory = 0;
    const memIds = (() => {
        const set = Object.create(null);
        for (const t of (Array.isArray(o.memoryTexts) ? o.memoryTexts : [])) set[String(t)] = 1;
        return set;
    })();
    const hasMemIndex = Object.keys(memIds).length > 0;
    const hist = str(o.historyText, 400);
    for (const e of arr) {
        const src = resumeSourceNorm(e && e.source);
        bySource[src] = (bySource[src] || 0) + 1;
        if ((e && e.importance != null ? clamp01(e.importance) : 0) >= immune) imm++;
        const refs = (e && Array.isArray(e.refs)) ? e.refs : [];
        if (hasMemIndex) for (const r of refs) if (!memIds[String(r)]) orphan++;
        const len = String((e && e.summary) || '').length;
        if (len > longest) longest = len;
        if (len > summaryMax) condensed++;                       // 待凝练（超目标长度）
        if (!Number.isFinite(resumeStoryMs(e))) clockless++;      // 日期解析不出的条目（不静默丢弃，但要点名）
        // 疑似重复：`history` 里已含该条简述的前 8 字（`docs/D26` §3.1 分工规则① / 风险 R2）
        if (hist && len >= 8 && hist.indexOf(String(e.summary).slice(0, 8)) >= 0) dupWithHistory++;
    }
    // 同一角色内「简述前 12 字相同」视为疑似重复（体检用；不改数据）
    const seen = Object.create(null);
    let dupSuspects = 0;
    for (const e of arr) {
        const k = String((e && e.summary) || '').slice(0, 12);
        if (!k) continue;
        if (seen[k]) dupSuspects++; else seen[k] = 1;
    }
    return {
        total: arr.length, max: max, over: arr.length > max,
        nearLimit: arr.length >= Math.max(1, Math.ceil(max * ratio)),
        immune: imm, bySource: bySource, orphanRefs: orphan, dupSuspects: dupSuspects,
        longest: longest, condensed: condensed, clockless: clockless, dupWithHistory: dupWithHistory,
    };
}

/**
 * 全库履历体检读数（`数-19`…`技-25` 的「三处出口同源」数据源：面板 / `FTT` 导出 / 调试桥都读它）。
 * @param {Array} snapshots 角色档案数组
 * @param {{max?:number, triggerRatio?:number, immune?:number, summaryMax?:number, memoryIds?:Array<string>}} [opts]
 * @returns {{snapshots:number, withResume:number, total:number, overCount:number, nearCount:number,
 *            orphanRefs:number, dupSuspects:number, dupWithHistory:number, clockless:number,
 *            canonTotal:number, storyTotal:number, manualTotal:number, max:number, items:Array}}
 */
export function resumeHealthReport(snapshots, opts) {
    const o = opts || {};
    const list = Array.isArray(snapshots) ? snapshots : [];
    const out = {
        snapshots: list.length, withResume: 0, total: 0, overCount: 0, nearCount: 0,
        orphanRefs: 0, dupSuspects: 0, dupWithHistory: 0, clockless: 0,
        canonTotal: 0, storyTotal: 0, manualTotal: 0,
        max: Math.max(1, Math.floor(Number(o.max) || RESUME_DEFAULT_MAX)), items: [],
    };
    const memT = Array.isArray(o.memoryIds) ? o.memoryIds : [];
    for (const s of list) {
        const arr = Array.isArray(s && s.resume) ? s.resume : [];
        if (!arr.length) continue;
        out.withResume++;
        const st = resumeStats(arr, {
            max: out.max, triggerRatio: o.triggerRatio, immune: o.immune, summaryMax: o.summaryMax,
            historyText: (s && s.background && s.background.history) || '', memoryTexts: memT,
        });
        out.total += st.total;
        out.canonTotal += st.bySource.canon || 0;
        out.storyTotal += st.bySource.story || 0;
        out.manualTotal += st.bySource.manual || 0;
        out.orphanRefs += st.orphanRefs;
        out.dupSuspects += st.dupSuspects;
        out.dupWithHistory += st.dupWithHistory;
        out.clockless += st.clockless;
        if (st.over) out.overCount++;
        if (st.nearLimit && !st.over) out.nearCount++;
        out.items.push({
            id: String((s && s.id) || ''), name: String((s && s.name) || ''),
            total: st.total, over: st.over, nearLimit: st.nearLimit,
            canon: st.bySource.canon || 0, story: st.bySource.story || 0, manual: st.bySource.manual || 0,
            longest: st.longest, toCondense: st.condensed, orphanRefs: st.orphanRefs,
            dupSuspects: st.dupSuspects, dupWithHistory: st.dupWithHistory, clockless: st.clockless,
            immune: st.immune,
        });
    }
    out.items.sort((a, b) => (b.total - a.total) || (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
    return out;
}

// ==================== 履历机械段的**运行账本**（`docs/D22` W4 `技-25` 的「遗弃计数」读数源） ====================
// `docs/D26` Q2 明确「不需要复活抑制 / 不需要墓碑」→ **不新增任何持久字段**：
//   遗弃与凝练的计数只留在**本次会话内存**里（界面上如实写成「本会话内」），重启即归零。
//   账本放在本模块（而不是修复管道里）是为了让**体检**（`core/data-health.js`）只依赖纯内核就能读到它 ——
//   避免「只读体检」反过来依赖「修复管道」造成的层次倒挂。
let resumeLedger = { runs: 0, snapshots: 0, normalized: 0, dropped: 0, condensed: 0, lastAt: 0, last: null };
/** 记一次履历机械段（由 `core/character-repair.js#resumeMechanicalPass` 调用） */
export function resumeLedgerRecord(stat) {
    const s = stat || {};
    resumeLedger.runs++;
    resumeLedger.snapshots += Number(s.snapshots) || 0;
    resumeLedger.normalized += Number(s.normalized) || 0;
    resumeLedger.dropped += Number(s.dropped) || 0;
    resumeLedger.condensed += Number(s.condensed) || 0;
    resumeLedger.lastAt = Date.now();
    resumeLedger.last = {
        at: resumeLedger.lastAt, snapshots: Number(s.snapshots) || 0, normalized: Number(s.normalized) || 0,
        dropped: Number(s.dropped) || 0, condensed: Number(s.condensed) || 0, changed: Number(s.changed) || 0,
    };
    return resumeLedgerState();
}
/** 账本只读快照（体检 / 面板 / 命令**同源**：三处都读它，不各算一份） */
export function resumeLedgerState() {
    return Object.assign({}, resumeLedger, { last: resumeLedger.last ? Object.assign({}, resumeLedger.last) : null });
}
/** 清空账本（调试 / 测试用；**不动任何履历数据**） */
export function resumeLedgerReset() {
    resumeLedger = { runs: 0, snapshots: 0, normalized: 0, dropped: 0, condensed: 0, lastAt: 0, last: null };
    return resumeLedgerState();
}

/** 单条履历的人读行（面板 / 导出 / 命令**同源**：`1919-11-29 · 简述（重要 0.8 · 关联 2）`） */export function resumeEntryLine(e) {
    try {
        const bits = [];
        if (e && e.date) bits.push(String(e.date));
        if (e && e.time) bits.push(String(e.time));
        const head = bits.join(' ');
        const imp = (e && e.importance != null) ? Number(e.importance) : null;
        const meta = [];
        if (imp !== null && Number.isFinite(imp)) meta.push('重要 ' + imp);
        const refs = (e && Array.isArray(e.refs)) ? e.refs.length : 0;
        if (refs) meta.push('关联 ' + refs);
        if (e && e.source === 'canon') meta.push('原作');
        else if (e && e.source === 'manual') meta.push('手填');
        return head + (head ? ' · ' : '') + String((e && e.summary) || '') + (meta.length ? ('（' + meta.join(' · ') + '）') : '');
    } catch (x) { return ''; }
}

/**
 * 履历的**提示词文本**（`业-7`：修复提示词里的「履历」契约段 + 已存在条目的去重依据）。
 *   只输出 `date` / `summary` / `importance` / `source` 与 `refs` 的**条数**，
 *   **不回正文之外的任何字段**、不带正文（履历本身就是要给 AI 看的简述，属设计内）。
 * @param {Array} list
 * @param {{limit?:number, withHeader?:boolean}} [opts]
 */
export function resumeToPromptText(list, opts) {
    const o = opts || {};
    const limit = Math.max(1, Math.floor(Number(o.limit) || RESUME_DEFAULT_MAX));
    const arr = resumeSort(list).slice(0, limit);
    if (!arr.length) return o.withHeader === false ? '' : '（暂无履历）';
    return arr.map((e) => '- ' + resumeEntryLine(e)).join('\n');
}
