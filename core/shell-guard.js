// ============================================================
// core/shell-guard.js —— **空壳条目判定与入库拦截**（v3.44.0，`docs/D22` **W4** `数-13`）
//
// 设计依据：`docs/D20` §3.4 / §8 `数-13` ——
//   事实：「少量空壳条目（场景 5/40、NPC 快照 6/27 正文 < 12 字，最短 0 字）」；
//   步骤：① 入库前加最小长度与必需字段校验（不达标**丢弃并计数**）；② 体检增设空壳项；③ 列表加筛选视图；
//   验收：「构造空壳 → 被丢弃且计数可见；已有空壳可筛选出」。
//
// 两个**不同**的判据（刻意分开，避免误删）：
//   · **入库拦截 `isShellEntry`（严）**：只有「**完全无信息**」才拦 —— 所有「正文类」字段与「标识类」字段
//     加起来不足 `SHELL_MIN_CHARS` 字，且除 `id` 外没有任何非空的自有字段。
//     为什么这么严：`items` 里「钥匙」这类 2 个字的条目**是有意义的**（标识本身就是信息），
//     按 `docs/D20` K 的「正文 < 12 字」去拦会把它们一起丢掉 → 那是**数据损失**，不是治理。
//   · **体检 `shellReport`（宽）**：按 `D20` K 的实测口径（正文 < `SHELL_MIN_CHARS` 字）列出**存量**条目，
//     只报告、不删（`docs/D20` §5 R6「卫生清理误删内容」的对策：只清字段与占位，绝不删条目）。
//     存量空壳的出口是**列表筛选视图**（`ui/panel.js` 的筛选条）+ 人工决定删或不删。
//
// 纪律：本模块是**纯函数叶子**（不 import 任何 core 模块），可在内核任意处使用；
//   拦截只发生在**写入路径**（`core/ingest.js#mergeDelta` 的 `add` 列表），**不触碰存量数据**。
// ============================================================

/** 最小可承载信息的字数（`docs/D20` K 的实测口径：正文 < 12 字即视为空壳） */
export const SHELL_MIN_CHARS = 12;

/**
 * 各维「正文类」字段（承载内容语义；这些字段为空 = 这条没啥可读的）
 * 与「标识类」字段（用来指认对象；短但有意义）。
 */
const DIM_FIELDS = Object.freeze({
    atoms: { body: ['text', 'content'], ident: ['title'] },
    memories: { body: ['content', 'text'], ident: ['title', 'owner'] },
    snapshots: { body: ['content', 'background.history', 'appearance'], ident: ['name'] },
    items: { body: ['desc', 'content'], ident: ['name'] },
    concepts: { body: ['content', 'text'], ident: ['name'] },
    scenes: { body: ['desc', 'content'], ident: ['name'] },
    plans: { body: ['content'], ident: ['title'] },
    suspense: { body: ['content'], ident: ['title'] },
    parallels: { body: ['text', 'content'], ident: ['title'] },
    currencies: { body: ['note'], ident: ['name', 'owner'] },
    rumors: { body: ['content'], ident: ['subject', 'title'] },
    plotSegments: { body: ['linesText', 'header'], ident: ['header'] },
    npcs: { body: ['desc'], ident: ['name'] },
});

/** 除 id 外**不算信息**的元字段（插件自维护；它们有值不代表条目有内容） */
const META_KEYS = [
    'id', 'uses', 'importance', 'strength', 'nsfw', 'floorStart', 'floorEnd', 'floorNowStart', 'floorNowEnd',
    'originGone', 'chatKey', 'updatedAt', 'createdAt', 'hidden', 'summarizedAt', 'lastSeenDate', 'lastSeenFloor',
    'at', 'nsfwLevel', 'category', 'kind',
];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function getByPath(o, path) {
    try {
        let cur = o;
        for (const seg of String(path).split('.')) { if (cur == null) return undefined; cur = cur[seg]; }
        return cur;
    } catch (e) { return undefined; }
}

/** 单字段文本长度（非字符串先转字符串；数组按元素求和；对象忽略） */
function textLen(v) {
    try {
        if (v === undefined || v === null) return 0;
        if (typeof v === 'string') return v.trim().length;
        if (typeof v === 'number') return String(v).length;
        if (Array.isArray(v)) return v.reduce((n, x) => n + ((typeof x === 'string') ? x.trim().length : 0), 0);
        return 0;
    } catch (e) { return 0; }
}

/** 该维的字段集（未登记的维度 → 宽松：不拦） */
export function shellFieldsOf(dim) { return DIM_FIELDS[String(dim)] || null; }

/** 正文类字段合计长度（体检口径：正文 < 12 字 = 空壳） */
export function bodyLengthOf(dim, it) {
    const spec = shellFieldsOf(dim);
    if (!spec || !isObj(it)) return 0;
    let n = 0;
    for (const f of spec.body) n += textLen(getByPath(it, f));
    return n;
}

/** 标识类字段合计长度 */
export function identLengthOf(dim, it) {
    const spec = shellFieldsOf(dim);
    if (!spec || !isObj(it)) return 0;
    let n = 0;
    for (const f of spec.ident) n += textLen(getByPath(it, f));
    return n;
}

/**
 * **体检口径**（宽）：该条目是不是空壳 —— 正文类字段合计 < `SHELL_MIN_CHARS` 字。
 * 只用于报告与筛选，**不用于删除**。
 */
export function isShellEntry(dim, it) {
    try {
        if (!shellFieldsOf(dim) || !isObj(it)) return false;
        // 完全没有正文类字段可查的维度（理论上不会发生）→ 不算空壳（宁可漏报不误报）
        const hasAny = (shellFieldsOf(dim).body || []).length > 0;
        if (!hasAny) return false;
        return bodyLengthOf(dim, it) < SHELL_MIN_CHARS;
    } catch (e) { return false; }
}

/**
 * **入库拦截口径**（严）：完全不承载信息的条目 ——
 *   **标识类也为空**（`identLen === 0`）**且**正文类合计 < `SHELL_MIN_CHARS` **且**除元字段外没有其它有值字段。
 *
 * 为什么必须要求「标识类也为空」：`items` / `scenes` 的 `name`、`plans` 的 `title` 本身就是信息 ——
 *   「钥匙」只有 2 个字，但它**确实指认了一个对象**，丢掉它就是**数据损失**。
 *   只按「正文短」去拦，正是 `docs/D20` K 表那个实测口径会踩的坑（体检可以用它，拦截不行）。
 *   —— 这一条是**实测出来的**：第一版按「正文 + 标识合计 < 12 字」实现，`slim-keeper` 之外还让
 *   `ingest-golden` 的 V1 悬念（11 字、无标题）掉了一条，正是本轮把开关默认设为关的直接原因。
 * @returns {{shell:boolean, len:number, identLen:number, extraKeys:string[]}}
 */
export function shellVerdict(dim, it) {
    const out = { shell: false, len: 0, identLen: 0, extraKeys: [] };
    try {
        const spec = shellFieldsOf(dim);
        if (!spec || !isObj(it)) return out;
        out.len = bodyLengthOf(dim, it);
        out.identLen = identLengthOf(dim, it);
        out.extraKeys = Object.keys(it).filter((k) => {
            if (META_KEYS.indexOf(k) >= 0) return false;
            if (spec.body.indexOf(k) >= 0 || spec.ident.indexOf(k) >= 0) return false;
            const v = it[k];
            if (v === undefined || v === null || v === '') return false;
            if (Array.isArray(v)) return v.length > 0;
            if (typeof v === 'object') return Object.keys(v).length > 0;
            return true;
        });
        out.shell = out.identLen === 0 && (out.len + out.identLen) < SHELL_MIN_CHARS && out.extraKeys.length === 0;
        return out;
    } catch (e) { return out; }
}

/**
 * **入库前过滤**：就地剔除 `delta[dim].add` 里的空壳条目（只动新增，绝不碰 update / remove / close）。
 * @param {object} delta 归一化后的增量（就地修改）
 * @param {{dims?:string[]}} [opts] 只过滤这些维度（缺省：`DIM_FIELDS` 的全部键）
 * @returns {{dropped:number, byDim:object, samples:Array<{dim:string,len:number}>}}
 */
export function filterShellAdds(delta, opts) {
    const stat = { dropped: 0, byDim: {}, samples: [] };
    try {
        if (!isObj(delta)) return stat;
        const dims = (opts && Array.isArray(opts.dims) && opts.dims.length) ? opts.dims : Object.keys(DIM_FIELDS);
        for (const dim of dims) {
            const node = delta[dim];
            if (!isObj(node) || !Array.isArray(node.add) || !node.add.length) continue;
            const keep = [];
            for (const it of node.add) {
                let shell = false;
                try { shell = shellVerdict(dim, it).shell; } catch (e) { shell = false; }
                if (!shell) { keep.push(it); continue; }
                stat.dropped++;
                stat.byDim[dim] = (stat.byDim[dim] || 0) + 1;
                if (stat.samples.length < 5) stat.samples.push({ dim: dim, len: (isObj(it) ? bodyLengthOf(dim, it) + identLengthOf(dim, it) : 0) });
            }
            if (keep.length !== node.add.length) node.add = keep;
        }
        return stat;
    } catch (e) { return stat; }
}

/**
 * 存量空壳报告（体检用；只读）：按维度计数 + 给出前若干条样本 id（**不删**）。
 * @returns {{total:number, byDim:object, samples:Array<{dim:string,id:string,len:number}>}}
 */
export function shellReport(st, opts) {
    const out = { total: 0, byDim: {}, samples: [] };
    try {
        const s = st || {};
        const dims = (opts && Array.isArray(opts.dims) && opts.dims.length) ? opts.dims : Object.keys(DIM_FIELDS);
        const maxSamples = Math.max(0, Number((opts || {}).samples) || 5);
        for (const dim of dims) {
            const arr = s[dim];
            if (!Array.isArray(arr)) continue;
            for (const it of arr) {
                if (!isObj(it)) continue;
                if (!isShellEntry(dim, it)) continue;
                out.total++;
                out.byDim[dim] = (out.byDim[dim] || 0) + 1;
                if (out.samples.length < maxSamples) out.samples.push({ dim: dim, id: String(it.id || ''), len: bodyLengthOf(dim, it) });
            }
        }
        return out;
    } catch (e) { return out; }
}

export { DIM_FIELDS };
