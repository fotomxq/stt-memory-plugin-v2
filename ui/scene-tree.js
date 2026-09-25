// ============================================================
// ui/scene-tree.js —— 场景页**聚合树**（v2.47.0，逐字移植 V1 `scenesHtml()` 24361~24472）
//
// 用户报告：「情节等大类面板列表显示内容不全，请参照 V1 展示对应内容，注意展示顺序。」
// V1 的场景页不是平铺列表，而是：
//   ① 按**全部 `pathArr` 聚合出完整树**（父级没有独立记录时显示为灰色「虚节点」，仅展示、不可编辑）；
//   ② 同路径多记录**去重**（保留第一条，修复历史重复导致的错配）；
//   ③ **当前位置高亮**：`state.state.location` 按 `· > ／ /` 拆段，与场景路径做「连续子序列」匹配 →
//      命中分支整条亮色（含祖先），叶子标「📍 当前」；
//   ④ 子树可**折叠**（点 `▾`，纯 DOM 切换，不触发重绘 —— 与 V1 同）；节点带 `data-ftt-scene-node`（路径）；
//   ⑤ 行内容：`名称` + `描述`（`.ftt-sub`）+ `标签` + `路径 · 调用N次 · 重要度M%`（叶子才出统计）。
// 与 V1 的差异（仅 DOM 口径）：动作名用 V2 的 `data-ftt-action`（`addChildScene` / `edit` / `delete`），
//   多选复选框沿用 V2 的 `data-ftt-select`；其余标记与文案逐字一致。
// ============================================================
import { state } from '../core/model/runtime.js';
import { escHtml } from '../core/util.js';
import { entryMatches } from './console.js';
import { importancePct } from '../core/recall.js';

const esc = (v) => escHtml(String(v == null ? '' : v));
const trim = (v) => String(v == null ? '' : v).trim();

/** 场景路径键（V1 `scenePathKey`）：有 pathArr 用 `a>b>c`，否则 pathStr/name */
export function scenePathKey(s) {
    const arr = (s && Array.isArray(s.pathArr) && s.pathArr.length) ? s.pathArr.map(trim) : null;
    if (arr) return arr.join('>');
    return trim((s && s.pathStr) || (s && s.name) || '');
}
/** 场景路径数组（V1：`pathArr` 优先，否则用 `name` 单段） */
function scenePathArr(s) {
    const arr = (s && Array.isArray(s.pathArr) && s.pathArr.length) ? s.pathArr.map(trim).filter(Boolean) : null;
    if (arr && arr.length) return arr;
    const n = trim((s && s.name) || '');
    return n ? [n] : [];
}

/** 顶部统计胶囊（V1 `catStat('scenes')` 逐字：`共 N 个场景节点`） */
function statChip(total) { return '<div class="ftt-cat-stat ftt-chip">共 ' + total + ' 个场景节点</div>'; }

/**
 * 场景页正文（V1 `scenesHtml()` 的等价物）。
 * @param {object} opts `{ q, multi, sel }`（搜索词 / 是否多选 / 已选 id 集合）
 * @returns {string}
 */
export function scenesTreeHtml(opts) {
    const o = opts || {};
    const q = String(o.q || '');
    const multi = o.multi === true;
    const sel = o.sel || new Set();
    const all0 = (() => {
        const seen = new Set();
        return (state.scenes || []).slice().filter((s) => {
            const k = scenePathKey(s);
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    })();
    // 搜索：命中节点连同其**祖先路径**一并保留以维持树结构（V1 同口径）
    let all = all0;
    if (q) {
        const hitKeys = new Set();
        for (const s of all0) { try { if (entryMatches(s, q)) hitKeys.add(scenePathKey(s)); } catch (e) { /* 忽略 */ } }
        const keep = new Set();
        for (const s of all0) {
            const k = scenePathKey(s);
            for (const hk of hitKeys) { if (hk === k || hk.indexOf(k + '>') === 0) { keep.add(k); break; } }
        }
        all = all0.filter((s) => keep.has(scenePathKey(s)));
    }
    const search = '<div class="ftt-row"><input class="ftt-input" type="text" data-ftt-search="scenes" value="' + esc(q) + '" placeholder="搜索：场景名 / 描述 / 标签 / 路径…">'
        + '<button class="ftt-btn ftt-sm" data-ftt-action="searchClear" data-ftt-search-kind="scenes" title="清除搜索与筛选">✕ 清除</button>'
        + '<span class="ftt-muted">' + (q ? ('匹配 ' + all.length + ' / ') : '共 ') + all0.length + ' 个场景节点</span></div>';
    const addBtn = '<button class="ftt-btn ftt-sm ftt-primary" data-ftt-action="addEntry" data-kind="scenes">➕ 添加顶层场景</button>';
    const multiBtn = '<button class="ftt-btn ftt-sm" data-ftt-action="multiToggle" data-kind="scenes" title="切换单选 / 多选">' + (multi ? '☑ 多选模式' : '☐ 单选模式') + '</button>';
    const bulk = multi
        ? ('<button class="ftt-btn ftt-sm" data-ftt-action="selectAll" data-kind="scenes">全选</button>'
            + '<button class="ftt-btn ftt-sm" data-ftt-action="selectNone" data-kind="scenes">清空选择</button>'
            + '<button class="ftt-btn ftt-sm ftt-err" data-ftt-action="bulkDelete" data-kind="scenes"' + (sel.size ? '' : ' disabled') + '>🗑 删除选中（' + sel.size + '）</button>')
        : '';
    const sceneBar = '<div class="ftt-addbar ftt-toolbar">' + addBtn + multiBtn + bulk
        + '<button class="ftt-btn ftt-sm" data-ftt-action="sceneRepair" title="复用「立即修复」管道，修正场景树错乱的结构/用词不当">🔧 修复结构/用词</button></div>';
    if (!all0.length) {
        return statChip(0) + search + sceneBar + '<div class="ftt-empty">（该类目暂无条目）</div>';
    }
    if (q && !all.length) {
        return statChip(all0.length) + search + sceneBar + '<div class="ftt-empty">无匹配结果（搜索：' + esc(q) + '）</div>';
    }
    // —— 当前位置（总览地点）→ 段序列（V1：按 `· > ＞ /`Split） ——
    const locRaw = trim((state.state && state.state.location) || '');
    const locSegs = locRaw ? locRaw.split(/[·>＞/]/).map(trim).filter(Boolean) : [];
    // —— 聚合树：node = { name, isLeaf, scene, children } ——
    const root = { name: '', children: {}, scene: null };
    const addPath = (arr, scene) => {
        let cur = root;
        arr.forEach((seg, i) => {
            if (!cur.children[seg]) cur.children[seg] = { name: seg, children: {}, scene: null };
            const nd = cur.children[seg];
            if (i === arr.length - 1) { nd.scene = scene; nd.isLeaf = true; }
            cur = nd;
        });
    };
    for (const s of all) addPath(scenePathArr(s), s);
    // —— 当前位置命中：叶子路径是 location 段序列的**连续子序列**，或末段互相包含 ——
    const hitLeafKeys = new Set();
    const hitAncestorKeys = new Set();
    if (locSegs.length) {
        for (const s of all) {
            const arr = scenePathArr(s);
            const locJoined = locSegs.join('|');
            const pathJoined = arr.join('|');
            const matchChain = locJoined.indexOf(pathJoined) >= 0;
            const leafName = arr[arr.length - 1];
            const matchLeaf = locSegs.some((seg) => seg === leafName || leafName.indexOf(seg) === 0 || seg.indexOf(leafName) === 0);
            if (matchChain || matchLeaf) {
                hitLeafKeys.add(arr.join('>'));
                arr.forEach((_, i) => hitAncestorKeys.add(arr.slice(0, i + 1).join('>')));
            }
        }
    }
    // —— 每节点完整路径（深度优先） ——
    (function calcPath(nd, pp) {
        const cur = nd.name ? (pp ? (pp + '>' + nd.name) : nd.name) : pp;
        nd._path = cur || '';
        for (const k of Object.keys(nd.children)) calcPath(nd.children[k], cur);
    })(root, '');
    const curLocNote = locRaw
        ? ('<div class="ftt-muted" style="margin:6px 0 2px">📍 当前：' + esc(locRaw) + (hitLeafKeys.size ? '（亮色分支 = 当前位置）' : '（未匹配到场景路径）') + '</div>')
        : '';
    const hint = '<div class="ftt-muted" style="margin:6px 0 2px">场景树按全部路径聚合：灰色 = 中间层级（仅展示）；▾ 折叠/展开；亮色 = 当前位置。</div>';
    const renderNode = (nd, depth) => {
        const kids = Object.keys(nd.children).sort((a, b) => a.localeCompare(b));
        const hasKids = kids.length > 0;
        const nodePath = nd._path || '';
        const hit = nodePath && (hitLeafKeys.has(nodePath) || hitAncestorKeys.has(nodePath));
        const isCurrentLeaf = !!nd.isLeaf && !!nd.scene && hitLeafKeys.has(nodePath);
        const indent = depth * 18;
        const styleBg = hit ? 'background:rgba(240,192,96,0.15);border:1px solid rgba(240,192,96,0.45);border-radius:6px;' : '';
        const leafColor = isCurrentLeaf ? '#f0c060' : '';
        const badge = isCurrentLeaf ? '<span class="ftt-badge ftt-badge--fact">📍 当前</span>' : (hit && nd.scene ? '<span class="ftt-scene-hit">◈</span>' : '');
        let head = '';
        if (nd.name) {
            const scene = nd.scene;
            const titleHtml = scene
                ? ('<b style="color:' + (leafColor || 'inherit') + '">' + esc(nd.name) + '</b>'
                    + (scene.desc ? ('<div class="ftt-sub">' + esc(scene.desc) + '</div>') : '')
                    + ((Array.isArray(scene.tags) && scene.tags.length) ? ('<div class="ftt-tags">#' + esc(scene.tags.join(' #')) + '</div>') : ''))
                : ('<span class="ftt-sub">' + esc(nd.name) + '</span>');
            const sid = String((scene && scene.id) || '');
            const ops = scene
                ? ('<div class="ftt-item-ops">'
                    + (multi ? ('<input type="checkbox" data-ftt-select="scenes" data-ftt-id="' + esc(sid) + '"' + (sel.has(sid) ? ' checked' : '') + ' title="选中">') : '')
                    + '<button class="ftt-op" data-ftt-action="addChildScene" data-id="' + esc(sid) + '" title="添加子场景">➕子</button>'
                    + '<button class="ftt-op" data-ftt-action="edit" data-kind="scenes" data-id="' + esc(sid) + '" title="编辑">✏️</button>'
                    + '<button class="ftt-op ftt-del" data-ftt-action="delete" data-kind="scenes" data-id="' + esc(sid) + '" title="删除（留墓碑）">🗑</button></div>')
                : '';
            const rowAttr = scene ? (' data-id="' + esc(sid) + '"') : '';
            const meta = scene
                ? ('<div class="ftt-meta">' + esc((Array.isArray(scene.pathArr) ? scene.pathArr.join('>') : '') || nd.name) + ' · 调用' + (scene.uses || 0) + '次 · 重要度' + importancePct(scene) + '%</div>')
                : '';
            const toggle = hasKids
                ? ('<span class="ftt-scene-caret" data-ftt-scene-caret="1" data-ftt-scene-caret-for="' + esc(nodePath) + '" title="折叠/展开">▾</span>')
                : '<span class="ftt-scene-caret-gap"></span>';
            head = '<div class="ftt-item' + (scene ? ' ftt-inline' : '') + '"' + rowAttr + ' data-ftt-scene-node="' + esc(nodePath) + '" style="margin-left:' + indent + 'px;' + styleBg + '">'
                + '<div style="display:flex;align-items:flex-start;gap:4px;flex:1 1 auto;min-width:0">' + toggle + '<div style="flex:1;min-width:0">' + titleHtml + meta + '</div></div>'
                + ops + (badge ? ('<div style="padding:0 6px 4px">' + badge + '</div>') : '') + '</div>';
        }
        if (!hasKids) return head;
        const childHtml = kids.map((k) => renderNode(nd.children[k], depth + (nd.name ? 1 : 0))).join('\n');
        return nd.name
            ? (head + '<div class="ftt-scene-children" data-ftt-scene-children="' + esc(nodePath) + '">' + childHtml + '</div>')
            : childHtml;
    };
    const treeHtml = Object.keys(root.children).sort((a, b) => a.localeCompare(b))
        .map((k) => renderNode(root.children[k], 0)).join('\n');
    return statChip(all0.length) + search + sceneBar + curLocNote + hint + '<div class="ftt-scene-tree">' + treeHtml + '</div>';
}
