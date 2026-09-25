// ============================================================
// core/clock-trace.js —— **剧情时钟「取值追踪」**（纯内核，无宿主依赖）
//
// 目的（用户要求）：「时钟日志记录有问题，需明确**从哪里取值、取值逻辑是什么**，以方便追踪问题。」
//   本模块提供一套**统一的时钟取值追踪结构**，让每一处时钟日志都能回答四个问题：
//     ① 值是什么（value）—— 最终落盘值；
//     ② 从哪来（from）—— 取值来源键，配 `CLOCK_SRC_LABEL` 的中文标签（不再出现看不懂的英文键）；
//     ③ 为什么取它（why）—— 命中该来源的**判据**（正则/正文头/相对词/优先级链/同一节点…）；
//     ④ 还有什么没被采用（rejects）—— 全部被放弃候选取值与**放弃原因**。
//   另记录「降级链」（degrade）与「实际落盘差异」（applied：字段 prev → next，同值/被手工锁定也如实标注）。
//
// 结构（可序列化，仅截断样本，不落正文全文）：
//   {
//     id, stage, at, action,
//     text:     { mode, floors, chars, sample },
//     chain:    ['手工锁定', '正文头结构', '正文正则', …],       // 本次实际参与的取值环节（按判定顺序）
//     picks:    { date|time|location|present: { value, from, fromLabel, why } },
//     rejects:  [{ field, value, from, fromLabel, idx, raw, why }],
//     degrade:  { degraded, reason, reasonLabel, detail },
//     applied:  { fields: [{ field, from, to, changed }], locked, unchanged, present },
//     notes:    [string],
//   }
// 环形保留最近若干条（`CLOCK_TRACE_KEEP`），供调试页与 `FTT.clockTrace()` 查看。
// 一致性：本模块**不参与任何取值决策**（只记录），故不影响既有黄金样本校验。
// ============================================================

/** 记录条数（每个 stage 各自保留最近 N 条） */
export const CLOCK_TRACE_KEEP = 5;

/**
 * 取值来源键 → 中文标签（**全量登记**）。键取自各产源的真实写入值：
 *   `core/clock-extract.js`（regex/header/custom/marker/daypart/relative/storyday/plot/atom-latest/prev/scene/manual/
 *   latest-ai/plot-atom/keep-prev）与 `core/clock-patrol.js`（manual/clock/plot/atoms-majority）。
 * 未知键由 `clockSrcLabel()` 标注「（未登记）」并保留原键 —— 便于发现新增产源漏登记。
 */
export const CLOCK_SRC_LABEL = {
    // 日期 / 时间 / 地点（正文侧）
    regex: '正文正则（最新正文）',
    header: '正文头结构（▷/▶）',
    custom: '自定义正则（设定页）',
    marker: '标记式（【日期:…】/日期:…）',
    daypart: '纯时段词（清晨/晚上…）',
    relative: '相对日期推进（明天/3天后…）',
    storyday: '「第 N 天」纪元换算',
    // 数据侧
    plot: '最新情节',
    'atom-latest': '原子数据（最新存在日期）',
    prev: '沿用已有值',
    scene: '最新场景（降级）',
    // 在场
    'latest-ai': '最新 AI 正文点名',
    'plot-atom': '最新情节涉及角色',
    'keep-prev': '沿用旧名单',
    // 手工 / 锚点
    manual: '手工强制改写',
    clock: '当前剧情时钟',
    'atoms-majority': '原子数据多数派',
};

/** 降级原因键 → 中文（与 `ui/clock.js` 的既有文案同源，此处统一为唯一事实源） */
export const CLOCK_DEGRADE_LABEL = {
    force: '强制降级（设定已开启）',
    'no-date': '正文未识别到日期',
    'anomaly:jump': '日期异常：年份远超当前时钟',
    'anomaly:backward': '日期异常：剧情时间大幅倒退',
    'anomaly:invalid': '日期异常：格式非法',
};

/** 来源键 → 中文标签；空值 → '—'；未知键 → `<键>（未登记）` */
export function clockSrcLabel(key) {
    const k = String(key == null ? '' : key).trim();
    if (!k) return '—';
    return CLOCK_SRC_LABEL[k] || (k + '（未登记）');
}

/** 降级原因 → 中文标签（未知原因保留原键） */
export function clockDegradeLabel(reason) {
    const r = String(reason == null ? '' : reason).trim();
    if (!r) return '';
    return CLOCK_DEGRADE_LABEL[r] || r;
}

/** 全部已登记来源键（测试用：断言产源与标签不脱节） */
export function clockSrcKeys() { return Object.keys(CLOCK_SRC_LABEL); }

// ---------- 追踪实例 ----------
let seq = 0;
const store = {};   // { [stage]: [trace, …] }（最新在前）

const str = (v) => String(v == null ? '' : v);
const clip = (v, n) => { const s = str(v); return s.length > n ? (s.slice(0, n) + '…') : s; };

/** 新建一条追踪（stage：extract / patrol / regex-ai / time-repair；action：人为可读的动作名） */
export function clockTraceStart(stage, action) {
    seq += 1;
    return {
        id: 'ct' + seq,
        stage: str(stage) || 'extract',
        action: str(action),
        at: Date.now(),
        text: { mode: '', floors: '', chars: 0, sample: '' },
        chain: [],
        picks: {},
        rejects: [],
        degrade: { degraded: false, reason: '', reasonLabel: '', detail: '' },
        applied: { fields: [], locked: false, unchanged: [], present: null },
        notes: [],
    };
}

/** 记录取文来源（模式 / 楼层范围 / 字符数 / 样本前 80 字） */
export function clockTraceText(trace, info) {
    if (!trace) return trace;
    const i = info || {};
    trace.text = {
        mode: str(i.mode),
        floors: str(i.floors),
        chars: Number(i.chars) || 0,
        sample: clip(i.sample, 80),
    };
    if (i.note) trace.notes.push(str(i.note));
    return trace;
}

/** 记录一个取值环节（按判定顺序；调试页据此还原「先试什么、再试什么」） */
export function clockTraceChain(trace, step) {
    if (!trace) return trace;
    const s = str(step).trim();
    if (s && trace.chain.indexOf(s) < 0) trace.chain.push(s);
    return trace;
}

/** 记录某字段的最终取值与判据 */
export function clockTracePick(trace, field, pick) {
    if (!trace) return trace;
    const f = str(field);
    const p = pick || {};
    trace.picks[f] = {
        value: p.value == null ? '' : p.value,
        from: str(p.from),
        fromLabel: clockSrcLabel(p.from),
        why: str(p.why),
    };
    return trace;
}

/** 记录一个**被放弃**的候选（含原始片段与放弃原因）——「为什么没取这个值」 */
export function clockTraceReject(trace, cand) {
    if (!trace) return trace;
    const c = cand || {};
    trace.rejects.push({
        field: str(c.field),
        value: c.value == null ? '' : c.value,
        from: str(c.from),
        fromLabel: clockSrcLabel(c.from),
        idx: Number(c.idx) || 0,
        raw: clip(c.raw, 60),
        why: str(c.why),
    });
    return trace;
}

/** 追加一条备注（统计/说明；如巡检的扫描条数与修复原因分布） */
export function clockTraceNote(trace, note) {
    if (!trace) return trace;
    const n = clip(note, 300);
    if (n) trace.notes.push(n);
    return trace;
}

/** 记录降级判定（是否降级 / 原因 / 细节，如「探测日期与锚点相差 120 年」） */
export function clockTraceDegrade(trace, info) {
    if (!trace) return trace;
    const i = info || {};
    trace.degrade = {
        degraded: !!i.degraded,
        reason: str(i.reason),
        reasonLabel: clockDegradeLabel(i.reason),
        detail: clip(i.detail, 200),
    };
    return trace;
}

/** 记录落盘差异（fields: [{field, from, to, changed}]） */
export function clockTraceApplied(trace, info) {
    if (!trace) return trace;
    const i = info || {};
    trace.applied = {
        fields: Array.isArray(i.fields) ? i.fields.map((x) => ({
            field: str(x && x.field), from: str(x && x.from), to: str(x && x.to), changed: !!(x && x.changed),
        })) : [],
        locked: !!i.locked,
        unchanged: Array.isArray(i.unchanged) ? i.unchanged.map(str) : [],
        present: i.present == null ? null : i.present,
    };
    if (i.note) trace.notes.push(str(i.note));
    return trace;
}

/** 收尾并入环形缓冲（返回该 trace，便于直接写日志） */
export function clockTraceFinish(trace, action) {
    if (!trace) return trace;
    if (action) trace.action = str(action);
    const stage = trace.stage || 'extract';
    const list = store[stage] || (store[stage] = []);
    list.unshift(trace);
    if (list.length > CLOCK_TRACE_KEEP) list.length = CLOCK_TRACE_KEEP;
    store['last'] = [trace].concat((store['last'] || []).filter((x) => x !== trace)).slice(0, CLOCK_TRACE_KEEP);
    return trace;
}

/** 最近一条追踪（缺省取全局最近一条；给 stage 则取该阶段最近一条） */
export function clockTraceLast(stage) {
    const key = str(stage);
    if (!key) return (store['last'] && store['last'][0]) || null;
    const list = store[key] || [];
    return list[0] || null;
}

/** 某阶段全部追踪（最新在前；只读副本语义 —— 调用方不要改写） */
export function clockTraceList(stage) { return ((store[str(stage)] || [])).slice(); }

/** 清空（测试/排障用） */
export function clockTraceClear() {
    Object.keys(store).forEach((k) => { delete store[k]; });
    return true;
}

/**
 * 一行摘要（日志/面板共用的可读形态）：
 *   `🕒 取值 [提取] 正文=最新AI回复 · 日期 1919-11-29←正文正则（…） · 时间 08:52←正文头结构(…） · 地点 … · 在场 …`
 */
export function clockTraceSummary(trace) {
    const t = trace || clockTraceLast();
    if (!t) return '';
    const partOf = (f) => {
        const p = t.picks[f];
        if (!p) return '';
        return f + ' ' + str(p.value || '（无）') + '←' + (p.fromLabel || '—') + (p.why ? ('（' + p.why + '）') : '');
    };
    const fields = ['date', 'time', 'location', 'present'];
    const applied = (t.applied && t.applied.fields) || [];
    const changed = applied.filter((x) => x.changed).map((x) => x.field);
    return '🕒 取值 [' + t.stage + '] ' + (t.text && t.text.mode ? ('正文=' + t.text.mode + (t.text.floors ? ('(' + t.text.floors + ')') : '') + ' · ') : '')
        + fields.map(partOf).filter(Boolean).join(' · ')
        + (t.degrade && t.degrade.degraded ? (' · ⚠️降级：' + (t.degrade.reasonLabel || t.degrade.reason)) : '')
        + (changed.length ? (' · 落盘改动：' + changed.join('/')) : ' · 落盘：无改动')
        + (t.applied && t.applied.locked ? ' （手工锁定）' : '');
}

/** 结构化摘要（`FTT.clockTraceSummary()` / 调试面板用；含被放弃候选与来源链） */
export function clockTraceInfo(trace) {
    const t = trace || clockTraceLast();
    if (!t) return null;
    return {
        id: t.id, stage: t.stage, action: t.action, at: t.at,
        text: Object.assign({}, t.text),
        chain: t.chain.slice(),
        picks: Object.keys(t.picks).map((f) => Object.assign({ field: f }, t.picks[f])),
        rejects: t.rejects.map((r) => Object.assign({}, r)),
        degrade: Object.assign({}, t.degrade),
        applied: {
            fields: (t.applied.fields || []).map((x) => Object.assign({}, x)),
            locked: !!t.applied.locked,
            unchanged: (t.applied.unchanged || []).slice(),
            present: t.applied.present,
        },
        notes: t.notes.slice(),
        summary: clockTraceSummary(t),
    };
}
