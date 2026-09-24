'use strict';
// ============================================================
// B9-d oracle（跨端同步分歧选择）：真实 V1 插件 v1.206 直调，生成
//   tests/fixtures/v1-golden-sync-pick.json
//   （`crossPendingGet`/`crossPendingClear`/`applyRemoteReplaceState`/`crossComputeInfo`/`adoptRemoteEnvelope`
//     + `crossPullPolicy` 分歧暂存分支 + UI 动作 `syncPickLocal`/`syncPickRemote` + 分歧横幅 + 同步日志留痕）
// 纪律：日志走 stderr（在 loadPlugin 之前覆写 console）、stdout 只输出 JSON、结尾 process.exit(0)、
//   连跑两次逐字节一致（输出不含 ts/ms/src 等时间派生值）。
// `syncPickLocal` / `syncPickRemote` 属 `handleAction` 的 case（未导出）→ 走 **真实点击委托**：
//   `F.openPanel()` → `panel.listeners.click` 派发伪事件驱动 V1 `handleAction`；
//   分歧横幅由 `renderStorageStatus()` 写入 `[data-ftt-storage-status]`（V1 未导出该函数），
//   故 mock document 的 `querySelector` 被替换为「只对 `[data-ftt-storage-status]` 返回代理盒」——
//   V1 自身代码不做任何改动。
// 运行：node tests/fixtures/gen-v1-golden-sync-pick.cjs [输出路径]
// ============================================================
const fs = require('fs');
const path = require('path');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin, makeResp, pluginToasts } = require(path.join(V1, 'tests/unit/helpers.js'));

const realStdoutWrite = process.stdout.write.bind(process.stdout);
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');
console.error = (...a) => process.stderr.write('ERR: ' + a.join(' ') + '\n');

const OUT = process.argv[2] || '';
const SRC_FILE = path.join(V1, 'src', 'FTT记忆组件-v1.206.js');
const SRC = fs.readFileSync(SRC_FILE, 'utf8');
const proj = (o) => (o === null || o === undefined ? null : JSON.parse(JSON.stringify(o)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snip(from, to, maxLen) {
    const i = SRC.indexOf(from);
    if (i < 0) return '';
    const j = to ? SRC.indexOf(to, i + from.length) : -1;
    const seg = (j > i ? SRC.slice(i, j) : SRC.slice(i, i + (maxLen || 1400)));
    return seg.trim();
}

/** 服务端桩（记忆文件：主/备份/快照/清单） */
function installServer(env) {
    const state = { files: {}, uploads: [], calls: [] };
    env.parentWin.fetch = async (url, opts) => {
        const u = String(url), op = opts || {};
        let body = null; try { body = op.body ? JSON.parse(op.body) : null; } catch (e) { /* 忽略 */ }
        state.calls.push({ url: u, name: body && body.name });
        if (u.indexOf('/csrf-token') === 0) return makeResp({ token: 'TK9D2' });
        if (u.indexOf('/api/files/upload') === 0) {
            const buf = Buffer.from(String((body && body.data) || ''), 'base64');
            state.uploads.push({ name: body && body.name, buf });
            state.files[body && body.name] = buf;
            return makeResp({ path: '/user/files/' + (body && body.name) });
        }
        if (u.indexOf('/api/files/delete') === 0) {
            delete state.files[String((body && body.path) || '').replace(/^\/user\/files\//, '')];
            return makeResp({ ok: true });
        }
        if (u.indexOf('/user/files/') === 0) {
            const name = decodeURIComponent(u.replace(/^\/user\/files\//, '').split('?')[0]);
            const buf = state.files[name];
            if (buf === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
            return makeResp(buf);
        }
        return makeResp('{}');
    };
    state.setJson = (n, obj) => { state.files[n] = Buffer.from(JSON.stringify(obj), 'utf8'); };
    return state;
}

/** 分歧场景：本端/对端各有独有条目 + 同 id 冲突（无端是超集）→ crossComputeInfo.mode='divergence' */
const LOCAL = {
    atoms: [{ id: 'L1', text: '本端独有：艾芙琳在码头交接货物。', title: '本端交接', date: '1936-12-06', tags: ['码头'], uses: 1, floorStart: 0, floorEnd: 2 }],
    currentStates: [{ id: 'x1', subject: '艾芙琳', field: '体力', value: '70', status: '正常', updatedAt: 200, uses: 1 }],
    updatedAt: 1700000002000,
};
const REMOTE = {
    atoms: [{ id: 'R1', text: '对端独有：线人在酒馆留下了字条。', title: '对端字条', date: '1936-12-07', tags: ['字条'], uses: 1, floorStart: 0, floorEnd: 2 }],
    currentStates: [{ id: 'x1', subject: '艾芙琳', field: '体力', value: '40', status: '疲惫', updatedAt: 300, uses: 1 }],
    updatedAt: 1700000003000,
};

function pickLogs(F, n) { return F.crossSyncLogList().slice(0, n); }
/** 同步日志投影（剔除 ts/ms/src 等时间/环境派生值） */
function logView(rec) {
    if (!rec) return null;
    return {
        action: String(rec.action || ''), mode: String(rec.mode || ''), changed: !!rec.changed,
        localN: Number(rec.localN) || 0, remoteN: Number(rec.remoteN) || 0, afterN: Number(rec.afterN) || 0,
        note: String(rec.note || ''),
    };
}
function toastView(t) { return { kind: String(t.kind || ''), title: String(t.title || ''), text: String(t.text || '') }; }
/** 横幅投影（按钮 class/text/title 逐字） */
function bannerView(html) {
    const s = String(html || '');
    const box = s.indexOf('ftt-warn-box');
    if (box < 0) return null;
    const grab = (re) => { const m = s.match(re); return m ? m[1] : null; };
    const btn = (action) => {
        const m = s.match(new RegExp('<button class="([^"]*)" data-ftt-action="' + action + '"([^>]*)>([^<]*)</button>'));
        if (!m) return null;
        const tm = String(m[2] || '').match(/title="([^"]*)"/);
        return { cls: m[1], hasTitleAttr: /title=/.test(String(m[2] || '')), title: tm ? tm[1] : null, text: m[3] };
    };
    return {
        title: grab(/<b class="ftt-pend-title">([^<]*)<\/b>/),
        desc: grab(/<div class="ftt-desc ftt-my-1">([\s\S]*?)<\/div>/),
        // 归一形态：V1 用 `Date.prototype.toLocaleString()` 渲染更新时间（随环境/时区变化）→
        //   比较用归一版（时间片段替换为 <t>），文案与统计数字逐字保留。
        descNorm: (() => { const d = grab(/<div class="ftt-desc ftt-my-1">([\s\S]*?)<\/div>/); return d === null ? null : String(d).replace(/（更新 [^）]*）/g, '（更新 <t>）'); })(),
        localBtn: btn('syncPickLocal'),
        remoteBtn: btn('syncPickRemote'),
        rowCls: grab(/<div class="(ftt-row ftt-mt-2)">/),
    };
}
const stateView = (F) => ({
    atomIds: (F.state.atoms || []).map((x) => x.id).sort(),
    stateValues: (F.state.currentStates || []).map((x) => x.id + '=' + x.value).sort(),
    updatedAt: Number(F.state.updatedAt) || 0,
});
const pendingView = (F) => {
    const p = F.crossPendingGet();
    if (!p) return null;
    const i = p.info || {};
    const d = i.diff || {};
    return {
        hasEnv: !!(p.env && p.env.payload), mode: String(i.mode || ''),
        localN: Number(i.localN) || 0, remoteN: Number(i.remoteN) || 0, tsDiff: Number(i.tsDiff) || 0,
        onlyLocal: Number(d.onlyLocal) || 0, onlyRemote: Number(d.onlyRemote) || 0, conflict: Number(d.conflict) || 0,
    };
};

async function main() {
    const g = global;
    const savedRaf = g.requestAnimationFrame;
    g.requestAnimationFrame = (fn) => { try { fn(); } catch (e) { /* 忽略 */ } return 0; };

    const env = makeTavernEnv();
    // mock document 的 querySelector 只对存储状态盒返回代理（V1 `renderStorageStatus` 真实写入的落点）
    const boxProxy = { innerHTML: '' };
    const rawQS = env.parentDoc.querySelector.bind(env.parentDoc);
    env.parentDoc.querySelector = (sel) => (String(sel).indexOf('data-ftt-storage-status') >= 0 ? boxProxy : rawQS(sel));

    const F = await loadPlugin(env);
    ['indexedDB', 'folder', 'localFolder', 'chatVariable', 'worldbook', 'chatFloor'].forEach((k) => { F.cfg.storage[k] = false; });
    F.cfg.storage.localStorage = true; F.cfg.storage.syncOnSave = false; F.cfg.storage.autoIdleCheck = false;
    F.cfg.storage.syncMetaProbe = false; F.cfg.storage.syncLogServer = false;
    F.cfg.storage.stateFile = true; F.cfg.storage.stateFileBak = true; F.cfg.storage.snapshotFile = true;
    F.cfg.syncTrafficGuard = false;                       // 关掉楼层门控（本 oracle 用 force 亦可）

    const result = { meta: { v1Version: 'v1.206', notes: [], sourceFile: 'src/FTT记忆组件-v1.206.js' } };
    result.scenario = { local: proj(LOCAL), remote: proj(REMOTE) };
    result.meta.v1SourceSnips = {
        pending: snip('let crossPending = null;', 'function atomEntryCount(d)', 900),
        applyRemoteReplaceState: snip('function applyRemoteReplaceState(env) {', '// ==================== v1.148', 900),
        divergenceBranch: snip('// 分歧：暂存并提示（仅保留最新一次对端信封）', 'return false;', 2000),
        pickLocal: snip("case 'syncPickLocal': {", "case 'syncPickRemote': {"),
        pickRemote: snip("case 'syncPickRemote': {", '// 刷新状态 = **获取服务端最新数据 + 自动合并**'),
        banner: snip('// 分歧横幅 —— 自动同步发现分歧时提示用户选择保留哪个版本（含统计）', '// 同步刷新「记忆文件通道状态行」', 1200),
        exports: snip('crossSyncManual, crossComputeInfo, crossPendingGet, crossPendingClear, applyRemoteReplaceState, adoptRemoteEnvelope,', '\n', 200),
    };

    // ---------------- 一、分歧检测（纯计算） ----------------
    {
        const info = F.crossComputeInfo(LOCAL, REMOTE, REMOTE.updatedAt);
        result.computeInfo = {
            mode: String(info.mode || ''), aggSame: !!info.aggSame, localN: info.localN, remoteN: info.remoteN,
            tsDiff: info.tsDiff, newer: info.newer,
            diff: { same: info.diff.same, onlyLocal: info.diff.onlyLocal, onlyRemote: info.diff.onlyRemote, conflict: info.diff.conflict, conflictWinLocal: info.diff.conflictWinLocal, conflictWinRemote: info.diff.conflictWinRemote },
        };
        // 单端超集/一致 三种对照（证明 divergence 判定不是恒真）
        const localSup = F.crossComputeInfo(Object.assign({}, REMOTE, { atoms: REMOTE.atoms.concat(LOCAL.atoms) }), REMOTE, REMOTE.updatedAt);
        const same = F.crossComputeInfo(REMOTE, REMOTE, REMOTE.updatedAt);
        result.computeControls = { localSuperset: localSup.mode, same: same.mode };
    }

    // ---------------- 二、UI 打开 + 自动对账暂存分歧 → 横幅 ----------------
    F.openPanel();
    const panel = env.parentDoc.elements['ftt-panel'] || env.parentWin.document.body.children.find((c) => c.id === 'ftt-panel');
    if (!panel) throw new Error('未找到 #ftt-panel');
    const listeners = (panel.listeners && panel.listeners.click) ? panel.listeners.click : [];
    const clickFake = async (ds, cls) => {
        const classes = ['ftt-open'].concat(cls || []);
        const keep = panel.classList.contains;
        panel.classList.contains = (c) => (classes.indexOf(c) >= 0 ? true : keep.call(panel, c));
        const fake = {
            target: { dataset: ds, classList: { contains: (c) => classes.indexOf(c) >= 0 }, closest: () => panel, tagName: 'A' },
            preventDefault() { }, stopPropagation() { },
        };
        try { for (const fn of listeners) { try { await fn(fake); } catch (e) { /* 与 V1 委托同容错 */ } } }
        finally { panel.classList.contains = keep; }
        await sleep(30);
    };
    const S = installServer(env);
    // 远端：一份与本端分歧的记忆文件（固定信封时间戳 → 可复现）
    const remoteEnv = F.storageEnvelope(Object.assign({}, F.state, proj(REMOTE)));
    remoteEnv.ts = 1700000003000; remoteEnv.payload.updatedAt = 1700000003000; remoteEnv.hash = F.storageHash(remoteEnv.payload);
    S.setJson(F.stateFileName(), remoteEnv);
    // 本端：分歧状态（固定 updatedAt）
    F.state = Object.assign({}, F.state, proj(LOCAL));

    // 进入 设定 → 存储（renderPanel → renderStorageStatus）
    await clickFake({ fttTab: 'settings' }, ['ftt-tab']);
    await clickFake({ fttSubtab: 'storage' }, ['ftt-subtab']);

    // 自动对账（V1 `crossPullPolicy`）→ 分歧暂存
    const logsBefore = F.crossSyncLogList().length;
    const toastsBefore = pluginToasts(F).length;
    const pulled = await F.crossPullPolicy('自动对账(测试)', { force: true });
    const pendingAfterPull = pendingView(F);
    const pullLogs = pickLogs(F, F.crossSyncLogList().length - logsBefore).map(logView);
    const pullToasts = pluginToasts(F).slice(toastsBefore).map(toastView);

    // 重绘存储页 → 横幅（renderStorageStatus 为异步，轮询等待）
    boxProxy.innerHTML = '';
    await clickFake({ fttSubtab: 'storage' }, ['ftt-subtab']);
    for (let i = 0; i < 60 && boxProxy.innerHTML.indexOf('ftt-warn-box') < 0; i++) await sleep(50);
    const banner = bannerView(boxProxy.innerHTML);

    result.divergence = {
        pulled: !!pulled,
        pendingAfterPull: pendingAfterPull,
        logs: pullLogs,
        toasts: pullToasts,
        banner: banner,
        stateBeforePick: stateView(F),
        uploadsBeforePick: S.uploads.length,
    };

    // ---------------- 三、syncPickLocal（保留本端 → 覆盖对端） ----------------
    {
        const t0 = pluginToasts(F).length;
        const l0 = F.crossSyncLogList().length;
        const u0 = S.uploads.length;
        await clickFake({ fttAction: 'syncPickLocal' }, []);
        await sleep(120);
        result.pickLocal = {
            pendingAfter: pendingView(F),
            logs: pickLogs(F, F.crossSyncLogList().length - l0).map(logView),
            toasts: pluginToasts(F).slice(t0).map(toastView),
            stateAfter: stateView(F),
            uploads: S.uploads.slice(u0).map((u) => ({ name: u.name, magic: [u.buf[0], u.buf[1]] })),
            bannerAfter: bannerView(boxProxy.innerHTML),
        };
    }

    // ---------------- 四、syncPickRemote（采用对端 → 整体替换） ----------------
    {
        // 复位：本端回到分歧态，远端文件仍在 → 再次暂存
        F.state = Object.assign({}, F.state, proj(LOCAL));
        const remoteEnv2 = F.storageEnvelope(Object.assign({}, F.state, proj(REMOTE)));
        remoteEnv2.ts = 1700000003000; remoteEnv2.payload.updatedAt = 1700000003000; remoteEnv2.hash = F.storageHash(remoteEnv2.payload);
        S.setJson(F.stateFileName(), remoteEnv2);
        F.fileCacheDropAll();
        await F.crossPullPolicy('自动对账(测试)', { force: true });
        const pendBefore = pendingView(F);
        const t0 = pluginToasts(F).length;
        const l0 = F.crossSyncLogList().length;
        const u0 = S.uploads.length;
        await clickFake({ fttAction: 'syncPickRemote' }, []);
        await sleep(120);
        result.pickRemote = {
            pendingBefore: pendBefore,
            pendingAfter: pendingView(F),
            logs: pickLogs(F, F.crossSyncLogList().length - l0).map(logView),
            toasts: pluginToasts(F).slice(t0).map(toastView),
            stateAfter: stateView(F),
            uploads: S.uploads.slice(u0).map((u) => ({ name: u.name, magic: [u.buf[0], u.buf[1]] })),
        };
    }

    // ---------------- 五、无待选时点「采用对端」（V1：warning + 不改动） ----------------
    {
        F.crossPendingClear();
        const keepAtoms = (F.state.atoms || []).map((x) => x.id).join(',');
        const t0 = pluginToasts(F).length;
        const l0 = F.crossSyncLogList().length;
        await clickFake({ fttAction: 'syncPickRemote' }, []);
        await sleep(120);
        result.pickRemoteNoPending = {
            logs: pickLogs(F, F.crossSyncLogList().length - l0).map(logView),
            toasts: pluginToasts(F).slice(t0).map(toastView),
        };
        result.pickRemoteNoPending.stateUnchanged = ((F.state.atoms || []).map((x) => x.id).join(',') === keepAtoms);
    }

    // ---------------- 六、applyRemoteReplaceState 直调（含「长任务在途降级」口径） ----------------
    {
        F.state = Object.assign({}, F.state, proj(LOCAL));
        const envForReplace = F.storageEnvelope(Object.assign({}, F.state, proj(REMOTE)));
        const r = F.applyRemoteReplaceState(envForReplace);
        result.applyReplace = { ret: r === true ? true : (r === null ? null : String(r)), atomIds: (F.state.atoms || []).map((x) => x.id).sort(), stateValues: (F.state.currentStates || []).map((x) => x.id + '=' + x.value).sort() };
        const adopted = F.adoptRemoteEnvelope(envForReplace);
        result.adoptEnvelope = { ret: !!adopted, atomIds: (F.state.atoms || []).map((x) => x.id).sort() };
    }

    // ---------------- 七、原生怪癖（oracle 实测，原样保留） ----------------
    result.meta.notes.unshift('本 fixture 由 tests/fixtures/gen-v1-golden-sync-pick.cjs **直调真实 V1 插件 v1.206** 生成'
        + '（`node tests/fixtures/gen-v1-golden-sync-pick.cjs tests/fixtures/v1-golden-sync-pick.json`，连跑两次逐字节一致）。'
        + '`crossComputeInfo`/`crossPendingGet`/`crossPendingClear`/`applyRemoteReplaceState`/`adoptRemoteEnvelope`/`crossPullPolicy` 走 `__FTT` 导出直调；'
        + '`syncPickLocal`/`syncPickRemote` 走**真实点击委托**（openPanel() 后在 `panel.listeners.click` 派发伪事件 → V1 `handleAction` 真实执行）；'
        + '分歧横幅由 V1 `renderStorageStatus()` 真实写入（mock document 的 `querySelector` 只对 `[data-ftt-storage-status]` 返回代理盒）。');
    result.meta.notes.push('V1 原生行为（oracle 实测，原样保留）：'
        + '① **只有自动对账路径**（`crossPullPolicy`）会产生「待选分歧」；`跨端立即同步`（`crossSyncManual`）遇分歧仍按「原子融合」处置（不产生待选）。'
        + '② 暂存只保留**更新**的那一份对端信封：已有 pending 且其 `updatedAt >= 新对端` 时，只记一条「分歧(已暂存较新待选)」日志、不覆盖、**不重复提示**。'
        + '③ `syncPickLocal`/`syncPickRemote` 都**先清空待选再执行**（异步 IIFE 内），失败也只提示「同步失败」，不会恢复 pending。'
        + '④ `syncPickLocal` 只做 `storageWriteAll(storageEnvelope(state))`（本端覆盖对端），**不重新读取对端**。'
        + '⑤ `syncPickRemote` 在**发送/提取在途**（`userWriteInFlight`）时把「整体替换」**降级为并集合并**（`applyRemoteReplaceState` 返回 `"merge"`），'
        + '并集合并也失败则放弃替换（返回 `null`）；toast 的 `ok` 判定按「真值」处理 → `"merge"` 也走「已采用对端版本」分支。'
        + '⑥ 两条处置都写同步日志 `action=\'分歧选择\'`，`mode` 分别为 `保留本端(覆盖对端)` / `采用对端(整体替换)`（无待选时后者写 `未找到待选对端` 且 `changed=false`）。'
        + '⑦ 分歧横幅两个按钮**没有 `title` 属性**（V1 原文如此），文案为 `保留本地（N 条）` / `采用对端（N 条）`。');
    result.meta.notes.push('投影说明：同步日志与提示中的 `ts`/`ms`/`src` 属时间/环境派生值，已剔除（仅保留 action/mode/changed/localN/remoteN/afterN/note 与 toast 的 kind/title/text）。');

    if (savedRaf === undefined) delete g.requestAnimationFrame; else g.requestAnimationFrame = savedRaf;
    return result;
}

main().then((r) => {
    const text = JSON.stringify(r, null, 2) + '\n';
    if (OUT) fs.writeFileSync(OUT, text);
    realStdoutWrite(text);
    process.exit(0);
}).catch((e) => { process.stderr.write('ORACLE FAIL: ' + ((e && e.stack) || e) + '\n'); process.exit(2); });
