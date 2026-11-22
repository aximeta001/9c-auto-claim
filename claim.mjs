#!/usr/bin/env node
/**
 * Nine Chronicles (Heimdall) — 自动领取巡逻奖励 / 日常奖励
 * ----------------------------------------------------------------
 * 每次运行做一次「检查 + 领取」，供定时任务反复调用：
 *   1. 从链上读取当前 tip、角色的 dailyRewardReceivedIndex、patrol 解锁区块
 *   2. 判断两个奖励是否到了可领取区块
 *   3. 对可领取的奖励，逐笔签名并提交交易（单笔交易只允许 1 个 action）
 *   4. 输出结构化 JSON 结果，退出码 0=正常（含"未到时间/已跳过"），1=有失败
 *
 * 私钥只从环境变量 NC_PRIVATE_KEY 读取（32 字节 hex，可带 0x），
 * 绝不写进本文件、不写日志、不落盘。
 *
 * 用法：
 *   NC_PRIVATE_KEY=xxxx node claim.mjs                 # 一次性检查+领取（兼容旧调用）
 *   NC_PRIVATE_KEY=xxxx node claim.mjs --dry-run       # 只检查不提交
 *   NC_PRIVATE_KEY=xxxx node claim.mjs --reward daily  # 只领某一种
 *   NC_PRIVATE_KEY=xxxx node claim.mjs --watch         # 蹲守：远离窗口秒退、临近自等待、领完即止
 *   NC_PRIVATE_KEY=xxxx node claim.mjs --daemon        # 自接力常驻：守满整个 job 预算，交棒给下一个 job
 *   NC_PRIVATE_KEY=xxxx node claim.mjs --daemon --no-sweep  # 关闭「AP 满时先 sweep」前置
 *   NC_PRIVATE_KEY=xxxx node claim.mjs --daemon --sweep-attempts 3  # sweep 最多试 3 笔
 *   node claim.mjs --self-test                         # 离线自测纯逻辑（含重试决策，不联网）
 *
 * AP 满时先 Sweep：链上 daily_reward7 并无「AP 满不能领」检查，AP 满时领取照样
 * SUCCESS，但它只把 AP 补满到 120（ActionPointMax），等于零收益且白耗一个冷却周期。
 * 故提交日常奖励前，若链上 actionPoint 已满，先发一笔 hack_and_slash_sweep10
 * 消耗掉 AP，再领，才能真正拿到 120 AP。巡逻奖励不涉 AP，不触发。
 *
 * Sweep 现场构造（2026-11-23 重写，替换旧的「套用历史 SUCCESS 模板」）：
 *  装备/时装每笔都从链上 avatar.inventory 的【当前穿戴】实时读取，绝不套旧模板 ——
 *  旧模板的装备 GUID 会被换装弄失效，链上报 ItemDoesNotExistException，反复重试
 *  永远失败（2026-11-22 赛季中就因套旧模板连续失败 30 笔无人知晓）。符文槽因
 *  GraphQL 读不到装配关系，沿用最近 SUCCESS sweep 模板的槽位并用 runes 列表校验。
 *  战场只认链上终态：失败后读 transactionResult.exceptionNames 诊断根因，
 *  装备失效→刷新穿戴装备重试；CP 不足→关卡降 10 级（worldId 重算）重试；
 *  其余→有限重试。每笔换新 id + nonce，重试前复核链上 AP 防重复提交。
 *  穷尽修复仍失败则发邮件告警（含异常/关卡/装备差异），且照常领日常（不阻塞冷却）。
 *
 * --watch 把「等待」搬进本次 job 内部：闹钟只需在解锁窗口内把 job 叫醒一次，
 * 之后由本循环按链上区块自行推进，不依赖闹钟准时、不依赖跨运行状态文件。
 *
 * --daemon 是纯 GitHub 自维持链条的运行体：job 由 workflow 的接力 step 一个接一个
 * 唤起，本循环在单个 job 内持续值守多个奖励周期（默认 5.5h，< GitHub 单 job 6h 上限），
 * 领完不退出，靠「已处理解锁块锁定」实现幂等，直到预算耗尽正常交棒。
 *
 * 依赖：@planetarium/{account,tx,bencodex,lib9c}（见同目录 package.json）
 */

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { RawPrivateKey, Address } from "@planetarium/account";
import { signTx, encodeSignedTx } from "@planetarium/tx";
import { randomBytes } from "node:crypto";
import { encode, decode, BencodexDictionary } from "@planetarium/bencodex";
import { DailyReward, MEAD, fav, HEIMDALL_GENESIS_HASH } from "@planetarium/lib9c";

// ---------------- 配置 ----------------
// 定时任务是无人值守会话，不会保留环境变量，故默认从脚本同目录 .env 读取。
// 优先级：进程环境变量 > .env 文件
const DIR = path.dirname(fileURLToPath(import.meta.url));
function loadEnv() {
  const f = path.join(DIR, ".env");
  if (!fs.existsSync(f)) return {};
  const out = {};
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const ENV = { ...loadEnv(), ...process.env };

// ---------------- 多角色（同一 agent 下的多个 avatar） ----------------
// 一个 keystore/私钥对应一个 agent，一个 agent 下可以有多个 avatar（角色）。
// 三个角色共用同一 signer，因而共用同一条 nonce 队列 —— 若开三条并行常驻链，
// 会互相抢 nonce 造成 FAILURE。所以必须在「同一进程内串行」依次处理每个角色：
// 每笔交易提交前都重新取 nextTxNonce，绝不并发提交。
//
// NC_AVATARS 支持 "名字:0x地址" 或纯 "0x地址"，用逗号/空白分隔；
// 不配置时用下面三个已在 Heimdall 链上核实的角色（同属 agent 0x491b…c3f）。
// 注意：.env 里由 import-key.mjs 写入的 NC_AVATAR 只用于归属校验参考，
// 不参与角色列表决定 —— 否则 GitHub runner 上会退化成只跑一个角色。
const DEFAULT_AVATARS = [
  "bnb:0xAC9D450C69dF27ee290C90EC61c4B76154b0A21c",
  "bnbyes:0x3614521b77116568211b70d109A2822C15ec5044",
  "tomoon:0x897fD3F58c87F26b5C13F78656E688B2a89C6eF1",
];
function parseAvatars(spec) {
  const out = [];
  for (const part of String(spec).split(/[,\s]+/)) {
    if (!part) continue;
    const i = part.indexOf(":");
    const label = i >= 0 ? part.slice(0, i) : `avatar${out.length + 1}`;
    const addr = i >= 0 ? part.slice(i + 1) : part;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`角色地址格式错误: ${part}`);
    out.push({ label, address: addr });
  }
  if (!out.length) throw new Error("NC_AVATARS 为空：至少需要一个角色");
  return out;
}
const AVATARS = parseAvatars(ENV.NC_AVATARS || DEFAULT_AVATARS.join(","));
const CFG = {
  avatarAddress: AVATARS[0].address,   // 兼容旧字段 = 主角色
  avatars: AVATARS,
  privateKey: ENV.NC_PRIVATE_KEY || "",
  // 两个 Heimdall RPC，按优先级做 failover
  rpcUrls: [
    "https://heimdall-rpc-1.nine-chronicles.com/graphql",
    "https://heimdall6.9capi.com/graphql",
  ],
  mimir: "https://mimir.nine-chronicles.dev/heimdall/graphql/",
  api9c: "https://api.9capi.com",
  dailyInterval: 2550n,   // DailyReward.cs: DailyRewardInterval
  patrolInterval: 5400n,  // PatrolRewardSheet.csv: interval
  // 提交后等待上链确认的轮询参数
  confirmTries: 12,
  confirmIntervalMs: 5000,
};

// 当前正在处理的角色。所有链上查询 / 交易构造都读它，由 setActive 串行切换。
// 单角色配置下 ACTIVE 恒等于 AVATARS[0]，行为与旧版完全一致。
let ACTIVE = AVATARS[0];
function setActive(av) { ACTIVE = av; }
function activeAddress() { return ACTIVE.address; }
function taskKey(av, reward) { return `${av.label}|${reward}`; }

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const onlyIdx = args.indexOf("--reward");
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : null; // "daily" | "patrol" | null
const REWARDS = ONLY ? [ONLY] : ["daily", "patrol"];

// ---------------- 蹲守模式参数（--watch） ----------------
// 全部可用命令行覆盖，便于演练与调参；默认值针对 15 分钟心跳 + 加密 schedule
// 的双源闹钟，窗口取 900 块（≈2 小时）以保证「窗口内至少一次成功触发」。
const WATCH = args.includes("--watch");
const numArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : def;
};
const WATCH_WINDOW   = BigInt(Math.max(1, Math.trunc(numArg("--watch-window", 900))));
const POLL_FROM      = 40n;                                        // 剩 40 块起进入密集轮询
const POLL_SEC       = Math.max(1, Math.trunc(numArg("--poll-seconds", 60)));
const SLEEP_CAP_SEC  = 300;                                       // 单次最长睡 5 分钟，醒后重算
const BLOCK_SEC_EST  = 7;                                         // 保守估计（实际约 7~9s），宁可早醒
const MAX_WATCH_MS   = Math.max(10, numArg("--max-watch-seconds", 140 * 60)) * 1000;
// 仅 dry-run 生效的演练钩子：把解锁块伪装成「首轮 tip + N 块」，快速走完整个循环
const SIM_DELTA = args.includes("--simulate-unblock-delta")
  ? BigInt(Math.max(0, Math.trunc(numArg("--simulate-unblock-delta", 0))))
  : null;

// ---------------- 自接力常驻模式（--daemon） ----------------
// 与 --watch 的三点区别：
//  · 永不秒退：远离解锁窗口也留在 job 内按区块数休眠，直到时间预算耗尽才交棒
//  · 领完不退出：把「已处理的解锁块」锁住，链上刷新出更大的解锁块后自动进入下一周期
//  · 幂等靠内存锁而非跨运行状态文件：交易上链/索引有延迟，锁可防止读到旧解锁块时
//    重复提交；但锁带 TTL 兜底 —— 到期链上仍未刷新就主动解锁复核，绝不无限等待漏领
// 接力由 workflow 的独立 step（if: always()）完成，脚本崩溃/超时也不会断链。
const DAEMON = args.includes("--daemon");
const MAX_RUN_MS = Math.max(10, numArg("--max-run-seconds", 330 * 60)) * 1000; // 5.5h < 单 job 6h 上限
const DAEMON_CAP_SEC = Math.max(30, Math.trunc(numArg("--daemon-sleep-cap", 900)));
// 同一解锁块领取后的静默期：期间链上状态若尚未刷新，不重复判定，避免重复提交
const HANDLED_TTL_MS = 30 * 60 * 1000;
// 仅 dry-run 演练生效：模拟 tip 每轮前进块数、领取后解锁块前进块数（用于快速走多周期）
const SIM_TIP_STEP = BigInt(Math.max(1, Math.trunc(numArg("--simulate-tip-step", 20))));
const SIM_CYCLE_BLOCKS = BigInt(Math.max(1, Math.trunc(numArg("--simulate-cycle-blocks", 60))));
// 仅 dry-run 演练生效：模拟 AP 满（让 watchClaim 走一遍 would_sweep 路径，绝不联网/提交）
const SIM_AP_FULL = args.includes("--simulate-ap-full");

// ---------------- 窗口早退（省流） ----------------
// 定时任务是固定频率唤起，无法「平时不跑、临近才跑」。所以由脚本自己早退：
// 远离解锁时只发 1 个轻量 tip 请求就退出，不查 Mimir / 9CAPI、不做归属校验、
// 不构造交易。解锁块缓存仅用于「提前跳过」，绝不用于提交判断 —— 一旦 tip
// 接近或超过缓存解锁块，必走完整链上复核，以链上权威状态为准。
const NO_IDLE_SKIP = args.includes("--no-idle-skip");
const wbIdx = args.indexOf("--window-blocks");
const WINDOW_BLOCKS = wbIdx >= 0 && Number.isFinite(Number(args[wbIdx + 1]))
  ? BigInt(Math.max(0, Math.trunc(Number(args[wbIdx + 1]))))
  // 窗口必须 >= 一次唤起间隔内链上前进的块数，否则可能一步跨过窗口。
  // 15 分钟唤起：按最坏 5 秒/块 ≈ 180 块，取 200 块留余量（约 27 分钟 @8s/块）。
  : 200n;
const IDLE_SKIP = !DRY && !NO_IDLE_SKIP; // dry-run 是人工验证，强制走完整流程
const STATE_FILE = path.join(DIR, ".state.json");
// 缓存最长有效期：即使解锁块被意外写错，也强制在 14 小时内做一次完整复核
const MAX_CACHE_AGE_MS = 14 * 3600 * 1000;

const TYPE_ID = { daily: "daily_reward7", patrol: "claim_patrol_reward" };
const INTERVAL = { daily: CFG.dailyInterval, patrol: CFG.patrolInterval };

// ---------------- AP 满时先 Sweep 消耗（仅日常奖励） ----------------
// 依据 Lib9c/Action/DailyReward.cs：Execute 里没有任何 AP 检查，只做
//   SetActionPoint(avatarAddress, ActionPointMax = 120)  ← 「补满」而非「加 120」
// 于是 AP 已满时领取照样 SUCCESS，但收益为 0，却把 dailyRewardReceivedIndex
// 刷到当前块、白等一个 2550 块冷却。所以在提交 daily_reward7 之前，先发一笔
// hack_and_slash_sweep10 把 AP 消耗掉，再领，才能真正拿到 120 AP。
// 巡逻奖励 claim_patrol_reward 与 AP 无关，不触发。
const AP_MAX = 120;                    // DailyReward.ActionPointMax
const SWEEP_TYPE_ID = "hack_and_slash_sweep10";
const SWEEP_AP_THRESHOLD = 120;        // 当前 AP >= 此值视为「满」，需要提前消耗
const SWEEP_ENABLED = !args.includes("--no-sweep");   // 默认开启
// 每次 sweep 固定消耗多少 AP（目标：把 120AP 全部用掉 = 30 次 sweep，不浪费）。
// 模板里的 actionPoint 会跟着「最近一次手动 sweep」漂移（实测出现过 80/120），
// 若沿用 80 只消耗 80AP，剩 40AP 被 daily 补回，等于白丢 40AP 的 sweep 收益。
// 依据 Lib9c/Action/HackAndSlashSweep.cs Execute：
//   · 对 actionPoint 的唯一硬校验是 actionPoint <= 当前 AP（没有 120 上限）
//   · playCount = actionPoint / CostAP，CostAP 由 StageSheet+质押系数决定
//   · CP 校验 (cp >= SweepRequiredCPSheet[stageId].RequiredCP) 与 playCount 无关
//   · stage446 的 EntryCostItemId = 0（无入场材料），playCount 变大无需改材料字段
// 且 shouldSweep 只在链上 AP >= 120 时才触发，故覆盖成 120 必然满足链上校验。
// 上限钳到 120：绝不能提交超过当前 AP 的值（否则 NotEnoughActionPointException）。
const SWEEP_AP_TARGET = Math.max(1, Math.min(SWEEP_AP_THRESHOLD,
  Math.trunc(numArg("--sweep-ap", SWEEP_AP_THRESHOLD))));
// ---- sweep 失败重试（失败/超时/异常都不要一次就降级）----
// 连续最多 SWEEP_MAX_ATTEMPTS 次提交尝试（含首次）。每轮重试前先读链上
// actionPoint 复核：若 AP 已被消耗，说明上一笔其实成功了（典型的「confirmTx
// 超时但其实 SUCCESS」），立即收敛去领日常，绝不重复提交。这同时保证「AP 已
// 被扣」一定接着领日常，避免出现扣了 120AP 却没补满的错配。
// 链上幂等：多笔 sweep 同时上链时最多只有一笔能扣 120 AP，其余 FAILURE 无
// 副作用 —— 重试提高成功率，但不会重复消耗 AP。全部失败才降级照常领日常。
// 默认 6 = 首次提交 + 失败后最多重试 5 次，正好对应「重试 5 次」。
// 想少试几笔可 --sweep-attempts 3；--sweep-attempts 1 等于退回旧版单次行为。
const SWEEP_MAX_ATTEMPTS = Math.max(1, Math.min(20, Math.trunc(numArg("--sweep-attempts", 6))));
const SWEEP_RETRY_GAP_MS = Math.max(0, numArg("--sweep-retry-gap-ms", 4000));
// 每笔 sweep 给足确认时间（与日常相同），让每次尝试尽量落到确定的终态，
// 而不是半途 PENDING 就又提一笔、把多笔 sweep 堆在链上。
const SWEEP_CONFIRM_TRIES = Math.max(1, Math.min(CFG.confirmTries,
  Math.trunc(numArg("--sweep-confirm-tries", CFG.confirmTries))));
// sweep 整体硬预算：6 轮 ×(确认最多 60s + 间隔 4s) 约 6~7 分钟，留足余量，
// 到点无论结果如何都降级照常领日常，绝不因可选步骤拖过领取窗口。
// 注：每轮 confirmTx 最多 12×5s=60s，实际只在交易迟迟不出终态时才会跑满。
const SWEEP_BUDGET_MS = Math.max(1000, numArg("--sweep-budget-seconds", 480)) * 1000;
// ---- sweep 现场构造配置（2026-11-23）----
// 起始扫荡关卡：优先取「本角色最近一笔 SUCCESS sweep」的 stageId/worldId（跟随养成），
// 拿不到时用这里的默认。CP 不足时逐级下调（见 SWEEP_CP_FALLBACK_STEP）。
const SWEEP_DEFAULT_STAGE = Math.max(1, Math.trunc(numArg("--sweep-stage", 446)));
// stage→world：WorldSheet 里每 50 关一个 world（1-50→1, 401-450→9, 451-500→10…）
function worldOfStage(stage) { return Math.ceil(Number(stage) / 50); }
// CP 不足时每次下调的关卡数（worldId 由 worldOfStage 重算）。0=不降级，只重试。
const SWEEP_CP_FALLBACK_STEP = Math.max(0, Math.trunc(numArg("--sweep-cp-fallback-step", 10)));
// 允许的最低关卡（防止一路降到 stage1 低收益区）；默认 400（world 8 起）。
const SWEEP_MIN_STAGE = Math.max(1, Math.trunc(numArg("--sweep-min-stage", 400)));
// 同一 stage 因「非装备/非CP」原因失败的最大重试次数（避免未知异常无限空转）。
const SWEEP_MAX_SAME_STAGE_RETRY = Math.max(1, Math.trunc(numArg("--sweep-same-stage-retry", 2)));

// ---- 告警邮件配置（凭证只从环境变量/Secrets 读，绝不落盘、不写日志）----
// 用 Node 原生 tls 实现最小 SMTP 客户端，无第三方依赖。端口默认 465(implicit TLS)；
// 若用 587(STARTTLS) 设 NC_SMTP_STARTTLS=1。任一必填项缺失则跳过发信、仅记日志。
const ALERT = {
  host: ENV.NC_SMTP_HOST || "",
  port: Math.trunc(Number(ENV.NC_SMTP_PORT || 465)),
  user: ENV.NC_SMTP_USER || "",
  pass: ENV.NC_SMTP_PASS || "",
  to: ENV.NC_SMTP_TO || "",
  from: ENV.NC_SMTP_FROM || ENV.NC_SMTP_USER || "",
  starttls: /^(1|true|yes)$/i.test(ENV.NC_SMTP_STARTTLS || ""),
  enabled: !args.includes("--no-alert"),
};
function alertConfigured() {
  return ALERT.enabled && !!(ALERT.host && ALERT.user && ALERT.pass && ALERT.to);
}

// ---------------- 工具 ----------------
async function gql(url, query, variables = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "9c-auto-claim/1.0" },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// 依次尝试多个 RPC，返回第一个成功的
async function gqlRpc(query, variables = {}) {
  let lastErr;
  for (const url of CFG.rpcUrls) {
    try {
      const d = await gql(url, query, variables);
      if (d.errors) throw new Error(d.errors[0].message.slice(0, 160));
      return { ...d, _url: url };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`所有 RPC 均失败: ${lastErr?.message}`);
}

function log(obj) { console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj })); }

// ---------------- 解锁块缓存（供窗口早退） ----------------
// 只缓存「下次可领取区块」这一个权威值，领取成功后该缓存自动失效：
// 因为 tip 已越过旧的解锁块，下一轮必然进入完整检查并从链上刷新。
function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch (_) { return null; }
}
function writeState(s) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s), { mode: 0o600 });
    fs.chmodSync(STATE_FILE, 0o600);
  } catch (e) {
    log({ level: "warn", msg: "状态缓存写入失败（不影响本次执行）", detail: String(e.message) });
  }
}

// 是否可窗口早退：缓存有效、完整，且所有待检查奖励都远离解锁点。
// 任一条件不满足 → 返回 null，走完整链上检查（保守，绝不因缓存误事）。
function idleSkipDecision(tip) {
  if (!IDLE_SKIP) return null;
  const s = readState();
  if (!s || s.version !== 1 || !s.unblock || !Number.isFinite(s.updatedAt)) return null;
  if (Date.now() - s.updatedAt > MAX_CACHE_AGE_MS) return null;  // 到期强制复核
  const pending = REWARDS.map((r) => {
    const ub = s.unblock[r];
    return typeof ub === "number" && Number.isFinite(ub) ? ub : null;
  });
  if (pending.some((x) => x === null)) return null;               // 缓存不完整
  const nearest = Math.min(...pending);
  const remaining = nearest - Number(tip);
  if (remaining <= Number(WINDOW_BLOCKS)) return null;            // 已进入窗口
  return {
    nearestUnblockBlock: nearest,
    blocksRemaining: remaining,
    msg: `远离解锁窗口（最近还需约 ${(remaining * 8 / 3600).toFixed(1)} 小时），跳过完整检查`,
  };
}

// ---------------- 链上状态读取 ----------------
async function getTip() {
  const d = await gqlRpc("{ nodeStatus { tip { index } genesis { hash } } }");
  const ns = d.data.nodeStatus;
  return { tip: BigInt(ns.tip.index), genesis: ns.genesis.hash, rpc: d._url };
}

// 读角色链上状态：日常领取区块 + 当前 AP + 所属 agent 地址（用于私钥归属校验）
// actionPoint 是链上权威值（DailyReward 会把它补满到 120）；读不到就返回 null，
// shouldSweep 会据此保守跳过 sweep，绝不臆测。
async function getAvatarState() {
  const q = "query($a:Address!){ stateQuery { avatar(avatarAddress:$a){ actionPoint dailyRewardReceivedIndex agentAddress } } }";
  const d = await gqlRpc(q, { a: activeAddress() });
  const av = d.data?.stateQuery?.avatar;
  return {
    dailyReceivedIndex: av?.dailyRewardReceivedIndex == null ? 0n : BigInt(av.dailyRewardReceivedIndex),
    actionPoint: av?.actionPoint == null ? null : Number(av.actionPoint),
    agentAddress: av?.agentAddress || null,
  };
}

// 巡逻奖励：优先用 9CAPI 的解锁区块；失败则回退到 Mimir 最近一次成功领取 + 5400
async function getPatrolUnblock() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const r = await fetch(CFG.api9c + "/PatrolUnblockIndexHeimdall", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatarAddress: activeAddress() }), signal: ctrl.signal,
    });
    clearTimeout(t);
    const j = await r.json();
    if (typeof j.patrolClaimBlock === "number") {
      return { unblock: BigInt(j.patrolClaimBlock), source: "9capi" };
    }
  } catch (_) { /* 回退 */ }
  // 回退：Mimir 查最近一次该角色、且 signer 匹配的 claim_patrol_reward 成功交易
  try {
    const q = `query($a:Address!){ transactions(filter:{avatarAddress:$a,actionTypeId:"claim_patrol_reward"},take:5){
      items { blockIndex object { signer } } } }`;
    const d = await gql(CFG.mimir, q, { a: activeAddress() });
    const items = d.data?.transactions?.items || [];
    if (items.length) {
      return { unblock: BigInt(items[0].blockIndex) + CFG.patrolInterval, source: "mimir" };
    }
  } catch (_) { /* 继续 */ }
  return { unblock: 0n, source: "unknown" };
}

// ---------------- 交易构造与提交 ----------------
function buildActionValue(reward, avatarAddr) {
  if (reward === "daily") {
    return new DailyReward({ avatarAddress: avatarAddr }).bencode();
  }
  // claim_patrol_reward：与 9CAPI PatrolClaimHeimdall 返回值逐字节一致
  return new BencodexDictionary([
    ["type_id", "claim_patrol_reward"],
    ["values", avatarAddr.toBytes()],
  ]);
}

// ---------------- AP 满时先 Sweep 消耗（详见文件头说明） ----------------
// 只在「日常奖励 + 链上 actionPoint 已达上限」时才需要提前消耗 AP。
// ap 读不到（null）/ 开关关闭 / 巡逻奖励：一律返回 false，绝不臆测。
function shouldSweep(reward, ap) {
  return SWEEP_ENABLED && reward === "daily" &&
    ap !== null && ap !== undefined && Number.isFinite(ap) &&
    ap >= SWEEP_AP_THRESHOLD;
}

// 纯决策（不联网，供 --self-test 覆盖）：一轮 sweep 之后下一步怎么走。
//   success — 已确认 AP 被消耗：交易回执 SUCCESS，或重试前复核链上 AP 已低于满值
//   retry   — 本轮未成功（FAILURE/INVALID/PENDING/异常），且还有剩余次数
//   degrade — 次数用尽，降级照常领日常（绝不阻塞领取、错失冷却窗口）
// 关键点：confirmTx 超时(PENDING) 或回执 FAILURE 时，只要链上 AP 已掉下来，
// 就说明那笔其实生效了 —— 只认链上，不认回执；否则会重复提交、白耗 nonce，
// 甚至出现「sweep 已扣 AP、脚本却判失败去领日常」的错配。
function sweepDecision({ txStatus, chainAp, attempt, maxAttempts }) {
  if (txStatus === "SUCCESS") return "success";
  if (chainAp !== null && chainAp !== undefined && Number.isFinite(chainAp) &&
      chainAp < SWEEP_AP_THRESHOLD) return "success";
  if (attempt >= maxAttempts) return "degrade";
  return "retry";
}

// 失败根因诊断（2026-11-23）：把 exceptionNames 映射为具体修复动作，代替过去
// 「无脑重试同一笔」的死循环。只按链上回执的异常名判断，不臆测。
//   refresh_loadout — 装备/符文 GUID 失效（换装/分解）→ 重新现场读穿戴装备再打
//   lower_stage     — CP 不足 → 关卡下调一级（worldId 重算）
//   retry           — 其它/未知异常 → 同参数有限重试
//   stop            — 明确不可恢复（如关卡锁/AP 逻辑冲突）→ 停止并告警
function diagnoseSweepFailure(exceptionNames) {
  const names = (exceptionNames || []).filter(Boolean).map(String);
  const joined = names.join("|");
  // 装备/符文不在背包：换装后旧 GUID 失效，正是 2026-11-22 连败的根因。
  if (/ItemDoesNotExist|Equipment.*NotFound|Rune.*NotFound|InvalidEquipment|InvalidRune/i.test(joined)) {
    return { action: "refresh_loadout", reason: "装备/符文 GUID 已失效（可能刚换装）", names };
  }
  // CP 不够：降关卡是唯一可靠解（读不到实时 CP，只能靠链上异常反馈逐级试）。
  if (/NotEnoughCombatPoint|CombatPoint/i.test(joined)) {
    return { action: "lower_stage", reason: "CP 不足，需降低扫荡关卡", names };
  }
  // 关卡/世界不合法：可能 stage 超过了已解锁，降一级通常也能解。
  if (/InvalidStage|Stage.*Not.*Unlock|InvalidWorld|World.*Not.*Unlock/i.test(joined)) {
    return { action: "lower_stage", reason: "关卡/世界校验失败", names };
  }
  // 入场材料不足（高关需要门票材料）：降关卡到无入场材料区。
  if (/NotEnoughMaterial|InsufficientMaterial|NotEnoughItem/i.test(joined)) {
    return { action: "lower_stage", reason: "入场材料不足", names };
  }
  if (!names.length) return { action: "retry", reason: "无异常名（超时/PENDING）", names };
  return { action: "retry", reason: "其它异常", names };
}

// 重试前复核链上 AP（只认链上权威值）。读不到返回 null —— 不臆测为成功，
// 让重试/降级兜底，绝不因为一次 RPC 抖动就误判。
async function readChainApQuiet() {
  try {
    const av = await getAvatarState();
    return av.actionPoint === null || av.actionPoint === undefined ? null : av.actionPoint;
  } catch (_) { return null; }
}

// UUID 字符串 → .NET Guid.ToByteArray() 字节序（Lib9c Equipment ItemId 的序列化格式）。
// 与 world-boss.mjs 的 uuidToDotnet 一致：前 3 段小端、后 2 段大端。
function uuidToDotnet(u) {
  const h = String(u).replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new Error(`装备 GUID 格式非法: ${u}`);
  return Buffer.from(
    h.slice(6, 8) + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2) +
    h.slice(10, 12) + h.slice(8, 10) +
    h.slice(14, 16) + h.slice(12, 14) + h.slice(16), "hex");
}

// 取「本角色最近一笔 SUCCESS sweep」的符文槽（runeInfos）与起点关卡。
// GraphQL 只能读到 avatar.runes（拥有哪些符文、等级），读不到「装到哪个槽」，
// 所以符文槽沿用历史 SUCCESS sweep 的槽位，再用 runes 列表校验每个 runeId 是否仍拥有。
// 装备/时装绝不从这里取 —— 那是 2026-11-22 连败 30 笔的根因，改为现场读穿戴。
async function fetchSweepTemplate() {
  const q = `query($a:Address!){ transactions(filter:{avatarAddress:$a},take:40){
    items { blockIndex object { txStatus actions { typeId raw } } } } }`;
  try {
    const d = await gql(CFG.mimir, q, { a: activeAddress() });
    const items = d.data?.transactions?.items || [];
    for (const it of items) {
      const o = it.object || {};
      if (o.txStatus !== "SUCCESS") continue;               // 只认成功的
      for (const a of o.actions || []) {
        if (a.typeId === SWEEP_TYPE_ID && a.raw &&
            /^[0-9a-fA-F]+$/.test(a.raw) && a.raw.length % 2 === 0) {
          const action = decode(Buffer.from(a.raw, "hex"));
          const v = action?.get?.("values");
          if (!(v instanceof BencodexDictionary)) continue;
          // 归属校验：必须是本角色
          const mine = Buffer.from(Address.fromHex(activeAddress()).toBytes());
          const av = v.get("avatarAddress");
          if (!Buffer.isBuffer(av) || !av.equals(mine)) continue;
          const runeSlots = [...v.get("runeInfos")].map(slot => [...slot].map(x => String(x)));
          const stageId = Number(String(v.get("stageId")));
          const worldId = Number(String(v.get("worldId")));
          return { runeSlots, stageId, worldId, source: `mimir@${it.blockIndex}` };
        }
      }
    }
  } catch (e) {
    log({ level: "warn", msg: "拉取历史 sweep 符文槽失败（将用空符文槽现场构造）", detail: String(e.message) });
  }
  // 找不到 SUCCESS 模板：符文槽用空（Lib9c 允许不装符文），关卡用默认——
  // 装备仍现场读，所以不会重蹈「套旧装备」覆辙；只是少了符文加成，CP 可能不够触发降级。
  return { runeSlots: [], stageId: SWEEP_DEFAULT_STAGE,
           worldId: worldOfStage(SWEEP_DEFAULT_STAGE), source: "default" };
}

// 现场读取当前穿戴装备/时装 + 拥有符文列表（权威链上状态），构造 sweep 的装备字段。
// 这是本次改造的核心：装备/时装每次都实时读，换装后自动跟上，绝不再套旧模板 GUID。
async function resolveLiveLoadout() {
  const q = `query($a:Address!){ stateQuery{ avatar(avatarAddress:$a){
    inventory{ equipments{ itemId id level itemSubType equipped } costumes{ itemId equipped } }
    runes{ runeId level }
  } } }`;
  let av = null, lastErr = null;
  for (const url of CFG.rpcUrls) {
    try {
      const d = await gql(url, q, { a: activeAddress() });
      if (d.errors?.length) { lastErr = d.errors[0].message; continue; }
      av = d.data?.stateQuery?.avatar;
      if (av?.inventory) break;
    } catch (e) { lastErr = e.message; }
  }
  if (!av?.inventory) {
    throw new Error(`avatar.inventory 读取失败，拒绝构造以免用错装备：${String(lastErr || "无数据").slice(0, 140)}`);
  }
  const eqs = av.inventory.equipments || [];
  const cos = av.inventory.costumes || [];
  // 当前穿戴的常规装备（equipped=true）。Lib9c 校验的是「背包里存在这些 GUID」，
  // 因此 tuned 后装/换装都能通过；只要 equipped 标记可靠即可。
  const equippedEq = eqs.filter(e => e.equipped);
  const equippedCo = cos.filter(c => c.equipped);
  if (!equippedEq.length) {
    throw new Error("当前无 equipped 装备，拒绝构造（宁可不 sweep 也不用空装备浪费 AP）");
  }
  const equipmentIds = equippedEq.map(e => uuidToDotnet(e.itemId));
  const costumeIds = equippedCo.map(c => uuidToDotnet(c.itemId));
  const ownedRuneIds = new Set((av.runes || []).map(r => Number(r.runeId)));
  return { equipmentIds, costumeIds, ownedRuneIds,
           equipCount: equipmentIds.length, costumeCount: costumeIds.length };
}

// 用现场装备 + 符文槽 + 指定关卡，从零构造一个 hack_and_slash_sweep10 action。
// 字段类型严格对齐 TMPL 那笔 SUCCESS sweep（都用 Unicode Text 表示数字）：
//   actionPoint / apStoneCount / stageId / worldId = Text；runeInfos = [[Text,Text],...]
//   equipments / costumes = List[Bytes(16)]；avatarAddress = Bytes(20)；id = Bytes(16)
function buildSweepActionLive(loadout, template, stageId) {
  const stage = Math.max(1, Math.trunc(Number(stageId)));
  const world = worldOfStage(stage);
  // 符文槽：过滤掉「已不拥有」的符文（换符文/分解后 runeId 失效会报 ItemDoesNotExist）。
  const runeInfos = (template.runeSlots || [])
    .filter(([slot, rid]) => loadout.ownedRuneIds.size === 0 || loadout.ownedRuneIds.has(Number(rid)))
    .map(([slot, rid]) => [String(slot), String(rid)]);
  const values = new BencodexDictionary([
    ["actionPoint", String(SWEEP_AP_TARGET)],  // 一次用满 120 AP
    ["apStoneCount", "0"],                       // 不消耗 AP 药水
    ["avatarAddress", Buffer.from(Address.fromHex(activeAddress()).toBytes())],
    ["costumes", loadout.costumeIds],
    ["equipments", loadout.equipmentIds],
    ["id", randomBytes(16)],                     // 每笔换新，避免重复交易
    ["runeInfos", runeInfos],
    ["stageId", String(stage)],
    ["worldId", String(world)],
  ]);
  return { action: new BencodexDictionary([["type_id", SWEEP_TYPE_ID], ["values", values]]),
           stage, world, runeCount: runeInfos.length };
}

// 提交 sweep 消耗 AP（2026-11-23 重写）：现场构造 + 失败诊断自适应修复。
// 与旧版「重试同一笔 6 次然后静默降级」的本质区别：
//  1. 装备/时装每轮都现场读当前穿戴（换装自动跟上），不再套旧 GUID；
//  2. 失败后读链上 exceptionNames 诊断根因，针对性修复后再打：
//       装备失效 → 强制刷新 loadout；CP/关卡/材料不足 → stage 下调一级；
//  3. 穷尽修复仍失败 → 发邮件告警（含异常名/关卡/装备变化/txId），照常领日常。
// 每一轮仍贯彻「只认链上」：每笔新 id + nonce；重试前复核链上 AP，已消耗立即收手；
// 总耗时硬上限，绝不拖过领取窗口。daily_reward7 无 AP 门槛，sweep 失败不阻塞领取。
async function spendApBySweep(ctx, ap) {
  const started = Date.now();
  const MAX = SWEEP_MAX_ATTEMPTS;
  const info = {
    triggered: true, ap, targetAp: SWEEP_AP_TARGET, status: "skipped",
    maxAttempts: MAX, attempts: 0, attemptLog: [], stage: null,
  };
  if (DRY) {
    info.status = "would_sweep";
    info.msg = `演练：AP 已满，本应现场构造 sweep 消耗 ${SWEEP_AP_TARGET} AP（最多 ${MAX} 次）后再领日常（未提交任何交易）`;
    log({ level: "info", reward: "daily", msg: info.msg, ap, maxAttempts: MAX });
    return info;
  }

  // 现场资源：符文槽/起点关卡拉一次；装备/时装每轮重读。
  let template = null;
  let loadout = null;
  let stage = SWEEP_DEFAULT_STAGE;
  let sameStageFails = 0;       // 同一关卡「非装备/非CP」失败计数，防止未知异常空转
  let lastStatus = null;
  let lastDiag = null;

  for (let attempt = 1; attempt <= MAX; attempt++) {
    // 预算保护
    if (Date.now() - started > SWEEP_BUDGET_MS) {
      log({ level: "warn", reward: "daily",
            msg: "sweep 累计耗时达到上限，转告警并照常领日常",
            elapsedMs: Date.now() - started, attempts: info.attempts });
      info.stopReason = "budget_exhausted";
      break;
    }

    // 非首轮：复核链上 AP，已消耗说明此前某笔其实成功了，立即收手。
    let chainAp = null;
    if (attempt > 1) {
      if (SWEEP_RETRY_GAP_MS > 0) await new Promise(r => setTimeout(r, SWEEP_RETRY_GAP_MS));
      chainAp = await readChainApQuiet();
      info.chainAp = chainAp;
    }
    const pre = sweepDecision({ txStatus: lastStatus, chainAp, attempt: attempt - 1, maxAttempts: MAX });
    if (pre === "success") {
      info.status = "swept";
      info.confirmedBy = "chain_ap";
      info.msg = `复核链上 AP=${chainAp} 已消耗，此前 sweep 已生效，继续领日常`;
      log({ level: "info", reward: "daily", msg: info.msg, attempts: info.attempts, chainAp });
      return info;
    }

    info.attempts = attempt;
    const one = { attempt };
    info.attemptLog.push(one);
    try {
      // 符文槽/关卡模板：首轮拉一次（仅取符文槽，装备绝不取模板）。
      if (!template) template = await fetchSweepTemplate();
      if (stage === SWEEP_DEFAULT_STAGE && Number.isFinite(template.stageId)) {
        stage = Math.max(SWEEP_MIN_STAGE, Math.trunc(template.stageId));
      }
      // 装备/时装每轮现场重读 —— 换装后立刻跟上（修复根因）。
      loadout = await resolveLiveLoadout();
      const built = buildSweepActionLive(loadout, template, stage);
      one.stage = built.stage; one.world = built.world;
      one.equipCount = loadout.equipCount; one.costumeCount = loadout.costumeCount;
      one.runeCount = built.runeCount;
      info.stage = built.stage; info.world = built.world;

      const nonce = await getNonce(ctx.signer.toString());
      one.nonce = Number(nonce);
      const txId = await submitTx({ account: ctx.account, pub: ctx.pub, signer: ctx.signer, nonce, actionValue: built.action });
      one.txId = txId; info.txId = txId;
      log({ level: "info", reward: "daily",
            msg: `AP 已满：现场构造 sweep 消耗 ${SWEEP_AP_TARGET} AP（第 ${attempt}/${MAX} 次）`,
            txId, stage: built.stage, world: built.world, equip: loadout.equipCount,
            costume: loadout.costumeCount, rune: built.runeCount, attempt, maxAttempts: MAX });

      const r = await confirmTx(txId, SWEEP_CONFIRM_TRIES);
      one.txStatus = r.txStatus;
      one.exceptionNames = r.exceptionNames ?? null;
      info.txStatus = r.txStatus;
      info.exceptionNames = r.exceptionNames;
      lastStatus = r.txStatus;

      const post = sweepDecision({ txStatus: r.txStatus, chainAp: null, attempt, maxAttempts: MAX });
      if (post === "success") {
        info.status = "swept";
        info.confirmedBy = "tx_status";
        info.msg = `sweep 成功（第 ${attempt} 次，stage ${stage}），AP 已消耗，继续领日常`;
        log({ level: "info", reward: "daily", msg: info.msg, txId, attempts: info.attempts, stage });
        return info;
      }

      // 未成功：诊断根因，决定下一轮怎么修。
      const diag = diagnoseSweepFailure(r.exceptionNames);
      lastDiag = diag; one.diagnosis = diag;
      log({ level: "warn", reward: "daily",
            msg: `sweep 第 ${attempt}/${MAX} 次未成功：${r.txStatus} / ${diag.action} / ${diag.reason}`,
            txId, stage, names: diag.names, attempt });

      if (diag.action === "lower_stage") {
        // CP/关卡/材料不足：下调关卡（worldId 随之重算），同关卡计数清零。
        if (SWEEP_CP_FALLBACK_STEP > 0 && stage - SWEEP_CP_FALLBACK_STEP >= SWEEP_MIN_STAGE) {
          const from = stage;
          stage -= SWEEP_CP_FALLBACK_STEP;
          sameStageFails = 0;
          log({ level: "info", reward: "daily", msg: `sweep 关卡降级 ${from}→${stage}（world ${worldOfStage(stage)}），下轮重试` });
        } else {
          // 已到最低关卡仍不够 → 无路可降，停止后续尝试。
          info.stopReason = "stage_floor";
          break;
        }
      } else if (diag.action === "refresh_loadout") {
        // 装备失效：下一轮强制重读穿戴（本实现本就每轮重读，这里显式记一次）。
        sameStageFails = 0;
        one.willRefreshLoadout = true;
      } else {
        // 其它/未知异常：同参数有限重试，超过就停。
        sameStageFails += 1;
        if (sameStageFails >= SWEEP_MAX_SAME_STAGE_RETRY) {
          info.stopReason = "repeated_unknown_failure";
          break;
        }
      }
      if (post === "degrade") break;                     // 次数用尽
    } catch (e) {
      one.error = String(e.message);
      lastStatus = null;
      log({ level: "warn", reward: "daily",
            msg: `sweep 第 ${attempt}/${MAX} 次异常，准备重试`,
            detail: String(e.message), attempt, ap });
      if (attempt >= MAX) break;
    }
  }

  // 穷尽修复仍未成功：发告警邮件（不阻塞日常领取）。
  info.status = "sweep_unconfirmed";
  info.msg = `sweep 经 ${info.attempts} 次尝试仍未成功（停止原因=${info.stopReason || "attempts_exhausted"}），已告警并照常领日常`;
  log({ level: "error", reward: "daily", msg: info.msg,
        attempts: info.attempts, lastTxStatus: info.txStatus ?? null,
        lastDiag, stage, ap });
  await sendSweepAlert(info, { ap, stage, loadout, template, lastDiag });
  return info;
}

async function getNonce(signerStr) {
  const d = await gqlRpc("query($a:Address!){ transaction { nextTxNonce(address:$a) } }", { a: signerStr });
  return BigInt(d.data.transaction.nextTxNonce);
}

async function submitTx({ account, pub, signer, nonce, actionValue }) {
  const unsignedTx = {
    nonce,
    genesisHash: HEIMDALL_GENESIS_HASH,
    signer: signer.toBytes(),
    updatedAddresses: new Set(),
    actions: [actionValue],
    publicKey: pub.toBytes("uncompressed"),
    timestamp: new Date(),
    gasLimit: 1n,
    maxGasPrice: fav(MEAD, 0.00001),
  };
  const signedTx = await signTx(unsignedTx, account);
  const payload = Buffer.from(encode(encodeSignedTx(signedTx))).toString("hex");
  const d = await gqlRpc("mutation($p:String!){ stageTransaction(payload:$p) }", { p: payload });
  return d.data.stageTransaction; // txId
}

// 交易状态是否为「链上已定论」的终态。
// Heimdall TxStatus 枚举：INVALID / STAGING / SUCCESS / FAILURE / INCLUDED
//  · 终态：SUCCESS / FAILURE / INVALID —— 可作为领取结论
//  · 中间态：STAGING（未打包）/ INCLUDED（已打包、执行结果未定）
//    INCLUDED 后续可能变 SUCCESS 也可能变 FAILURE（冷却检查在执行阶段才抛
//    RequiredBlockIndexException），绝不能据此判定「已领取」：误判会锁定解锁块，
//    白白错失一整个周期，直到交棒才补领。
function isTerminalTxStatus(s) {
  return s === "SUCCESS" || s === "FAILURE" || s === "INVALID";
}

// 只返回终态；中间态继续轮询，超时返回 PENDING（结果未定，交给链上状态复核）。
// tries 可覆盖：sweep 重试时每笔给足确认时间，尽量落到确定终态再决定是否重提。
async function confirmTx(txId, tries = CFG.confirmTries) {
  const q = "query($t:TxId!){ transaction { transactionResult(txId:$t){ txStatus blockIndex exceptionNames } } }";
  for (let i = 0; i < tries; i++) {
    try {
      const d = await gqlRpc(q, { t: txId });
      const r = d.data?.transaction?.transactionResult;
      if (r && isTerminalTxStatus(r.txStatus)) return r;
    } catch (_) { /* 节点还没索引到 */ }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, CFG.confirmIntervalMs));
  }
  return { txStatus: "PENDING" };
}

// ---------------- 告警邮件（sweep 穷尽修复仍失败时） ----------------
// 用 Node 原生 net/tls 实现最小 SMTP 客户端，零第三方依赖；凭证只从环境变量
// （GitHub Secrets 注入）读取，绝不落盘、不写日志。DRY/未配置时静默跳过。
function mimeHeader(s) {
  // 邮件头防止 CRLF 注入（主题里的异常名来自链上，理论上可控，做基本清洗）
  return String(s).replace(/[\r\n]+/g, " ");
}
function buildAlertMail(subject, body) {
  const lines = [
    `From: ${mimeHeader(ALERT.from)}`,
    `To: ${mimeHeader(ALERT.to)}`,
    `Subject: =?UTF-8?B?${Buffer.from(mimeHeader(subject), "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64"),
  ];
  return lines.join("\r\n") + "\r\n.\r\n";
}

// 极简 SMTP 会话：EHLO → (STARTTLS) → AUTH LOGIN → MAIL FROM → RCPT TO → DATA → QUIT。
// 465 用隐式 TLS 直连；587 先明文 EHLO 再 STARTTLS 升级。用闭包统一 handler，
// 升级 TLS 时把 data/error/close 监听从旧 socket 迁到新 socket，避免误判提前关闭。
function smtpSend(subject, body) {
  return new Promise((resolve, reject) => {
    let sock, buffer = "", phase = "greeting", finished = false, timer;
    let needStarttls = ALERT.starttls;   // 局部副本，STARTTLS 升级后清零，不改全局配置
    const authUser = Buffer.from(ALERT.user).toString("base64");
    const authPass = Buffer.from(ALERT.pass).toString("base64");
    const done = (err) => {
      if (finished) return; finished = true;
      clearTimeout(timer);
      try { sock && sock.destroy(); } catch (_) {}
      err ? reject(err) : resolve();
    };
    const send = (line) => { sock.write(line + "\r\n"); };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 2);
        const code = line.slice(0, 3);
        if (phase === "greeting") {
          if (code !== "220") return done(new Error("SMTP greeting " + line));
          send(`EHLO ${ALERT.host}`); phase = "ehlo";
        } else if (phase === "ehlo") {
          if (needStarttls && code === "250") { send("STARTTLS"); phase = "starttls"; }
          else if (/^250/.test(code)) { send("AUTH LOGIN"); phase = "auth_user"; }
          else return done(new Error("SMTP EHLO " + line));
        } else if (phase === "starttls") {
          if (code !== "220") return done(new Error("SMTP STARTTLS " + line));
          detach(sock);
          const secured = tls.connect({ socket: sock, servername: ALERT.host }, () => {
            attach(secured); send(`EHLO ${ALERT.host}`); phase = "ehlo"; needStarttls = false;
          });
          secured.on("error", e => done(e));
          return;
        } else if (phase === "auth_user") {
          if (code !== "334") return done(new Error("SMTP AUTH user " + line));
          send(authUser); phase = "auth_pass";
        } else if (phase === "auth_pass") {
          if (code !== "334") return done(new Error("SMTP AUTH pass " + line));
          send(authPass); phase = "auth_ok";
        } else if (phase === "auth_ok") {
          if (!/^235/.test(code)) return done(new Error("SMTP AUTH failed " + line));
          send(`MAIL FROM:<${ALERT.user}>`); phase = "mail_from";
        } else if (phase === "mail_from") {
          if (code !== "250") return done(new Error("SMTP MAIL FROM " + line));
          send(`RCPT TO:<${ALERT.to}>`); phase = "rcpt_to";
        } else if (phase === "rcpt_to") {
          if (!/^(250|251)/.test(code)) return done(new Error("SMTP RCPT TO " + line));
          send("DATA"); phase = "data";
        } else if (phase === "data") {
          if (code !== "354") return done(new Error("SMTP DATA " + line));
          sock.write(buildAlertMail(subject, body), "utf8", () => { send("QUIT"); phase = "quit"; });
        } else if (phase === "quit") {
          return done(null);
        }
      }
    };
    const onErr = (e) => done(e);
    const onClose = () => { if (!finished) done(new Error("SMTP 连接提前关闭")); };
    const attach = (s) => { s.setEncoding("utf8"); s.on("data", onData); s.on("error", onErr); s.on("close", onClose); };
    const detach = (s) => { if (s) { s.removeListener("data", onData); s.removeListener("error", onErr); s.removeListener("close", onClose); } };
    sock = needStarttls
      ? net.connect(ALERT.port, ALERT.host)
      : tls.connect({ host: ALERT.host, port: ALERT.port, servername: ALERT.host });
    attach(sock);
    timer = setTimeout(() => done(new Error("SMTP 超时")), 20000);
  });
}

// 组装 sweep 失败告警正文并发送。任何失败只记日志，绝不影响日常领取主流程。
async function sendSweepAlert(info, ctx) {
  if (DRY) { log({ level: "info", msg: "演练：跳过告警邮件" }); return; }
  if (!alertConfigured()) {
    log({ level: "warn", msg: "sweep 失败但告警邮件未配置（缺 NC_SMTP_HOST/USER/PASS/TO），仅记录日志",
          stopReason: info.stopReason || "attempts_exhausted" });
    return;
  }
  const attemptRows = (info.attemptLog || []).map(a =>
    `  - 第${a.attempt}次 stage=${a.stage ?? "-"} world=${a.world ?? "-"} ` +
    `status=${a.txStatus ?? "-"} 异常=${(a.exceptionNames || []).filter(Boolean).join(",") || "-"} ` +
    `诊断=${a.diagnosis?.action ?? "-"} tx=${a.txId || "-"}`).join("\n");
  const body = [
    `9C 自动领奖：AP 消耗 sweep 多次修复后仍失败（需人工关注）`,
    ``,
    `时间：${new Date().toISOString()}`,
    `角色：${ACTIVE.label || ""} ${activeAddress()}`,
    `尝试次数：${info.attempts} / ${info.maxAttempts}`,
    `停止原因：${info.stopReason || "attempts_exhausted"}`,
    `最终关卡：stage ${ctx.stage ?? info.stage ?? "-"}（world ${info.world ?? "-"}）`,
    `当前 AP：${ctx.ap ?? "-"}`,
    `最后异常：${(info.exceptionNames || []).filter(Boolean).join(",") || "-"}`,
    ``,
    `逐次尝试：`,
    attemptRows || "  （无）",
    ``,
    `现场装备：${ctx.loadout?.equipCount ?? "-"} 件 / 时装 ${ctx.loadout?.costumeCount ?? "-"} 件 / 符文槽 ${(ctx.template?.runeSlots || []).length}`,
    `说明：装备/时装已改为现场读取当前穿戴，若仍报 ItemDoesNotExist 请检查是否有装备被锁定或刚刚变动。`,
    `日常奖励不受影响，已照常领取。`,
  ].join("\n");
  const subject = `[9C告警] sweep 失败 stage${ctx.stage ?? info.stage ?? "-"} ${attemptRows ? "" : ""}`.slice(0, 120);
  try {
    await smtpSend(subject, body);
    log({ level: "info", msg: "sweep 失败告警邮件已发送", to: ALERT.to });
  } catch (e) {
    log({ level: "error", msg: "sweep 失败告警邮件发送失败", detail: String(e.message) });
  }
}

// ---------------- 蹲守模式（--watch） ----------------
//  · 不依赖 .state.json（云端 runner 每次全新），每轮直接读链上权威状态
//  · 按剩余「区块数」而非墙上时间推进，区块变快/变慢都能自适应
//  · 两个奖励各自独立判定；提交串行（同一个 signer 不能并发抢 nonce）
//  · 只有领取成功才标记完成；确认未出终态/失败则冷却后按链上状态复核重试
//  · 全局硬超时，退出后由下一次心跳接力，不会永久占用 runner
function planSleepSec(minRem, capSec = SLEEP_CAP_SEC) {
  if (minRem <= 0n) return 0;
  if (minRem <= POLL_FROM) return POLL_SEC;
  return Math.max(1, Math.min(capSec, Number(minRem - POLL_FROM) * BLOCK_SEC_EST));
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function selfTest() {
  const cases = [
    [1000n, SLEEP_CAP_SEC], [100n, 300], [45n, 35],
    [40n, POLL_SEC], [5n, POLL_SEC], [0n, 0],
  ];
  let pass = 0;
  let total = cases.length;
  for (const [rem, expect] of cases) {
    const got = planSleepSec(rem);
    const ok = got === expect;
    console.log(`  planSleepSec(${rem}) = ${got}  期望 ${expect}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  }
  // 终态判定：只有 SUCCESS/FAILURE/INVALID 能下结论，INCLUDED/STAGING 必须继续等。
  // 这是本次修复的核心 —— 把 INCLUDED 当成功会锁定解锁块、错失整个领取周期。
  const terminalCases = [
    ["SUCCESS", true], ["FAILURE", true], ["INVALID", true],
    ["INCLUDED", false], ["STAGING", false], ["PENDING", false],
    [null, false], [undefined, false], ["", false],
  ];
  total += terminalCases.length;
  for (const [s, expect] of terminalCases) {
    const got = isTerminalTxStatus(s);
    const ok = got === expect;
    console.log(`  isTerminalTxStatus(${String(s)}) = ${got}  期望 ${expect}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  }
  // AP 满才 sweep：仅日常 + 链上 AP 已满；AP 未满/读不到/巡逻一律不触发
  const sweepCases = [
    ["daily", 120, true], ["daily", 130, true],
    ["daily", 119, false], ["daily", 0, false],
    ["daily", null, false], ["daily", undefined, false], ["daily", NaN, false],
    ["patrol", 120, false],
  ];
  total += sweepCases.length;
  for (const [rw, apv, expect] of sweepCases) {
    const got = shouldSweep(rw, apv);
    const ok = got === expect;
    console.log(`  shouldSweep(${rw}, ${String(apv)}) = ${got}  期望 ${expect}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  }
  // 现场构造：buildSweepActionLive 用传入的当前装备/符文槽从零拼 action，
  // 字段类型严格对齐（数字用 Text，装备/符文 GUID 用 Bytes）。
  total++;
  try {
    const eq = Buffer.from("11".repeat(16), "hex");
    const co = Buffer.from("22".repeat(16), "hex");
    const loadout = { equipmentIds: [eq], costumeIds: [co], ownedRuneIds: new Set([10056, 10047]) };
    const tpl = { runeSlots: [["0", "10056"], ["1", "10047"], ["3", "99999"]], stageId: 446, worldId: 9 };
    const built = buildSweepActionLive(loadout, tpl, 446);
    const v = built.action.get("values");
    const ok = String(built.action.get("type_id")) === SWEEP_TYPE_ID &&
      String(v.get("actionPoint")) === String(SWEEP_AP_TARGET) &&
      String(v.get("apStoneCount")) === "0" &&
      String(v.get("stageId")) === "446" && String(v.get("worldId")) === "9" &&
      typeof v.get("actionPoint") === "string" &&
      Buffer.isBuffer(v.get("id")) && v.get("id").length === 16 &&
      [...v.get("equipments")][0].equals(eq) &&
      // 不在 ownedRuneIds 的 99999 必须被过滤掉（换符文后失效）
      [...v.get("runeInfos")].length === 2;
    console.log(`  现场构造 action(装备/符文/字段类型) = ${ok}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  } catch (e) {
    console.log(`  现场构造 action FAIL ${e.message}`);
  }
  // stage→world 派生：401-450→9, 451-500→10, 1-50→1（降级时 worldId 必须跟着变）
  total++;
  {
    const cases = [[446, 9], [450, 9], [451, 10], [400, 8], [1, 1], [50, 1], [51, 2]];
    const ok = cases.every(([s, w]) => worldOfStage(s) === w);
    console.log(`  worldOfStage 派生(446→9,451→10,1→1) = ${ok}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  }
  // CP 降级场景：stage 下调后 buildSweepActionLive 的 worldId 必须重算
  total++;
  try {
    const loadout = { equipmentIds: [Buffer.from("11".repeat(16), "hex")], costumeIds: [], ownedRuneIds: new Set() };
    const b1 = buildSweepActionLive(loadout, { runeSlots: [], stageId: 446 }, 446);
    const b2 = buildSweepActionLive(loadout, { runeSlots: [], stageId: 430 }, 430);
    const b3 = buildSweepActionLive(loadout, { runeSlots: [], stageId: 450 }, 450);
    const b4 = buildSweepActionLive(loadout, { runeSlots: [], stageId: 451 }, 451);
    const ok = String(b1.action.get("values").get("worldId")) === "9" &&
      String(b2.action.get("values").get("worldId")) === "9" &&
      String(b3.action.get("values").get("worldId")) === "9" &&
      String(b4.action.get("values").get("worldId")) === "10";
    console.log(`  CP 降关卡后 worldId 重算(450→9,451→10) = ${ok}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  } catch (e) {
    console.log(`  CP 降关卡 worldId 重算 FAIL ${e.message}`);
  }
  // 失败诊断：不同异常名映射到正确修复动作
  total++;
  {
    const dc = [
      [["Nekoyume.Action.ItemDoesNotExistException"], "refresh_loadout"],
      [[null, "Nekoyume.Action.NotEnoughCombatPointException", null], "lower_stage"],
      [["Nekoyume.Action.InvalidStageException"], "lower_stage"],
      [["Nekoyume.Action.NotEnoughMaterialException"], "lower_stage"],
      [[], "retry"],
      [["SomeWeirdException"], "retry"],
    ];
    const ok = dc.every(([ex, want]) => diagnoseSweepFailure(ex).action === want);
    console.log(`  diagnoseSweepFailure 异常→修复映射 = ${ok}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  }
  // actionPoint 恒为 120 / apStoneCount 恒为 0（不因现场装备变化而漂移）
  total++;
  {
    const loadout = { equipmentIds: [Buffer.from("ab".repeat(16), "hex")], costumeIds: [], ownedRuneIds: new Set() };
    const built = buildSweepActionLive(loadout, { runeSlots: [], stageId: 446 }, 446);
    const v = built.action.get("values");
    const ok = String(v.get("actionPoint")) === String(SWEEP_AP_TARGET) && String(v.get("apStoneCount")) === "0";
    console.log(`  现场构造锁死 ${SWEEP_AP_TARGET}AP/0药水 = ${ok}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  }
  // sweep 重试决策：SUCCESS 优先；链上 AP 已消耗也判 success（超时但其实成功）；
  // 次数未满 retry，次数用尽 degrade（降级照常领日常）。只认链上 + 有界重试。
  const M = 6;
  const decisionCases = [
    [{ txStatus: "SUCCESS", chainAp: 120, attempt: 1, maxAttempts: M }, "success"],
    [{ txStatus: "SUCCESS", chainAp: null, attempt: 6, maxAttempts: M }, "success"],
    [{ txStatus: "FAILURE", chainAp: 0,   attempt: 2, maxAttempts: M }, "success"],
    [{ txStatus: "PENDING", chainAp: 119, attempt: 3, maxAttempts: M }, "success"],
    [{ txStatus: "INVALID", chainAp: 12,  attempt: 5, maxAttempts: M }, "success"],
    [{ txStatus: "FAILURE", chainAp: 120, attempt: 1, maxAttempts: M }, "retry"],
    [{ txStatus: "PENDING", chainAp: 120, attempt: 3, maxAttempts: M }, "retry"],
    [{ txStatus: "INVALID", chainAp: null,attempt: 2, maxAttempts: M }, "retry"],
    [{ txStatus: null,      chainAp: null,attempt: 1, maxAttempts: M }, "retry"], // 异常
    [{ txStatus: "FAILURE", chainAp: 120, attempt: 6, maxAttempts: M }, "degrade"],
    [{ txStatus: "PENDING", chainAp: null,attempt: 6, maxAttempts: M }, "degrade"],
    [{ txStatus: null,      chainAp: null,attempt: 6, maxAttempts: M }, "degrade"],
    [{ txStatus: "PENDING", chainAp: NaN, attempt: 6, maxAttempts: M }, "degrade"],
    [{ txStatus: "PENDING", chainAp: NaN, attempt: 2, maxAttempts: M }, "retry"],
  ];
  total += decisionCases.length;
  for (const [inp, expect] of decisionCases) {
    const got = sweepDecision(inp);
    const ok = got === expect;
    const tag = `sD(${inp.txStatus},ap=${String(inp.chainAp)},#${inp.attempt})`;
    console.log(`  ${tag} = ${got}  期望 ${expect}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  }
  // 每笔现场构造的 action 必须换新 id，否则重试会被链上判重复交易；其余字段保持一致
  total++;
  try {
    const loadout = { equipmentIds: [Buffer.from("11".repeat(16), "hex")], costumeIds: [], ownedRuneIds: new Set() };
    const b1 = buildSweepActionLive(loadout, { runeSlots: [], stageId: 446 }, 446).action;
    const b2 = buildSweepActionLive(loadout, { runeSlots: [], stageId: 446 }, 446).action;
    const id1 = Buffer.from(b1.get("values").get("id")).toString("hex");
    const id2 = Buffer.from(b2.get("values").get("id")).toString("hex");
    const ok = id1 !== id2 && id1.length === 32 && id2.length === 32 &&
      String(b1.get("values").get("stageId")) === String(b2.get("values").get("stageId")) &&
      String(b1.get("values").get("actionPoint")) === "120";
    console.log(`  现场构造两次 id 不同 = ${ok}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  } catch (e) {
    console.log(`  现场构造两次 id FAIL ${e.message}`);
  }
  // 语义校验：默认 6 笔 = 首次 + 重试 5 次；带 --sweep-attempts 时按传入值校验
  total++;
  {
    const expected = args.includes("--sweep-attempts")
      ? Math.max(1, Math.min(20, Math.trunc(numArg("--sweep-attempts", 6)))) : 6;
    const ok = SWEEP_MAX_ATTEMPTS === expected;
    console.log(`  sweep 最多 ${SWEEP_MAX_ATTEMPTS} 笔=首次+${SWEEP_MAX_ATTEMPTS - 1} 次重试（期望 ${expected}）  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  }
  // ---- 多角色（同一 agent 下串行处理，绝不串号 / 抢 nonce）----
  total++;
  try {
    const ok = AVATARS.length === 3 &&
      new Set(AVATARS.map((a) => a.address.toLowerCase())).size === 3 &&
      AVATARS.every((a) => /^0x[0-9a-fA-F]{40}$/.test(a.address)) &&
      CFG.avatarAddress === AVATARS[0].address;
    console.log(`  默认三角色配置(3 个互异合法地址) = ${ok}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  } catch (e) { console.log(`  默认三角色配置 FAIL ${e.message}`); }
  total++;
  try {
    const p = parseAvatars(`a:0x${"1".repeat(40)}, b:0x${"2".repeat(40)}`);
    const ok = p.length === 2 && p[0].label === "a" && p[1].address === `0x${"2".repeat(40)}`;
    console.log(`  parseAvatars(名字:地址 + 逗号空白) = ${ok}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  } catch (e) { console.log(`  parseAvatars FAIL ${e.message}`); }
  total++;
  try {
    const q = parseAvatars(`0x${"a".repeat(40)}`);
    const ok = q.length === 1 && q[0].label === "avatar1";
    console.log(`  parseAvatars(纯地址自动命名) = ${ok}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  } catch (e) { console.log(`  parseAvatars 纯地址 FAIL ${e.message}`); }
  total++;
  {
    let threw = false;
    try { parseAvatars("bad:0x1234"); } catch (_) { threw = true; }
    console.log(`  parseAvatars(非法地址必须报错) = ${threw}  ${threw ? "OK" : "FAIL"}`);
    if (threw) pass++;
  }
  total++;
  {
    const ok = taskKey(AVATARS[0], "daily") !== taskKey(AVATARS[1], "daily") &&
      taskKey(AVATARS[0], "daily") !== taskKey(AVATARS[0], "patrol");
    console.log(`  taskKey 按角色+奖励分键 = ${ok}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  }
  total++;
  try {
    const before = activeAddress();
    setActive(AVATARS[1]);
    const switched = activeAddress() === AVATARS[1].address;
    // 现场构造：切到 bnbyes 后 action 的 avatarAddress 必须是 bnbyes，绝不串回 bnb
    const loadout = { equipmentIds: [], costumeIds: [], ownedRuneIds: new Set() };
    const builtB = buildSweepActionLive(loadout, { runeSlots: [], stageId: 446 }, 446).action;
    const addrB = Buffer.from(builtB.get("values").get("avatarAddress")).toString("hex");
    const wantB = Buffer.from(Address.fromHex(AVATARS[1].address).toBytes()).toString("hex");
    setActive(AVATARS[0]);
    const builtA = buildSweepActionLive(loadout, { runeSlots: [], stageId: 446 }, 446).action;
    const addrA = Buffer.from(builtA.get("values").get("avatarAddress")).toString("hex");
    const wantA = Buffer.from(Address.fromHex(AVATARS[0].address).toBytes()).toString("hex");
    const restored = activeAddress() === before;
    const ok = switched && addrB === wantB && addrA === wantA && addrA !== addrB && restored;
    console.log(`  setActive 切换 + 现场构造 avatar 不串号 = ${ok}  ${ok ? "OK" : "FAIL"}`);
    if (ok) pass++;
  } catch (e) { setActive(AVATARS[0]); console.log(`  多角色切换 FAIL ${e.message}`); }

  console.log(`  self-test: ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

// 每轮快照：tip + 角色状态 + 巡逻解锁块，全部取链上/权威接口
async function readWatchSnapshot() {
  const st = await getTip();
  let av;
  try { av = await getAvatarState(); }
  catch (_) { av = { dailyReceivedIndex: null, actionPoint: null, agentAddress: null }; }
  const unblock = {
    daily: av.dailyReceivedIndex === null ? null : av.dailyReceivedIndex + CFG.dailyInterval,
  };
  let patrolSource = "unknown";
  try {
    const p = await getPatrolUnblock();
    if (p.unblock > 0n) { unblock.patrol = p.unblock; patrolSource = p.source; }
    else unblock.patrol = null;
  } catch (_) { unblock.patrol = null; }
  return { st, av, unblock, patrolSource };
}

// 提交单项奖励；done=true 表示本 job 不再处理它。
// 只有 SUCCESS（或演练的 would_claim）算 done；确认未出终态/超时/失败/异常一律
// done=false，由调用方按链上状态复核重提（stop 保留兼容，恒为 false）。
async function watchClaim(reward, ctx, ub, snap) {
  const rec = { reward, typeId: TYPE_ID[reward], unblockBlock: Number(ub) };
  // AP 满时先 sweep 消耗，仅日常奖励。放在 DRY 分支之前，演练也能显示意图。
  // sweep 内部会 confirmTx 等到终态，随后这里重新 getNonce，避免与 sweep 撞 nonce。
  const ap = snap?.av?.actionPoint ?? null;
  if (shouldSweep(reward, ap)) {
    rec.sweep = await spendApBySweep(ctx, ap);
  }
  if (DRY) {
    rec.status = "would_claim";
    rec.msg = "演练模式：已到期，本应提交交易（未提交）";
    log({ level: "info", reward, msg: rec.msg });
    return { rec, done: true };
  }
  try {
    const nonce = await getNonce(ctx.signer.toString());
    const actionValue = buildActionValue(reward, Address.fromHex(activeAddress()));
    const txId = await submitTx({
      account: ctx.account, pub: ctx.pub, signer: ctx.signer, nonce, actionValue,
    });
    rec.txId = txId;
    log({ level: "info", reward, msg: "交易已提交", txId, nonce: Number(nonce) });
    const r = await confirmTx(txId);
    rec.txStatus = r.txStatus;
    rec.blockIndex = r.blockIndex ?? null;
    if (r.txStatus === "SUCCESS") {
      rec.status = "claimed"; rec.msg = "领取成功";
      log({ level: "info", reward, msg: rec.msg, txId });
      return { rec, done: true };
    }
    if (r.txStatus === "PENDING") {
      // 确认超时 / 始终停留中间态：不锁定、不判成功，也不终止。
      // 下一轮直接重读链上解锁块：已刷新说明领到了，没刷新就重新提交。
      // 链上有幂等保护，重复提交最多成功一笔，其余 FAILURE 无副作用。
      rec.status = "pending";
      rec.msg = "已提交但确认未出终态，本轮不锁定；下轮按链上解锁块复核，未刷新则重提";
      log({ level: "warn", reward, msg: rec.msg, txId });
      return { rec, done: false, stop: false };
    }
    rec.status = "failed";
    rec.exceptionNames = r.exceptionNames;
    rec.msg = `交易 ${r.txStatus}` + (r.exceptionNames?.filter(Boolean).length
      ? `: ${r.exceptionNames.filter(Boolean).join(",")}` : "");
    log({ level: "error", reward, msg: rec.msg, txId });
    // 不 stop：一个奖励失败不该终止整个蹲守，继续按链上状态复核重提。
    return { rec, done: false, stop: false };
  } catch (e) {
    rec.status = "error"; rec.msg = String(e.message);
    log({ level: "error", reward, msg: "提交异常", detail: String(e.message) });
    return { rec, done: false, stop: false };
  }
}

async function watchMode() {
  const started = Date.now();
  const out = {
    network: "heimdall", avatar: activeAddress(), dryRun: DRY, mode: "watch",
    rewards: [], ok: true,
    config: {
      windowBlocks: Number(WATCH_WINDOW), pollFromBlocks: Number(POLL_FROM),
      pollSeconds: POLL_SEC, maxWatchSeconds: MAX_WATCH_MS / 1000,
      simulateDelta: SIM_DELTA === null ? null : Number(SIM_DELTA),
      sweepEnabled: SWEEP_ENABLED, apMax: AP_MAX, sweepApThreshold: SWEEP_AP_THRESHOLD,
      sweepApTarget: SWEEP_AP_TARGET, sweepMaxAttempts: SWEEP_MAX_ATTEMPTS, sweepRetryGapMs: SWEEP_RETRY_GAP_MS,
      sweepConfirmTries: SWEEP_CONFIRM_TRIES, sweepBudgetSec: SWEEP_BUDGET_MS / 1000,
    },
  };

  // 私钥与归属校验：与一次性模式同样严格的前置
  if (!CFG.privateKey && !DRY) {
    log({ level: "error", msg: "缺少私钥：请设置环境变量 NC_PRIVATE_KEY" });
    out.ok = false; out.error = "缺少 NC_PRIVATE_KEY";
    console.log(JSON.stringify(out)); process.exit(1);
  }
  let ctx = null;
  if (!DRY) {
    const hex = CFG.privateKey.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      out.ok = false; out.error = "私钥格式错误";
      console.log(JSON.stringify(out)); process.exit(1);
    }
    const account = RawPrivateKey.fromHex(hex);
    const pub = await account.getPublicKey();
    const signer = Address.deriveFrom(pub);
    ctx = { account, pub, signer };
    out.signer = signer.toString();
  }

  const results = new Map();
  const done = new Set();
  let first = true, simUnblock = null;

  while (true) {
    if (Date.now() - started > MAX_WATCH_MS) {
      out.status = "watch_timeout"; out.timedOut = true;
      out.msg = "达到本次 job 硬超时，退出由下一轮接力";
      log({ level: "warn", msg: out.msg });
      break;
    }

    let snap;
    try { snap = await readWatchSnapshot(); }
    catch (e) {
      log({ level: "warn", msg: "快照读取失败，稍后重试", detail: String(e.message) });
      if (DRY && SIM_DELTA === null) { out.status = "snapshot_error"; out.ok = false; break; }
      await sleepMs(Math.min(POLL_SEC, 15) * 1000);
      continue;
    }
    out.tip = Number(snap.st.tip); out.rpc = snap.st.rpc;
    out.patrolSource = snap.patrolSource;
    out.agentAddress = snap.av.agentAddress;
    if (!DRY && ctx && snap.av.agentAddress
        && ctx.signer.toString().toLowerCase() !== snap.av.agentAddress.toLowerCase()) {
      out.status = "aborted"; out.ok = false;
      out.error = "私钥与角色不匹配：已阻止提交";
      log({ level: "error", msg: out.error });
      break;
    }

    // 演练：解锁块固定在首轮 tip + N，之后每轮只读真实 tip，快速走完整循环
    if (DRY && SIM_DELTA !== null) {
      if (simUnblock === null) simUnblock = snap.st.tip + SIM_DELTA;
      for (const r of REWARDS) snap.unblock[r] = simUnblock;
    }

    const pending = REWARDS.filter((r) => !done.has(r));
    if (pending.length === 0) { out.status = "all_claimed"; break; }

    const info = pending.map((r) => {
      const ub = snap.unblock[r];
      const rem = ub === null ? null : (ub > snap.st.tip ? ub - snap.st.tip : 0n);
      return { r, ub, rem };
    });
    const valid = info.filter((x) => x.rem !== null);
    if (valid.length === 0) {
      out.status = "unknown";
      out.msg = "两个解锁块都读不到，保守不提交，退出等下一轮";
      log({ level: "warn", msg: out.msg });
      break;
    }
    const nearest = valid.reduce((a, x) => (x.ub < a.ub ? x : a));
    const minRem = valid.reduce((m, x) => (x.rem < m ? x.rem : m), valid[0].rem);
    out.nearestUnblockBlock = Number(nearest.ub);
    out.blocksRemaining = Number(minRem);

    if (first) {
      first = false;
      log({ level: "info", msg: "蹲守启动", tip: out.tip,
            nearestUnblockBlock: out.nearestUnblockBlock,
            blocksRemaining: Number(minRem), windowBlocks: Number(WATCH_WINDOW) });
    }
    if (minRem > WATCH_WINDOW) {
      out.status = "idle_skip";
      out.msg = `远离解锁窗口（最近还需 ${Number(minRem)} 块 ≈ ${(Number(minRem) * 8 / 3600).toFixed(1)} 小时），秒退`;
      break;
    }

    // 到期项：串行提交
    const due = valid.filter((x) => x.rem <= 0n);
    if (due.length) {
      let problem = false, unsettled = false;
      for (const x of due) {
        const { rec, done: isDone, stop } = await watchClaim(x.r, ctx, x.ub, snap);
        results.set(x.r, rec);
        if (isDone) done.add(x.r);
        else unsettled = true;
        if (stop) problem = true;
      }
      if (problem) { out.status = "claim_problem"; out.ok = false; break; }
      // 领完即止：若另一项也已进入轮询区/到期则继续，否则退出等下一周期
      const rest = REWARDS.filter((r) => !done.has(r)).map((r) => {
        const ub = snap.unblock[r];
        return ub === null ? null : Number(ub > snap.st.tip ? ub - snap.st.tip : 0n);
      }).filter((x) => x !== null);
      if (rest.length === 0 || Math.min(...rest) > Number(POLL_FROM)) {
        out.status = "claimed_and_stop";
        break;
      }
      // 有未决项（结果未定/失败）：节流一个轮询间隔再按链上状态复核重提，
      // 避免 0 秒空转刷 nonce。链上幂等保护，重复提交最多成功一笔。
      if (unsettled) await sleepMs(POLL_SEC * 1000);
      continue;
    }

    const sec = planSleepSec(minRem);
    const phase = minRem <= POLL_FROM ? "poll" : "sleep";
    log({ level: "watch", phase, remaining: Number(minRem), sleepSec: sec,
          msg: phase === "poll" ? "进入密集轮询区" : "按剩余区块数休眠等待" });
    if (DRY && SIM_DELTA === null) {
      out.status = "dry_plan";
      out.msg = `窗口内，本应 sleep ${sec}s 后重读链上（演练不真睡、不提交）`;
      break;
    }
    await sleepMs(sec * 1000);
  }

  out.rewards = REWARDS.map((r) => results.get(r) || {
    reward: r, typeId: TYPE_ID[r], status: done.has(r) ? "done" : "not_reached",
  });
  out.elapsedMs = Date.now() - started;
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}

// ---------------- 自接力常驻模式（--daemon） ----------------
// 纯 GitHub 自维持链条的运行体：单个 job 守满时间预算（默认 5.5h，< 6h 上限），
// 期间跨越多个奖励周期，领完不退出；预算耗尽后正常交棒，由 workflow 接力 step
// 用 workflow_dispatch 触发下一个常驻 job（concurrency 组保证串行、无缝衔接）。
//
// 幂等：handled Map 记住「已成功领取过的解锁块」。链上/索引刷新有延迟，解锁块
// 未变大前暂不重复提交；只有读到严格更大的解锁块（新周期）才解锁重来。
// 判据只认链上，不认回执：confirmTx 只在 SUCCESS/FAILURE/INVALID 终态返回，
// INCLUDED/STAGING 一律继续轮询；超时/失败都不锁定，冷却后按链上状态复核重提。
// 锁带 TTL 兜底：到期链上仍未刷新就主动解锁，确实没领到则重新提交（链上幂等，
// 重复提交最多成功一笔），绝不因「怕重提」而错失整个领取周期。
async function daemonMode() {
  const started = Date.now();
  const out = {
    network: "heimdall", avatar: CFG.avatarAddress, dryRun: DRY, mode: "daemon",
    avatars: AVATARS.map((a) => ({ label: a.label, address: a.address })),
    rewards: [], ok: true, transientErrors: 0,
    config: {
      avatars: AVATARS.length,
      maxRunSeconds: MAX_RUN_MS / 1000,
      pollFromBlocks: Number(POLL_FROM), pollSeconds: POLL_SEC,
      daemonSleepCapSec: DAEMON_CAP_SEC, handledTtlMs: HANDLED_TTL_MS,
      simulateDelta: SIM_DELTA === null ? null : Number(SIM_DELTA),
      simulateTipStep: SIM_DELTA === null ? null : Number(SIM_TIP_STEP),
      simulateCycleBlocks: SIM_DELTA === null ? null : Number(SIM_CYCLE_BLOCKS),
      simulateApFull: SIM_AP_FULL,
      sweepEnabled: SWEEP_ENABLED, apMax: AP_MAX, sweepApThreshold: SWEEP_AP_THRESHOLD,
      sweepApTarget: SWEEP_AP_TARGET, sweepMaxAttempts: SWEEP_MAX_ATTEMPTS, sweepRetryGapMs: SWEEP_RETRY_GAP_MS,
      sweepConfirmTries: SWEEP_CONFIRM_TRIES, sweepBudgetSec: SWEEP_BUDGET_MS / 1000,
    },
  };

  // 私钥与归属前置校验（与一次性 / watch 同样严格）
  if (!CFG.privateKey && !DRY) {
    log({ level: "error", msg: "缺少私钥：请设置环境变量 NC_PRIVATE_KEY" });
    out.ok = false; out.error = "缺少 NC_PRIVATE_KEY";
    console.log(JSON.stringify(out)); process.exit(1);
  }
  let ctx = null;
  if (!DRY) {
    const hex = CFG.privateKey.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      out.ok = false; out.error = "私钥格式错误";
      console.log(JSON.stringify(out)); process.exit(1);
    }
    const account = RawPrivateKey.fromHex(hex);
    const pub = await account.getPublicKey();
    ctx = { account, pub, signer: Address.deriveFrom(pub) };
    out.signer = ctx.signer.toString();
  }

  // 幂等锁 / 结果 / 计数全部按「角色|奖励」分键，避免三个角色互相覆盖。
  // 三个角色共用同一 signer 与 nonce 队列，因此整轮循环严格串行 await：
  // 每笔交易提交前都重新取 nextTxNonce，绝不并发提交。
  const handled = new Map();     // taskKey -> { unblock, at }
  const retryAfter = new Map();  // taskKey -> ms（提交失败冷却）
  const results = new Map();     // taskKey -> 最后一次 rec
  const cycles = new Map();      // taskKey -> 本 job 内领取次数
  let simTip = null;
  const simUb = {};              // 演练用解锁块（仅主角色）
  let first = true, round = 0, handoff = "budget_exhausted";

  while (true) {
    if (Date.now() - started >= MAX_RUN_MS) { handoff = "budget_exhausted"; break; }

    // 离线演练只需验证决策闭环，固定只跑主角色，保持结果确定性。
    const loopAvatars = (DRY && SIM_DELTA !== null) ? AVATARS.slice(0, 1) : AVATARS;
    let minRem = null, waitingRefresh = 0, roundTip = null, snapOk = false;
    let aborted = false;

    for (const av of loopAvatars) {
      setActive(av);   // 之后所有链上查询 / 模板 / 交易构造都指向这个角色
      let snap;
      if (DRY && SIM_DELTA !== null) {
        snap = {
          st: { tip: simTip ?? 1000000n, rpc: "simulated" },
          av: { dailyReceivedIndex: null, agentAddress: null,
                actionPoint: SIM_AP_FULL ? AP_MAX : null },
          unblock: {}, patrolSource: "simulated",
        };
      } else {
        try {
          snap = await readWatchSnapshot();
        } catch (e) {
          if (DRY) {
            out.status = "snapshot_error"; out.ok = false;
            handoff = "snapshot_error"; aborted = true; break;
          }
          // 单个角色快照失败只跳过它本轮，绝不拖垮其它角色的领取
          log({ level: "warn", msg: "快照读取失败，跳过本角色本轮",
                avatar: av.label, detail: String(e.message) });
          continue;
        }
      }
      snapOk = true;
      if (roundTip === null) {
        roundTip = snap.st.tip;
        out.rpc = snap.st.rpc; out.patrolSource = snap.patrolSource;
        out.agentAddress = snap.av.agentAddress;
      }

      // 归属校验：每个角色每轮都做（三个角色同 agent，但绝不假设）
      if (!DRY && ctx && snap.av.agentAddress &&
          ctx.signer.toString().toLowerCase() !== snap.av.agentAddress.toLowerCase()) {
        out.status = "aborted"; out.ok = false; handoff = "aborted";
        out.error = `私钥与角色 ${av.label} 不匹配：已阻止提交`;
        log({ level: "error", msg: out.error, avatar: av.label });
        aborted = true; break;
      }

      // 演练：伪造 tip 每轮前进、解锁块在领取后跳到下一周期
      if (DRY && SIM_DELTA !== null) {
        if (simTip === null) {
          simTip = snap.st.tip;
          for (const r of REWARDS) simUb[taskKey(av, r)] = simTip + SIM_DELTA;
        } else {
          simTip += SIM_TIP_STEP;
        }
        snap.st.tip = simTip;
        for (const r of REWARDS) snap.unblock[r] = simUb[taskKey(av, r)];
      }
      if (first) {
        first = false;
        log({ level: "info", msg: "自接力常驻启动", tip: Number(snap.st.tip),
              avatars: AVATARS.map((a) => a.label),
              maxRunSeconds: MAX_RUN_MS / 1000, windowBlocks: Number(WATCH_WINDOW) });
      }

      for (const r of REWARDS) {
        const key = taskKey(av, r);
        const ub = snap.unblock[r];
        if (ub === null || ub === undefined) continue;   // unknown：保守跳过
        const h = handled.get(key);
        if (h && ub > h.unblock) {
          handled.delete(key);                           // 链上刷新出下一周期：解锁重来
        } else if (h) {
          // 宽限期内等索引刷新；超过 TTL 仍未刷新则主动解锁、按链上状态复核/重提。
          // 链上有幂等保护，重复提交最多成功一笔，其余 FAILURE 无副作用。
          if (Date.now() - h.at > HANDLED_TTL_MS) {
            handled.delete(key);
            log({ level: "warn", avatar: av.label, reward: r,
                  msg: "解锁块超过 TTL 仍未刷新，主动解锁并按链上状态复核/重提",
                  unblockBlock: Number(ub), tip: Number(snap.st.tip) });
          } else {
            waitingRefresh++;
            continue;
          }
        }
        if ((retryAfter.get(key) || 0) > Date.now()) continue;
        const rem = ub > snap.st.tip ? ub - snap.st.tip : 0n;
        if (minRem === null || rem < minRem) minRem = rem;

        if (rem <= 0n) {
          // 串行提交：watchClaim 内部 sweep → getNonce → submit → confirm 全程 await，
          // 与下一个角色的下一笔交易之间绝无并发，共享 nonce 队列不会撞车。
          const { rec } = await watchClaim(r, ctx, ub, snap);
          rec.avatar = av.label; rec.avatarAddress = av.address;
          results.set(key, rec);
          // 只有「领取成功」才锁定解锁块。确认未出终态 / 超时 / 失败一律不锁，
          // 冷却后按链上状态复核重提 —— 绝不错失一个周期。
          const settled = ["claimed", "would_claim"].includes(rec.status);
          if (settled) {
            handled.set(key, { unblock: ub, at: Date.now() });
            cycles.set(key, (cycles.get(key) || 0) + 1);
            if (DRY && SIM_DELTA !== null) simUb[key] = simTip + SIM_CYCLE_BLOCKS;
            log({ level: "daemon", phase: "claimed", avatar: av.label, reward: r,
                  status: rec.status, cycle: cycles.get(key),
                  unblockBlock: Number(ub), tip: Number(snap.st.tip) });
          } else {
            retryAfter.set(key, Date.now() + 60000);
            out.transientErrors++;
            log({ level: "warn", phase: "claim_retry", avatar: av.label, reward: r,
                  status: rec.status, msg: "提交未成功，冷却 60s 后重试" });
          }
        }
      }
      if (aborted) break;
    }
    if (aborted) break;
    if (!snapOk) {
      await sleepMs(Math.min(POLL_SEC, 15) * 1000);
      continue;
    }
    round++;
    out.tip = Number(roundTip);

    let sec, phase;
    if (minRem === null) {
      sec = Math.min(POLL_SEC, 60);
      phase = "wait_refresh";
      out.waitingRefresh = waitingRefresh;
    } else {
      sec = planSleepSec(minRem, DAEMON_CAP_SEC);
      phase = minRem <= POLL_FROM ? "poll" : "sleep";
    }
    log({ level: "daemon", phase, round, avatars: AVATARS.length,
          remaining: minRem === null ? null : Number(minRem),
          sleepSec: sec, cycles: Object.fromEntries(cycles),
          elapsedSec: Math.round((Date.now() - started) / 1000) });

    if (DRY && SIM_DELTA === null) {
      out.status = "dry_plan"; handoff = "dry_plan";
      out.msg = `演练（无模拟）：本应 sleep ${sec}s 并持续值守到 ${MAX_RUN_MS / 1000}s 预算耗尽后交棒；不真睡、不提交`;
      break;
    }
    const leftMs = MAX_RUN_MS - (Date.now() - started);
    await sleepMs(Math.max(0, Math.min(sec * 1000, leftMs)));
  }

  out.status = out.status || handoff;
  out.handoff = handoff;
  out.rounds = round;
  out.rewards = [];
  for (const av of AVATARS) {
    for (const r of REWARDS) {
      const key = taskKey(av, r);
      out.rewards.push({
        avatar: av.label, avatarAddress: av.address,
        reward: r, typeId: TYPE_ID[r], cycles: cycles.get(key) || 0,
        ...(results.get(key) || { status: "watching", msg: "本 job 未触及领取点" }),
      });
    }
  }
  out.avatars = AVATARS.map((a) => ({
    label: a.label, address: a.address,
    cycles: Object.fromEntries(REWARDS.map((r) => [r, cycles.get(taskKey(a, r)) || 0])),
  }));
  out.elapsedMs = Date.now() - started;
  out.msg = out.msg || (handoff === "budget_exhausted"
    ? "时间预算耗尽，正常交棒：由 workflow 接力 step 触发下一个常驻 job"
    : `退出：${handoff}`);
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}

// ---------------- 三角色链上核对（--check-all，只读、绝不提交） ----------------
// 供 workflow 的 dry_run 分支使用：一次性列出每个角色的解锁块、剩余块数、AP、
// 归属，以及本轮若到期会触发哪些动作。不签名、不 stageTransaction、不接力。
async function checkAllMode() {
  const out = {
    network: "heimdall", mode: "check-all", dryRun: true,
    avatars: [], rewards: [], ok: true,
  };
  for (const av of AVATARS) {
    setActive(av);
    const rec = { label: av.label, avatar: av.address };
    try {
      const snap = await readWatchSnapshot();
      rec.tip = Number(snap.st.tip);
      rec.rpc = snap.st.rpc;
      rec.actionPoint = snap.av.actionPoint;
      rec.agentAddress = snap.av.agentAddress;
      rec.patrolSource = snap.patrolSource;
      rec.rewards = REWARDS.map((r) => {
        const ub = snap.unblock[r];
        const rem = ub == null ? null : Number(ub > snap.st.tip ? ub - snap.st.tip : 0n);
        return {
          reward: r, typeId: TYPE_ID[r],
          unblockBlock: ub == null ? null : Number(ub),
          blocksRemaining: rem,
          ready: ub != null && ub <= snap.st.tip,
          wouldSweep: r === "daily" && shouldSweep(r, snap.av.actionPoint),
        };
      });
    } catch (e) {
      rec.error = String(e.message);
      out.ok = false;
    }
    out.avatars.push(rec);
    log({ level: "info", msg: "角色链上核对", avatar: av.label,
          actionPoint: rec.actionPoint, agentAddress: rec.agentAddress,
          rewards: rec.rewards });
  }
  for (const a of out.avatars) {
    for (const r of a.rewards || []) out.rewards.push({ avatar: a.label, ...r });
  }
  out.msg = out.ok
    ? `已核对 ${AVATARS.length} 个角色，未提交任何交易`
    : "部分角色链上读取失败，未提交任何交易";
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}

// ---------------- 主流程 ----------------
async function main() {
  if (args.includes("--self-test")) return selfTest();
  if (args.includes("--check-all")) return checkAllMode();
  if (DAEMON) return daemonMode();
  if (WATCH) return watchMode();
  const started = Date.now();
  const out = { network: "heimdall", avatar: activeAddress(), dryRun: DRY, rewards: [], ok: true };

  if (!CFG.privateKey && !DRY) {
    log({ level: "error", msg: "缺少私钥：请设置环境变量 NC_PRIVATE_KEY" });
    out.ok = false; out.error = "缺少 NC_PRIVATE_KEY";
    console.log(JSON.stringify(out)); process.exit(1);
  }

  let account = null, pub = null, signer = null;
  if (!DRY) {
    let hex = CFG.privateKey.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      log({ level: "error", msg: "私钥格式错误：需要 64 位十六进制（32 字节）" });
      out.ok = false; out.error = "私钥格式错误";
      console.log(JSON.stringify(out)); process.exit(1);
    }
    account = RawPrivateKey.fromHex(hex);
    pub = await account.getPublicKey();
    signer = Address.deriveFrom(pub);
    out.signer = signer.toString();
  }

  let state;
  try {
    state = await getTip();
    out.tip = Number(state.tip);
    out.rpc = state.rpc;
  } catch (e) {
    log({ level: "error", msg: "读取链上 tip 失败", detail: String(e.message) });
    out.ok = false; out.error = "读取 tip 失败";
    console.log(JSON.stringify(out)); process.exit(1);
  }

  // ---- 窗口早退：远离解锁点时只花 1 个 tip 请求就退出，不做归属校验/9CAPI 查询/构造交易 ----
  const skip = idleSkipDecision(state.tip);
  if (skip) {
    out.status = "idle_skip";
    out.windowBlocks = Number(WINDOW_BLOCKS);
    out.nearestUnblockBlock = skip.nearestUnblockBlock;
    out.blocksRemaining = skip.blocksRemaining;
    out.msg = skip.msg;
    out.elapsedMs = Date.now() - started;
    console.log(JSON.stringify(out));
    process.exit(0);
  }
  out.status = "checked";

  // 归属校验：私钥派生的 signer 必须等于角色链上的 agentAddress
  // （链上 ClaimPatrolReward / DailyReward 都会做 CheckAvatarAddrIsContainedInAgent，
  //  不匹配必然 FAILURE 并白耗 gas/nonce，故在本地提前拦截）
  let avatarState;
  try {
    avatarState = await getAvatarState();
    out.agentAddress = avatarState.agentAddress;
    if (!DRY && signer && avatarState.agentAddress) {
      if (signer.toString().toLowerCase() !== avatarState.agentAddress.toLowerCase()) {
        log({ level: "error", msg: "私钥与角色不匹配", signer: signer.toString(), agentAddress: avatarState.agentAddress });
        out.ok = false;
        out.error = "私钥与角色不匹配：该私钥对应的 agent 不是此角色的拥有者，已阻止提交";
        console.log(JSON.stringify(out)); process.exit(1);
      }
    }
  } catch (e) {
    log({ level: "warn", msg: "角色状态读取失败（归属校验跳过）", detail: String(e.message) });
    avatarState = { dailyReceivedIndex: null, agentAddress: null };
  }

  // 计算每种奖励的下次可领取区块
  const unblock = {};
  if (avatarState.dailyReceivedIndex === null) {
    unblock.daily = null;
    log({ level: "warn", msg: "日常领取状态不可用，跳过 daily 以免误判" });
  } else {
    unblock.daily = avatarState.dailyReceivedIndex + CFG.dailyInterval;
  }
  try { const p = await getPatrolUnblock(); unblock.patrol = p.unblock; out.patrolSource = p.source; }
  catch (e) { unblock.patrol = null; log({ level: "warn", msg: "巡逻状态读取失败", detail: String(e.message) }); }

  for (const reward of REWARDS) {
    const ub = unblock[reward];
    const rec = { reward, typeId: TYPE_ID[reward], unblockBlock: ub === null ? null : Number(ub) };
    if (ub === null) {
      rec.status = "unknown"; rec.msg = "无法判断解锁区块，跳过以免误提交";
      out.rewards.push(rec); continue;
    }
    rec.blocksRemaining = Number(ub > state.tip ? ub - state.tip : 0n);
    if (state.tip < ub) {
      rec.status = "not_ready";
      rec.msg = `未到时间，还需约 ${rec.blocksRemaining} 个区块（约 ${(rec.blocksRemaining * 8 / 3600).toFixed(1)} 小时）`;
      out.rewards.push(rec); continue;
    }
    rec.status = DRY ? "would_claim" : "claiming";
    out.rewards.push(rec);

    if (DRY) continue;

    // AP 满时先 sweep 消耗（仅日常奖励）；sweep 内部等到终态，随后重新 getNonce
    if (shouldSweep(reward, avatarState.actionPoint)) {
      rec.sweep = await spendApBySweep({ account, pub, signer }, avatarState.actionPoint);
    }

    // 提交（单笔单 action）
    try {
      const nonce = await getNonce(signer.toString());
      const actionValue = buildActionValue(reward, Address.fromHex(activeAddress()));
      const txId = await submitTx({ account, pub, signer, nonce, actionValue });
      rec.txId = txId;
      log({ level: "info", reward, msg: "交易已提交", txId, nonce: Number(nonce) });
      const result = await confirmTx(txId);
      rec.txStatus = result.txStatus;
      rec.blockIndex = result.blockIndex ?? null;
      if (result.txStatus === "SUCCESS") {
        rec.status = "claimed";
        rec.msg = "领取成功";
      } else {
        rec.status = "failed";
        rec.msg = `交易 ${result.txStatus}` + (result.exceptionNames?.filter(Boolean).length ? `: ${result.exceptionNames.filter(Boolean).join(",")}` : "");
        rec.exceptionNames = result.exceptionNames;
        out.ok = false;
      }
      log({ level: result.txStatus === "SUCCESS" ? "info" : "error", reward, msg: rec.msg, txId });
    } catch (e) {
      rec.status = "error"; rec.msg = String(e.message);
      out.ok = false;
      log({ level: "error", reward, msg: "提交异常", detail: String(e.message) });
    }
  }

  // ---- 维护解锁块缓存（供后续轮次窗口早退）----
  // 原则：宁可多跑一次完整检查，也绝不因缓存漏领。
  //  · 领取成功 → 链上状态已变，删缓存，下一轮强制完整检查刷新到下一周期
  //  · 全部 not_ready 且两个解锁块都有效 → 写缓存，之后可长时间早退
  //  · 其余（failed / error / unknown / 部分成功）→ 清缓存，下一轮继续完整检查重试
  if (!DRY) {
    const claimedAny = out.rewards.some((r) => r.status === "claimed");
    const allNotReady = out.rewards.length > 0 && out.rewards.every((r) => r.status === "not_ready");
    const d = unblock.daily, p = unblock.patrol;
    const bothValid = d && d > 0n && p && p > 0n;
    if (claimedAny) {
      try { fs.rmSync(STATE_FILE, { force: true }); } catch (_) {}
      out.cache = "cleared_after_claim";
    } else if (allNotReady && bothValid) {
      writeState({ version: 1, updatedAt: Date.now(), unblock: { daily: Number(d), patrol: Number(p) } });
      out.cache = "refreshed";
    } else {
      try { fs.rmSync(STATE_FILE, { force: true }); } catch (_) {}
      out.cache = "cleared_retry";
    }
  }

  out.elapsedMs = Date.now() - started;
  console.log(JSON.stringify(out));   // 结构化结果，供定时任务解析
  process.exit(out.ok ? 0 : 1);
}

main().catch((e) => {
  log({ level: "fatal", msg: String(e.stack || e.message) });
  console.log(JSON.stringify({ ok: false, error: String(e.message) }));
  process.exit(1);
});
