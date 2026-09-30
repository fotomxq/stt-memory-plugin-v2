// ============================================================
// core/read-ledger.js —— **读取台账：服务端 / 本地 / 内存的每一次数据读取**（v3.0.23，纯内核）
//
// 用户要求（原话）：「任何从服务端、本地、内存读取数据等的行为，都要详细记录统计、时间等信息到日志，方便追踪问题。」
//
// 为什么单独一层（与 `core/pipeline.js` 的分工）：
//   · `pipeline` 回答「**正在做什么**、还要多久」——面向进行中的**写/算**动作；
//   · `read-ledger` 回答「**读到了什么**、从哪一层读的、花了多久、为什么没读到」——面向载入路径的
//     **取证**：初次激活数据没对齐时，第一个要问的就是「主文件读了没有？哈希过没过？分片应用了几片？
//     聊天元数据里有没有？内存库里有没有？」。
//
// 纪律：
//   · **纯内核**：无 DOM / 无宿主 / 无定时器；时间与日志出口都由宿主注入（`setReadLedgerHooks`，默认 no-op）；
//     同一份台账同时供「调试页区块 / 调试包文本 / storeStatus 诊断」读取，避免三处口径漂移。
//   · **绝不抛**：任何一次记录失败都吞掉（台账是观测设施，绝不能反过来弄坏主流程）。
//   · **内存恒定**：环形缓冲 `READ_LEDGER_CAP` 条（最新在前）+ 分来源累计计数；不落盘、不随会话增长。
//   · **不记正文**：只记**体积 / 条数 / 字段名 / 哈希 / 结果**，绝不记聊天或记忆正文（与 `trace.js` 同口径）。
// ============================================================

/** 环形缓冲上限（条） */
export const READ_LEDGER_CAP = 240;

/** 读取来源标签（UI 与日志共用一份，防止各处自造文案） */
export const READ_SRC_LABEL = Object.freeze({
    file: '服务端文件',
    shard: '服务端分片',
    meta: '分片清单',
    local: '本机缓冲',
    idb: '本机内存库',
    chatmeta: '聊天元数据',
    remote: '对端文件',
    settings: '扩展设置',
    cfg: '内核配置',
    memory: '内存态',
    backup: '删楼备份',
    import: '导入来源',
    other: '其它',
});

export function readSrcLabel(src) {
    const k = String(src || '');
    return READ_SRC_LABEL[k] || READ_SRC_LABEL.other;
}

let hooks = {
    now: () => Date.now(),
    // 宿主注入：把一条读取记录写进调试日志 / 交互时间线（默认 no-op，内核零宿主依赖）
    log: () => undefined,       // (rec) => void
};
export function setReadLedgerHooks(next) { hooks = Object.assign({}, hooks, next || {}); return hooks; }
export function readLedgerHooks() { return Object.assign({}, hooks); }

/** 记录表（最新在前） */
let records = [];
/** 分来源累计（内存恒定；进程内统计） */
let bySrc = Object.create(null);
let seq = 0;
let totalMs = 0;
let totalBytes = 0;

function nowMs() {
    try { const v = Number(hooks.now()); return Number.isFinite(v) ? v : Date.now(); } catch (e) { return Date.now(); }
}

/** 数字归一（NaN / 负数 → 0） */
function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }

/** 体积展示（B / KB / MB；与调试页其它区块口径一致） */
export function fmtBytes(n) {
    const v = num(n);
    if (v < 1024) return v + 'B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + 'KB';
    return (v / 1024 / 1024).toFixed(2) + 'MB';
}

/** 时长展示（ms；≥1s 用 s） */
export function fmtMs(n) {
    const v = num(n);
    return v >= 1000 ? ((v / 1000).toFixed(2).replace(/\.?0+$/, '') + 's') : (Math.round(v) + 'ms');
}

/**
 * 开一条读取（配合 `readLedgerEnd`；返回的 token 只在本模块内解释）。
 * @param {string} action 读的动作（如「读主文件」「读分片清单」「读本机内存库」）
 * @param {string} src 来源键（`READ_SRC_LABEL` 的键）
 * @param {{target?:string, note?:string}} [opts]
 */
export function readLedgerBegin(action, src, opts) {
    const o = opts || {};
    return {
        id: ++seq,
        at: nowMs(),
        action: String(action || '读取'),
        src: String(src || 'other'),
        target: String(o.target == null ? '' : o.target),
        note: String(o.note == null ? '' : o.note),
    };
}

/**
 * 收一条读取（把开始到现在的耗时写进记录）。
 * @param {object} tok `readLedgerBegin` 的返回值
 * @param {{ok?:boolean, miss?:boolean, bytes?:number, chars?:number, items?:number, fields?:number,
 *          hash?:string, reason?:string, note?:string, extra?:object, quiet?:boolean}} [res]
 * @returns {object|null} 记录（已入台账）
 */
export function readLedgerEnd(tok, res) {
    if (!tok || typeof tok !== 'object') return null;
    const r = res || {};
    return readLedgerRecord(Object.assign({}, r, {
        action: tok.action,
        src: tok.src,
        target: tok.target,
        note: r.note != null ? r.note : tok.note,
        at: tok.at,
        ms: Math.max(0, nowMs() - num(tok.at)),
    }));
}

/**
 * 直接记一条（一次性读取 / 由宿主代记；`ms` 缺省用 `at` 推算）。
 * @param {object} rec `{action, src, target?, at?, ms?, ok?, miss?, bytes?, chars?, items?, fields?, hash?, reason?, note?, extra?}`
 */
export function readLedgerRecord(rec) {
    try {
        const r = rec || {};
        const at = num(r.at) || nowMs();
        const ms = num(r.ms);
        const item = {
            seq: ++seq,
            at: at,
            ms: ms,
            action: String(r.action || '读取'),
            src: String(r.src || 'other'),
            srcLabel: readSrcLabel(r.src),
            target: String(r.target == null ? '' : r.target).slice(0, 120),
            ok: r.ok !== false,
            miss: r.miss === true,
            bytes: num(r.bytes),
            chars: num(r.chars),
            items: num(r.items),
            fields: num(r.fields),
            hash: String(r.hash == null ? '' : r.hash).slice(0, 24),
            reason: String(r.reason == null ? '' : r.reason).slice(0, 160),
            note: String(r.note == null ? '' : r.note).slice(0, 200),
        };
        if (r.extra && typeof r.extra === 'object') {
            const ex = {};
            for (const k of Object.keys(r.extra).slice(0, 12)) {
                const v = r.extra[k];
                ex[String(k).slice(0, 24)] = (v && typeof v === 'object') ? (Array.isArray(v) ? v.slice(0, 12) : '[obj]') : String(v).slice(0, 60);
            }
            item.extra = ex;
        }
        records.unshift(item);
        if (records.length > READ_LEDGER_CAP) records.length = READ_LEDGER_CAP;
        const s = bySrc[item.src] || (bySrc[item.src] = { n: 0, ok: 0, fail: 0, miss: 0, ms: 0, bytes: 0, items: 0, fields: 0, maxMs: 0 });
        s.n += 1;
        if (item.ok) s.ok += 1; else s.fail += 1;
        if (item.miss) s.miss += 1;
        s.ms += item.ms;
        s.bytes += item.bytes;
        s.items += item.items;
        s.fields += item.fields;
        if (item.ms > s.maxMs) s.maxMs = item.ms;
        totalMs += item.ms;
        totalBytes += item.bytes;
        if (r.quiet !== true) { try { hooks.log(item); } catch (e) { /* 忽略 */ } }
        return item;
    } catch (e) { return null; }
}

/** 台账列表（最新在前；`limit` 缺省全部缓冲） */
export function readLedgerList(limit) {
    const n = num(limit) || records.length;
    return records.slice(0, n).map((r) => Object.assign({}, r));
}

/** 统计汇总（调试页 / storeStatus / 调试包共用一份口径） */
export function readLedgerStats() {
    const srcs = {};
    for (const k of Object.keys(bySrc)) srcs[k] = Object.assign({ label: readSrcLabel(k) }, bySrc[k], { avgMs: bySrc[k].n ? Math.round(bySrc[k].ms / bySrc[k].n) : 0 });
    let fail = 0, miss = 0, ok = 0;
    for (const k of Object.keys(bySrc)) { ok += bySrc[k].ok; fail += bySrc[k].fail; miss += bySrc[k].miss; }
    const slowest = records.slice().sort((a, b) => b.ms - a.ms).slice(0, 5).map((r) => Object.assign({}, r));
    const recent = records.slice(0, 12).map((r) => Object.assign({}, r));
    let lastAt = 0;
    for (const r of records) if (r.at > lastAt) lastAt = r.at;
    return {
        count: records.length, totalReads: Object.keys(bySrc).reduce((n, k) => n + bySrc[k].n, 0),
        ok: ok, fail: fail, miss: miss,
        totalMs: Math.round(totalMs), avgMs: (ok + fail) ? Math.round(totalMs / (ok + fail)) : 0,
        totalBytes: totalBytes, lastAt: lastAt, cap: READ_LEDGER_CAP,
        bySrc: srcs, slowest: slowest, recent: recent,
    };
}

/** 单条文本（调试页一行） */
export function readLedgerLine(rec) {
    const r = rec || {};
    const hhmmss = (() => {
        try { return new Date(num(r.at)).toLocaleTimeString('zh-CN', { hour12: false }); } catch (e) { return '--:--:--'; }
    })();
    const parts = [hhmmss, r.srcLabel || readSrcLabel(r.src), String(r.action || '读取')];
    if (r.target) parts.push(String(r.target));
    parts.push(r.miss ? '未命中' : (r.ok === false ? '失败' : '✓'));
    parts.push(fmtMs(r.ms));
    if (r.bytes) parts.push(fmtBytes(r.bytes));
    if (r.items) parts.push(Number(r.items) + ' 条');
    if (r.fields) parts.push(Number(r.fields) + ' 字段');
    if (r.hash) parts.push('#' + String(r.hash).slice(0, 8));
    if (r.reason) parts.push('原因：' + String(r.reason));
    if (r.note) parts.push(String(r.note));
    return parts.join(' · ');
}

/** 台账行文本（最新在前） */
export function readLedgerLines(limit) { return readLedgerList(limit).map(readLedgerLine); }

/** 汇总文本（调试包用；多行，不含任何正文） */
export function readLedgerSummaryText(limit) {
    const st = readLedgerStats();
    const lines = [];
    lines.push('读取台账：共 ' + st.totalReads + ' 次（成功 ' + st.ok + ' / 失败 ' + st.fail + ' / 未命中 ' + st.miss
        + '）· 累计耗时 ' + fmtMs(st.totalMs) + ' · 平均 ' + fmtMs(st.avgMs) + ' · 累计读取 ' + fmtBytes(st.totalBytes));
    for (const k of Object.keys(st.bySrc)) {
        const s = st.bySrc[k];
        lines.push('  · ' + (s.label || k) + '：' + s.n + ' 次（失败 ' + s.fail + ' / 未命中 ' + s.miss + '）· 共 ' + fmtMs(s.ms)
            + ' · 最慢 ' + fmtMs(s.maxMs) + ' · ' + fmtBytes(s.bytes) + ' · ' + s.items + ' 条');
    }
    for (const l of readLedgerLines(limit || 20)) lines.push('  ' + l);
    return lines.join('\n');
}

/** 复位（测试 / 手动清空台账用） */
export function resetReadLedger() {
    records = [];
    bySrc = Object.create(null);
    seq = 0;
    totalMs = 0;
    totalBytes = 0;
    return true;
}
