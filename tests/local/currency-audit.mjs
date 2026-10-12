// tests/local/currency-audit.mjs —— **只读**核对宿主原生存储里的真实货币数据
//
// 用途（v3.46.2，`docs/D22` §4.14 W13 `应-30`）：用户要求「新增货币融合，指定一个角色的所有货币交给AI去整理规整，
//   尤其是一些只是叫法不同的货币应该合并。**具体你可以参考本地的调试接口，调取数据核对**」——
//   本脚本就是那次核对用的工具：直接读宿主原生存储（`extension-store/**`），按**归属**汇总「名字|单位」组合、
//   条数、合计额度，并粗筛疑似同义别名（互相包含 / 共字）。
//
// 纪律：**只读**，不写任何宿主文件；不打印与货币无关的正文。
// 用法：node tests/local/currency-audit.mjs   （换库：环境变量 `FTT_AUDIT_ROOT=<extension-store 目录>`）
//
// 路径纪律：**不写死用户目录**（`check-no-user-paths` 会拦）—— 默认由 `%APPDATA%` 拼出宿主数据目录。
//
// 该脚本给出的实测结论（写进 `docs/D36` §2 与本轮批次档 `docs/history/P10c93`）：
//   李瑶 **37 种「名字|单位」组合 / 125 条** —— 金（黄金 / 天然碎金 / 碎金子 / 赤金条 / 诺米斯玛金币…）·
//   银（碎银 / 碎银子 / 雪花银 / 银角子与碎银饼 / 官铸雪花大银）· 票据（飞钱 / 飞钱凭证 / 通兑飞钱凭证）·
//   铜（开元通宝 / 铜钱 / 拜占庭铜努米亚）四簇；另有**单位写法混乱**、**复合名**（「飞钱凭证及赤金条」）与**负额度**（-6）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APPDATA = String(process.env.APPDATA || process.env.HOME || '.').replace(/\\/g, '/');
const ROOT = process.env.FTT_AUDIT_ROOT
    || join(APPDATA, 'com.tauritavern.client', 'data', '_tauritavern', 'extension-store');
const STORES = ['ftt2-files', 'ftt-files', 'fft_v2_store', 'ftt2-local'];

function walk(dir, out = [], depth = 0) {
    if (depth > 3) return out;
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out, depth + 1);
        else { try { const st = statSync(p); out.push({ p, size: st.size }); } catch { /* 忽略 */ } }
    }
    return out;
}

/** 从任意 JSON 里递归找 currencies 数组（state 顶层或分片信封里） */
function collectCurrencies(node, sink, path = '') {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.currencies)) sink.push({ path, arr: node.currencies });
    for (const k of Object.keys(node)) {
        if (k === 'currencies') continue;
        const v = node[k];
        if (v && typeof v === 'object') collectCurrencies(v, sink, path + '/' + k);
    }
}

const byOwner = new Map();
let scanned = 0, withCur = 0;
for (const store of STORES) {
    const dir = join(ROOT, store);
    for (const f of walk(dir)) {
        if (f.size > 30 * 1024 * 1024) continue;                       // 超大分片跳过（只读核对够用）
        let txt = '';
        try { txt = readFileSync(f.p, 'utf8'); } catch { continue; }
        scanned++;
        const sink = [];
        try { collectCurrencies(JSON.parse(txt), sink); } catch { sink.length = 0; }
        if (!sink.length) {
            // 行式 JSON（每行一个 JSON）兜底
            for (const line of txt.split('\n')) {
                const s = line.trim();
                if (!s || s[0] !== '{') continue;
                try { collectCurrencies(JSON.parse(s), sink); } catch { /* 忽略 */ }
            }
        }
        if (!sink.length) continue;
        withCur++;
        for (const s of sink) for (const c of s.arr) {
            if (!c || typeof c !== 'object') continue;
            const owner = String(c.owner || c.who || '(未署名)').trim();
            if (!byOwner.has(owner)) byOwner.set(owner, new Map());
            const m = byOwner.get(owner);
            const name = String(c.name || c.currency || c.unit || '(无名)').trim();
            const unit = String(c.unit || '').trim();
            const amount = Number(c.amount) || 0;
            const k = name + '|' + unit;
            const prev = m.get(k) || { name, unit, n: 0, total: 0, ids: [] };
            prev.n++; prev.total += amount;
            if (prev.ids.length < 3) prev.ids.push(String(c.id || '').slice(0, 14));
            m.set(k, prev);
        }
    }
}

console.log(`扫过 ${scanned} 个文件，其中含 currencies 的 ${withCur} 个；不同归属 ${byOwner.size} 个\n`);
const owners = [...byOwner.entries()].sort((a, b) => b[1].size - a[1].size);
for (const [owner, m] of owners.slice(0, 8)) {
    const rows = [...m.values()].sort((a, b) => b.n - a.n);
    console.log(`【${owner}】${rows.length} 种「名字|单位」组合，${rows.reduce((s, r) => s + r.n, 0)} 条记录`);
    for (const r of rows.slice(0, 14)) {
        console.log(`   ${r.name}${r.unit && r.unit !== r.name ? (' / 单位=' + r.unit) : ''}  ×${r.n}  合计 ${r.total}  id=${r.ids.join(',')}`);
    }
    // 疑似同义别名（名字互相包含，或名字长度≥2 且有共同字）
    const names = [...new Set(rows.map((r) => r.name))];
    const sus = [];
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
        const a = names[i], b = names[j];
        if (a === b) continue;
        if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) sus.push(`${a} ↔ ${b}（包含）`);
        else {
            const common = [...a].filter((ch) => b.indexOf(ch) >= 0).length;
            if (common >= 1 && Math.min(a.length, b.length) >= 2) sus.push(`${a} ↔ ${b}（共字）`);
        }
    }
    if (sus.length) console.log('   ⚠️ 疑似同义：' + sus.slice(0, 10).join(' · '));
    console.log('');
}
