// ============================================================
// adapters/local-parts.js —— **快照 / 日志的结构化拆分**（v3.32.0，用户要求）
//
// 用户原话：「本地存储的快照，也需要拆分结构化存储，避免单一文件聚合。日志文件也需要拆开做存储。」
//
// 事实（v3.31.x 之前）：
//   · **快照链**：整条链聚合成**一个**文件（`ftt2-snap-<scope>.json`，几百 KB~MB 级）；
//   · **日志**：调试日志 / 同步日志各自**一个大数组**（单文件 / 单键，撞配额、也难按时间取用）。
//   本模块把两者也**拆成结构化小文件**：
//     · 快照：`snapshots/<条目 id>.json`（一条一个文件）+ `snapshots/manifest.json`（链顺序 + 逐条 hash/bytes/n/ts）；
//     · 日志：`logs/<kind>-<YYYY-MM-DD>.json`（**按天分片**）+ `logs/manifest.json`（各片 hash/bytes/条数/时间范围）。
//   纯函数（拆分 / 合并 / 命名 / 清单），宿主读写由调用方注入 —— 与服务端分片、本机层分片同构。
// ============================================================
import { hashText } from '../core/util.js';

/** 结构版本 */
export const LOCAL_PARTS_V = 1;
/** 目录名 */
export const SNAP_DIR = 'snapshots';
export const LOG_DIR = 'logs';
export const SNAP_MANIFEST = 'manifest.json';
export const LOG_MANIFEST = 'manifest.json';

/** 文件名安全化（快照 id / 日志名都过一遍） */
export function safePartName(name) {
    const s = String(name == null ? '' : name).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
    return s || 'part';
}
/** 快照条目文件名 */
export function snapPartFileName(id) { return safePartName(id) + '.json'; }
/** 日志分片文件名（按天） */
export function logPartFileName(kind, day) { return safePartName(kind) + '-' + safePartName(day) + '.json'; }
/** 条目时间戳 → `YYYY-MM-DD`（本地时区；非法 → `unknown`） */
export function dayKeyOf(ts) {
    try {
        const n = Number(ts);
        if (!Number.isFinite(n) || n <= 0) return 'unknown';
        const d = new Date(n);
        const p = (x) => String(x).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    } catch (e) { return 'unknown'; }
}

/**
 * 快照链 → 逐条文件（一条一个文件，避免单文件聚合）。
 * @param {Array<object>} snapStore `state.snapStore`
 * @returns {{ok:boolean, manifest:object, files:Object<string,string>, reason?:string}}
 */
export function snapshotParts(snapStore) {
    try {
        const list = Array.isArray(snapStore) ? snapStore : [];
        const files = {};
        const parts = {};
        const order = [];
        for (const raw of list) {
            if (!raw || typeof raw !== 'object') continue;
            const id = safePartName(raw.id || ('snap_' + order.length));
            const text = JSON.stringify(raw);
            files[snapPartFileName(id)] = text;
            parts[snapPartFileName(id)] = {
                id: String(raw.id || id), kind: String(raw.kind || ''), ts: String(raw.ts || ''),
                hash: hashText(text), bytes: text.length,
                n: Object.keys(raw.atomsHashes || {}).length,
            };
            order.push(snapPartFileName(id));
        }
        return {
            ok: true, files: files,
            manifest: { v: LOCAL_PARTS_V, dir: SNAP_DIR, at: Date.now(), count: order.length, order: order, parts: parts },
        };
    } catch (e) { return { ok: false, manifest: null, files: {}, reason: String((e && e.message) || e) }; }
}

/**
 * 逐条文件 → 快照链（按 manifest.order 还原顺序；坏条只报坏条）。
 * @returns {{ok:boolean, snapStore:Array, bad:string[]}}
 */
export function joinSnapshotParts(manifest, files) {
    const bad = [];
    const out = [];
    try {
        const order = (manifest && Array.isArray(manifest.order)) ? manifest.order : Object.keys(files || {});
        for (const name of order) {
            const raw = files ? files[name] : undefined;
            if (typeof raw !== 'string') { bad.push(name); continue; }
            const want = (manifest && manifest.parts && manifest.parts[name]) || null;
            if (want && String(want.hash) !== hashText(raw)) { bad.push(name); continue; }
            try { out.push(JSON.parse(raw)); } catch (e) { bad.push(name); }
        }
        return { ok: bad.length === 0, snapStore: out, bad: bad };
    } catch (e) { return { ok: false, snapStore: out, bad: bad }; }
}

/**
 * 日志条目 → **按天分片**文件。
 * @param {Array<object>} entries 日志条目（需带 `at`）
 * @param {string} kind 日志种类（`debug` / `sync` …）
 * @param {{cap?:number}} [opts] `cap` = 每片最多条数（超出再切 `-2`、`-3`…）
 * @returns {{ok:boolean, manifest:object, files:Object<string,string>}}
 */
export function logParts(entries, kind, opts) {
    try {
        const o = opts || {};
        const cap = Math.max(1, Number(o.cap) || 500);
        const list = (Array.isArray(entries) ? entries : []).filter((x) => x && typeof x === 'object');
        const byDay = new Map();
        for (const e of list) {
            const day = dayKeyOf(e.at != null ? e.at : e.ts);
            if (!byDay.has(day)) byDay.set(day, []);
            byDay.get(day).push(e);
        }
        const files = {};
        const parts = {};
        const days = [];
        for (const day of Array.from(byDay.keys()).sort()) {
            const arr = byDay.get(day);
            const chunks = [];
            for (let i = 0; i < arr.length; i += cap) chunks.push(arr.slice(i, i + cap));
            chunks.forEach((chunk, idx) => {
                const name = logPartFileName(kind, day + (idx ? ('-' + (idx + 1)) : ''));
                const text = JSON.stringify(chunk);
                files[name] = text;
                parts[name] = {
                    day: day, n: chunk.length, hash: hashText(text), bytes: text.length,
                    from: Number((chunk[0] && chunk[0].at) || 0) || 0,
                    to: Number((chunk[chunk.length - 1] && chunk[chunk.length - 1].at) || 0) || 0,
                };
                days.push(name);
            });
        }
        return {
            ok: true, files: files,
            manifest: { v: LOCAL_PARTS_V, dir: LOG_DIR, kind: String(kind || ''), at: Date.now(), count: list.length, order: days, parts: parts },
        };
    } catch (e) { return { ok: false, manifest: null, files: {}, reason: String((e && e.message) || e) }; }
}

/**
 * 逐片文件 → 日志条目（按 `at` 升序；坏片只报坏片）。
 * @returns {{ok:boolean, entries:Array, bad:string[]}}
 */
export function joinLogParts(manifest, files) {
    const bad = [];
    const entries = [];
    try {
        const order = (manifest && Array.isArray(manifest.order)) ? manifest.order : Object.keys(files || {});
        for (const name of order) {
            const raw = files ? files[name] : undefined;
            if (typeof raw !== 'string') { bad.push(name); continue; }
            const want = (manifest && manifest.parts && manifest.parts[name]) || null;
            if (want && String(want.hash) !== hashText(raw)) { bad.push(name); continue; }
            try {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) for (const x of arr) entries.push(x);
                else bad.push(name);
            } catch (e) { bad.push(name); }
        }
        entries.sort((a, b) => Number((a && a.at) || 0) - Number((b && b.at) || 0));
        return { ok: bad.length === 0, entries: entries, bad: bad };
    } catch (e) { return { ok: false, entries: entries, bad: bad }; }
}

export default {
    LOCAL_PARTS_V, SNAP_DIR, LOG_DIR, SNAP_MANIFEST, LOG_MANIFEST,
    safePartName, snapPartFileName, logPartFileName, dayKeyOf,
    snapshotParts, joinSnapshotParts, logParts, joinLogParts,
};
