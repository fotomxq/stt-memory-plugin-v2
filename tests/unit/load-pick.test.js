// ============================================================
// 单元测试 · v3.0.11「载入择优」：本机缓冲（localStorage）vs 服务端文件（原生存储 / 酒馆文件）
//
// 真机根因（2026-09 实测，桥接只读取证）：
//   · 本机缓冲 `ftt2_state_char:1xbib3t` = 71243B / **v2.84.0** / 台账 **0 条** / `hashOk:true`；
//   · 服务端文件 = 202674B / v2.75.0 / 台账 11 条（原生里另有更新的一份）；
//   · 旧实现「**第一个有货的就用**」→ 先读本机缓冲且它非空 → 直接采用，**从不比较 `updatedAt`**。
//     于是那份很旧、台账还空的缓冲把更新得多的服务端文件永久遮蔽：每次刷新/重载后，
//     已经分析过的楼层成片变回「未摘要」。用户侧的观感是「**数据丢了**」（实际只是台账记账被旧副本盖住）。
//
// 本批修法：两个源**都读**，按 `updatedAt` 取新；相等（含都为 0）时以服务端文件为准（权威大对象）；
//   只有一个时用那个。本文件既测纯函数（边界/取舍），也测 `loadMemoryState()` 的接线是否真的按择优落地。
//
// 运行：node tests/unit/load-pick.test.js
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost, installGlobalFetch } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { setStorageHooks } from '../../adapters/store.js';
import { stateFileName } from '../../adapters/user-file.js';
import { setKernelState, setScopeKey, kernelState } from '../../core/model/runtime.js';
import { emptyState, scopeId } from '../../core/state.js';
import { pickNewerState, loadMemoryState } from '../../index.js';

const R = makeReporter('load-pick v3.0.11 载入择优（本机缓冲 vs 服务端文件）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [] });
host.ctx.characters = [{ name: '择优测试', avatar: 'pick.png' }];
host.ctx.characterId = 0;
host.ctx.name2 = '择优测试';
setContextProvider(() => host.ctx);
const unHost = installGlobalHost(host, doc);

/** 造一个最小可用 state（只关心 updatedAt 与台账条数） */
function mkSt(updatedAt, marks, tag) {
    const st = emptyState();
    st.updatedAt = updatedAt;
    st.processedFloors = [];
    for (let i = 1; i <= marks; i++) st.processedFloors.push({ f: i * 2, h: 'h' + i });
    st.state = Object.assign({}, st.state, { date: '1919-11-29', location: String(tag || '') });
    return st;
}
/** 服务端文件信封（不写 hash：本文件只验证**择优**口径，哈希校验另有测试覆盖） */
const envelope = (st) => JSON.stringify({ payload: { data: st } });

let localRaw = null;
let fileBody = null;
setStorageHooks({
    getItem: (k) => (k === 'ftt2_state_' + scopeId() ? localRaw : null),
    setItem: () => undefined,
    removeItem: () => undefined,
});
const unFetch = installGlobalFetch(async (url) => {
    const want = '/user/files/' + encodeURIComponent(stateFileName(scopeId()));
    if (String(url) === want) {
        if (fileBody === null) return { status: 404, text: 'not found' };
        return { status: 200, text: fileBody };
    }
    return { status: 404, text: '' };
});

(async function main() {
    setScopeKey('pick-target');
    // 注意：`loadMemoryState()` 内的 `wireKernelChatHooks()` 会按宿主角色重定作用域，
    //   故本地缓冲键与文件名的桩都写成**动态** `scopeId()`，断言里也一律现取。
    void scopeId();

    // ---------------- A 纯函数：取舍与边界 ----------------
    console.log('\n[A1] pickNewerState 纯函数');
    {
        const older = mkSt(1000, 0, 'old');
        const newer = mkSt(2000, 12, 'new');
        A('A1 文件更新 → 取文件', pickNewerState(older, newer).via === 'file'
            && pickNewerState(older, newer).reason === 'file-newer'
            && pickNewerState(older, newer).st.updatedAt === 2000);
        A('A1 本机缓冲更新 → 取本机缓冲', pickNewerState(newer, older).via === 'local'
            && pickNewerState(newer, older).reason === 'local-newer'
            && pickNewerState(newer, older).st.updatedAt === 2000);
        A('A1 时间戳相等 → 以服务端文件为准（权威大对象）',
            pickNewerState(mkSt(500, 3), mkSt(500, 9)).via === 'file'
            && pickNewerState(mkSt(500, 3), mkSt(500, 9)).reason === 'tie-file');
        A('A1 两者都为 0（V1 旧数据无 updatedAt）→ 仍取服务端文件',
            pickNewerState(mkSt(0, 0), mkSt(0, 11)).via === 'file'
            && pickNewerState(mkSt(0, 0), mkSt(0, 11)).st.processedFloors.length === 11);
        A('A1 只有本机缓冲 → 取本机缓冲（`only-local`）',
            pickNewerState(mkSt(700, 2), null).via === 'local'
            && pickNewerState(mkSt(700, 2), null).reason === 'only-local');
        A('A1 只有服务端文件 → 取文件（`only-file`）',
            pickNewerState(null, mkSt(700, 2)).via === 'file'
            && pickNewerState(null, mkSt(700, 2)).reason === 'only-file');
        A('A1 两个源都空 → `new`（空容器起步，不抛错）',
            pickNewerState(null, null).via === 'new' && pickNewerState(null, null).st === null
            && pickNewerState(undefined, undefined).reason === 'none');
        A('A1 非对象（脏数据）按「无」处理，不吃异常',
            pickNewerState('x', 42).via === 'new' && pickNewerState({}, null).via === 'local');
        A('A1 返回两个时间戳便于调试留痕（`atLocal` / `atFile`）', (() => {
            const p = pickNewerState(mkSt(11, 1), mkSt(22, 1));
            return p.atLocal === 11 && p.atFile === 22 && typeof p.reason === 'string';
        })());
    }

    // ---------------- B 接线：陈旧本机缓冲不再遮蔽新文件 ----------------
    console.log('\n[B1] loadMemoryState 接线：陈旧本机缓冲（0 条台账）不得遮蔽更新的服务端文件（12 条）');
    {
        // 真机同款形态：本机缓冲**很旧**且**台账为空**（信封自洽，所以旧实现在哈希校验处不会丢弃它）
        localRaw = envelope(mkSt(1000, 0, 'stale-local'));
        fileBody = envelope(mkSt(2000, 12, 'fresh-file'));
        const r = await loadMemoryState();
        A('B1 择优来源 = 服务端文件（不再「第一个有货就用」）', r.via === 'file', J(r));
        A('B1 内核态取到文件的 12 条台账（刷新后不再成片变回未摘要）',
            Array.isArray(kernelState().processedFloors) && kernelState().processedFloors.length === 12,
            'marks=' + ((kernelState().processedFloors || []).length));
        A('B1 无服务端文件时回落到本机缓冲（不丢本机数据）', await (async () => {
            fileBody = null;
            const r2 = await loadMemoryState();
            return r2.via === 'local' && kernelState().processedFloors.length === 0;
        })());
    }

    // ---------------- C 反向：本机缓冲更新时以它为准 ----------------
    console.log('\n[C1] loadMemoryState 接线：本机缓冲更新（未同步的本地改动）→ 以本机缓冲为准');
    {
        localRaw = envelope(mkSt(3000, 5, 'fresh-local'));
        fileBody = envelope(mkSt(2000, 12, 'older-file'));
        const r = await loadMemoryState();
        A('C1 择优来源 = 本机缓冲', r.via === 'local', J(r));
        A('C1 内核态取到本机缓冲的 5 条台账（不拿旧文件覆盖较新的本地改动）',
            kernelState().processedFloors.length === 5, 'marks=' + kernelState().processedFloors.length);
    }

    // ---------------- D 双源都空 → 空容器起步（不抛错、不崩） ----------------
    console.log('\n[D1] loadMemoryState：两个源都没有 → 空容器起步（绝不抛错）');
    {
        localRaw = null;
        fileBody = null;
        const r = await loadMemoryState();
        A('D1 来源标记 = new，内核态为空容器且可用',
            r.via === 'new' && Array.isArray(kernelState().processedFloors)
            && kernelState().processedFloors.length === 0 && r.scope === scopeId(), J(r));
    }

    // ---------------- E 脏数据不阻塞载入（哈希不符 / 非 JSON / 无 payload） ----------------
    console.log('\n[E1] 脏数据：坏信封一律当「无」，不影响另一源与启动');
    {
        localRaw = '{ not json';
        fileBody = envelope(mkSt(2000, 7, 'ok'));
        const r = await loadMemoryState();
        A('E1 本机缓冲是坏 JSON → 丢弃它，用服务端文件（载入不失败）',
            r.via === 'file' && kernelState().processedFloors.length === 7, J(r));
        localRaw = JSON.stringify({ payload: { data: mkSt(9, 3, 'h') }, hash: 'deadbeef' });
        fileBody = envelope(mkSt(2000, 7, 'ok'));
        const r2 = await loadMemoryState();
        A('E1 本机缓冲哈希不符 → 丢弃它，仍用服务端文件',
            r2.via === 'file' && kernelState().processedFloors.length === 7, J(r2));
        localRaw = envelope(mkSt(4000, 4, 'newer-but-broken-file'));
        fileBody = 'not-json-at-all';
        const r3 = await loadMemoryState();
        A('E1 服务端文件解析失败 → 回落到可用的本机缓冲',
            r3.via === 'local' && kernelState().processedFloors.length === 4, J(r3));
    }

    unFetch();
    unHost();
    R.done();
})().catch((e) => { console.error('❌ load-pick.test.js 异常中断:', e); process.exit(1); });
