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
//   关联类（warn）：`link-bad-row` · `link-orphan`（引用的条目不存在）
//   台账类（warn）：`processed-not-array` · `ledger-bad-mark` · `ledger-dup-mark` · `lastknown-invalid` ·
//                   `lastchatfloor-invalid` · `processedver-invalid`
//   墓碑类（warn）：`tombstone-bad-ts`（时间戳非数字 → 该墓碑实际不生效，跨端可能被复活）
//
// v3.13.1（用户要求「检查最新版 BUG」后修的四处口径缺陷）：
//   ① `HEALTH_DIMS` 里 `plotSegments` 重复 → 该维被扫两遍，明细与计数**翻倍**、`scanned.dims` 虚高（现去重）；
//   ② `level` 原先由被 `cap` 截断的 `findings` 推导 → 大量 info 会把 warn 挤出明细，摘要**低估严重度**
//      （现按累计到的最严重级别给出，与 `counts` 一致）；
//   ③ v3.11.1 的丢失留痕台账 `processedDropped` 与 `lastChatFloor` / `processedVer` 原先**不在体检范围**（现补上）；
//   ④ 载入期自愈的 `changed` 原先被丢弃（无留痕）→ 由 `core/migrate.js#lastHealInfo` 回传，`index.js` 记日志并按需落盘。
// ============================================================
import { ATOM_DIM_KEYS, DIM_CHAR_LIMITS, DIMENSIONS } from './constants.js';
import { cfg, state as kernelState } from './model/runtime.js';
import { NSFW_LEVEL_FIELD, nsfwLevelNorm } from './nsfw-level.js';

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
 * @returns {{ok:boolean, level:'ok'|'warn'|'error', findings:Array, counts:object, scanned:object, truncated:number, at:number}}
 */
export function dataHealthReport(st, opts) {
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

    // v3.13.1：等级由**累计到的最严重级别**决定（与 `counts` 一致，不受 `findings` 截断影响）；
    //   `error` 只可能来自结构类（容器类型 / 条目不是对象）。
    out.ok = worst < 3;
    out.level = worst >= 3 ? 'error' : (worst === 2 ? 'warn' : (worst === 1 ? 'info' : 'ok'));
    return out;
}

/** 一行摘要（面板 / 命令 / 调试端口用；只读） */
export function dataHealthText(report) {
    const r = report || dataHealthReport();
    const parts = Object.keys(r.counts).sort().map((k) => k + ' ' + r.counts[k]);
    const head = r.ok ? (r.level === 'ok' ? '数据体检：未发现异常' : '数据体检：' + r.level + '（' + parts.length + ' 类）') : '数据体检：结构异常';
    return head + (parts.length ? ' · ' + parts.join(' · ') : '') + '（扫描 ' + r.scanned.items + ' 条 / ' + r.scanned.dims + ' 维）';
}

export { DIMENSIONS };
