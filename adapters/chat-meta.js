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
