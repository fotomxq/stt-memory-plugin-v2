// ============================================================
// ui/popup.js —— **兼容层**（v2.2.0 起主界面改为 V1 同构浮层 `ui/panel.js`）
// 历史：v2.1.0 曾用 ST 的 `callGenericPopup` + 4 个自定义分页；用户要求「完全对齐 V1」后，
//   改为 V1 的浮层（`#ftt-panel` + 13 分页 + V1 原样式），本模块只做**名称转发**，
//   让既有导入（index/命令/调试导出/测试）无需改动即可继续工作。
// 注意：`popupTabs()` 现在返回 **V1 的 13 个分页 id**（不是旧的 4 个）；`popupInfo()` 返回浮层信息。
// ============================================================
import {
    openPanel, closePanel, panelHtml, panelTabs, panelInfo, panelAction, panelState,
    setPanelHooks2, bindOverlay, unmountPanel, PANEL_ID, PANEL_TABS, panelBodyHtml, renderPanel,
} from './panel.js';

export const POPUP_ID = PANEL_ID;

/** 打开（= 打开 V1 浮层） */
export async function openPopup(tab) { return openPanel(tab); }
/** 关闭 */
export function closePopup() { return closePanel(); }
/** 完整 HTML（V1 面板 HTML） */
export function popupHtml(tab) { void tab; return panelHtml(); }
/** 指定分页内容 HTML */
export function popupBodyHtml(tab) { return panelBodyHtml(tab); }
/** 分页清单（V1 的 13 个） */
export function popupTabs() { return panelTabs(); }
/** 面板信息 */
export function popupInfo() { return panelInfo(); }
/** 面板状态 */
export function popupState() { return panelState(); }
/** 动作转发 */
export async function popupAction(action, payload) { return panelAction(action, payload); }
/** 钩子注入（转发给浮层） */
export function setPopupHooks(hooks) { return setPanelHooks2(hooks); }
/** 事件绑定（转发） */
export function bindPopup() { return bindOverlay(); }
/** 卸载（转发） */
export function unmountPopup() { return unmountPanel(); }
/** 兼容：早期 config 摘要 */
export function popupConfig() {
    return { id: PANEL_ID, tabs: PANEL_TABS.map((t) => t[0]), mode: 'v1-overlay' };
}
