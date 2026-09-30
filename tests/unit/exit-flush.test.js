// ============================================================
// 单元测试 · v3.0.18「退出/切后台前落一次盘」+「未走内核钩子的改动也必须落盘」
//
// 用户报告（原话）：「新版本 前期修复的关于存储异常、重开应用后存档丢失问题，再次出现。
//   请核对你中间版本是否把bug再次复原了。核对并再次修复该错误问题。」
//
// 背景（v3.0.15 引入、v3.0.18 修的回归）：
//   v3.0.15 为了减少卡顿加了「数据无变化 → 保存短路」，判据只信**内核 `saveState()` 钩子**打的时间戳
//   （`touchSeq`）—— 等于假设「所有会改数据的地方都记得调 `saveState()`」。但确实存在**不调**的路径
//   （最典型：面板「删除快照」`ui/snapshots.js#snapDelete` 直接改 `state.snapStore`），
//   这类改动在窗口内被短路掉 → 只活在内存里 → **重开应用/刷新页面就丢**。
//   v3.0.18 改为**内容签名**判据（与上次成功上传的内容逐字节比对），并补上退出/切后台的落盘钩子。
//
// 运行：node tests/unit/exit-flush.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';

const R = makeReporter('exit-flush v3.0.18 存档不丢：内容签名短路 + 退出前落盘');

// ---------- 桩宿主（doc/window 都要能挂监听，才能验证「切后台/关闭前落盘」）----------
const doc = makeDocument(['ftt-panel', 'extensions_settings2', 'ftt_v2_settings']);
const dl = { doc: {}, win: {} };
const addL = (bag) => (t, fn) => { (bag[t] = bag[t] || []).push(fn); };
const remL = (bag) => (t, fn) => { const a = bag[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
doc.addEventListener = addL(dl.doc);
doc.removeEventListener = remL(dl.doc);
doc.visibilityState = 'visible';
const winStub = { addEventListener: addL(dl.win), removeEventListener: remL(dl.win) };
globalThis.window = winStub;

const host = makeHost({ chat: [{ is_user: true, mes: '你好' }, { is_user: false, mes: '甲在码头清点铜箱。' }] });
const unHost = installGlobalHost(host, doc);
// `installGlobalHost` 会把 `globalThis.window` 换成它自己的桩（没有 addEventListener）→ 这里装回带监听的窗
globalThis.window = winStub;
let uploads = 0;
const unFetch = installGlobalFetch((url) => {
    if (String(url) === '/api/files/upload') uploads += 1;
    return { status: 200, text: 'ok' };
});

const entry = await import('../../index.js');
const RT = await import('../../core/model/runtime.js');
const ST = await import('../../adapters/store.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fire = (bag, type) => { for (const fn of (bag[type] || []).slice()) { try { fn(); } catch (e) { /* 忽略 */ } } };

R.assert('E0 装配就绪（宿主 + 内核状态 + 退出落盘监听已挂上）',
    typeof entry.runtimeState === 'function' && RT.state && (dl.doc.visibilitychange || []).length === 1
    && (dl.win.pagehide || []).length === 1 && (dl.win.beforeunload || []).length === 1,
    { doc: Object.keys(dl.doc), win: Object.keys(dl.win) });

// ① 未走内核钩子的改动（模拟 `ui/snapshots.js#snapDelete` 这类直改）→ 下一次保存**必须**真落盘
{
    RT.state.snapStore = [{ id: 'sig-base', at: 1, items: [] }];
    ST.markDataTouched();
    await ST.saveStateNow({ reason: '基准', force: true });      // 先建立「已上传内容」基线
    const up0 = uploads;

    // 直改内存，**不**调用 saveState()/persistNow()（正是 v3.0.15 短路会吞掉的情形）
    RT.state.snapStore = [{ id: 'sig-direct-change', at: 2, items: [] }];
    const up1 = uploads;
    const r = await ST.saveStateNow({ reason: '直改后保存' });
    const up2 = uploads;
    R.assert('E1 回归：**没有走内核 `saveState()` 钩子**的改动（直接改 `state.snapStore`）也会被内容签名识别 → 下一次保存**真的落盘**（不再被「无变化」短路吞掉，重开应用不会再丢）',
        up1 === up0 && r.skipped !== 'no-change' && r.ok === true && up2 > up1 && String(r.via).indexOf('file') >= 0,
        { up0, up1, up2, r });

    const up3 = uploads;
    const r2 = await ST.saveStateNow({ reason: '内容确实没变' });
    const up4 = uploads;
    R.assert('E2 内容**逐字节未变**时仍照旧短路（`skipped:no-change`，不再上传、不再建信封/编码）——性能优化保留，但判据换成了内容签名（安全性由 E1 保证）',
        r2.ok === true && r2.skipped === 'no-change' && up4 === up3, { up3, up4, r2 });
}

// ② 退出/切后台：`visibilitychange(hidden)` / `pagehide` 各触发一次立即落盘（防抖窗口内的改动不丢）
{
    RT.state.snapStore = [{ id: 'sig-exit-change', at: 3, items: [] }];
    const up0 = uploads;
    doc.visibilityState = 'hidden';
    fire(dl.doc, 'visibilitychange');
    await sleep(60);
    const up1 = uploads;
    R.assert('E3 应用切到后台（`visibilitychange` → hidden）→ **立即落盘**：防抖窗口里的改动当场写盘（本机缓冲 + 服务端文件），不再等 800ms/3s 防抖',
        up1 > up0, { up0, up1 });

    // 关闭/离开页面同样触发：**退出前的落盘是「强制完整保存」**（最后一次写主文件的机会）——
    //   无变化时只补写主文件（提交点）1 次，**分片一个都不重传**（它们靠内容哈希判定）；有变化时当场写盘。
    const up2 = uploads;
    fire(dl.win, 'pagehide');
    await sleep(60);
    const up3 = uploads;
    RT.state.snapStore = [{ id: 'sig-exit-change-2', at: 4, items: [] }];
    fire(dl.win, 'beforeunload');
    await sleep(60);
    const up4 = uploads;
    const okE4 = up3 === up2 + 1 && up4 > up3;
    if (!okE4) console.log('E4-DEBUG ' + JSON.stringify({ up2: up2, up3: up3, up4: up4 }));
    R.assert('E4 `pagehide` / `beforeunload` 同样落盘：无变化时只补写主文件（提交点）1 次、分片不重传（增量）；有变化时当场写盘',
        okE4, { up2, up3, up4 });
}

// ③ teardown 解绑（解绑后不再触发落盘）
{
    try { entry.teardown(); } catch (e) { /* 忽略 */ }
    const nDoc = (dl.doc.visibilitychange || []).length;
    const nWin = (dl.win.pagehide || []).length;
    RT.state.snapStore = [{ id: 'sig-after-teardown', at: 5, items: [] }];
    const up0 = uploads;
    doc.visibilityState = 'hidden';
    fire(dl.doc, 'visibilitychange');
    fire(dl.win, 'pagehide');
    await sleep(60);
    R.assert('E5 `teardown()` 解绑退出落盘监听（切后台/关闭不再触发保存；监听数组清空）',
        nDoc === 0 && nWin === 0 && uploads === up0, { nDoc, nWin, up0, up: uploads });
}

unFetch();
unHost();
delete globalThis.window;
R.done();
