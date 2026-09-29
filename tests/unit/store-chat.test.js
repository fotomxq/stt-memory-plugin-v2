// ============================================================
// 单元测试 · P2 宿主层（host/chat.js 聊天接线 + adapters/store.js 保存流水线 + adapters/user-file.js 文件通道）
// v3.0.15 增补（用户报告「上次更新后特别卡顿，尤其正文保存，可能直接卡死」）：
//   S9/S10 保存与文件请求的两层看门狗 · S11 base64 分块（编码逐字节一致）· S12「数据无变化」保存短路 ·
//   S13 并发保存合流 · S14 索引交接后墓碑留痕照常。
// 重点：保存流水线必须复刻 V1 `saveState()` 顺序（刷新原子 h → 删除自动留痕 → 写库）——
//   批次 5 的黄金样本已证明「内容哈希墓碑由该流水线写入」。本文件全部断言均为 await 后的真实条件
//   （不使用「Promise && true」这类恒真写法）。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter, makeHost, installGlobalFetch } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { wireKernelChatHooks, kernelChatMessages, latestAiMessageText, currentLastMessageId, currentStableCharKey, attachKernelState, kernelChatDebug } from '../../host/chat.js';
import { saveStateNow, scheduleSave, cancelScheduledSave, loadFromLocalStorage, loadFromServerFile, wirePersistHooks, setStorageHooks, setSaveDebounce, storeStatus, lastSaveInfo, resetState, primeStateIndex, flushStateNow, setFlushStuckMs, FLUSH_STUCK_MS, markDataTouched, setSaveNoopWindowMs, SAVE_NOOP_WINDOW_MS } from '../../adapters/store.js';
import { slugify, stateFileName, textToBase64, base64ToText, uploadStateFile, deleteStateFile } from '../../adapters/user-file.js';
import { cfg, setKernelState, getScopeKey, setPersistHooks, kernelState } from '../../core/model/runtime.js';
import { scopeId, emptyState } from '../../core/state.js';
import { panelAction, panelState, panelBodyHtml } from '../../ui/panel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const R = makeReporter('store-chat P2 宿主层');
const clone = (v) => JSON.parse(JSON.stringify(v));
const J = (v) => JSON.stringify(v);

function freshState() {
    return {
        atoms: [
            { id: 'a1', text: '角色甲在码头发现木箱，断口整齐（正文足够长）。', title: '甲', date: '1919-11-29', tags: ['码头'] },
            { id: 'a2', text: '两人在仓库清点货物并记录转运去向（正文足够长）。', title: '乙', date: '1919-11-30', tags: ['仓库'] },
        ],
        currentStates: [], snapshots: [], memories: [], items: [], plans: [], suspense: [], scenes: [], concepts: [], parallels: [], npcs: [],
        links: [], currencies: [], plotSegments: [], rumors: [], deleted: {}, deletedH: {}, vars: {}, stats: {},
        state: { date: '1919-11-29', time: '', location: '', present: [] },
    };
}
const localKey = () => 'ftt2_state_' + scopeId();

(async function main() {
    // ---------------- host/chat.js ----------------
    const host = makeHost();
    host.ctx.chat = [
        { is_user: true, mes: '用户发言' },
        { is_user: false, mes: '角色甲在码头发现木箱。' },
        { is_user: true, mes: '追问' },
        { is_user: false, mes: '角色乙说仓库账目对不上。' },
    ];
    host.ctx.characters = [{ name: '角色甲', avatar: 'avatar甲.png' }];
    host.ctx.characterId = 0;
    host.ctx.name2 = '角色甲';
    setContextProvider(() => host.ctx);

    const wire = wireKernelChatHooks();
    R.assert('H1 wireKernelChatHooks：消息数 / 最后楼层号 / 角色稳定键接线正确',
        wire.messages === 4 && wire.lastMessageId === 3 && wire.scopeKey === 'avatar甲.png' && currentStableCharKey() === 'avatar甲.png', wire);
    R.assert('H2 最新 AI 正文（跳过用户消息，取最后一条非用户）',
        latestAiMessageText() === '角色乙说仓库账目对不上。' && latestAiMessageText().length > 0, latestAiMessageText());
    R.assert('H3 内核口径消息数组（is_user / message 双写）', (() => {
        const list = kernelChatMessages();
        return list.length === 4 && list[1].is_user === false && list[1].message === '角色甲在码头发现木箱。' && list[1].mes === list[1].message;
    })(), kernelChatMessages().length);
    R.assert('H4 空聊天降级（-1 / 空正文；作用域仍可由 avatar 得到）', (() => {
        const keep = host.ctx.chat;
        host.ctx.chat = [];
        const r = wireKernelChatHooks();
        const dbg = kernelChatDebug();
        host.ctx.chat = keep; wireKernelChatHooks();
        return r.messages === 0 && r.lastMessageId === -1 && dbg.assistantChars === 0 && typeof r.scopeKey === 'string';
    })(), '');
    R.assert('H5 作用域键与内核 scopeId() 同源（char:<djb2>）',
        getScopeKey() === 'avatar甲.png' && /^char:[0-9a-z]+$/.test(scopeId()), scopeId());

    // ---------------- adapters/user-file.js ----------------
    R.assert('F1 slug / 文件名 / base64 往返', (() => {
        const ascii = slugify('char_abc-1');
        const cn = slugify('角色甲');
        const round = base64ToText(textToBase64('角色甲 hello 世界'));
        return ascii === 'char_abc-1' && /^n[0-9a-z]+$/.test(cn) && round === '角色甲 hello 世界'
            && stateFileName('char:abc') === 'ftt2-state-charabc.json';
    })(), [slugify('char_abc-1'), slugify('角色甲')]);

    // ---------------- adapters/store.js ----------------
    const store = { values: {} };
    setStorageHooks({
        getItem: (k) => (Object.prototype.hasOwnProperty.call(store.values, k) ? store.values[k] : null),
        setItem: (k, v) => { store.values[k] = String(v); return true; },
    });
    setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

    // S1：写入信封 + 刷新原子 h
    {
        const st = freshState(); attachKernelState(st);
        const r = await saveStateNow({ skipFile: true });
        const raw = store.values[localKey()];
        const env = raw ? JSON.parse(raw) : null;
        R.assert('S1 保存流水线：写入本机信封 + 刷新全部原子 h + 回报 via',
            r.ok === true && String(r.via).indexOf('localStorage') >= 0 && !!env && !!env.hash
            && (st.atoms || []).every(x => typeof x.h === 'string' && x.h.length > 0)
            && env.payload && env.payload.data && env.payload.data.atoms.length === 2,
            { r, keys: Object.keys(store.values), envHash: env && env.hash });
    }
    // S2：删除自动留痕随信封落盘（批次 5 的接线要求）
    {
        const st = freshState(); attachKernelState(st);
        await saveStateNow({ skipFile: true });                       // 建索引基线
        const removed = st.atoms.find(x => x.id === 'a2');
        st.atoms = st.atoms.filter(x => x.id !== 'a2');
        await saveStateNow({ skipFile: true });                       // 留痕 + 落盘
        const env = JSON.parse(store.values[localKey()]);
        const del = ((env.payload.data.deleted || {}).atoms) || {};
        const delH = ((env.payload.data.deletedH || {}).atoms) || {};
        R.assert('S2 保存流水线写「删除自动留痕」：id 墓碑 + 内容哈希墓碑随信封落盘',
            !!del.a2 && Object.keys(delH).length >= 1 && !!removed, { del, delH });
    }
    // S3：载入校验（正常可读 / 篡改即拒绝）
    {
        const st = freshState(); attachKernelState(st);
        await saveStateNow({ skipFile: true });
        const okRead = loadFromLocalStorage();
        const tampered = JSON.parse(store.values[localKey()]);
        tampered.payload.data.atoms[0].text = '被篡改的正文内容，长度足够长。';
        store.values[localKey()] = JSON.stringify(tampered);
        const badRead = loadFromLocalStorage();
        R.assert('S3 loadFromLocalStorage：正常可读、信封哈希不一致即拒绝',
            !!okRead && okRead.atoms.length === 2 && badRead === null, { ok: !!okRead, bad: badRead });
    }
    // S4：防抖保存与取消
    {
        setSaveDebounce(20);
        attachKernelState(freshState());
        const before = lastSaveInfo().at;
        scheduleSave('t1');
        const cancelled = cancelScheduledSave();
        await new Promise(r => setTimeout(r, 60));
        const notSaved = lastSaveInfo().at === before;
        scheduleSave('t2');
        await new Promise(r => setTimeout(r, 80));
        const saved = lastSaveInfo().at > before;
        setSaveDebounce(0);
        R.assert('S4 防抖保存可取消；不取消时到点写入', cancelled === true && notSaved === true && saved === true,
            { cancelled, notSaved, saved, last: lastSaveInfo() });
    }
    // S5：内核钩子接线
    {
        const info = wirePersistHooks();
        attachKernelState(freshState());
        R.assert('S5 wirePersistHooks：接线摘要与 storeStatus 可用（内核 saveState() 不会抛）',
            !!info.debounceMs && typeof storeStatus().scope === 'string' && storeStatus().scope === scopeId(), { info, status: storeStatus() });
    }
    // S6：服务端文件通道
    {
        const calls = [];
        const un = installGlobalFetch((url, opts) => {
            calls.push({ url, method: opts.method, body: opts.body });
            return { status: 200, body: { ok: true } };
        });
        const up = await uploadStateFile('ftt2-state-x.json', '{"a":1}');
        const del = await deleteStateFile('ftt2-state-x.json');
        un();
        const body = JSON.parse(calls[0].body);
        R.assert('S6 uploadStateFile / deleteStateFile 走 ST 文件端点（base64 data + /user/files/ 路径）',
            up.ok === true && del.ok === true && calls.length === 2
            && calls[0].url === '/api/files/upload' && typeof body.name === 'string' && typeof body.data === 'string'
            && calls[1].url === '/api/files/delete' && JSON.parse(calls[1].body).path.indexOf('/user/files/') === 0,
            { up, del, calls: calls.map(c => c.url) });
    }
    // S7：服务端文件载入
    {
        const st = freshState(); attachKernelState(st);
        await saveStateNow({ skipFile: true });
        const env = JSON.parse(store.values[localKey()]);
        const un = installGlobalFetch(() => ({ status: 200, text: JSON.stringify(env) }));
        const got = await loadFromServerFile();
        un();
        R.assert('S7 loadFromServerFile：读取并校验信封后返回 state',
            !!got && Array.isArray(got.atoms) && got.atoms.length === 2, got && got.atoms && got.atoms.length);
    }

    // ---------------- S8 B9-a：resetState（**与真实 V1 v1.206 黄金样本逐项比对**） ----------------
    // 黄金样本：tests/fixtures/v1-golden-reset.json（oracle = 真实 V1 插件 v1.206 直调 `resetState()`）
    {
        const G = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'v1-golden-reset.json'), 'utf8'));
        const FIXED = G.meta.fixedNow;
        const realNow = Date.now;
        const realConfirm = globalThis.confirm;
        const unFetch = installGlobalFetch(() => ({ status: 200, body: { ok: true } }));   // 服务端文件通道（不影响本段断言）

        // 与 oracle 同款的「前/后」投影
        const snap = (st) => {
            const dims = ['atoms', 'currentStates', 'snapshots', 'memories', 'items', 'currencies', 'plans', 'suspense', 'scenes',
                'concepts', 'parallels', 'plotSegments', 'rumors', 'links', 'summaries', 'processedFloors', 'repairLog', 'snapStore'];
            const out = { counts: {} };
            dims.forEach((d) => { out.counts[d] = Array.isArray(st[d]) ? st[d].length : -1; });
            out.tombIds = Object.keys((st.deleted || {}).atoms || {});
            out.tombHashes = Object.keys((st.deletedH || {}).atoms || {});
            out.deletedDims = Object.keys(st.deleted || {}).sort();
            out.deletedHDims = Object.keys(st.deletedH || {}).sort();
            out.processedFloors = clone(st.processedFloors || []);
            out.lastKnownFloor = Number(st.lastKnownFloor);
            out.stats = clone(st.stats || {});
            out.state = clone(st.state || {});
            out.protagonistKeys = Object.keys(st.protagonist || {}).sort();
            out.varsKeys = Object.keys(st.vars || {}).sort();
            out.varTemplatesKeys = Object.keys(st.varTemplates || {}).sort();
            out.repairCursorKeys = Object.keys(st.repairCursor || {}).sort();
            out.updatedAt = Number(st.updatedAt);
            return out;
        };
        const norm = (st) => { const c = clone(st); c.version = '<VERSION>'; c.scope = '<SCOPE>'; delete c.updatedAt; return c; };
        // 与 oracle 同款富状态种子（每个容器都有数据 + 双墓碑 + 台账 + 时钟）
        const seed = {
            atoms: [{ id: 'a1', title: '甲', text: '角色甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29', tags: ['码头'], validity: 'active' }],
            currentStates: [{ id: 's1', subject: '角色甲', field: '状态', value: '警觉' }],
            snapshots: [{ id: 'sn1', name: '角色甲', appearance: '短打' }],
            memories: [{ id: 'm1', title: '木箱', content: '甲记得木箱断口整齐。' }],
            items: [{ id: 'i1', name: '木箱', desc: '来源不明。' }],
            currencies: [{ id: 'c1', owner: '角色甲', kind: '大洋', amount: 12 }],
            plans: [{ id: 'p1', content: '查清木箱来源。' }],
            suspense: [{ id: 'u1', content: '木箱来源不明。' }],
            scenes: [{ id: 'sc1', name: '码头', pathStr: '城/码头' }],
            concepts: [{ id: 'cp1', name: '黑市', content: '私下交易。' }],
            parallels: [{ id: 'pa1', title: '黑市风声', text: '码头有人私下交易军械。' }],
            plotSegments: [{ id: 'pg1', range: '1919-11-01~1919-11-30', lines: ['甲发现木箱'] }],
            rumors: [{ id: 'ru1', subject: '码头', text: '有人说军械流入。' }],
            links: [{ id: 'lk1', dim: 'memories', refId: 'm1', who: '角色甲' }],
            vars: { money: 12 },
            summaries: [{ id: 'sm1', text: '前期摘要。' }],
            processedFloors: [{ f: 1, h: 'h1' }, { f: 2, h: 'h2' }],
            lastKnownFloor: 2,
            stats: { plansClosed: 2, suspenseResolved: 1 },
            deleted: { atoms: { gone1: 1700000000000 } },
            deletedH: { atoms: { hashgone: 1700000000000 } },
            repairLog: [{ at: 1, text: '旧修复记录' }],
            repairCursor: { memoriesRing: 3 },
            snapStore: [{ id: 'root1', kind: 'root', ts: '2024-01-01', atomsHashes: { a1: 'h' } }],
            state: { date: '1919-12-01', time: '夜', location: '码头', sceneFocus: '码头', present: ['角色甲'] },
            protagonist: { name: '角色甲' },
            updatedAt: FIXED,
        };
        Object.assign(kernelState() || {}, {});                       // no-op（保持可读性）
        // 种在**完整空容器**上（V1 oracle 的 `state` 亦源自 `emptyState()`；`varTemplates` 等键必须同源）
        const st0 = Object.assign(emptyState(), clone(seed));
        setKernelState(st0);
        // 基线索引对齐（否则 resetState 的删除留痕会把「本用例残留」误判为删除 —— oracle 同款处理）
        try { primeStateIndex(); } catch (e) { /* 忽略 */ }
        const before = snap(kernelState());

        Date.now = () => FIXED;
        let ret = null;
        try { ret = await resetState(); } finally { Date.now = realNow; }
        const after = snap(kernelState());
        const afterKeys = Object.keys(kernelState()).sort();

        R.assert('S8 resetState 前置状态与 oracle 种子逐项一致（计数 / 双墓碑 / 台账 / 时钟 / 游标）',
            J(before) === J(G.before), { before: before, want: G.before });

        R.assert('S9 resetState 清空全部维度容器 + 台账 + 统计 + 时钟 + 主角/变量；**抑制整批墓碑**（deleted/deletedH 为空，不生成删除留痕把对端也清掉）',
            J(after) === J(G.after) && after.deletedDims.length === 0 && after.deletedHDims.length === 0
            && after.counts.repairLog === -1 && after.updatedAt === FIXED,
            { after: after, want: G.after });

        R.assert('S10 resetState 复位后的容器键集与 V1 逐项一致（29 键，含 V1 `saveState()` 收尾 materialize 的 `snapStore`）',
            J(afterKeys) === J(G.afterKeys) && afterKeys.length === G.afterKeys.length,
            { keys: afterKeys, want: G.afterKeys });

        R.assert('S11 resetState 复位后的内存态（version/scope 归一为占位符）与 V1 `emptyState()` 深比较一致',
            J(norm(kernelState())) === J(G.stateNormalized), (() => { try { return norm(kernelState()); } catch (e) { return String(e.message); } })());

        R.assert('S12 resetState 返回值（V2 扩展）：ok=true / 落盘通道 / 清空前条目计数可回报（V1 无返回值）',
            ret && ret.ok === true && String(ret.via).indexOf('localStorage') >= 0
            && ret.cleared.total === G.before.counts.atoms + G.before.counts.currentStates + G.before.counts.snapshots + G.before.counts.memories
                + G.before.counts.items + G.before.counts.currencies + G.before.counts.plans + G.before.counts.suspense + G.before.counts.scenes
                + G.before.counts.concepts + G.before.counts.parallels + G.before.counts.plotSegments + G.before.counts.rumors
                + G.before.counts.links + G.before.counts.summaries + G.before.counts.processedFloors
            && G.returnValue.type === 'undefined',
            { ret: ret, goldenCleared: G.before.counts });

        // 幂等：再次 reset 仍为空且无墓碑（与 oracle `idempotent` 一致）
        await resetState();
        const idem = snap(kernelState());
        R.assert('S13 resetState 幂等：连续两次调用后仍是空容器且零墓碑（与 oracle `idempotent` 逐项一致）',
            idem.counts.atoms === 0 && idem.deletedDims.length === 0 && idem.deletedHDims.length === 0
            && idem.lastKnownFloor === -1 && idem.counts.processedFloors === 0
            && J(idem.counts) === J(G.idempotent.counts), { idem: idem, want: G.idempotent });

        // ---- 面板动作 `reset`（V1 同名；确认文案逐字一致 + 无对话框时不执行）----
        {
            setKernelState(Object.assign(emptyState(), clone(seed)));
            try { primeStateIndex(); } catch (e) { /* 忽略 */ }
            await panelAction('settingsSub', { sub: 'data' });
            const html = panelBodyHtml('settings');
            delete globalThis.confirm;                                  // 无对话框环境（V1 口径：不执行）
            const cancelled = await panelAction('reset', {});
            const afterCancel = (kernelState().atoms || []).length;
            let seen = '';
            globalThis.confirm = (text) => { seen = String(text); return true; };
            const done = await panelAction('reset', {});
            const note = String(((done.state || {}).note) || '');
            const emptied = (kernelState().atoms || []).length === 0 && (kernelState().deleted || {}).atoms === undefined;
            R.assert('S14 面板动作 `reset`：数据管理页按钮文案与 V1 逐字一致（🗑 清空当前角色记忆）；无对话框不执行（取消态如实提示）；确认后清空并如实回报',
                html.indexOf('data-ftt-action="reset"') >= 0 && html.indexOf('🗑 清空当前角色记忆') >= 0
                && cancelled.ok === false && String(((cancelled.state || {}).note) || '').indexOf('已取消清空') >= 0
                && afterCancel === G.before.counts.atoms
                && seen === G.confirmText
                && done.ok === true && note.indexOf('已清空当前角色的 FTT 记忆') === 0 && emptied,
                { cancelled: cancelled.state, seen: seen, note: note, want: G.confirmText });
            try { delete globalThis.confirm; } catch (e) { /* 忽略 */ }
        }
        if (realConfirm !== undefined) globalThis.confirm = realConfirm;
        unFetch();
    }

    // ---------------- S9/S10：v3.0.14「保存记忆文件执行超长时间（管线状态 2.6 万秒）」的宿主侧看门狗 ----------------
    // 用户报告（原话）：「新版本 保存记忆文件，会执行超长时间，我这边在管线状态观测到2.6万秒的提示。请修复太异常。」
    //   根因在 `core/pipeline.js`（合流 runId，见 pipeline.test.js 的 G1）；此处锁定**宿主侧两条防线**：
    //   服务端文件请求超时（挂住的 fetch 不再让保存永不结束）+ 立即保存的卡死看门狗（不再被堵死）。
    {
        const st9 = freshState();
        attachKernelState(st9);
        // ① 服务端文件请求：**永不 settle 的 fetch** + 小超时 → 如实 'timeout(…ms)'，不再永久挂着
        const prevFetch = globalThis.fetch;
        globalThis.fetch = (url, opts) => new Promise((res, rej) => {
            const sig = opts && opts.signal;
            if (sig && typeof sig.addEventListener === 'function') sig.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
        });
        const t0 = Date.now();
        const hung = await uploadStateFile('ftt2-state-x.json', '{"a":1}', { timeoutMs: 30 });
        const elapsed = Date.now() - t0;
        // ② 正常返回时**确实带了 AbortSignal**（超时机制真的接在请求上）
        let sawSignal = false;
        globalThis.fetch = (url, opts) => { sawSignal = !!(opts && opts.signal && typeof opts.signal.addEventListener === 'function'); return Promise.resolve({ status: 200, text: 'ok' }); };
        const okUp = await uploadStateFile('ftt2-state-x.json', '{"a":1}');
        globalThis.fetch = prevFetch;
        R.assert('S9 v3.0.14 服务端文件请求带超时：fetch 永不返回 → `{ok:false, error:"timeout(30ms)"}`（且立即结束，不再让「保存记忆文件」永不完成）；正常请求带 AbortSignal',
            hung.ok === false && String(hung.error).indexOf('timeout(30ms)') === 0 && elapsed < 2000
            && okUp.ok === true && sawSignal === true,
            { hung, elapsed, sawSignal });

        // ③ 保存 / 立即保存的卡死看门狗：阈值内合流（同一 Promise）、超阈值**重开一次**
        //   v3.0.15：这里改用 **IndexedDB 步骤**制造「确定性的卡死」（不依赖 fetch —— 原生文件通道可能绕过 fetch，
        //   会让「挂住」变得不确定；`localforage.setItem` 永不 resolve 则保存必然停在步骤⑤）。
        const prevLibs = host.ctx.libs;
        const warns = [];
        setPersistHooks({ warn: (m) => warns.push(String(m)) });
        host.ctx.libs = { localforage: { setItem: () => new Promise(() => { }) } };   // 保存永远卡住
        setFlushStuckMs(30);
        const p1 = flushStateNow('测试卡死', { force: true });            // force：v3.0.15 起「数据无变化」会短路，本项要测**真实保存**
        const p2 = flushStateNow('测试卡死', { force: true });             // 阈值内 → 合流（同一个 Promise）
        const coalesced = p1 === p2;
        await new Promise((r) => setTimeout(r, 60));                      // 超过阈值 → 视为卡死
        host.ctx.libs = { localforage: { setItem: async () => true } };   // 恢复：证明「重开的这一次」真的能落盘
        const p3 = flushStateNow('测试卡死', { force: true });
        const reopened = p3 !== p1;
        // 新开的这次应立刻落盘成功（不再被卡死的旧 Promise 堵住）；两层看门狗各留一条告警。
        // 注意：**必须在等待之后**才把阈值还原 —— 保存层的判卡死发生在微任务里，
        //   提前还原（阈值回 60s）会让它误判「还没卡死」而去合流那个永不 settle 的旧保存。
        const done3 = await Promise.race([p3, new Promise((r) => setTimeout(() => r({ ok: false, error: 'still-stuck' }), 2000))]);
        setFlushStuckMs(FLUSH_STUCK_MS);
        host.ctx.libs = prevLibs;
        R.assert('S10 v3.0.14/v3.0.15 保存看门狗：阈值内两次 flush 合流为一个 Promise；超过阈值即判卡死 → **保存层与立即保存层都重开**（不再被永不 settle 的 Promise 堵死），新开的一次落盘成功，且各留一条「疑似卡死」告警',
            coalesced === true && reopened === true && !!done3 && done3.ok === true
            && warns.some((m) => m.indexOf('立即保存超过') >= 0 && m.indexOf('疑似卡死') >= 0)
            && warns.some((m) => m.indexOf('上一次保存超过') >= 0 && m.indexOf('疑似卡死') >= 0),
            { coalesced, reopened, done3, warns });
    }

    // ---------------- S11–S13：v3.0.15「上次更新后特别卡顿（尤其正文保存）」的性能修复 ----------------
    // 用户报告（原话）：「新版本 上次版本更新后特别卡顿，尤其是在正文保存或其他环节，无报错，但可能会直接卡死。」
    //   实测（2000 情节容器 = 1.3MB 信封）：一次保存的**同步**耗时里 base64 编码 151ms（旧逐字节拼接）、
    //   全量索引建了两遍各 ~38ms、`storageHash` 66ms 等 —— 每次事件驱动的保存都会阻塞主线程数百毫秒。
    {
        // ① base64：新实现（分块 / Buffer）必须与旧实现（逐字节拼接）**逐字节一致**
        const samples = ['', 'ascii', '中文·多字节字符与 emoji 🐋 混排', 'x'.repeat(200000)];
        const oldB64 = (str) => {
            const b = new TextEncoder().encode(String(str));
            let bin = '';
            for (const x of b) bin += String.fromCharCode(x);
            return btoa(bin);
        };
        const same = samples.every((x) => {
            const a1 = textToBase64(x);
            const a2 = oldB64(x);
            try { if (typeof Buffer === 'function') { const b3 = Buffer.from(String(x), 'utf8').toString('base64'); return a1 === a2 && b3 === a2; } } catch (e) { /* 无 Buffer */ }
            return a1 === a2;
        });
        R.assert('S11 v3.0.15 base64 编码改**分块 fromCharCode**（旧实现逐字节拼接，1.3MB 实测 151ms → 16ms）：空串 / ASCII / 多字节与 emoji / 200KB 长文本的编码结果与旧实现**逐字节一致**（含 Buffer 环境）',
            same === true && textToBase64('中文') === oldB64('中文'), { ok: same });

        // ② 「数据无变化 → 保存短路」：事件驱动的空保存（每次生成结束都会触发一次）不再做任何重活
        const st12 = freshState();
        attachKernelState(st12);
        const keepSyncOnSave = !!(cfg.storage && cfg.storage.syncOnSave);
        if (cfg.storage) cfg.storage.syncOnSave = false;               // 关掉「保存后镜像」：镜像内的 saveState 会再写一次容器，计数无法隔离
        const sName12 = stateFileName(scopeId());
        let up12 = 0;
        const un12 = installGlobalFetch((url, opts) => {
            try { const b = JSON.parse((opts && opts.body) || '{}'); if (String(b.name) === sName12) up12++; } catch (e) { /* 忽略 */ }
            return { status: 200, text: 'ok' };
        });
        markDataTouched();
        const full1 = await saveStateNow({ reason: 'S12-首次' });
        const at1 = Number((lastSaveInfo() || {}).at);
        const u1 = up12;
        const noop = await saveStateNow({ reason: 'S12-无变化' });
        const u2 = up12;
        const atNoop = Number((lastSaveInfo() || {}).at);
        markDataTouched();                                             // 数据又动了 → 必须真保存
        const full2 = await saveStateNow({ reason: 'S12-有变化' });
        const u3 = up12;
        markDataTouched();
        setSaveNoopWindowMs(0);                                        // 窗口=0 → 一律完整保存（自愈路径）
        const full3 = await saveStateNow({ reason: 'S12-窗口外' });
        setSaveNoopWindowMs(SAVE_NOOP_WINDOW_MS);
        markDataTouched();
        const forced = await saveStateNow({ reason: 'S12-force', force: true });
        const u4 = up12;
        un12();
        if (cfg.storage) cfg.storage.syncOnSave = keepSyncOnSave;
        R.assert('S12 v3.0.15「数据无变化」的保存**走短路**（`skipped:no-change`：不再算索引 / 建信封 / base64 / 上传，主记忆文件一次都不写）：首次与「有变化」时真写；`force` 与窗口外一律完整保存',
            full1.ok === true && u1 >= 1 && full1.via.indexOf('file') >= 0 && at1 > 0
            && noop.ok === true && noop.skipped === 'no-change' && u2 === u1 && atNoop === at1
            && full2.ok === true && u3 > u1                          // 数据动过 → 真写
            && full3.ok === true && u4 > u3                          // 窗口外 → 真写
            && forced.ok === true && forced.via !== 'noop',
            { full1, noop, full2, full3, forced, uploads: [u1, u2, u3, u4], at1, atNoop });

        // ③ 并发保存**合流**：同一时刻只开**一行**「保存记忆文件」，也只做一次完整保存
        const st13 = freshState();
        attachKernelState(st13);
        const keepSyncOnSave13 = !!(cfg.storage && cfg.storage.syncOnSave);
        if (cfg.storage) cfg.storage.syncOnSave = false;
        const PL13 = await import('../../core/pipeline.js');
        // S10 故意留下一个**卡死的保存行**（同标签）—— 若不清空，新保存会与它合流（join 同标签），
        //   行数增量就观察不到了。这里先清空运行表（只影响读数，不影响在途 Promise）。
        PL13.resetPipeline();
        const saveRows = () => PL13.listPipelineRuns().filter((r) => r.label === '保存记忆文件').length;
        let midTouch = false;                                          // 保存**期间**再改数据 → 结束后必须补跑一次
        const sName13 = stateFileName(scopeId());
        let up13 = 0;
        const un13 = installGlobalFetch((url, opts) => {
            try { const b = JSON.parse((opts && opts.body) || '{}'); if (String(b.name) === sName13) { up13++; if (midTouch) markDataTouched(); } } catch (e) { /* 忽略 */ }
            return { status: 200, text: 'ok' };
        });
        markDataTouched();
        const q1 = saveStateNow({ reason: 'S13-A', force: true });
        const n1 = saveRows();                                         // 第一路 → 1 行
        const q2 = saveStateNow({ reason: 'S13-B', force: true });
        const n2 = saveRows();                                         // 第二路**合流** → 仍是 1 行（不再开新行、不再写一遍）
        const r1 = await q1, r2 = await q2;
        await new Promise((r) => setTimeout(r, 400));                   // 等流水线内部的派生保存（②b 快照维护）收尾
        const n3 = saveRows();                                          // 收尾后 0 行
        const joined = up13;                                            // 并发两路 → 合流后只写 1 次（派生补跑至多再 1 次）
        midTouch = true;
        markDataTouched();
        const q3 = saveStateNow({ reason: 'S13-C', force: true });
        const q4 = saveStateNow({ reason: 'S13-D', force: true });      // 保存期间数据又变 → 结束后补跑一次
        const r3 = await q3, r4 = await q4;
        await new Promise((r) => setTimeout(r, 80));
        const rerunUploads = up13 - joined;
        un13();
        if (cfg.storage) cfg.storage.syncOnSave = keepSyncOnSave13;
        midTouch = false;
        R.assert('S13 v3.0.15 并发保存**合流**：两次并发 `saveStateNow` 只开一行「保存记忆文件」、只写一次主记忆文件（两个调用方拿到同一结果），收尾后该行消失；若保存**期间**数据又变了，结束后补跑一次（不丢最后一次变更）',
            n1 === 1 && n2 === 1 && n3 === 0 && joined >= 1 && joined <= 2
            && r1.ok === true && r1.via.indexOf('file') >= 0 && J(r1) === J(r2) && J(r3) === J(r4)
            && rerunUploads === 2,
            { n1, n2, n3, joined, rerunUploads });

        // ④ P4：索引交接后**墓碑仍照常留痕**（删条目 → 保存 → 写进 deleted 账本）
        const st14 = freshState();
        attachKernelState(st14);
        primeStateIndex();                                             // 基线 = 当前三条
        const keep = st14.atoms.slice();
        st14.atoms = st14.atoms.filter((x) => x.id !== 'a2');           // 删一条
        markDataTouched();
        await saveStateNow({ reason: 'S14-删除', force: true });
        const tomb = !!((st14.deleted || {}).atoms && (st14.deleted.atoms.a2 || (st14.deletedH || {}).atoms));
        st14.atoms = keep;
        primeStateIndex();
        R.assert('S14 v3.0.15 保存流水线把「刚建好的索引」交给墓碑扫复用（不再全量哈希两遍）后，**删除留痕照常工作**：删掉一条情节 → 保存 → `deleted.atoms` 出现该 id 墓碑',
            tomb === true, { deleted: st14.deleted });
    }

    setContextProvider(null);
    setKernelState(null);
    R.done();
})().catch(e => { console.error('❌ store-chat.test.js 异常中断:', e); process.exit(1); });
