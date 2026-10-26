// ============================================================
// ui/subtabs.js —— **页内子标签统一组件（分段胶囊）**（v3.52.0 W33 `应-49`，`docs/D55` §3.4）
//
// 口径：5 处页内子标签（情节双子页 / 货币三子页 / 场景双子页 / 设定 15 子页 / 约束四维）
//   统一为同一种「分段胶囊」外观 + 横向滚动边缘渐隐。**DOM 契约不变**：
//   · 仍输出 `<a class="ftt-subtab …">`（`panel-audit` / 既有测试按此类名与 `data-ftt-*` 属性断言）；
//   · 各页的属性名由调用方给（`data-ftt-asub` / `data-ftt-csub` / `data-ftt-subtab` …）。
// 另：设定页 15 子页提供**四分组**（内容与投喂 / 记忆与整理 / AI 与安全 / 数据与排障）聚类导航。
// ============================================================

/** HTML 转义（组件内自足，避免跨模块依赖） */
function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function attr(v) { return esc(v).replace(/"/g, '&quot;'); }

/**
 * 一段子标签（分段胶囊）。
 * @param {Array<{id:string,label:string,active?:boolean,title?:string}>} items
 * @param {{attrName:string, extraClass?:string, groupLabel?:string}} opts
 */
export function subTabsHtml(items, opts) {
    const o = opts || {};
    const name = String(o.attrName || 'data-ftt-subtab');
    const list = Array.isArray(items) ? items : [];
    const group = o.groupLabel ? ('<span class="ftt-subtab-group">' + esc(o.groupLabel) + '</span>') : '';
    return '<div class="ftt-subtabs-row' + (group ? ' ftt-subtabs-grouped' : '') + (o.extraClass ? (' ' + attr(o.extraClass)) : '') + '">'
        + group + list.map((it) => {
            const id = String((it && it.id) || '');
            const on = it && it.active === true;
            return '<a href="javascript:void(0)" class="ftt-subtab' + (on ? ' ftt-on' : '') + '" ' + name + '="' + attr(id) + '"'
                + (it && it.title ? (' title="' + attr(it.title) + '"') : '') + (on ? ' aria-current="page"' : '') + '>' + esc((it && it.label) || id) + '</a>';
        }).join('') + '</div>';
}

/** 设定页 15 子页的四分组（`应-49`；顺序与 `SETTINGS_TABS` 一致，仅加分组标题） */
export const SETTINGS_GROUPS = Object.freeze([
    { label: '内容与投喂', ids: ['base', 'feed', 'api', 'extract', 'analyze'] },
    { label: '记忆与整理', ids: ['forget', 'rumors', 'parallels', 'constraint'] },
    { label: 'AI 与风险', ids: ['safety', 'prompts'] },
    { label: '数据与排障', ids: ['storage', 'debug', 'data', 'about'] },
]);

/**
 * 按分组渲染设定子标签（保持每页属性 `data-ftt-subtab="<id>"` 与 `ftt-subtab ftt-on` 形态）。
 * @param {Array<{id:string,label:string}>} tabs `SETTINGS_TABS`
 * @param {string} current 当前子页 id
 */
export function groupedSubTabsHtml(tabs, current) {
    const cur = String(current || '');
    const list = Array.isArray(tabs) ? tabs : [];
    const byId = new Map(list.map((t) => [String(t.id), t]));
    const used = new Set();
    const groups = SETTINGS_GROUPS.map((g) => {
        const items = g.ids.filter((id) => byId.has(id)).map((id) => {
            used.add(id);
            const t = byId.get(id);
            return { id: id, label: t.label, active: id === cur };
        });
        return items.length ? subTabsHtml(items, { attrName: 'data-ftt-subtab', groupLabel: g.label }) : '';
    }).join('');
    // 未登记进分组的新子页 → 追加到「其它」（保证永不丢页）
    const rest = list.filter((t) => !used.has(String(t.id)));
    const tail = rest.length ? subTabsHtml(rest.map((t) => ({ id: t.id, label: t.label, active: String(t.id) === cur })), { attrName: 'data-ftt-subtab', groupLabel: '其它' }) : '';
    return '<div class="ftt-subtabs ftt-subtabs-settings">' + groups + tail + '</div>';
}
