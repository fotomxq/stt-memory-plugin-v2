// ============================================================
// tests/harness/hash-norm.js —— 黄金样本比较前的**哈希归一**
// 背景（有意偏离登记；`docs/D8-内容哈希与瘦身白名单设计稿.md` R1=B / v2.86.0）：
//   V1 的 `it.h` = **变更哈希**（逐维字段表）；v2.86.0 起 `it.h` = **身份哈希**（4 基本槽 + 3 扩展槽，带 `i2:` 前缀），
//   变更哈希改由 `atomChangeHash` 承担（快照差异 / 情节签名）。
//   于是 `tests/fixtures/v1-golden-*.json` 里 V1 写下的 `h` 值**不再可比** —— 但样本**不可手改**（`开发守则.md` §4）。
// 口径：比较前把 `h`（运行态可再生成的缓存）归一为占位符；**其余字段仍严格逐字比对**。
//   身份哈希本身的口径（槽位 / 前缀 / 集合排序 / 与变更哈希的分工）由 `tests/unit/hash-dual-fingerprint.test.js` 专门校验。
// ============================================================

/** 深度归一：`h` → `'H'`；`deletedH` 的键（本身就是哈希）→ 按序占位 `H1..Hn` */
export function normHashes(v) {
    if (Array.isArray(v)) return v.map(normHashes);
    if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) {
            if (k === 'h') { o[k] = v[k] ? 'H' : v[k]; continue; }
            if (k === 'deletedH' && v[k] && typeof v[k] === 'object' && !Array.isArray(v[k])) {
                const out = {};
                for (const dim of Object.keys(v[k]).sort()) {
                    const m = v[k][dim];
                    if (!m || typeof m !== 'object') { out[dim] = m; continue; }
                    const keys = Object.keys(m).sort();
                    const nm = {};
                    keys.forEach((key, i) => { nm['H' + (i + 1)] = m[key]; });
                    out[dim] = nm;
                }
                o[k] = out;
                continue;
            }
            o[k] = normHashes(v[k]);
        }
        return o;
    }
    return v;
}

/** 哈希样式字符串（storageHash 产物：两段 base36 + `_`，身份哈希再带 `i2:` 前缀） */
const HASH_RE = /^(i2:)?[0-9a-z]{4,}_[0-9a-z]{4,}$/;

/**
 * **激进归一**：连同「数组/对象里的裸哈希字符串」一起归一（`h` 值、墓碑键列表、哈希数组…）。
 * 用途：那些原本断言「墓碑键 / h 值逐字与 V1 一致」的用例 —— v2.86.0 起口径已变为**身份哈希**（有意偏离，见 `docs/D8` R1=B），
 *   比较改为「结构一致 + 哈希形态正确」；身份哈希的槽位与分工由 `tests/unit/hash-dual-fingerprint.test.js` 专门校验。
 */
export function normHashStrings(v) {
    if (typeof v === 'string') return HASH_RE.test(v) ? 'H' : v;
    if (Array.isArray(v)) return v.map(normHashStrings);
    if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) o[k] = normHashStrings(v[k]);
        return o;
    }
    return v;
}

/**
 * 角色档案**内容副本**的归一（v2.86.0 / `docs/D8` §4.4 有意偏离登记）：
 * V1 的 `snapshots[].content` = 「背景·经历」截断 300 字；v2.86.0 起 = **全部结构化字段的确定性副本**（上限取该维 `dimCharLimits`）。
 * 故黄金样本比较时把 `category==='snapshots'` 条目的 `content` 归一为 `'C'`（副本本身的确定性与覆盖面由
 * `tests/unit/snapshot-content-copy.test.js` 专门校验），其余字段仍严格逐字比对。
 */
export function normSnapshotContent(v) {
    if (Array.isArray(v)) return v.map(normSnapshotContent);
    if (v && typeof v === 'object') {
        const o = {};
        const isSnap = String(v.category || '') === 'snapshots';
        for (const k of Object.keys(v)) {
            if (isSnap && k === 'content') { o[k] = 'C'; continue; }   // 副本整体归一（空/非空都不比对；副本口径另测）
            o[k] = normSnapshotContent(v[k]);
        }
        return o;
    }
    return v;
}

/** JSON 字符串比较（哈希键归一） */
export function JN(v) { return JSON.stringify(normHashes(v === undefined ? null : v)); }

/** JSON 字符串比较（哈希键 + 裸哈希字符串都归一） */
export function JA(v) { return JSON.stringify(normHashStrings(v === undefined ? null : v)); }
