// ============================================================
// ui/recycle-bin.js —— **「🕳 最近删除 + ♻ 恢复」的界面层**（v3.46.7，`docs/D22` §4.4 W15 `应-8`）
//
// 来源（`docs/D19` §8 实施规格 `应-8` / §3.4 · `docs/D9` §6 状态说明）：
//   「在『设定 → 数据管理』的危险区**之前**增加『🕳 最近删除（N 条）』只读列表 + 『♻ 恢复选中』
//    （清除对应 id 墓碑）；范围限定为**本机当前作用域**；界面写明『恢复仅在本机清除墓碑记录；
//    对端仍以墓碑为准』。」
//
// 分工（`docs/05-开发指南.md` §5 **C11** + 体量棘轮）：
//   · `core/recycle-bin.js` = 数据事实源（清单 + 清墓碑，纯函数）；
//   · 本模块 = 勾选状态 + 渲染 + 落盘（`saveState`）；
//   · `ui/settings-pages.js` = 只把 `recycleBinSectionHtml()` 插进数据管理页（1 行接线）。
//
// **零写入边界**：勾选 / 全选 / 恢复，都只动 `state.deleted`（墓碑记录）——
//   不新增、不修改、不移动任何记忆条目；恢复本身也不把条目正文搬回来（它早被删除动作移除了）。
// ============================================================
import { saveState } from '../core/model/runtime.js';
import { recycleBinList, recycleBinRestore } from '../core/recycle-bin.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => Number(v) || 0;

/** 本模块接管的动作（`ui/panel.js` 只按这张表分发，不在面板里散落分支） */
export const RECYCLE_BIN_ACTIONS = Object.freeze(['rbToggle', 'rbAll', 'rbNone', 'rbRestore']);
/** 需要二次确认的动作（中央危险动作闸用；清墓碑是对端可见的破坏性操作） */
export const RECYCLE_BIN_DANGER = Object.freeze({ rbRestore: true });

/** 勾选集合：`dim\u0000id`（维度内 id 唯一，跨维度必须带维度） */
let picked = new Set();
/** 上次恢复结果（供界面回显；只读） */
let lastRestore = null;

/** 勾选键（`\u0000` 不可能出现在维度名或条目 id 里） */
function keyOf(dim, id) { return String(dim) + '\u0000' + String(id); }

/** 状态快照（面板 / 调试 / 测试用） */
export function recycleBinUiState() {
    return {
        picked: picked.size,
        last: lastRestore ? Object.assign({}, lastRestore) : null,
    };
}

/** 清空勾选（切页 / 数据重载后由 `refreshRecycleBinSelection()` 调用） */
export function resetRecycleBinSelection() { picked = new Set(); return picked.size; }

/**
 * **勾选集合与当前墓碑清单求交**（幂等）：把已不存在的勾选剔掉。
 * 渲染与动作都先调它，避免「删了又清、勾选悬空」导致恢复时报 skipped。
 */
export function refreshRecycleBinSelection() {
    const alive = new Set(recycleBinList({ max: 1e6 }).items.map((it) => keyOf(it.dim, it.id)));
    let dropped = 0;
    Array.from(picked).forEach((k) => { if (!alive.has(k)) { picked.delete(k); dropped++; } });
    return dropped;
}

/** 时间戳 → 人读相对时间（与既有调试面口径一致：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期） */
function agoText(ts) {
    const t = Number(ts) || 0;
    if (!t) return '时间未知';
    const d = Date.now() - t;
    if (d < 0) return '刚刚';
    const min = Math.floor(d / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小时前';
    const day = Math.floor(hr / 24);
    if (day < 30) return day + ' 天前';
    try {
        const dt = new Date(t);
        const p = (n) => (n < 10 ? '0' + n : String(n));
        return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
    } catch (e) { return '较早'; }
}

/** 单行：勾选框 + 维度 + id 摘要 + 删除时刻 */
function rowHtml(it) {
    const k = keyOf(it.dim, it.id);
    const on = picked.has(k);
    return '<div class="ftt-item ftt-inline">'
        + '<input type="checkbox" data-ftt-action="rbToggle" data-ftt-rb-dim="' + esc(it.dim) + '" data-ftt-rb-id="' + esc(it.id) + '"'
        + (on ? ' checked' : '') + ' title="选中这条墓碑记录">'
        + '<span class="ftt-grow"><b>' + esc(it.label) + '</b>'
        + ' <span class="ftt-muted">' + esc(shortId(it.id)) + '</span>'
        + ' <span class="ftt-muted">· 删除于 ' + esc(agoText(it.ts)) + '</span></span>'
        + '</div>';
}

/** id 摘要（长 id 只留头尾，避免撑破行；完整 id 在 title 里） */
function shortId(id) {
    const s = String(id || '');
    if (s.length <= 18) return s;
    return s.slice(0, 8) + '…' + s.slice(-6);
}

/**
 * 「🕳 最近删除」区块（**只读清单 + 恢复**）。
 *
 * 位置口径（`docs/D19` `应-8` 原文）：在数据管理页**危险区之前**。
 * 显隐口径：**没有任何墓碑时不渲染**（空区块对用户没有信息量，也不该占位）。
 *
 * @returns {string} HTML（无墓碑 → 空串）
 */
export function recycleBinSectionHtml() {
    let data;
    try { data = recycleBinList(); } catch (e) { return ''; }
    if (!num(data.dims)) return '';
    try { refreshRecycleBinSelection(); } catch (e) { /* 勾选求交失败不挡渲染 */ }
    const items = data.items;
    const rows = items.map(rowHtml).join('\n');
    const selN = picked.size;
    const trunc = num(data.truncated);
    const last = lastRestore;
    return '<div class="ftt-section"><div class="ftt-sec-title">🕳 最近删除 <span class="ftt-muted">已删除 ' + num(data.total) + ' 条 · 可恢复</span></div>'
        + '<div class="ftt-hint">删除条目会同时写入**两处**记录（按条目 id 与按内容哈希），用来<b>防止它从其它设备复活</b>。'
        + '「恢复」= <b>只在本机清除这些墓碑记录</b>；条目正文早在删除时移除了，这里不会把它搬回来 —— '
        + '此后它可以从备份导入或 AI 提取重新写入。<b>对端仍以墓碑为准</b>：换 id 写回的同内容可能在合并后再次消失。</div>'
        + '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="rbAll" title="勾选下面全部记录">全选</button>'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="rbNone" title="取消全部勾选">清空勾选</button>'
        + '<button class="ftt-btn ftt-sm' + (selN ? ' ftt-err' : '') + '" data-ftt-action="rbRestore"' + (selN ? '' : ' disabled') + ' title="清除选中条目的墓碑记录（需二次确认；不改任何条目）">♻ 恢复选中（' + selN + '）</button></div>'
        + (last ? ('<div class="ftt-hint">' + esc(last.text) + '</div>') : '')
        + '<div>' + rows + '</div>'
        + (trunc ? ('<div class="ftt-hint">仅列出最近 ' + items.length + ' 条（共 ' + num(data.total) + ' 条）；更早的墓碑记录仍在，只是不在本视图渲染。</div>') : '')
        + '</div>';
}

/**
 * 处理本模块的动作（由 `ui/panel.js` 统一分发）。
 * @param {string} a 动作名（见 `RECYCLE_BIN_ACTIONS`）
 * @param {object} p 动作参数（面板透传）
 * @returns {{ok:boolean, action?:string, reason?:string, restored?:number, hashes?:number, skipped?:number}}
 */
export function runRecycleBinAction(a, p) {
    const act = String(a || '');
    const par = p || {};
    try {
        if (act === 'rbToggle') {
            const dim = String(par.rbDim || '');
            const id = String(par.rbId || '');
            if (!dim || !id) return { ok: false, action: act, reason: 'bad-ref' };
            const k = keyOf(dim, id);
            if (par.on) picked.add(k); else picked.delete(k);
            return { ok: true, action: act, picked: picked.size };
        }
        if (act === 'rbAll') {
            recycleBinList({ max: 1e6 }).items.forEach((it) => picked.add(keyOf(it.dim, it.id)));
            return { ok: true, action: act, picked: picked.size };
        }
        if (act === 'rbNone') {
            picked = new Set();
            return { ok: true, action: act, picked: 0 };
        }
        if (act === 'rbRestore') {
            refreshRecycleBinSelection();
            const refs = Array.from(picked).map((k) => {
                const i = k.indexOf('\u0000');
                return { dim: k.slice(0, i), id: k.slice(i + 1) };
            });
            if (!refs.length) return { ok: false, action: act, reason: 'nothing-picked' };
            const r = recycleBinRestore(refs);
            picked = new Set();
            if (r.ok && r.restored > 0) {
                try { saveState(); } catch (e) { /* 落盘失败下一轮仍会保存；不改返回值口径 */ }
            }
            lastRestore = {
                at: Date.now(), restored: num(r.restored), hashes: num(r.hashes), skipped: num(r.skipped),
                text: '已恢复 ' + num(r.restored) + ' 条（清除墓碑 ' + num(r.restored) + ' 条'
                    + (num(r.hashes) ? ' · 同时清除内容墓碑 ' + num(r.hashes) + ' 条' : '')
                    + (num(r.skipped) ? ' · 跳过 ' + num(r.skipped) + ' 条（已不在清单里）' : '') + '）。',
            };
            return Object.assign({ ok: !!r.ok, action: act }, r, { reason: r.reason || '' });
        }
    } catch (e) {
        return { ok: false, action: act, reason: String((e && e.message) || e) };
    }
    return { ok: false, action: act, reason: 'unknown-action' };
}

/**
 * 供 `ui/panel.js` 调用的**单一入口**：跑动作 + 组装 `panelAction` 的返回值与提示行。
 * 把这两个「只有本功能知道形状」的字段留在本模块，面板侧就只留一行分发（`docs/05` §5 C11 的"必要接线"）。
 * @returns {{action:string, result:Object, note:string}}
 */
export function recycleBinAction(a, p) {
    const r = runRecycleBinAction(a, p);
    const note = (String(a) === 'rbRestore')
        ? (r.ok ? ('已恢复 ' + num(r.restored) + ' 条（已清除对应墓碑记录）') : ('恢复未执行：' + String(r.reason || '无可恢复项')))
        : '';
    return {
        action: String(a || ''),
        result: Object.assign({ ok: r.ok !== false, action: a, recycleBin: r, reason: r.reason || '', restored: num(r.restored) }, { note: note }),
        note: note,
    };
}
