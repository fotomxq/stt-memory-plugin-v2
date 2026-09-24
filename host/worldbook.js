// ============================================================
// host/worldbook.js —— **世界书通道（宿主层）**
//   （B8-7，1:1 移植 V1 `src/modules/05-记忆状态与存储抽象.js` 的 `storageProviders.worldbook`：
//     `label` / `isFttEntry` / `legacyEntryName` / `test` / `read` / `buildWorldbookEntries` / `write` / `remove`）
//
// 分层职责：本文件只负责**宿主 API 交互**（谁提供 API、怎么调、失败怎么降级），词条构建与识别在
//   `core/worldbook.js`（纯函数），8s 防抖调度与保存流水线接线在 `adapters/worldbook.js`。
//
// 适配（与 V1 的差异，逐条见 docs/P8y-B8-7世界书单向镜像.md）：
//   ① ESM 化 + 宿主函数解析改走 `host/st-api.js#worldbookApi()`（V1 内联 `thApi(name) || getFn(name)`）；
//      解析口径**逐项对齐**：`test`/`read` 用「thApi → getFn」链，`write`/`remove` 只用 thApi（V1 原样）；
//   ② `this.isFttEntry` / `this.buildWorldbookEntries` → 直接调 `core/worldbook.js` 同名导出（无 `this` 依赖）；
//   ③ 日志/告警走内核注入钩子（`warn` / `dbgLog`），V1 用全局 `warn` / `dbgLog`；
//   ④ `refreshWorldbookNames()` 保留（返回世界书名数组并更新缓存）；V1 的 `worldbookNamesHtml()` /
//      `fillWorldbookSelect()` 属 UI 层，**不在本批**（面板动作 `worldbookRefresh` 待接线）。
// 一致性由 tests/unit/worldbook-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { cfg, dbgLog, warn } from '../core/model/runtime.js';
import { STORAGE_ENV_VERSION } from '../core/envelope.js';
import {
    WORLDBOOK_META, buildWorldbookEntries, worldbookIsFttEntry, worldbookIsOurs,
    worldbookLegacyEntryName, worldbookTotalBytes, worldbookFormatBytes,
} from '../core/worldbook.js';
import { worldbookApi } from './st-api.js';

/** 世界书下拉缓存（V1 `worldbookNamesCache`；`refreshWorldbookNames()` 填充） */
let worldbookNamesCache = [];

/**
 * 刷新世界书列表缓存（V1 `refreshWorldbookNames`，逐字）：取不到 API → 空数组（不抛错）。
 * @returns {Promise<string[]>} 世界书名数组
 */
async function refreshWorldbookNames() {
    try {
        const api = worldbookApi();
        const names = api.names ? await api.names() : [];
        worldbookNamesCache = Array.isArray(names) ? names.map(String) : [];
    } catch (e) { worldbookNamesCache = []; }
    return worldbookNamesCache;
}

/** 当前世界书列表缓存（副本）—— 供设定页/面板接线时读取 */
function worldbookNames() {
    return worldbookNamesCache.slice();
}

/**
 * 世界书存储 provider（V1 `storageProviders.worldbook`）。
 * 单向写入型：`read()` 仅兼容 v1.27 旧快照词条（一次性迁移识别），不提供整库还原。
 */
const worldbookProvider = {
    label: WORLDBOOK_META.label,

    /** 词条识别（V1 同名方法） */
    isFttEntry(e) { return worldbookIsFttEntry(e); },
    /** 旧快照词条名（V1 同名方法）：`FTT记忆快照·<角色名>` */
    legacyEntryName() { return worldbookLegacyEntryName(); },
    /** 清理判据（V1 `write`/`remove` 内联 `isOurs`）：三态合一 */
    isOurs(e) { return worldbookIsOurs(e); },
    /** 词条构建（V1 同名方法，委托内核纯函数） */
    buildWorldbookEntries(env) { return buildWorldbookEntries(env); },

    /** 能力探测（V1 `test`）：能取到 `getWorldbookNames` 且返回数组即可用 */
    async test() {
        try {
            const api = worldbookApi();
            const g = api.names;
            if (!g) return false;
            const names = await g();
            return Array.isArray(names);
        } catch (e) { return false; }
    },

    /** 读取（V1 `read`）：仅识别 v1.27 旧快照词条（content = 完整信封 JSON）→ 返回信封，否则 null */
    async read() {
        try {
            const wb = cfg.storage && cfg.storage.worldbookName; if (!wb) return null;
            const api = worldbookApi();
            const g = api.get;
            if (!g) return null;
            const entries = await g(String(wb));
            const list = Array.isArray(entries) ? entries : (entries && Array.isArray(entries.entries) ? entries.entries : []);
            // 兼容旧版单条快照词条（name='FTT记忆快照·角色'，content=完整信封 JSON）
            const legacyName = worldbookLegacyEntryName();
            const legacy = list.find(e => e && (e.name === legacyName || (e.comment !== undefined && e.comment === legacyName)));
            if (legacy && typeof legacy.content === 'string') {
                try {
                    const j = JSON.parse(legacy.content);
                    if (j && j.v === STORAGE_ENV_VERSION) return j;
                } catch (e) { /* 忽略 */ }
            }
            return null;   // 原子词条为「同步镜像」形式，不提供完整信封还原
        } catch (e) { return null; }
    },

    /**
     * 写入（V1 `write`）：全量重建 —— 先移除全部本插件词条（三态兼容），再写入新词条。
     * 体积上限 `cfg.storage.worldbookMaxBytes`（默认 262144）**超限即跳过并告警**（不做截断）。
     */
    async write(env) {
        try {
            const wb = cfg.storage && cfg.storage.worldbookName; if (!wb) { warn('存储[世界书]未选择世界书'); return false; }
            const st = cfg.storage || {};
            const api = worldbookApi();
            const g = api.get, del = api.del, create = api.create, upd = api.update;
            if (!g || (!create && !upd)) { warn('存储[世界书]当前酒馆助手版本不支持词条写入接口'); return false; }
            // 类目常驻词条 + 原子词条（Markdown 分层，标题去前缀，keys 纯标签）
            const entries = buildWorldbookEntries(env);
            const totalBytes = worldbookTotalBytes(entries);
            if (totalBytes > (Number(st.worldbookMaxBytes) || 262144)) {
                warn(`存储[世界书]词条总量 ${worldbookFormatBytes(totalBytes)} 超过上限，已跳过（请改用浏览器/文件夹存储）`);
                return false;
            }
            const isOurs = (e) => worldbookIsOurs(e);
            // 全量重建：先移除全部本插件词条（兼容 快照词条 / v1.37-38 FTT· 前缀词条 / v1.39 无前缀 extra 标记词条），再写入新词条
            const removeOurs = (prev) => {
                const list = Array.isArray(prev) ? prev : (prev && Array.isArray(prev.entries) ? prev.entries : []);
                return list.filter(e => !isOurs(e));
            };
            if (upd) {
                // TH 官方：updater 返回新数组 —— 一次调用完成「清理旧 + 写入新」，避免删除接口签名不一致导致词条冗余
                await upd(String(wb), (prev) => removeOurs(prev).concat(entries));
            } else if (del && create) {
                await del(String(wb), (e) => isOurs(e));   // 第二参为 predicate（TH 官方签名）
                if (entries.length) await create(String(wb), entries);
            } else if (create) {
                if (entries.length) await create(String(wb), entries);
            } else {
                return false;
            }
            dbgLog('对账', { action: '世界书同步', wb, entries: entries.length, bytes: totalBytes });
            return true;
        } catch (e) { warn('存储[世界书]写入失败', e); return false; }
    },

    /** 清除本插件词条（V1 `remove`）：优先 `updateWorldbookWith`，否则 `deleteWorldbookEntries(pred)` */
    async remove() {
        try {
            const wb = cfg.storage && cfg.storage.worldbookName; if (!wb) return false;
            const api = worldbookApi();
            const upd = api.update, del = api.del;
            const isOurs = (e) => worldbookIsOurs(e);
            if (upd) {
                await upd(String(wb), (prev) => {
                    const list = Array.isArray(prev) ? prev : (prev && Array.isArray(prev.entries) ? prev.entries : []);
                    return list.filter(e => !isOurs(e));
                });
                return true;
            }
            if (del) { await del(String(wb), (e) => isOurs(e)); return true; }
            return false;
        } catch (e) { return false; }
    },
};

export { WORLDBOOK_META, worldbookProvider, refreshWorldbookNames, worldbookNames };
