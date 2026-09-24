// ============================================================
// adapters/i18n.js —— 词条注册（ST `addLocaleData`）与文案查询
// 事实源：P0 探针结论 —— `getContext().addLocaleData` 存在；ST 约定扩展可自带 `i18n/<locale>.json`。
// 设计：**JSON 给 ST 自动扫描 / JS 镜像给 ESM 直接读**（无需 fetch），两者由 scripts/check-i18n.js 强制同步。
// 键口径：以**界面上的中文字面量**为键 —— `zh-cn` 为身份映射，`en` 为英文译文；`t(key)` 在当前语言下取译文。
// 失败姿态：注册失败只记原因（不影响插件其余功能）；缺失词条回退键本身。
// ============================================================
import { getCtx } from '../host/st-api.js';
import zhCn from '../i18n/zh-cn.js';
import en from '../i18n/en.js';

export const DICTS = Object.freeze({ 'zh-cn': zhCn, en });
const registered = { ok: false, locales: [], reason: '', at: 0 };

/** 当前界面语言（ST `getContext().getCurrentLocale?` / `locale` 字段；缺失默认 zh-cn） */
export function currentLocale() {
    try {
        const ctx = getCtx();
        if (ctx && typeof ctx.getCurrentLocale === 'function') return String(ctx.getCurrentLocale() || 'zh-cn');
        if (ctx && ctx.locale) return String(ctx.locale);
    } catch (e) { /* 忽略 */ }
    return 'zh-cn';
}

/**
 * 注册词条到 ST（幂等）。
 * 兼容两种签名：`addLocaleData(locale, data)`（release 分支）与仅注册当前语言的 `addLocaleData(data)`。
 * @returns {{ok:boolean, locales:string[], reason?:string}}
 */
export function registerLocaleData() {
    const ctx = getCtx();
    registered.at = Date.now();
    if (!ctx || typeof ctx.addLocaleData !== 'function') {
        registered.ok = false; registered.locales = []; registered.reason = 'addLocaleData 不可用';
        return { ok: false, locales: [], reason: registered.reason };
    }
    const done = [];
    for (const locale of Object.keys(DICTS)) {
        try { ctx.addLocaleData(locale, DICTS[locale]); done.push(locale); }
        catch (e) { registered.reason = String((e && e.message) || e); }
    }
    registered.ok = done.length > 0;
    registered.locales = done;
    if (!done.length) registered.reason = registered.reason || '注册失败';
    return { ok: registered.ok, locales: done, reason: registered.reason };
}

/**
 * 取译文（缺失回退键本身；支持 `{n}` 占位替换）。
 * @param {string} key 中文字面量键
 * @param {object} [vars] 占位变量
 */
export function t(key, vars) {
    const k = String(key == null ? '' : key);
    const dict = DICTS[currentLocale()] || DICTS['zh-cn'] || {};
    let out = dict[k] !== undefined ? dict[k] : k;
    if (vars && typeof vars === 'object') {
        for (const name of Object.keys(vars)) out = out.split('{' + name + '}').join(String(vars[name]));
    }
    return out;
}

/** 词条统计（诊断导出：数量 / 语言 / 注册结果） */
export function i18nStats() {
    return {
        locales: Object.keys(DICTS),
        keys: Object.keys(DICTS['zh-cn'] || {}).length,
        locale: currentLocale(),
        registered: { ok: registered.ok, locales: registered.locales.slice(), reason: registered.reason, at: registered.at },
    };
}
