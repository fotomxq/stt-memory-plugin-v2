// ============================================================
// ui/feed-scan.js —— **投喂标签自动分析**（B9-c）
//
// V1 出处（`src/FTT记忆组件-v1.206.js`）：
//   · `let rxTagScan = null`（约 695）+ `latestAiFloorInfo()`（约 696）+ `rxNormTag()`（约 713）
//     + `rxAnalyzeLatestText()`（约 720）+ `rxDedupeTagList()`（约 755）+ `rxPushFeedTag()`（约 766）
//     —— 均为模块级函数，且在 V1 `__FTT` 导出清单内（约 28126）。
//   · 结果渲染 `rxTagScanHtml()`（约 25157）。
//   · 设定页「投喂标签自动分析」节 + 「投喂白/黑名单标签」两节（约 25513~25527）。
//   · 动作 `rxScanTags`（约 27087）/ `rxAddTag`（约 27094）/ `rxScanClear`（约 27103）。
//
// 语义（与 V1 逐字一致）：扫描**最近一条 AI 正文**的结构 → 列出 HTML 标签（成对闭合者排前）与行内标记
//   （【】/[]）→ 点标签右侧「＋白 / ＋黑」**一键收录**进投喂白/黑名单（**大小写不敏感自动排重**）→ 可清空结果。
//   结果缓存在模块级 `rxTagScan`（跨 `renderPanel` 保留），只有 `rxScanClear` 或再次分析才改变。
//
// V2 适配（逐条登记，行为序与 V1 一致）：
//   ① **楼层读取走宿主层**：V1 用 TH 的 `getLastMessageId()` + `getChatMessages(i, {hide_state:'all', include_swipes:true})`
//      （取 `msgs[0]`）；V2 用 `core/model/runtime.js#getLastMessageId()` + `host/floors.js#floorMessage(i)`
//      （同一份 `ctx.chat[i]` 原始消息）。取文口径 `assistantTextOf(m) || m.mes` 与 V1 `getAssistantText(m) || m.mes` 同实现。
//   ② **配置键用 V2 规范名**：V1 落点 `cfg.feedRegexWhitelist` / `cfg.feedRegexBlacklist`（同 V2），
//      但 V1 设定页文本域用的是**别名** `data-ftt-cfg="rx_whitelist"` / `"rx_blacklist"`，由 `settingsApplyAll` 映射回真实键
//      并在保存时整表排重；V2 无「批量保存」层（每个控件即时写回），故文本域直接用真实键，
//      排重改在面板 change 委托里对 `rx_whitelist` 等价的键调用 `rxDedupeTagList(value.split('\n'))`（语义同 V1）。
//   ③ **提示通道**：V1 用 toastr（`notify(title, text)`）；V2 写面板 `state.note`（读 `r.state.note`）。
//      `feedScanAction()` 同时返回 `title` 与 `note`（= V1 的 title / text），面板只施加 `note`。
//   ④ V1 `rxTagScanHtml` 里的 `escHtml` 在 V2 用 `core/util.js#escHtml`（同实现）。
// ============================================================
import { cfg, saveCfg, getLastMessageId, warn } from '../core/model/runtime.js';
import { floorMessage, assistantTextOf } from '../host/floors.js';
import { escHtml } from '../core/util.js';

/** 投喂白/黑名单的配置键（V1 同名：`cfg.feedRegexWhitelist` / `cfg.feedRegexBlacklist`） */
export const RX_WHITELIST_KEY = 'feedRegexWhitelist';
export const RX_BLACKLIST_KEY = 'feedRegexBlacklist';
/** 设定页文本域需在保存时整表排重的键（V1 `settingsApplyAll` 的 `rx_whitelist`/`rx_blacklist` 等价物） */
export const RX_TAG_TEXT_KEYS = Object.freeze([RX_WHITELIST_KEY, RX_BLACKLIST_KEY]);

/** 分析结果缓存（V1 `let rxTagScan = null`；跨重渲染保留） */
let rxTagScan = null;

/**
 * 最新 AI 正文 + 楼层号（V1 `latestAiFloorInfo` 逐字：回溯窗口 60 楼）。
 * 跳过隐藏楼 / 用户楼 / `role` 非 assistant 的楼 / 空白正文楼；无 AI 回复时 `floor = -1`。
 * @returns {{text:string, floor:number}}
 */
export function latestAiFloorInfo() {
    try {
        const last = getLastMessageId();
        if (last < 0) return { text: '', floor: -1 };
        for (let i = last; i >= 0 && i >= last - 60; i--) {
            const m = floorMessage(i);
            if (!m || m.is_hidden) continue;
            if (m.is_user) continue;
            if (m.role && m.role !== 'assistant') continue;
            const text = assistantTextOf(m) || (typeof m.mes === 'string' ? m.mes : '');
            if (text && String(text).trim()) return { text: String(text).trim(), floor: i };
        }
        return { text: '', floor: -1 };
    } catch (e) { return { text: '', floor: -1 }; }
}

/**
 * 标签名归一化（V1 `rxNormTag` 逐字）：去掉 `<content>` / `</content>` 包裹与【】［］「」括号、首尾引号，限长 40。
 * @returns {string}
 */
export function rxNormTag(raw) {
    let s = String(raw == null ? '' : raw).trim();
    s = s.replace(/^<\s*\/?\s*/, '').replace(/\s*\/?\s*>$/, '');
    s = s.replace(/^[【\[（("'「『]+/, '').replace(/[】\]）)"'」』]+$/, '');
    return s.trim().slice(0, 40);
}

/** 读当前分析结果（副本；诊断/测试用） */
export function rxTagScanState() {
    try { return rxTagScan ? JSON.parse(JSON.stringify(rxTagScan)) : null; } catch (e) { return null; }
}
/** 写分析结果（`null` = 清空；诊断/测试用） */
export function setRxTagScan(v) { rxTagScan = v || null; return rxTagScan; }

/**
 * 正文结构分析（V1 `rxAnalyzeLatestText` 逐字）：HTML 标签名（含是否成对）+ 行内标记（【】/[]）。
 * 排序：成对优先 → 次数降序 → 名称 `localeCompare` 升序；各取前 30。
 * @returns {object} `{ok, ts, floor, chars, tags:[{name,count,paired}], markers:[{name,count}]}`；无正文时 `{ok:false, reason:'no-text',…}`
 */
export function rxAnalyzeLatestText() {
    const info = latestAiFloorInfo();
    if (!info.text) {
        rxTagScan = { ok: false, reason: 'no-text', ts: Date.now(), floor: -1, chars: 0, tags: [], markers: [] };
        return rxTagScan;
    }
    const text = info.text;
    const tagMap = new Map();
    const closedSet = new Set();
    try {
        let m;
        const reOpen = /<\s*([a-zA-Z][a-zA-Z0-9_:.-]*)(?:\s[^<>]*)?\/?>/g;
        while ((m = reOpen.exec(text))) { const n = m[1].toLowerCase(); tagMap.set(n, (tagMap.get(n) || 0) + 1); }
        const reClose = /<\s*\/\s*([a-zA-Z][a-zA-Z0-9_:.-]*)\s*>/g;
        while ((m = reClose.exec(text))) closedSet.add(m[1].toLowerCase());
    } catch (e) { /* 与 V1 同容错 */ }
    const tags = Array.from(tagMap.entries())
        .map(([name, count]) => ({ name, count, paired: closedSet.has(name) }))
        .sort((a, b) => (b.paired - a.paired) || (b.count - a.count) || a.name.localeCompare(b.name))
        .slice(0, 30);
    const markerMap = new Map();
    try {
        let m;
        const reMark = /[【\[]([^】\]\n]{1,24})[】\]]/g;
        while ((m = reMark.exec(text))) {
            const n = String(m[1] || '').trim();
            if (!n || !/[0-9A-Za-z\u4e00-\u9fff]/.test(n)) continue;   // 至少含一个实义字符
            markerMap.set(n, (markerMap.get(n) || 0) + 1);
        }
    } catch (e) { /* 与 V1 同容错 */ }
    const markers = Array.from(markerMap.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name))
        .slice(0, 30);
    rxTagScan = { ok: true, ts: Date.now(), floor: info.floor, chars: text.length, tags, markers };
    return rxTagScan;
}

/**
 * 保存时的整表排重（V1 `rxDedupeTagList` 逐字）：大小写不敏感、去空、保序。
 * @param {Array} list
 * @returns {string[]}
 */
export function rxDedupeTagList(list) {
    const out = [];
    for (const raw of (Array.isArray(list) ? list : [])) {
        const tag = rxNormTag(raw);
        if (!tag) continue;
        if (out.some((x) => x.toLowerCase() === tag.toLowerCase())) continue;
        out.push(tag);
    }
    return out;
}

/**
 * 收录一个标签到白/黑名单（V1 `rxPushFeedTag` 逐字，自动排重）。
 * 注意（V1 原生口径，原样保留）：空标签分支**不做整表计算** → `n` 恒为 0（不是当前名单长度）。
 * @param {'white'|'black'|string} kind 非 `'black'` 一律按 `'white'`
 * @param {string} raw
 * @returns {{added:boolean, reason:string, tag:string, n:number, other:boolean}}
 */
export function rxPushFeedTag(kind, raw) {
    const out = { added: false, reason: '', tag: '', n: 0, other: false };
    try {
        const tag = rxNormTag(raw);
        out.tag = tag;
        if (!tag) { out.reason = 'empty'; return out; }
        const isBlack = kind === 'black';
        const key = isBlack ? RX_BLACKLIST_KEY : RX_WHITELIST_KEY;
        const otherKey = isBlack ? RX_WHITELIST_KEY : RX_BLACKLIST_KEY;
        const list = rxDedupeTagList(cfg[key]);
        out.n = list.length;
        if (list.some((x) => x.toLowerCase() === tag.toLowerCase())) { out.reason = 'dup'; return out; }
        list.push(tag);
        cfg[key] = list;
        out.n = list.length;
        out.added = true;
        try { out.other = rxDedupeTagList(cfg[otherKey]).some((x) => x.toLowerCase() === tag.toLowerCase()); } catch (e) { /* 与 V1 同容错 */ }
        try { saveCfg(); } catch (e) { /* 落盘失败不影响内存写入（V1 同容错） */ }
    } catch (e) { out.reason = 'error'; }
    return out;
}

/** 当前白/黑名单（只读副本；诊断用） */
export function rxFeedTagLists() {
    try {
        return { white: rxDedupeTagList(cfg[RX_WHITELIST_KEY]), black: rxDedupeTagList(cfg[RX_BLACKLIST_KEY]) };
    } catch (e) { return { white: [], black: [] }; }
}
/** 该键是否属于「投喂标签」文本域（保存时需整表排重；V1 `settingsApplyAll` 的等价判定） */
export function isFeedTagKey(key) { return RX_TAG_TEXT_KEYS.indexOf(String(key || '')) >= 0; }

/**
 * 分析结果渲染（V1 `rxTagScanHtml` 逐字）：未分析 / 无正文 / 有结果三态；
 * 有结果时每个候选渲染「＋白」「＋黑」两个收录按钮，**已收录者高亮**（`ftt-chip-btn--on-w` / `--on-b`）。
 * @returns {string}
 */
export function rxTagScanHtml() {
    const s = typeof rxTagScan === 'undefined' ? null : rxTagScan;
    if (!s) return '<div class="ftt-muted">尚未分析。点「🔍 分析最新正文结构」列出正文中的 HTML 标签与行内标记，点标签即可收录。</div>';
    if (!s.ok) return '<div class="ftt-muted">⚠️ 未取到最近一条 AI 正文，无法分析。</div>';
    const wl = (Array.isArray(cfg.feedRegexWhitelist) ? cfg.feedRegexWhitelist : []).map((x) => String(x || '').toLowerCase());
    const bl = (Array.isArray(cfg.feedRegexBlacklist) ? cfg.feedRegexBlacklist : []).map((x) => String(x || '').toLowerCase());
    const chip = (name, count, paired) => {
        const k = String(name).toLowerCase();
        const inW = wl.indexOf(k) >= 0, inB = bl.indexOf(k) >= 0;
        const attr = escHtml(String(name));
        return '<span class="ftt-scan-chip">'
            + '<b class="ftt-text">' + attr + '</b><span class="ftt-sub">×' + count + (paired ? '·成对' : '') + '</span>'
            + '<button class="ftt-btn ftt-sm ftt-chip-btn' + (inW ? ' ftt-chip-btn--on-w' : '') + '" data-ftt-action="rxAddTag" data-ftt-kind="white" data-ftt-tag="' + attr + '" title="加入白名单">＋白</button>'
            + '<button class="ftt-btn ftt-sm ftt-chip-btn' + (inB ? ' ftt-chip-btn--on-b' : '') + '" data-ftt-action="rxAddTag" data-ftt-kind="black" data-ftt-tag="' + attr + '" title="加入黑名单">＋黑</button>'
            + '</span>';
    };
    const tagsHtml = s.tags.length ? s.tags.map((t) => chip(t.name, t.count, t.paired)).join('') : '<span class="ftt-muted">（未发现 HTML 标签）</span>';
    const marksHtml = s.markers.length ? s.markers.map((m) => chip(m.name, m.count, false)).join('') : '<span class="ftt-muted">（未发现行内标记）</span>';
    return '<div class="ftt-hint ftt-my-2">📄 第 ' + s.floor + ' 楼 AI 正文 · ' + s.chars + ' 字 · 标签 ' + s.tags.length + ' 种 / 标记 ' + s.markers.length + ' 种（已收录高亮）</div>'
        + '<div class="ftt-my-2"><span class="ftt-hint">HTML 标签：</span>' + tagsHtml + '</div>'
        + '<div class="ftt-my-2"><span class="ftt-hint">行内标记：</span>' + marksHtml + '</div>';
}

/** 设定页「投喂标签自动分析」节（V1 约 25513~25518 逐字；两个按钮**无 title**，与 V1 一致） */
export function feedScanSectionHtml() {
    return '<div class="ftt-section"><div class="ftt-sec-title">投喂标签自动分析</div>'
        + '<div class="ftt-row"><button class="ftt-btn ftt-sm" data-ftt-action="rxScanTags">🔍 分析最新正文结构</button><button class="ftt-btn ftt-sm" data-ftt-action="rxScanClear">清空结果</button></div>'
        + '<div class="ftt-muted ftt-my-1">扫描<b>最近一条 AI 正文</b>：列出 HTML 标签与行内标记；点「＋白 / ＋黑」收录，自动排重。</div>'
        + rxTagScanHtml()
        + '</div>';
}

/**
 * 设定页「投喂白名单 / 黑名单标签」两节（V1 约 25519~25527 逐字）。
 * 唯一差异：`data-ftt-cfg` 用 V2 规范键（V1 用别名 `rx_whitelist`/`rx_blacklist`，见文件头 ②）。
 */
export function feedTagListSectionsHtml() {
    const wl = (cfg[RX_WHITELIST_KEY] || []).join('\n');
    const bl = (cfg[RX_BLACKLIST_KEY] || []).join('\n');
    return '<div class="ftt-section"><div class="ftt-sec-title">投喂白名单标签（只保留含这些标签的行，每行一个标签名）</div>'
        + '<textarea data-ftt-cfg="' + RX_WHITELIST_KEY + '" class="ftt-textarea">' + escHtml(wl) + '</textarea>'
        + '<div class="ftt-muted">填标签名即可（如 content 或【战斗】），无需正则；留空=不过滤。白名单全部未命中会自动回退为不过滤。</div>'
        + '</div>'
        + '<div class="ftt-section"><div class="ftt-sec-title">投喂黑名单标签（屏蔽含这些标签的行，每行一个标签名）</div>'
        + '<textarea data-ftt-cfg="' + RX_BLACKLIST_KEY + '" class="ftt-textarea">' + escHtml(bl) + '</textarea>'
        + '<div class="ftt-muted">填标签名即可（如【系统消息】），无需写正则。留空=不过滤。</div>'
        + '</div>';
}

/**
 * 投喂标签动作（V1 同名：`rxScanTags` / `rxAddTag` / `rxScanClear`）。
 * 返回值：
 *   · `title` / `text` —— 与 V1 `notify(kind, {title, text})` 的 title / text **逐字一致**（黄金样本可比）；
 *   · `note` —— V2 面板提示（V1 用 toastr 的 title+text 两行，V2 面板只有一行）：
 *     约定 `note = title ? title + '：' + text : text`；`rxScanClear` 与 V1 一样**无提示**（三者皆空串）。
 * @returns {{ok:boolean, action:string, title:string, text:string, note:string}}
 */
export function feedScanAction(action, payload) {
    const a = String(action || '');
    const p = payload || {};
    /** V1 `notify(title, text)` → V2 单行 note（约定见上） */
    const mk = (ok, title, text, extra) => Object.assign({
        ok: ok, action: a, title: String(title || ''), text: String(text || ''),
        note: title ? (String(title) + '：' + String(text || '')) : String(text || ''),
    }, extra || {});
    try {
        if (a === 'rxScanTags') {
            const sc = rxAnalyzeLatestText();
            if (!sc || !sc.ok) {
                return mk(false, '未取到最新正文', '当前会话没有可分析的 AI 回复（或正文为空）。', { scan: sc });
            }
            return mk(true, '已分析最新正文结构',
                '第 ' + sc.floor + ' 楼 · ' + sc.chars + ' 字 · HTML 标签 ' + sc.tags.length + ' 种 / 行内标记 ' + sc.markers.length + ' 种；点标签右侧「＋白」/「＋黑」即可收录。',
                { scan: sc });
        }
        if (a === 'rxAddTag') {
            // V1：`const kind = String(ds && ds.fttKind === 'black' ? 'black' : 'white');`
            const kind = String(p.kind === 'black' ? 'black' : 'white');
            const res = rxPushFeedTag(kind, p.tag);
            const label = kind === 'black' ? '黑名单' : '白名单';
            if (!res.added) {
                const dup = res.reason === 'dup';
                return mk(false,
                    dup ? ('已在' + label + '中（自动排重）') : '未收录',
                    dup ? (res.tag + ' · 当前共 ' + res.n + ' 项') : '标签为空，未收录。',
                    { kind: kind, result: res });
            }
            return mk(true, '已加入' + label,
                res.tag + ' · 当前共 ' + res.n + ' 项' + (res.other ? '（注意：该标签也存在于另一侧名单）' : ''),
                { kind: kind, result: res });
        }
        if (a === 'rxScanClear') { rxTagScan = null; return mk(true, '', ''); }
        return mk(false, '', '未知投喂标签动作：' + a);
    } catch (e) {
        warn('投喂标签动作失败', e);
        return mk(false, '', '投喂标签动作失败：' + String((e && e.message) || e));
    }
}

/** 投喂标签动作名（供面板分发；与 V1 `data-ftt-action` 逐字一致） */
export const FEED_SCAN_ACTIONS = Object.freeze(['rxScanTags', 'rxAddTag', 'rxScanClear']);
