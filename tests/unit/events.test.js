// ============================================================
// 单元测试 · host/events（事件绑定与解绑、缺能力降级）
// ============================================================
import { makeReporter, makeHost } from '../harness/st-mock.js';
import { setContextProvider, resetContextProvider } from '../../host/st-api.js';
import { bindCoreEvents, eventTypeAvailability } from '../../host/events.js';
import { HOST_EVENTS } from '../../core/constants.js';

const R = makeReporter('host-events 事件绑定');

const host = makeHost();
setContextProvider(() => host.ctx);

let hits = { ended: 0, changed: 0 };
const b = bindCoreEvents({
    GENERATION_ENDED: () => { hits.ended++; },
    CHAT_CHANGED: () => { hits.changed++; },
});
R.assert('E1 只绑定显式提供的事件（未提供的跳过，不报缺失）',
    b.bound.length === 2 && b.bound.indexOf('GENERATION_ENDED') >= 0 && b.bound.indexOf('CHAT_CHANGED') >= 0 && b.missing.length === 0,
    b);
R.assert('E2 事件派发命中处理函数', (() => {
    host.emit('GENERATION_ENDED');
    host.emit('CHAT_CHANGED');
    host.emit('MESSAGE_RECEIVED');
    return hits.ended === 1 && hits.changed === 1;
})(), hits);
R.assert('E3 unbind 后不再派发', (() => {
    b.unbind();
    host.emit('GENERATION_ENDED');
    return hits.ended === 1;
})(), hits);
R.assert('E4 事件常量可用性清单（九事件）', (() => {
    const list = eventTypeAvailability();
    return list.length === HOST_EVENTS.length && list.every(x => x.available === true);
})(), eventTypeAvailability());

const bare = makeHost({ noEventSource: true });
setContextProvider(() => bare.ctx);
const b2 = bindCoreEvents({ GENERATION_ENDED: () => { } });
R.assert('E5 无事件源时如实报缺失且不抛异常', b2.bound.length === 0 && b2.missing.length === 1 && b2.missing[0] === 'GENERATION_ENDED', b2);

resetContextProvider();
R.done();
