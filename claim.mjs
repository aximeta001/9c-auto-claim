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
 *   NC_PRIVATE_KEY=xxxx node claim.mjs                 # 正常领取
 *   NC_PRIVATE_KEY=xxxx node claim.mjs --dry-run       # 只检查不提交
 *   NC_PRIVATE_KEY=xxxx node claim.mjs --reward daily  # 只领某一种
 *
 * 依赖：@planetarium/{account,tx,bencodex,lib9c}（见同目录 package.json）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RawPrivateKey, Address } from "@planetarium/account";
import { signTx, encodeSignedTx } from "@planetarium/tx";
import { encode, BencodexDictionary } from "@planetarium/bencodex";
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
const CFG = {
  avatarAddress: ENV.NC_AVATAR || "0xAC9D450C69dF27ee290C90EC61c4B76154b0A21c",
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

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const onlyIdx = args.indexOf("--reward");
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : null; // "daily" | "patrol" | null
const REWARDS = ONLY ? [ONLY] : ["daily", "patrol"];

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

// 读角色链上状态：日常领取区块 + 所属 agent 地址（用于私钥归属校验）
async function getAvatarState() {
  const q = "query($a:Address!){ stateQuery { avatar(avatarAddress:$a){ dailyRewardReceivedIndex agentAddress } } }";
  const d = await gqlRpc(q, { a: CFG.avatarAddress });
  const av = d.data?.stateQuery?.avatar;
  return {
    dailyReceivedIndex: av?.dailyRewardReceivedIndex == null ? 0n : BigInt(av.dailyRewardReceivedIndex),
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
      body: JSON.stringify({ avatarAddress: CFG.avatarAddress }), signal: ctrl.signal,
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
    const d = await gql(CFG.mimir, q, { a: CFG.avatarAddress });
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

async function confirmTx(txId) {
  const q = "query($t:TxId!){ transaction { transactionResult(txId:$t){ txStatus blockIndex exceptionNames } } }";
  for (let i = 0; i < CFG.confirmTries; i++) {
    try {
      const d = await gqlRpc(q, { t: txId });
      const r = d.data?.transaction?.transactionResult;
      if (r && r.txStatus && r.txStatus !== "STAGING") return r;
    } catch (_) { /* 节点还没索引到 */ }
    if (i < CFG.confirmTries - 1) await new Promise((r) => setTimeout(r, CFG.confirmIntervalMs));
  }
  return { txStatus: "PENDING" };
}

// ---------------- 主流程 ----------------
async function main() {
  const started = Date.now();
  const out = { network: "heimdall", avatar: CFG.avatarAddress, dryRun: DRY, rewards: [], ok: true };

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

    // 提交（单笔单 action）
    try {
      const nonce = await getNonce(signer.toString());
      const actionValue = buildActionValue(reward, Address.fromHex(CFG.avatarAddress));
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
