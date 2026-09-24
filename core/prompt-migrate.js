// ============================================================
// core/prompt-migrate.js —— 提示词模板签名与迁移（**逐字移植自 V1** v1.132 / v1.179 链）
// 纯逻辑、零宿主依赖：只做「哪些模板该刷新、哪些该保留」的判定，落盘由 adapters 层负责。
//   · `promptSig(s)`：V1 逐字（FNV-1a 32 位 → 十六进制 + '-' + 长度），用于识别「仍是某个历史默认」；
//   · `migratePromptTemplates(pt)`：仅替换「缺失/空」或「签名命中 legacy 默认」或「等于新默认」的模板；
//   · `migrateArmorPreset(target)`：旧键 `armorPreset`（非 v1.178 默认且非空）迁入模板后删除旧键（幂等）。
// ============================================================
import { PROMPT_TEMPLATES_V2, PROMPT_LEGACY_SIGS, PROMPT_DEFAULT_VERSION, ARMOR_PRESET_V1178_DEFAULT } from './config.js';

/** 提示词签名（V1 `promptSig` 逐字） */
export function promptSig(s) {
    try {
        const t = String(s == null ? '' : s);
        let h = 0x811c9dc5;
        for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
        return h.toString(16) + '-' + t.length;
    } catch (e) { return '0-0'; }
}

let migrateInfo = null;
/** 最近一次迁移信息（设置页提示/诊断） */
export function promptMigrateStats() { return migrateInfo ? Object.assign({}, migrateInfo, { refreshed: migrateInfo.refreshed.slice(), kept: migrateInfo.kept.slice() }) : null; }

/** 提示词升级（V1 `applyPromptV132` 口径）；返回**新对象**，不修改入参 */
export function migratePromptTemplates(pt) {
    const out = Object.assign({}, pt || {});
    const refreshed = [], kept = [];
    for (const k of Object.keys(PROMPT_TEMPLATES_V2)) {
        const cur = out[k];
        const legacySigs = PROMPT_LEGACY_SIGS[k];
        const curSig = promptSig(cur);
        const isLegacyDefault = (cur === undefined || cur === null || cur === '')
            || (Array.isArray(legacySigs) ? legacySigs.indexOf(curSig) >= 0 : legacySigs === curSig);
        if (isLegacyDefault || cur === PROMPT_TEMPLATES_V2[k]) {
            if (out[k] !== PROMPT_TEMPLATES_V2[k]) refreshed.push(k);
            out[k] = PROMPT_TEMPLATES_V2[k];
        } else { kept.push(k); }
    }
    migrateInfo = { version: PROMPT_DEFAULT_VERSION, refreshed, kept, at: Date.now() };
    return out;
}

/** v1.179 破甲预设迁移（幂等）：返回 {migrated, reason, deleted} */
export function migrateArmorPreset(target) {
    const t = target && typeof target === 'object' ? target : {};
    try {
        const pt = t.promptTemplates = Object.assign({}, t.promptTemplates || {});
        const old = t.armorPreset;
        const hasOld = (old !== undefined && old !== null && String(old).trim() !== '');
        const isV1178Default = String(old || '') === String(ARMOR_PRESET_V1178_DEFAULT);
        let migrated = false, reason = 'nothing-to-do';
        if (hasOld && !isV1178Default) { pt.armorPreset = String(old); migrated = true; reason = 'user-text-migrated'; }
        else if (hasOld) { reason = 'v1178-default-ignored'; }
        if (hasOld) delete t.armorPreset;
        return { migrated, reason, deleted: !!hasOld };
    } catch (e) { return { migrated: false, reason: 'error', deleted: false }; }
}
