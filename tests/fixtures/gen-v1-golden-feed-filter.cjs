'use strict';
// ============================================================
// v2.45.0 oracle：「投喂白/黑名单 → 投喂文本」**联动**对照样本
//   → tests/fixtures/v1-golden-feed-filter.json
// 目的：固化 V1 v1.206 的**正确口径**（过滤发生在原始正文上，标签仍在）：
//   · 白名单 = 按标签名提取 `<content>…</content>` 的**内部内容**（大小写不敏感、可跨行）；
//   · 黑名单 = 按行丢弃命中行；白名单提取路径下黑名单作用于提取结果；
//   · 白名单存在但一行都没命中 → **回退原文**（并写调试日志）；
//   · 无名单 → 原样返回（此时 V1 会把 HTML 原样交给 AI —— v2.44.0 起 V2 会去掉标签，属有意差异）。
// 用途：V2 v2.44.0 首版把「去 HTML」放到过滤**之前** → 白/黑名单永远匹配不到（用户报告的「不联动生效」）。
//   V2 v2.45.0 改为「先过滤、后去标签」，本样本用于断言：**有名单时 V2 与 V1 逐字一致**。
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致。
// ============================================================
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin, waitPipelineIdle } = require(path.join(V1, 'tests/unit/helpers.js'));
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');

const REAL_STDOUT = process.stdout.write.bind(process.stdout);
const proj = (o) => (o === null || o === undefined ? null : JSON.parse(JSON.stringify(o)));

/** 楼层样本（与 V2 单测完全一致） */
const FLOORS = {
    HTML: [
        { is_user: true, role: 'user', mes: '用户：继续。<br>' },
        { is_user: false, role: 'assistant', mes: '<content>甲走进仓库。</content><system>旁白：铜箱是空的。</system><br>普通正文一行。' },
    ],
    PLAIN: [
        { is_user: true, role: 'user', mes: '用户：继续。' },
        { is_user: false, role: 'assistant', mes: '甲走进仓库。旁白：铜箱是空的。\n普通正文一行。' },
    ],
    MARKER: [
        { is_user: false, role: 'assistant', mes: '正文开头【战斗】甲拔剑。<br>【状态】体力 5。' },
    ],
};

/** 每个用例一个全新 V1 实例（楼层经 `getChatMessages` 注入） */
async function run(floorsKey, white, black) {
    const floors = FLOORS[floorsKey];
    const env = makeTavernEnv({
        ctx: {
            chat: proj(floors),
            getLastMessageId: () => floors.length - 1,
            getChatMessages: (i) => (floors[Number(i)] === undefined ? [null] : [proj(floors[Number(i)])]),
        },
    });
    const F = await loadPlugin(env);
    const st = F.cfg.storage;
    ['indexedDB', 'folder', 'localFolder', 'chatVariable', 'worldbook', 'chatFloor'].forEach(k => { st[k] = false; });
    st.localStorage = true; st.syncOnSave = false; st.autoIdleCheck = false;
    await waitPipelineIdle(F);
    F.cfg.stateDecayEnabled = false; F.cfg.memoryForgetEnabled = false; F.cfg.parallelDecayEnabled = false;
    F.cfg.clockAutoPatrol = false;
    F.cfg.feedFloors = 10;
    F.cfg.feedRegexWhitelist = white.slice();
    F.cfg.feedRegexBlacklist = black.slice();
    const lines = (() => { try { return F.collectFloorLinesInRange(0, floors.length - 1); } catch (e) { return { err: String(e.message) }; } })();
    const feed = (() => { try { return String(F.buildFeedFloorText(10) || ''); } catch (e) { return 'ERR:' + String(e.message); } })();
    const range = (() => { try { return String(F.buildFeedFloorTextRange(10, floors.length - 1) || ''); } catch (e) { return 'ERR:' + String(e.message); } })();
    return { lines: proj(lines), feed: feed, range: range, wl: proj(F.cfg.feedRegexWhitelist), bl: proj(F.cfg.feedRegexBlacklist) };
}

(async function main() {
    const out = {
        meta: {
            v1Version: 'v1.206',
            generatedBy: 'tests/fixtures/gen-v1-golden-feed-filter.cjs',
            note: '投喂白/黑名单的**联动口径**：过滤必须作用在原始正文上（白名单按标签名提取内部内容）。V2 v2.45.0 改为「先过滤、后去标签」后，有名单场景应与本样本逐字一致；无名单场景 V2 额外剔除 HTML（v2.44.0 有意差异）。',
        },
        floorSamples: proj(FLOORS),
        cases: [],
    };
    const plan = [
        { name: '无名单（HTML 楼层）', floors: 'HTML', white: [], black: [] },
        { name: '白名单 content', floors: 'HTML', white: ['content'], black: [] },
        { name: '白名单 content + 黑名单 system', floors: 'HTML', white: ['content'], black: ['system'] },
        { name: '白名单未命中（应回退原文）', floors: 'HTML', white: ['nope'], black: [] },
        { name: '仅黑名单 system', floors: 'HTML', white: [], black: ['system'] },
        { name: '白名单大小写不敏感（CONTENT）', floors: 'HTML', white: ['CONTENT'], black: [] },
        { name: '行内标记白名单（战斗）', floors: 'MARKER', white: ['战斗'], black: [] },
        { name: '行内标记黑名单（状态）', floors: 'MARKER', white: [], black: ['状态'] },
        { name: '无名单（纯文本楼层）', floors: 'PLAIN', white: [], black: [] },
    ];
    for (const c of plan) {
        out.cases.push({ name: c.name, floors: c.floors, white: c.white, black: c.black, out: await run(c.floors, c.white, c.black) });
    }
    const text = JSON.stringify(out, null, 1);
    REAL_STDOUT(text, () => process.exit(0));
})();
