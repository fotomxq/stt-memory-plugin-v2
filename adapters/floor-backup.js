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
import { slugify, uploadStateFile, deleteStateFile } from './user-file.js';
import { fileStampCompact } from '../core/util.js';

export const FLOOR_BACKUP_PREFIX = 'ftt2-floor-backup-';
export const FLOOR_BACKUP_SLOTS = 3;

/**
 * 备份文件名（槽位 0..2）。
 * v3.0.17（用户要求「导出 json 备份，文件名必须带日期和时间」）：名字里带**紧凑时间戳**
 *   （`ftt2-floor-backup-<角色>-s2-20260930-140522.json`）—— 备份文件被导出/转发后仍一眼看得出时间。
 *   「**3 份轮转**」口径不变：轮转由**槽位**决定（写新文件后删掉该槽位的上一份，见 `writeFloorBackup`），
 *   因此目录里始终只保留 3 份（每份都带时间戳），不会随删楼次数无限增长。
 * @param {string} scope 角色作用域
 * @param {number} slot 槽位 0..2
 * @param {Date|number} [at] 备份时刻（缺省当前）
 */
export function floorBackupName(scope, slot, at) {
    const s = Math.abs(Math.floor(Number(slot) || 0)) % FLOOR_BACKUP_SLOTS;
    return FLOOR_BACKUP_PREFIX + slugify(scope) + '-s' + (s + 1) + '-' + fileStampCompact(at) + '.json';
}

/**
 * 写入一份删楼前备份（写成功后**尽力删除该槽位的上一份**，维持「3 份轮转」）。
 * @param {string} scope 角色作用域（`char:<hash>`）
 * @param {number} slot 槽位（0..2）
 * @param {string} text 明文 JSON（本插件导出的信封，可直接被「⬆ 选择文件导入」还原）
 * @param {{at?:Date|number, prevName?:string}} [opts] `at` 备份时刻（测试/确定性用）；`prevName` 该槽位上一份文件名
 * @returns {Promise<{ok:boolean, slot:number, name:string, chars:number, replaced?:string, status?:number, error?:string}>}
 */
export async function writeFloorBackup(scope, slot, text, opts) {
    const o = opts || {};
    const name = floorBackupName(scope, slot, o.at);
    const body = String(text == null ? '' : text);
    if (!body) return { ok: false, slot: slot, name: name, chars: 0, error: '空备份内容' };
    const r = await uploadStateFile(name, body);
    if (!(r && r.ok)) {
        return { ok: false, slot: slot, name: name, chars: body.length, status: (r && r.status) || 0, error: String((r && r.error) || '') };
    }
    // 轮转：删掉该槽位的**上一份**（只删本插件自己的备份前缀；失败不改变备份结果本身）
    let replaced = '';
    try {
        const prev = String(o.prevName || '');
        if (prev && prev !== name && prev.indexOf(FLOOR_BACKUP_PREFIX) === 0) {
            await deleteStateFile(prev);
            replaced = prev;
        }
    } catch (e) { /* 忽略：删旧失败只影响目录整洁，不影响本次备份 */ }
    return { ok: true, slot: slot, name: name, chars: body.length, replaced: replaced, status: (r && r.status) || 0, error: '' };
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
