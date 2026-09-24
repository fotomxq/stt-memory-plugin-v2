// ============================================================
// core/worldbook.js —— **世界书单向镜像（内核）**
//   （B8-7，逐字移植自 V1 `src/modules/05-记忆状态与存储抽象.js` 的 `storageProviders.worldbook`
//     「世界书 Markdown 分层同步」段 + `buildWorldbookKeys`）
//
// 定位：世界书存储是**可选单向灌输**（只出不进）—— 把记忆库「类目常驻词条（H1 索引，constant）+
//   原子词条（H2 标题 + 正文）」全量重建写入所选世界书，供酒馆自行激活触发；**不参与主存储读取/对账**
//   （`read` 仅兼容 v1.27 旧快照词条，供一次性迁移识别）。
//
// 本文件只做**纯构建与识别**（零宿主依赖、导入无副作用、未开启世界书存储时零行为）：
//   ① `buildWorldbookEntries(env)`      —— 词条构建（V1 逐字：类目 H1 常驻 + 原子 H2/正文 + keys 纯标签）；
//   ② `worldbookIsFttEntry` / `worldbookLegacyEntryName` / `worldbookIsOurs` —— 识别/清理三态；
//   ③ `buildWorldbookKeys(maxN)`        —— 世界书自动关键词（记忆库真实高频标签）；
//   ④ `worldbookTotalBytes` / `worldbookFormatBytes` / `worldbookMemoryTotal` —— 体积上限判定与同步日志；
//   ⑤ `WORLDBOOK_META`                  —— V1 `storageMeta.worldbook` 元数据（label/short/...）。
//   宿主通道（TH 世界书 API 调用、8s 防抖写入调度）在 `host/worldbook.js` + `adapters/worldbook.js`；
//   面板动作 `worldbookRefresh` 与 `FTT.*` 入口**待接线**（见 docs/P8y-B8-7世界书单向镜像.md §4）。
//
// 适配（与 V1 的差异，逐条见 docs/P8y-B8-7世界书单向镜像.md）：
//   ① ESM 化：`cfg` / `state` 取注入视图（`core/model/runtime.js`），`scopeId()` 取 `core/state.js`
//      —— V1 直接读全局 `cfg` / `state` 与 `getCurrentCharacterId()`；`activeAtoms()` 取 `core/merge.js`（V1 同源）；
//   ② `legacyEntryName()` 的角色名取 `identityView.characterName`（宿主注入）；V1 调 TH `getCurrentCharacterName()`。
//      V1 有 `try/catch` 兜底 `'FTT记忆快照'`，V2 视图读取不抛错 → 该兜底分支在本文件**不可达**（保留等价语义）；
//   ③ 关联摘要行：V2 `core/model/rel.js#relSummaryLine` **不可复用**（文案与行序都不同 —— 计划/悬念为
//      「公开计划/公开悬念」、平行事件无「关联：」前缀、且按可靠度重排行）。本文件**逐字重写** V1 `relWbLine`
//      （含 `REL_LINK_HOW_LABEL` 取值与 `links` **原序**），保证词条内容与 V1 逐字符一致；
//   ④ V1 的 `FTT·` 前缀 / `extra.ftt` 无前缀 / v1.27 快照词条三态口径原样保留（注释里的「-38」指 v1.37-38
//      的 `FTT·` 前缀词条，`isFttEntry` 本身只有两个判据，第三态由 `legacyEntryName()` 在 `worldbookIsOurs` 中兜）；
//   ⑤ `buildWorldbookEntries` 的 V1 数值怪癖原样保留（`worldbookDepth: null` → `0` 而非 9999；`worldbookScanDepth`
//      非数字 → `NaN`；概率钳制到 0-100；短标题 ≤40/类目名 ≤20/`atomContent` 标题 ≤48）。
// 一致性由 tests/unit/worldbook-golden.test.js 的真实 V1 黄金样本强制校验。
// ============================================================
import { cfg, state, identityView } from './model/runtime.js';
import { scopeId } from './state.js';
import { activeAtoms } from './merge.js';

/** V1 `storageMeta.worldbook`（逐字复制；`storageIsWriteMirror('worldbook') === false` —— 不参与常规写镜像） */
const WORLDBOOK_META = {
    group: 'cross',
    crossDevice: true,
    label: '世界书存储',
    short: '世界书',
    desc: '单向写入所选世界书词条（类目词条+原子词条，Markdown 分层），供酒馆自行激活触发；可选（独立开关）',
};

/**
 * V1 `REL_LINK_HOW_LABEL`（`core/model/rel.js` 未导出 `relHowLabelOf`，且 `relSummaryLine` 文案不同 → 此处逐字复制）。
 * 仅用于世界书词条正文末尾的关联摘要行。
 */
const REL_LINK_HOW_LABEL = { participant: '亲历', witness: '目击', told: '被告知', inferred: '推断', rumor: '传闻', unspecified: '知情', author: '策划', join: '参与', involved: '当事人', investigating: '在查', related: '相关' };
/** V1 `relHowLabelOf`：未登记的 how 一律「知情」 */
function relHowLabelOf(how) { try { return REL_LINK_HOW_LABEL[how] || '知情'; } catch (e) { return '知情'; } }

/** V1 `formatBytes(n)`：B / KB(1 位小数) / MB(2 位小数) */
function worldbookFormatBytes(n) {
    try {
        const b = Number(n) || 0;
        if (b >= 1048576) return `${(b / 1048576).toFixed(2)} MB`;
        if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
        return `${b} B`;
    } catch (e) { return '0 B'; }
}

/** 词条总体积（V1 `write` 口径：所有词条的 `content.length + name.length` 之和） */
function worldbookTotalBytes(entries) {
    return (Array.isArray(entries) ? entries : [])
        .reduce((s, e) => s + (String((e && e.content) || '').length + String((e && e.name) || '').length), 0);
}

/** V1 `totalMemoryCount()`（本文件只用于「世界书同步完成」调试日志；V2 同名函数在 core/ingest.js 未导出） */
function worldbookMemoryTotal() {
    const c = state || {};
    return (c.atoms || []).length + (c.currentStates || []).length + (c.snapshots || []).length +
        (c.memories || []).length + (c.items || []).length + (c.plans || []).length + (c.suspense || []).length +
        (c.scenes || []).length + (c.concepts || []).length;
}

/**
 * 是否本插件词条（V1 `storageProviders.worldbook.isFttEntry`）——两态判据：
 *   ① v1.37-38 的 `FTT·` 前缀词条；② v1.39 起的无前缀词条（`extra.ftt` 标记）。
 * 第三态（v1.27 快照词条 `FTT记忆快照·角色`）由 `worldbookLegacyEntryName()` 承担，见 `worldbookIsOurs`。
 */
function worldbookIsFttEntry(e) {
    return !!(e && (String(e.name || '').startsWith('FTT·') || (e.extra && e.extra.ftt)));
}

/** 旧版单条快照词条名（V1 `legacyEntryName`）：`FTT记忆快照·<角色名前 20 字>` */
function worldbookLegacyEntryName() {
    try {
        const nm = identityView.characterName || '';
        return 'FTT记忆快照·' + String(nm).slice(0, 20);
    } catch (e) { return 'FTT记忆快照'; }
}

/** 清理判据（V1 `write`/`remove` 内联的 `isOurs`）：三态合一的「这是我的词条吗」 */
function worldbookIsOurs(e) {
    if (!e) return false;
    if (worldbookIsFttEntry(e)) return true;
    const legacy = worldbookLegacyEntryName();
    if ((e.comment !== undefined && e.comment === legacy) || e.name === legacy) return true;
    return false;
}

/**
 * 世界书自动关键词（V1 `buildWorldbookKeys`）：记忆库真实高频标签 —— 只取长度 2-12 的字面标签
 * （剔除 `FTT记忆` / 角色名等无关固定词与超短/超长垃圾），按频次降序取前 `n` 个（默认 8，下限 3）。
 * 数据源：`activeAtoms()`（已总结隐藏的情节不参与）+ 记忆前 60 + 概念前 30；`tags` 优先、回退 `keywords`。
 */
function buildWorldbookKeys(maxN) {
    try {
        const n = Math.max(3, Number(maxN) || 8);
        const words = [];
        const freq = {};
        const add = (arr) => { (arr || []).forEach(k => { const kk = String(k || '').trim(); if (kk && kk.length >= 2 && kk.length <= 12) freq[kk] = (freq[kk] || 0) + 1; }); };
        activeAtoms().slice(0, 60).forEach(a => add(a.tags && a.tags.length ? a.tags : a.keywords));   // v1.203：已总结隐藏的不参与关键词归纳
        ((state && state.memories) || []).slice(0, 60).forEach(m => add(m.tags && m.tags.length ? m.tags : m.keywords));
        ((state && state.concepts) || []).slice(0, 30).forEach(c => add(c.tags && c.tags.length ? c.tags : c.keywords));
        Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n).forEach(([k]) => { if (!words.includes(k)) words.push(k); });
        return words.slice(0, n);
    } catch (e) { return []; }
}

/**
 * 构建世界书词条（V1 `buildWorldbookEntries`，逐字移植）。
 * 结构：类目常驻词条（`# 类目` + 原子标题清单，strategy=constant）+ 该类目原子词条（`## 标题` + 正文，
 * strategy=`cfg.storage.worldbookMode`，keys=原子自身真实标签）—— 全量重建、无冗余、书内顺序即层级顺序。
 * @param {object} env 存储信封 `{ ts, payload: { data } }`（V1 同款；缺 data → 空结果）
 * @returns {Array<object>} TH 世界书词条数组
 */
function buildWorldbookEntries(env) {
    const st = (cfg && cfg.storage) || {};
    const d = (env && env.payload && env.payload.data) || {};
    const entries = [];
    const cleanLine = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    // 词条/标题行用短标题（≤40 字，超出加省略号）；正文保留原文
    const shortTitle = (v, max) => {
        const s = cleanLine(v);
        const m = Math.max(8, Number(max) || 40);
        return s.length > m ? s.slice(0, m - 1) + '…' : s;
    };
    // 只收集原子自身真实标签（长度 2-12、去重、上限 10）；不再附加 'FTT记忆'/类目词
    const realKeys = (...lists) => {
        const out = [];
        (lists || []).forEach(arr => (arr || []).forEach(k => {
            const kk = String(k || '').trim();
            if (kk && kk.length >= 2 && kk.length <= 12 && !out.includes(kk)) out.push(kk);
        }));
        return out.slice(0, 10);
    };
    const strategyOf = (type, keys) => ({
        type,
        keys: Array.isArray(keys) ? keys.slice(0, 10) : [],
        keys_secondary: { logic: 'and_any', keys: [] },
        scan_depth: Math.max(1, Number(st.worldbookScanDepth) != null ? Number(st.worldbookScanDepth) : 6),
    });
    const positionOf = () => ({
        type: st.worldbookPosition || 'at_depth',
        role: st.worldbookRole || 'system',
        depth: Number(st.worldbookDepth) != null ? Number(st.worldbookDepth) : 9999,
        order: 100,
    });
    const miscOf = () => ({
        enabled: true,
        probability: Math.max(0, Math.min(100, Number(st.worldbookProbability) != null ? Number(st.worldbookProbability) : 100)),
        recursion: {
            prevent_incoming: st.worldbookPreventRecursion !== false,
            prevent_outgoing: st.worldbookPreventRecursion !== false,
            delay_until: null,
        },
        effect: {
            sticky: st.worldbookSticky != null ? Number(st.worldbookSticky) : null,
            cooldown: st.worldbookCooldown != null ? Number(st.worldbookCooldown) : null,
            delay: st.worldbookDelay != null ? Number(st.worldbookDelay) : null,
        },
    });
    // 单个原子的 Markdown 内容：`## 原子标题` + 空行 + 正文（正文与标题同源/为空时只输出标题行，不重复平铺）
    const atomContent = (titleRaw, bodyRaw) => {
        const title = cleanLine(titleRaw);
        const body = String(bodyRaw || '').trim();
        if (!title && !body) return '';
        if (title && body && body !== title) {
            return `## ${shortTitle(title, 48)}\n\n${body.slice(0, 2000)}`;
        }
        // 无独立标题（标题即正文，如情节/计划/悬念）：整句较短直接作标题行；过长则短标题 + 完整正文
        const full = body || title;
        const line = cleanLine(full);
        if (line.length <= 80) return `## ${line}`;
        return `## ${shortTitle(line, 40)}\n\n${full.slice(0, 2000)}`;
    };
    // 各类目数据源：{kind, 类目标题, 原子标题, 正文, 真实标签}
    // v1.166：世界书词条的关联摘要行（cfg.relLinkToWorldbook，默认开）—— 词条正文附
    //   「谁知情 / 谁相关」，与注入体口径一致；关闭或无关联时返回空串（零冗余）。
    const relWbLine = (dim, refId) => {
        try {
            if (cfg && cfg.relLinkToWorldbook === false) return '';
            const rows = (Array.isArray(d.links) ? d.links : ((state && state.links) || []))
                .filter(x => x && String(x.dim) === String(dim) && String(x.refId) === String(refId));
            if (!rows.length) return '';
            const anchor = rows.find(x => !x.who) || null;
            const people = rows.filter(x => x.who);
            if (String(dim) === 'parallels') return people.length ? `关联：相关 ${people.slice(0, 6).map(x => x.who).join('、')}（角色不知情）` : '';
            if (anchor && anchor.public) return String(dim) === 'memories' ? '关联：公开事实（人尽皆知）' : '关联：公开（人尽皆知）';
            if (!people.length) return '';
            const label = (typeof relHowLabelOf === 'function') ? relHowLabelOf : ((h) => h);
            const order = ['author', 'involved', 'participant', 'witness', 'join', 'investigating', 'told', 'inferred', 'rumor', 'unspecified'];
            const groups = [];
            for (const how of order) {
                const list = people.filter(x => x.how === how);
                if (!list.length) continue;
                groups.push(`${label(how)}：${list.slice(0, 6).map(x => x.who).join('、')}`);
            }
            return groups.length ? `关联：${groups.join(' · ')}` : '';
        } catch (e) { return ''; }
    };
    const catSources = [
        { kind: '情节', title: (a) => a.title || a.text, body: (a) => a.text || a.content, keys: (a) => realKeys(a.tags, a.keywords), src: (d2) => d2.atoms || [] },
        { kind: '记忆', dim: 'memories', title: (m) => m.title, body: (m) => m.content, keys: (m) => realKeys(m.tags, m.keywords), src: (d2) => d2.memories || [] },
        { kind: '概念', title: (c) => c.name, body: (c) => c.content, keys: (c) => realKeys(c.tags, c.keywords), src: (d2) => d2.concepts || [] },
        { kind: '物品', title: (i) => i.name, body: (i) => i.desc, keys: (i) => realKeys([i.name]), src: (d2) => d2.items || [] },
        { kind: '计划', dim: 'plans', title: (p) => p.content, body: (p) => p.content, keys: (p) => realKeys(p.tags), src: (d2) => (d2.plans || []).filter(x => x.status !== 'closed') },
        { kind: '悬念', dim: 'suspense', title: (s) => s.content, body: (s) => s.content, keys: (s) => realKeys(s.tags), src: (d2) => (d2.suspense || []).filter(x => x.status !== 'closed') },
    ];
    const catOrder = { '情节': 1, '记忆': 2, '概念': 3, '物品': 4, '计划': 5, '悬念': 6 };
    const cats = catSources
        .map(cs => ({
            kind: cs.kind,
            items: cs.src(d).map(x => ({
                id: String((x && x.id) || ''),
                title: cleanLine(cs.title(x)),
                body: String(cs.body(x) || '').trim(),
                keys: cs.keys(x),
                // v1.166：关联摘要行（受 relLinkToWorldbook 控制；无关联 → 空，零冗余）
                rel: (cs.dim && x && x.id) ? relWbLine(cs.dim, x.id) : '',
            })).filter(x => x.title || x.body),
        }))
        .sort((a, b) => (catOrder[a.kind] || 99) - (catOrder[b.kind] || 99));
    const mode = st.worldbookMode || 'selective';
    // 先类目常驻词条（H1 索引），再该类目原子词条（H2+正文），保持书内顺序即层级顺序
    cats.forEach(cat => {
        if (!cat.items.length) return;   // 空类目不建词条（无冗余）
        // 类目常驻词条：内容 = `# 类目` + 原子标题清单（Markdown 一级标题列该类目）；constant 常驻
        const list = cat.items.map(it => `- ${shortTitle(it.title || it.body)}`).join('\n');
        entries.push({
            name: shortTitle(cat.kind, 20),
            ...miscOf(),
            strategy: strategyOf('constant', []),
            position: positionOf(),
            content: `# ${cat.kind}\n\n${list}`.slice(0, 4000),
            extra: { ftt: { kind: cat.kind, scope: scopeId(), ts: env.ts, cat: true } },
        });
        // 原子词条：标题=原子标题（去前缀）、内容内部 ## 标题 + 正文、keys=真实标签
        cat.items.forEach(it => {
            const atomTitle = shortTitle(it.title || it.body);
            const base = atomContent(it.title, it.body);
            // v1.166：关联摘要行附在词条正文末尾（与注入体同口径）
            const content = it.rel ? `${base}\n\n${it.rel}` : base;
            entries.push({
                name: atomTitle,
                ...miscOf(),
                strategy: strategyOf(mode, it.keys),
                position: positionOf(),
                content,
                extra: { ftt: { kind: cat.kind, scope: scopeId(), ts: env.ts, title: it.title || '' } },
            });
        });
    });
    return entries;
}

export {
    WORLDBOOK_META,
    worldbookFormatBytes, worldbookTotalBytes, worldbookMemoryTotal,
    worldbookIsFttEntry, worldbookLegacyEntryName, worldbookIsOurs,
    buildWorldbookKeys, buildWorldbookEntries,
    relHowLabelOf,
};
