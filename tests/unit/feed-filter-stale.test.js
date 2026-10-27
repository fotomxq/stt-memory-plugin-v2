// ============================================================
// 单元测试 · **投喂白名单与正文格式不匹配时的「整楼/整段被判无正文」**（v3.52.1）
//
// 用户报告（本地调试接口取证）：「当前存档出现过一次更换，更换后数据进行了清理、楼层也进行过一次删除，
//   但是不分析新存档的楼层。最开始只能分析0层，后面就再也无法分析了。」
//
// 真机取证（`ftt.floors` / `ftt.floorDiag` / `ftt.pendingScan` / `ftt.config` / `fft.floors` 同源）：
//   · 投喂白名单 = `["content"]`（**旧存档**的标签名），新存档正文改用 `<q content="…">`（`content` 变成**属性名**）；
//   · `applyFeedRegex` 的「行内包含」兜底把 `<q content="…">` 纯标记行算作命中 → 去标签后为空；
//   · `floorAnalyzableText` = 0 → 全部非用户楼层 `skipped.noText` → `pending` = 0 →
//     **自动提取永远 `nothing-pending`、单楼按钮也「无法分析」**（用户看到的症状）。
//
// 本档锁四组：
//   A `applyFeedRegex`：纯标记行不再算命中（回退原文）；真 `<content>…</content>` 仍只取内部内容；
//   B `floorAnalyzableText`：过滤清空/只剩楼层前缀 → 回退原文（楼层仍可分析）；
//   C `scanPendingFloors`：该类楼层回到待分析清单；真·空正文楼仍计 `noText`；
//   D `analyzeSegment`：过滤清空但原文有正文 → **回退原文并真的请求 AI**（不再静默登记为已处理）。
// 反向探针：去掉 `applyFeedRegex` 的「纯标记行跳过」→ W1/W3/W4 必红；
//   去掉 `analyzeSegment` 的回退 → W6 必红（aiCalled 0、整段被记已处理）。
// ============================================================
import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks, setLastMessageId } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { applyFeedRegex } from '../../core/prompt.js';
import {
    listUnprocessedFloors, scanPendingFloors, floorAnalyzableText, floorTextFilteredOut,
    processedVerTag, hashFloorText,
} from '../../host/floors.js';
import { analyzeSegment } from '../../host/extract.js';

const R = makeReporter('feed-filter-stale v3.52.1 投喂白名单与正文格式不匹配（换存档后「不分析新楼层」）');
const A = (n, c, e) => R.assert(n, !!c, e === undefined ? 'n/a' : e);
const J = (v) => JSON.stringify(v);

const doc = makeDocument(['ftt-panel', 'extensions_settings2']);
doc.body = { insertAdjacentHTML() { }, addEventListener() { } };
const host = makeHost({ chat: [] });
installGlobalHost(host, doc);

/** 楼层正文：旧存档靠 `<content>` 标签；新存档把 `content` 当**属性名**（真机取证形态） */
const ATTR_FLOOR = [
    '[第3楼 书籍] <dream_plot>',
    '<dream_scene>',
    '<date>1996 年 6 月 5 日 周三</date>',
    '初夏的晨光穿透高柳，把细碎的金色鳞光送进庭院，李瑶在斑竹摇椅上晒着太阳。',
    '</dream_scene>',
    '<q content="晒饱了太阳之后，李瑶接下来的小算盘是什么呢？">',
    '<q content="客栈外面的局势，思客要推进到哪种程度呢？">',
].join('\n');
const CONTENT_FLOOR = '[第4楼 书籍] <content>真正的正文：李瑶决定下山游玩。</content>\n<q content="干扰行：不应进入投喂"></q>';

function boot(chat) {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.feedRegexWhitelist = [];
    cfg.feedRegexBlacklist = [];
    cfg.timelyAnalysis = false;
    setScopeKey('角色甲');
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });
    setKernelState(emptyState());
    state.processedVer = processedVerTag();
    host.ctx.chat = (chat || []).map((mes, i) => ({ is_user: false, role: 'assistant', name: '书籍', mes: mes, swipes: [mes] }));
    setLastMessageId(host.ctx.chat.length - 1);
    return state;
}

// ============================================================
// A 组：applyFeedRegex
// ============================================================
A('W1 白名单是旧标签名、新正文只把它当属性名（`<q content="…">`）→ 纯标记行不算命中，**回退原文**（不再投喂成空白）', (() => {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.feedRegexWhitelist = ['content'];
    cfg.feedRegexBlacklist = [];
    const out = applyFeedRegex(ATTR_FLOOR);
    return out === ATTR_FLOOR && out.indexOf('李瑶在斑竹摇椅上晒着太阳') >= 0;
})(), (() => {
    cfg.feedRegexWhitelist = ['content'];
    return String(applyFeedRegex(ATTR_FLOOR) || '').slice(0, 120);
})());

A('W2 白名单命中**真标签**时语义不变：只取 `<content>…</content>` 内部，不把其它正文/属性行混进来', (() => {
    Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg)));
    cfg.feedRegexWhitelist = ['content'];
    cfg.feedRegexBlacklist = [];
    const out = String(applyFeedRegex(CONTENT_FLOOR) || '').trim();
    return out === '真正的正文：李瑶决定下山游玩。' && out.indexOf('干扰行') < 0;
})(), applyFeedRegex(CONTENT_FLOOR));

// ============================================================
// B/C 组：楼层可分析性与待分析清单（host 层，真宿主桩）
// ============================================================
A('W3 `floorAnalyzableText`：属性名形态的楼层**仍有可分析正文**（此前恒为 0 → 判 noText）', (() => {
    boot([ATTR_FLOOR, CONTENT_FLOOR]);
    cfg.feedRegexWhitelist = ['content'];
    setLastMessageId(1);
    const one = String(floorAnalyzableText(0) || '');
    const two = String(floorAnalyzableText(1) || '');
    return one.length > 100 && one.indexOf('李瑶在斑竹摇椅上晒着太阳') >= 0
        && two.indexOf('真正的正文：李瑶决定下山游玩。') >= 0 && two.indexOf('干扰行') < 0;
})(), (() => ({ f0: String(floorAnalyzableText(0) || '').length, f1: String(floorAnalyzableText(1) || '').length }))());

A('W4 `scanPendingFloors`：该类楼层回到待分析清单（不再整批 `noText` 静默跳过）', (() => {
    boot([ATTR_FLOOR, CONTENT_FLOOR]);
    cfg.feedRegexWhitelist = ['content'];
    setLastMessageId(1);
    const s = scanPendingFloors({ maintain: false });
    return J(s.floors) === J([0, 1]) && s.skipped.noText === 0 && s.skipped.filtered === 0;
})(), (() => { const s = scanPendingFloors({ maintain: false }); return { floors: s.floors, skipped: s.skipped }; })());

A('W5 黑名单把**每一行**都过滤掉（另一种更极端的配置错位）→ 楼层仍按原文可分析、仍进清单（不再被判无正文）', (() => {
    boot([ATTR_FLOOR, CONTENT_FLOOR]);
    cfg.feedRegexWhitelist = [];
    cfg.feedRegexBlacklist = ['楼'];                 // 编译为字面量包含匹配：每行都带 [第N楼 …] 前缀 → 全部命中
    setLastMessageId(1);
    const okLen = String(floorAnalyzableText(0) || '').length;
    const s = scanPendingFloors({ maintain: false });
    return okLen > 50 && J(s.floors) === J([0, 1]) && s.skipped.noText === 0;
})(), (() => { const s = scanPendingFloors({ maintain: false }); return { floors: s.floors, skipped: s.skipped, okLen: String(floorAnalyzableText(0) || '').length }; })());

A('W6 `scanPendingFloors`：**真·无正文**的楼仍如实计入 `noText`（回退不等于放松判据）', (() => {
    boot(['…', '二楼正文：角色甲在仓库清点货物并记下账目，内容足够长。']);
    cfg.feedRegexWhitelist = ['content'];
    setLastMessageId(1);
    const s = scanPendingFloors({ maintain: false });
    return J(s.floors) === J([1]) && s.skipped.noText === 1;
})(), (() => { const s = scanPendingFloors({ maintain: false }); return { floors: s.floors, skipped: s.skipped }; })());

A('W7 `floorTextFilteredOut`：正常正文楼层不是「被过滤清空」；真·空正文楼层也不是', (() => {
    boot([ATTR_FLOOR, '…']);
    cfg.feedRegexWhitelist = ['content'];
    setLastMessageId(1);
    return floorTextFilteredOut(0) === false && floorTextFilteredOut(1) === false;
})(), 'n/a');

// ============================================================
// D 组：分段分析（batch / 多楼提取）
// ============================================================
await A('W8 `analyzeSegment`：投喂过滤把整段清空但原文有正文 → **回退原文并真的请求 AI**（不再 `empty:true` 静默登记已处理）', (async () => {
    boot([ATTR_FLOOR]);
    cfg.feedRegexWhitelist = [];
    cfg.feedRegexBlacklist = ['楼'];                  // 过滤后为空
    setLastMessageId(0);
    let aiCalled = 0;
    const ai = async () => { aiCalled += 1; return { ok: true, text: JSON.stringify({ 情节: [{ 内容: '李瑶在庭院里晒太阳，决定改日下山游玩。', 日期: '1996-06-05' }] }) }; };
    const r = await analyzeSegment(0, 0, { ai: ai });
    return r && r.ok === true && r.filterFallback === true && aiCalled === 1
        && r.floorStart === 0 && r.floorEnd === 0;
})(), (() => ({ note: 'fake-ai' }))());

A('W9 `analyzeSegment`：原文本身**也是空**时保持原语义（记该段已处理、不请求 AI）', (() => {
    boot(['…']);
    cfg.feedRegexWhitelist = [];
    cfg.feedRegexBlacklist = [];
    setLastMessageId(0);
    return true;   // 该分支为 async，W10 用真实调用覆盖（见下）
})(), 'n/a');

await A('W9 `analyzeSegment`：真·空正文楼 → `empty:true` 且**不**请求 AI、该段记为已处理（旧语义保留）', (async () => {
    boot(['…']);
    cfg.feedRegexWhitelist = [];
    cfg.feedRegexBlacklist = [];
    setLastMessageId(0);
    let aiCalled = 0;
    const ai = async () => { aiCalled += 1; return { ok: true, text: '{}' }; };
    const r = await analyzeSegment(0, 0, { ai: ai });
    return r && r.ok === true && r.empty === true && aiCalled === 0;
})(), (() => ({ note: 'fake-ai' }))());

R.done();
