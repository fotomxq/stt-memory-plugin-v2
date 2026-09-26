#!/usr/bin/env node
// ============================================================
// scripts/gen-changelog-json.js —— 由 `CHANGELOG.md` 生成 `FTT-memory-changelog.json`
//
// 为什么需要它（v2.53.0，用户要求「版本更新应该是**代码库中的 json 文件**」）：
//   关于页（`ui/about.js`）要以**机器可读清单**展示版本更新。此前仓库里没有该 JSON，
//   「关于」页成功态只能靠 fetch 桩验证 —— 真实部署永远读不到、只能显示失败（等于功能没落地）。
//   本脚本让 **CHANGELOG.md 成为唯一事实源**：清单由它生成，`scripts/check-changelog-json.js`
//   在门禁里校验「文件 == 重新生成的结果」，因此不可能出现手改后漂移的假数据。
//
// 用法：
//   node scripts/gen-changelog-json.js          # 生成/覆盖 FTT-memory-changelog.json
//   node scripts/gen-changelog-json.js --check  # 只校验（门禁用），不写文件
// ============================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_FILE = join(ROOT, 'FTT-memory-changelog.json');

/** 去掉 Markdown 行内标记（保留可读文本） */
function plain(s) {
    return String(s == null ? '' : s)
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // [文本](链接) → 文本
        .replace(/`([^`]*)`/g, '$1')               // 行内代码
        .replace(/\*\*/g, '')                      // 粗体
        .replace(/^[#>\-*\s]+/, '')                // 行首标记
        .replace(/\s+/g, ' ')
        .trim();
}

/** 截断（按字符数，中文友好；超长加省略号） */
function clip(s, n) {
    const t = plain(s);
    return t.length > n ? (t.slice(0, n - 1) + '…') : t;
}

/**
 * 解析 CHANGELOG.md → 清单对象。
 * 标题形如：`## v2.53.0（2026-09-26）· 关于页：…`
 * 要点形如：`**① 小标题**：正文…`（多行为一段，遇下一个 `**` 起始行分段）；
 *   「用户要求 / 门禁 / 未验证」这类过程性段落**不作为要点**（关于页只列改动本身，≤3 条）。
 * @returns {{name:string,title:string,version:string,updatedAt:string,generatedAt:string,intro:object,changelog:Array}}
 */
export function buildChangelogJson(text) {
    const lines = String(text).split('\n');
    const entries = [];
    const SKIP_LEAD = /^(用户要求|门禁|未验证|为什么|说明|背景|触发)/;
    const NUMBERED = /^[①②③④⑤⑥⑦⑧⑨⑩]/;
    let cur = null;
    let seg = null;   // { lead, body: [] }
    const flushSeg = () => {
        if (!cur || !seg) { seg = null; return; }
        const lead = plain(seg.lead);
        const body = plain(seg.body.join(''));
        const numbered = NUMBERED.test(lead);
        if (lead && !SKIP_LEAD.test(lead)) {
            cur._segs.push({ lead: lead, text: clip(lead + (body ? '：' + body : ''), 90), numbered: numbered });
        }
        seg = null;
    };
    for (const raw of lines) {
        const line = raw.trim();
        const h = line.match(/^##\s+v?(\d+\.\d+\.\d+)\s*[（(]([^）)]*)[）)]\s*(?:[·•\-–—]\s*)?(.*)$/);
        if (h) {
            flushSeg();
            cur = { version: h[1], date: plain(h[2]), title: plain(h[3]), points: [], _segs: [] };
            entries.push(cur);
            continue;
        }
        if (!cur) continue;
        if (/^##\s/.test(line)) break;
        const bold = line.match(/^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/);
        if (bold) { flushSeg(); seg = { lead: bold[1], body: bold[2] ? [bold[2]] : [] }; }
        else if (seg) seg.body.push(line);
    }
    flushSeg();
    // 选点：优先带圈编号的改动条目（用户要求/门禁等过程段落已被跳过；续行造成的伪分段也不会排在前面）
    for (const e of entries) {
        const numbered = e._segs.filter((s) => s.numbered).map((s) => s.text);
        const others = e._segs.filter((s) => !s.numbered).map((s) => s.text);
        e.points = (numbered.length ? numbered : others).slice(0, 3);
        delete e._segs;
    }

    const top = entries[0] || { version: '', date: '' };
    return {
        name: 'FTT记忆组件',
        title: 'SillyTavern 长期记忆扩展（V2 原生扩展）',
        version: top.version,
        updatedAt: top.date,
        generatedAt: top.date,
        intro: {
            what: 'SillyTavern 长期记忆扩展：自动提取 / 注入 / 维护剧情记忆。',
            highlights: [
                '自动提取：从楼层文本提炼 情节 / 记忆 / 角色 / 物品 / 货币 等原子数据。',
                '按预算注入：把记忆拼进上下文，可查看命中与未命中审计。',
                '剧情时钟：只以最新一条「情节」为唯一可信来源，不猜、不巡检改写。',
                '可追溯：交互 / 宿主调用 / 错误统一追踪，调试日志可导出。',
            ],
            entries: [],
            notes: '',
        },
        changelog: entries,
    };
}

/** 生成结果文本（统一 2 空格缩进 + 末尾换行，保证可重复生成字节一致） */
export function renderChangelogJson(text) {
    return JSON.stringify(buildChangelogJson(text), null, 2) + '\n';
}

/** 读取源（CHANGELOG.md）并渲染 */
export function renderFromRepo() {
    return renderChangelogJson(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const check = process.argv.includes('--check');
    const next = renderFromRepo();
    const prev = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';
    const n = JSON.parse(next).changelog.length;
    if (check) {
        if (prev !== next) {
            console.log('❌ FTT-memory-changelog.json 与 CHANGELOG.md 不同步（请运行 node scripts/gen-changelog-json.js）');
            process.exit(1);
        }
        console.log('✅ 版本清单 JSON 与 CHANGELOG.md 同步（' + n + ' 个版本）');
        process.exit(0);
    }
    writeFileSync(OUT_FILE, next);
    console.log('✅ 已生成 FTT-memory-changelog.json（' + n + ' 个版本，' + Buffer.byteLength(next, 'utf8') + ' 字节）');
}
