// ============================================================
// 单元测试 · host/interceptor（生成前钩子：永不 abort、可观测、全局挂载）
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { fttGenerateInterceptor, installGlobalInterceptor, uninstallGlobalInterceptor, interceptorStats, resetInterceptorStats } from '../../host/interceptor.js';
import { VERSION, INJECT_ID } from '../../core/constants.js';

const R = makeReporter('host-interceptor 生成前钩子');

resetInterceptorStats();
let aborted = false;
const abort = () => { aborted = true; };

const before = interceptorStats();
await fttGenerateInterceptor([{ mes: 'a' }, { mes: 'b' }], 4096, abort, 'normal');
const after = interceptorStats();
R.assert('I1 调用被记录（次数/类型/chat 长度/上下文）',
    after.calls === before.calls + 1 && after.lastType === 'normal' && after.lastChatSize === 2 && after.lastContextSize === 4096,
    { after, before });
R.assert('I2 永不调用 abort（硬规则：消息必须发得出去）', aborted === false, aborted);
R.assert('I3 统计含版本与注入键', after.version === VERSION && after.injectKey === INJECT_ID, after);

await fttGenerateInterceptor(undefined, undefined, abort, undefined);
const g = interceptorStats();
R.assert('I4 非法入参不抛异常并安全记录', g.lastChatSize === -1 && g.lastContextSize === 0 && g.lastType === '', g);

await fttGenerateInterceptor([], 0, abort, 'quiet');
R.assert('I5 quiet 类型也如实记录（放行决策交给上层）', interceptorStats().lastType === 'quiet', interceptorStats());

R.assert('I6 全局挂载/卸载（manifest 按名字查找全局函数）', (() => {
    installGlobalInterceptor();
    const ok = typeof globalThis.fttGenerateInterceptor === 'function' && globalThis.fttGenerateInterceptor === fttGenerateInterceptor;
    uninstallGlobalInterceptor();
    const gone = globalThis.fttGenerateInterceptor === undefined;
    return ok && gone;
})(), typeof globalThis.fttGenerateInterceptor);
R.assert('I7 卸载后再次调用钩子本体仍安全（不依赖全局）', (() => {
    resetInterceptorStats();
    return fttGenerateInterceptor([], 1, abort, 'swipe') instanceof Promise && interceptorStats().calls === 1;
})(), '');

R.done();
