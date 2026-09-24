// ============================================================
// 单元测试 · core/update（更新检查纯逻辑）
// ============================================================
import { makeReporter } from '../harness/st-mock.js';
import { parseVersion, compareVersions, judgeUpdate, shouldAutoCheck, repoRawUrls, extractChangelogHead, updateReport, summarizeCheck } from '../../core/update.js';
import { DEFAULT_UPDATE_REPO, DEFAULT_UPDATE_BRANCH, DEFAULT_UPDATE_INTERVAL_HOURS } from '../../core/constants.js';

const R = makeReporter('core-update 更新检查纯逻辑');

R.assert('V1 parseVersion 解析 v 前缀 / 缺段 / 预发布 / 非法', (() => {
    const a = parseVersion('v2.1.3'), b = parseVersion('2.1'), c = parseVersion('2.0.0-p1'), d = parseVersion('abc');
    return JSON.stringify(a.parts) === '[2,1,3]' && a.pre === ''
        && JSON.stringify(b.parts) === '[2,1,0]' && c.pre === 'p1' && d === null;
})(), '');
R.assert('V2 compareVersions 全序（含预发布 < 正式）', (() => {
    return compareVersions('2.0.0', '2.0.1') === -1 && compareVersions('2.1.0', '2.0.9') === 1
        && compareVersions('v2.0.0', '2.0.0') === 0 && compareVersions('2.0.0-p1', '2.0.0') === -1
        && compareVersions('2.0.0-p1', '2.0.0-p2') === -1 && compareVersions('x', '2.0.0') === null;
})(), '');
R.assert('V3 judgeUpdate 四种状态', (() => {
    return judgeUpdate('2.0.0', '2.1.0').status === 'newer' && judgeUpdate('2.0.0', '2.0.0').status === 'same'
        && judgeUpdate('2.1.0', '2.0.0').status === 'older' && judgeUpdate('2.0.0', '').status === 'unknown'
        && judgeUpdate('2.0.0', '2.1.0').remoteNewer === true;
})(), '');
R.assert('V4 shouldAutoCheck：首次启动必查', (() => {
    const r = shouldAutoCheck({ autoUpdateCheck: true, startupCheckedAt: 0, lastCheckAt: 0, now: 1000, hasHost: true });
    return r.run === true && r.reason === 'first-startup';
})(), '');
R.assert('V5 shouldAutoCheck：间隔未到不查 / 到期再查', (() => {
    const base = { autoUpdateCheck: true, startupCheckedAt: 1, intervalHours: 24, hasHost: true };
    const recent = shouldAutoCheck(Object.assign({}, base, { lastCheckAt: 1000, now: 1000 + 3600 * 1000 }));
    const due = shouldAutoCheck(Object.assign({}, base, { lastCheckAt: 1000, now: 1000 + 25 * 3600 * 1000 }));
    return recent.run === false && recent.reason === 'recent' && due.run === true && due.reason === 'interval-elapsed';
})(), '');
R.assert('V6 shouldAutoCheck：关闭开关 / 无宿主 / 手动', (() => {
    const off = shouldAutoCheck({ autoUpdateCheck: false, hasHost: true });
    const noHost = shouldAutoCheck({ autoUpdateCheck: true, hasHost: false });
    const manual = shouldAutoCheck({ autoUpdateCheck: false, hasHost: true, manual: true });
    return off.reason === 'disabled' && noHost.reason === 'no-host' && manual.run === true && manual.reason === 'manual';
})(), '');
R.assert('V7 repoRawUrls：GitHub（含 .git 后缀与斜杠）', (() => {
    const a = repoRawUrls('https://github.com/fotomxq/stt-memory-plugin', 'main');
    const b = repoRawUrls('https://github.com/fotomxq/stt-memory-plugin.git/', 'dev');
    return a.host === 'github' && a.owner === 'fotomxq' && a.repo === 'stt-memory-plugin'
        && a.manifest === 'https://raw.githubusercontent.com/fotomxq/stt-memory-plugin/main/manifest.json'
        && a.changelog === 'https://raw.githubusercontent.com/fotomxq/stt-memory-plugin/main/CHANGELOG.md'
        && b.branch === 'dev' && b.manifest.indexOf('/dev/manifest.json') > 0;
})(), '');
R.assert('V8 repoRawUrls：Gitee 与未知域名', (() => {
    const g = repoRawUrls('https://gitee.com/fotomxq/stt-memory-plugin.git', 'main');
    const o = repoRawUrls('https://gitlab.com/a/b', 'main');
    const empty = repoRawUrls('', 'main');
    return g.host === 'gitee' && g.manifest === 'https://gitee.com/fotomxq/stt-memory-plugin/raw/main/manifest.json'
        && o.host === 'other' && o.manifest === null && empty.host === '';
})(), '');
R.assert('V9 extractChangelogHead：版本 + 日期 + 要点（限条数、去符号）', (() => {
    const md = '# 版本历史\n\n> 说明\n\n## v2.1.0（2026-10-01）\n\n**标题**\n\n- 要点一 **粗体** `代码`\n- 要点二\n- 要点三\n- 要点四\n- 要点五\n- 要点六\n\n## v2.0.0（2026-09-24）\n- 旧要点\n';
    const h = extractChangelogHead(md, 5);
    return h.version === '2.1.0' && h.date === '2026-10-01' && h.points.length === 5
        && h.points[0] === '要点一 粗体 代码' && h.points.indexOf('旧要点') < 0;
})(), '');
R.assert('V9b extractChangelogHead 兼容两位版本号（V1 形态 v1.206）', (() => {
    const h = extractChangelogHead('## v1.206（2026-09-24）\n- 要点A\n', 3);
    return h.version === '1.206' && h.date === '2026-09-24' && h.points.length === 1;
})(), extractChangelogHead('## v1.206（2026-09-24）\n- 要点A\n', 3));
R.assert('V10 updateReport：五类文案', (() => {
    const newer = updateReport({ ok: true, via: 'remote-manifest:github', judge: { status: 'newer', current: '2.0.0', remote: '2.1.0' } });
    const same = updateReport({ ok: true, judge: { status: 'same', current: '2.0.0', remote: '2.0.0' } });
    const older = updateReport({ ok: true, judge: { status: 'older', current: '2.1.0', remote: '2.0.0' } });
    const git = updateReport({ ok: true, via: 'st-endpoint', isUpToDate: true, judge: { status: 'unknown' } });
    const bad = updateReport({ ok: false, error: 'HTTP 404' });
    return newer.indexOf('发现新版本 2.1.0') >= 0 && newer.indexOf('来源 remote-manifest:github') >= 0
        && same.indexOf('已是最新版本') >= 0 && older.indexOf('高于远端') >= 0
        && git.indexOf('已是最新（Git 校验）') >= 0 && bad.indexOf('HTTP 404') >= 0;
})(), '');
R.assert('V10b updateReport 同时兼容摘要结构（summarizeCheck 输出）', (() => {
    const sum = summarizeCheck({ ok: true, via: 'remote-manifest:github', judge: { status: 'newer', current: '2.0.0', remote: '2.1.0' }, points: ['x'] }, 7);
    const t = updateReport(sum);
    const c = updateReport(summarizeCheck({ ok: true, isUpToDate: false, judge: { status: 'newer', current: '2.0.0', remote: '2.0.0', commitOnly: true } }, 8));
    return t.indexOf('发现新版本 2.1.0') >= 0 && c.indexOf('同版本新提交') >= 0;
})(), updateReport(summarizeCheck({ ok: true, judge: { status: 'newer', current: '2.0.0', remote: '2.1.0' } }, 1)));
R.assert('V11 summarizeCheck：字段裁剪与默认值', (() => {
    const s = summarizeCheck({ ok: true, via: 'x', judge: { status: 'newer', current: '2.0.0', remote: '2.1.0' }, points: ['a', 'b', 'c', 'd', 'e', 'f'], isUpToDate: false }, 12345);
    return s.at === 12345 && s.ok === true && s.status === 'newer' && s.points.length === 5 && s.isUpToDate === false && s.error === '';
})(), '');
R.assert('V12 默认常量：默认仓库为 GitHub 项目地址 + 分支 main + 24h',
    DEFAULT_UPDATE_REPO === 'https://github.com/fotomxq/stt-memory-plugin-v2' && DEFAULT_UPDATE_BRANCH === 'main' && DEFAULT_UPDATE_INTERVAL_HOURS === 24,
    [DEFAULT_UPDATE_REPO, DEFAULT_UPDATE_BRANCH, DEFAULT_UPDATE_INTERVAL_HOURS]);

R.done();
