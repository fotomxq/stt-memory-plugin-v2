// ============================================================
// 单元测试 · P2 宿主层（host/chat.js 聊天接线 + adapters/store.js 保存流水线 + adapters/user-file.js 文件通道）
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
import { saveStateNow, scheduleSave, cancelScheduledSave, loadFromLocalStorage, loadFromServerFile, wirePersistHooks, setStorageHooks, setSaveDebounce, storeStatus, lastSaveInfo, resetState, primeStateIndex } from '../../adapters/store.js';
import { slugify, stateFileName, textToBase64, base64ToText, uploadStateFile, deleteStateFile } from '../../adapters/user-file.js';
import { setKernelState, getScopeKey, setPersistHooks, kernelState } from '../../core/model/runtime.js';
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

    setContextProvider(null);
    setKernelState(null);
    R.done();
})().catch(e => { console.error('❌ store-chat.test.js 异常中断:', e); process.exit(1); });
