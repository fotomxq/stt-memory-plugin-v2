// ============================================================
// core/tri-link.js —— **三域联动（传言 · 计划 · 悬念）**的纯内核
//   （v3.46.1，`docs/D22` §4.12 **W11**；来源稿 `docs/D32` v1.0，Q1–Q8 已按建议默认整批裁决）
//
// 用户要求（原话）：「新版本，v3.46.1 / 开发待开发的W11」
// 一句话口径（`docs/D32` §3.8）：本功能**既不读楼层**（因此不依赖提取记忆），**也不删不合并**（因此不是修复）；
//   它只做一件事 —— **在既有条目之间建立可解释的关联，并按规则推进它们的留痕与受限字段**。
//
// 三条通道的边界（同一张表的第三行）：
//   提取（AI 摘要）= 楼层 → 条目（可新增/可删改）· 修复（各域 🔧 / 总览 🛠）= 域内卫生（不新增）·
//   **本模块 = 既有条目之间建关联 + 受限字段推进（不新增、不删除、不改正文）**。
//
// 本模块是**纯内核**：不碰 DOM / 宿主 / 定时器，只读 `state`/`cfg` 快照与注入的钩子（`check-core-purity.js` 强制）。
// 契约要点（逐条对应 `docs/D32`）：
//   · 打包（§3.4）：三段只读快照 —— 三域条目 / 关联行 / 最小事实锚（**不含情节正文**，**不调 `aiFeedText`**）；
//   · 规则（§3.2）：13 条规则表（写进提示词 → AI 按它判断；落库前按它复核）；
//   · 校验（§3.6）：七条机械判据（端点存在 / 跨域 / 字段白名单 / 关联齐备 / 上限钳制 / 知情边界 / 单调性）；
//   · 幂等（§3.6）：`linkPassSig = hash(打包指纹 + ops 规范化签名)` —— 同签名重复提交直接跳过；
//   · 应用（§3.7）：先算后写（在**副本**上求值 → 过校验 → 一次性写回）；失败整轮放弃；
//   · 留痕（§3.9）：面板提示行 + `dbgLog('联动', …)` + 运行时槽位 `state.triLinkLog`（末 5 条、不参与跨端同步）。
// ============================================================
import { state, cfg, saveState, dbgLog } from './model/runtime.js';
import { upsertRelLinks } from './entries.js';
import { storageHash } from './envelope.js';

/** 三域（顺序即"视野优先级"的默认序；`payload.scope` 可把某一域提到最前） */
export const TRI_DIMS = Object.freeze(['rumors', 'plans', 'suspense']);

/** 每域的展示名（提示词、预览区、日志共用一份，避免三处措辞漂移） */
export const TRI_DIM_LABEL = Object.freeze({ rumors: '传言', plans: '计划', suspense: '悬念' });

/** 运行时槽位：联动记录（末 5 条；**不参与跨端同步**，登记在 `core/state-slots.js`） */
export const TRI_LOG_MAX = 5;

/**
 * 受限字段白名单 + 钳制（`docs/D32` §3.5「受限字段白名单」逐字）——**出现白名单以外的字段即整条拒收**。
 * `kind`：`num` 数值（min/max/delta 单轮变化上限）· `enum` 枚举 · `text` 短文本（cap 字）· `list` 短列表（cap 条 × itemCap 字）· `append` 追加留痕（cap 字）。
 */
export const TRI_PATCH_SPEC = Object.freeze({
    plans: Object.freeze({
        progress: Object.freeze({ kind: 'num', min: 0, max: 100, delta: 20 }),
        phase: Object.freeze({ kind: 'enum', values: Object.freeze(['blocked', 'abandoned', '']) }),
        statusNote: Object.freeze({ kind: 'text', cap: 60 }),
        blockers: Object.freeze({ kind: 'list', cap: 8, itemCap: 40 }),
        history: Object.freeze({ kind: 'append', cap: 60 }),
    }),
    suspense: Object.freeze({
        clues: Object.freeze({ kind: 'append', cap: 60 }),
        resolveCondition: Object.freeze({ kind: 'text', cap: 60 }),
        level: Object.freeze({ kind: 'enum', values: Object.freeze(['主线', '支线', '彩蛋']) }),
        statusNote: Object.freeze({ kind: 'text', cap: 60 }),
        history: Object.freeze({ kind: 'append', cap: 60 }),
    }),
    rumors: Object.freeze({
        objectivity: Object.freeze({ kind: 'text', cap: 12 }),
        ferment: Object.freeze({ kind: 'num', min: 0, max: 100, delta: 25 }),
        stage: Object.freeze({ kind: 'enum', values: Object.freeze(['萌芽', '扩散', '发酵', '异变', '消退', '沉寂']), adjacent: true }),
        chain: Object.freeze({ kind: 'append', cap: 60 }),
    }),
});

/** 传言阶段（`stage` 只能改到**相邻档**——§3.5 白名单第 3 行的"相邻"口径） */
export const TRI_RUMOR_STAGES = Object.freeze(['萌芽', '扩散', '发酵', '异变', '消退', '沉寂']);

/**
 * **联动规则表**（`docs/D32` §3.2 的 L1–L13；`effect` 词表沿用 `docs/D4` §2.3）。
 * 两处用途：① 拼进提示词；② 校验时作为「该 op 是否有依据」的对照（不强制 op 必须命中某条规则 —— AI 允许合理外推，
 *   但 `reason` 必须写清依据，见 §3.5 的"允许合理外推，但必须写清理由"）。
 */
export const TRI_RULES = Object.freeze([
    Object.freeze({ id: 'L1', from: 'rumors', to: 'plans', effect: 'advance', note: '传言被证实 → 计划的步骤 / 前提推进、阻碍解除' }),
    Object.freeze({ id: 'L2', from: 'rumors', to: 'suspense', effect: 'annex+mark', note: '传言被证实 → 追加线索；满足揭晓条件则标记可揭晓' }),
    Object.freeze({ id: 'L3', from: 'rumors', to: 'plans', effect: 'annex+mark', note: '传言被证伪 → 计划前提失效，记入进展并要求复核' }),
    Object.freeze({ id: 'L4', from: 'rumors', to: 'plans', effect: 'annex', note: '传言扩散 / 发酵上升 → 计划暴露风险上升，记入进展' }),
    Object.freeze({ id: 'L5', from: 'rumors', to: 'suspense', effect: 'recompute', note: '传言扩散 / 发酵上升 → 悬念层级或线索推进' }),
    Object.freeze({ id: 'L6', from: 'rumors', to: 'plans,suspense', effect: 'annex', note: '传言裂变 / 演化出变体 → 按主体归口到相关计划 / 悬念（只建关联）' }),
    Object.freeze({ id: 'L7', from: 'plans', to: 'rumors', effect: 'advance+recompute', note: '计划了结 → 传言失去传播动力：客观性上调、发酵度下调' }),
    Object.freeze({ id: 'L8', from: 'plans', to: 'suspense', effect: 'annex', note: '计划受阻 / 放弃 → 揭晓条件变化' }),
    Object.freeze({ id: 'L9', from: 'plans', to: 'rumors', effect: 'mark', note: '计划受阻 / 放弃 → 可能催生新说法（**只标记，不新增条目**）' }),
    Object.freeze({ id: 'L10', from: 'plans', to: 'suspense', effect: 'annex', note: '计划进度推进 → 相关悬念线索随之推进' }),
    Object.freeze({ id: 'L11', from: 'suspense', to: 'rumors', effect: 'advance', note: '悬念揭晓 → 相关传言被证实或证伪（客观性变化 + 传导链留痕）' }),
    Object.freeze({ id: 'L12', from: 'suspense', to: 'plans', effect: 'advance', note: '悬念揭晓 → 计划阻碍解除，进度推进或状态备注更新' }),
    Object.freeze({ id: 'L13', from: 'any', to: 'other', effect: 'mark', note: '任一域新增 / 删除 / 编辑 → 仅在确有关联时标注受影响（不臆造因果）' }),
]);

/** 五条硬边界（`docs/D32` §3.2；校验器逐条落实，见 `triValidate`） */
export const TRI_BOUNDS = Object.freeze([
    Object.freeze({ id: 'B1', note: '不得新增 / 删除 / 合并条目，不得改写任何正文 → 字段白名单（校验 3）' }),
    Object.freeze({ id: 'B2', note: '不得凭空扩散 → 锚行 public 或已存在 knows 链（校验 6）' }),
    Object.freeze({ id: 'B3', note: '不得写历史：留痕 at 取剧情当前日期且不早于现有留痕（校验 7）' }),
    Object.freeze({ id: 'B4', note: '不得跨域回写事实：情节是唯一事实锚' }),
    Object.freeze({ id: 'B5', note: '不得一轮递归：一次点击 = 一轮（见 `core/tri-link.js` 的编排：不回调自身）' }),
]);

/** 默认上限（供 `core/config.js` 与调用点共用；`cfg` 读不到时按此兜底） */
export const TRI_DEFAULTS = Object.freeze({ enabled: true, maxItems: 60, packMaxChars: 20000, maxOps: 40, stateAdvance: true, singleMaxChars: 160, factMax: 60 });

/** 读 `cfg`（缺省回退 `TRI_DEFAULTS`；只读） */
export function triCfg() {
    const c = (cfg && typeof cfg === 'object') ? cfg : {};
    const num = (k, d) => { const n = Number(c[k]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
    return {
        enabled: c.triLinkEnabled !== false,
        stateAdvance: c.triLinkStateAdvance !== false,
        maxItems: Math.min(num('triLinkMaxItems', TRI_DEFAULTS.maxItems), 200),
        packMaxChars: Math.min(num('triLinkPackMaxChars', TRI_DEFAULTS.packMaxChars), 80000),
        maxOps: Math.min(num('triLinkMaxOps', TRI_DEFAULTS.maxOps), 120),
    };
}

// ---------- 小工具（纯） ----------
const str = (v) => String(v == null ? '' : v);
const clip = (v, n) => { const s = str(v); return s.length > n ? (s.slice(0, n) + '…') : s; };
/** 剧情当前日期（`state.state.date`；取不到则空串） */
export function triStoryDate() { try { return str(state && state.state && state.state.date); } catch (e) { return ''; } }
/** 条目标题（三域字段名不同：传言 `subject` / 计划·悬念 `title`） */
export function triTitleOf(dim, it) {
    if (!it) return '';
    return str(dim === 'rumors' ? (it.subject || it.title) : (it.title || it.subject));
}
/** 关联行的 `at`/日期解析（历史留痕的单调性判据用；解析不了 → 0） */
function tsOf(v) { const t = Date.parse(str(v)); return Number.isFinite(t) ? t : 0; }

// ============================================================
// ① 打包（`docs/D32` §3.4）：三段只读快照
// ============================================================
/**
 * 打包三域数据（**只读**，不改任何数据；返回的对象可直接 JSON 化）。
 * @param {{scope?:string}} [opts] `scope` = 入口域（`rumors` / `plans`），只影响**段内排序优先级**与预览区默认展开
 * @returns {{at:number, scope:string, storyDate:string, sections:object, ids:object, counts:object, truncated:object, chars:number, fp:string, text:string}}
 */
export function triPack(opts) {
    const o = opts || {};
    const conf = triCfg();
    const scope = (TRI_DIMS.indexOf(str(o.scope)) >= 0) ? str(o.scope) : 'rumors';
    const st = state || {};
    const ids = { rumors: {}, plans: {}, suspense: {} };
    const counts = { rumors: 0, plans: 0, suspense: 0 };
    const truncated = { items: 0, chars: 0, facts: 0 };
    const lines = [];
    const sec = { items: [], links: [], facts: [], cast: [] };

    // ── 段①：三域条目（**视野优先级**：入口域在前；域内 `status=open` 优先 → 重要度降序 → id 稳定序）
    for (const dim of TRI_DIMS.slice().sort((a, b) => (a === scope ? -1 : b === scope ? 1 : TRI_DIMS.indexOf(a) - TRI_DIMS.indexOf(b)))) {
        const arr = Array.isArray(st[dim]) ? st[dim] : [];
        const sorted = arr.slice().sort((a, b) => {
            const oa = (str(a && a.status) === 'open') ? 0 : 1;
            const ob = (str(b && b.status) === 'open') ? 0 : 1;
            if (oa !== ob) return oa - ob;
            return String(a && a.id).localeCompare(String(b && b.id));
        });
        const picked = [];
        for (const it of sorted) {
            if (!it || !it.id) continue;
            if (picked.length >= conf.maxItems) { truncated.items += (sorted.length - picked.length); break; }
            picked.push(it);
        }
        for (const it of picked) {
            const id = str(it.id);
            ids[dim][id] = true;
            counts[dim] += 1;
            const rec = {
                dim: dim, id: id, title: clip(triTitleOf(dim, it), 40),
                status: str(it.status), tags: Array.isArray(it.tags) ? it.tags.slice(0, 5) : undefined,
            };
            if (dim === 'rumors') {
                rec.objectivity = str(it.objectivity); rec.ferment = Number(it.ferment) || 0;
                rec.stage = str(it.stage); rec.media = str(it.media);
                rec.chainTail = (Array.isArray(it.chain) ? it.chain.slice(-2) : []).map((x) => clip(str(x && (x.text || x)), 60));
            } else if (dim === 'plans') {
                rec.phase = str(it.phase); rec.progress = Number(it.progress) || 0;
                rec.steps = (Array.isArray(it.steps) ? it.steps.slice(0, 6) : []).map((x) => clip(str(x && (x.text || x)), 40));
                rec.blockers = (Array.isArray(it.blockers) ? it.blockers.slice(0, 5) : []).map((x) => clip(str(x), 40));
                rec.historyTail = (Array.isArray(it.history) ? it.history.slice(-2) : []).map((x) => clip(str(x && (x.text || x)), 60));
            } else {
                rec.level = str(it.level); rec.resolveCondition = clip(it.resolveCondition, 60);
                rec.clues = (Array.isArray(it.clues) ? it.clues.slice(0, 6) : []).map((x) => clip(str(x && (x.text || x)), 40));
                rec.historyTail = (Array.isArray(it.history) ? it.history.slice(-2) : []).map((x) => clip(str(x && (x.text || x)), 60));
            }
            const body = clip(it.content || it.detail || it.text || '', TRI_DEFAULTS.singleMaxChars);
            if (str(it.content || it.detail || it.text || '').length > TRI_DEFAULTS.singleMaxChars) truncated.chars += 1;
            if (body) rec.body = body;
            sec.items.push(rec);
            lines.push(dim + ' ' + id + ' ' + rec.title + ' ' + (body || '') + ' ' + JSON.stringify(rec).slice(0, 240));
        }
    }
    // ── 段②：关联行（端点或人行涉及三域的**锚行 + 人行**）
    const linkMax = Math.max(1, Number((cfg && cfg.relLinkMax) || 12));
    for (const dim of TRI_DIMS) {
        for (const id of Object.keys(ids[dim])) {
            const rows = (Array.isArray(st.links) ? st.links : []).filter((x) => x && str(x.dim) === dim && str(x.refId) === id).slice(0, linkMax);
            for (const r of rows) {
                sec.links.push({ dim: dim, refId: id, who: str(r.who), how: str(r.how), public: r.public === true, deviation: str(r.deviation) });
            }
        }
    }
    lines.push('L ' + JSON.stringify(sec.links).slice(0, 400));
    // ── 段③：最小事实锚（**不含正文**）+ 涉及角色名去重
    const atoms = (Array.isArray(st.atoms) ? st.atoms : []).filter((a) => a && a.id);
    for (const a of atoms) {
        if (sec.facts.length >= TRI_DEFAULTS.factMax) { truncated.facts += 1; continue; }
        sec.facts.push({ id: str(a.id), title: clip(triTitleOf('atoms', a) || a.title, 40), date: str(a.date) });
    }
    const cast = [];
    const addCast = (v) => { const s = str(v).trim(); if (s && cast.indexOf(s) < 0 && cast.length < 60) cast.push(s); };
    for (const dim of TRI_DIMS) for (const it of (Array.isArray(st[dim]) ? st[dim] : [])) { addCast(it && it.who); addCast(it && it.owner); addCast(it && it.carrier); }
    for (const it of sec.items) if (it.dim === 'rumors' && Array.isArray(it.carriers)) it.carriers.slice(0, 6).forEach(addCast);
    sec.cast = cast;
    lines.push('F ' + JSON.stringify(sec.facts).slice(0, 400) + ' C ' + cast.join(' '));

    // ── 总量上限（超限从**段①末尾**开始截：保留"视野优先级"最高的那些）
    let text = lines.join('\n');
    if (text.length > conf.packMaxChars) {
        let cut = 0;
        while (text.length > conf.packMaxChars && sec.items.length > 0) {
            const dropped = sec.items.pop();
            delete ids[dropped.dim][dropped.id];
            counts[dropped.dim] = Math.max(0, counts[dropped.dim] - 1);
            cut += 1;
            const keep = lines.filter((l) => l.indexOf(dropped.dim + ' ' + dropped.id + ' ') !== 0);
            lines.length = 0; for (const l of keep) lines.push(l);
            text = lines.join('\n');
        }
        truncated.items += cut;
        truncated.chars += cut;
    }
    return {
        at: Date.now(), scope: scope, storyDate: triStoryDate(),
        sections: sec, ids: ids, counts: counts, truncated: truncated, chars: text.length,
        fp: storageHash(JSON.stringify(sec.items.map((x) => x.id).concat(sec.links.map((x) => x.dim + x.refId + (x.who || ''))))),
        text: text,
    };
}

// ============================================================
// ② 解析与七条校验（`docs/D32` §3.6）
// ============================================================
/** 从 AI 文本里抠出 JSON（容忍 ```json 包裹与前后解释文字；失败 → null） */
export function triParse(text) {
    const s = str(text).trim();
    if (!s) return null;
    const tryParse = (t) => { try { const v = JSON.parse(t); return (v && typeof v === 'object' && Array.isArray(v.ops)) ? v : null; } catch (e) { return null; } };
    let v = tryParse(s);
    if (v) return v;
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) { v = tryParse(fence[1].trim()); if (v) return v; }
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) { v = tryParse(s.slice(i, j + 1)); if (v) return v; }
    return null;
}

/** 字段白名单/钳制：把 `patch` 收成合法值；出现白名单外字段 → 返回 null（整条拒收） */
export function triClampPatch(dim, patch, it) {
    const spec = TRI_PATCH_SPEC[dim];
    if (!spec) return null;
    const out = {};
    const src = (patch && typeof patch === 'object') ? patch : {};
    for (const k of Object.keys(src)) {
        const rule = spec[k];
        if (!rule) return null;                                   // 校验 3：白名单外字段 → 整条拒收
        const v = src[k];
        if (rule.kind === 'num') {
            const n = Number(v);
            if (!Number.isFinite(n)) return null;
            const cur = Number(it && it[k]) || 0;
            const delta = Math.max(-rule.delta, Math.min(rule.delta, Math.round(n) - cur));
            out[k] = Math.max(rule.min, Math.min(rule.max, cur + delta));
        } else if (rule.kind === 'enum') {
            const s = str(v);
            if (rule.values.indexOf(s) < 0) return null;
            if (rule.adjacent) {
                const cur = str(it && it[k]) || TRI_RUMOR_STAGES[0];
                const ci = TRI_RUMOR_STAGES.indexOf(cur), ni = TRI_RUMOR_STAGES.indexOf(s);
                if (ci >= 0 && ni >= 0 && Math.abs(ci - ni) > 1) return null;     // 只能改到相邻档
            }
            out[k] = s;
        } else if (rule.kind === 'text') {
            out[k] = clip(v, rule.cap);
        } else if (rule.kind === 'list') {
            const arr = (Array.isArray(v) ? v : [v]).map((x) => clip(x, rule.itemCap)).filter(Boolean).slice(0, rule.cap);
            out[k] = arr;
        } else if (rule.kind === 'append') {
            out[k] = clip(v, rule.cap);
        }
    }
    return out;
}

/**
 * **七条机械校验**（`docs/D32` §3.6 逐条；AI 只提方案，结构由这里兜底）。
 * @param {Array} ops AI 返回的 `ops`
 * @param {object} pack `triPack()` 的结果
 * @returns {{accepted:Array, rejected:Array, reasons:object}}
 */
export function triValidate(ops, pack) {
    const conf = triCfg();
    const accepted = [];
    const rejected = [];
    const reasons = {};
    const bump = (r) => { reasons[r] = (reasons[r] || 0) + 1; };
    const list = Array.isArray(ops) ? ops : [];
    // 校验 1 的辅助：打包集合内 `{dim, id}` 精确匹配
    const inPack = (end) => {
        try {
            const d = str(end && end.dim), i = str(end && end.id);
            return !!(pack && pack.ids && pack.ids[d] && pack.ids[d][i]);
        } catch (e) { return false; }
    };
    const itemOf = (dim, id) => {
        const arr = (state && state[dim]) || [];
        for (const x of arr) if (x && str(x.id) === str(id)) return x;
        return null;
    };
    let taken = 0;
    for (const raw of list.slice(0, Math.max(1, conf.maxOps * 4))) {
        const op = raw || {};
        const src = { dim: str(op.src && op.src.dim), id: str(op.src && op.src.id) };
        const dst = { dim: str(op.dst && op.dst.dim), id: str(op.dst && op.dst.id) };
        const why = [];
        // 1 端点存在性（本次打包集合内）
        if (!inPack(src) || !inPack(dst)) why.push('endpoint-not-packed');
        // 2 跨域性
        if (src.dim === dst.dim) why.push('same-dim');
        // 3 字段白名单
        let patch = {};
        const item = itemOf(dst.dim, dst.id);
        if (op.patch && typeof op.patch === 'object' && Object.keys(op.patch).length) {
            const p = triClampPatch(dst.dim, op.patch, item);
            if (!p) why.push('patch-not-allowed'); else patch = p;
        }
        // 4 关联特性齐备（link 必须是 about / knows，且 knows 要带 who）
        const link = str(op.link);
        const who = str(op.who || (op.linkWho) || (op.patch && op.patch.who) || '').trim();
        if (link !== 'about' && link !== 'knows') why.push('no-link');
        if (link === 'knows' && !who) why.push('knows-without-who');
        // 6 知情边界（B2）：knows 新增知情者 / about 让传言扩散到新角色 → 该条目锚行 public 或该角色已有 knows 链
        if (!why.length && link === 'knows') {
            const anchor = ((state && state.links) || []).filter((x) => x && str(x.dim) === src.dim && str(x.refId) === src.id);
            const isPublic = anchor.some((x) => !str(x.who) && x.public === true) || (itemOf(src.dim, src.id) && itemOf(src.dim, src.id).public === true);
            const known = anchor.some((x) => str(x.who) === who && str(x.how));
            if (!isPublic && !known) why.push('no-knowledge-basis');
        }
        // 5 上限（op 总数）
        if (!why.length && taken >= conf.maxOps) why.push('over-max-ops');
        // 7 单调性：留痕 at 不早于该条目现有留痕（`history` / `chain` 的日期）
        if (!why.length) {
            const now = triStoryDate();
            const arr = (dst.dim === 'plans') ? (item && item.history) : (dst.dim === 'suspense' ? (item && item.history) : (item && item.chain));
            const last = Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
            const lastAt = last ? tsOf(last.at || last.date || last.time) : 0;
            const nowAt = tsOf(now);
            if (lastAt && nowAt && nowAt < lastAt) why.push('not-monotonic');
        }
        if (why.length) { rejected.push({ op: op, reasons: why }); for (const r of why) bump(r); continue; }
        taken += 1;
        accepted.push({ src: src, dst: dst, link: link, who: who, effect: str(op.effect) || 'annex', patch: patch,
            evidence: { ref: str(op.evidence && op.evidence.ref), quote: clip(op.evidence && op.evidence.quote, 40) },
            reason: clip(op.reason, 60) });
    }
    return { accepted: accepted, rejected: rejected, reasons: reasons };
}

/** 幂等签名（`docs/D32` §3.6）：打包指纹 + ops 规范化签名 */
export function triSig(pack, accepted) {
    try {
        const norm = (Array.isArray(accepted) ? accepted : []).map((o) => [o.src.dim, o.src.id, o.dst.dim, o.dst.id, o.link, o.who, JSON.stringify(o.patch || {})].join('|')).sort();
        return storageHash(String((pack && pack.fp) || '') + '#' + norm.join('~'));
    } catch (e) { return ''; }
}

// ============================================================
// ③ 应用（`docs/D32` §3.7 ⑤：先算后写 → 一次性写回）
// ============================================================
/**
 * 把已通过校验的 op 落到 `state.links` + 受限字段 + 留痕。
 * **纪律**：不新增 / 不删除条目、不改正文、不递归（B1/B4/B5）。
 * @returns {{links:number, fields:number, notes:number, details:Array}}
 */
export function triApply(accepted) {
    const out = { links: 0, fields: 0, notes: 0, details: [] };
    const now = triStoryDate();
    const st = state || {};
    /** 取某条目当前锚行（`who` 空的那条）；没有则 null */
    const anchorOf = (dim, id) => ((st.links || []).filter((x) => x && String(x.dim) === dim && String(x.refId) === id && !String(x.who))[0]) || null;
    for (const op of (Array.isArray(accepted) ? accepted : [])) {
        const detail = { src: op.src.dim + ':' + op.src.id, dst: op.dst.dim + ':' + op.dst.id, link: op.link, fields: [] };
        try {
            // ⑤-a 关联行（**主体**，`docs/D32` §3.1 三级载体）：
            //   `about` = **源条目**的锚行承载指向目标的结构化引用（R→P 写传言锚行的 `planRef`；P↔S 双向同写 = `数-34`）
            //   `knows` = **源条目**的人行（`who` + `how`）；同时在其锚行记一条指向目标的结构化引用（保证跨域可反查，§3.6-4）
            const anchorIncoming = Object.assign({}, anchorOf(op.src.dim, op.src.id) || {}, triRefPatch(op.src, op.dst));
            const anchorRes = upsertRelLinks(op.src.dim, op.src.id, [anchorIncoming], {});
            out.links += Number(anchorRes && (anchorRes.added + anchorRes.updated)) || 0;
            detail.fields.push('anchor:' + op.src.dim + '→' + op.dst.dim);
            if (op.link === 'knows') {
                const kr = upsertRelLinks(op.src.dim, op.src.id, [{ who: op.who, how: triHowFor(op.src.dim) }], {});
                out.links += Number(kr && (kr.added + kr.updated)) || 0;
                detail.fields.push('knows:' + op.who);
            }
            // 数-34：计划 ↔ 悬念**双向镜像**（两侧锚行同写；幂等 —— 已有同 ref 则 upsert 不叠加）
            if (op.link === 'about' && ((op.src.dim === 'plans' && op.dst.dim === 'suspense') || (op.src.dim === 'suspense' && op.dst.dim === 'plans'))) {
                const back = Object.assign({}, anchorOf(op.dst.dim, op.dst.id) || {}, triRefPatch(op.dst, op.src));
                const br = upsertRelLinks(op.dst.dim, op.dst.id, [back], {});
                out.links += Number(br && (br.added + br.updated)) || 0;
                detail.fields.push('mirror:' + op.dst.dim + '→' + op.src.dim);
            }
            // ⑤-b 受限字段 + 留痕（白名单已在校验器里收过一遍，这里再算一次钳制）
            const conf = triCfg();
            if (conf.stateAdvance && op.patch && Object.keys(op.patch).length) {
                const dim = op.dst.dim;
                const item = ((st[dim] || []).filter((x) => x && String(x.id) === op.dst.id)[0]) || null;
                if (item) {
                    for (const k of Object.keys(op.patch)) {
                        const v = op.patch[k];
                        if (k === 'history' || k === 'chain' || k === 'clues') {
                            const key = (k === 'history') ? 'history' : (k === 'chain' ? 'chain' : 'clues');
                            if (!Array.isArray(item[key])) item[key] = [];
                            const entry = (k === 'clues') ? { text: v, by: op.who || '', at: now } : { text: v, at: now, kind: (k === 'chain' ? '联动' : undefined), result: (k === 'history' ? op.effect : undefined) };
                            item[key].push(entry);
                            const cap = (k === 'chain') ? 60 : (k === 'clues' ? Math.max(1, Number((cfg && cfg.cluesMax) || 20)) : Math.max(1, Number((cfg && cfg.planHistoryMax) || 30)));
                            if (item[key].length > cap) item[key] = item[key].slice(-cap);
                            out.notes += 1;
                        } else {
                            item[k] = v;
                        }
                        out.fields += 1;
                        detail.fields.push(k + '=' + JSON.stringify(v).slice(0, 40));
                    }
                }
            }
            out.details.push(detail);
        } catch (e) { detail.error = str((e && e.message) || e); out.details.push(detail); }
    }
    return out;
}

/**
 * 目标域 → 锚行上的**结构化引用字段名**（`docs/D32` §3.1 三级载体第 1 级；`memRefs` 是数组）。
 * 只支持三域 + 被三域直接引用的 `atoms` / `concepts` / `memories`（其余域不在本功能写入范围）。
 */
export function triRefPatch(src, dst) {
    const id = str(dst && dst.id);
    if (!id) return {};
    const d = str(dst && dst.dim);
    if (d === 'plans') return { planRef: id };
    if (d === 'suspense') return { suspenseRef: id };
    if (d === 'atoms') return { atomRef: id };
    if (d === 'concepts') return { conceptRef: id };
    if (d === 'memories') return { memRefs: [{ dim: 'memories', refId: id }] };
    return {};
}
/** 该域的默认 `how`（传言 = 听说；计划 = 知情；悬念 = 当事人） */
function triHowFor(dim) {
    return dim === 'rumors' ? 'heard' : (dim === 'plans' ? 'unspecified' : 'involved');
}

// ============================================================
// ④ 运行时槽位与留痕（`docs/D32` §3.9）
// ============================================================
/** 追加一条联动记录（**末 5 条**；不参与跨端同步 —— `core/state-slots.js` 已登记为 runtime） */
export function triLogPush(rec) {
    try {
        const arr = Array.isArray(state.triLinkLog) ? state.triLinkLog : (state.triLinkLog = []);
        arr.push(Object.assign({ at: Date.now() }, rec || {}));
        while (arr.length > TRI_LOG_MAX) arr.shift();
        return arr.length;
    } catch (e) { return 0; }
}
/** 只读副本（面板 / 调试导出共用） */
export function triLogList() { try { return (Array.isArray(state.triLinkLog) ? state.triLinkLog : []).map((x) => Object.assign({}, x)); } catch (e) { return []; } }
/** 提示行文案（`docs/D32` §3.9：关联 N · 留痕 N · 状态 N · 拒绝 N（截断 M）） */
export function triNoteText(applied, rejectedCount, truncated) {
    const a = applied || {};
    return '联动构建：关联 ' + (Number(a.links) || 0) + ' · 留痕 ' + (Number(a.notes) || 0) + ' · 状态 ' + (Number(a.fields) || 0)
        + ' · 拒绝 ' + (Number(rejectedCount) || 0)
        + (Number((truncated || {}).items) ? ('（截断 ' + Number(truncated.items) + '）') : '');
}
/** 调试日志（kind `联动`） */
export function triDebug(rec) { try { dbgLog('联动', rec || {}); } catch (e) { /* 忽略 */ } }
/** 落盘（注入式：调用方也可自行 saveState） */
export function triSave() { try { return saveState(); } catch (e) { return false; } }

/** 五种终止原因（`docs/D32` §3.11）：调用点在跑之前先问一次 */
export function triBlockReason(hasData) {
    const conf = triCfg();
    if (!conf.enabled) return 'disabled';
    if (!hasData) return 'no-data';
    return '';
}

/** 每种原因的**用户可见文案**（面板提示行 + toast 共用同一份，避免两处措辞漂移） */
export const TRI_REASON_TEXT = Object.freeze({
    disabled: '联动构建已关闭（可在配置里打开 triLinkEnabled）',
    busy: '分析管道占用中，稍后再试',
    'no-data': '三域（传言 / 计划 / 悬念）都还没有条目',
    'no-ai': 'AI 未返回结果，本次未改动任何数据',
    invalid: '方案不可用（全部动作被拒）',
});
