'use strict';
// ============================================================
// v2.44.0 oracle：「正文 HTML 标签污染数据」对照样本（**V1 缺陷 #5**）
//   → tests/fixtures/v1-golden-html-pollution.json
// 目的：把 **V1 v1.206 的现状**（地点/场景/投喂文本不做 HTML 清洗 → `<br>`、`<div>`、`&nbsp;` 被当作内容
//   写进 `state.state.location` / `sceneDesc`，并原样进入投喂给 AI 的楼层文本）固化成**可复查的证据**，
//   以便 V2 的修正（v2.44.0：统一剔除 HTML 标签/实体，见 core/html-text.js 与 docs/P10i）能逐项断言差异。
//   与既有四处「V1 故障明确修正」同口径。
// 纪律：日志走 stderr、stdout 只输出 JSON、结尾 process.exit(0)、连跑两次逐字节一致。
// ============================================================
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin, waitPipelineIdle } = require(path.join(V1, 'tests/unit/helpers.js'));
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');

const REAL_STDOUT = process.stdout.write.bind(process.stdout);
const OUT = process.argv[2] || path.join(__dirname, 'v1-golden-html-pollution.json');
const clone = (o) => JSON.parse(JSON.stringify(o));

/** 含 HTML 的楼层正文（酒馆消息正文是富文本） */
const FLOOR_HTML = [
    { is_user: true, role: 'user', mes: '甲：去仓库看看。<br>' },
    { is_user: false, role: 'assistant', mes: '▷1919年11月29日（东汉建武二十七年）·冬(死寂的长街)<br>▷码头仓库<br>甲推开木门，灰尘扑面。<div>墙角有一只铜箱。</div>' },
];
const FLOOR_PLAIN = [
    { is_user: true, role: 'user', mes: '甲：去仓库看看。' },
    { is_user: false, role: 'assistant', mes: '▷1919年11月29日（东汉建武二十七年）·冬(死寂的长街)\n▷码头仓库\n甲推开木门，灰尘扑面。\n墙角有一只铜箱。' },
];

async function boot(chat) {
    const F = await loadPlugin(makeTavernEnv({
        ctx: {
            chat: clone(chat || []),
            getChatMessages: (i) => clone(chat || []).slice(Number(i) || 0, (Number(i) || 0) + 1),
        },
    }));
    const st = F.cfg.storage;
    ['indexedDB', 'folder', 'localFolder', 'chatVariable', 'worldbook', 'chatFloor'].forEach(k => { st[k] = false; });
    st.localStorage = true; st.syncOnSave = false; st.autoIdleCheck = false;
    await waitPipelineIdle(F);
    F.cfg.stateDecayEnabled = false; F.cfg.memoryForgetEnabled = false; F.cfg.parallelDecayEnabled = false;
    F.cfg.clockAutoPatrol = false; F.cfg.clockForceDegrade = false; F.cfg.clockAnomalyJumpYears = 50;
    F.state = Object.assign({}, F.state, {
        atoms: [], currentStates: [], snapshots: [], memories: [], items: [], currencies: [], plotSegments: [],
        plans: [], suspense: [], scenes: [], concepts: [], parallels: [], links: [], vars: {},
        state: { date: '', time: '', location: '', present: [] }, summaries: [], processedFloors: [], lastKnownFloor: -1,
    });
    return F;
}

// ① 真实排版：换行 + 行尾标签（用户报告的场景 —— 整行「码头仓库<br>」被当作地点）
const TEXT_HEADER_BR = '▷1919年11月29日（东汉建武二十七年）·冬(死寂的长街)\n▷码头仓库<br>\n甲推开木门。';
// ② 全文用 `<br>` 换行（无 `\n`）：V1 因整段变成一行而**识别不到**正文头地点行
const TEXT_HEADER_BR_ONLY = '▷1919年11月29日（东汉建武二十七年）·冬(死寂的长街)<br>▷码头仓库<br>甲推开木门。';
const TEXT_HEADER_PLAIN = '▷1919年11月29日（东汉建武二十七年）·冬(死寂的长街)\n▷码头仓库\n甲推开木门。';
const TEXT_MARKER_BR = '1919年11月29日，傍晚。甲走进码头。【地点：码头仓库<br>】';
const TEXT_MARKER_DIV = '<div>甲走进码头。</div>【地点：<b>码头</b>&nbsp;仓库】';

(async function main() {
    const out = {
        meta: {
            v1Version: 'v1.206',
            generatedBy: 'tests/fixtures/gen-v1-golden-html-pollution.cjs',
            note: 'V1 不做 HTML 清洗：地点/场景取值与投喂楼层文本原样保留 <br>/<div>/<b>/&nbsp; —— V2 v2.44.0 已修正（core/html-text.js），本样本用于断言差异（V1 故障明确修正 #5）',
        },
    };

    // ---------- A 组：正文头地点（`▷码头仓库<br>`） ----------
    {
        const F = await boot(FLOOR_HTML);
        const run = (text, cfgPatch) => {
            Object.assign(F.cfg, { clockRegexPreset: 'cn+marker', clockRelative: true, clockDateRegex: '', clockTimeRegex: '', clockLocationRegex: '' }, cfgPatch || {});
            const r = F.extractClockFromText(text, { date: '', time: '', location: '' });
            return { date: r.date, time: r.time, location: r.location, sceneDesc: r.sceneDesc, source: r.source, header: r.header };
        };
        out.A = {
            headerBr: run(TEXT_HEADER_BR),
            headerBrOnly: run(TEXT_HEADER_BR_ONLY),
            headerPlain: run(TEXT_HEADER_PLAIN),
            markerBr: run(TEXT_MARKER_BR),
            markerDiv: run(TEXT_MARKER_DIV),
            customLocationBr: (() => {
                Object.assign(F.cfg, { clockLocationRegex: '地点[:：](.{1,20})' });
                const r = F.extractClockFromText('1919年11月29日，傍晚。地点：码头仓库<br>', { date: '', time: '', location: '' });
                Object.assign(F.cfg, { clockLocationRegex: '' });
                return { location: r.location, source: r.source };
            })(),
        };
    }

    // ---------- B 组：投喂给 AI 的楼层文本（HTML 原样进入提示词） ----------
    {
        const F = await boot(FLOOR_HTML);
        const plain = await boot(FLOOR_PLAIN);
        const take = (f) => {
            const r = {};
            try { r.lines = f.collectFloorLinesInRange(0, 1); } catch (e) { r.linesErr = String(e.message); }
            try { r.feed = f.buildFeedFloorText(2); } catch (e) { r.feedErr = String(e.message); }
            try { r.analyzable = f.floorAnalyzableText(1); } catch (e) { r.analyzableErr = String(e.message); }
            return r;
        };
        out.B = { html: take(F), plain: take(plain) };
    }

    // ---------- C 组：手工锚点录入（地点粘进 `<br>`） ----------
    {
        const F = await boot(FLOOR_PLAIN);
        const man = (v) => { try { const r = F.parseClockManualInput(v); return { ok: r.ok, date: r.date, time: r.time, location: r.location, notes: r.notes }; } catch (e) { return { error: String(e.message) }; } };
        out.C = {
            locationBr: man({ location: '码头仓库<br>' }),
            locationDiv: man({ location: '<div>码头仓库</div>' }),
            locationPlain: man({ location: '码头仓库' }),
            dateTime: man({ date: '1919年11月29日', time: '傍晚', location: '码头仓库&nbsp;B1' }),
        };
    }

    // ---------- D 组：AI 生成地点正则的校验（含标签的写法是否被接受） ----------
    {
        const F = await boot(FLOOR_PLAIN);
        const probe = (re) => {
            try {
                const r = F.clockAiApply ? F.clockAiApply({ 地点正则: re }) : null;
                return r ? { applied: r.applied, skipped: r.skipped, regex: (r.regexes || {}).location } : { unavailable: true };
            } catch (e) { return { error: String(e.message) }; }
        };
        out.D = {
            withTag: probe('▷([^<\\n]+)<br>'),
            plain: probe('▷([^\\n]+)'),
            note: 'V1 是否内置「含 HTML 特征需拒绝」的校验 —— 由本样本如实记录（V2 v2.44.0 明确拒绝：reason=html-tag）',
        };
    }

    const text = JSON.stringify(out, null, 1);
    REAL_STDOUT(text, () => process.exit(0));
})();
