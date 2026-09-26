'use strict';
// ============================================================
// oracle（未摘要楼层跳过机制）：真实 V1 插件 v1.206 + 真实 V2 模块，**同一份合成聊天**上各算一次清单，
//   产出 tests/fixtures/v1-golden-pending-floors.json。
//
// 被测（用户报告）：「未摘要楼层存在问题，很多无法分析或不应该分析的会被展示出来，请核对跳过机制。
//   当**原子数据对应的楼层存在时，则不需要分析**。」
//
// 对照口径（V1 `pendingFloorList(0, getLastMessageId())` vs V2 `listUnprocessedFloors({})`）：
//   V1 = 台账哈希（含 20s 节流的哈希归位对账 + 哈希漂移防呆）+ 非 AI 楼跳过 + 可分析正文判据；
//   V2 = 上述全部（逐条移植）＋ **新增**「该楼已有记忆数据则跳过」（用户要求）＋ 正文额外去 HTML 标签
//        （v2.44.0 起，宿主层 `cleanText`；V1 不去标签，故「正文只有 HTML 标签」的楼 V1 会列出、V2 不列）。
// 因此本 fixture 记录三个清单：
//   · v1             —— V1 原样结果（对照基线）
//   · v2NoCover      —— V2 关闭「已有记忆数据」跳过（只保留移植差异）→ 期望 = v1 去掉「纯 HTML 标签楼」
//   · v2             —— V2 默认（含覆盖跳过）
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致。
// 运行：node tests/fixtures/gen-v1-golden-pending-floors.cjs [输出路径]
// ============================================================
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const V1 = '/home/ubuntu/st/STT记忆插件';
const V2 = path.join(__dirname, '..', '..');
const { makeTavernEnv, loadPlugin } = require(path.join(V1, 'tests/unit/helpers.js'));

console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');
console.error = (...a) => process.stderr.write('ERR: ' + a.join(' ') + '\n');

const OUT = process.argv[2] || path.join(__dirname, 'v1-golden-pending-floors.json');

const imp = (rel) => import(pathToFileURL(path.join(V2, rel)).href);

// 场景表与单测共用（tests/fixtures/pending-floors-scenarios.mjs），避免两侧各写一份而悄悄漂移
let SCENARIOS_FIX = [];
const loadScenarios = async () => {
    const mod = await imp('tests/fixtures/pending-floors-scenarios.mjs');
    SCENARIOS_FIX = mod.SCENARIOS;
};

(async function main() {
    const scenMod = await imp('tests/fixtures/pending-floors-scenarios.mjs');
    const SCENARIOS = scenMod.SCENARIOS;
    const ALL_DIMS = scenMod.ALL_DIMS;

    // ---------- V1 环境（真实插件 v1.206）----------
    const env = makeTavernEnv({ ctx: { getChatMessages: () => [], getLastMessageId: () => -1 } });
    const F = await loadPlugin(env);
    const V1_TAG = String(F.processedVerTag());

    // ---------- V2 模块（真实源码）----------
    const floorsV2 = await imp('host/floors.js');
    const stMock = await imp('tests/harness/st-mock.js');
    const runtimeV2 = await imp('core/model/runtime.js');
    const stateV2 = await imp('core/state.js');
    const coverV2 = await imp('core/floor-cover.js');
    const doc = stMock.makeDocument(['extensions_settings2']);
    const host = stMock.makeHost({});
    stMock.installGlobalHost(host, doc);

    const out = {
        generatedFrom: { v1: 'src/FTT记忆组件-v1.205.js（当前 src 最新版）', v2: 'host/floors.js' },
        v1Tag: V1_TAG,
        documentedDeviations: [
            { id: 'D1', scenario: 'relocate', what: 'V1 只在条数变化时写回归位对账结果 → 顶部插入新楼后旧标记仍指旧楼层号，已分析楼被重复列为未摘要；V2 只要归位结果不同就写回', where: 'host/floors.js#reconcileProcessedFloors' },
            { id: 'D2', scenario: 'html-only', what: 'V2 v2.44.0 起投喂前去除 HTML 标签 → 纯标签正文视为无可分析内容（V1 不列判据不同）', where: 'host/floors.js#floorAnalyzableText' },
            { id: 'D3', scenario: 'covered-by-atoms / covered-by-segments / range-0-0', what: 'V2 v2.64.0 新增「该楼已有记忆数据 → 跳过」（用户要求）；区间 0/0 视为未知、不作证据', where: 'core/floor-cover.js' },
        ],
        scenarios: [],
    };

    for (const sc of SCENARIOS) {
        const lastId = Number(sc.lastId);
        const dims = sc.dims || {};

        // ---- V1：状态与聊天 ----
        env.ctx.getLastMessageId = () => lastId;
        const setChat = (chat) => { env.ctx.getChatMessages = (i) => { const m = chat[Number(i)]; return m ? [m] : []; }; };
        for (const k of ALL_DIMS) F.state[k] = Array.isArray(dims[k]) ? JSON.parse(JSON.stringify(dims[k])) : [];
        F.state.lastKnownFloor = -1;

        if (sc.marksFromPre) {
            setChat(sc.pre);
            F.state.processedFloors = sc.pre.map((_, i) => ({ f: i, h: F.hashFloorText(i) }));
            F.state.processedVer = F.processedVerTag();
        } else {
            setChat(sc.chat);
            F.state.processedFloors = (sc.marks || []).map((m) => ({ f: Number(m.f), h: m.h === null ? F.hashFloorText(Number(m.f)) : String(m.h) }));
            F.state.processedVer = sc.processedVer ? String(sc.processedVer) : F.processedVerTag();
        }
        setChat(sc.chat);
        const endOpt = (sc.endFloorOpt === undefined) ? lastId : Number(sc.endFloorOpt);
        const v1 = F.pendingFloorList(0, endOpt);

        // ---- V2：同状态、同聊天 ----
        const st = stateV2.emptyState();
        for (const k of ALL_DIMS) st[k] = Array.isArray(dims[k]) ? JSON.parse(JSON.stringify(dims[k])) : [];
        if (sc.marksFromPre) {
            host.ctx.chat = sc.pre.map((m) => Object.assign({}, m));
            runtimeV2.setKernelState(st);
            runtimeV2.setLastMessageId(sc.pre.length - 1);
            st.processedFloors = sc.pre.map((_, i) => ({ f: i, h: floorsV2.hashFloorText(i) }));
            st.processedVer = floorsV2.processedVerTag();
        } else {
            host.ctx.chat = sc.chat.map((m) => Object.assign({}, m));
            runtimeV2.setKernelState(st);
            runtimeV2.setLastMessageId(lastId);
            st.processedFloors = (sc.marks || []).map((m) => ({ f: Number(m.f), h: m.h === null ? floorsV2.hashFloorText(Number(m.f)) : String(m.h) }));
            st.processedVer = sc.processedVer ? String(sc.processedVer) : floorsV2.processedVerTag();
        }
        host.ctx.chat = sc.chat.map((m) => Object.assign({}, m));
        runtimeV2.setLastMessageId(lastId);
        st.lastKnownFloor = -1;
        const scanOpt = (sc.endFloorOpt === undefined) ? {} : { endFloor: Number(sc.endFloorOpt) };
        const v2NoCover = floorsV2.listUnprocessedFloors(Object.assign({ ignoreCovered: true }, scanOpt));
        const v2 = floorsV2.listUnprocessedFloors(Object.assign({}, scanOpt));
        const cov = coverV2.floorCoverage(st);

        const onlyV1 = v1.filter((f) => v2NoCover.indexOf(f) < 0);
        const onlyV2 = v2NoCover.filter((f) => v1.indexOf(f) < 0);
        const coveredSkipped = v2NoCover.filter((f) => v2.indexOf(f) < 0);
        out.scenarios.push({
            name: sc.name,
            note: sc.note,
            lastId: lastId,
            endFloorOpt: (sc.endFloorOpt === undefined ? null : Number(sc.endFloorOpt)),
            floors: sc.chat.length,
            v1MarksAfter: (F.state.processedFloors || []).map((m) => Number(m.f)).sort((a, b) => a - b),
            v2MarksAfter: (st.processedFloors || []).map((m) => Number(m.f)).sort((a, b) => a - b),
            coverageRanges: cov.ranges,
            coverageFloors: cov.floors,
            v1: v1,
            v2NoCover: v2NoCover,
            v2: v2,
            onlyV1: onlyV1,
            onlyV2: onlyV2,
            coveredSkipped: coveredSkipped,
            expect: sc.expect || {},
            deviation: String(sc.deviation || ''),
        });
    }

    const json = JSON.stringify(out, null, 1) + '\n';
    if (OUT) fs.writeFileSync(OUT, json);
    process.stdout.write(json);
    process.exit(0);
})().catch((e) => { process.stderr.write('ERR: ' + (e && e.stack || e) + '\n'); process.exit(1); });
