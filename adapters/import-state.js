// ============================================================
// adapters/import-state.js —— **JSON 存档导入**（v3.50.7，用户报告「导出后的数据无法导入」）
//
// 为什么单独成模块（`docs/05` §5 C11 + 体量棘轮）：导入的**解析容错 + 逐容器回报 + 落盘失败如实回报**
//   会明显撑大 `index.js`（在册受控文件）→ 逻辑落本模块，入口只留一行调用。
//
// 口径（逐条对应 `docs/D17` `U253`）：
//   ① **解析前去 BOM 与首尾空白**：Windows 记事本 / 部分宿主「另存为 UTF-8」会写 `\uFEFF`，
//      `JSON.parse` 直接抛错 → 用户看到「导入失败（JSON 解析失败）」，而文件其实是好的；
//   ② **信封形态校验**：本插件导出为 `{format, version, scope, at, state}`；带 `format` 却没有 `state` 时
//      **如实失败**（旧实现会把信封本身当状态去合并 → `added: 0` 却报 `ok: true`，用户看不出「其实没进去」）；
//   ③ **逐容器回报**：`dims`（各维度新增）/ `slots`（运行时槽并入）/ `tombstones`（墓碑并集），
//      让「导入成功但没生效」不再可能被误判为成功；
//   ④ **落盘失败不吞结果**：内存已合并 → 报 `saved:false` + `saveError`，用户可重试或手动导出。
//
// 依赖注入（`ctx`）而非直接 import 宿主：本模块只依赖 `core/` 与同层的 `adapters/import-v1.js`，
//   保持「core 不反向依赖 adapters」的分层（`scripts/check-core-purity.js` / `check-core-refs.js`）。
// ============================================================
import { DIMENSIONS } from '../core/constants.js';
import { mergeV1IntoCurrent } from './import-v1.js';

/**
 * 导入一份 JSON 存档文本（**按 id 合并、append-only**，绝不删除本地数据）。
 * @param {string} text 文件内容或粘贴的 JSON
 * @param {{getState:Function, attach:Function, save:Function}} ctx 宿主注入：取当前态 / 装回态 / 落盘
 * @returns {Promise<{ok:boolean, reason?:string, added?:number, saved?:boolean, saveError?:string, dims?:object, slots?:object, tombstones?:object, format?:string}>}
 */
export async function importStatePayload(text, ctx) {
    const c = ctx || {};
    try {
        // ① 去 BOM + 首尾空白
        const raw = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
        if (!raw) return { ok: false, reason: '内容为空' };
        let obj = null;
        try { obj = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'JSON 解析失败' }; }
        // ② 信封形态校验（带 format 却无 state → 如实失败）
        const isEnvelope = !!(obj && typeof obj === 'object' && obj.format);
        if (isEnvelope && (!obj.state || typeof obj.state !== 'object')) {
            return { ok: false, reason: '存档信封里没有 state（文件可能不完整；请重新导出后再试）', format: String(obj.format || '') };
        }
        const incoming = (obj && obj.state) ? obj.state : obj;
        if (!incoming || typeof incoming !== 'object') return { ok: false, reason: '不是有效的记忆数据' };
        const cur = (typeof c.getState === 'function') ? c.getState() : null;
        const before = DIMENSIONS.reduce((n, d) => n + ((cur && Array.isArray(cur[d.kind])) ? cur[d.kind].length : 0), 0);
        const { merged, summary } = mergeV1IntoCurrent(cur, incoming);
        if (typeof c.attach === 'function') c.attach(merged);
        // ④ 落盘失败不吞结果
        let saved = true, saveError = '';
        try {
            if (typeof c.save === 'function') await c.save();
        } catch (e) { saved = false; saveError = String((e && e.message) || e); }
        const after = DIMENSIONS.reduce((n, d) => n + ((merged && Array.isArray(merged[d.kind])) ? merged[d.kind].length : 0), 0);
        return {
            ok: true, added: Math.max(0, after - before), saved: saved, saveError: saveError,
            dims: (summary && summary.added) || {}, slots: (summary && summary.slots) || {},
            tombstones: (summary && summary.tombstones) || { deleted: 0, deletedH: 0 },
        };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
}

/**
 * 导入结果的**逐容器明细**提示文案（面板「📥 导入存档」用；纯字符串，不碰 DOM）。
 *   为什么不用一个「新增 N 条」：当维度全被跳过、只有台账 / 变量并入时，
 *   用户看到「新增 0 条」会以为「没导进去」（而其实台账 / 变量已并入）；落盘失败也必须看得见。
 * @param {object} r `importStatePayload` 的返回
 * @returns {string}
 */
export function importResultNote(r) {
    const x = r || {};
    const parts = [];
    const dims = Object.keys(x.dims || {});
    if (dims.length) parts.push('条目新增 ' + (x.added || 0) + ' 条（' + dims.map((k) => k + ' ' + x.dims[k]).join(' · ') + '）');
    // 旧钩子 / 测试桩可能只给 `added` 不给 `dims` → 如实报总数（不谎称「本机都已有」）
    else if (Number(x.added) > 0) parts.push('条目新增 ' + Number(x.added) + ' 条');
    else parts.push('条目新增 0 条（文件里的条目本机都已有）');
    const slots = Object.keys(x.slots || {});
    if (slots.length) parts.push('台账 / 变量等并入 ' + slots.length + ' 项（' + slots.join(' · ') + '）');
    const t = x.tombstones || {};
    if ((t.deleted || 0) + (t.deletedH || 0) > 0) parts.push('删除墓碑并入 ' + ((t.deleted || 0) + (t.deletedH || 0)) + ' 条');
    parts.push('相同的跳过 / 变更覆盖，未删除本地记忆');
    if (x.saved === false) parts.push('⚠ 落盘失败（' + String(x.saveError || '未知') + '）：内存已合并，请重试或立即导出备份');
    return parts.join('；');
}
