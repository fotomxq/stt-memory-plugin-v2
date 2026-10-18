// ============================================================
// 单元测试 · v3.50.18：传言列表排序
//   用户原话：「传言按照发酵度排序，发酵最高的排在前面；如果发酵度相同，则按照发生日期排列，最近发生的靠前。」
//
// 口径（`core/rumor-sort.js`）：发酵度降序 → 同度按**发生日期**降序（最近在前，复用 `sortRecentByStoryDate`
//   的日期口径：剧情日期 → 无日期靠后 → `floorEnd` 倒序）。
//
// 运行：node tests/unit/rumor-sort.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { rumorFermentOf, sortRumorsByFerment } from '../../core/rumor-sort.js';

const R = makeReporter('rumor-sort v3.50.18：传言按发酵度排序（同度看发生日期）');
const A = (n, c, e) => R.assert(n, !!c, (typeof e === 'function') ? e() : e);
const J = (v) => JSON.stringify(v);

const mk = (id, ferment, date, floorEnd) => ({ id: id, subject: id, content: '说法' + id, ferment: ferment, date: date || '', floorEnd: floorEnd === undefined ? 0 : floorEnd });
const ids = (arr) => arr.map((x) => x.id).join(',');

// ---------- A 组：主键（发酵度降序） ----------
A('A1 **发酵度最高在前**：30 / 90 / 60 → `b(90), c(60), a(30)`', (() => {
    const out = sortRumorsByFerment([mk('a', 30, '1919-11-01'), mk('b', 90, '1919-11-02'), mk('c', 60, '1919-11-03')]);
    return ids(out) === 'b,c,a' && out[0].ferment === 90;
})(), () => ids(sortRumorsByFerment([mk('a', 30, ''), mk('b', 90, ''), mk('c', 60, '')])));

A('A2 **缺省/非法发酵度按 20**（与 `normalizeRumor` 归一化口径一致）：高于 25 的在前、低于 19 的在后', (() => {
    const out = sortRumorsByFerment([{ id: 'n', subject: 'n', content: 'x' }, mk('hi', 25, ''), mk('lo', 19, ''), mk('bad', 'abc', '')]);
    const pos = (id) => out.map((x) => x.id).indexOf(id);
    // 20 折成 20：`n` 与 `bad` 都应在 `lo`(19) 之前、`hi`(25) 之后；两者相对次序不判死
    return pos('hi') < pos('n') && pos('n') < pos('lo') && pos('bad') < pos('lo')
        && rumorFermentOf({}) === 20 && rumorFermentOf({ ferment: 'abc' }) === 20
        && rumorFermentOf({ ferment: 200 }) === 100 && rumorFermentOf({ ferment: -5 }) === 0;
})(), () => J(sortRumorsByFerment([{ id: 'n' }, mk('hi', 25, ''), mk('lo', 19, '')]).map((x) => [x.id, rumorFermentOf(x)])));
// ---------- B 组：次键（同发酵度 → 发生日期降序） ----------
A('B1 **发酵度相同 → 最近发生的靠前**：同 50，日期 11-01 / 11-05 / 11-03 → `05, 03, 01`', (() => {
    const out = sortRumorsByFerment([mk('一', 50, '1919-11-01'), mk('五', 50, '1919-11-05'), mk('三', 50, '1919-11-03')]);
    return ids(out) === '五,三,一';
})(), () => ids(sortRumorsByFerment([mk('一', 50, '1919-11-01'), mk('五', 50, '1919-11-05'), mk('三', 50, '1919-11-03')])));

A('B2 **跨年/跨月日期**按真实时间降序（`1919-12-30` 在 `1920-01-02` 之后）：`1920-01-02, 1919-12-30, 1919-02-01`', (() => {
    const out = sortRumorsByFerment([mk('a', 40, '1919-02-01'), mk('b', 40, '1920-01-02'), mk('c', 40, '1919-12-30')]);
    return ids(out) === 'b,c,a';
})(), () => ids(sortRumorsByFerment([mk('a', 40, '1919-02-01'), mk('b', 40, '1920-01-02'), mk('c', 40, '1919-12-30')])));

A('B3 **无日期的排在有日期之后**（沿用既定日期口径），但仍按发酵度归位：`f90(无日期)` 依旧第一位', (() => {
    const out = sortRumorsByFerment([mk('x', 50, '1919-11-05'), mk('y', 50, ''), mk('z', 90, '')]);
    return ids(out) === 'z,x,y';
})(), () => ids(sortRumorsByFerment([mk('x', 50, '1919-11-05'), mk('y', 50, ''), mk('z', 90, '')])));

A('B4 同发酵度且**都无日期** → 退回 `floorEnd` 倒序（最近发生的靠前）', (() => {
    const out = sortRumorsByFerment([mk('p', 60, '', 10), mk('q', 60, '', 30), mk('r', 60, '', 20)]);
    return ids(out) === 'q,r,p';
})(), () => ids(sortRumorsByFerment([mk('p', 60, '', 10), mk('q', 60, '', 30), mk('r', 60, '', 20)])));

// ---------- C 组：不变量（不改入参 / 稳定 / 边界） ----------
A('C1 **不改入参**：返回新数组，原数组顺序与内容不变', (() => {
    const src = [mk('a', 10, '1919-11-01'), mk('b', 90, '1919-11-02')];
    const before = J(src);
    const out = sortRumorsByFerment(src);
    return out !== src && J(src) === before && ids(out) === 'b,a';
})(), 'n/a');

A('C2 稳定：完全同键（同发酵度同日期）时**保持原相对次序**', (() => {
    const out = sortRumorsByFerment([mk('1', 50, '1919-11-01'), mk('2', 50, '1919-11-01'), mk('3', 50, '1919-11-01')]);
    return ids(out) === '1,2,3';
})(), 'n/a');

A('C3 边界：空数组 / 单条 / 非数组 → 安全返回（不抛错、不改入参）', (() => {
    return J(sortRumorsByFerment([])) === '[]'
        && ids(sortRumorsByFerment([mk('only', 50, '')])) === 'only'
        && J(sortRumorsByFerment(null)) === '[]'
        && J(sortRumorsByFerment(undefined)) === '[]';
})(), 'n/a');

A('C4 混合大数据集：发酵度严格降序，且**相邻同度**的日期严格不升（一次性校验两条主键）', (() => {
    const list = [];
    const ferm = [10, 90, 50, 50, 70, 20, 50, 90, 10, 70];
    const dates = ['1919-11-01', '1919-11-02', '1919-11-03', '1919-11-04', '1919-11-05', '1919-11-06', '1919-11-07', '1919-11-08', '1919-11-09', '1919-11-10'];
    for (let i = 0; i < ferm.length; i++) list.push(mk('r' + i, ferm[i], dates[i]));
    const out = sortRumorsByFerment(list);
    let ok = true;
    for (let i = 1; i < out.length; i++) {
        const fa = rumorFermentOf(out[i - 1]), fb = rumorFermentOf(out[i]);
        if (fa < fb) ok = false;                                  // 发酵度必须非升
        if (fa === fb && String(out[i - 1].date) < String(out[i].date)) ok = false;   // 同度时日期必须非降
    }
    return ok && out.length === list.length;
})(), () => ids(sortRumorsByFerment([mk('r0', 10, '1919-11-01'), mk('r1', 90, '1919-11-02')])));

R.done();
