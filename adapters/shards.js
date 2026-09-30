// ============================================================
// adapters/shards.js —— **按维度的分片提交**（v3.0.21）
//
// 用户要求（原话）：「修复存储异常，当退出应用后，插件的数据大量回滚。之前发现是内存问题，建议一劳永逸，
//   第一次启动不用内存或本地数据。每次数据变动立刻分片提交到服务端存储，实现实时存储能力。」
//
// 定位：在**主文件（完整信封）不变**的前提下，再加一层**按维度分片**的耐久通道。
//   · 每个原子维度一个文件：`ftt2-shard-<slug>-<维度>.json`；其余小容器（时钟 / 变量 / 统计 / 墓碑账本 /
//     快照链 / 已处理台账 …）合成一个 `meta` 分片；
//   · 另有一份**分片清单** `ftt2-shard-<slug>-manifest.json`（每片 `{at, hash, bytes, n}`）——载入时只读它 1 次；
//   · **写**：只在**该片内容哈希变化**时才上传（未变的片一个字节都不发）→ 真正增量、可实时；
//   · **读**：载入（或读对端信封）后，若某片的 `at` **晚于主文件信封时间** → 读该片并覆盖对应维度 ——
//     于是**主文件写入滞后 / 失败（超时、被杀进程、切后台）时，改动仍能从分片恢复**，不会再「大量回滚」。
//
// 兼容与失败姿态：主文件仍是**完整信封**（跨端同步 / 备份 / 导入 / V1 迁移全部照旧）；分片是**附加**的，
//   缺失 / 损坏 / 校验不过 → 一律静默忽略（绝不影响主路径）；分片上传失败也不影响主文件写入。
// ============================================================
import { ATOM_DIM_KEYS } from '../core/constants.js';
import { hashText } from '../core/util.js';
import { scopeId } from '../core/state.js';
import { state as kernelState } from '../core/model/runtime.js';
import { fileTransportUploadText, fileTransportReadAuto } from './file-transport.js';
import { slugify } from './user-file.js';
// v3.0.23（用户要求「任何…读取…都要详细记录统计、时间等信息到日志」）：分片的每一次读取都进读取台账
//   （清单 1 次 + 每个需要读的维度片各 1 次），并记下「读了哪几片 / 应用了哪几片」。
import { readLedgerBegin, readLedgerEnd, readLedgerRecord } from '../core/read-ledger.js';

/** 分片前缀（刻意不与主文件 `ftt2-state-` / 删楼备份 `ftt2-floor-backup-` 冲突） */
export const SHARD_PREFIX = 'ftt2-shard-';
/** 小容器合成片的名字 */
export const META_SHARD = 'meta';

/** `meta` 片收录的小容器键（其余键不进分片：它们要么是派生态，要么逐次全量重算） */
export const META_KEYS = Object.freeze([
    'state', 'vars', 'stats', 'deleted', 'deletedH', 'snapStore', 'processedFloors', 'processedVer',
    'lastKnownFloor', 'weaveLastFloor', 'rumorTick', 'curations', 'coverReset', 'floorShrinkAt', 'snapFp',
]);
/** 逐维度分片的维度键（原子维度 + 货币） */
export const SHARD_DIMS = Object.freeze(ATOM_DIM_KEYS.concat(['currencies']));

/** 单个分片文件名 */
export function shardName(slugOrScope, dim) {
    return SHARD_PREFIX + slugify(String(slugOrScope || scopeId())) + '-' + String(dim) + '.json';
}
/** 分片清单文件名 */
export function shardManifestName(slugOrScope) {
    return SHARD_PREFIX + slugify(String(slugOrScope || scopeId())) + '-manifest.json';
}

/** 该分片的当前内容（引用，不拷贝） */
function shardValue(st, dim) {
    const s = st || {};
    if (dim === META_SHARD) {
        const out = {};
        for (const k of META_KEYS) if (s[k] !== undefined) out[k] = s[k];
        return out;
    }
    return Array.isArray(s[dim]) ? s[dim] : [];
}

/** 分片载荷签名（内容哈希 + 条数；用于「只上传变化过的片」） */
export function shardSig(st, dim) {
    try {
        const v = shardValue(st, dim);
        const text = JSON.stringify(v === undefined ? null : v) || '';
        const n = Array.isArray(v) ? v.length : Object.keys(v || {}).length;
        return { hash: hashText(text), bytes: text.length, n: n };
    } catch (e) { return { hash: '', bytes: 0, n: 0 }; }
}

/** 上一次已上传的各片签名（进程内；失败/未上传的片不会被记下 → 下次仍会重试） */
let lastHashes = Object.create(null);
/** 清单是否已经成功写过一次（写在服务端）——没有任何分片变化时就不必再写一遍清单 */
let manifestPushed = false;

/**
 * 只上传**内容变化过**的分片，并更新清单。
 * @param {object} [st] 状态容器（缺省用内核 state）
 * @param {{force?:boolean, at?:number}} [opts] `force` = 忽略签名缓存（首次 / 手动同步用）；
 *   `at` = **本次所属信封的时间戳**（保存流水线把信封的 `payload.updatedAt` 传进来）——
 *   清单里记的就是它，于是「主文件与分片同属一次写入」时载入侧不会误判成「分片更新」（零多余请求）。
 * @returns {Promise<{ok:boolean, wrote:string[], skipped:string[], failed:object, manifest:string, at:number}>}
 */
export async function writeStateShards(st, opts) {
    const o = opts || {};
    const s = st || kernelState() || {};
    const slug = scopeId();
    const at = Number(o.at) > 0 ? Number(o.at) : Date.now();
    const out = { ok: true, wrote: [], skipped: [], failed: {}, manifest: shardManifestName(slug), at: at };
    const marks = Object.create(null);
    for (const dim of SHARD_DIMS.concat([META_SHARD])) {
        const sig = shardSig(s, dim);
        marks[dim] = { at: at, hash: sig.hash, bytes: sig.bytes, n: sig.n };
        if (!o.force && sig.hash && lastHashes[dim] === sig.hash) { out.skipped.push(dim); continue; }
        const body = JSON.stringify({ v: 1, scope: slug, dim: dim, at: at, hash: sig.hash, payload: shardValue(s, dim) });
        let r = null;
        try { r = await fileTransportUploadText(shardName(slug, dim), body); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
        if (r && r.ok) { lastHashes[dim] = sig.hash; out.wrote.push(dim); }
        else { out.ok = false; out.failed[dim] = String((r && (r.error || r.reason)) || 'write-failed'); }
    }
    // 清单最后写（它是「哪些片是新的」的唯一索引；写失败只影响恢复能力，不影响主文件）。
    //   v3.0.21：**没有任何分片变化时不重写清单** —— 主文件（提交点）时间戳前移即可，
    //   载入侧对「清单时间戳 ≤ 主文件时间戳」的片一律跳过（内容本来就没变）→ 事件驱动的空保存不浪费流量。
    if (!out.wrote.length && manifestPushed && !o.force) { out.manifest = '(unchanged)'; return out; }
    try {
        const mBody = JSON.stringify({ v: 1, scope: slug, at: at, marks: marks });
        const mr = await fileTransportUploadText(shardManifestName(slug), mBody);
        if (!mr || !mr.ok) { out.ok = false; out.failed.manifest = String((mr && (mr.error || mr.reason)) || 'write-failed'); }
        else manifestPushed = true;
    } catch (e) { out.ok = false; out.failed.manifest = String((e && e.message) || e); }
    return out;
}

/** 读分片清单（缺失 / 损坏 → null；1 次请求） */
export async function readShardManifest(slugOrScope) {
    const name = shardManifestName(slugOrScope);
    const tok = readLedgerBegin('读分片清单', 'meta', { target: name });
    try {
        const r = await fileTransportReadAuto(name, { src: 'meta', role: '分片清单' });
        if (!r || !r.ok || !r.text) { readLedgerEnd(tok, { ok: true, miss: true, reason: String((r && r.error) || 'no-manifest') }); return null; }
        const m = JSON.parse(r.text);
        if (!m || typeof m !== 'object' || !m.marks) { readLedgerEnd(tok, { ok: false, reason: 'bad-manifest', bytes: String(r.text).length }); return null; }
        const dims = Object.keys(m.marks);
        readLedgerEnd(tok, { ok: true, bytes: String(r.text).length, fields: dims.length, extra: { dims: dims.slice(0, 20) }, note: '清单含 ' + dims.length + ' 片' });
        return m;
    } catch (e) {
        readLedgerEnd(tok, { ok: false, reason: String((e && e.message) || e) });
        return null;
    }
}

/** 读单片的载荷（校验分片内容哈希；不符 → null） */
export async function readShard(slugOrScope, dim) {
    const name = shardName(slugOrScope, dim);
    const tok = readLedgerBegin('读分片', 'shard', { target: name });
    try {
        const r = await fileTransportReadAuto(name, { src: 'shard', role: '维度分片' });
        if (!r || !r.ok || !r.text) { readLedgerEnd(tok, { ok: true, miss: true, reason: String((r && r.error) || 'no-shard'), extra: { dim: String(dim) } }); return null; }
        const p = JSON.parse(r.text);
        if (!p || p.dim !== String(dim)) { readLedgerEnd(tok, { ok: false, reason: 'dim-mismatch', bytes: String(r.text).length, extra: { dim: String(dim) } }); return null; }
        const h = hashText(JSON.stringify(p.payload === undefined ? null : p.payload) || '');
        if (p.hash && h !== p.hash) { readLedgerEnd(tok, { ok: false, reason: 'hash-mismatch', bytes: String(r.text).length, hash: h, extra: { dim: String(dim) } }); return null; }   // 内容被截断/损坏 → 忽略
        const n = Array.isArray(p.payload) ? p.payload.length : Object.keys(p.payload || {}).length;
        readLedgerEnd(tok, { ok: true, bytes: String(r.text).length, items: n, hash: p.hash || h, extra: { dim: String(dim), at: Number(p.at) || 0 }, note: '片校验通过' });
        return { dim: String(dim), at: Number(p.at) || 0, hash: p.hash || h, payload: p.payload };
    } catch (e) {
        readLedgerEnd(tok, { ok: false, reason: String((e && e.message) || e), extra: { dim: String(dim) } });
        return null;
    }
}

/**
 * 把**比主文件更新**的分片应用到状态上（原地）。
 * @param {object} st 目标状态（来自主文件 / 本机缓冲）
 * @param {number} mainAt 主文件的信封时间（`payload.updatedAt`）
 * @param {{slug?:string}} [opts]
 * @returns {Promise<{applied:string[], skipped:string[], at:number}>}
 */
export async function applyNewerShards(st, mainAt, opts) {
    const o = opts || {};
    const slug = o.slug || scopeId();
    const out = { applied: [], skipped: [], at: 0 };
    try {
        if (!st || typeof st !== 'object') return out;
        const m = await readShardManifest(slug);
        if (!m || !m.marks) {
            try { readLedgerRecord({ action: '分片对账', src: 'shard', target: shardManifestName(slug), ok: true, miss: true, reason: 'no-manifest', note: '没有分片清单 → 本次无分片可应用（主文件时间 ' + base + '）' }); } catch (e) { /* 忽略 */ }
            return out;
        }
        out.at = Number(m.at) || 0;
        const base = Number(mainAt) || 0;
        // 需要读的分片：**严格更新**（主文件写入滞后/失败）—— 或时间戳相同但该维度内容与清单记录不一致
        //   （同一毫秒内先写分片再写主文件、而主文件那次没写成的边界情形）。
        const allDims = Object.keys(m.marks);
        const dims = allDims.filter((d) => {
            const mk = m.marks[d] || {};
            const mat = Number(mk.at) || 0;
            if (mat > base) return true;
            if (mat !== base) return false;
            try { return !!mk.hash && shardSig(st, d).hash !== mk.hash; } catch (e) { return false; }
        });
        for (const dim of dims) {
            const sh = await readShard(slug, dim);
            if (!sh) { out.skipped.push(dim); continue; }
            if (dim === META_SHARD) {
                const p = sh.payload || {};
                for (const k of META_KEYS) if (p[k] !== undefined) { try { st[k] = p[k]; } catch (e) { /* 忽略 */ } }
            } else {
                try { st[dim] = Array.isArray(sh.payload) ? sh.payload : []; } catch (e) { /* 忽略 */ }
            }
            out.applied.push(dim);
        }
        // v3.0.23：把「清单里有多少片 / 读了哪几片 / 应用了哪几片」记成一条（载入路径可追踪）
        try {
            readLedgerRecord({
                action: '分片对账', src: 'shard', target: shardManifestName(slug),
                ok: true, items: out.applied.length, ms: 0,
                extra: { marks: allDims.length, need: dims.length, applied: out.applied, skipped: out.skipped, mainAt: base, shardAt: out.at },
                note: '清单 ' + allDims.length + ' 片 · 需读 ' + dims.length + ' 片 · 应用 ' + out.applied.length + ' 片（主文件时间 ' + base + '）',
            });
        } catch (e) { /* 忽略 */ }
        return out;
    } catch (e) { return out; }
}

/** 进程内签名缓存复位（测试 / 手动同步「强制全量重传」用） */
export function resetShardMarks() { lastHashes = Object.create(null); manifestPushed = false; return true; }
/** 当前已上传签名快照（诊断用；不含内容） */
export function shardMarks() { return Object.assign({}, lastHashes); }
