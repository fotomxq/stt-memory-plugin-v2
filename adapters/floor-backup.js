// ============================================================
// adapters/floor-backup.js —— **删楼前的明文备份（3 份轮转）**（v2.94.0，`docs/D12` v0.2 §4 前置② / Q5）
//
// 用户裁决（D12 Q5）：「删楼前**自动导出明文备份**，**3 份轮转**，路径写入结果与人工确认项。」
// 通道选择：走**酒馆用户目录文件**（`/api/files/upload`，与主记忆文件同一目录）——
//   ① 与「明文 JSON 可直接用「⬆ 选择文件导入」还原」的承诺一致（不像 localStorage 那样不可取走）；
//   ② 文件名前缀 `ftt2-floor-backup-` **不与主文件**（`ftt2-state-`）/同步日志冲突，
//      因此既不会被主文件通道读取，也不会被同步扫描误当数据；
//   ③ 轮转只占 3 个固定槽位（覆盖最旧的），不会随删楼次数无限增长。
//
// 失败姿态（与 D12 §6-5 一致）：**备份失败 → 不执行删除**（由调用方判定），绝不「悄悄删了但没备份」。
// ============================================================
import { slugify, uploadStateFile } from './user-file.js';

export const FLOOR_BACKUP_PREFIX = 'ftt2-floor-backup-';
export const FLOOR_BACKUP_SLOTS = 3;

/** 备份文件名（槽位 0..2；同一角色固定 3 个名字 → 天然轮转覆盖） */
export function floorBackupName(scope, slot) {
    const s = Math.abs(Math.floor(Number(slot) || 0)) % FLOOR_BACKUP_SLOTS;
    return FLOOR_BACKUP_PREFIX + slugify(scope) + '-' + (s + 1) + '.json';
}

/**
 * 写入一份删楼前备份。
 * @param {string} scope 角色作用域（`char:<hash>`）
 * @param {number} slot 槽位（0..2）
 * @param {string} text 明文 JSON（本插件导出的信封，可直接被「⬆ 选择文件导入」还原）
 * @returns {Promise<{ok:boolean, slot:number, name:string, chars:number, status?:number, error?:string}>}
 */
export async function writeFloorBackup(scope, slot, text) {
    const name = floorBackupName(scope, slot);
    const body = String(text == null ? '' : text);
    if (!body) return { ok: false, slot: slot, name: name, chars: 0, error: '空备份内容' };
    const r = await uploadStateFile(name, body);
    return {
        ok: !!(r && r.ok), slot: slot, name: name, chars: body.length,
        status: (r && r.status) || 0, error: String((r && r.error) || ''),
    };
}

/**
 * 下一次写入应使用的槽位（**先测备份可用性再取槽**；轮转顺序由调用方传入的上次槽位决定）。
 * @param {number} lastSlot 上次写入的槽位（-1 表示从未写入）
 */
export function nextFloorBackupSlot(lastSlot) {
    const n = Number(lastSlot);
    if (!Number.isFinite(n) || n < 0) return 0;
    return (Math.floor(n) + 1) % FLOOR_BACKUP_SLOTS;
}
