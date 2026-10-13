#!/usr/bin/env node
// ============================================================
// scripts/git-sync.js —— 服务端 git 双向同步（先拉后推）
//
// 为什么需要它：
//   本仓库常有多个会话/机器同时推进，本地与服务端会各自领先。
//   手工 `git pull` + `git push` 容易漏掉其中之一，也容易在分叉时
//   误产生合并提交。本脚本把「先拉（快进）→ 有本地新提交再推」
//   固化成一条可重复执行、非交互的命令，并保证：
//     · 默认只做快进（ff-only），不产生意外的合并提交；
//     · 工作区有**已跟踪文件**的改动、或本地与服务端已分叉时，
//       **拒绝写入并以码 2 退出**（与 `local:deploy` 的「条件不足即报错
//       退出且不写任何东西」同约定）；
//     · 同名标签指向不同提交时**只报告不失败**，不影响分支推送；
//     · 全程不弹凭据/编辑器提示（GIT_TERMINAL_PROMPT=0）。
//
// 私钥路径外置（重要）：
//   私钥路径是**本机信息**，不写进脚本、也不入库。放在
//   `scripts/git-sync.config.json`（已被 .gitignore 忽略，且已登记进
//   `check-local-leak.js` 的 SKIP_REL）。模板见同目录 `.example.json`。
//   配置里推荐写 `~` 或环境变量形式（如 `%USERPROFILE%`），既便携又不
//   含真实用户名；脚本会在运行时展开为绝对路径。
//
// 用法：
//   node scripts/git-sync.js                 拉取 + 推送（当前分支）
//   node scripts/git-sync.js --dry-run       只报告计划，不写任何东西
//   node scripts/git-sync.js --tags          顺带推送新增标签
//   node scripts/git-sync.js --rebase        分叉时改用 rebase（默认拒绝）
//   node scripts/git-sync.js --autostash     工作区脏时先暂存，拉完再恢复
//   node scripts/git-sync.js --json          机器可读输出
//
//   其他参数：--remote <名>（默认 origin）· --branch <名>（默认当前分支）
//             --ssh-key <路径>（覆盖配置里的私钥）
//             --no-pull · --no-push · --no-ssh-key · --quiet · --help
//
// 退出码：0 已同步或已成功 · 1 执行出错 · 2 前置条件不足（未写任何东西）
// ============================================================

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_REFUSED = 2;

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, 'git-sync.config.json');

const USAGE = `服务端 git 双向同步（先拉后推）

用法：node scripts/git-sync.js [选项]

选项：
  --remote <名>     远端名，默认取配置或 origin
  --branch <名>     分支名，默认当前分支
  --ssh-key <路径>  覆盖配置里的私钥路径（支持 ~ 与环境变量）
  --no-ssh-key      不使用私钥（交给 git 默认身份发现）
  --dry-run         只报告将要做什么，不写任何东西
  --rebase          本地与服务端分叉时用 rebase 收口（默认拒绝并退出 2）
  --autostash       工作区脏时自动 stash → 拉取 → stash pop
  --tags            顺带推送新增标签（同名但对象不同的标签只报告，不强制覆盖）
  --no-pull         只推送，不拉取
  --no-push         只拉取，不推送
  --json            以 JSON 输出结果
  --quiet           只输出错误与警告
  -h, --help        显示本帮助

私钥路径配置：scripts/git-sync.config.json（本机文件，永不入库）
退出码：0 已同步或已成功 · 1 执行出错 · 2 前置条件不足（未写任何东西）`;

class GitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GitError';
    this.code = code;
  }
}

/**
 * 展开路径里的 `~` 与环境变量写法，得到绝对路径。
 * 注意：`~` 优先用 HOME / USERPROFILE（本机可能以服务账户运行，
 * 此时 os.homedir() 指向的不是用户目录）。
 */
function expandPath(input) {
  if (typeof input !== 'string' || !input) return '';
  let out = input.trim();
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (out === '~') out = home;
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = join(home, out.slice(2));
  out = out.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
  out = out.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => process.env[a ?? b] ?? m);
  return out;
}

/** 读取本机配置文件；不存在或损坏时返回空配置（不致命）。 */
function loadConfig() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return { config: {}, notes: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { config: {}, notes: [`${CONFIG_PATH} 内容不是对象，已忽略`] };
    }
    return { config: parsed, notes: [] };
  } catch (error) {
    return { config: {}, notes: [`${CONFIG_PATH} 解析失败，已忽略：${error.message}`] };
  }
}

/**
 * 执行 git 子命令。
 * 统一关闭交互提示，避免在无人值守时挂死。
 * sshKey 存在时通过 GIT_SSH_COMMAND 指定私钥（让 git 自行解析 ssh，
 * 以免用到系统自带 ssh —— 在服务账户下它可能因文件 ACL 而拒绝私钥）。
 */
function git(args, { allowFail = false, sshKey = '' } = {}) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
  };
  if (sshKey) {
    // 引号包住路径，兼容含空格的目录；正斜杠避免转义歧义。
    const key = sshKey.replace(/\\/g, '/');
    env.GIT_SSH_COMMAND = `ssh -i "${key}" -o IdentitiesOnly=yes -o BatchMode=yes`;
  }
  const res = spawnSync('git', args, { encoding: 'utf8', windowsHide: true, env });
  const out = (res.stdout ?? '').trim();
  const err = (res.stderr ?? '').trim();
  const code = res.status ?? -1;
  if (res.error) throw new GitError(`无法执行 git：${res.error.message}`, code);
  if (!allowFail && code !== 0) {
    throw new GitError(`git ${args.join(' ')} 退出码 ${code}：${err || out || '(无输出)'}`, code);
  }
  return { code, out, err };
}

function parseArgs(argv) {
  const opts = {
    remote: null,
    branch: null,
    sshKey: undefined,
    dryRun: false,
    rebase: false,
    autostash: false,
    tags: null,
    json: false,
    quiet: false,
    pull: true,
    push: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const needValue = (name) => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new GitError(`${name} 需要一个值`, EXIT_ERROR);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--remote': opts.remote = needValue('--remote'); break;
      case '--branch': opts.branch = needValue('--branch'); break;
      case '--ssh-key': opts.sshKey = needValue('--ssh-key'); break;
      case '--no-ssh-key': opts.sshKey = ''; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--rebase': opts.rebase = true; break;
      case '--autostash': opts.autostash = true; break;
      case '--tags': opts.tags = true; break;
      case '--json': opts.json = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--no-pull': opts.pull = false; break;
      case '--no-push': opts.push = false; break;
      case '-h':
      case '--help': opts.help = true; break;
      default: throw new GitError(`未知参数：${arg}（用 --help 看用法）`, EXIT_ERROR);
    }
  }
  return opts;
}

/** 读取分支状态：ahead / behind / 已跟踪改动 / 未跟踪文件。 */
function readState(remote, branch, upstreamExists, sshKey) {
  const upstream = `${remote}/${branch}`;
  let ahead = 0;
  let behind = 0;
  if (upstreamExists) {
    const res = git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], { sshKey });
    const parts = res.out.split(/\s+/).map(Number);
    behind = Number.isFinite(parts[0]) ? parts[0] : 0;
    ahead = Number.isFinite(parts[1]) ? parts[1] : 0;
  }
  const lines = git(['status', '--porcelain'], { sshKey }).out
    .split('\n').map((s) => s.trimEnd()).filter(Boolean);
  return {
    upstream,
    ahead,
    behind,
    tracked: lines.filter((l) => !l.startsWith('??')),
    untracked: lines.filter((l) => l.startsWith('??')),
  };
}

/** 列出远端标签：name -> { obj, peeled }。 */
function listRemoteTags(remote, sshKey) {
  const map = new Map();
  const res = git(['ls-remote', '--tags', remote], { allowFail: true, sshKey });
  if (res.code !== 0) return map;
  for (const line of res.out.split('\n')) {
    if (!line.trim()) continue;
    const [sha, ref] = line.split(/\s+/);
    if (!ref || !ref.startsWith('refs/tags/')) continue;
    let name = ref.slice('refs/tags/'.length);
    if (name.endsWith('^{}')) {
      name = name.slice(0, -3);
      const entry = map.get(name) ?? {};
      entry.peeled = sha;
      map.set(name, entry);
    } else {
      const entry = map.get(name) ?? {};
      entry.obj = sha;
      map.set(name, entry);
    }
  }
  return map;
}

/**
 * 计算需要推送的标签，并把「同名但对象不同」的标签单独列出。
 * 不强制覆盖远端标签 —— 那是破坏性操作，交给使用者显式决定。
 */
function planTags(remote, sshKey) {
  const localTags = git(['tag', '--list'], { sshKey }).out
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const remoteTags = listRemoteTags(remote, sshKey);
  const toPush = [];
  const skipped = [];
  for (const tag of localTags) {
    const localCommit = git(['rev-parse', `${tag}^{commit}`], { allowFail: true, sshKey }).out;
    const entry = remoteTags.get(tag);
    if (!entry) {
      toPush.push(tag);
      continue;
    }
    const remoteCommit = entry.peeled ?? entry.obj;
    if (remoteCommit !== localCommit) {
      skipped.push({ tag, reason: '远端同名标签指向不同提交', localCommit, remoteCommit });
      continue;
    }
    const localObject = git(['rev-parse', tag], { allowFail: true, sshKey }).out;
    if (entry.obj && localObject !== entry.obj) {
      skipped.push({ tag, reason: '提交相同但标签对象不同（仅元数据差异）', localCommit, remoteCommit });
    }
  }
  return { toPush, skipped };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }

  const { config, notes: configNotes } = loadConfig();
  const remote = opts.remote ?? config.remote ?? 'origin';
  const useTags = opts.tags ?? config.tags === true;
  const useAutostash = opts.autostash || config.autostash === true;
  const useRebase = opts.rebase || config.strategy === 'rebase';
  const rawKey = opts.sshKey !== undefined ? opts.sshKey : (config.sshKey ?? '');
  const sshKey = rawKey ? expandPath(rawKey) : '';

  const result = {
    remote,
    branch: null,
    sshKey: sshKey ? '已配置（路径已隐去）' : '未使用',
    dryRun: opts.dryRun,
    pulled: 0,
    pushed: 0,
    pushedNewBranch: false,
    tagsPushed: [],
    tagsSkipped: [],
    notes: [...configNotes],
    status: 'ok',
  };

  const say = (m) => { if (!opts.quiet && !opts.json) process.stdout.write(`${m}\n`); };
  const warn = (m) => { if (!opts.json) process.stderr.write(`警告：${m}\n`); };
  const refuse = (m) => {
    result.status = 'refused';
    result.notes.push(m);
    if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stderr.write(`拒绝执行：${m}\n（未写入任何东西，退出码 ${EXIT_REFUSED}）\n`);
    return EXIT_REFUSED;
  };

  // ---- 前置条件（全部只读，任一不满足即退出码 2 且不写任何东西）----
  const insideRes = git(['rev-parse', '--is-inside-work-tree'], { allowFail: true, sshKey });
  if (insideRes.code !== 0 || insideRes.out !== 'true') return refuse('当前目录不是 git 工作树');

  const branch = opts.branch ?? git(['rev-parse', '--abbrev-ref', 'HEAD'], { sshKey }).out;
  if (!branch || branch === 'HEAD') return refuse('处于 detached HEAD，请先切到一个分支');
  result.branch = branch;

  const remoteUrl = git(['remote', 'get-url', remote], { allowFail: true, sshKey });
  if (remoteUrl.code !== 0) return refuse(`远端 ${remote} 不存在（git remote 看看有哪些）`);

  if (sshKey) say(`私钥：已由 scripts/git-sync.config.json 指定`);
  else say('私钥：未指定，使用 git 默认身份发现');

  // ---- 拉取远端信息 ----
  say(`拉取 ${remote}（${remoteUrl.out}）…`);
  const fetch = git(['fetch', '--prune', remote], { allowFail: true, sshKey });
  if (fetch.code !== 0) {
    process.stderr.write(
      `拉取失败：${fetch.err || fetch.out}\n`
      + `若为鉴权失败，可在 scripts/git-sync.config.json 里指定 sshKey，`
      + `或用 \`git ls-remote ${remote}\` 自行验证。\n`,
    );
    return EXIT_ERROR;
  }
  // 标签单独取：同名标签对象不同会让 fetch 报 rejected，但不应影响分支同步。
  const fetchTags = git(['fetch', '--tags', remote], { allowFail: true, sshKey });
  if (fetchTags.code !== 0) {
    warn(`取标签时有条目被跳过（不影响分支）：${fetchTags.err || fetchTags.out}`);
  }

  const upstreamExists = git(
    ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`],
    { allowFail: true, sshKey },
  ).code === 0;

  let state = readState(remote, branch, upstreamExists, sshKey);

  // ---- 判断能否安全拉取 ----
  const needsPull = opts.pull && state.behind > 0;
  if (needsPull) {
    if (state.ahead > 0 && !useRebase) {
      return refuse(
        `本地与服务端已分叉（本地领先 ${state.ahead}、落后 ${state.behind}）。`
        + '默认不产生合并提交：请先自行 rebase，或用 --rebase 让本脚本收口。',
      );
    }
    if (state.tracked.length > 0 && !useAutostash) {
      return refuse(
        `工作区有 ${state.tracked.length} 处**已跟踪文件**的未提交改动，拉取可能冲突。`
        + '请先提交，或用 --autostash 让本脚本暂存后再恢复。',
      );
    }
  }
  if (state.untracked.length > 0) {
    result.notes.push(`工作区有 ${state.untracked.length} 个未跟踪文件（不影响快进）`);
  }

  // ---- 计划 / dry-run ----
  const planned = [];
  if (needsPull) {
    planned.push(state.ahead > 0
      ? `rebase 本地 ${state.ahead} 个提交到 ${state.upstream}`
      : `快进拉取 ${state.behind} 个提交（ff-only）`);
  }
  if (opts.push && !upstreamExists) {
    // 远端还没有这个分支：没有 upstream 就没有 ahead 可比，必须显式推送并建立跟踪。
    planned.push(`推送新分支 ${branch} 到 ${remote} 并建立跟踪`);
  } else if (opts.push && state.ahead > 0) {
    planned.push(`推送本地 ${state.ahead} 个提交到 ${state.upstream}`);
  }
  if (useAutostash && needsPull && state.tracked.length > 0) {
    planned.push(`暂存并恢复 ${state.tracked.length} 处未提交改动`);
  }

  // ---- 标签计划（--tags）----
  // 必须在「是否已同步」判定**之前**算出来：否则分支已同步时脚本会提前返回，
  // 新标签永远推不上去（空跑）。
  let tagPlan = { toPush: [], skipped: [] };
  if (useTags) {
    tagPlan = planTags(remote, sshKey);
    result.tagsSkipped = tagPlan.skipped;
    for (const item of tagPlan.skipped) warn(`标签 ${item.tag} 未推送：${item.reason}`);
    if (tagPlan.toPush.length > 0) {
      planned.push(`推送 ${tagPlan.toPush.length} 个新标签（${tagPlan.toPush.join(', ')}）`);
    }
  }

  if (planned.length === 0) {
    say(`已同步：${branch} 与 ${state.upstream || remote} 一致，无需操作。`);
    if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return EXIT_OK;
  }
  say('计划：');
  for (const line of planned) say(`  · ${line}`);
  if (opts.dryRun) {
    say('（--dry-run：未执行）');
    result.status = 'dry-run';
    if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return EXIT_OK;
  }

  // ---- 暂存已跟踪改动（仅在确实要拉取时）----
  let stashed = false;
  if (needsPull && state.tracked.length > 0 && useAutostash) {
    const stash = git(['stash', 'push', '--include-untracked', '-m', 'git-sync: autostash'], { sshKey });
    if (stash.code !== 0) throw new GitError(`暂存工作区失败：${stash.err || stash.out}`, stash.code);
    stashed = true;
  }

  try {
    // ---- 拉取 ----
    if (needsPull) {
      if (state.ahead > 0) {
        say(`rebase 到 ${state.upstream} …`);
        const rebase = git(['rebase', state.upstream], { allowFail: true, sshKey });
        if (rebase.code !== 0) {
          git(['rebase', '--abort'], { allowFail: true, sshKey });
          throw new GitError(`rebase 失败（已 abort 回到原状）：${rebase.err || rebase.out}`, rebase.code);
        }
      } else {
        say(`快进到 ${state.upstream} …`);
        const merge = git(['merge', '--ff-only', state.upstream], { allowFail: true, sshKey });
        if (merge.code !== 0) throw new GitError(`快进失败：${merge.err || merge.out}`, merge.code);
      }
      result.pulled = state.behind;
      state = readState(remote, branch, true, sshKey);
    }

    // ---- 推送 ----
    if (opts.push && (!upstreamExists || state.ahead > 0)) {
      say(upstreamExists
        ? `推送 ${state.ahead} 个提交到 ${remote}/${branch} …`
        : `推送新分支 ${branch} 到 ${remote} …`);
      const pushArgs = ['push'];
      if (!upstreamExists) pushArgs.push('--set-upstream');
      pushArgs.push(remote, `${branch}:${branch}`);
      const push = git(pushArgs, { allowFail: true, sshKey });
      if (push.code !== 0) {
        if (/non-fast-forward|fetch first|rejected/i.test(`${push.err}\n${push.out}`)) {
          result.notes.push('推送被拒：远端有新提交，请重跑本脚本完成拉取。');
        }
        throw new GitError(`推送失败：${push.err || push.out}`, push.code);
      }
      if (upstreamExists) {
        result.pushed = state.ahead;
        say(`已推送 ${result.pushed} 个提交。`);
      } else {
        result.pushedNewBranch = true;
        result.notes.push(`已推送新分支 ${branch}（已建立跟踪）`);
        say(`已推送新分支 ${branch}（已建立跟踪）。`);
      }
    }

    // ---- 标签 ----
    if (useTags && tagPlan.toPush.length > 0) {
      say(`推送 ${tagPlan.toPush.length} 个新标签 …`);
      const res = git(['push', remote, ...tagPlan.toPush], { allowFail: true, sshKey });
      if (res.code !== 0) warn(`标签推送失败（分支已推送，不受影响）：${res.err || res.out}`);
      else result.tagsPushed = tagPlan.toPush;
    }
  } finally {
    // ---- 恢复暂存改动 ----
    if (stashed) {
      const pop = git(['stash', 'pop'], { allowFail: true, sshKey });
      if (pop.code !== 0) {
        warn(`恢复暂存改动失败，改动仍在 stash 中（git stash list 可见）：${pop.err || pop.out}`);
      } else {
        say('已恢复未提交改动。');
      }
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return EXIT_OK;
  }
  say(
    `完成：拉取 ${result.pulled} 个提交 · 推送 ${result.pushed} 个提交`
    + (result.pushedNewBranch ? ` · 新分支 ${branch} 已建立跟踪` : '')
    + (result.tagsPushed.length ? ` · 新标签 ${result.tagsPushed.join(', ')}` : ''),
  );
  return EXIT_OK;
}

try {
  process.exitCode = main();
} catch (error) {
  const code = error instanceof GitError && error.code === EXIT_REFUSED ? EXIT_REFUSED : EXIT_ERROR;
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = code;
}
