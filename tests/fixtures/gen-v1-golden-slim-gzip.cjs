'use strict';
// ============================================================
// B9-d oracle（条目瘦身 + gzip 存储）：真实 V1 插件 v1.206 直调，生成
//   tests/fixtures/v1-golden-slim-gzip.json
//   （瘦身：slimEntryForStorage / hydrateSlimEntry / slimDataForStorage / hydrateStorageData /
//     snapshotIndexFrom / slimSnapshotStoreForStorage / hydrateSnapshotStore；
//    gzip：gzipToBase64 / gunzipFromBytes / bytesToBase64 / base64ToBytes /
//     filesUploadContent（写入路径，桩 fetch 捕获 base64 → 解字节 → 魔数比对）/ stateFileReadAny（按魔数读回））
// 纪律：日志走 stderr（在 loadPlugin 之前覆写 console）、stdout 只输出 JSON、结尾 process.exit(0)、
//   连跑两次逐字节一致（输出中不含任何 Date.now 派生值）。
// 运行：node tests/fixtures/gen-v1-golden-slim-gzip.cjs [输出路径]
// ============================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const V1 = '/home/ubuntu/st/STT记忆插件';
const { makeTavernEnv, loadPlugin, makeResp } = require(path.join(V1, 'tests/unit/helpers.js'));

const realStdoutWrite = process.stdout.write.bind(process.stdout);
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
console.warn = (...a) => process.stderr.write('WARN: ' + a.join(' ') + '\n');
console.error = (...a) => process.stderr.write('ERR: ' + a.join(' ') + '\n');

const OUT = process.argv[2] || '';
const SRC_FILE = path.join(V1, 'src', 'FTT记忆组件-v1.206.js');
const SRC = fs.readFileSync(SRC_FILE, 'utf8');
const proj = (o) => (o === null || o === undefined ? null : JSON.parse(JSON.stringify(o)));

function snip(from, to, maxLen) {
    const i = SRC.indexOf(from);
    if (i < 0) return '';
    const j = to ? SRC.indexOf(to, i + from.length) : -1;
    const seg = (j > i ? SRC.slice(i, j) : SRC.slice(i, i + (maxLen || 1400)));
    return seg.trim();
}
/** 字节摘要（确定性；用于体积/内容比对） */
function bytesDigest(buf) {
    return { len: buf.length, magic: [buf[0], buf[1]], sha1: require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 16) };
}
/** 服务端桩（V1 `tests/unit/storage-slim-v1131.test.js#installServer` 同款，加确定性） */
function installServer(env, opt) {
    const o = opt || {};
    const state = { files: {}, uploads: [], calls: [] };
    Object.keys(o.files || {}).forEach((k) => { state.files[k] = Buffer.isBuffer(o.files[k]) ? o.files[k] : Buffer.from(String(o.files[k]), 'utf8'); });
    env.parentWin.fetch = async (url, opts) => {
        const u = String(url), op = opts || {};
        let body = null; try { body = op.body ? JSON.parse(op.body) : null; } catch (e) { /* 忽略 */ }
        state.calls.push({ url: u, name: body && body.name });
        if (u.indexOf('/csrf-token') === 0) return makeResp({ token: 'TK9D' });
        if (u.indexOf('/api/files/upload') === 0) {
            const buf = Buffer.from(String((body && body.data) || ''), 'base64');
            state.uploads.push({ name: body && body.name, buf });
            state.files[body && body.name] = buf;
            return makeResp({ path: '/user/files/' + (body && body.name) });
        }
        if (u.indexOf('/api/files/delete') === 0) {
            const p = String((body && body.path) || '').replace(/^\/user\/files\//, '');
            delete state.files[p];
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
    state.lastUpload = () => state.uploads[state.uploads.length - 1] || null;    state.byName = (n) => state.uploads.filter((x) => x.name === n).pop() || null;
    /** 解出上传内容（自动识别 gzip 魔数） */
    state.decode = (n) => {
        const u = state.byName(n);
        if (!u) return null;
        const gz = u.buf[0] === 0x1f && u.buf[1] === 0x8b;
        const text = gz ? zlib.gunzipSync(u.buf).toString('utf8') : u.buf.toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
        return { name: n, gz: gz, text: text, json: json, bytes: bytesDigest(u.buf) };
    };
    state.setJson = (n, obj) => { state.files[n] = Buffer.from(JSON.stringify(obj), 'utf8'); };
    return state;
}

/** 固定信封时间戳（`storageEnvelope` 取 Date.now → 会污染 gzip 字节；此处按固定值重算哈希，保证可复现） */
function deterministicEnvelope(F, st) {
    const env = F.storageEnvelope(st);
    env.ts = 1700000000000;
    if (env.payload) { env.payload.updatedAt = 1700000000000; env.hash = F.storageHash(env.payload); }
    return env;
}

// ---------------- 场景（覆盖同义字段 / 空默认值 / extra 回显 / 历史脏 name） ----------------
const ATOM = {
    id: 'a1', text: '艾芙琳在红唇酒吧见到线人', title: '酒馆会面', date: '1936-12-06', time: '下午',
    type: 'event', entities: [], locations: ['红唇酒吧'], tags: ['会面'], keywords: [], uses: 0,
    floorStart: 0, floorEnd: 3, location: '', validity: 'active',
    content: '艾芙琳在红唇酒吧见到线人',          // 与 text 完全重复 → 应被去掉（同义组）
    extra: [{ name: 'title', type: 'string', value: '酒馆会面' }, { name: 'unknownField', type: 'string', value: '独有信息' }],
};
const SCENE = {
    id: 'sc1', name: '红唇酒吧', title: '红唇酒吧', desc: '码头边的酒吧', content: '码头边的酒吧',
    pathArr: ['港区', '酒吧'], pathStr: '港区>酒吧', tags: [],
    actions: [], history: [], uses: 0,
};
const STATE_ROW = { id: 'st1', subject: '艾芙琳', field: '体力', value: '70', content: '70', status: '正常', note: '', history: [], updatedAt: 0 };
const RUMOR = { id: 'ru1', subject: '维蒂帮', title: '维蒂帮', content: '维蒂帮在走私', text: '维蒂帮在走私', stage: '传播', ferment: 1, tags: ['维蒂帮'], carriers: [], media: [], chain: [], pending: false, lineage: [], uses: 0 };
const SNAP_ATOM = { id: 'a1', __cat: 'atoms', text: '艾芙琳在红唇酒吧见到线人', title: '酒馆会面', content: '艾芙琳在红唇酒吧见到线人', tags: ['会面'], uses: 0 };

async function main() {
    const g = global;
    const savedRaf = g.requestAnimationFrame;
    g.requestAnimationFrame = (fn) => { try { fn(); } catch (e) { /* 忽略 */ } return 0; };

    const env = makeTavernEnv();
    const F = await loadPlugin(env);
    ['indexedDB', 'folder', 'localFolder', 'chatVariable', 'worldbook', 'chatFloor'].forEach((k) => { F.cfg.storage[k] = false; });
    F.cfg.storage.localStorage = true; F.cfg.storage.syncOnSave = false; F.cfg.storage.autoIdleCheck = false;
    F.cfg.storage.syncMetaProbe = false; F.cfg.storage.syncLogServer = false;
    F.cfg.storage.stateFile = true; F.cfg.storage.stateFileBak = true; F.cfg.storage.snapshotFile = true;

    const result = { meta: { v1Version: 'v1.206', notes: [], sourceFile: 'src/FTT记忆组件-v1.206.js' } };

    // ---------------- 零、V1 源码片段（证据） ----------------
    result.meta.v1SourceSnips = {
        slimHead: snip("const SLIM_EXT_GZ = '.json.gz';", 'function isSlimDefault(v) {'),
        slimEntry: snip('function slimEntryForStorage(cat, it) {', '// 单条还原'),
        hydrateSlimEntry: snip('function hydrateSlimEntry(cat, it) {', '// 数据体瘦身'),
        slimData: snip('function slimDataForStorage(data, opts) {', '// 数据体还原'),
        snapshotIndex: snip('function snapshotIndexFrom(snaps) {', '// 快照链瘦身'),
        slimSnapshot: snip('function slimSnapshotStoreForStorage(snaps) {', 'function hydrateSnapshotStore(snaps) {'),
        gzip: snip('function bytesToBase64(u8) {', '// 删除服务端用户目录文件'),
        uploadContent: snip('async function filesUploadContent(baseName, text, timeoutMs) {', '// 读文件：自动识别 gzip 魔数'),
        decodeBytes: snip('async function decodeFileBytes(name, u8, backend) {', '// 具体后端实现：酒馆用户目录文件'),
        slimFileEnvelope: snip('function slimFileEnvelope(env, keepSnap) {', '// 快照链文件读取'),
        fileNamesExts: snip('function fileNames(kind) {', '// **读取顺序**', 1200),
        exports: snip('slimEntryForStorage, hydrateSlimEntry, slimDataForStorage, hydrateStorageData,', '\n', 260),
    };

    // ---------------- 一、瘦身编解码（逐条投影） ----------------
    result.scenario = { atom: proj(ATOM), scene: proj(SCENE), stateRow: proj(STATE_ROW), rumor: proj(RUMOR) };

    const cases = [
        { cat: 'atoms', key: 'atom', it: ATOM },
        { cat: 'scenes', key: 'scene', it: SCENE },
        { cat: 'currentStates', key: 'stateRow', it: STATE_ROW },
        { cat: 'rumors', key: 'rumor', it: RUMOR },
    ];
    result.slimEntries = {};
    result.hydratedEntries = {};
    result.hashKeep = {};
    for (const c of cases) {
        const slim = F.slimEntryForStorage(c.cat, proj(c.it));
        const hyd = F.hydrateSlimEntry(c.cat, proj(slim));
        result.slimEntries[c.key] = { cat: c.cat, keys: Object.keys(slim).sort(), out: proj(slim) };
        result.hydratedEntries[c.key] = { keys: Object.keys(hyd).sort(), out: proj(hyd) };
    }
    // 内容哈希瘦身前 = 后（关键口径）
    {
        const full = { atoms: [proj(ATOM)] };
        F.state = Object.assign({}, F.state, full);
        const before = F.dataAggHash(full);
        const slim = F.slimDataForStorage({ atoms: [proj(ATOM)] });
        const hyd = F.hydrateStorageData(proj(slim));
        const after = F.dataAggHash({ atoms: hyd.atoms });
        result.hashKeep = { before: before, after: after, same: before === after, hashAfterSlimPayload: F.dataAggHash({ atoms: slim.atoms }) };
    }

    // ---------------- 二、数据体瘦身（剥快照 → snapIndex） ----------------
    {
        const data = {
            scope: 'char:should-be-deleted',
            atoms: [proj(ATOM)], scenes: [proj(SCENE)], currentStates: [proj(STATE_ROW)], rumors: [proj(RUMOR)],
            memories: [], items: [], plans: [], suspense: [], concepts: [], parallels: [], links: [], plotSegments: [],
            snapStore: [{ id: 'root_1', kind: 'root', ts: '2024-01-01T00:00:00.000Z', baseId: null, hash: 'h1', atoms: { a1: proj(SNAP_ATOM) }, atomsHashes: { a1: 'h1' }, deleted: { atoms: ['zombie'] } }],
            snapFp: { a1: { h: 'h1', cat: 'atoms' } },
            updatedAt: 1700000000000,
        };
        const keep = F.slimDataForStorage(proj(data), { keepSnap: false });
        const keepSnap = F.slimDataForStorage(proj(data), { keepSnap: true });
        result.slimData = {
            keys: Object.keys(keep).sort(),
            snapIndex: proj(keep.snapIndex),
            hasSnapStore: keep.snapStore !== undefined, hasSnapFp: keep.snapFp !== undefined, hasScope: keep.scope !== undefined,
            atomKeys: Object.keys(keep.atoms[0]).sort(),
            keepSnapHasSnapStore: keepSnap.snapStore !== undefined && keepSnap.snapStore.length === 1,
            hydratedKeys: Object.keys(F.hydrateStorageData(proj(keep))).sort(),
        };
    }
    // 快照索引独立函数
    result.snapIndex = proj(F.snapshotIndexFrom([
        { id: 'root_1', kind: 'root', ts: 1, baseId: null, hash: 'h1', atomsHashes: { a1: 'h1', a2: 'h2' } },
        { id: '', kind: 'root', ts: 2 },                              // 无 id → 被过滤
    ]));

    // ---------------- 三、快照链瘦身 ----------------
    {
        const snaps = [{ id: 'root_1', kind: 'root', ts: '2024-01-01T00:00:00.000Z', baseId: null, hash: 'h1', atomsHashes: { a1: 'h1' }, atoms: { a1: proj(SNAP_ATOM) }, deleted: { atoms: ['gone'] } }];
        const slim = F.slimSnapshotStoreForStorage(proj(snaps));
        const hyd = F.hydrateSnapshotStore(proj(slim));
        result.slimSnapshot = {
            keys: Object.keys(slim[0]).sort(),
            atomKeys: Object.keys(slim[0].atoms.a1).sort(),
            out: proj(slim),
            hydratedAtomKeys: Object.keys(hyd[0].atoms.a1).sort(),
            hydratedAtom: proj(hyd[0].atoms.a1),
        };
    }

    // ---------------- 四、gzip 往返（base64 → 字节 → 魔数 → 解压） ----------------
    {
        const text = JSON.stringify({ atoms: Array.from({ length: 40 }, (_, i) => ({ id: 'a' + i, text: '艾芙琳在红唇酒吧与线人交谈，讨论维蒂帮的走私路线。'.repeat(2), title: '会面' + i })) });
        const gz = await F.gzipToBase64(text);
        const u8 = F.base64ToBytes(gz.b64);
        const back = await F.gunzipFromBytes(u8);
        result.gzipRoundTrip = {
            ok: !!gz.ok, magic: [u8[0], u8[1]], bytes: u8.length, rawBytes: Buffer.byteLength(text, 'utf8'),
            shrinkRatio: Number((u8.length / Buffer.byteLength(text, 'utf8')).toFixed(3)),
            equals: back === text,
            b64RoundTrip: F.bytesToBase64(u8) === gz.b64,
            b64Digest: bytesDigest(Buffer.from(gz.b64, 'base64')),
        };
    }

    // ---------------- 五、写入路径（自动 gzip → base64；命名 .json.gz） ----------------
    {
        const S = installServer(env, {});
        F.state = Object.assign({}, F.state, {
            atoms: [proj(ATOM)],
            snapStore: [{ id: 'root_1', kind: 'root', ts: '2024-01-01T00:00:00.000Z', baseId: null, hash: 'h1', atoms: { a1: proj(SNAP_ATOM) }, atomsHashes: { a1: 'h1' } }],
            snapFp: { a1: { h: 'h1', cat: 'atoms' } },
            updatedAt: 1700000000000,
        });
        // 固定信封时间戳（`storageEnvelope` 默认取 Date.now）→ gzip 字节可逐字节复现
        const envFixed = deterministicEnvelope(F, F.state);
        const w = await F.stateFileWrite(envFixed, { bak: true });
        const main = S.decode(w.name);
        const bak = S.decode(w.bakName || '');
        const snapName = String(S.uploads.map((u) => u.name).filter((n) => /^ftt-snap-/.test(n)).pop() || '');
        const snap = snapName ? S.decode(snapName) : null;
        result.writePath = {
            ret: { ok: !!w.ok, gz: !!w.gz, name: w.name, uploaded: proj(w.uploaded), bak: !!w.bak, bakName: w.bakName || '' },
            main: main ? {
                name: main.name, gz: main.gz, bytes: main.bytes,
                envKeys: Object.keys(main.json || {}).sort(),
                payloadKeys: Object.keys((main.json || {}).payload || {}).sort(),
                dataKeys: Object.keys(((main.json || {}).payload || {}).data || {}).sort(),
                hasSnapIndex: Array.isArray((((main.json || {}).payload || {}).data || {}).snapIndex),
                snapIndexLen: ((((main.json || {}).payload || {}).data || {}).snapIndex || []).length,
                hasSnapStore: ((((main.json || {}).payload || {}).data || {}).snapStore !== undefined),
                hasSnapFp: ((((main.json || {}).payload || {}).data || {}).snapFp !== undefined),
                atomKeys: Object.keys(((((main.json || {}).payload || {}).data || {}).atoms || [])[0] || {}).sort(),
                hash: String((main.json || {}).hash || ''),
            } : null,
            bak: bak ? { name: bak.name, gz: bak.gz, hasSnapStore: ((((bak.json || {}).payload || {}).data || {}).snapStore !== undefined) } : null,
            snap: snap ? { name: snap.name, gz: snap.gz, magic: snap.bytes.magic, count: (snap.json || {}).count, hasSnapFp: !!(snap.json || {}).snapFp, atomKeys: Object.keys((((snap.json || {}).snapStore || [])[0] || {}).atoms || {}).length ? Object.keys(((snap.json || {}).snapStore || [])[0].atoms.a1).sort() : [] } : null,
            // 快照文件载荷内含 `updatedAt: Date.now()` → 只记录名/魔数（长度与哈希不可复现，不写入 fixture）
            uploads: S.uploads.map((u) => ({ name: u.name, magic: [u.buf[0], u.buf[1]] })),
        };
        // 读回（按魔数识别 + 还原）
        const back = await F.stateFileReadAny();
        result.readPath = back && back.env ? {
            from: back.from, name: back.name,
            atoms: (back.env.payload.data.atoms || []).length,
            atomKeys: Object.keys((back.env.payload.data.atoms || [])[0] || {}).sort(),
            textBack: ((back.env.payload.data.atoms || [])[0] || {}).text,
            contentBack: ((back.env.payload.data.atoms || [])[0] || {}).content,
        } : null;
    }

    // ---------------- 六、明文兼容（旧 .json 仍可读）+ 压缩不可用时回退明文 ----------------
    {
        // ① 明文旧文件：直接放一个明文 `.json`（关掉 stateFileWrite 的 gz 不可行 —— V1 恒 gzip；
        //    这里验证**读取侧**按魔数识别明文，即 V1 `decodeFileBytes` 的明文分支）。
        const S = installServer(env, {});
        const envPlain = F.storageEnvelope(Object.assign({}, F.state, { atoms: [proj(ATOM)], updatedAt: 1700000000000 }));
        S.setJson(F.stateFileName(), envPlain);
        const r = await F.stateFileReadAny();
        result.legacyPlainRead = r && r.env ? { from: r.from, atoms: (r.env.payload.data.atoms || []).length, text: (r.env.payload.data.atoms || [])[0].text } : null;

        // ② 压缩不可用（移除 CompressionStream）→ 写入回退明文 `.json`
        const savedCS = g.CompressionStream;
        try { delete g.CompressionStream; } catch (e) { g.CompressionStream = undefined; }
        const S2 = installServer(env, {});
        const w2 = await F.stateFileWrite(F.storageEnvelope(Object.assign({}, F.state, { atoms: [proj(ATOM)], updatedAt: 1700000000000 })), { bak: false });
        const up2 = S2.byName(w2.name);
        result.gzUnavailableFallback = {
            ret: { ok: !!w2.ok, gz: !!w2.gz, name: w2.name },
            uploadName: up2 ? up2.name : null,
            magic: up2 ? [up2.buf[0], up2.buf[1]] : null,
            isPlainJson: !!(up2 && up2.buf[0] !== 0x1f),
            bodyEndsJson: !!(w2.name && /\.json$/.test(w2.name)),
        };
        if (savedCS === undefined) delete g.CompressionStream; else g.CompressionStream = savedCS;
    }

    // ---------------- 七、原生怪癖（oracle 实测，原样保留） ----------------
    result.meta.notes.unshift('本 fixture 由 tests/fixtures/gen-v1-golden-slim-gzip.cjs **直调真实 V1 插件 v1.206** 生成'
        + '（`node tests/fixtures/gen-v1-golden-slim-gzip.cjs tests/fixtures/v1-golden-slim-gzip.json`，连跑两次逐字节一致）。'
        + '瘦身/还原/gzip 原语走 `__FTT` 导出直调；写入路径经桩 fetch（捕获 base64 → 解字节 → 魔数/内容比对），'
        + '读取路径经 `stateFileReadAny`（按内容魔数识别）验证。');
    result.meta.notes.push('V1 原生行为（oracle 实测，原样保留）：'
        + '① `slimEntryForStorage` 对**非对象**原样返回；`extra` 槽位与顶层同值即丢弃，只保留「顶层没有或值不同」的槽位。'
        + '② 同义字段组只在「组内出现 ≥2 个键」且「值与保留键 JSON 全等」时才删除；`scenes.pathArr/pathStr` 有专用比较。'
        + '③ `slimDataForStorage` 非 `keepSnap` 时写入 `snapIndex` 并删 `snapStore`/`snapFp`，且**删除 `scope`**；'
        + '`keepSnap:true`（备份文件口径）保留完整链。'
        + '④ `snapshotIndexFrom` 过滤掉无 `id` 的项。'
        + '⑤ 写入路径 `filesUploadContent` **恒先试 gzip**（`.json.gz`），失败才回退明文 `.json`；'
        + '`storageEnvelope` 的哈希对**瘦身后的 payload** 重算（`slimFileEnvelope`），故读取侧 `envValid` 仍通过。'
        + '⑥ 备份文件默认保留完整链（`slimFileEnvelope(env, true)`），`bakSlim:true` 时才与主文件同。'
        + '⑦ 读取侧 `decodeFileBytes` 的 gzip 判定是**内容魔数**（`1f 8b`），与扩展名无关 → 明文旧文件照读。');

    if (savedRaf === undefined) delete g.requestAnimationFrame; else g.requestAnimationFrame = savedRaf;
    return result;
}

main().then((r) => {
    const text = JSON.stringify(r, null, 2) + '\n';
    if (OUT) fs.writeFileSync(OUT, text);
    realStdoutWrite(text);
    process.exit(0);
}).catch((e) => { process.stderr.write('ORACLE FAIL: ' + ((e && e.stack) || e) + '\n'); process.exit(2); });
