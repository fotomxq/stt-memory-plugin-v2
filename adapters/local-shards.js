// ============================================================
// adapters/local-shards.js —— **本机层的结构化分片**（v3.31.0，用户要求）
//
// 用户原话：「本地文件可以拆碎了保存，这样方便分片处理，呈现结构化、体系化，而不是聚合到单一文件。
//   其他本地存储文件同理。」
//
// 背景：服务端**早已按维度分片**（`adapters/shards.js`：每维一个文件 + 清单），而**本机层**一直把整份状态
//   塞进**一个**记录 —— 浏览器端是单键（`ftt2_state_<scope>`，撞 1.8M 字符预算）、目录/磁盘端是单个大文件。
//   本模块把本机层也拆成**逐维文件/键**，与服务端同构：
//     · 目录（本地磁盘 / 浏览器选中文件夹）：`<目录>/<scope>/<维度>.json` + `<目录>/<scope>/manifest.json`；
//     · 浏览器本机存储（localStorage / IndexedDB）：`ftt2_ls_<scope>__<维度>`（每维一条键）。
//   好处：① 单条记录小、不再受单键配额限制；② 出问题只坏一维、可单独核对/替换；③ 与服务端分片同名同构，
//   「结构化、体系化」；④ 结构上便于后续按维增量写（只重写变化的那几维）。
//
// 纪律：**纯函数**（切分 / 命名 / 合并 / 校验）放在本文件，宿主读写由调用方注入（便于单测）。
// ============================================================
import { DIMENSIONS } from '../core/constants.js';
import { hashText } from '../core/util.js';

/** 分片清单版本 */
export const LOCAL_SHARD_V = 1;
/** meta 分片名（承载「非维度」的全部字段：state/vars/stats/deleted/台账/归属/快照指纹…） */
export const META_SHARD = 'meta';
/** 浏览器本机层的键前缀 */
export const LOCAL_SHARD_PREFIX = 'ftt2_ls_';

/** 参与分片的维度名（顺序稳定 = DIMENSIONS 声明顺序） */
export function shardDims() {
    try { return DIMENSIONS.map((d) => String(d.kind)); } catch (e) { return []; }
}
/** 作用域 → 目录 / 键名安全短标识 */
export function scopeSlug(scope) {
    const s = String(scope == null ? '' : scope).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48);
    return s || 'default';
}
/** 目录模式下的分片文件名（相对 `<目录>/<scope>/`） */
export function shardFileName(dim) { return String(dim || META_SHARD) + '.json'; }
/** 浏览器本机层的分片键名 */
export function shardKeyName(scope, dim) { return LOCAL_SHARD_PREFIX + scopeSlug(scope) + '__' + String(dim || META_SHARD); }
/** 清单文件名 / 键名 */
export function manifestFileName() { return 'manifest.json'; }
export function manifestKeyName(scope) { return LOCAL_SHARD_PREFIX + scopeSlug(scope) + '__manifest'; }

/**
 * 把一份存储信封**切成逐维片段**（纯函数）。
 * @param {object} env 存储信封 `{v, scope, payload:{scope, updatedAt, data}, hash, ts}`
 * @returns {{ok:boolean, at:number, scope:string, parts:Object<string, any>, counts:Object<string, number>, reason?:string}}
 *   `parts.meta` = 非维度字段的集合；`parts.<dim>` = 该维数组（缺失则空数组）
 */
export function splitParts(env) {
    try {
        const data = (env && env.payload && env.payload.data) || null;
        if (!data || typeof data !== 'object') return { ok: false, parts: {}, counts: {}, at: 0, scope: '', reason: 'no-data' };
        const dims = shardDims();
        const parts = {};
        const counts = {};
        const meta = {};
        for (const k of Object.keys(data)) {
            if (dims.indexOf(k) >= 0) continue;
            meta[k] = data[k];
        }
        parts[META_SHARD] = meta;
        counts[META_SHARD] = Object.keys(meta).length;
        for (const d of dims) {
            const arr = Array.isArray(data[d]) ? data[d] : [];
            parts[d] = arr;
            counts[d] = arr.length;
        }
        return {
            ok: true, parts: parts, counts: counts,
            at: Number((env.payload && env.payload.updatedAt) || 0) || 0,
            scope: String((env.payload && env.payload.scope) || env.scope || ''),
        };
    } catch (e) { return { ok: false, parts: {}, counts: {}, at: 0, scope: '', reason: String((e && e.message) || e) }; }
}

/**
 * 把逐维片段**合并回一份数据对象**（纯函数；用于载入）。
 * @param {Object<string, any>} parts
 * @returns {{ok:boolean, data:object|null, dims:Object<string, number>, reason?:string}}
 */
export function joinParts(parts) {
    try {
        if (!parts || typeof parts !== 'object') return { ok: false, data: null, dims: {}, reason: 'no-parts' };
        const meta = (parts[META_SHARD] && typeof parts[META_SHARD] === 'object' && !Array.isArray(parts[META_SHARD])) ? parts[META_SHARD] : {};
        const data = Object.assign({}, meta);
        const dims = {};
        for (const d of shardDims()) {
            if (!(d in parts)) continue;
            const arr = Array.isArray(parts[d]) ? parts[d] : [];
            data[d] = arr;
            dims[d] = arr.length;
        }
        return { ok: true, data: data, dims: dims };
    } catch (e) { return { ok: false, data: null, dims: {}, reason: String((e && e.message) || e) }; }
}

/**
 * 生成/校验分片清单（每个片段：字节数、内容哈希、条数）。
 * @param {Object<string, any>} parts
 * @param {{at?:number, scope?:string}} [info]
 * @returns {{v:number, at:number, scope:string, parts:Object<string,{hash:string,bytes:number,n:number}>}}
 */
export function buildManifest(parts, info) {
    const o = info || {};
    const out = { v: LOCAL_SHARD_V, at: Number(o.at || 0) || Date.now(), scope: String(o.scope || ''), parts: {} };
    try {
        for (const k of Object.keys(parts || {})) {
            const text = JSON.stringify(parts[k]);
            const n = Array.isArray(parts[k]) ? parts[k].length : Object.keys(parts[k] || {}).length;
            out.parts[k] = { hash: hashText(text), bytes: text.length, n: n };
        }
    } catch (e) { /* 忽略：清单尽力而为 */ }
    return out;
}

/**
 * 校验「读回来的片段」与清单是否一致（**坏一维就报那一维**，不整体作废）。
 * @returns {{ok:boolean, bad:string[], dims:Object<string, number>}}
 */
export function verifyParts(parts, manifest) {
    const bad = [];
    const dims = {};
    try {
        const want = (manifest && manifest.parts) || {};
        for (const k of Object.keys(want)) {
            const got = parts ? parts[k] : undefined;
            if (got === undefined) { bad.push(k); continue; }
            const text = JSON.stringify(got);
            if (String(want[k].hash) !== hashText(text)) { bad.push(k); continue; }
            dims[k] = Array.isArray(got) ? got.length : Object.keys(got || {}).length;
        }
    } catch (e) { /* 忽略 */ }
    return { ok: bad.length === 0, bad: bad, dims: dims };
}

/** 需要写入/读取的分片名（meta + 全部维度） */
export function allShardNames() { return [META_SHARD].concat(shardDims()); }

export default {
    LOCAL_SHARD_V, META_SHARD, LOCAL_SHARD_PREFIX,
    shardDims, scopeSlug, shardFileName, shardKeyName, manifestFileName, manifestKeyName,
    splitParts, joinParts, buildManifest, verifyParts, allShardNames,
};
