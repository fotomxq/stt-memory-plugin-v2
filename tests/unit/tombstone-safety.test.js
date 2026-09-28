import { makeReporter, makeHost, makeDocument, installGlobalHost } from '../harness/st-mock.js';
import { cfg, state, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { applyDeletedToArray } from '../../core/sweep.js';
import { atomIdentityHash } from '../../core/model/hash.js';
// 墙钟口径：`entryWallMs` 只认 > 1e12 的 `updatedAt`（毫秒墙钟）
const T = Date.now();
const R = makeReporter('tombstone-safety v2.91.0 内容墓碑保守判据');
const A = (n,c,e)=>R.assert(n,!!c,e);
const doc=makeDocument(['ftt-panel']); doc.body={insertAdjacentHTML(){},addEventListener(){}}; installGlobalHost(makeHost({chat:[]}),doc);
Object.assign(cfg, JSON.parse(JSON.stringify(defaultCfg))); setScopeKey('t'); setKernelState(emptyState()); setPersistHooks({saveState:()=>true,saveCfg:()=>true,log:()=>{},warn:()=>{}});
const atom = { id:'a_new', title:'码头交货', date:'1919-11-20', text:'甲把铜箱交给乙。', locations:['码头'], tags:['交易'] };
const h = atomIdentityHash('atoms', atom);
const delH = { atoms: { [h]: Date.now() } };
A('A1 无墙钟时间的条目：**不再被内容墓碑删除**（跨端同步/旧存档高危路径，改为只认同 id 墓碑）', (() => {
  const r = applyDeletedToArray('atoms', [Object.assign({}, atom)], {}, {}, delH, {}, false);
  return r.arr.length === 1 && r.arr[0].id === 'a_new';
})(), '见断言');
A('A2 有墙钟且**早于**墓碑：仍按内容墓碑删除（原有语义不变）', (() => {
  const old = Object.assign({}, atom, { updatedAt: T - 1000 });
  const r = applyDeletedToArray('atoms', [old], {}, {}, { atoms: { [h]: T } }, {}, false);
  return r.arr.length === 0;
})(), '见断言');
A('A3 有墙钟且**晚于**墓碑：保留并作废该内容墓碑（删除后重写）', (() => {
  const nw = Object.assign({}, atom, { updatedAt: T + 1000 });
  const r = applyDeletedToArray('atoms', [nw], {}, {}, { atoms: { [h]: T } }, {}, false);
  return r.arr.length === 1 && !r.delH[h];
})(), '见断言');
A('A4 id 墓碑不受影响：无墙钟也照删（删除动作仍需生效）', (() => {
  const r = applyDeletedToArray('atoms', [Object.assign({}, atom)], { atoms: { a_new: Date.now() } }, {}, {}, {}, false);
  return r.arr.length === 0;
})(), '见断言');
R.done();
