// ============================================================
// ui/entry-flat.js —— **编辑器回填**：把入库条目展开为「扁平表单字段」（v3.51.5 从 `ui/panel.js` 外提）
//
// 为什么外提：`ui/panel.js` 有体量棘轮（`docs/05` §5 C11），而「新增一个维度就要补一处回填」是**必然增长**的接线；
//   外提后新维度只改本模块，面板不再增行。
//
// 用户报告（v3.51.5）：「核对修复长期收支编辑的错误点，尤其是信息没回填。」
//   根因：`deals` 的三段 `outlook` 是**嵌套结构**，而编辑器字段表用的是扁平键（`outlookText` / `nodesText` / `forecast*`）；
//   旧 `flatFor` 只做顶层拷贝 → `deals` 编辑时这些键全是 `undefined` → **表单空着**（保存还会把原值冲掉）。
// ============================================================
import { flattenSnapshot } from './fields.js';

/**
 * 入库条目 → 扁平表单值。
 * @param {string} kind 维度键
 * @param {object} item 条目
 * @returns {object} 扁平键值（键名与 `kindFields(kind)` 一致）
 */
export function flatFor(kind, item) {
    const it = item || {};
    if (kind === 'snapshots') return flattenSnapshot(it);
    const out = Object.assign({}, it);
    ['tags', 'keywords', 'entities', 'locations', 'characters', 'traits', 'quirks', 'values', 'todos', 'commitments'].forEach((k) => {
        if (Array.isArray(out[k])) out[k] = out[k].join('，');
    });
    if (kind === 'rumors') {
        out.carriersText = (Array.isArray(it.carriers) ? it.carriers : []).map((c) => String(c && c.who || '') + (c && c.role && c.role !== '传播者' ? ':' + c.role : '')).filter(Boolean).join('\n');
        out.mediaText = (Array.isArray(it.media) ? it.media : []).map((m) => [m && m.type, m && m.name, m && m.date, m && m.durability].filter((x) => x !== undefined && x !== null && x !== '').join('|')).join('\n');
    }
    if (kind === 'plotSegments') {
        out.linesText = (Array.isArray(it.lines) ? it.lines : []).map((l) => String(l && l.label || '') + ': ' + String(l && l.text || '')).join('\n');
    }
    if (kind === 'parallels' && Array.isArray(it.goalOdds)) out.goalOdds = JSON.stringify(it.goalOdds);
    /**
     * v3.51.5（W32 `应-47` 续 · 用户报告「长期收支编辑信息没回填」）：**三段 `outlook` → 扁平字段**。
     *   · 已发生节点按「日期|金额|说明」逐行展开（与 `ui/fields.js#deconstructEntry` 的解析互逆）；
     *   · 预测单独成组（`forecastNextDate` / `forecastDelta` / `forecastDirection` / `forecastNote` / `forecastSource`）；
     *   · 金额 0 也照常回填（不因 `0` 被当成"空"而丢）。
     */
    if (kind === 'deals') {
        const ol = (it.outlook && typeof it.outlook === 'object') ? it.outlook : {};
        const fc = (ol.forecast && typeof ol.forecast === 'object') ? ol.forecast : {};
        out.outlookText = String(ol.text == null ? '' : ol.text);
        out.nodesText = (Array.isArray(ol.nodes) ? ol.nodes : []).map((n) => {
            const x = (n && typeof n === 'object') ? n : {};
            const delta = Number(x.delta) || 0;
            return [String(x.date == null ? '' : x.date), String(delta), String(x.note == null ? '' : x.note)].join('|');
        }).join('\n');
        out.forecastNextDate = String(fc.nextDate == null ? '' : fc.nextDate);
        out.forecastDelta = Number(fc.delta) || 0;
        out.forecastDirection = String(fc.direction || 'increase');
        out.forecastNote = String(fc.note == null ? '' : fc.note);
        out.forecastSource = String(fc.source || 'ai');
    }
    return out;
}
