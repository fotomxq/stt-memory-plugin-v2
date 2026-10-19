// ============================================================
// core/data-health.js —— **数据体检（只读）**（v3.13.0，用户要求「核对存在的 BUG 和数据异常」）
//
// 定位：给本地调试端口（调试桥 `ftt.dataHealth`）、面板与 `/ftt` 一条**只读、零副作用**的体检入口 ——
//   把「存档里已经不对劲、但平时不报错」的数据异常逐条列出来，用户与开发都能一眼核对。
//
// 纪律：
//   · **只读**：不改任何字段、不落盘、不触发任何维护流程（与调试桥的只读边界一致）；
//   · **可解释**：每条发现都带 `code` / `level` / `dim` / `id` / `field` / `detail`，能直接定位到条目；
//   · **可自愈的分工**：能从数据本身确定地修好的（脏台账标记 / 非规范 NSFW / 负数 uses / 倒置楼层区间 …）
//     在 `core/migrate.js#migrateState` **载入期自愈**；无法确定语义的（重复 id / 超长字段 / 墓碑时间戳非法）
//     只报告、不擅自改写（避免误删用户数据）。
//
// 覆盖的异常（`code`）：
//   结构类（error）：`container-type`（维度容器类型不对）· `entry-not-object`
//   标识类（warn）：`entry-no-id` · `entry-dup-id`
//   楼层类（warn）：`floor-inverted`（来源区间倒置）· `floornow-inverted`（当前位置倒置）·
//                   `origin-gone-with-floornow`（「原文已移除」却仍声明当前位置）
//   NSFW 类（warn）：`nsfw-invalid`（等级不是「无 / 弱 / 强」的规范值）
//   数值类（warn）：`uses-invalid`（负数 / 非数字）· `importance-out-of-range`（不在 0..1）
//   体积类（info）：`field-too-long`（单字段超过该维度字数上限）
//   文本类（warn）：`text-bad-token`（文本里混入 `undefined` / `NaN` / `[object Object]` 占位；v3.26.1）
//   关联类（warn）：`link-bad-row` · `link-orphan`（引用的条目不存在）
// v3.44.0 新增（`docs/D22` **W4**）：
//   字段名类（info）：`field-legacy-name`（只带旧字段名而缺规范名；`数-10`）·
//                     `attribution-missing`（缺聊天归属 `chatKey`；`数-10`，v3.45.1 `数-29` 起**仅双命中时回填**，见下）
//   关联锚点（info）：`link-missing-anchor`（关联行缺知情锚点 `at` / `from` / `view`；`数-11`）
//   计划悬念（info）：`plan-long-open`（长期未推进的 open 计划 / 悬念；`数-12`）
//   空壳（info）：`entry-shell`（正文 < 12 字的存量空壳；`数-13`）
//   越界（warn）：`field-out-of-range`（保留字段越界：`weaveLastFloor` / `parallelFloor` / `storyDay` / `floorStart`；`数-14`）
//   槽位（info）：`state-slot-unregistered`（未登记的 state 顶层槽位；`数-15`）·
//                 `state-slot-reserved`（已登记但**未接线**的保留槽位；`数-15`）
//   台账类（warn）：`processed-not-array` · `ledger-bad-mark` · `ledger-dup-mark` · `lastknown-invalid` ·
//                   `lastchatfloor-invalid` · `processedver-invalid`
//   墓碑类（warn）：`tombstone-bad-ts`（时间戳非数字 → 该墓碑实际不生效，跨端可能被复活）
//
// v3.45.5 新增（`docs/D22` W4 `技-25` ①，设计稿 `docs/D26` §8 技-25 行；新增顶层键 `out.resume` = `resumeHealthReport(...)`）：
//   履历类（info）：`resume-over-limit`（某角色履历条数**超过上限**；**软阈值** —— 只有超限才清算，`≤ 上限`一条不动）·
//                   `resume-needs-condense`（超过凝练目标的简述条数）·
//                   `resume-suspect-dup`（同一角色内「简述前 12 字相同」的**疑似**重复；**只提示，不改数据**）·
//                   `resume-dup-with-history`（与 `background.history` 疑似重复，`docs/D26` §3.1 分工规则）·
//                   `resume-clockless`（日期解析不出 → 该条排序会掉到最后）
//   履历类（warn）：`resume-orphan-ref`（`refs` 指向不存在的记忆 id）
//   口径：① 读数与遗弃 / 凝练**同源**（算法唯一源 `core/resume.js`，本文件只做「读数 → 发现」的翻译）；
//        ② 明细**按角色聚合**（一个角色每个 code 至多一条 —— 否则「上限 30 条 × N 角色」会直接淹没 `findings`）；
//        ③ `dim` 一律 `'snapshots'`；④ 只在**有履历**的角色上产生发现（老存档无 `resume` 字段 → 一条都不多）；
//        ⑤ 开关 `cfg.snapshotResumeEnabled === false` → `out.resume.note = 'disabled'`（如实标注「未体检」，
//           **不静默当作「健康」**），且不加任何履历发现。
//
// v3.13.1（用户要求「检查最新版 BUG」后修的四处口径缺陷）：
//   ① `HEALTH_DIMS` 里 `plotSegments` 重复 → 该维被扫两遍，明细与计数**翻倍**、`scanned.dims` 虚高（现去重）；
//   ② `level` 原先由被 `cap` 截断的 `findings` 推导 → 大量 info 会把 warn 挤出明细，摘要**低估严重度**
//      （现按累计到的最严重级别给出，与 `counts` 一致）；
//   ③ v3.11.1 的丢失留痕台账 `processedDropped` 与 `lastChatFloor` / `processedVer` 原先**不在体检范围**（现补上）；
//   ④ 载入期自愈的 `changed` 原先被丢弃（无留痕）→ 由 `core/migrate.js#lastHealInfo` 回传，`index.js` 记日志并按需落盘。
// ============================================================
import { ATOM_DIM_KEYS, DIM_CHAR_LIMITS, DIMENSIONS } from './constants.js';
import { constraintFindings, constraintCheckOn } from './constraint-check.js';   // v3.50.22（`业-2`）
import { cfg, state as kernelState } from './model/runtime.js';
import { NSFW_LEVEL_FIELD, nsfwLevelNorm } from './nsfw-level.js';
// v3.26.1：坏占位 token（`undefined` / `NaN` / `[object Object]`）只读体检
import { hasBadToken, walkStrings } from './util.js';

/** 是否有值（与 `core/field-names.js#nonEmpty` 同口径：非空串 / 有限数 / 布尔；`数-16` 失锚关联判定用） */
function nonEmpty(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'boolean') return true;
    return false;
}
// v3.44.0（`docs/D22` W4）：字段名规范 / 空壳 / 越界 / 槽位 / 关联锚点 / 计划悬念老化
import { ATTRIBUTION_FIELD, LAST_SEEN_DATE_FIELD, LAST_SEEN_FLOOR_FIELD, attributionMissing, legacyNameGaps } from './field-names.js';
import { isShellEntry, shellReport, SHELL_MIN_CHARS, DIM_FIELDS as SHELL_DIM_FIELDS } from './shell-guard.js';
import { reservedRangeIssues } from './reserved-fields.js';
import { stateSlotReport } from './state-slots.js';
// v3.50.28（`docs/D22` §4.28 W28 `技-28`）：全量扫描节流与可观测（体检是一次全库扫描）
import { scanBegin, scanEnd } from './scan-throttle.js';
import { relAnchorGaps } from './rel-maint.js';
import { planAgingReport, PLAN_AGING_STALE_DAYS } from './plan-aging.js';
// v3.45.5（`docs/D22` W4 `技-25` ①，设计稿 `docs/D26` §8）：**履历**体检读数 ——
//   算法唯一源在 `core/resume.js`（纯内核叶子模块；归一 / 遗弃 / 凝练 / 统计都在那里），
//   本文件**只做「读数 → 发现」的翻译**，不重复实现任何算法（`resumeHealthReport` 内部已含缺省回落：
//   配置非法时自动取默认值，所以这里直接把 `cfg` 的六个键透传即可）。
import { RESUME_DEFAULT_SUMMARY_MAX, resumeHealthReport, resumeLedgerState } from './resume.js';

/** 体检发现的等级：`error` 计入 `ok=false`；`warn` / `info` 只提示 */
export const HEALTH_LEVELS = Object.freeze(['error', 'warn', 'info']);
/** 单次体检最多返回的明细条数（超出只累计计数，避免把整份存档经调试端口外送） */
export const HEALTH_FINDINGS_CAP = 200;
/** 参与体检的维度（ATOM_DIM_KEYS + 货币/名册/分段）；`ATOM_DIM_KEYS` 已含 `plotSegments` → **去重**（v3.13.1 修） */
const HEALTH_DIMS = (() => {
    const out = [];
    for (const d of ATOM_DIM_KEYS.concat(['currencies', 'npcs', 'plotSegments'])) if (out.indexOf(d) < 0) out.push(d);
    return out;
})();
/** 有内容哈希/条目 id 的维度（关联层的行是引用而非条目） */
const HEALTH_TEXT_FIELDS = {
    atoms: ['title', 'text', 'content'],
    currentStates: ['subject', 'value', 'content'],
    snapshots: ['name', 'appearance', 'background.history', 'content'],
    memories: ['title', 'content'],
    items: ['name', 'desc'],
    plans: ['title', 'content', 'statusNote'],
    suspense: ['title', 'content', 'statusNote'],
    scenes: ['name', 'desc'],
    concepts: ['name', 'content'],
    parallels: ['title', 'text', 'causalLine'],
    rumors: ['subject', 'content'],
    plotSegments: ['header', 'raw'],
    currencies: ['name', 'note'],
    npcs: ['name', 'desc'],
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
/**
 * 台账标记的楼层号解析（**严格**，与 `core/migrate.js#ledgerFloorNum` 同口径）：
 *   只认非负整数与十进制数字串 —— `Number(null) === 0` 一类宽松转换会把垃圾标记伪装成「第 0 楼已处理」，
 *   体检若也这么做就等于**漏报**这条异常。
 */
function ledgerFloorNum(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
    if (typeof v === 'string') { const t = v.trim(); return /^\d+$/.test(t) ? Number(t) : NaN; }
    return NaN;
}

/**
 * 容器名 → 字数上限表的维度键：状态记录在 `state` 上叫 `currentStates`，
 * 而在 `cfg.dimCharLimits` / `DIM_CHAR_LIMITS` 里叫 `states`（V1 口径）—— 不改映射就会漏检整维。
 */
const LIMIT_KEY_ALIAS = { currentStates: 'states' };
function limitOf(dim) {
    const key = LIMIT_KEY_ALIAS[dim] || dim;
    try {
        const c = Number(cfg && cfg.dimCharLimits && cfg.dimCharLimits[key]);
        if (Number.isFinite(c) && c > 0) return c;
    } catch (e) { /* 忽略 */ }
    return Number(DIM_CHAR_LIMITS[key]) || 0;
}

function getByPath(o, path) {
    try {
        let cur = o;
        for (const seg of String(path).split('.')) { if (cur == null) return undefined; cur = cur[seg]; }
        return cur;
    } catch (e) { return undefined; }
}

/**
 * 数据体检（只读）。
 * @param {object} [st] 状态快照（缺省用内核 state）
 * @param {{cap?:number, dims?:string[]}} [opts]
 * @returns {{ok:boolean, level:'ok'|'warn'|'error', findings:Array, counts:object,
 *            hygiene:{counts:object, findings:Array},
 *            resume:object, scanned:{dims:number, items:number, fields:number, resumeItems:number},
 *            truncated:number, at:number}}
 *   · `resume`（v3.45.5）= `core/resume.js#resumeHealthReport` 的读数（顶层键；开关关闭时带 `note:'disabled'`）；
 *   · `scanned.resumeItems` = 已扫描的**履历条数**（既有键语义不变，仅追加这一个）。
 */
/** 墓碑比「明显偏高」阈值（`数-16` 体检四项之一；**只影响文案里的点名**，不影响任何行为） */
export const TOMBSTONE_RATIO_SPIKE = 5;

export function dataHealthReport(st, opts) {
    // v3.50.28（W28 `技-28`）：体检 = 全库扫描 → 走同一套节流与读数（`force` 供面板显式「体检」动作放行）
    const _scanGate = (() => { try { return scanBegin('dataHealth', { force: !!(opts && opts.force) }); } catch (e) { return { go: false, runId: 0, reason: 'error', conf: { capItems: 50000 } }; } })();
    const _scanT0 = Date.now();
    const s = st || kernelState || {};
    const o = opts || {};
    const cap = Math.max(1, Math.min(Number(o.cap) || HEALTH_FINDINGS_CAP, 5000));
    const dims = (Array.isArray(o.dims) && o.dims.length) ? o.dims : HEALTH_DIMS;
    const out = { ok: true, level: 'ok', findings: [], counts: {}, scanned: { dims: 0, items: 0, fields: 0 }, truncated: 0, at: Date.now() };
    // v3.13.1：等级按**发现到的异常**累计（而不是按被 `cap` 截断后的 `findings` 推导）——
    //   此前 205 条超长字段(info) 会把 1 条台账脏标记(warn) 挤出 `findings`，摘要于是把 warn 读成 info。
    const RANK = { info: 1, warn: 2, error: 3 };
    let worst = 0;
    const add = (code, level, extra) => {
        out.counts[code] = (out.counts[code] || 0) + 1;
        const r = RANK[level] || 0;
        if (r > worst) worst = r;
        if (out.findings.length < cap) out.findings.push(Object.assign({ code: code, level: level }, extra || {}));
        else out.truncated++;
    };

    // ---------- 维度容器与条目 ----------
    for (const dim of dims) {
        let arr = null;
        try { arr = s[dim]; } catch (e) { arr = undefined; }
        out.scanned.dims++;
        if (arr === undefined || arr === null) continue;                       // 缺容器 → 由迁移补空，不算异常
        if (!Array.isArray(arr)) { add('container-type', 'error', { dim: dim, detail: '容器应为数组，实际是 ' + (Array.isArray(arr) ? 'array' : typeof arr) }); continue; }
        const seen = Object.create(null);
        // 关联层（`links`）的行是**引用行**（`dim` + `refId` + `who`），本就没有 `id`、楼层与 NSFW 等级 →
        //   只查行结构（见下方关联层专段），否则会产生「缺 id」一类**误报**。
        const isRefLayer = dim === 'links';
        for (let i = 0; i < arr.length; i++) {
            const it = arr[i];
            out.scanned.items++;
            if (!isObj(it)) { add('entry-not-object', 'error', { dim: dim, at: i, detail: '条目应为对象，实际是 ' + (it === null ? 'null' : typeof it) }); continue; }
            if (isRefLayer) continue;
            const id = (it.id === undefined || it.id === null) ? '' : String(it.id);
            if (!id) add('entry-no-id', 'warn', { dim: dim, at: i, field: 'id', detail: '缺 id（无法按 id 编辑 / 跨端对账）' });
            // 注意 `seen[id] !== undefined`：首次出现的下标是 0 时 `if (seen[id])` 为假 → 会漏报（本批修的写法缺陷）
            else if (seen[id] !== undefined) add('entry-dup-id', 'warn', { dim: dim, id: id, at: i, field: 'id', detail: 'id 与第 ' + seen[id] + ' 条重复（后者按 id 不可达）' });
            else seen[id] = i;

            // 楼层来源区间
            const fs = Number(it.floorStart), fe = Number(it.floorEnd);
            if (isInt(fs) && isInt(fe) && fs >= 0 && fe >= 0 && fe < fs) {
                add('floor-inverted', 'warn', { dim: dim, id: id, field: 'floorStart/floorEnd', value: [fs, fe], detail: '来源区间倒置（' + fs + ' > ' + fe + '）' });
            }
            // 当前位置
            const ns = Number(it.floorNowStart), ne = Number(it.floorNowEnd);
            const hasNow = isInt(ns) && isInt(ne);
            if (hasNow && (ns < 0 || ne < ns)) {
                add('floornow-inverted', 'warn', { dim: dim, id: id, field: 'floorNowStart/floorNowEnd', value: [ns, ne], detail: '当前位置区间非法（' + ns + ' → ' + ne + '）' });
            }
            if (it.originGone === true && hasNow) {
                add('origin-gone-with-floornow', 'warn', { dim: dim, id: id, field: 'originGone', value: [ns, ne], detail: '已判「原文已移除」却仍声明当前位置' });
            }
            // NSFW 等级
            if (it[NSFW_LEVEL_FIELD] !== undefined && it[NSFW_LEVEL_FIELD] !== null) {
                const raw = it[NSFW_LEVEL_FIELD];
                const norm = nsfwLevelNorm(raw);
                if (typeof raw !== 'string' || raw !== norm) {
                    add('nsfw-invalid', 'warn', { dim: dim, id: id, field: NSFW_LEVEL_FIELD, value: raw, detail: '等级应为 none / weak / strong，实际 ' + JSON.stringify(raw) });
                }
            }
            // 数值字段
            if (it.uses !== undefined && it.uses !== null) {
                const u = Number(it.uses);
                if (!Number.isFinite(u) || u < 0) add('uses-invalid', 'warn', { dim: dim, id: id, field: 'uses', value: it.uses, detail: '调用次数应为 ≥0 的数字' });
            }
            if (it.importance !== undefined && it.importance !== null) {
                const im = Number(it.importance);
                if (!Number.isFinite(im) || im < 0 || im > 1) add('importance-out-of-range', 'warn', { dim: dim, id: id, field: 'importance', value: it.importance, detail: '重要度应在 0..1' });
            }
            // 单字段体积
            const lim = limitOf(dim);
            if (lim > 0) {
                for (const p of (HEALTH_TEXT_FIELDS[dim] || [])) {
                    const v = getByPath(it, p);
                    if (typeof v !== 'string' || !v) continue;
                    out.scanned.fields++;
                    if (v.length > lim) add('field-too-long', 'info', { dim: dim, id: id, field: p, value: v.length, detail: '长度 ' + v.length + ' 超过该维度上限 ' + lim });
                }
            }
            // v3.26.1（用户报告「有传言中出现了 undefined 字样」）：文本里的**坏占位 token**
            //   （`undefined` / `NaN` / `[object Object]`，多由拼接时取到空值造成）——
            //   载入期已由 `core/migrate.js#healthSelfHeal` 清理；此处只读列出**残留**（例如深层的数组元素）。
            {
                const hitPaths = [];
                try {
                    walkStrings(it, (v, path) => {
                        if (hasBadToken(v)) hitPaths.push(path);
                        return undefined;                                  // 只读，不改
                    }, { maxDepth: 4, maxStrings: 4000 });
                } catch (e) { /* 忽略 */ }
                for (const p of hitPaths.slice(0, 3)) {
                    add('text-bad-token', 'warn', { dim: dim, id: id, field: p, detail: '文本里混入了占位 token（undefined / NaN / [object Object]）' });
                }
            }
        }
    }

    // ---------- 关联层 ----------
    try {
        const links = Array.isArray(s.links) ? s.links : [];
        const exists = (dim, refId) => {
            const arr = (() => { try { return s[dim]; } catch (e) { return null; } })();
            if (!Array.isArray(arr)) return false;
            return arr.some((x) => x && String(x.id) === String(refId));
        };
        for (let i = 0; i < links.length; i++) {
            const l = links[i];
            if (!isObj(l)) { add('link-bad-row', 'warn', { dim: 'links', at: i, detail: '关联行应为对象' }); continue; }
            const dim = String(l.dim || ''), refId = String(l.refId || '');
            if (!dim || !refId) add('link-bad-row', 'warn', { dim: 'links', at: i, detail: '关联行缺 dim / refId' });
            else if (!exists(dim, refId)) add('link-orphan', 'warn', { dim: 'links', at: i, refId: dim + ':' + refId, detail: '引用的条目不存在（孤儿关联行）' });
        }
    } catch (e) { /* 忽略 */ }

    // ---------- 已处理楼层台账 ----------
    try {
        /** 台账数组逐条校验（主台账与 v3.11.1 的丢弃留痕**同口径**；v3.13.1 起留痕也纳入体检） */
        const checkMarks = (pf, dim) => {
            if (pf !== undefined && pf !== null && !Array.isArray(pf)) {
                add('processed-not-array', 'warn', { dim: dim, detail: '台账应为数组，实际是 ' + typeof pf });
                return;
            }
            if (!Array.isArray(pf)) return;
            const seenF = Object.create(null);
            for (let i = 0; i < pf.length; i++) {
                const x = pf[i];
                const f = ledgerFloorNum(isObj(x) ? x.f : x);
                const h = isObj(x) ? String(x.h || '') : '';
                if (!isInt(f) || f < 0) { add('ledger-bad-mark', 'warn', { dim: dim, at: i, value: x, detail: '台账标记的楼层号非法（空值 / 布尔 / 非数字都会让该标记失效）' }); continue; }
                const key = f + ':' + h;
                if (seenF[key]) { add('ledger-dup-mark', 'warn', { dim: dim, at: i, value: { f: f, h: h }, detail: '台账标记重复' }); continue; }
                seenF[key] = 1;
            }
        };
        checkMarks(s.processedFloors, 'processedFloors');
        checkMarks(s.processedDropped, 'processedDropped');
        const lk = s.lastKnownFloor;
        if (lk !== undefined && lk !== null) {
            const n = Number(lk);
            if (!Number.isFinite(n) || !isInt(n) || n < -1) add('lastknown-invalid', 'warn', { dim: 'lastKnownFloor', value: lk, detail: '应为 ≥-1 的整数（-1 = 未知）' });
        }
        // v3.13.1：另外两个台账辅助字段此前**不在体检范围**（脏了既不报也不修）
        const lc = s.lastChatFloor;
        if (lc !== undefined && lc !== null) {
            const n = Number(lc);
            if (!Number.isFinite(n) || !isInt(n) || n < -1) add('lastchatfloor-invalid', 'warn', { dim: 'lastChatFloor', value: lc, detail: '应为 ≥-1 的整数（-1 = 未知；末见楼层允许回退）' });
        }
        if (s.processedVer !== undefined && s.processedVer !== null && typeof s.processedVer !== 'string') {
            add('processedver-invalid', 'warn', { dim: 'processedVer', value: typeof s.processedVer, detail: '应为字符串版本标签（非字符串会被当成「版本不符」而重算台账）' });
        }
    } catch (e) { /* 忽略 */ }

    // ---------- 删除墓碑时间戳 ----------
    try {
        const scanTree = (tree, label) => {
            if (!isObj(tree)) return;
            for (const dim of Object.keys(tree)) {
                const m = tree[dim];
                if (!isObj(m)) continue;
                for (const k of Object.keys(m)) {
                    const v = m[k];
                    if (v === null || v === undefined) { add('tombstone-bad-ts', 'warn', { dim: label + '.' + dim, id: k, value: v, detail: '墓碑时间戳为空 → 该墓碑不生效' }); continue; }
                    const n = Number(v);
                    if (!Number.isFinite(n) || n <= 0) add('tombstone-bad-ts', 'warn', { dim: label + '.' + dim, id: k, value: v, detail: '墓碑时间戳不是正整数 → 该墓碑不生效（对端可能复活该条目）' });
                }
            }
        };
        scanTree(s.deleted, 'deleted');
        scanTree(s.deletedH, 'deletedH');
    } catch (e) { /* 忽略 */ }

    // ==================== v3.44.0（`docs/D22` W4）：六项新口径 ====================
    // **分两条通道**（这是本轮刻意的设计决定，不是省事）：
    //   · `out.findings` / `out.counts` / `out.level` —— **异常**：结构坏、id 重复、墓碑失效、字段越界…
    //     这些是「数据坏了，要处理」；`out.level` 只由它们决定（`error`/`warn`/`info`/`ok`）。
    //   · `out.hygiene` —— **存量卫生计数**：缺归属、缺锚点、空壳、长期 open、未登记槽位…
    //     这些是「数据没坏，但有可清理的面」，**数量级可能是几十上百**。
    //   为什么不塞进 `findings`：① 会把 `level` 从 `ok` 抬成 `info`，让「体检干净」这个**可用信号**失效；
    //   ② 明细会挤掉真正的 warn（v3.13.1 修过同类问题）；③ 计数才是这批的交付物（能降、能对账）。
    //   `out.hygiene` 与 `findings` 同为**只读**、同样经三处出口（面板 / `FTT.dataHealth()` / 调试桥）可见。
    out.hygiene = { counts: {}, findings: [] };
    const hyg = (code, dim, n, extra) => {
        if (!n) return;
        out.hygiene.counts[code] = (out.hygiene.counts[code] || 0) + Number(n);
        if (out.hygiene.findings.length < cap) out.hygiene.findings.push(Object.assign({ code: code, level: 'info', dim: dim, value: n }, extra || {}));
    };
    const hygOne = (code, extra) => { out.hygiene.counts[code] = (out.hygiene.counts[code] || 0) + 1; if (out.hygiene.findings.length < cap) out.hygiene.findings.push(Object.assign({ code: code, level: 'info' }, extra || {})); };

    // ① `数-10`：字段名规范 —— 只带旧名而缺规范名 / 缺聊天归属（**不可回填**，见 `core/field-names.js` 头注）
    try {
        const gapsByDim = {}, attrByDim = {};
        for (const dim of dims) {
            const arr = s[dim];
            if (!Array.isArray(arr)) continue;
            for (const it of arr) {
                if (!isObj(it)) continue;
                const g = legacyNameGaps(dim, it);
                if (g.date) gapsByDim[dim + '.' + LAST_SEEN_DATE_FIELD] = (gapsByDim[dim + '.' + LAST_SEEN_DATE_FIELD] || 0) + 1;
                if (g.floor) gapsByDim[dim + '.' + LAST_SEEN_FLOOR_FIELD] = (gapsByDim[dim + '.' + LAST_SEEN_FLOOR_FIELD] || 0) + 1;
                if (attributionMissing(it) && dim !== 'links') attrByDim[dim] = (attrByDim[dim] || 0) + 1;   // 关联层是引用行，本就没有归属
            }
        }
        for (const k of Object.keys(gapsByDim)) {
            hyg('field-legacy-name', k, gapsByDim[k], { field: k, detail: '只有旧字段名、缺规范名 —— 载入期迁移与写入期补写都会双写规范名；此项应恒为 0（不为 0 说明数据在迁移后被写回旧名）' });
        }
        for (const k of Object.keys(attrByDim)) {
            hyg('attribution-missing', k, attrByDim[k], { field: ATTRIBUTION_FIELD, detail: '缺聊天归属 `chatKey`：**约定「只打不推断」**（`core/entry-meta.js#stampChatScope`）。v3.45.1（`docs/D22` W6 `数-29`）起改为：**只在「当前聊天键 + 内容指纹」双命中时幂等回填空值**（`core/chat-scope.js#backfillChatAttribution`），其余登记为「升级前历史数据」并保留**独立计数**（`plotScopeSnapshot().legacy` / `ledgerHealth().marksLegacyNoChat`），**不删一条**；仍不做的：按楼层范围或 AI 推断归属（猜错比不打标更危险）。新落库条目会自动带上' });
        }
    } catch (e) { /* 忽略 */ }

    // ② `数-11`：关联行失锚（知情时间 / 告知者 / 差异）
    try {
        const g = relAnchorGaps(s);
        if (g.at) hyg('link-missing-anchor', 'links.at', g.at, { field: 'at', detail: '关联行缺「知情时间」（共 ' + g.total + ' 行；其中「当时在场」的 ' + g.atPresent + ' 行由载入期/修复管道**机械回填**为归属条目的剧情日期）' });
        if (g.from) hyg('link-missing-anchor', 'links.from', g.from, { field: 'from', detail: '关联行缺「告知者」（仅「被告知」需要有；**无法机械推断 → 不回填**，关系表标注「无依据」）' });
        if (g.view) hyg('link-missing-anchor', 'links.view', g.view, { field: 'view', detail: '关联行缺「差异 / 看法」（各人视角不同时才需要；**无法机械推断 → 不回填**）' });
    } catch (e) { /* 忽略 */ }

    // ③ `数-12`：长期未推进的 open 计划 / 悬念（老化分档；**不自动了结**，交用户一键闭环）
    try {
        const nowDate = String((isObj(s.state) && s.state.date) || '');
        const aging = planAgingReport(s, nowDate, {});
        const staleN = (aging.dims.plans || {}).stale || 0;
        const staleS = (aging.dims.suspense || {}).stale || 0;
        if (staleN) hyg('plan-long-open', 'plans', staleN, { field: 'status', detail: '有 ' + staleN + ' 条计划已 ' + PLAN_AGING_STALE_DAYS + ' 天以上未被正文推动（按剧情时间；当前 ' + (nowDate || '无剧情时钟') + '）—— 可在计划页「⌛ 长期未推进」筛选后一键了结' });
        if (staleS) hyg('plan-long-open', 'suspense', staleS, { field: 'status', detail: '有 ' + staleS + ' 条悬念已 ' + PLAN_AGING_STALE_DAYS + ' 天以上未被正文推动（按剧情时间；当前 ' + (nowDate || '无剧情时钟') + '）—— 可在悬念页「⌛ 长期未推进」筛选后一键了结' });
    } catch (e) { /* 忽略 */ }

    // ④ `数-13`：存量空壳条目（正文 < 12 字；**只报告**，出口是列表筛选视图）
    try {
        const sh = shellReport(s, { samples: 0 });
        for (const dim of Object.keys(sh.byDim)) {
            hyg('entry-shell', dim, sh.byDim[dim], { field: (SHELL_DIM_FIELDS[dim] || {}).body ? SHELL_DIM_FIELDS[dim].body.join('/') : '', detail: '正文不足 ' + SHELL_MIN_CHARS + ' 字（空壳）；**只报告不删** —— 用列表页筛选条「🫥 空壳」挑出来人工处理。新入库的空壳会被 `core/shell-guard.js` 拦下并计数（开关 `cfg.shellGuardEnabled`，默认关）' });
        }
    } catch (e) { /* 忽略 */ }

    // ⑤ `数-14`：保留字段越界（楼层基线 / 剧情天数）—— 这条属**异常**（warn），留在 `findings` 里
    try {
        for (const it of reservedRangeIssues(s)) {
            add(it.code, 'warn', { dim: it.dim || '', id: it.id || '', field: it.field, value: it.value, detail: it.detail });
        }
    } catch (e) { /* 忽略 */ }

    // ⑦ `数-16`（`docs/D16` §5）：**体检四项** —— 归属缺失（含「与当前不同」）· 失锚关联 · 空壳 · **墓碑比**
    //   口径（四项逐条落在这里，供面板 / `FTT` 导出 / 调试桥三处同源引用）：
    //     · **归属缺失**：条目**没有** `chatKey`，**或**与当前 `state.chatKey` **不同**的条数（两段分别计数）
    //     · **失锚关联**：记忆类关联行的 `atomRef` / `conceptRef` / `planRef` **全空**（无法指回依据条目）——
    //       与 `link-orphan`（**悬空**：引用的条目不存在）是两件事，D16 §5 分列两行
    //     · **空壳条目**：正文 < `SHELL_MIN_CHARS`（12 字）—— 复用上面的 `entry-shell`（`数-13`）
    //     · **墓碑比**：该维 `deleted` 键数 / 该维**存活**条数（比值只读；比值 ≥ `TOMBSTONE_RATIO_SPIKE` 时在 detail 里点名）
    //   全部落在 `hygiene`（info，不抬 `level`）：它们是**卫生面**而非异常 —— 处置动作是「清」而不是「修」，
    //   让 `level` 保持 `ok` 才有「体检干净」这个可用信号（与 ①–⑥ 同款裁量）。
    try {
        const curChatKey = String((isObj(s.state) && s.state[ATTRIBUTION_FIELD]) || '');
        const attrForeign = {};
        const anchorMissing = {};
        const tombRatio = [];
        for (const dim of dims) {
            const arr = s[dim];
            if (Array.isArray(arr)) {
                for (const it of arr) {
                    if (!isObj(it)) continue;
                    const k = String(it[ATTRIBUTION_FIELD] || '');
                    if (k && curChatKey && k !== curChatKey) attrForeign[dim] = (attrForeign[dim] || 0) + 1;
                }
            }
        }
        for (const dim of Object.keys(attrForeign)) {
            hyg('attribution-foreign', dim, attrForeign[dim], { field: ATTRIBUTION_FIELD, detail: '有 ' + attrForeign[dim] + ' 条带**其它聊天**的归属（`chatKey` ≠ 当前 `' + (curChatKey || '（空）') + '`）—— 按设计**保留不动**（换聊天不丢数据）：本条只做可见性，不迁移、不改写' });
        }
        // 失锚关联：关联行（`s.links`）里 `dim` ∈ 记忆类，且三个 ref 全空
        try {
            const links = Array.isArray(s.links) ? s.links : [];
            const MEM_DIMS = ['memories'];
            for (const row of links) {
                if (!isObj(row)) continue;
                const target = String(row.dim || '');
                if (MEM_DIMS.indexOf(target) < 0) continue;
                const empty = !nonEmpty(row.atomRef) && !nonEmpty(row.conceptRef) && !nonEmpty(row.planRef)
                    && !nonEmpty(row.itemRef) && !nonEmpty(row.rumorRef) && !nonEmpty(row.sceneRef) && !nonEmpty(row.stateRef) && !nonEmpty(row.parallelRef);
                if (empty) anchorMissing[target] = (anchorMissing[target] || 0) + 1;
            }
        } catch (e) { /* 忽略 */ }
        for (const dim of Object.keys(anchorMissing)) {
            hyg('link-ref-missing', dim, anchorMissing[dim], { field: 'atomRef/conceptRef/planRef', detail: '记忆类关联行有 ' + anchorMissing[dim] + ' 行的**所有引用锚点都为空**（无法指回依据条目 —— 与 `link-orphan`「引用的条目不存在」不同）；**只报告不推断**：不按楼层 / 不按 AI 猜锚点（猜错比空着更危险）' });
        }
        // 墓碑比（逐维）：`deleted[dim]` 键数 / 存活条数
        const delTree = isObj(s.deleted) ? s.deleted : {};
        for (const dim of dims) {
            const live = Array.isArray(s[dim]) ? s[dim].length : 0;
            const dead = isObj(delTree[dim]) ? Object.keys(delTree[dim]).length : 0;
            if (!dead && !live) continue;
            const ratio = live > 0 ? (dead / live) : (dead > 0 ? Infinity : 0);
            tombRatio.push({ dim: dim, live: live, dead: dead, ratio: ratio });
        }
        for (const t of tombRatio) {
            const ratioText = Number.isFinite(t.ratio) ? (Math.round(t.ratio * 100) / 100) + '×' : '∞（无存活条目）';
            const spike = !Number.isFinite(t.ratio) || t.ratio >= TOMBSTONE_RATIO_SPIKE;
            hyg('tombstone-ratio', t.dim, t.dead, { field: 'deleted.' + t.dim, value: t.dead, detail: '墓碑比 ' + ratioText + '（墓碑 ' + t.dead + ' / 存活 ' + t.live + '）' + (spike ? (' —— **≥ ' + TOMBSTONE_RATIO_SPIKE + '×**：墓碑已明显多于存活条目，可在「设定 → 数据管理」用墓碑回收清理（只清墓碑，不动存活条目）') : '') });
        }
        out.tombstone = { dims: tombRatio, spike: tombRatio.filter((x) => !Number.isFinite(x.ratio) || x.ratio >= TOMBSTONE_RATIO_SPIKE).map((x) => x.dim) };
    } catch (e) { /* 忽略 */ }

    // ⑥ `数-15`：state 顶层 / 内层槽位登记一致性（未登记 = 新的「看起来能用」位置）
    try {
        const sr = stateSlotReport(s);
        if (sr.unregistered.length) hygOne('state-slot-unregistered', { dim: 'state', field: sr.unregistered.join(','), value: sr.unregistered.length, detail: '存档里有未登记的顶层槽位 —— 每个保留字段都必须有归属与出口说明，请登记进 `core/state-slots.js#STATE_SLOTS`／`RUNTIME_SLOTS`' });
        if (sr.innerUnregistered.length) hygOne('state-slot-unregistered', { dim: 'state', field: sr.innerUnregistered.join(','), value: sr.innerUnregistered.length, detail: '`state` 容器里有未登记的内部槽位（同上，登记进 `core/state-slots.js#STATE_INNER_SLOTS`）' });
        if (sr.reservedWithData && sr.reservedWithData.length) hygOne('state-slot-reserved', { dim: 'state', field: sr.reservedWithData.map((x) => x.key).join(','), value: sr.reservedWithData.length, detail: '保留但**未接线**（明确标注「未启用」）**且当前装着数据**：' + sr.reservedWithData.map((x) => x.key + '（' + x.label + '）').join(' · ') + '；另有死读配置键 ' + sr.cfgReads.map((x) => x.key).join(',') + '。空白槽位不报（避免噪声）' });
    } catch (e) { /* 忽略 */ }

    // ⑦ `数-19`…`技-25`（`docs/D26` §8 技-25 ①）：**履历**（角色档案第 9 区块 `snapshots[].resume`）——
    //   条数 / 超限 / 待凝练 / 疑似重复 / 孤儿引用 / 无时钟。**只读**（不改任何字段、不落盘）。
    //   顶层键 `out.resume` = `core/resume.js#resumeHealthReport` 的读数（面板 / `FTT` 导出 / 调试桥三处同源）；
    //   本段只把读数翻成**按角色聚合**的发现（一个角色每个 code 至多一条），并追加 `scanned.resumeItems`。
    out.scanned.resumeItems = 0;
    try {
        if (cfg.snapshotResumeEnabled === false) {
            // 开关关闭 → 履历**未体检**：读数清零并如实打标（`note: 'disabled'`），
            //   绝不能让「关掉开关」看起来像「体检干净」。
            out.resume = resumeHealthReport([]);
            out.resume.note = 'disabled';
        } else {
            const rOpts = {
                max: cfg.snapshotResumeMax, triggerRatio: cfg.snapshotResumeTriggerRatio,
                immune: cfg.snapshotResumeImmune, summaryMax: cfg.snapshotResumeSummaryMax,
                memoryIds: (s.memories || []).map((m) => m && m.id).filter(Boolean).map(String),
            };
            out.resume = resumeHealthReport(s.snapshots, rOpts);
            out.scanned.resumeItems = Number(out.resume.total) || 0;
            // v3.45.5（`docs/D22` W4 `技-25` ① 的第四项读数）：**遗弃计数** ——
            //   与「条数 / 超限 / 疑似重复」不同，遗弃数**不在数据里**（`docs/D26` Q2 裁决「不需要墓碑」→ 不落盘），
            //   它只能来自履历机械段的**运行账本**（`core/resume.js#resumeLedgerState`，本会话内累计）。
            //   放在**顶层键** `resumeLedger`（而不是并进 `out.resume`）有两个理由：
            //     ① `out.resume` 保持与 `resumeHealthReport(...)` **逐字同源**（单测直接比对两者）；
            //     ② 语义确实不同 —— 一个是「存档现状」，一个是「本次会话做过什么」，混在一起会让人误以为是持久读数。
            out.resumeLedger = resumeLedgerState();
            // 文案里的凝练目标：与 `core/resume.js#resumeStats` **同款归一**（非法配置回落默认；这里只为显示一个数）
            const condenseMax = Math.max(8, Math.floor(Number(cfg.snapshotResumeSummaryMax) || RESUME_DEFAULT_SUMMARY_MAX));
            // `resumeHealthReport.items` 只含**有履历**的角色（空履历 / 无 `resume` 字段的角色不在其中）
            for (const it of out.resume.items) {
                const id = String(it.id || '');
                if (it.over) add('resume-over-limit', 'info', { dim: 'snapshots', id: id, field: 'resume.total', value: it.total, detail: '履历 ' + it.total + ' 条超过上限 ' + out.resume.max + ' 条（超出 ' + (it.total - out.resume.max) + ' 条）—— **软阈值**：只有超过上限才清算，未超（≤ 上限）时一条都不动；下次履历维护会按「重要度 × 剧情时间新鲜度」遗弃超出的条目（达到免疫线的条目不参与遗弃，故实际遗弃数只会更少）' });
                if (it.toCondense > 0) add('resume-needs-condense', 'info', { dim: 'snapshots', id: id, field: 'resume.toCondense', value: it.toCondense, detail: '有 ' + it.toCondense + ' 条简述超过凝练目标 ' + condenseMax + ' 字（最长 ' + it.longest + ' 字）待凝练；凝练只压简述，不动日期 / 时刻 / 重要度 / 关联' });
                if (it.dupSuspects > 0) add('resume-suspect-dup', 'info', { dim: 'snapshots', id: id, field: 'resume.dupSuspects', value: it.dupSuspects, detail: '有 ' + it.dupSuspects + ' 条简述「前 12 字」与同角色其它条目相同（疑似重复）；**只提示，不改数据** —— 请在角色页核对后手工合并' });
                if (it.dupWithHistory > 0) add('resume-dup-with-history', 'info', { dim: 'snapshots', id: id, field: 'resume.dupWithHistory', value: it.dupWithHistory, detail: '有 ' + it.dupWithHistory + ' 条与 `background.history` 疑似重复（简述前 8 字已见于历史正文）；按 `docs/D26` §3.1 的分工：历史写「剧情前生平」、履历写「剧情内大事记」，同一件事应只留一处' });
                if (it.orphanRefs > 0) add('resume-orphan-ref', 'warn', { dim: 'snapshots', id: id, field: 'resume.orphanRefs', value: it.orphanRefs, detail: '有 ' + it.orphanRefs + ' 条的 `refs` 指向不存在的记忆 id（记忆已被删除或从未入库）；关联只是软引用，不影响履历本身，但界面上的「关联记忆」点不开' });
                if (it.clockless > 0) add('resume-clockless', 'info', { dim: 'snapshots', id: id, field: 'resume.clockless', value: it.clockless, detail: '有 ' + it.clockless + ' 条日期解析不出（不是 `YYYY-MM-DD` 这类剧情日期写法，含公元前负年份）；**这类条目不静默丢弃，但排序会掉到最后**，展示顺序会与预期不符' });
            }
        }
    } catch (e) { /* 忽略 */ }

    // v3.13.1：等级由**累计到的最严重级别**决定（与 `counts` 一致，不受 `findings` 截断影响）；
    //   `error` 只可能来自结构类（容器类型 / 条目不是对象）。
    out.ok = worst < 3;
    out.level = worst >= 3 ? 'error' : (worst === 2 ? 'warn' : (worst === 1 ? 'info' : 'ok'));
    /**
     * v3.50.22（`docs/D22` W2 `业-2` / `docs/D2` §5.2·§6 S3）：**约束的机械校验**并入体检。
     *   只报告、不改数据（`N4`）；finding 形态与既有完全一致（`{code, level, dim, id, field, value, detail}`），
     *   因此报告 / 调试页 / 文本摘要三处出口**零改动**即可显示。总开关 `cfg.constraintCheckEnabled`。
     */
    try {
        if (typeof constraintCheckOn === 'function' && constraintCheckOn()) {
            const cf = constraintFindings(s, { maxFloor: Number(o.maxFloor) || 0, cap: cap });
            for (const f of cf) add(f.code, f.level, { dim: f.dim, id: f.id, field: f.field, value: f.value, detail: f.detail });
        }
    } catch (e) { /* 忽略：校验失败不影响体检主体 */ }

    // v3.50.28（W28 `技-28`）：如实落账（条目 / 维度 / 耗时 / 命中；不含正文）
    try {
        if (_scanGate.go) {
            const scannedItems = Number((out.scanned && out.scanned.items) || 0);
            const dimsN = Number((out.scanned && out.scanned.dims) || 0);
            scanEnd('dataHealth', _scanGate.runId, {
                items: scannedItems, dims: dimsN, ms: Date.now() - _scanT0,
                hits: Object.keys(out.counts || {}).length,
                remaining: Math.max(0, scannedItems - Number((_scanGate.conf && _scanGate.conf.capItems) || 50000)),
            });
        }
    } catch (e) { /* 观测失败不影响体检 */ }
    out.scanThrottled = _scanGate.go ? '' : _scanGate.reason;
    return out;
}

/** 一行摘要（面板 / 命令 / 调试端口用；只读） */
export function dataHealthText(report) {
    const r = report || dataHealthReport();
    const parts = Object.keys(r.counts).sort().map((k) => k + ' ' + r.counts[k]);
    const head = r.ok ? (r.level === 'ok' ? '数据体检：未发现异常' : '数据体检：' + r.level + '（' + parts.length + ' 类）') : '数据体检：结构异常';
    return head + (parts.length ? ' · ' + parts.join(' · ') : '') + '（扫描 ' + r.scanned.items + ' 条 / ' + r.scanned.dims + ' 维）';
}

/**
 * 一行**卫生摘要**（v3.44.0，`docs/D22` W4）：`out.hygiene` 的只读文案 —— 与 `dataHealthText`（异常）**分开**，
 *   因为这两件事的处置动作不同：异常要修，卫生面要清（也可能永远不清）。
 * @returns {string} 无卫生项时返回空串（调用方据此不显示这一行）
 */
export function dataHealthHygieneText(report) {
    try {
        const h = (report || {}).hygiene;
        if (!h || !h.counts) return '';
        const parts = Object.keys(h.counts).sort().map((k) => k + ' ' + h.counts[k]);
        if (!parts.length) return '';
        return '数据卫生：' + parts.join(' · ');
    } catch (e) { return ''; }
}

export { DIMENSIONS };
