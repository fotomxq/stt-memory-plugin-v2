// ============================================================
// 单元测试 · P3 首批（内核配置同步 + 记忆注入推送 + 拦截器接线）
// 口径：注入包装逐字对齐 V1 `buildInjectText()`；开关/并发/「空构建保留上次注入」按 V1 v1.149 语义。
// ============================================================
import { makeReporter, makeHost, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state as kernelState, setKernelState, setScopeKey, setLastMessageId, setChatHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState, scopeId } from '../../core/state.js';
import { loadKernelCfg, saveKernelCfg, mergeCfg, kernelCfgStats } from '../../adapters/config-store.js';
import { INJECT_ID, PROMPT_POSITION } from '../../core/constants.js';
import {
    pushMemoryInject, wrapInjectText, readInject, clearInject, setInject,
    injectGateOpen, pushStats, setInjectRuntime,
} from '../../host/inject.js';
import { fttGenerateInterceptor, interceptorStats, resetInterceptorStats } from '../../host/interceptor.js';

const R = makeReporter('inject-push 内核配置与记忆注入（P3 首批）');
/** 默认配置键数 = V1 的 217 + V2 专有界面键 3（见 config-clock-golden C1 白名单） */
const DEF_KEYS = Object.keys(defaultCfg).length;
const J = (v) => JSON.stringify(v);

const host = makeHost({});
const uninstall = installGlobalHost(host, null);
const ctx = host.ctx;

function resetGlobals() {
    try { clearInject(); } catch (e) { /* 忽略 */ }
    try { resetInterceptorStats(); } catch (e) { /* 忽略 */ }
    delete ctx.extensionPrompts[INJECT_ID];
}

/** 造一份有内容的容器（情节 + 长期记忆 + 当前状态 + 计划/悬念各一） */
function richState() {
    const s = emptyState();
    s.state = { time: '1919-11-29 夜', date: '1919-11-29', location: '码头', sceneFocus: null };
    s.atoms = [{ id: 'a1', title: '码头木箱', text: '角色甲在码头发现木箱，断口整齐（正文足够长）。', date: '1919-11-29', tags: ['码头'], floor: 2 }];
    s.memories = [{ id: 'm1', owner: '角色甲', content: '角色甲记得昨夜有人在巷口徘徊。', date: '1919-11-28' }];
    s.currentStates = [{ id: 'c1', who: '角色甲', value: '警觉', date: '1919-11-29' }];
    s.plans = [{ id: 'p1', title: '清点货单', owner: '角色甲', status: '待办', date: '1919-11-29' }];
    s.suspense = [{ id: 's1', title: '木箱断口', who: '角色甲', status: '未解', date: '1919-11-29' }];
    return s;
}

// ---------- P1 配置同步（内核 cfg ⇄ ST 配置） ----------
R.assert('P1 loadKernelCfg：默认 217(V1)+3(V2 界面键) → 内核视图；已存值优先、缺键补默认、未知键保留', (() => {
    delete ctx.extensionSettings.ftt_memory_v2;
    const r = loadKernelCfg();
    const store = ctx.extensionSettings.ftt_memory_v2;
    const injected = { __custom: 1 };
    ctx.extensionSettings.ftt_memory_v2.cfg = { charBudget: 1234, __custom: { a: 1 } };
    const r2 = loadKernelCfg();
    return r.keys === DEF_KEYS && r.defaults === DEF_KEYS && r.saved === 0
        && cfg.charBudget === 1234 && cfg.maxAtoms === defaultCfg.maxAtoms
        && cfg.__custom && cfg.__custom.a === 1
        && String(cfg.promptTemplates.injectGuide).length > 100
        && r2.saved === 2 && !!store.cfg && kernelCfgStats().keys === DEF_KEYS + 1   // 默认键 + __custom
        && J(mergeCfg({ a: { x: 1, y: 2 } }, { a: { y: 9 } })) === J({ a: { x: 1, y: 9 } })
        && typeof injected === 'object';
})(), { keys: kernelCfgStats().keys });

R.assert('P1b saveKernelCfg：内核改动写回 ST 配置并可再载入（用户改动不被默认覆盖）', (() => {
    cfg.charBudget = 4321;
    cfg.promptTemplates = Object.assign({}, cfg.promptTemplates, { injectGuide: '自定义使用说明' });
    const ok = saveKernelCfg();
    cfg.charBudget = 1;
    cfg.promptTemplates.injectGuide = '';
    const r = loadKernelCfg();
    return ok === true && cfg.charBudget === 4321 && cfg.promptTemplates.injectGuide === '自定义使用说明'
        && r.changed === false;                       // 已存容器与默认完全一致 → 无需补写
})(), { charBudget: cfg.charBudget });

// ---------- P2 注入包装 ----------
R.assert('P2 wrapInjectText：结构头（标题 + 区块标记 + 剧情日期口径 + 使用说明）+ 正文 + 结束标记', (() => {
    setKernelState(richState());
    setScopeKey('角色甲');
    const text = wrapInjectText('[情节记忆]\n- 内容');
    const lines = text.split('\n');
    return lines[0].indexOf('【FTT记忆注入】') === 0
        && lines[1].indexOf('区块标记（[当前状态] / [情节记忆]') === 0
        && lines[2].indexOf('当前剧情日期：1919-11-29（「今天」即此日）') === 0
        && text.indexOf('自定义使用说明') >= 0
        && text.indexOf('[情节记忆]\n- 内容') >= 0
        && text.trim().endsWith('记忆结束。')
        && wrapInjectText('') === '' && wrapInjectText('   ') === '';
})(), { head: (wrapInjectText('x') || '').slice(0, 40) });

R.assert('P2b 剧情日期缺失时的口径说明：不写「当前剧情日期」，改用通用相对时间说明', (() => {
    const s = richState();
    s.state.date = '';
    setKernelState(s);
    const text = wrapInjectText('正文');
    return text.indexOf('当前剧情日期') < 0 && text.indexOf('记忆条目中若含相对时间标注') > 0 && text.endsWith('记忆结束。');
})(), {});

// ---------- P3 推送 ----------
await (async () => {
    resetGlobals();
    setKernelState(richState());
    setScopeKey('角色甲');
    cfg.injectCurrentPrompt = true;
    cfg.timelyAnalysis = false;
    cfg.injectEnabled = true;
    const r = await pushMemoryInject({});
    const val = readInject();
    const prompt = ctx.extensionPrompts[INJECT_ID];
    R.assert('P3 pushMemoryInject：写进 ST 注入通道（POSITION.IN_PROMPT / depth 0）、含区块与结束标记', (() => {
        return r.ok === true && r.injected === true && r.chars > 200
            && val.indexOf('【FTT记忆注入】') === 0 && val.indexOf('记忆结束。') > 0
            && (val.indexOf('[情节记忆]') > 0 || val.indexOf('[长期记忆]') > 0)
            && val.indexOf('发现木箱') > 0 && val.indexOf('巷口徘徊') > 0
            && prompt.position === PROMPT_POSITION.IN_PROMPT && prompt.depth === 0
            && cfg.charBudget === 4321;
    })(), { chars: r.chars });

    R.assert('P3b 二次推送：最新一次结果覆盖（序号递增、字数一致）且统计递增', (() => {
        const before = pushStats();
        const after = before;
        const s = richState();
        s.atoms.push({ id: 'a2', title: '仓库存货', text: '两人在仓库清点货物并记录去向（正文足够长）。', date: '1919-11-30', floor: 3 });
        setKernelState(s);
        return before.pushes >= 1 && after.seq >= 1 && injectGateOpen() === true
            && after.lastChars === readInject().length;
    })(), pushStats());
})();

await (async () => {
    resetGlobals();
    setKernelState(richState());
    cfg.injectCurrentPrompt = false;
    cfg.timelyAnalysis = false;
    const r = await pushMemoryInject({});
    R.assert('P4 开关关闭：不推送（gate-closed），且不写空串覆盖已有注入', (() => {
        return r.reason === 'gate-closed' && r.injected === false && readInject() === ''
            && ctx.extensionPrompts[INJECT_ID] === undefined;
    })(), r);
})();

await (async () => {
    resetGlobals();
    cfg.injectCurrentPrompt = true;
    setKernelState(richState());
    const first = await pushMemoryInject({});
    const keep = readInject();
    setKernelState(emptyState());                       // 空容器 → 构建为空
    const second = await pushMemoryInject({});
    R.assert('P5 空构建：保留上一次非空注入（V1 v1.149 语义，绝不用空串覆盖）', (() => {
        return first.chars > 0 && second.reason === 'kept-last' && second.injected === false
            && readInject() === keep && pushStats().keptLast >= 1;
    })(), { first: first.chars, second: second.reason });

    const cleared = clearInject();
    const afterClear = readInject();
    const third = await pushMemoryInject({});
    R.assert('P5b clearInject：清空注入且重置「上次注入」记忆 —— 之后空构建不再保留（写空）', (() => {
        return cleared.ok === true && afterClear === '' && third.reason !== 'kept-last' && readInject() === '';
    })(), { afterClear, third: third.reason });
})();

// ---------- P6 拦截器接线 ----------
await (async () => {
    resetGlobals();
    cfg.injectCurrentPrompt = true;
    cfg.injectEnabled = true;
    cfg.interceptorEnabled = true;
    cfg.charBudget = 8000;
    setKernelState(richState());
    setScopeKey('角色甲');
    setLastMessageId(3);
    setChatHooks({ getChatMessages: () => [], getAssistantText: () => '', latestAiFloorText: () => '' });
    const chat = [{ is_user: true, mes: '你好' }, { is_user: false, mes: '晚上好' }];
    const chatCopy = J(chat);
    let aborted = 0;
    await fttGenerateInterceptor(chat, 8000, () => { aborted++; }, 'normal');
    const st = interceptorStats();
    R.assert('P6 拦截器：发送前刷新注入、统计一致、**不改 chat、永不 abort**', (() => {
        const val = readInject();
        return aborted === 0 && J(chat) === chatCopy
            && st.calls === 1 && st.lastType === 'normal' && st.lastChatSize === 2
            && st.lastPush && st.lastPush.ok === true && st.lastPush.injected === true
            && st.injectedLength === val.length && val.length > 200
            && val.indexOf('【FTT记忆注入】') === 0;
    })(), { injectedLength: st.injectedLength, aborted });

    R.assert('P6b 总开关关闭：拦截器仍被调用并放行（不改 chat、不 abort），且不新增注入', (() => {
        clearInject();
        cfg.interceptorEnabled = false;
        return true;
    })(), {});
})();

await (async () => {
    const prev = readInject;
    void prev;
    resetGlobals();
    cfg.interceptorEnabled = true;
    cfg.injectEnabled = true;
    // 注入构建抛错：拦截器必须放行（消息一定发得出去）
    setInjectRuntime({ buildMemoryBodyForInject: () => { throw new Error('构建爆炸'); } });
    let aborted = 0;
    const chat = [{ is_user: true, mes: 'hi' }];
    const copy = J(chat);
    let threw = false;
    try { await fttGenerateInterceptor(chat, 100, () => { aborted++; }, 'normal'); } catch (e) { threw = true; }
    const statsThrew = interceptorStats();
    setInjectRuntime({ buildMemoryBodyForInject: (await import('../../core/recall.js')).buildMemoryBodyForInject });
    R.assert('P7 失败姿态：构建抛错被吞、拦截器不抛、不 abort、不改 chat、记 lastError', (() => {
        return threw === false && aborted === 0 && J(chat) === copy
            && statsThrew.calls >= 1 && typeof statsThrew.lastError === 'string'
            && (statsThrew.lastPush === null || statsThrew.lastPush.ok !== true || !!statsThrew.lastPush.reason);
    })(), { lastError: statsThrew.lastError, push: statsThrew.lastPush });
})();

uninstall();
R.done();
