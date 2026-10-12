// ============================================================
// adapters/save-ledger.js —— **本次保存的物理写清单**（v3.46.0，`docs/D22` W9 `数-31` / `docs/D17` U188）
//
// 为什么单独成模块：`docs/05-开发指南.md` §5 约定的 **C11**「新功能一律落新模块，单体文件只允许必要接线」
//   （`docs/D22` W5 `技-14` / `scripts/check-file-size.js`）。这份读数是**新功能**，故落在本模块；
//   `adapters/store.js` 只留六处一行接线（`saveLedgerBegin` / `saveLedgerNote` / `saveLedgerEnd`）。
//
// 解决的问题（`docs/D28` §3.3.2 #1）：此前只有 `lastSave.via`（一个通道名串）与 `ttWriteStats`（原生写计数）——
//   **没有「这次为什么写了 7.5MB」的口径**。真机上「一次保存写了几份整载荷」只能靠猜；有了本清单，
//   「本次写了哪些通道 / 各多少次 / 各多少字节 / 哪些被跳过及原因」变成一条可读、可导出的读数。
//
// 口径（三条纪律）：
//   ① **只读数**：只记录"写了什么"，**不改变任何写入时机与内容**（将来各收敛动作要独立可关，见 `数-31` 验收）；
//   ② **逐通道一行**：`{ ch, writes, bytes, skipped, reason }` —— `skipped>0` 时 `reason` 必带（`unchanged` / `off` / `budget` …）；
//   ③ **环形保留最近 5 次**（`SAVE_LEDGER_MAX`）：只留最近，避免读数本身变成负担。
//
// 边界：本模块**不读盘、不写盘、不碰 DOM**；只有内存里的一个环形数组与三个纯记录函数。
// ============================================================

/** 环形保留的保存次数（够回答「刚才那几次为什么写」；再多就是负担） */
export const SAVE_LEDGER_MAX = 5;

let ring = [];
let cur = null;

/** 开一次新的保存账本（`adapters/store.js#saveStateNowInner` 入口调用） */
export function saveLedgerBegin(scope) {
    cur = { at: Date.now(), scope: String(scope == null ? '' : scope), channels: [] };
    return cur;
}

/** 记一个通道（同通道多次调用则累加 `writes` / `bytes`；`reason` 后写覆盖） */
export function saveLedgerNote(ch, patch) {
    try {
        if (!cur) return;
        const name = String(ch == null ? '' : ch);
        if (!name) return;
        let row = null;
        for (const r of cur.channels) if (r.ch === name) { row = r; break; }
        if (!row) { row = { ch: name, writes: 0, bytes: 0, skipped: 0, reason: '' }; cur.channels.push(row); }
        const p = patch || {};
        if (Number(p.writes)) row.writes += Number(p.writes);
        if (Number(p.bytes)) row.bytes += Number(p.bytes);
        if (Number(p.skipped)) row.skipped += Number(p.skipped);
        if (p.reason !== undefined && p.reason !== '') row.reason = String(p.reason);
    } catch (e) { /* 读数失败绝不影响保存 */ }
}

/** 结束并归档本次账本（返回归档对象；`totalWrites` / `totalBytes` 为跨通道合计） */
export function saveLedgerEnd() {
    try {
        if (!cur) return null;
        const rec = cur;
        rec.totalBytes = rec.channels.reduce((s, r) => s + (Number(r.bytes) || 0), 0);
        rec.totalWrites = rec.channels.reduce((s, r) => s + (Number(r.writes) || 0), 0);
        ring = [rec].concat(ring).slice(0, SAVE_LEDGER_MAX);
        cur = null;
        return rec;
    } catch (e) { cur = null; return null; }
}

/**
 * **短路那一次的留痕**（v3.46.0）：无变化 → 本次**一个字节都没写**，但账本要如实记一条 `no-op`，
 *   否则 `last` 会停留在上一次真正写盘的那次，读者会以为「刚点保存就写了 7.5MB」。
 * @param {string} reason
 */
export function saveLedgerNoop(scope, reason) {
    try {
        saveLedgerBegin(scope);
        saveLedgerNote('no-op', { skipped: 1, reason: String(reason || '内容无变化 → 短路（本次未写任何通道）') });
        return saveLedgerEnd();
    } catch (e) { return null; }
}

/** 只读出口：最近若干次保存的物理写清单（深拷贝副本；`last` = 最近一次） */
export function saveLedgerInfo() {
    try {
        const copy = (r) => (r ? Object.assign({}, r, { channels: (r.channels || []).map((c) => Object.assign({}, c)) }) : null);
        return { max: SAVE_LEDGER_MAX, last: copy(ring[0] || null), recent: ring.map(copy) };
    } catch (e) { return { max: SAVE_LEDGER_MAX, last: null, recent: [] }; }
}

/** 人读摘要（一行；供调试页/日志共用，避免两处措辞漂移） */
export function saveLedgerSummaryText(info) {
    const last = (info && info.last) || null;
    if (!last) return '尚无保存记录。';
    const parts = (last.channels || []).map((c) => c.ch + (c.skipped ? ('（跳过:' + (c.reason || '') + '）') : ('=' + c.bytes + 'B')));
    return '最近一次保存 · ' + String(last.scope || '') + ' · 写 ' + Number(last.totalWrites || 0) + ' 次 / ' + Number(last.totalBytes || 0) + 'B · ' + parts.join(' · ');
}
