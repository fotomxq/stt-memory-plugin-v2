// ============================================================
// 单元测试 · v3.45.1「读取台账未命中口径唯一」（`docs/D22` §4.7 W6 `技-34` · 台账 U174）
//
// 真机事实（`docs/D29` §2 第 5 行 / `docs/D13` §… 第 5 行）：
//   `ftt.reads.stats = {miss: 1}`，而同一次会话的文本台账里明确有 **≥ 2 条**
//   `通道读取失败 … reason: "miss"` —— 读数与台账互相打架：
//   用 `miss` 判断「本机层是否可用」会得到**相反结论**。
// 根因（`docs/D29` §8 `技-34`）：旧计数把「是否成功」与「是否未命中」当两个独立维度 ——
//   `if (item.ok) s.ok++; else s.fail++;` 之后**无条件** `if (item.miss) s.miss++;`，
//   于是 `{ok:false, miss:true}` 这条如实标记的未命中**同时**进了 `fail` 与 `miss`。
//
// 本文件把「三桶互斥」钉成回归，并给出**反向探针**：
//   A1 就是判据 —— 把修复回退成旧写法时该断言必须失败（把 `readLedgerRecord` 的入桶恢复成
//   `if (ok) … else fail++` + 无条件 `if (miss) miss++`，A1 立即红）。
// 运行：node tests/unit/read-ledger-miss.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import {
    READ_LEDGER_CAP, readLedgerBucket, setReadLedgerHooks, readLedgerRecord,
    readLedgerList, readLedgerStats, readLedgerLine, readLedgerLines,
    readLedgerSummaryText, resetReadLedger,
} from '../../core/read-ledger.js';

const R = makeReporter('read-ledger-miss v3.45.1 读取台账未命中口径唯一（技-34 / U174）');
const J = (v) => JSON.stringify(v);

// 受控时钟（台账内所有时间都经 `hooks.now` → 断言与机器时间无关）
let clock = 1700000000000;
setReadLedgerHooks({ now: () => clock, log: () => undefined });
resetReadLedger();

// ---------- A 组：三桶互斥（**反向探针** = A1） ----------
{
    resetReadLedger();
    // 真机里那两条「通道读取失败 … reason: "miss"」的等价记录：如实标记未命中，且 ok=false
    const recA = readLedgerRecord({ action: '通道读取失败', src: 'local', target: 'ftt2_state_char1.json', ms: 5, ok: false, miss: true, reason: 'miss' });
    clock += 7;   // 总耗时 12ms，供 A5 断言平均耗时的分母
    const recB = readLedgerRecord({ action: '通道读取失败', src: 'local', target: 'ftt2-meta-char1.json', ms: 7, ok: false, miss: true, reason: 'miss' });
    const st = readLedgerStats();
    const lo = st.bySrc.local;
    R.assert('A1 **反向探针**：`reason="miss"`（`miss === true`）的记录只进 `miss` 桶 —— `miss === 2` 且 `fail === 0`、`ok === 0`；'
        + '逐来源同样只进 `miss`（回退成旧写法「先计 fail、再无条件计 miss」时本断言必须失败）',
        !!recA && !!recB && recA.miss === true && recB.miss === true
        && st.miss === 2 && st.fail === 0 && st.ok === 0 && st.totalReads === 2
        && !!lo && lo.miss === 2 && lo.fail === 0 && lo.ok === 0 && lo.n === 2,
        J({ miss: st.miss, fail: st.fail, ok: st.ok, local: lo }));

    // ① 的完整判据：任何一条记录都**恰好**贡献 1 个桶（三桶之和 == 记录数）
    R.assert('A2 口径自洽：`ok + fail + miss === totalReads`（含 `miss === true` 的记录在内，每条记录恰好贡献 1 个桶）',
        (st.ok + st.fail + st.miss) === st.totalReads && st.totalReads === 2,
        J({ ok: st.ok, fail: st.fail, miss: st.miss, total: st.totalReads }));
}

// ---------- B 组：`miss` 计入**所有**如实标记未命中的记录 ----------
{
    resetReadLedger();
    // 真机里未命中的三种如实标记：读不到本机缓冲 / 按预算跳过写入 / 聊天里没有本插件数据
    readLedgerRecord({ action: '读本机缓冲', src: 'local', ms: 1, ok: true, miss: true, reason: 'no-local-buffer' });
    readLedgerRecord({ action: '写本机缓冲', src: 'local', ms: 1, ok: false, miss: true, bytes: 900, reason: 'over-budget', note: '超过字符预算且压缩未能解决 → 跳过' });
    readLedgerRecord({ action: '读聊天元数据', src: 'chatmeta', ms: 2, miss: true, reason: 'no-meta-data' });
    // 一条真失败（**没有** miss 标记）与一条常规成功，用于证明修复没有把 fail/ok 一并吞掉
    readLedgerRecord({ action: '读分片', src: 'shard', ms: 9, ok: false, reason: 'hash-mismatch' });
    readLedgerRecord({ action: '读主文件', src: 'file', ms: 3, ok: true, bytes: 1024 });
    const st = readLedgerStats();
    R.assert('B1 `stats.miss` 计入**所有** `reason=miss` 的记录（含 `ok:true` 的「本机缓冲为空」与 `ok:false` 的「按预算跳过写入」）：'
        + 'miss === 3，且这些记录一个都没进 `fail`；真正的失败（hash-mismatch）仍进 `fail === 1`，成功仍进 `ok === 1`',
        st.miss === 3 && st.fail === 1 && st.ok === 1 && st.totalReads === 5
        && st.bySrc.local.miss === 2 && st.bySrc.local.fail === 0
        && st.bySrc.chatmeta.miss === 1 && st.bySrc.chatmeta.fail === 0
        && st.bySrc.shard.fail === 1 && st.bySrc.shard.miss === 0
        && st.bySrc.file.ok === 1,
        J({ miss: st.miss, fail: st.fail, ok: st.ok, local: st.bySrc.local, shard: st.bySrc.shard, chatmeta: st.bySrc.chatmeta }));

    R.assert('B2 `readLedgerBucket`（入桶判定纯函数）= 唯一口径：miss 优先于 fail，其余失败进 fail，正常进 ok（文本台账与统计都调它，杜绝两套口径）',
        readLedgerBucket({ ok: false, miss: true }) === 'miss'
        && readLedgerBucket({ ok: true, miss: true }) === 'miss'
        && readLedgerBucket({ ok: false }) === 'fail'
        && readLedgerBucket({ ok: true }) === 'ok'
        && readLedgerBucket({}) === 'ok'
        && readLedgerBucket(null) === 'ok',
        J([{ ok: false, miss: true }, { ok: false }, { ok: true }].map(readLedgerBucket)));
}

// ---------- C 组：文本台账一行里必须有**原因类别** ----------
{
    resetReadLedger();
    readLedgerRecord({ action: '通道读取失败', src: 'local', target: 'ftt2_state_char1.json', ms: 5, ok: false, miss: true, reason: 'miss' });
    readLedgerRecord({ action: '通道读取失败', src: 'file', target: 'ftt2-shard-x.json', ms: 4, ok: false, miss: true });   // 未记 reason
    readLedgerRecord({ action: '通道读取失败', src: 'shard', ms: 6, ok: false, reason: 'hash-mismatch' });
    readLedgerRecord({ action: '通道读取失败', src: 'file', ms: 6, ok: false });                                           // 未记 reason
    const lines = readLedgerLines(10);
    const text = readLedgerSummaryText(10);
    R.assert('C1 文本台账每行都写清「为什么不算成功」：有 `reason` 用原值（`原因：miss`），没有时按桶名兜底（`原因：未命中（未记原因）` / `原因：失败（未记原因）`）——'
        + '复用既有 `原因：` 字段与格式，不新增格式；结果词与统计桶同源（`未命中` / `失败`）',
        lines[3].indexOf('原因：miss') > 0 && lines[3].indexOf('未命中') > 0
        && lines[2].indexOf('原因：未命中（未记原因）') > 0
        && lines[1].indexOf('原因：hash-mismatch') > 0 && lines[1].indexOf('失败') > 0
        && lines[0].indexOf('原因：失败（未记原因）') > 0,
        J(lines));

    R.assert('C2 汇总文本的成功 / 失败 / 未命中三数与逐来源读数一致（1 成功 0 · 失败 2 · 未命中 2），调试包与调试页看到的是同一份口径',
        text.indexOf('读取台账：共 4 次') === 0 && text.indexOf('成功 0 / 失败 2 / 未命中 2') > 0
        && text.indexOf('服务端分片：1 次（失败 1 / 未命中 0）') > 0
        && text.indexOf('本机缓冲：1 次（失败 0 / 未命中 1）') > 0,
        text.split('\n').slice(0, 4));
}

// ---------- D 组：返回结构不变（只改「进哪个桶」的语义） ----------
{
    resetReadLedger();
    readLedgerRecord({ action: '读主文件', src: 'file', ms: 6, ok: true, bytes: 2048, items: 3 });
    readLedgerRecord({ action: '通道读取失败', src: 'local', ms: 6, ok: false, miss: true, reason: 'miss' });
    const st = readLedgerStats();
    const keys = Object.keys(st).sort().join(',');
    const srcKeys = Object.keys(st.bySrc.local).sort().join(',');
    R.assert('D1 `readLedgerStats()` 返回结构一字未变（`count/totalReads/ok/fail/miss/totalMs/avgMs/totalBytes/lastAt/cap/bySrc/slowest/recent`；'
        + '逐来源仍是 `n/ok/fail/miss/ms/bytes/items/fields/maxMs/label/avgMs`）—— 别的模块照旧读这些字段',
        keys === 'avgMs,bySrc,cap,count,fail,lastAt,miss,ok,recent,slowest,totalBytes,totalMs,totalReads'.split(',').sort().join(',')
        && srcKeys === 'avgMs,bytes,fail,fields,items,label,maxMs,miss,ms,n,ok'.split(',').sort().join(',')
        && st.cap === READ_LEDGER_CAP && st.count === 2 && st.recent.length === 2 && st.slowest.length === 2,
        J({ keys, srcKeys }));

    // avgMs 分母 = 三桶之和（旧写法在三桶互斥后会漏掉未命中 → 平均耗时被抬高；此处 12ms / 2 条 = 6ms）
    R.assert('D2 平均耗时分母 = 三桶之和（=全部记录）：12ms / 2 条 = 6ms —— 旧写法 `totalMs/(ok+fail)` 会把未命中算成「0 条」而抬高均值',
        st.totalMs === 12 && st.avgMs === 6 && st.bySrc.local.avgMs === 6,
        J({ totalMs: st.totalMs, avgMs: st.avgMs, srcAvg: st.bySrc.local.avgMs }));
}

// ---------- E 组：与既有 reader 口径互不干扰（记录字段与镜像策略不变） ----------
{
    resetReadLedger();
    const logged = [];
    setReadLedgerHooks({ now: () => clock, log: (rec) => logged.push(rec) });
    readLedgerRecord({ action: '通道读取失败', src: 'local', ms: 2, ok: false, miss: true, reason: 'miss' });
    readLedgerRecord({ action: '读主文件', src: 'file', ms: 2, ok: true, bytes: 16 });
    const list = readLedgerList();
    const st = readLedgerStats();
    setReadLedgerHooks({ log: () => undefined });
    R.assert('E1 记录本身与镜像准入不变：`{ok:false, miss:true}` 仍是一条带原因的结构化记录（`ok === false` / `miss === true`），'
        + '仍被镜像进调试日志（异常 / 未命中 / 慢读），而常规成功读取不镜像 —— 本次只改「进哪个桶」',
        list.length === 2 && list[1].ok === false && list[1].miss === true && list[1].reason === 'miss'
        && logged.length === 1 && logged[0].action === '通道读取失败'
        && readLedgerLine(list[0]).indexOf('✓') > 0 && st.ok === 1 && st.miss === 1 && st.fail === 0,
        J({ logged: logged.length, st: { ok: st.ok, fail: st.fail, miss: st.miss } }));
}

resetReadLedger();
R.done();
