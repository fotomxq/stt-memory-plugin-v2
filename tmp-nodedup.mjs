// 临时脚本（用完即删）：快速记账**不按内容去重**（人工连点两次同额是两笔真实记录）
import { readFileSync, writeFileSync } from 'node:fs';
const p = 'core/currency-quick.js';
let t = readFileSync(p, 'utf8');
let miss = 0;
const rep = (a, b) => { if (t.indexOf(a) < 0) { console.log('MISS: ' + a.slice(0, 70)); miss++; } else t = t.replace(a, b); };

// ① 导入：不再用 mergeMoneyHistory（改由本模块自己的 appendQuickFlow 控制口径）
rep("import { formatMoney, mergeMoneyHistory, roundMoney } from './model/money.js';",
    "import { formatMoney, roundMoney } from './model/money.js';");

// ② 新增 appendQuickFlow（放在 applyQuickCurrencyFlow 之前）
rep("/**\n * **应用一条快速记录**",
    "/**\n"
    + " * **把一条快速记录并入流水**（**不按内容去重**）。\n"
    + " *\n"
    + " * 与 `core/model/money.js#mergeMoneyHistory` 的差别（有意为之）：后者是给 **AI 抽取** 用的 ——\n"
    + " *   同一份正文重复抽取应当去重；而这里是人**手动点两次同额**，那是**两笔真实记录**，必须都留下。\n"
    + " *   上限仍沿用「最近 12 笔」（与既有口径一致，防条目无限膨胀）。\n"
    + " * @param {Array} history 既有流水\n"
    + " * @param {{date:string,delta:number,note:string}} flow 新流水\n"
    + " * @returns {Array}\n"
    + " */\n"
    + "export function appendQuickFlow(history, flow) {\n"
    + "    const arr = Array.isArray(history) ? history.slice() : [];\n"
    + "    if (flow) arr.push({ date: String(flow.date || ''), delta: Number(flow.delta) || 0, note: String(flow.note || '') });\n"
    + "    return arr.slice(-12);\n"
    + "}\n"
    + "\n"
    + "/**\n * **应用一条快速记录**");

// ③ 应用处改用它
rep("    const history = mergeMoneyHistory(c.history, [flow]);",
    "    const history = appendQuickFlow(c.history, flow);");
writeFileSync(p, t, 'utf8');
console.log('已改：人工记账不去重，miss=' + miss);
