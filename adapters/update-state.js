// ============================================================
// adapters/update-state.js —— 更新检查状态持久化（存在 extensionSettings 内，随设定同步）
// 字段：firstRunAt / startupCheckedAt / lastCheckAt / lastResult
//
// v3.45.1（`docs/D22` §4.7 W6 `应-22`，台账 U178）：本模块同时是**显示判定口径**的唯一落点 ——
//   关于页与「有更新」高亮都必须经 `judgeUpdateState` 取结论，不得各自解释 `lastResult`。
// ============================================================
import { MODULE_NAME, VERSION, DEFAULT_UPDATE_INTERVAL_HOURS } from '../core/constants.js';
import { getCtx } from '../host/st-api.js';
import { compareVersions } from '../core/update.js';
import { saveSettings } from './settings.js';

function bucket() {
    const ctx = getCtx();
    if (!ctx || !ctx.extensionSettings || typeof ctx.extensionSettings !== 'object') return null;
    const root = ctx.extensionSettings[MODULE_NAME] || (ctx.extensionSettings[MODULE_NAME] = {});
    if (!root.update || typeof root.update !== 'object') root.update = {};
    return root.update;
}

/** 读取更新状态（无宿主时返回内存兜底对象，不抛异常） */
export function readUpdateState() {
    const b = bucket();
    if (!b) return { firstRunAt: 0, startupCheckedAt: 0, lastCheckAt: 0, lastResult: null };
    return {
        firstRunAt: Number(b.firstRunAt) || 0,
        startupCheckedAt: Number(b.startupCheckedAt) || 0,
        lastCheckAt: Number(b.lastCheckAt) || 0,
        lastResult: b.lastResult || null,
    };
}

/**
 * 一次更新检查结论的**有效期**（毫秒）——与「自动检查间隔」同源（默认 24h）。
 *
 * 为什么用检查间隔而不是另定常量：真机事实正是「界面一直显示有新版本，**直到下一次 24h 检查**」
 *   （`docs/D29` §2 第 9 行）——超过一个检查周期仍被当作**当前结论**，就是本项要修的口径；
 *   另定一个魔法窗口只会让「有效期」与「多久查一次」两个口径再次分叉。
 */
export const UPDATE_RESULT_STALE_MS = (() => {
    const h = Number(DEFAULT_UPDATE_INTERVAL_HOURS) > 0 ? Number(DEFAULT_UPDATE_INTERVAL_HOURS) : 24;
    return h * 60 * 60 * 1000;
})();

/**
 * 判定「持久化的更新检查结果」**现在**该怎么显示（纯函数；`state` / `opts` 可注入 → 单测可精确构造状态）。
 *
 * 真机事实（`docs/D29` §2 第 9 行）：`update.state.lastResult = {current:"3.40.0", remote:"3.40.1",
 *   status:"newer"}`、`hasUpdate true`，而运行版本已是 **3.40.6** —— 界面在版本已最新时仍显示
 *   「有新版本」。
 * 口径（`docs/D29` §8 `应-22`）：
 *   ① 「是否真的更新」一律用**当前运行版本**与 `lastResult.remote` 比较（版本比较器复用
 *      `core/update.js#compareVersions`，本模块不另写第二套 —— 两套版本比较正是本项的病根）；
 *   ② `lastResult.current` 与当前运行版本不一致（= 记录产生于旧版本），或记录已超过
 *      `UPDATE_RESULT_STALE_MS` → 判**陈旧**（`status:'stale'`）：不显示「有新版本」，
 *      由调用方显示「已过期（时间）」并保留原始记录（只读）。
 * 被否决的替代方案：照旧只看 `lastResult.status === 'newer'` —— 那个 `status` 是**记录产生时**的结论，
 *   版本升级后它永远停在旧值，界面就会长期说假话；用 `Date.now()` 当检查时间同样被否决
 *   （见 `at` 的兜底注释）。
 * @param {{lastResult?:object, lastCheckAt?:number}} [state] 缺省读宿主持久化状态
 * @param {{now?:number, version?:string}} [opts] 测试注入点（`now` / 运行版本）
 * @returns {{status:'none'|'stale'|'error'|'newer'|'same'|'older'|'unknown', stale:boolean, at:number,
 *            atKnown:boolean, current:string, remote:string, error:string, commitOnly:boolean}}
 */
export function judgeUpdateState(state, opts) {
    const o = opts || {};
    const empty = { status: 'none', stale: false, at: 0, atKnown: false, current: '', remote: '', error: '', commitOnly: false };
    try {
        const st = state || readUpdateState();
        const r = (st && st.lastResult) || null;
        if (!r) return empty;
        const now = Number(o.now) || Date.now();
        const ver = String(o.version || VERSION);
        const j = (r.judge && typeof r.judge === 'object') ? r.judge : null;
        const cur = String(r.current != null && r.current !== '' ? r.current : ((j && j.current) || ''));
        const remote = String(r.remote != null && r.remote !== '' ? r.remote : ((j && j.remote) || ''));
        const commitOnly = !!(r.commitOnly || (j && j.commitOnly));
        // 时间：优先 `lastResult.at`（`summarizeCheck` 写入的检查时刻）；**缺字段时兜底用同一状态里的
        //   `lastCheckAt`**（同一次检查写入的另一处时间），仍取不到就如实说「时间未知」——
        //   绝不用 `Date.now()` 冒充，否则「多久以前查的」会永远显示成刚刚查的。
        const at = Number(r.at) || Number(st && st.lastCheckAt) || 0;
        const base = { status: 'unknown', stale: false, at: at, atKnown: at > 0, current: cur, remote: remote, error: String(r.error || ''), commitOnly: commitOnly };
        // ② 陈旧判定：记录里的本机版本已不是当前运行版本，或记录超过一个检查周期
        const versionStale = !!cur && cur !== ver;
        const timeStale = at > 0 && (now - at) > UPDATE_RESULT_STALE_MS;
        if (versionStale || timeStale) return Object.assign(base, { status: 'stale', stale: true });
        if (r.ok === false) return Object.assign(base, { status: 'error' });
        // ① git 真值优先：端点说「同版本新提交」时，版本号比较判不出差异，仍算有更新
        if (commitOnly) return Object.assign(base, { status: 'newer' });
        const c = compareVersions(ver, remote);
        if (c === null) {
            // 版本号判不出（远端没给可解析的版本号）→ 回退记录里的当时结论 / git 真值，
            //   与 `host/update.js#updateStatusText` 的兜底同源，避免一处说「有更新」另一处说「判不出」
            const was = String(r.status || (j && j.status) || '');
            if (was === 'newer' || was === 'same' || was === 'older') return Object.assign(base, { status: was });
            if (r.isUpToDate === true) return Object.assign(base, { status: 'same' });
            if (r.isUpToDate === false) return Object.assign(base, { status: 'newer' });
            return base;
        }
        if (c < 0) return Object.assign(base, { status: 'newer' });     // 远端更高 → 才有「新版本」
        if (c > 0) return Object.assign(base, { status: 'older' });     // 本机更高（开发版）
        return Object.assign(base, { status: 'same' });                 // 本地 ≥ 远端 → 不再说「有新版本」
    } catch (e) { return empty; }
}

/** 写入部分字段并保存 */
export function writeUpdateState(patch) {
    const b = bucket();
    const p = patch || {};
    if (!b) return false;
    for (const k of Object.keys(p)) b[k] = p[k];
    saveSettings();
    return true;
}

/** 首次运行标记（幂等：已有 firstRunAt 则原样返回） */
export function ensureFirstRun(now) {
    const st = readUpdateState();
    if (st.firstRunAt) return st.firstRunAt;
    const at = Number(now) || Date.now();
    writeUpdateState({ firstRunAt: at });
    return at;
}
