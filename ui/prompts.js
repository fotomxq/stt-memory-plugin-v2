// ============================================================
// ui/prompts.js —— **提示词模板编辑**（对齐 V1 `13-UI-设置与存储开关.js` 的提示词页 + v1.132/v1.179 迁移链）
// 覆盖：
//   · `promptSig(s)`：V1 逐字（FNV-1a 32 位 → 十六进制 + '-' + 长度）—— 用于判定「当前文本是否仍是某个历史默认」；
//   · `migratePromptTemplates(pt)`：V1 `applyPromptV132` 口径 —— 仅替换「缺失/空」或「签名命中历史默认」或「等于新默认」
//     的模板，用户自定义过的一律保留；返回并记录迁移信息（刷新了哪些、保留了哪些）；
//   · `migrateArmorPreset(cfgLike)`：V1 v1.179 口径 —— 旧键 `cfg.armorPreset` 若不是 v1.178 官方默认则迁入模板，随后删除旧键（幂等）；
//   · 分组编辑 UI：按 `PROMPT_GROUPS`（5 组 / 33 条模板）渲染 textarea + 单条保存/恢复默认 + 组恢复默认 + 全部恢复默认 + 破甲预设导入。
// 写回：`cfg.promptTemplates[key] = 文本` → `saveKernelCfg()`（ST 配置持久化）。
// ============================================================
import { cfg } from '../core/model/runtime.js';
import { PROMPT_GROUPS, PROMPT_TEMPLATES_V2, PROMPT_LEGACY_SIGS, PROMPT_DEFAULT_VERSION, ARMOR_PRESET_V1178_DEFAULT, defaultCfg } from '../core/config.js';
import { saveKernelCfg } from '../adapters/config-store.js';
import { promptSig, promptMigrateStats } from '../core/prompt-migrate.js';
import { mdBold } from './hints.js';   // v2.60.0：统一富文本（`**x**` → 粗体）

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = esc;

// 签名与迁移的**纯逻辑**放在 core/prompt-migrate.js（零宿主依赖，便于配置载入层复用）
export { promptSig, migratePromptTemplates, migrateArmorPreset, promptMigrateStats } from '../core/prompt-migrate.js';

/** 模板当前是否被用户自定义（与内置默认不同） */
export function isPromptCustomized(key) {
    try { return String((cfg.promptTemplates || {})[key]) !== String(PROMPT_TEMPLATES_V2[key]); } catch (e) { return false; }
}
/** 当前模板文本（缺失 → 内置默认 → 配置默认） */
export function promptText(key) {
    try {
        const cur = (cfg.promptTemplates || {})[key];
        if (cur !== undefined && cur !== null && cur !== '') return String(cur);
        if (PROMPT_TEMPLATES_V2[key] !== undefined) return String(PROMPT_TEMPLATES_V2[key]);
        return String((defaultCfg.promptTemplates || {})[key] || '');
    } catch (e) { return ''; }
}
/** 模板键 → 所属组 */
export function promptGroupOf(key) {
    const hit = PROMPT_GROUPS.filter((g) => (g.keys || []).indexOf(String(key)) >= 0)[0];
    return hit ? hit.title : '（未分组）';
}
/** 统计：模板总数、分组数、自定义条数、未分组键 */
export function promptStats() {
    const keys = Object.keys(PROMPT_TEMPLATES_V2);
    const grouped = PROMPT_GROUPS.reduce((n, g) => n + (g.keys || []).length, 0);
    const customized = keys.filter((k) => isPromptCustomized(k));
    const ungrouped = keys.filter((k) => promptGroupOf(k) === '（未分组）');
    return { templates: keys.length, groups: PROMPT_GROUPS.length, grouped, customized: customized.length, customizedKeys: customized, ungrouped, migrate: promptMigrateStats() };
}

/** 写回单条模板（唯一入口）→ 持久化 ST 配置 */
export function applyPrompt(key, text) {
    const k = String(key || '');
    if (!k || PROMPT_TEMPLATES_V2[k] === undefined) return { ok: false, reason: 'unknown-key' };
    try {
        cfg.promptTemplates = Object.assign({}, cfg.promptTemplates || {});
        cfg.promptTemplates[k] = String(text == null ? '' : text);
        try { saveKernelCfg(); } catch (e) { /* 落盘失败不影响内存态 */ }
        return { ok: true, key: k, chars: cfg.promptTemplates[k].length, customized: isPromptCustomized(k) };
    } catch (e) { return { ok: false, reason: 'error' }; }
}
/** 恢复单条为内置默认 */
export function resetPrompt(key) {
    const k = String(key || '');
    if (!k || PROMPT_TEMPLATES_V2[k] === undefined) return { ok: false, reason: 'unknown-key' };
    return applyPrompt(k, PROMPT_TEMPLATES_V2[k]);
}
/** 恢复一组（按组 keys） */
export function resetPromptGroup(title) {
    const g = PROMPT_GROUPS.filter((x) => x.title === String(title))[0];
    if (!g) return { ok: false, reason: 'unknown-group' };
    let n = 0;
    for (const k of (g.keys || [])) { if (resetPrompt(k).ok) n++; }
    return { ok: true, reset: n, group: g.title };
}
/** 全部恢复默认（含清理未分组键？V1 只重置已知模板键） */
export function resetAllPrompts() {
    let n = 0;
    for (const k of Object.keys(PROMPT_TEMPLATES_V2)) { if (resetPrompt(k).ok) n++; }
    return { ok: true, reset: n };
}

/** 单条模板编辑块（V1 同款：`.ftt-editor`/textarea + 保存/恢复默认 + 签名与自定义标记） */
export function promptEditorHtml(key) {
    const k = String(key);
    const text = promptText(k);
    const customized = isPromptCustomized(k);
    return '<div class="ftt-editor ftt-prompt-editor" data-ftt-prompt-box="' + attr(k) + '">'
        + '<div class="ftt-editor-title">' + esc(k) + ' <span class="ftt-muted">' + esc(promptGroupOf(k)) + ' · ' + text.length + ' 字 · 签名 ' + esc(promptSig(text))
        + (customized ? ' · <b>已自定义</b>' : ' · 内置默认') + '</span></div>'
        + '<textarea data-ftt-prompt="' + attr(k) + '" rows="8">' + esc(text) + '</textarea>'
        + '<div class="ftt-row"><button class="ftt-btn ftt-primary ftt-sm" data-ftt-action="promptSave" data-ftt-prompt-key="' + attr(k) + '">💾 保存</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="promptResetOne" data-ftt-prompt-key="' + attr(k) + '"' + (customized ? '' : ' disabled') + '>↩ 恢复默认</button></div>'
        + '</div>';
}

/** 提示词页 HTML（5 组 / 33 条；组头 + 组恢复默认 + 模板编辑块 + 迁移提示 + 破甲预设导入） */
export function promptsPageHtml(opts) {
    const o = opts || {};
    const st = promptStats();
    const out = [];
    out.push('<div class="ftt-cat-stat ftt-chip">提示词模板 ' + st.templates + ' 条 / ' + st.groups + ' 组 · 已自定义 ' + st.customized + ' 条'
        + (st.ungrouped.length ? (' · ⚠️ 未分组 ' + st.ungrouped.length + ' 条：' + esc(st.ungrouped.join('、'))) : '') + '</div>');
    const mi = st.migrate;
    if (mi) {
        out.push('<div class="ftt-hint">上次载入迁移（' + esc(String(mi.version)) + '）：刷新 ' + (mi.refreshed || []).length + ' 条'
            + ((mi.refreshed || []).length ? ('（' + esc(mi.refreshed.slice(0, 8).join('、')) + (mi.refreshed.length > 8 ? ' 等' : '') + '）') : '')
            + ' · 保留自定义 ' + (mi.kept || []).length + ' 条</div>');
    }
    out.push('<div class="ftt-row"><button class="ftt-btn ftt-sm ftt-err" data-ftt-action="promptResetAll">↩ 全部恢复默认（' + st.templates + ' 条）</button>'
        + '<span class="ftt-hint">恢复默认只影响提示词模板，不动机忆数据；改动即时落盘（ST 配置）。</span></div>');
    for (const g of PROMPT_GROUPS) {
        const keys = (g.keys || []).filter((k) => PROMPT_TEMPLATES_V2[k] !== undefined);
        if (!keys.length) continue;
        const custom = keys.filter((k) => isPromptCustomized(k)).length;
        out.push('<h4 class="ftt-h4-inline">' + esc(g.title) + ' <span class="ftt-muted">' + keys.length + ' 条' + (custom ? (' · 自定义 ' + custom) : '') + '</span>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="promptGroupReset" data-ftt-prompt-group="' + attr(g.title) + '">↩ 本组恢复默认</button></h4>');
        if (g.desc) out.push('<div class="ftt-hint">' + mdBold(g.desc) + '</div>');
        if (g.switchKey) {
            const on = cfg[g.switchKey] !== false;
            out.push('<div class="ftt-field"><label>' + esc(g.switchLabel || g.switchKey) + '</label><label class="ftt-switch"><input type="checkbox" data-ftt-cfg="' + attr(g.switchKey) + '"' + (on ? ' checked' : '') + '><span class="ftt-slider"></span></label><span class="ftt-muted">' + (on ? '已开启' : '已关闭') + '</span></div>');
        }
        keys.forEach((k) => out.push(promptEditorHtml(k)));
    }
    // 破甲预设导入（同目录文件 / 粘贴文本）
    out.push('<h4 class="ftt-h4-inline">破甲预设导入 <span class="ftt-muted">（同目录 FTT-memory-preset.txt 或粘贴）</span></h4>');
    out.push('<div class="ftt-field ftt-field-col"><label>粘贴预设文本（采用后写入 armorPreset 模板）</label><textarea data-ftt-armor-import="1" rows="4" placeholder="在此粘贴…"></textarea></div>');
    out.push('<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="armorPresetImport">⬇ 采用为破甲预设</button>'
        + '<span class="ftt-hint">也可把预设文本存成同目录的 FTT-memory-preset.txt，由插件自动采用。</span></div>');
    return out.join('\n');
}

/**
 * 提示词页动作（唯一入口）。
 * @param {string} action promptSave | promptResetOne | promptResetAll | promptGroupReset | armorPresetImport
 */
export function promptAction(action, payload) {
    const p = payload || {};
    const a = String(action || '');
    try {
        if (a === 'promptSave') {
            const r = applyPrompt(String(p.key || ''), p.text == null ? '' : p.text);
            return Object.assign(r, { ok: !!r.ok, html: promptsPageHtml() });
        }
        if (a === 'promptResetOne') { const r = resetPrompt(String(p.key || '')); return Object.assign(r, { html: promptsPageHtml() }); }
        if (a === 'promptResetAll') { const r = resetAllPrompts(); return Object.assign(r, { html: promptsPageHtml() }); }
        if (a === 'promptGroupReset') { const r = resetPromptGroup(String(p.group || '')); return Object.assign(r, { html: promptsPageHtml() }); }
        if (a === 'armorPresetImport') {
            const text = String(p.text == null ? '' : p.text);
            if (!text.trim()) return { ok: false, reason: 'empty', html: promptsPageHtml() };
            const r = applyPrompt('armorPreset', text);
            return Object.assign(r, { ok: !!r.ok, imported: text.length, html: promptsPageHtml() });
        }
        return { ok: false, reason: 'unknown-action', html: promptsPageHtml() };
    } catch (e) { return { ok: false, reason: 'error', error: String((e && e.message) || e), html: promptsPageHtml() }; }
}
