#!/usr/bin/env node
/**
 * Nine Chronicles (Heimdall) — 无限塔「下一赛季第 1 层」自动冲塔监控
 * ----------------------------------------------------------------
 * 目的：用户一旦进入《无限塔》新赛季（默认第 11 期），立刻自动提交一笔
 *       infinite_tower_battle 打第 1 层。因为无限塔的个人计时器锚定在
 *       「首次进塔」那一笔（Lib9c PerformSeasonReset 设 LastTicketRefillBlockIndex
 *       = currentBlockIndex，并发放 1 张票），越早打第 1 层，个人补票时钟越早开始。
 *
 * 判定（全部满足才提交，只读链上权威状态）：
 *   1) infiniteTowerStatus.infiniteTowerId >= TARGET_SEASON（新赛季已上线）
 *   2) isActive === true（赛季窗口进行中）
 *   3) clearedFloor < 1（第 1 层尚未通关 —— 幂等：通关后本脚本永不重复提交）
 *   4) remainingTickets >= 1（有票；Lib9c 新赛季首笔会送 1 张，正好够第 1 层）
 *
 * 交易构造（字节级复用「本人已成功」的历史 infinite_tower_battle 模板）：
 *   · 从 Mimir 拉该 avatar 最近一笔 SUCCESS 的 infinite_tower_battle.raw；
 *     取不到则回退到内置模板（主角色 bnb 的一笔已成功交易，仅对主角色有效）。
 *   · 只强制改写三个字段：id(新16字节)、infiniteTowerId→目标赛季、floorId→1。
 *   · 装备 / 时装 / 食物 / 符文槽 / buyTicketIfNeeded / useNcgForTicket 原样保留，
 *     确保 CP、装备、符文等链上校验与那笔「最近 SUCCESS」完全一致，自动跟随养成。
 *   · buyTicketIfNeeded=false、useNcgForTicket=false：新赛季首笔送 1 票，不花 NCG/材料。
 *
 * 终态只认 SUCCESS / FAILURE / INVALID（同 claim.mjs 的 isTerminalTxStatus）；
 * 提交后跨节点并行复核，防「伪 INVALID」。提交成功后再次读链上 clearedFloor 确认 >=1。
 *
 * 模式：
 *   node infinite-tower.mjs --once                    # 单次检查，命中即提交一笔
 *   node infinite-tower.mjs --watch                   # 蹲守（主力）：进程内高频轮询，命中即提交，成功即停
 *   node infinite-tower.mjs --watch --gap-ms 20000    # 自定义轮询间隔（默认 20 秒）
 *   node infinite-tower.mjs --once --dry-run          # 只读演练，绝不提交
 *   node infinite-tower.mjs --season 11 --once        # 指定目标赛季号
 *   node infinite-tower.mjs --self-test               # 离线纯逻辑自测（不联网）
 *
 * 高可用：GitHub 的 schedule cron 在高负载时会延迟/丢弃，不能作为抢首层的唯一手段。
 *   --watch 作为长驻主体：一个 job 内每 20 秒轮询一次链，赛季一上链立刻提交（不等下一轮 cron）。
 *   预算耗尽（默认 5.5h < 单 job 6h）打印 {"handoff":"budget_exhausted"}，由 workflow 的
 *   接力 step 用 workflow_dispatch（REST API，准时、不进调度队列）即时刻下一个 job，无缝衔接。
 *   冲塔成功 / 交易定论后打印 {"done":...} / {"stopped":...} 并退出，workflow 不再接力，避免空转。
 *
 * 私钥只从 NC_PRIVATE_KEY（环境变量或同目录 .env）读取，绝不写日志/落盘。
 * 与领奖链/扫货链/AB 链共用同一 keystore Secrets，由 import-key.mjs 生成 .env。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RawPrivateKey, Address } from "@planetarium/account";
import { signTx, encodeSignedTx } from "@planetarium/tx";
import { randomBytes } from "node:crypto";
import { encode, decode, BencodexDictionary } from "@planetarium/bencodex";
import { MEAD, fav, HEIMDALL_GENESIS_HASH } from "@planetarium/lib9c";

// ---------------- 配置 ----------------
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
  privateKey: ENV.NC_PRIVATE_KEY || "",
  // 无限塔状态查询只有 9capi 节点稳定返回，rpc-1 常返回空 —— 故状态查询专用顺序
  statusRpc: "https://heimdall6.9capi.com/graphql",
  rpcUrls: [
    "https://heimdall6.9capi.com/graphql",
    "https://heimdall-rpc-1.nine-chronicles.com/graphql",
  ],
  mimir: "https://mimir.nine-chronicles.dev/heimdall/graphql/",
  confirmTries: 12,
  confirmIntervalMs: 5000,
};

// 主角色 bnb 的 avatar（内置兜底模板归属）
const MAIN_AVATAR = "0xAC9D450C69dF27ee290C90EC61c4B76154b0A21c";
const AVATAR = ENV.NC_AVATAR || MAIN_AVATAR;
const TYPE_ID = "infinite_tower_battle";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ONCE = args.includes("--once");
const WATCH = args.includes("--watch");
const SELF_TEST = args.includes("--self-test");
const numArg = (flag, def) => {
  const i = args.indexOf(flag);
  if (i < 0) return def;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : def;
};
const TARGET_SEASON = Math.max(1, Math.trunc(numArg("--season", 11)));
// 抢首层要快：默认 20 秒轮询一次链上状态（赛季一上链最多 20 秒内命中）。
const GAP_MS = Math.max(5000, numArg("--gap-ms", 20000));
// 单个 job 长驻预算，默认 5.5h（< GitHub 单 job 6h 上限），耗尽后交棒给下一个 job。
// 注意单位是「秒」：下限 10 秒（便于 --max-watch-seconds 60 快速验证交棒），再 ×1000 转毫秒。
const MAX_WATCH_MS = Math.max(10, numArg("--max-watch-seconds", 330 * 60)) * 1000;

// 内置兜底模板：主角色 bnb 在 block 11833685 的一笔 SUCCESS infinite_tower_battle.raw
// （infiniteTowerId=10, floorId=100；本脚本会把赛季改成目标值、楼层改成 1）
const FALLBACK_RAW = "6475373a747970655f69647532313a696e66696e6974655f746f7765725f626174746c6575363a76616c756573647531333a6176617461724164647265737332303aac9d450c69df27ee290c90ec61c4b76154b0a21c7531373a6275795469636b657449664e65656465646675383a636f7374756d65736c31363a3c07374778009e42bfa10a16854b5b3431363a3dbdcb4788e4ea4aa7a8bfc396c12cb931363a47695f4fb8c7a4449ca7c9b99891790b31363adbe17aed6a93ad4288a985f0383732b2657531303a65717569706d656e74736c31363a656ba3105d2d53419c2709151d1877c131363a84afc54e6d44d840948afc3089a2479931363acf5f2258713bc94e943078cfa84e8cbc31363a78cc60679f7f1b49992732ed5b090eb731363a2a9b1888b279d449a8864952c340571431363aa44d5b8d516e95418c834092994f833631363aeba24ec67f4e5c44acf718c40594835b6575373a666c6f6f72496475333a31303075353a666f6f64736c6575323a696431363a755ddb3dbe52b6418cb2f63eeff8ccac7531353a696e66696e697465546f776572496475323a313075313a726c6c75313a3075353a3130303437656c75313a3175353a3130303532656c75313a3375353a3130303231656c75313a3475353a3130303133656c75313a3675353a3130303536656c75313a3775353a3130303531656c75313a3875353a3330303031656c75313a3975353a313030353565657531353a7573654e6367466f725469636b6574666565";

// ---------------- 通用工具 ----------------
async function gql(url, query, variables = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "9c-infinite-tower/1.0" },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

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
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// 交易状态是否为链上终态（与 claim.mjs 完全一致）
function isTerminalTxStatus(s) {
  return s === "SUCCESS" || s === "FAILURE" || s === "INVALID";
}

// ---------------- 链上状态读取 ----------------
async function getTip() {
  const d = await gqlRpc("{ nodeStatus { tip { index } } }");
  return BigInt(d.data.nodeStatus.tip.index);
}

// 无限塔状态：只有 9capi 稳定返回，多试几次防限流返回空
async function getTowerStatus(avatar, tries = 5) {
  const q = `query($a:Address!){ stateQuery { infiniteTowerStatus(avatarAddress:$a){
    infiniteTowerId isActive scheduleStatus currentBlockIndex
    scheduleStartBlockIndex scheduleEndBlockIndex clearedFloor currentFloor
    floorBegin floorEnd hasPlayableFloor remainingTickets maxTickets dailyFreeTickets
  } } }`;
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const d = await gql(CFG.statusRpc, q, { a: avatar });
      const s = d.data?.stateQuery?.infiniteTowerStatus;
      if (s && s.infiniteTowerId != null) return s;
      last = d.errors?.[0]?.message || "空状态";
    } catch (e) { last = e.message; }
    if (i < tries - 1) await sleepMs(800);
  }
  throw new Error(`读取 infiniteTowerStatus 失败: ${last}`);
}

// 读取 avatar 的 agentAddress，用于私钥归属校验
async function getAgentAddress(avatar) {
  const q = "query($a:Address!){ stateQuery { avatar(avatarAddress:$a){ agentAddress } } }";
  const d = await gqlRpc(q, { a: avatar });
  return d.data?.stateQuery?.avatar?.agentAddress || null;
}

// ---------------- 模板获取与 action 构造 ----------------
// 从 Mimir 拉该 avatar 最近一笔 SUCCESS 的 infinite_tower_battle.raw
async function fetchTemplateRaw(avatar) {
  const q = `query($a:Address!){ transactions(filter:{avatarAddress:$a},take:60){
    items { blockIndex object { txStatus actions { typeId raw } } } } }`;
  try {
    const d = await gql(CFG.mimir, q, { a: avatar });
    const items = d.data?.transactions?.items || [];
    for (const it of items) {
      const o = it.object || {};
      if (o.txStatus !== "SUCCESS") continue;
      for (const a of o.actions || []) {
        if (a.typeId === TYPE_ID && a.raw &&
            /^[0-9a-fA-F]+$/.test(a.raw) && a.raw.length % 2 === 0) {
          return { raw: a.raw, source: `mimir@${it.blockIndex}` };
        }
      }
    }
  } catch (e) {
    log({ level: "warn", msg: "拉取历史 infinite_tower_battle 模板失败", detail: String(e.message) });
  }
  if (avatar.toLowerCase() === MAIN_AVATAR.toLowerCase()) {
    return { raw: FALLBACK_RAW, source: "fallback@11833685" };
  }
  throw new Error("本 avatar 无可用 infinite_tower_battle 模板：Mimir 未返回，且内置模板属于主角色");
}

// 只改写三个字段：id(新16字节)、infiniteTowerId→赛季、floorId→1；其余原样保留。
function buildBattleAction(rawHex, avatar, season, floor) {
  const action = decode(Buffer.from(rawHex, "hex"));
  if (!(action instanceof BencodexDictionary) || String(action.get("type_id")) !== TYPE_ID) {
    throw new Error("模板 type_id 校验失败");
  }
  const values = action.get("values");
  if (!(values instanceof BencodexDictionary)) {
    throw new Error("模板 values 结构校验失败");
  }
  // 归属校验：模板 avatarAddress 必须是本角色
  const mine = Buffer.from(Address.fromHex(avatar).toBytes());
  const tmpl = values.get("avatarAddress");
  if (!tmpl || !Buffer.isBuffer(tmpl) || !tmpl.equals(mine)) {
    throw new Error("模板 avatarAddress 与本角色不符");
  }
  const entries = [];
  for (const k of values.keys()) {
    const key = String(k);
    if (key === "id") {
      entries.push([k, randomBytes(16)]);        // 每笔换新，避免被判重复交易
      continue;
    }
    if (key === "infiniteTowerId" || key === "floorId") {
      const orig = values.get(k);
      const target = key === "infiniteTowerId" ? season : floor;
      // 保持模板原值类型（此模板为 Unicode Text 字符串），编码类型不变、字段集合不变
      entries.push([k, typeof orig === "bigint" ? BigInt(target) : String(target)]);
      continue;
    }
    entries.push([k, values.get(k)]);
  }
  return new BencodexDictionary([
    ["type_id", action.get("type_id")],
    ["values", new BencodexDictionary(entries)],
  ]);
}

// ---------------- 交易提交与确认 ----------------
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
  return d.data.stageTransaction;
}

// 跨节点并行复核：任节点返回终态即采用（防单节点「伪 INVALID」）
async function confirmTxAcrossNodes(txId, tries = CFG.confirmTries) {
  const q = "query($t:TxId!){ transaction { transactionResult(txId:$t){ txStatus blockIndex exceptionNames } } }";
  for (let i = 0; i < tries; i++) {
    const results = await Promise.all(CFG.rpcUrls.map(async (url) => {
      try {
        const d = await gql(url, q, { t: txId }, 20000);
        return d.data?.transaction?.transactionResult;
      } catch (_) { return null; }
    }));
    for (const r of results) {
      if (r && isTerminalTxStatus(r.txStatus)) return r;
    }
    if (i < tries - 1) await sleepMs(CFG.confirmIntervalMs);
  }
  return { txStatus: "PENDING" };
}

// ---------------- 判定：是否满足提交条件 ----------------
function decide(status, season) {
  if (!status) return { ok: false, reason: "无链上状态" };
  const cur = Number(status.infiniteTowerId);
  if (!Number.isFinite(cur)) return { ok: false, reason: "赛季号解析失败" };
  if (cur < season) return { ok: false, reason: `目标第${season}期尚未上线（当前第${cur}期）`, currentSeason: cur };
  if (status.isActive !== true) return { ok: false, reason: `赛季未激活（isActive=${status.isActive}, ${status.scheduleStatus}）`, currentSeason: cur };
  if (Number(status.clearedFloor) >= 1) return { ok: false, reason: `第1层已通关（clearedFloor=${status.clearedFloor}），幂等跳过`, currentSeason: cur };
  if (Number(status.remainingTickets) < 1) return { ok: false, reason: `无票（remainingTickets=${status.remainingTickets}），跳过`, currentSeason: cur };
  return { ok: true, reason: `第${cur}期进行中、第1层未通关、有票 —— 命中`, currentSeason: cur };
}

// ---------------- 单次执行 ----------------
async function runOnce(ctx, out) {
  const status = await getTowerStatus(AVATAR);
  const tip = await getTip().catch(() => null);
  out.status = {
    season: status.infiniteTowerId,
    isActive: status.isActive,
    scheduleStatus: status.scheduleStatus,
    clearedFloor: status.clearedFloor,
    currentFloor: status.currentFloor,
    remainingTickets: status.remainingTickets,
    window: `${status.scheduleStartBlockIndex}~${status.scheduleEndBlockIndex}`,
    tip: tip == null ? null : String(tip),
  };
  out.targetSeason = TARGET_SEASON;
  const d = decide(status, TARGET_SEASON);
  out.decision = d;
  log({ level: "info", msg: "无限塔状态检查", ...out.status, target: TARGET_SEASON, hit: d.ok, why: d.reason });
  if (!d.ok) { out.result = "skip"; return; }

  const season = d.currentSeason;   // 用链上实际赛季号（>= 目标），而非写死，避免错过换季
  const template = await fetchTemplateRaw(AVATAR);
  out.template = { source: template.source };
  const actionValue = buildBattleAction(template.raw, AVATAR, season, 1);
  out.action = { typeId: TYPE_ID, infiniteTowerId: season, floorId: 1 };

  if (DRY) { out.result = "dry-run（未提交）"; return; }

  if (!ctx) throw new Error("缺少签名上下文");
  // 归属校验：私钥派生的 signer 必须等于 avatar 的 agentAddress
  const agent = await getAgentAddress(AVATAR);
  if (!agent || agent.toLowerCase() !== ctx.signer.toString().toLowerCase()) {
    throw new Error(`私钥与 avatar 不匹配（signer=${ctx.signer.toString()}, agent=${agent}）`);
  }
  const nonce = await getNonce(ctx.signer.toString());
  const txId = await submitTx({ ...ctx, nonce, actionValue });
  out.txId = txId;
  out.nonce = String(nonce);
  log({ level: "info", msg: "已提交 infinite_tower_battle 第1层", txId, nonce: String(nonce), season });

  const result = await confirmTxAcrossNodes(txId);
  out.txResult = result;
  log({ level: "info", msg: "交易终态", txId, ...result });
  if (result.txStatus !== "SUCCESS") {
    out.result = `交易未成功（${result.txStatus}）`;
    return;
  }
  // 成功后再次读链上确认第1层已通关（交易 SUCCESS 但战斗失利也可能发生）
  let cleared = null;
  for (let i = 0; i < 6; i++) {
    const s = await getTowerStatus(AVATAR, 3).catch(() => null);
    if (s && Number(s.infiniteTowerId) === season && Number(s.clearedFloor) >= 1) { cleared = s; break; }
    await sleepMs(4000);
  }
  if (cleared) {
    out.confirmed = { season: cleared.infiniteTowerId, clearedFloor: cleared.clearedFloor };
    out.result = "冲塔成功：第1层已通关";
    log({ level: "info", msg: "冲塔成功，第1层已通关", season: cleared.infiniteTowerId, clearedFloor: cleared.clearedFloor });
  } else {
    out.result = "交易 SUCCESS 但未确认通关（可能战斗失利，需人工复核，不重复提交）";
    log({ level: "warn", msg: "交易成功但未确认第1层通关，停止以免浪费票", txId });
  }
}

async function makeCtx() {
  if (!CFG.privateKey) return null;
  let hex = CFG.privateKey.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("私钥格式错误：需要 64 位十六进制");
  const account = RawPrivateKey.fromHex(hex);
  const pub = await account.getPublicKey();
  const signer = Address.deriveFrom(pub);
  return { account, pub, signer };
}

async function main() {
  if (SELF_TEST) return selfTest();

  const out = { network: "heimdall", avatar: AVATAR, dryRun: DRY, mode: WATCH ? "watch" : ONCE ? "once" : "once", ok: true };
  let ctx = null;
  if (!DRY) {
    try { ctx = await makeCtx(); }
    catch (e) { log({ level: "error", msg: "私钥加载失败", detail: e.message }); out.ok = false; out.error = e.message; console.log(JSON.stringify(out)); process.exit(1); }
    if (!ctx) { log({ level: "error", msg: "缺少 NC_PRIVATE_KEY" }); out.ok = false; out.error = "缺少 NC_PRIVATE_KEY"; console.log(JSON.stringify(out)); process.exit(1); }
  }

  if (WATCH) {
    const started = Date.now();
    log({ level: "info", msg: "进入无限塔蹲守模式（进程内高频轮询）", targetSeason: TARGET_SEASON, dryRun: DRY, gapMs: GAP_MS, budgetSec: Math.round(MAX_WATCH_MS / 1000) });
    let rounds = 0;
    while (Date.now() - started < MAX_WATCH_MS) {
      rounds++;
      out.round = rounds;
      try {
        await runOnce(ctx, out);
        if (out.result && out.result.startsWith("冲塔成功")) {
          // 目标达成：本脚本使命完成，停止轮询且不交棒，避免赛季内空转浪费 runner。
          out.done = true;
          out.handoff = "none";
          break;
        }
        if (out.result && out.result.startsWith("交易未成功")) break;   // 已定论，不盲目重复
        if (out.result && out.result.startsWith("交易 SUCCESS 但未确认通关")) break;  // 已花票，等人工复核
      } catch (e) {
        log({ level: "warn", msg: "本轮检查异常，稍后重试", detail: e.message });
      }
      await sleepMs(GAP_MS);
    }
    if (!out.done && !out.handoff) {
      // 预算耗尽（非命中、非定论、非演练）：正常交棒，由 workflow 接力 step 立即拉起下一个 job。
      out.handoff = DRY ? "dry_run" : "budget_exhausted";
    }
    out.rounds = rounds;
    out.elapsedSec = Math.round((Date.now() - started) / 1000);
    console.log(JSON.stringify(out));
    return;
  }

  try { await runOnce(ctx, out); }
  catch (e) { log({ level: "error", msg: "执行失败", detail: e.message }); out.ok = false; out.error = e.message; }
  console.log(JSON.stringify(out));
  if (!out.ok) process.exit(1);
}

// ---------------- 离线自测 ----------------
function selfTest() {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error("FAIL:", name); } };

  ok("终态 SUCCESS", isTerminalTxStatus("SUCCESS") === true);
  ok("终态 FAILURE", isTerminalTxStatus("FAILURE") === true);
  ok("终态 INVALID", isTerminalTxStatus("INVALID") === true);
  ok("中间态 STAGING 不算终态", isTerminalTxStatus("STAGING") === false);
  ok("中间态 INCLUDED 不算终态", isTerminalTxStatus("INCLUDED") === false);
  ok("PENDING 不算终态", isTerminalTxStatus("PENDING") === false);

  // 判定逻辑
  const base = { infiniteTowerId: 10, isActive: true, clearedFloor: 0, remainingTickets: 1, scheduleStatus: "Active" };
  ok("旧赛季不命中", decide({ ...base, infiniteTowerId: 10 }, 11).ok === false);
  ok("新赛季+激活+未通关+有票 → 命中", decide({ ...base, infiniteTowerId: 11 }, 11).ok === true);
  ok("未激活不命中", decide({ ...base, infiniteTowerId: 11, isActive: false }, 11).ok === false);
  ok("已通关不命中(幂等)", decide({ ...base, infiniteTowerId: 11, clearedFloor: 1 }, 11).ok === false);
  ok("无票不命中", decide({ ...base, infiniteTowerId: 11, remainingTickets: 0 }, 11).ok === false);
  ok("赛季号超前仍命中(第12期)", decide({ ...base, infiniteTowerId: 12 }, 11).ok === true);
  ok("空状态不命中", decide(null, 11).ok === false);

  // action 构造：内置模板 → 改赛季/楼层，字段类型保持
  try {
    const a = buildBattleAction(FALLBACK_RAW, MAIN_AVATAR, 11, 1);
    const v = a.get("values");
    ok("构造后 type_id 正确", String(a.get("type_id")) === TYPE_ID);
    ok("构造后 infiniteTowerId=11", String(v.get("infiniteTowerId")) === "11");
    ok("构造后 floorId=1", String(v.get("floorId")) === "1");
    ok("构造后 id 为16字节", Buffer.isBuffer(v.get("id")) && v.get("id").length === 16);
    ok("装备原样保留(7)", Array.isArray(v.get("equipments")) && v.get("equipments").length === 7);
    ok("时装原样保留(4)", Array.isArray(v.get("costumes")) && v.get("costumes").length === 4);
    ok("符文原样保留(8)", Array.isArray(v.get("r")) && v.get("r").length === 8);
    ok("buyTicketIfNeeded=false", v.get("buyTicketIfNeeded") === false);
    ok("useNcgForTicket=false", v.get("useNcgForTicket") === false);
    // 两次构造 id 必须不同
    const a2 = buildBattleAction(FALLBACK_RAW, MAIN_AVATAR, 11, 1);
    ok("每次 id 不同", !a2.get("values").get("id").equals(v.get("id")));
  } catch (e) {
    fail++; console.error("FAIL: action 构造异常", e.message);
  }
  // 归属校验：换 avatar 应抛错
  try {
    buildBattleAction(FALLBACK_RAW, "0x3614521b77116568211b70d109A2822C15ec5044", 11, 1);
    fail++; console.error("FAIL: 归属校验未拦截");
  } catch (_) { pass++; }

  console.log(JSON.stringify({ selfTest: true, pass, fail, ok: fail === 0 }));
  if (fail > 0) process.exit(1);
}

main();
