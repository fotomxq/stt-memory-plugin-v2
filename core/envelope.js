// ============================================================
// core/envelope.js —— **逐字移植自 V1**（src/modules/05-记忆状态与存储抽象.js 的存储信封）
// 覆盖：标准化存储信封 `storageEnvelope`（{ v, scope, payload:{scope, updatedAt, data}, hash, ts }）与
//   双轮 FNV-1a 内容哈希 `storageHash`（载入时校验，损坏即降级到下一优先级后端）。
// ============================================================

import { scopeId } from './state.js';
const STORAGE_ENV_VERSION = 1;

function storageHash(obj) {
    try {
        const s = JSON.stringify(obj);
        let h1 = 0x811c9dc5, h2 = 0x01000193;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ (c ^ 0x5f), 0x85ebca6b) >>> 0;
        }
        return h1.toString(36) + '_' + h2.toString(36);
    } catch (e) { return ''; }
}
// ==================== 服务端/CP 协同 + 删除墓碑 基础工具 ====================
// ① 与 Cocktail Plus 一致的稳定序列化（递归排序键；null/undefined→'null'）——用于 settings 哈希对齐

function storageEnvelope(data) {
    const payload = { scope: scopeId(), updatedAt: Date.now(), data };
    return { v: STORAGE_ENV_VERSION, scope: scopeId(), payload, hash: storageHash(payload), ts: Date.now() };
}

export { storageEnvelope, storageHash, STORAGE_ENV_VERSION };
