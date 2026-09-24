// ============================================================
// core/sync-log.js —— **同步日志内核**（B7-2，逐字移植自 V1 `src/modules/06-存储后端与三型归类.js`）
// 背景（V1 需求）：浏览器崩溃 / 双端不同步排查需要「最近 30 条同步记录」—— 每次跨端对账/镜像推送记一条：
//   本地条数与大小 → 对端条数与大小 → 同步后条数与大小 + 触发源/处置方式/耗时。
// 覆盖：`syncLogRecordKey`（记录指纹）/ `syncLogMerge`（服务端交叉并集合并）/ `syncLogPushRecord`（环形入队）/
//   `syncLogStat`（条数+字节统计）/ `syncLogShortHash` / `syncLogSource`（本端设备·浏览器标识）。
// 适配：纯内核化 —— 原 V1 直接读写 `window.localStorage` 与 `navigator`，此处改为**纯函数 + 注入 nav**；
//   持久化与文件通道在 `adapters/sync.js`（与本模块同一口径，由测试与真实 V1 黄金样本强制校验）。
// ============================================================
import { hashText } from './util.js';
import { atomEntryCount } from './cross-sync.js';

/** 环形上限：最近 30 条（V1 `storePolicy('log').keep`） */
export const SYNC_LOG_MAX = 30;

/** 记录指纹（V1 `syncLogRecordKey`）—— 服务端合并去重用 */
function syncLogRecordKey(r) {
    try {
        if (!r || typeof r !== 'object') return '';
        return [r.ts, r.src, r.action, r.mode, r.note, r.localN, r.remoteN, r.afterN, r.localHash, r.remoteHash, r.afterHash].join('|');
    } catch (e) { return ''; }
}

/** 交叉合并：union 去重（先 a 后 b）→ ts 新→旧 → 上限 max（V1 `syncLogMerge`） */
function syncLogMerge(a, b, max) {
    const cap = Number(max) > 0 ? Number(max) : SYNC_LOG_MAX;
    const out = [];
    const seen = Object.create(null);
    const pushAll = (arr) => {
        (Array.isArray(arr) ? arr : []).forEach((r) => {
            if (!r || typeof r !== 'object') return;
            const k = syncLogRecordKey(r) || ('#' + out.length + ':' + Math.random());
            if (seen[k]) return;
            seen[k] = 1; out.push(r);
        });
    };
    pushAll(a); pushAll(b);
    out.sort((x, y) => (Number(y && y.ts) || 0) - (Number(x && x.ts) || 0));
    if (out.length > cap) out.length = cap;
    return out;
}

/**
 * 入队一条记录（V1 `crossSyncLogPush` 的纯函数版）：头部插入 + 自动补 ts/src + 环形挤出。
 * @param {Array} list 现有列表（新→旧）
 * @param {object} rec 记录字段（action/mode/…）
 * @param {object} [opts] src（本端源头）/ max
 * @returns {Array} 新列表
 */
function syncLogPushRecord(list, rec, opts) {
    try {
        const o = opts || {};
        const cap = Number(o.max) > 0 ? Number(o.max) : SYNC_LOG_MAX;
        const row = Object.assign({ ts: Date.now(), src: String(o.src || '') }, rec || {});
        const next = [row].concat(Array.isArray(list) ? list : []);
        return next.length > cap ? next.slice(0, cap) : next;
    } catch (e) { return Array.isArray(list) ? list : []; }
}

/** 数据统计：条目数（各大类原子合计）+ 数据 JSON 字节（不含信封壳）—— V1 `syncLogStat` */
function syncLogStat(d) {
    let n = 0; try { n = atomEntryCount(d); } catch (e) { /* 忽略 */ }
    let bytes = 0; try { bytes = JSON.stringify(d || {}).length; } catch (e) { /* 忽略 */ }
    return { n, bytes };
}

/** 短哈希展示（前 12 位，足够区分同/异；完整值亦存于记录字段） */
function syncLogShortHash(h) { try { return String(h || '').slice(0, 12); } catch (e) { return ''; } }

/**
 * 本端源头描述 —— 以浏览器自身信息（UA/平台/语言）为依据：可读的设备·浏览器标签 + 短码
 * （UA+平台+语言 哈希前 8 位，用于区分「两台浏览器」是否为同一台设备/同一浏览器指纹）。供同步日志追溯本端。
 * @param {object} nav 形如 { userAgent, platform, language, userAgentData:{platform} }（V1 读全局 navigator）
 */
function syncLogSource(nav) {
    try {
        const n = nav || {};
        const ua = String(n.userAgent || '');
        const plat = String((n.userAgentData && n.userAgentData.platform) || n.platform || '');
        const lang = String(n.language || '');
        if (!ua) return '测试/非浏览器环境';
        const u = ua.toLowerCase();
        let dev = '未知设备';
        if (/(iphone|ipad|ipod)/.test(u)) dev = 'iOS';
        else if (/android/.test(u)) dev = 'Android';
        else if (/windows/.test(u)) dev = 'Windows';
        else if (/mac os|macintosh/.test(u)) dev = 'macOS';
        else if (/linux/.test(u)) dev = 'Linux';
        let brow = '?';
        if (/edg\//.test(u)) brow = 'Edge';
        else if (/chrome|chromium|crios/.test(u)) brow = 'Chrome';
        else if (/firefox|fxios/.test(u)) brow = 'Firefox';
        else if (/safari/.test(u)) brow = 'Safari';
        const code = String(hashText(ua + '|' + plat + '|' + lang)).slice(0, 8);
        return `${dev}·${brow}(${code})${plat ? '·' + plat : ''}`;
    } catch (e) { return '未知'; }
}

export { syncLogRecordKey, syncLogMerge, syncLogPushRecord, syncLogStat, syncLogShortHash, syncLogSource };
