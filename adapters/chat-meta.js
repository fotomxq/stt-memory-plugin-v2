// ============================================================
// adapters/chat-meta.js —— **`chatMetadata` 主载体：只读接入与差异报告**（v2.94.0，`docs/D11` v0.3 §3.2 / 阶段 S1；`docs/D12` v0.2 S4b）
//
// 为什么需要它（用户裁决，`docs/D12` §8-C）：
//   「**载体必须比消息活得久** —— 记忆数据主载体是 `chatMetadata`（随聊天存活）；**不得**把消息 `extra`
//     作为唯一载体（删楼会连带删掉）。」
//   → 记忆数据必须**随聊天走**：聊天被 ST 同步 / 备份 / 存档时，`chatMetadata` 一起走，
//     于是「一端删楼、多端同步」时各端拿到的是**同一份记忆**，不会因删楼而丢数据。
//
// 本阶段（S1）的纪律是 **只读不写**：
//   · 探测宿主 API（`ctx.chatMetadata` + `ctx.saveMetadata`）→ 缺失即标记 `unsupported` 并**降级**（不报错）；
//   · 读出 chatMetadata 里本插件命名空间下的那份数据，与**当前生效状态**做**差异报告**
//     （哪边更新 / 各维条数 / 体积 / 是否需要迁移），供调试页与调试包核对；
//   · **绝不写入、绝不改动** chatMetadata —— 写路径属 S3「主通道切换」，本阶段不碰。
//
// 命名空间：`ftt_memory_v2`（与扩展目录名一致），内部结构为自描述信封 `{ format, version, at, scope, state }`。
// ============================================================
import { getCtx } from '../host/st-api.js';
import { MODULE_NAME, VERSION, DIMENSIONS } from '../core/constants.js';
// v3.0.23（用户要求「任何从服务端、本地、内存读取数据等的行为，都要详细记录统计、时间等信息到日志」+
//   「初次激活插件读取的数据还是没有对齐」）：chatMetadata 是「随聊天走」的载体 —— 本版**把它接进载入路径**，
//   并把每次读取记进读取台账（条数 / 体积 / 时间 / 作用域是否匹配）。
import { readLedgerBegin, readLedgerEnd } from '../core/read-ledger.js';

/** chatMetadata 内的命名空间键（与扩展目录名一致，避免与其它扩展冲突） */
export const CHAT_META_KEY = MODULE_NAME;

function meta() {
    try {
        const ctx = getCtx();
        return (ctx && ctx.chatMetadata && typeof ctx.chatMetadata === 'object') ? ctx.chatMetadata : null;
    } catch (e) { return null; }
}

/**
 * 能力探测（`docs/D11` §6：宿主 API 可用性未核实 → 必须探测 + 降级）。
 * @returns {{available:boolean, readable:boolean, writable:boolean, reason:string}}
 */
export function chatMetaCapability() {
    try {
        const ctx = getCtx();
        if (!ctx) return { available: false, readable: false, writable: false, reason: 'no-host' };
        const m = (ctx.chatMetadata && typeof ctx.chatMetadata === 'object') ? ctx.chatMetadata : null;
        if (!m) return { available: false, readable: false, writable: false, reason: 'no-chat-metadata' };
        return {
            available: true,
            readable: true,
            // 写能力存在与否只作**诊断**（S1 只读，不调用）
            writable: (typeof ctx.saveMetadata === 'function'),
            reason: '',
        };
    } catch (e) {
        return { available: false, readable: false, writable: false, reason: 'error' };
    }
}

/**
 * 读取 chatMetadata 中本插件命名空间的数据（**只读**）。
 * @returns {{ok:boolean, present:boolean, reason:string, bytes:number, at:number, version:string,
 *            scope:string, counts:object, total:number, raw:object|null}}
 */
export function chatMetaRead() {
    const empty = { ok: true, present: false, reason: '', bytes: 0, at: 0, version: '', scope: '', counts: {}, total: 0, raw: null };
    try {
        const cap = chatMetaCapability();
        if (!cap.readable) return Object.assign({}, empty, { ok: false, reason: cap.reason });
        const m = meta();
        const raw = m ? m[CHAT_META_KEY] : null;
        if (!raw || typeof raw !== 'object') return empty;
        const state0 = (raw.state && typeof raw.state === 'object') ? raw.state : raw;
        const counts = {};
        let total = 0;
        for (const d of DIMENSIONS) {
            const n = Array.isArray(state0[d.kind]) ? state0[d.kind].length : 0;
            counts[d.kind] = n;
            total += n;
        }
        let bytes = 0;
        try { bytes = JSON.stringify(raw).length; } catch (e) { bytes = 0; }
        return {
            ok: true, present: true, reason: '',
            bytes: bytes,
            at: Number(raw.at) || 0,
            version: String(raw.version || ''),
            scope: String(raw.scope || ''),
            counts: counts, total: total,
            raw: raw,
        };
    } catch (e) {
        return Object.assign({}, empty, { ok: false, reason: 'error' });
    }
}

/** 当前生效状态的同口径摘要（与 `chatMetaRead` 用同一套字段，便于逐项对比） */
export function liveStateSummary(state) {
    const st = state || {};
    const counts = {};
    let total = 0;
    for (const d of DIMENSIONS) {
        const n = Array.isArray(st[d.kind]) ? st[d.kind].length : 0;
        counts[d.kind] = n;
        total += n;
    }
    let bytes = 0;
    try { bytes = JSON.stringify(st).length; } catch (e) { bytes = 0; }
    return { counts: counts, total: total, bytes: bytes, at: 0, version: String(st.version || VERSION), scope: String(st.scope || '') };
}

/**
 * v3.0.23：**把 chatMetadata 当作一个载入源**（用户报告「初次激活插件读取的数据还是没有对齐」）。
 *
 * 背景（`docs/D12` §8-C 用户裁决）：「记忆数据主载体是 `chatMetadata`（随聊天存活）…聊天被酒馆同步 /
 *   备份时 chatMetadata 一起走」。但在此之前 V2 **只把它当差异报告读**（S1 只读不写），
 *   **载入路径完全不看它** —— 于是「换设备 / 恢复聊天备份 / 初次激活」时，聊天自带的那份记忆
 *   一个字节都不参与载入，用户看到的就是「数据没有对齐（好像全丢了）」。
 * 本函数只做**读**（不改 chatMetadata、不写 chatMetadata；写路径仍属后续阶段）：
 *   取出本插件命名空间下的 `{format, version, at, scope, state}`，做最小结构校验后返回 state。
 * @returns {{ok:boolean, present:boolean, reason:string, at:number, bytes:number, total:number,
 *            counts:object, scope:string, scopeMatch:boolean, state:object|null}}
 */
export function chatMetaLoadState() {
    const empty = { ok: true, present: false, reason: '', at: 0, bytes: 0, total: 0, counts: {}, scope: '', scopeMatch: true, state: null };
    const tok = readLedgerBegin('读聊天元数据', 'chatmeta', { target: CHAT_META_KEY });
    try {
        const cap = chatMetaCapability();
        if (!cap.readable) { readLedgerEnd(tok, { ok: true, miss: true, reason: cap.reason || 'unsupported' }); return Object.assign({}, empty, { ok: false, reason: cap.reason || 'unsupported' }); }
        const m = meta();
        const raw = m ? m[CHAT_META_KEY] : null;
        if (!raw || typeof raw !== 'object') { readLedgerEnd(tok, { ok: true, miss: true, reason: 'no-meta-data', note: '聊天里没有本插件的记忆数据' }); return empty; }
        const state0 = (raw.state && typeof raw.state === 'object') ? raw.state : null;
        if (!state0) { readLedgerEnd(tok, { ok: false, reason: 'no-state', bytes: 0 }); return Object.assign({}, empty, { ok: false, reason: 'no-state' }); }
        const counts = {};
        let total = 0;
        for (const d of DIMENSIONS) { const n = Array.isArray(state0[d.kind]) ? state0[d.kind].length : 0; counts[d.kind] = n; total += n; }
        let bytes = 0;
        try { bytes = JSON.stringify(raw).length; } catch (e) { bytes = 0; }
        const scope = String(raw.scope || state0.scope || '');
        // ⚠️ **必须深拷贝**：`raw.state` 是 chatMetadata 里的**活对象**，直接挂进内核后，保存流水线
        //   （墓碑扫 / 瘦身 / 索引）会就地改它 —— 那就等于「写 chatMetadata」，违反本阶段「只读不写」的纪律
        //   （`docs/D11` §5 S1 / `docs/D12` S4b）。载入只取一份**快照**。
        let snapshot = null;
        try { snapshot = JSON.parse(JSON.stringify(state0)); } catch (e) { snapshot = null; }
        if (!snapshot) { readLedgerEnd(tok, { ok: false, reason: 'clone-failed', bytes: bytes }); return Object.assign({}, empty, { ok: false, reason: 'clone-failed' }); }
        const r = {
            ok: true, present: true, reason: '', at: Number(raw.at) || Number(state0.updatedAt) || 0,
            bytes: bytes, total: total, counts: counts, scope: scope, scopeMatch: true, state: snapshot,
        };
        readLedgerEnd(tok, {
            ok: true, bytes: bytes, items: total,
            extra: { at: r.at, scope: scope, dims: Object.keys(counts).filter((k) => counts[k] > 0) },
            note: '聊天元数据里有 ' + total + ' 条（随聊天走的载体）',
        });
        return r;
    } catch (e) {
        readLedgerEnd(tok, { ok: false, reason: String((e && e.message) || e) });
        return Object.assign({}, empty, { ok: false, reason: String((e && e.message) || e) });
    }
}

/**
 * **只读差异报告**（`docs/D11` §5 S1 验收口径；`docs/D12` S4b）。
 * 逐项给出「chatMetadata 里那份」与「当前生效状态」的条数差、体积、时间先后，并给出可执行结论
 * （`same` / `meta-newer` / `live-newer` / `meta-only` / `live-only` / `differs`）。
 *
 * @param {object} liveState 当前内核 state
 * @returns {{ok:boolean, reason:string, available:boolean, present:boolean, verdict:string,
 *            meta:object, live:object, dims:object, text:string}}
 */
export function chatMetaDiffReport(liveState) {
    const live = liveStateSummary(liveState);
    const r = chatMetaRead();
    const cap = chatMetaCapability();
    const dims = {};
    for (const d of DIMENSIONS) {
        const a = Number((r.counts || {})[d.kind]) || 0;
        const b = Number((live.counts || {})[d.kind]) || 0;
        if (a !== b) dims[d.kind] = { meta: a, live: b, delta: a - b };
    }
    let verdict = 'same';
    if (!cap.available) verdict = 'unsupported';
    else if (!r.present) verdict = live.total > 0 ? 'live-only' : 'empty';
    else if (live.total === 0) verdict = 'meta-only';
    else if (Object.keys(dims).length === 0) verdict = 'same';
    else verdict = (r.at > live.at) ? 'meta-newer' : 'live-newer';
    const text = (() => {
        if (verdict === 'unsupported') return '宿主不提供 chatMetadata（' + cap.reason + '）→ 本阶段降级：仍走文件通道（数据不受影响）。';
        if (verdict === 'empty') return 'chatMetadata 与当前状态都没有本插件的记忆数据。';
        if (verdict === 'live-only') return 'chatMetadata 里还没有本插件的记忆（当前 ' + live.total + ' 条只在文件通道）→ S3 迁移时才需要灌入，本阶段**只读不动**。';
        if (verdict === 'meta-only') return 'chatMetadata 里有 ' + r.total + ' 条，当前生效状态为空 → 需要人工确认后再恢复。';
        if (verdict === 'same') return '两边一致（各 ' + live.total + ' 条 · ' + live.bytes + '/' + r.bytes + ' 字节）→ 无需处理。';
        const parts = Object.keys(dims).map((k) => k + ' ' + dims[k].meta + '→' + dims[k].live).join(' · ');
        return '两边条目数不同：' + parts + '（差异 ' + Object.keys(dims).length + ' 类）→ 目前以文件通道为准，未做任何改动。';
    })();
    return {
        ok: !!r.ok, reason: String(r.reason || ''), available: !!cap.available, present: !!r.present,
        verdict: verdict, meta: r, live: live, dims: dims, text: text,
    };
}

/** 差异报告人读多行文本（调试包用；不含任何记忆正文） */
export function chatMetaDiffText(liveState) {
    const d = chatMetaDiffReport(liveState);
    const lines = [
        '主载体（chatMetadata）只读差异报告' + (d.available ? '' : '［宿主不支持 → 已降级］'),
        '· 命名空间：' + CHAT_META_KEY + '（本阶段只读不写）',
        '· chatMetadata：' + (d.present ? (d.meta.total + ' 条 · ' + d.meta.bytes + ' 字节 · 写入于 ' + (d.meta.at ? new Date(d.meta.at).toISOString() : '未知')) : '（无本插件数据）'),
        '· 当前生效状态：' + d.live.total + ' 条 · ' + d.live.bytes + ' 字节',
        '· 结论：' + d.verdict + ' — ' + d.text,
    ];
    const keys = Object.keys(d.dims);
    for (const k of keys) lines.push('  - ' + k + '：chatMetadata ' + d.dims[k].meta + ' / 当前 ' + d.dims[k].live + '（差 ' + d.dims[k].delta + '）');
    return lines.join('\n');
}
