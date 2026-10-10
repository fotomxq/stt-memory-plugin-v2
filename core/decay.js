// ============================================================
// core/decay.js —— **时间衰退函数（单一实现）**（`docs/D22` `业-6` / `docs/D18` §4.1 P5）
//
// 定位：原先是 `core/ingest.js` 内的私有件，另有 `core/recall.js` 的**同名私有副本**（`D18` §2 K11）。
//   同一算法两处漂移是明确的缺陷来源（两版对「负数毫秒」的判定不同，见下），故抽成本**叶子模块**：
//   · 只依赖常量，不 import 任何其它 core 模块 → `core/ingest.js` 与 `core/recall.js` 都能安全复用，
//     且不会与 `core/ingest.js#…` ↔ `core/recall.js#…` 之间既有的相互引用形成环；
//   · `core/ingest.js` **再导出** `calcTimeDecay`，使既有的 `core/ingest.js#calcTimeDecay` 引用形态
//     （`docs/D18`/`D20`/`D21` 与 `core/forget.js` / `core/rumor-evolve.js` 的 import）保持不变。
//
// 口径（`docs/D18` §4.1）：
//   · **基准时刻与条目时刻一律由调用方给「剧情时间毫秒」** —— 本函数只做纯计算，不读时钟
//     （`nowAt` 不是有限数值时**直接返回 0**，绝不回落到现实墙钟：调用方必须在无剧情时钟时自行短路）。
//   · **负毫秒（公元前 ~ 1969）是合法时间**，照常参与衰减（B8-5 的有意偏离，见下）。
//   · 阈值、比例、权重、封顶**一律不变**（`docs/D18` §4.1 P4：只改基准，不改强度）。
// ============================================================
const DECAY_MS_HOUR = 3600 * 1000;
const DECAY_MS_DAY = 24 * DECAY_MS_HOUR;
const DECAY_MS_MONTH = 30.44 * DECAY_MS_DAY;
const DECAY_MS_YEAR = 365.25 * DECAY_MS_DAY;

// —— 通用 5 参数多级时间衰退（底层方法，供各大类复用）——
// 入参：earliestAt 大类最早时刻 / latestAt 大类最晚时刻 / nowAt 基准时刻（剧情当下）/
//       itemAt 被判断条目自身时刻 / count 大类条目数；返回衰退值 0..1
export function calcTimeDecay(earliestAt, latestAt, nowAt, itemAt, count) {
    try {
        const now = Number(nowAt);
        if (!Number.isFinite(now)) return 0;                               // 无基准时刻（无剧情时钟）→ 不衰退
        const item = Number(itemAt);
        // B8-5 修正（**有意偏差**，V1 为 `item <= 0`）：剧情日期以 2000 为基准换算，**1970 年之前的剧情日期
        //   得到负毫秒值**，而 V1 的 `item <= 0` 会把它们当成「无时间信息」→ 状态衰退 / 记忆遗忘 / 平行事件衰退
        //   对 19~20 世纪的剧情**整体失效**（用户常见设定恰好是 1919 一类年份）。V1 注释写的是「无时间信息视为新」，
        //   故此处按注释语义只判「非有限数值」；负值（公元前 ~ 1969）是合法时间，正常参与衰减。
        if (!Number.isFinite(item)) return 0;                              // 无时间信息视为新
        const age = Math.max(0, now - item);
        // 1) 多级时间尺度（小时→天→月→年，各占一段权重，1 年以上完全饱和）
        const sHours = Math.min(1, age / DECAY_MS_HOUR);
        const sDays = Math.min(1, age / DECAY_MS_DAY);
        const sMonths = Math.min(1, age / DECAY_MS_MONTH);
        const sYears = Math.min(1, age / DECAY_MS_YEAR);
        const scale = 0.20 * sHours + 0.25 * sDays + 0.30 * sMonths + 0.25 * sYears;   // ≤1
        // 2) 类别跨度相对位置：条目越接近「最早」越老（=1），接近「最新」越新（≈0）
        let relFrac = 0;
        const e = Number(earliestAt), l = Number(latestAt);
        const spanBase = Math.max(1, (Number.isFinite(e) && Number.isFinite(l) ? l : now) - (Number.isFinite(e) ? e : now));
        if (Number.isFinite(e) && now > e) {
            relFrac = Math.min(1, Math.max(0, (now - item) / (now - e)));
            // 条目晚于最新（正在被维护）则相对位置按 0 计（最活跃）
            if (Number.isFinite(l) && item >= l) relFrac = 0;
            relFrac = Math.min(1, Math.max(0, relFrac));
        }
        // 3) 条目拥挤度：同类条目越多，整体越易衰退（+2%/条，封顶 ×1.5）
        const n = Math.max(1, Number(count) || 1);
        const crowd = Math.min(1.5, 1 + 0.02 * (n - 1));
        const base = Math.min(1, 0.55 * scale + 0.45 * relFrac);
        return Math.min(1, Math.max(0, base * crowd));
    } catch (e) { return 0; }
}
