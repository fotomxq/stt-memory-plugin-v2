// ============================================================
// 单元测试 · P2 宿主层（host/chat.js 聊天接线 + adapters/store.js 保存流水线 + adapters/user-file.js 文件通道）
// 重点：保存流水线必须复刻 V1 `saveState()` 顺序（刷新原子 h → 删除自动留痕 → 写库）——
//   批次 5 的黄金样本已证明「内容哈希墓碑由该流水线写入」。本文件全部断言均为 await 后的真实条件
//   （不使用「Promise && true」这类恒真写法）。
// ============================================================
import { makeReporter, makeHost, installGlobalFetch } from '../harness/st-mock.js';
import { setContextProvider } from '../../host/st-api.js';
import { wireKernelChatHooks, kernelChatMessages, latestAiMessageText, currentLastMessageId, currentStableCharKey, attachKernelState, kernelChatDebug } from '../../host/chat.js';
import { saveStateNow, scheduleSave, cancelScheduledSave, loadFromLocalStorage, loadFromServerFile, wirePersistHooks, setStorageHooks, setSaveDebounce, storeStatus, lastSaveInfo } from '../../adapters/store.js';
import { slugify, stateFileName, textToBase64, base64ToText, uploadStateFile, deleteStateFile } from '../../adapters/user-file.js';
import { setKernelState, getScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { scopeId } from '../../core/state.js';

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

    setContextProvider(null);
    setKernelState(null);
    R.done();
})().catch(e => { console.error('❌ store-chat.test.js 异常中断:', e); process.exit(1); });
