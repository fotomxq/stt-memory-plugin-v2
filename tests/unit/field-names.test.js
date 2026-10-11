// ============================================================
// 单元测试 · v3.44.0 `docs/D22` W4 **`数-10`** —— 字段名与字段集统一
//   设计：`docs/D20` §3.4 / §8 `数-10`（「同一语义 4 种日期字段名」→ 迁移期写规范化字段；体检两项；瘦身白名单同步）
//   实现：`core/field-names.js`（登记表 + 规范化）· `core/migrate.js`（载入期双写）· `core/entry-meta.js`（写入期补写）
//
// 本文件锁四件事：
//   ① **语义 → 规范名唯一**：`lastSeenDate`（日期形态）/ `lastSeenFloor`（楼层形态）；旧名只读兼容；
//   ② **只补不覆盖 + 幂等**：规范名已有值一律不动；重复迁移不再产生变化（`changed=false`）；
//   ③ **不改任何哈希**：两个规范名都**不在** `HASH_FIELDS` / `IDENTITY_FIELDS`（跨端聚合与内容哈希零影响）；
//   ④ **写入期即补写**：新入库条目（走 `preserveEntryMeta`）立刻带规范名，不必等下次载入。
//
// 运行：node tests/unit/field-names.test.js
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { cfg, setKernelState, setScopeKey, setPersistHooks } from '../../core/model/runtime.js';
import { defaultCfg } from '../../core/config.js';
import { emptyState } from '../../core/state.js';
import { migrateState, lastHealInfo } from '../../core/migrate.js';
import { preserveEntryMeta } from '../../core/entry-meta.js';
import {
    ATTRIBUTION_FIELD, FIELD_NAME_DIMS, LAST_SEEN_DATE_FIELD, LAST_SEEN_FLOOR_FIELD,
    attributionMissing, canonicalizeEntryFields, legacyNameGaps, seenDateOf, seenFloorOf,
} from '../../core/field-names.js';
import { HASH_FIELDS, IDENTITY_FIELDS, slimWhitelistOf, NON_HASH_CANONICAL_FIELDS } from '../../core/model/hashfields.js';
import { slimEntryForStorage, hydrateSlimEntry, SLIM_SYNONYM_GROUPS } from '../../core/slim.js';

const R = makeReporter('field-names v3.44.0 字段名规范（D22 W4 数-10）');
const A = (n, c, e) => R.assert(n, !!c, e);
const J = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

Object.assign(cfg, clone(defaultCfg));
setScopeKey('甲');
setPersistHooks({ saveState: () => true, saveCfg: () => true, log: () => undefined, warn: () => undefined });

const SEED = () => Object.assign(emptyState(), {
    items: [{ id: 'i1', name: '钥匙', desc: '铜制，齿口磨损。', seenDate: '1919-05-01' }],
    scenes: [{ id: 'sc1', name: '码头', desc: '货箱堆得很高。', floorSeen: 7 }],
    atoms: [{ id: 'a1', title: '甲', text: '甲在码头发现木箱。', date: '1919-11-29' }],
});

// ---------- ① 语义 → 规范名 ----------
A('F1 登记表：需要规范化的维度只有 items（日期形态）与 scenes（楼层形态）；读取一律**规范名优先、旧名回退**', (() => {
    const it = { seenDate: '1919-05-01', lastSeenDate: '1919-06-02' };
    const sc = { floorSeen: 7, lastSeenFloor: 9 };
    return J(FIELD_NAME_DIMS.slice().sort()) === J(['items', 'scenes'])
        && seenDateOf('items', it) === '1919-06-02'                     // 规范名优先
        && seenDateOf('items', { seenDate: '1919-05-01' }) === '1919-05-01'   // 旧名回退
        && seenDateOf('items', { date: '1919-01-01' }) === '1919-01-01'       // 二级回退（V1 的 date 别名）
        && seenDateOf('items', {}) === ''
        && seenFloorOf('scenes', sc) === 9 && seenFloorOf('scenes', { floorSeen: 3 }) === 3 && seenFloorOf('scenes', {}) === 0;
})(), J({ dims: FIELD_NAME_DIMS }));

A('F2 缺口判定（体检口径）：只有「旧名有值 且 规范名为空」才算缺口；空值不算异常', (() => {
    const g1 = legacyNameGaps('items', { seenDate: '1919-05-01' });
    const g2 = legacyNameGaps('items', { seenDate: '1919-05-01', lastSeenDate: '1919-05-01' });
    const g3 = legacyNameGaps('items', { seenDate: '' });
    const g4 = legacyNameGaps('scenes', { floorSeen: 7 });
    const g5 = legacyNameGaps('scenes', { floorSeen: 7, lastSeenFloor: 7 });
    return g1.date === true && g2.date === false && g3.date === false && g4.floor === true && g5.floor === false;
})(), '');

A('F3 归属缺失（`chatKey`）：只判定不改写 —— `attributionMissing` 是纯函数，模块里**没有任何回填**（约定「只打不推断」）', (() => {
    const miss = attributionMissing({ id: 'a1' });
    const has = attributionMissing({ id: 'a1', chatKey: 'c1' });
    const empty = attributionMissing({ id: 'a1', chatKey: '  ' });
    return miss === true && has === false && empty === true && ATTRIBUTION_FIELD === 'chatKey';
})(), '');

// ---------- ② 双写：只补不覆盖 + 幂等 ----------
A('F4 规范化：旧名 → 规范名**双写**，旧名保留；规范名已有值（即使与旧名不同）一律不动', (() => {
    const a = { seenDate: '1919-05-01' };
    const b = canonicalizeEntryFields('items', a);
    const c = { seenDate: '1919-05-01', lastSeenDate: '1919-09-09' };
    canonicalizeEntryFields('items', c);
    const d = { floorSeen: 7 };
    canonicalizeEntryFields('scenes', d);
    const e = { floorSeen: 0 };                     // 0 = 未记录 → 不写（写 0 与「没这个字段」无法区分）
    const f = { x: 1 };                             // 无关维度 → 不动
    const g = canonicalizeEntryFields('atoms', f);
    return b.changed === true && J(b.written) === J(['lastSeenDate'])
        && a.seenDate === '1919-05-01' && a.lastSeenDate === '1919-05-01'          // 旧名保留 + 规范名补上
        && c.lastSeenDate === '1919-09-09'                                        // 不覆盖
        && d.lastSeenFloor === 7 && d.floorSeen === 7
        && e.lastSeenFloor === undefined
        && g.changed === false && f.lastSeenDate === undefined;
})(), '');

A('F5 载入期迁移：`migrateState` 双写并计数（`lastHealInfo().fields`），**幂等**（第二次不再产生变化）', (() => {
    setKernelState(SEED());
    const s = clone(SEED());
    migrateState(s);
    const h1 = lastHealInfo();
    const snapshot = J(s.items) + '|' + J(s.scenes);
    const s2 = clone(s);
    migrateState(s2);
    const h2 = lastHealInfo();
    return h1.fields === 2 && s.items[0].lastSeenDate === '1919-05-01' && s.scenes[0].lastSeenFloor === 7
        && h2.fields === 0 && (J(s2.items) + '|' + J(s2.scenes)) === snapshot;
})(), '');

A('F6 写入期补写：新入库条目走 `preserveEntryMeta`（所有维度归一化的唯一漏斗）时**当场**带上规范名', (() => {
    setKernelState(SEED());
    const norm = { id: 'i9', name: '账册', desc: '发黄。', seenDate: '1919-12-01' };
    const sc = { id: 'sc9', name: '仓库', desc: '空的。', floorSeen: 12 };
    preserveEntryMeta('items', {}, norm);
    preserveEntryMeta('scenes', {}, sc);
    return norm.lastSeenDate === '1919-12-01' && sc.lastSeenFloor === 12;
})(), '');

// ---------- ③ 哈希零影响 ----------
A('F7 **不改任何哈希**：两个规范名都不在 `HASH_FIELDS` / `IDENTITY_FIELDS` / 瘦身白名单里，且已在 `NON_HASH_CANONICAL_FIELDS` 登记（= 这是决定，不是漏改）', (() => {
    const inHash = (HASH_FIELDS.items || []).indexOf('lastSeenDate') >= 0 || (HASH_FIELDS.scenes || []).indexOf('lastSeenFloor') >= 0;
    const inIdent = J(IDENTITY_FIELDS.items || {}) .indexOf('lastSeenDate') >= 0 || J(IDENTITY_FIELDS.scenes || {}).indexOf('lastSeenFloor') >= 0;
    const inSlim = slimWhitelistOf('items').indexOf('lastSeenDate') >= 0 || slimWhitelistOf('scenes').indexOf('lastSeenFloor') >= 0;
    return !inHash && !inIdent && !inSlim
        && J(NON_HASH_CANONICAL_FIELDS.items) === J(['lastSeenDate'])
        && J(NON_HASH_CANONICAL_FIELDS.scenes) === J(['lastSeenFloor']);
})(), '');

A('F8 瘦身不丢字段：两个名字**都**保存（各是一个短值）；同义组里**没有**这两组（keeper 必须落在白名单内，R3 不变量）', (() => {
    const slim = slimEntryForStorage('items', { id: 'i1', name: '钥匙', desc: '铜制。', seenDate: '1919-05-01', lastSeenDate: '1919-05-01' });
    const back = hydrateSlimEntry('items', clone(slim));
    const groups = SLIM_SYNONYM_GROUPS.items.map((g) => g.join('+')).concat(SLIM_SYNONYM_GROUPS.scenes.map((g) => g.join('+')));
    return slim.seenDate === '1919-05-01' && slim.lastSeenDate === '1919-05-01'
        && back.seenDate === '1919-05-01' && back.lastSeenDate === '1919-05-01'
        && groups.indexOf('seenDate+lastSeenDate') < 0 && groups.indexOf('floorSeen+lastSeenFloor') < 0;
})(), J(slimEntryForStorage('items', { id: 'i1', name: '钥匙', seenDate: '1919-05-01', lastSeenDate: '1919-05-01' })));

R.done();
