#!/usr/bin/env node
/**
 * 9C Adventure Boss —— 一键连续 Sweep（极简版）
 * ============================================================================
 * 只做一件事：连续提交 N 笔 `sweep_adventure_boss`（默认 10 笔），代替手工
 * 一次一次点「冲」。除此之外什么都不做：
 *   · 不解锁首层 / 不挑战爬层（unlock_floor、explore_adventure_boss 都由你手工做）
 *   · 不判断是哪个 BOSS（交易里根本没有 bossId，4 个 BOSS 操作完全一样）
 *   · 不领奖、不定时、不常驻、不自接力、不设白名单、不模拟概率
 *   · 纯手动触发：你决定要不要点，点一次跑一批，跑完就退出
 *
 * 为什么可以这么简单（Lib9c 源码 + 链上真实交易双重确认）：
 *   · SweepAdventureBoss.PlainValueInternal 只有 6 个字段：
 *       s=赛季号, a=角色地址, c=时装, e=装备, r=符文槽, id=随机16字节
 *     —— 没有 bossId、没有楼层、没有次数。BOSS 由链上当前赛季的
 *     SeasonInfo.BossId 决定，客户端/脚本都无法也不必指定。
 *   · AdventureBossSheet.csv：4 个 BOSS（211000 Surt / 211001 Laufey /
 *     211002 Jormungandr / 211003 Hela）的 sweep_ap 全部 = 1、explore_ap 全部 = 2。
 *   · 所以每笔交易的结构对 4 个 BOSS 完全一致，唯一要跟着变的是赛季号 s。
 *
 * 构造方式（沿用已上线的 claim.mjs 成熟做法）：
 *   1) 从 Mimir 取「本角色最近一笔 SUCCESS 的 sweep_adventure_boss」原始字节做模板，
 *      自动跟随装备/符文；若本角色最近一笔 SUCCESS 的 explore_adventure_boss 更新，
 *      用它的 costumes/equipments/r 刷新 c/e/r（两者编码格式已验证字节级一致）。
 *   2) 每笔只改两个字段：
 *        id -> 新的 randomBytes(16)（每笔必须不同，否则被判重复交易）
 *        s  -> 当前赛季号（模板是历史赛季，不改会 InvalidAdventureBossSeasonException）
 *      其余字段一字不改，保证链上装备/符文/等级校验与那笔已成功交易完全一致。
 *   3) 赛季号优先读链上 LatestSeason state（SeasonInfo，赛季一开启即写入，不依赖索引），
 *      再用「本季窗口内 SUCCESS 的 adventure boss 交易」交叉校验；两者都没有才拒绝提交，
 *      绝不臆测。Mimir 全局索引在新赛季早期经常还没覆盖，故另备「本角色交易」兜底。
 *      可用 --season 覆盖。
 *   4) 提交策略分两种模式（默认「批量模式」，AB 专用）：
 *
 *      【批量模式 batch · 默认】AB 是可重复执行、失败可事后补齐的操作，
 *      不像日常/巡逻奖励那样「一次机会、重复领取就浪费」，因此不逐笔等终态：
 *        · 整批开始取一次链上 nextTxNonce，之后本地严格 +1 连续递增，
 *          同一 signer 绝不并发抢号；每笔独立 id（16 随机字节）。
 *        · 每笔只做「签名 -> stageTransaction」，笔间留 --gap-ms（默认 2000ms，
 *          略大于实测单笔提交耗时），不查链上终态。
 *        · 全部提交完做一次「总复核」：并行轮询所有 txId 的终态，
 *          只认 SUCCESS/FAILURE/INVALID，INCLUDED/STAGING 不算结论。
 *        · 统计链上 SUCCESS 数；不足目标次数则按差额再补一轮（重新取链上
 *          nextTxNonce 起步），最多 --max-rounds 轮。
 *        · 防「伪 INVALID」：节点尚未索引刚提交的 txId 时会短暂返回
 *          INVALID + blockIndex=null + 无异常名，这不是真终态，继续等；
 *          复核时对每个 txId 跨全部 RPC 节点取结果，任一节点已决即采信。
 *
 *      【逐笔模式 confirm-each · --confirm-each】旧行为，便于排查/保守场景：
 *        每笔重新取 nextTxNonce -> 签名 -> stageTransaction -> 等链上终态，
 *        第一笔非 SUCCESS 立即收手。日常/巡逻奖励链(claim.mjs)仍是这个策略，
 *        本文件不会影响它。
 *
 *   5) 两种模式都只认链上终态，都保证 nonce 不并发、每笔 id 唯一；
 *      批量模式把「等确认」从「每笔一次」压缩成「整批一次」，是提速的关键。
 *
 * 成本提醒（SweepAdventureBoss.Execute 源码）：
 *   requiredPotion = explorer.Floor * sweep_ap(=1)，每笔真扣 AP 药水(500000)。
 *   即「每笔消耗 = 你当前赛季已通关层数 × 1 瓶」。29 层 -> 29 瓶/笔，10 笔 = 290 瓶。
 *   FAILURE/INVALID 时异常回滚不扣药水。脚本不预判层数（链上未暴露该字段），
 *   只做「总药水 >= 次数」的最低门槛检查，真实消耗由链上裁决。
 *
 * 用法：
 *   node sweep-boss.mjs --self-test                 纯逻辑自测，不联网
 *   node sweep-boss.mjs --dry-run                  联网读链并构造 10 笔，不提交
 *   node sweep-boss.mjs --dry-run --times 5        预览 5 笔
 *   node sweep-boss.mjs --times 10                 批量提交 10 笔 + 末尾总复核 + 自动补齐
 *   node sweep-boss.mjs --times 10 --gap-ms 1500   调整笔间间隔
 *   node sweep-boss.mjs --times 10 --confirm-each  回退到逐笔等终态的旧模式
 *   node sweep-boss.mjs --times 10 --season 1429   手工指定赛季号
 *
 * 批量模式参数：
 *   --gap-ms N             笔间间隔，默认 2000（应略大于单笔提交耗时）
 *   --final-tries N        总复核最多轮询轮数，默认 12
 *   --final-interval-ms N  总复核轮询间隔，默认 3000（并行查全部 txId，不随笔数增长）
 *   --max-rounds N         最多「提交+复核」轮数（含补齐），默认 3
 *
 * 依赖：@planetarium/{account,tx,bencodex,lib9c}（见同目录 package.json）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RawPrivateKey, Address } from "@planetarium/account";
import { signTx, encodeSignedTx } from "@planetarium/tx";
import { randomBytes } from "node:crypto";
import { encode, decode, BencodexDictionary } from "@planetarium/bencodex";
import { fav, MEAD, HEIMDALL_GENESIS_HASH } from "@planetarium/lib9c";

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
  avatarAddress: ENV.NC_AVATAR || "0xAC9D450C69dF27ee290C90EC61c4B76154b0A21c",
  privateKey: ENV.NC_PRIVATE_KEY || "",
  rpcUrls: [
    "https://heimdall-rpc-1.nine-chronicles.com/graphql",
    "https://heimdall6.9capi.com/graphql",
  ],
  mimir: "https://mimir.nine-chronicles.dev/heimdall/graphql/",
  api9c: "https://api.9capi.com",
  confirmTries: 12,
  confirmIntervalMs: 5000,
  // 批量模式（AB 专用）：不等每笔终态，整批提交完再一次性复核 + 自动补齐
  finalTries: 12,          // 总复核最多轮询轮数
  finalIntervalMs: 3000,   // 总复核轮询间隔（并行查全部 txId，不随笔数线性增长）
  maxRounds: 3,            // 最多「提交+复核」轮数，防止无限补齐
};

const TYPE_ID = "sweep_adventure_boss";
// 赛季号来源白名单：只取「严格校验 Season == 当前赛季」的三类 SUCCESS 交易。
// 故意排除 wanted —— Lib9c/Action/AdventureBoss/Wanted.cs:78-83 明确允许
//   Season == latestSeason.Season + 1（提前投注下一季），从它解析会拿到下一季号，
//   导致 10 笔全部 InvalidAdventureBossSeasonException。
// sweep/explore/unlock_floor 三者都在 Execute 里硬性要求 Season == 当前赛季，
// 所以任何 SUCCESS 的这类交易，其 s/season 必然就是当时的当前赛季号。
const AB_TYPES = new Set([
  "sweep_adventure_boss", "explore_adventure_boss", "unlock_floor",
]);
const AP_STONE_ID = 500000;
// Lib9c Addresses.Inventory —— 迁移后的 inventory 存放在这个独立账户下，
// account state 的 key 就是 avatarAddress（见 AvatarModule.GetInventoryV2）。
// Mimir 的 inventory() 查询读的是旧版 AvatarState.inventory，迁移后是过时的
// 快照（实测本角色旧值 566，V2 真值 14268），绝不能用它做药水判断。
const INVENTORY_ACCOUNT = "0x000000000000000000000000000000000000001c";

// 兜底模板：本角色区块 11757007 已 SUCCESS 的 sweep_adventure_boss 原始 action。
// 正常运行时不用它 —— 每次都从 Mimir 取「本角色最近一笔 SUCCESS」动态跟随。
// 仅当 Mimir 完全拉不到时回退；其中的 s(1427) 仍会被覆盖成当前赛季号。
const FALLBACK_TEMPLATE_RAW =
  "6475373a747970655f69647532303a73776565705f616476656e747572655f626f737375363a76616c7565736475313a" +
  "6132303aac9d450c69df27ee290c90ec61c4b76154b0a21c75313a636c31363a3c07374778009e42bfa10a16854b5b34" +
  "31363a6619635e7b72d3479fda8675f64a366e6575313a656c31363a656ba3105d2d53419c2709151d1877c131363a84" +
  "afc54e6d44d840948afc3089a2479931363acf5f2258713bc94e943078cfa84e8cbc31363a78cc60679f7f1b49992732" +
  "ed5b090eb731363a2a9b1888b279d449a8864952c340571431363aa44d5b8d516e95418c834092994f833631363aeba2" +
  "4ec67f4e5c44acf718c40594835b31363a10279dce80a38b4390bbc01ab03ba7146575323a696431363a4293c5d703c1" +
  "2244a562ed3fdbc08afc75313a726c6c75313a3075353a3130303536656c75313a3175353a3130303437656c75313a33" +
  "75353a3130303531656c75313a3475353a3130303133656c75313a3675353a3330303031656c75313a3775353a313030" +
  "3231656c75313a3875353a3130303532656c75313a3975353a3130303535656575313a736931343237656565";

// ---------------- 参数 ----------------
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const SELF_TEST = args.includes("--self-test");
const numArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : def;
};
const TIMES = Math.max(1, Math.min(50, Math.trunc(numArg("--times", 10))));
// 批量模式笔间间隔：默认 2000ms，实测单笔「签名+stageTransaction」约 300~900ms，
// 2s 略大于单笔耗时，既让节点消化上一笔、又不浪费时间等链上终态。
const GAP_MS = Math.max(0, numArg("--gap-ms", 2000));
const seasonArgIdx = args.indexOf("--season");
const SEASON_OVERRIDE = seasonArgIdx >= 0 && /^\d+$/.test(String(args[seasonArgIdx + 1] || ""))
  ? BigInt(args[seasonArgIdx + 1]) : null;
const NO_GEAR_REFRESH = args.includes("--no-gear-refresh");
// 逐笔模式（旧行为）开关：默认走批量模式。日常/巡逻奖励链不受影响。
const CONFIRM_EACH = args.includes("--confirm-each");
// 硬门槛：sweep 前必须确认本角色本季真实通关层数 >= MIN_FLOOR，否则拒绝提交。
// 2026-11-24 血泪教训：floor=27 时误做 20 笔 sweep，每笔少拿第28层积分约6000+分，
// 20 笔共损失约 12万~14万分。用户定下铁律：没冲过目标层绝不 sweep。
// 默认 28；可用 --min-floor N 覆盖；--min-floor 0 显式关闭校验（不推荐）。
const MIN_FLOOR = Math.max(0, Math.min(30, Math.trunc(numArg("--min-floor", 28))));
const FINAL_TRIES = Math.max(1, Math.min(60, Math.trunc(numArg("--final-tries", CFG.finalTries))));
const FINAL_INTERVAL_MS = Math.max(200, numArg("--final-interval-ms", CFG.finalIntervalMs));
const MAX_ROUNDS = Math.max(1, Math.min(10, Math.trunc(numArg("--max-rounds", CFG.maxRounds))));

function log(obj) { console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj })); }

// ---------------- 网络 ----------------
async function gql(url, query, variables = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "9c-boss-sweep/1.0" },
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
  throw new Error(`所有 Heimdall RPC 均失败: ${lastErr?.message}`);
}

// ---------------- 链上读取 ----------------
async function getTip() {
  const d = await gqlRpc("{ nodeStatus { tip { index } genesis { hash } } }");
  return { tip: BigInt(d.data.nodeStatus.tip.index), genesis: d.data.nodeStatus.genesis.hash };
}

// 9CAPI 赛季状态：只用来判断「赛季进行中」+ 拿到窗口与 BOSS 名（纯展示，不参与判断）
async function getSeasonStatus() {
  // 2026-11-24 修复：9capi 的 /adventureBossHeimdallStatus（及其 heimdall6 节点）
  // 卡在旧赛季(1458)，返回陈旧/finished=true 会误拦截。改为从最新节点的
  // LatestSeason raw state 读权威赛季元数据（season/start/end/bossId）。
  const ls = await fetchSeasonFromChainState();
  if (!ls || !ls.start || !ls.end) {
    // 兜底：仍尝试旧 REST 端点
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(CFG.api9c + "/adventureBossHeimdallStatus", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarAddress: CFG.avatarAddress }), signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (typeof j.startBlockIndex !== "number" || typeof j.endBlockIndex !== "number") throw new Error("赛季状态字段缺失");
      return { finished: !!j.finished, start: BigInt(j.startBlockIndex), end: BigInt(j.endBlockIndex),
        bossId: j.bossId ?? null, bossName: j.bossName || "未知",
        floor: typeof j.floor === "number" ? j.floor : null, raw: j };
    } finally { clearTimeout(t); }
  }
  const BOSS_NAME = { 211000: "Surtr", 211001: "Laufey", 211002: "Jormungandr", 211003: "Hella" };
  const tip = await getTip();
  return {
    finished: tip.tip > BigInt(ls.end),
    start: BigInt(ls.start), end: BigInt(ls.end),
    bossId: ls.bossId ?? null,
    bossName: BOSS_NAME[ls.bossId] || "未知",
    floor: null,   // 该脚本对 floor 只做提示、不硬拦截；个人层数以第一笔链上终态为准
    raw: ls,
  };
}

// 读本角色本季「真实通关层数」floor —— 唯一权威是 9capi heimdall6 的
// adventureBossSeasonStatus（该节点 2026-11-24 已恢复同步）。返回 floor 或 null。
// 注意：绝不能用「交易笔数推算」代替——explore 受 CP 限制打不满，推算会虚报。
async function getMyRealFloor() {
  const q = `query($a:Address!){ stateQuery { adventureBossSeasonStatus(avatarAddress:$a){
    floor maxFloor bossId finished startBlockIndex endBlockIndex } } }`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const url = "https://heimdall6.9capi.com/graphql";
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, variables: { a: CFG.avatarAddress } }), signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const s = j.data?.stateQuery?.adventureBossSeasonStatus;
    return s && typeof s.floor === "number" ? { floor: s.floor, maxFloor: s.maxFloor,
      bossId: s.bossId, start: BigInt(s.startBlockIndex), end: BigInt(s.endBlockIndex) } : null;
  } catch (_) { return null; }
  finally { clearTimeout(t); }
}

// 从一段 action raw 解出赛季号：sweep/unlock_floor 用 `s`，explore 用 `season`。
// 二者在 Bencodex 里都是 Integer（JS bigint）。
function readSeasonFromRaw(rawHex) {
  try {
    const a = decode(Buffer.from(rawHex, "hex"));
    const v = a.get("values");
    if (!v || typeof v.keys !== "function") return null;
    for (const k of v.keys()) {
      const key = String(k);
      if (key !== "s" && key !== "season") continue;
      const x = v.get(k);
      if (typeof x === "bigint") return x;
      const n = Number(String(x));
      if (Number.isSafeInteger(n) && n > 0) return BigInt(n);
    }
  } catch (_) { /* 忽略解析不了的 */ }
  return null;
}

// 当前赛季号 = 当前赛季窗口内、链上 SUCCESS 的 adventure boss 交易里的 s。
// 依据 Lib9c Sweep/Explore.Execute：latestSeason.Season != Season 直接抛异常，
// 所以能 SUCCESS 的交易，其 s 必定就是当时的当前赛季号。
async function fetchCurrentSeason(status) {
  const q = `{ transactions(take:300){ items { blockIndex object { txStatus actions { typeId raw } } } } }`;
  const d = await gql(CFG.mimir, q);
  const items = d.data?.transactions?.items || [];
  const found = [];
  for (const it of items) {
    const blk = BigInt(it.blockIndex);
    if (blk < status.start || blk > status.end) continue;      // 必须是本赛季窗口内
    if (it.object?.txStatus !== "SUCCESS") continue;            // 只认链上成功
    for (const ac of it.object?.actions || []) {
      if (!AB_TYPES.has(ac.typeId) || !ac.raw) continue;
      const s = readSeasonFromRaw(ac.raw);
      if (s !== null) found.push({ season: s, blk, typeId: ac.typeId });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => (a.season === b.season ? 0 : a.season > b.season ? 1 : -1));
  return found[found.length - 1];
}

// ---- 赛季号兜底（新赛季早期 Mimir 全局索引还没覆盖时）----
// 兜底 1：直接读链上 LatestSeason 状态。这是最权威的硬事实，赛季一开启就写入，
//   完全不依赖交易索引是否追上。存储位置（Lib9c AdventureBossModule.cs / SeasonInfo.cs）：
//     accountAddress = Addresses.AdventureBoss = 0x…0100
//     address        = LatestSeasonAddress    = 全零地址
//     value          = List[Season, StartBlockIndex, EndBlockIndex, NextStartBlockIndex, BossId]
//   实测编码为 Bencodex Text（u…）或 Integer（i…e）混编，两种都要兼容。
const ADVENTURE_BOSS_ACCOUNT = "0x0000000000000000000000000000000000000100";
const LATEST_SEASON_KEY = "0x0000000000000000000000000000000000000000";

// 纯函数，供 --self-test 覆盖：把 state hex 解成赛季号等字段，解不出返回 null
function parseLatestSeasonState(hexOrNull) {
  if (!hexOrNull || typeof hexOrNull !== "string") return null;
  const raw = hexOrNull.startsWith("0x") ? hexOrNull.slice(2) : hexOrNull;
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) return null;
  let list;
  try { list = decode(Buffer.from(raw, "hex")); } catch (_) { return null; }
  if (!Array.isArray(list) || list.length < 5) return null;
  const asNum = (x) => {
    if (typeof x === "bigint") return Number(x);
    if (typeof x === "number") return Number.isSafeInteger(x) ? x : null;
    const s = Buffer.isBuffer(x) ? x.toString("utf8") : String(x);
    return /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null;
  };
  const [season, start, end, nextStart, bossId] = list.slice(0, 5).map(asNum);
  if (season === null || !Number.isSafeInteger(season) || season <= 0) return null;
  return { season: BigInt(season), start, end, nextStart, bossId };
}

async function fetchSeasonFromChainState() {
  const q = "query($a:Address!,$c:Address!){ state(address:$a, accountAddress:$c) }";
  const d = await gqlRpc(q, { a: LATEST_SEASON_KEY, c: ADVENTURE_BOSS_ACCOUNT });
  return parseLatestSeasonState(d.data?.state);
}

// 兜底 2：本角色本赛季窗口内 SUCCESS 的 adventure boss 交易。
//   sweep/explore/unlock_floor 在 Execute 里都硬性要求 Season == 当前赛季，
//   所以能 SUCCESS 的交易，其 s/season 必然就是当前赛季号（排除 wanted）。
async function fetchSeasonFromMyTxs(status, take = 160) {
  const q = `query($a:Address!){ transactions(filter:{avatarAddress:$a},take:${take}){
    items { blockIndex object { txStatus actions { typeId raw } } } } }`;
  const d = await gql(CFG.mimir, q, { a: CFG.avatarAddress });
  const found = [];
  for (const it of d.data?.transactions?.items || []) {
    const blk = BigInt(it.blockIndex);
    if (blk < status.start || blk > status.end) continue;
    if (it.object?.txStatus !== "SUCCESS") continue;
    for (const ac of it.object?.actions || []) {
      if (!AB_TYPES.has(ac.typeId) || !ac.raw) continue;
      const s = readSeasonFromRaw(ac.raw);
      if (s !== null) found.push({ season: s, blk, typeId: ac.typeId });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => (a.blk === b.blk ? 0 : a.blk > b.blk ? 1 : -1));
  return found[found.length - 1];
}

// 本角色最近一笔 SUCCESS 的指定类型交易
async function fetchMineLatestSuccess(typeId, take = 120) {
  const q = `query($a:Address!){ transactions(filter:{avatarAddress:$a},take:${take}){
    items { blockIndex object { txStatus signer actions { typeId raw } } } } }`;
  const d = await gql(CFG.mimir, q, { a: CFG.avatarAddress });
  for (const it of d.data?.transactions?.items || []) {
    if (it.object?.txStatus !== "SUCCESS") continue;
    const ac = (it.object?.actions || []).find((x) => x.typeId === typeId);
    if (ac && ac.raw && /^[0-9a-fA-F]+$/.test(ac.raw) && ac.raw.length % 2 === 0) {
      return { raw: ac.raw, blockIndex: Number(it.blockIndex) };
    }
  }
  return null;
}

// 取本角色「最近一笔 SUCCESS 的 Adventure 配装」的 c/e/r 原始值。
// 候选仅限 BattleType.Adventure 的玩法（与 sweep_adventure_boss 用同一个
// itemSlot/runeSlot 派生地址）：sweep_adventure_boss / explore_adventure_boss /
// hack_and_slash_sweep10。竞技场/无限塔等其它 BattleType 的配装槽不同，绝不能混用。
// 字段名映射：c<-costumes, e<-equipments, r<-r 或 runeInfos（编码已验证字节一致）。
const ADV_GEAR_TYPES = new Set([
  "sweep_adventure_boss", "explore_adventure_boss", "hack_and_slash_sweep10",
]);
async function fetchMineAdventureGear(take = 160) {
  const q = `query($a:Address!){ transactions(filter:{avatarAddress:$a},take:${take}){
    items { blockIndex object { txStatus actions { typeId raw } } } } }`;
  const d = await gql(CFG.mimir, q, { a: CFG.avatarAddress });
  for (const it of d.data?.transactions?.items || []) {
    if (it.object?.txStatus !== "SUCCESS") continue;
    for (const ac of it.object?.actions || []) {
      if (!ADV_GEAR_TYPES.has(ac.typeId) || !ac.raw) continue;
      try {
        const v = decode(Buffer.from(ac.raw, "hex")).get("values");
        const c = v.get("c") ?? v.get("costumes");
        const e = v.get("e") ?? v.get("equipments");
        const r = v.get("r") ?? v.get("runeInfos");
        if (!Array.isArray(c) || !Array.isArray(e) || !Array.isArray(r)) continue;
        return { c, e, r, blockIndex: Number(it.blockIndex), typeId: ac.typeId };
      } catch (_) { /* 换下一笔 */ }
    }
  }
  return null;
}

// 把 Bencodex 值转成正整数（Integer/bigint、Unicode Text、Binary 都兼容）
function toNonNegInt(x) {
  if (typeof x === "bigint") return x >= 0n ? Number(x) : null;
  if (typeof x === "number") return Number.isSafeInteger(x) && x >= 0 ? x : null;
  const s = Buffer.isBuffer(x) ? x.toString("utf8") : String(x);
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

// 解析 InventoryV2 原始 state：顶层是 List，每条是 Dict{count, item:List}；
// item[1] 是 itemId（"500000" 等）。同一 itemId 可能因 tradable/fungibleId
// 不同分成多堆，必须全部累加（实测 11860 + 2408 = 14268）。
// 返回 { total, stacks, entries }，解析不出来返回 null。
function parseApStoneFromState(hexOrNull) {
  if (!hexOrNull || typeof hexOrNull !== "string") return null;
  const hex = hexOrNull.startsWith("0x") ? hexOrNull.slice(2) : hexOrNull;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  let list;
  try { list = decode(Buffer.from(hex, "hex")); } catch (_) { return null; }
  if (!Array.isArray(list) || !list.length) return null;
  const stacks = [];
  let total = 0, parsed = 0;
  for (const e of list) {
    if (!e || typeof e.get !== "function") continue;
    const item = e.get("item");
    if (!Array.isArray(item) || item.length < 2) continue;
    const id = toNonNegInt(item[1]);
    if (id === null) continue;
    parsed++;
    if (id !== AP_STONE_ID) continue;
    const count = toNonNegInt(e.get("count"));
    if (count === null) return null;      // 目标道具却解析不出数量 -> 判为失败
    stacks.push(count);
    total += count;
  }
  if (!parsed || !stacks.length) return null;  // 一条都没解析出来 / 没有 AP 药水堆
  return { total, stacks, entries: parsed };
}

// AP 药水（500000 / AP_STONE）库存：以链上 InventoryV2 原始 state 为准。
// 只认链上，和「只认链上终态」的既定策略一致；Mimir 旧值仅打日志做对照。
async function fetchApStone() {
  const q = `query($a:Address!,$c:Address!){ state(address:$a, accountAddress:$c) }`;
  try {
    const d = await gqlRpc(q, { a: CFG.avatarAddress, c: INVENTORY_ACCOUNT });
    const r = parseApStoneFromState(d.data?.state);
    if (r) {
      log({ level: "info", msg: "AP 药水库存（链上 InventoryV2）",
        apStone: r.total, stacks: r.stacks, entries: r.entries, source: d._url });
      return r.total;
    }
    log({ level: "warn", msg: "InventoryV2 state 解析失败，回退 Mimir（注意：Mimir 读的是迁移前旧值，可能严重偏低）" });
  } catch (e) {
    log({ level: "warn", msg: "InventoryV2 state 读取失败，回退 Mimir", err: String(e.message).slice(0, 140) });
  }
  // 兜底：旧版 Mimir（仅用于不阻断流程；会在日志里标明不可信）
  try {
    const d = await gql(CFG.mimir,
      `query($a:Address!){ inventory(address:$a){ items { count item { id } } } }`,
      { a: CFG.avatarAddress });
    const items = d.data?.inventory?.items || [];
    const total = items.filter((x) => x.item?.id === AP_STONE_ID)
      .reduce((s, x) => s + (Number(x.count) || 0), 0);
    if (Number.isFinite(total)) {
      log({ level: "warn", msg: "使用 Mimir 旧版 inventory 值（不可信，仅供参考）", apStone: total });
      return total;
    }
  } catch (_) { /* 忽略 */ }
  return null;
}

// ---------------- 交易构造 ----------------
// 用「本角色最近一笔 SUCCESS 的 Adventure 配装」刷新 sweep 模板的 c/e/r。
// 三者字段名不同但编码一致（已实测 c=costumes 40B、e=equipments 154B、r 114B）。
function refreshGear(sweepRawHex, gear) {
  const sw = decode(Buffer.from(sweepRawHex, "hex"));
  const sv = sw.get("values");
  if (!(sv instanceof BencodexDictionary) || !gear) {
    return { rawHex: sweepRawHex, refreshed: false };
  }
  const map = { c: gear.c, e: gear.e, r: gear.r };
  const entries = [];
  let changed = 0;
  for (const k of sv.keys()) {
    const key = String(k);
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      const a = sv.get(k), b = map[key];
      // 只接受同为 List 的替换，避免类型漂移
      if (Array.isArray(a) && Array.isArray(b)) { entries.push([k, b]); changed++; continue; }
    }
    entries.push([k, sv.get(k)]);
  }
  const out = new BencodexDictionary([["type_id", sw.get("type_id")], ["values", new BencodexDictionary(entries)]]);
  return { rawHex: Buffer.from(encode(out)).toString("hex"), refreshed: changed === 3 };
}

// 核心：复用模板字节，只强制改写 id（每笔随机）与 s（当前赛季号，保持 Integer）。
function buildSweepAction(rawHex, season) {
  const action = decode(Buffer.from(rawHex, "hex"));
  if (!(action instanceof BencodexDictionary) || String(action.get("type_id")) !== TYPE_ID) {
    throw new Error("模板 type_id 校验失败");
  }
  const values = action.get("values");
  if (!(values instanceof BencodexDictionary)) throw new Error("模板 values 结构校验失败");

  // 归属校验：模板里的 a 必须就是本角色，防止误用他人参数
  const mine = Buffer.from(Address.fromHex(CFG.avatarAddress).toBytes());
  const tmpl = values.get("a");
  if (!tmpl || !Buffer.isBuffer(tmpl) || !tmpl.equals(mine)) {
    throw new Error("模板 avatarAddress 与本角色不符");
  }

  const entries = [];
  let hasId = false, hasS = false;
  for (const k of values.keys()) {
    const key = String(k);
    if (key === "id") { entries.push([k, randomBytes(16)]); hasId = true; continue; }
    if (key === "s") { entries.push([k, BigInt(season)]); hasS = true; continue; }
    entries.push([k, values.get(k)]);
  }
  if (!hasId || !hasS) throw new Error("模板缺少 id 或 s 字段");
  return new BencodexDictionary([
    ["type_id", action.get("type_id")],
    ["values", new BencodexDictionary(entries)],
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
  return d.data.stageTransaction;
}

// 只认链上终态（沿用领奖链既定策略）：INCLUDED/STAGING 都不是结论。
function isTerminalTxStatus(s) {
  return s === "SUCCESS" || s === "FAILURE" || s === "INVALID";
}
async function confirmTx(txId) {
  const q = "query($t:TxId!){ transaction { transactionResult(txId:$t){ txStatus blockIndex exceptionNames } } }";
  for (let i = 0; i < CFG.confirmTries; i++) {
    try {
      const d = await gqlRpc(q, { t: txId });
      const r = d.data?.transaction?.transactionResult;
      // 伪 INVALID 防护：节点尚未索引到刚提交的 txId 时会短暂返回
      // INVALID + blockIndex=null + 无异常名，这不是真终态，继续轮询。
      if (r && isTerminalTxStatus(r.txStatus) && !isPhantomInvalid(r)) return r;
    } catch (_) { /* 节点还没索引到 */ }
    if (i < CFG.confirmTries - 1) await new Promise((r) => setTimeout(r, CFG.confirmIntervalMs));
  }
  return { txStatus: "PENDING" };
}

// 纯决策（不联网，供 --self-test 覆盖）：一笔的链上终态出来后，是否继续下一笔。
// 只有 SUCCESS 才继续；FAILURE/INVALID/PENDING/异常一律收手，避免把剩余次数
// 继续扔上去白跑（每笔都要等确认，且失败原因多半不会自己消失）。
// 仅逐笔模式使用。
function shouldContinue(txStatus) { return txStatus === "SUCCESS"; }

// ---------------- 批量模式：跨节点终态查询 / 伪 INVALID 防护 ----------------
const RESULT_Q = "query($t:TxId!){ transaction { transactionResult(txId:$t){ txStatus blockIndex exceptionNames } } }";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 「伪 INVALID」：节点还没索引到刚提交的 txId 时，transactionResult 会短暂返回
// INVALID + blockIndex=null + 无异常名。这不是真终态，稍后通常会变成 SUCCESS。
// 纯函数，供 --self-test 覆盖。
function isPhantomInvalid(r) {
  if (!r || r.txStatus !== "INVALID") return false;
  if (r.blockIndex !== null && r.blockIndex !== undefined) return false;
  const names = (r.exceptionNames || []).filter(Boolean);
  return names.length === 0;
}

// 跨全部 RPC 节点查一笔终态：任一节点给出「已决」结果就采信。
// 优先级：SUCCESS > FAILURE > 真 INVALID > 伪 INVALID(视为未决) > 未决。
// 这样即使主节点落后、别的节点已索引，也不会误判成失败。
async function queryResultAcrossNodes(txId) {
  // 并行问所有节点：耗时约等于「一次 RPC 往返」，不随节点数增长。
  const rs = await Promise.all(CFG.rpcUrls.map(async (url) => {
    try {
      const d = await gql(url, RESULT_Q, { t: txId }, 20000);
      const r = d.data?.transaction?.transactionResult;
      return (r && !d.errors) ? r : null;
    } catch (_) { return null; }
  }));
  const results = rs.filter(Boolean);
  const decisive = results.filter((r) => isTerminalTxStatus(r.txStatus) && !isPhantomInvalid(r));
  if (decisive.length) {
    // 多节点不一致时，SUCCESS 优先（链上成功是唯一能推进的终态）
    const ok = decisive.find((r) => r.txStatus === "SUCCESS");
    return ok || decisive[0];
  }
  // 全是伪 INVALID / 中间态 / 无响应 -> 未决
  return null;
}

// 总复核：并行轮询一批 txId 的链上终态，直到全部出结论或轮数用尽。
// 关键：所有 txId 在每一轮里「并行」查，耗时不随笔数线性增长。
async function reconcileBatch(pending, tries, intervalMs) {
  const settled = new Map();          // txId -> 终态结果
  let left = pending.map((p) => p.txId);
  for (let k = 0; k < tries && left.length; k++) {
    const rs = await Promise.all(left.map((id) => queryResultAcrossNodes(id)));
    const next = [];
    for (let j = 0; j < left.length; j++) {
      if (rs[j]) settled.set(left[j], rs[j]);
      else next.push(left[j]);
    }
    left = next;
    if (left.length) await sleep(intervalMs);
  }
  return {
    settled,
    unresolved: left,                 // 到轮数用尽仍未出结论的 txId
  };
}

// 纯决策：下一轮还应新提交多少笔。供 --self-test 覆盖。
// 关键：未决(pending)的交易可能已经成功，先占位、不重复提交，
// 避免对「还在飞」的交易重复扣药水 / 多刷。只有明确少了才补差额。
function planBatchNeed(target, successSoFar, pendingCount) {
  return Math.max(0, target - successSoFar - pendingCount);
}

// ---------------- 批量编排（可注入依赖，供 --self-test 离线演练）----------------
// 把「连续提交 -> 总复核 -> 按差额补齐」的循环抽成可测函数：所有网络副作用
// 通过 deps 注入。自测里用 mock 就能演练完整流程，不联网、不提交、不消耗 AP。
async function runBatchLoop(deps) {
  const {
    target, maxRounds, gapMs = 0, gap = sleep,
    planNeed = planBatchNeed,
    freshNonce,        // () => Promise<nonce|null>，真实取链上 nextTxNonce
    submitOne,         // (nonce) => Promise<txId|null>，内部含有限重试
    reconcile,         // (pending) => Promise<{settled:Map<txId,r>, unresolved:txId[]}>
    onLog = () => {},
  } = deps;

  const results = [], pending = [];
  let cursor = null, submitted = 0, success = 0, round = 0;

  while (round < maxRounds) {
    round++;
    const chain = await freshNonce();
    if (chain !== null && chain !== undefined && (cursor === null || chain > cursor)) cursor = chain;
    if (cursor === null) throw new Error("无法取得批量提交的起始 nonce");

    // 未决交易可能已成功，先占位不重复提交
    const need = planNeed(target, success, pending.length);
    onLog({ msg: "轮开始", round, maxRounds, need, successSoFar: success,
      pending: pending.length, startNonce: String(cursor) });

    if (need > 0) {
      for (let j = 0; j < need; j++) {
        const nonce = cursor;
        let txId = null;
        for (let a = 1; a <= 3 && !txId; a++) {
          txId = await submitOne(nonce);
          if (!txId && a < 3) await gap(gapMs);
        }
        if (!txId) {
          // 提交失败：nonce 游标不推进，下一轮会用同一个 nonce 补上，
          // 保证链上 nonce 连续、不留空洞。
          onLog({ msg: "单笔提交连续失败，本轮停止提交，nonce 不推进", nonce: String(nonce) });
          break;
        }
        cursor = typeof cursor === "bigint" ? cursor + 1n : cursor + 1;
        const item = { i: ++submitted, txId, nonce: typeof nonce === "bigint" ? Number(nonce) : nonce };
        results.push({ ...item, txStatus: "PENDING", exceptionNames: [] });
        pending.push(item);
        onLog({ msg: "已提交", submitted, txId, nonce: item.nonce });
        if (j < need - 1 && gapMs > 0) await gap(gapMs);
      }
    }

    // 末尾总复核：并行查所有未决 txId，跨节点取终态，伪 INVALID 不算结论
    if (pending.length) {
      const rec = await reconcile(pending);
      for (const [txId, r] of rec.settled) {
        const row = results.find((x) => x.txId === txId);
        if (row) {
          row.txStatus = r.txStatus;
          row.exceptionNames = r.exceptionNames || [];
          row.blockIndex = r.blockIndex ?? null;
        }
      }
      const still = pending.filter((p) => rec.unresolved.includes(p.txId));
      pending.length = 0;
      pending.push(...still);
    }

    success = results.filter((x) => x.txStatus === "SUCCESS").length;
    const failed = results.filter((x) => x.txStatus === "FAILURE" || x.txStatus === "INVALID").length;
    onLog({ msg: "轮完成", round, success, failed, unresolved: pending.length, submitted });
    if (success >= target) break;
    if (pending.length === 0 && planNeed(target, success, 0) === 0) break;
  }
  return { results, success, pending, rounds: round, submitted };
}

// 失败原因的人话解释
function explainFailure(r) {
  const names = (r.exceptionNames || []).filter(Boolean).join(",");
  if (/NotEnoughMaterial/i.test(names)) return "AP 药水不足（每笔消耗 = 当前通关层数 × 1 瓶）";
  if (/InvalidAdventureBossSeason/i.test(names)) return "赛季号不匹配，可能刚跨赛季；用 --season 指定或稍后重试";
  if (/InvalidSeason|Season finished/i.test(names)) return "赛季已结束，等下一季";
  if (/Cannot sweep without cleared stage|InvalidOperation/i.test(names)) {
    return "当前赛季还没通关任何层：请先在游戏里手工打/解锁首层（脚本不做这一步）";
  }
  if (/FailedLoadState|ValidateEquipments|ValidateCostume|ItemRequirement/i.test(names)) {
    return "装备/时装/符文校验失败：请先在游戏里手工 Sweep 一次刷新模板，再重试";
  }
  if (/RequiredBlockIndex/i.test(names)) return "区块限制，稍后重试";
  return names || "链上判定失败（无异常名）";
}

// ---------------- 自测（纯逻辑，不联网） ----------------
async function selfTest() {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };

  // 1) 终态判定
  for (const [s, expect] of [["SUCCESS", true], ["FAILURE", true], ["INVALID", true],
    ["INCLUDED", false], ["STAGING", false], ["PENDING", false], [null, false]]) {
    ok(`isTerminalTxStatus(${String(s)})`, isTerminalTxStatus(s) === expect);
  }
  // 2) 模板 round-trip：字段集合与类型不变
  const base = decode(Buffer.from(FALLBACK_TEMPLATE_RAW, "hex"));
  const bv = base.get("values");
  const keys = [...bv.keys()].map(String).sort();
  ok("模板字段集合 = a,c,e,id,r,s", JSON.stringify(keys) === JSON.stringify(["a", "c", "e", "id", "r", "s"]));
  ok("模板 s 是 Integer(bigint)", typeof bv.get("s") === "bigint");
  ok("模板 id 是 16 字节", Buffer.isBuffer(bv.get("id")) && bv.get("id").length === 16);
  ok("模板 a 与默认角色一致", Buffer.isBuffer(bv.get("a")) &&
    bv.get("a").equals(Buffer.from(Address.fromHex(CFG.avatarAddress).toBytes())));

  // 3) buildSweepAction：只改 id 和 s，其余字节不变
  const built = buildSweepAction(FALLBACK_TEMPLATE_RAW, 1429n);
  const builtHex = Buffer.from(encode(built)).toString("hex");
  const nb = decode(Buffer.from(builtHex, "hex")).get("values");
  ok("改写后字节长度不变", builtHex.length === FALLBACK_TEMPLATE_RAW.length);
  ok("改写后 s = 1429n", nb.get("s") === 1429n);
  ok("改写后 s 仍是 bigint", typeof nb.get("s") === "bigint");
  ok("改写后 id 不同", !nb.get("id").equals(bv.get("id")));
  ok("改写后 id 仍 16 字节", nb.get("id").length === 16);
  for (const k of ["a", "c", "e", "r"]) {
    ok(`改写后 ${k} 字节不变`,
      Buffer.from(encode(nb.get(k))).toString("hex") === Buffer.from(encode(bv.get(k))).toString("hex"));
  }
  ok("改写后字段集合不变", JSON.stringify([...nb.keys()].map(String).sort()) === JSON.stringify(keys));

  // 4) 每笔 id 都不同
  const ids = new Set();
  for (let i = 0; i < 10; i++) ids.add(buildSweepAction(FALLBACK_TEMPLATE_RAW, 1429n).get("values").get("id").toString("hex"));
  ok("连发 10 笔 id 全不同", ids.size === 10);

  // 5) 赛季号解析（s 与 season 两种字段名）
  ok("readSeasonFromRaw 解析 s=1427", readSeasonFromRaw(FALLBACK_TEMPLATE_RAW) === 1427n);
  const exploreLike = new BencodexDictionary([
    ["type_id", "explore_adventure_boss"],
    ["values", new BencodexDictionary([["season", 1429n], ["id", randomBytes(16)]])],
  ]);
  ok("readSeasonFromRaw 解析 season=1429", readSeasonFromRaw(Buffer.from(encode(exploreLike)).toString("hex")) === 1429n);
  ok("readSeasonFromRaw 对无关 action 返回 null", readSeasonFromRaw(
    Buffer.from(encode(new BencodexDictionary([["type_id", "daily_reward7"], ["values", new BencodexDictionary([["id", randomBytes(16)]])]]))).toString("hex")) === null);

  // 6) 参数边界
  ok("TIMES 钳制在 1..50", TIMES >= 1 && TIMES <= 50);
  // 7) 逐笔模式决策：只有 SUCCESS 继续，其余一律收手
  for (const [s, expect] of [["SUCCESS", true], ["FAILURE", false], ["INVALID", false],
    ["PENDING", false], ["INCLUDED", false], [null, false]]) {
    ok(`shouldContinue(${String(s)})`, shouldContinue(s) === expect);
  }
  // 7b) 批量模式：伪 INVALID 识别（节点未索引，不是真终态）
  ok("伪 INVALID：INVALID+blockIndex=null+空异常名", isPhantomInvalid({
    txStatus: "INVALID", blockIndex: null, exceptionNames: [] }));
  ok("伪 INVALID：exceptionNames 含 null 也算空", isPhantomInvalid({
    txStatus: "INVALID", blockIndex: null, exceptionNames: [null, null] }));
  ok("真 INVALID：有 blockIndex 不算伪", !isPhantomInvalid({
    txStatus: "INVALID", blockIndex: 11829844, exceptionNames: [] }));
  ok("真 INVALID：有异常名不算伪", !isPhantomInvalid({
    txStatus: "INVALID", blockIndex: null, exceptionNames: ["InvalidSeasonException"] }));
  ok("SUCCESS/FAILURE 不是伪 INVALID", !isPhantomInvalid({ txStatus: "SUCCESS", blockIndex: 1, exceptionNames: [] })
    && !isPhantomInvalid({ txStatus: "FAILURE", blockIndex: 1, exceptionNames: [] }));
  ok("null 结果不是伪 INVALID", !isPhantomInvalid(null));
  // 7c) 批量模式：补齐笔数决策（pending 占位，避免重复提交）
  ok("planBatchNeed 10 笔全未提交=10", planBatchNeed(10, 0, 0) === 10);
  ok("planBatchNeed 已成功 10 笔=0", planBatchNeed(10, 10, 0) === 0);
  ok("planBatchNeed 成功 8 + 未决 2 = 0（不重复补）", planBatchNeed(10, 8, 2) === 0);
  ok("planBatchNeed 成功 7 + 失败已定 3 笔=3（补差额）", planBatchNeed(10, 7, 0) === 3);
  ok("planBatchNeed 成功 7 + 未决 1 = 2", planBatchNeed(10, 7, 1) === 2);
  ok("planBatchNeed 超额成功返回 0（不出现负数）", planBatchNeed(10, 12, 3) === 0);
  // 8) 失败解释
  ok("药水不足有专门提示", /AP 药水/.test(explainFailure({ exceptionNames: ["NotEnoughMaterialException"] })));
  ok("未通关有专门提示", /首层/.test(explainFailure({ exceptionNames: ["InvalidOperationException"] })));
  ok("赛季号不匹配有专门提示", /赛季号/.test(explainFailure({ exceptionNames: ["InvalidAdventureBossSeasonException"] })));
  ok("赛季结束有专门提示", /赛季已结束/.test(explainFailure({ exceptionNames: ["InvalidSeasonException"] })));

  // 9) InventoryV2 解析：item 是 List，item[1] 为 itemId；同 id 多堆必须累加
  // 构造与链上一致的条目：Dict{count:Integer, item:List[..., "500000", ...]}
  const mkEntry = (id, count) => new BencodexDictionary([
    ["count", BigInt(count)],
    ["item", ["2", String(id), "3", "16", "4", "0"]],
  ]);
  const mkState = (entries) => Buffer.from(encode(entries)).toString("hex");
  const realLike = mkState([mkEntry(302000, 239), mkEntry(500000, 11860), mkEntry(400000, 35000), mkEntry(500000, 2408)]);
  const r1 = parseApStoneFromState(realLike);
  ok("V2 解析：多堆 AP 药水累加 = 14268", r1 && r1.total === 14268);
  ok("V2 解析：两堆明细 = [11860,2408]", r1 && JSON.stringify(r1.stacks) === "[11860,2408]");
  ok("V2 解析：忽略其它道具（entries=4）", r1 && r1.entries === 4);
  ok("V2 解析：支持 0x 前缀", parseApStoneFromState("0x" + realLike)?.total === 14268);
  const single = parseApStoneFromState(mkState([mkEntry(500000, 7)]));
  ok("V2 解析：单堆 = 7", single && single.total === 7 && single.stacks.length === 1);
  ok("V2 解析：无 AP 药水返回 null", parseApStoneFromState(mkState([mkEntry(302000, 5)])) === null);
  ok("V2 解析：空 List 返回 null", parseApStoneFromState(mkState([])) === null);
  ok("V2 解析：非 hex 返回 null", parseApStoneFromState("zzzz") === null);
  ok("V2 解析：奇长度 hex 返回 null", parseApStoneFromState("abc") === null);
  ok("V2 解析：null/空返回 null", parseApStoneFromState(null) === null && parseApStoneFromState("") === null);
  ok("V2 解析：item 非 List 时跳过", parseApStoneFromState(
    Buffer.from(encode([new BencodexDictionary([["count", 3n], ["item", "oops"]])])).toString("hex")) === null);
  // 关键回归：Mimir 旧值 566 绝不能再被当成真值
  ok("Mimir 旧值 566 不等于 V2 真值 14268", 566 !== 14268);

  // 10) 赛季号兜底：链上 LatestSeason state 解析（Text / Integer 两种编码都要兼容）
  // 1434 赛季链上真实值：l u4:1434 u8:11791016 u8:11792816 u8:11795516 u6:211003 e
  const LS_TEXT_HEX = "6c75343a3134333475383a313137393130313675383a313137393238313675383a313137393535313675363a32313130303365";
  const ls = parseLatestSeasonState(LS_TEXT_HEX);
  ok("LatestSeason Text 编码解析 season=1434", ls && ls.season === 1434n);
  ok("LatestSeason Text 编码解析 start/end/boss", ls && ls.start === 11791016 && ls.end === 11792816 && ls.bossId === 211003);
  ok("LatestSeason 支持 0x 前缀", parseLatestSeasonState("0x" + LS_TEXT_HEX)?.season === 1434n);
  const intEncoded = Buffer.from(encode([
    1434n, 11791016n, 11792816n, 11795516n, 211003n,
  ])).toString("hex");
  ok("LatestSeason Integer 编码解析 season=1434", parseLatestSeasonState(intEncoded)?.season === 1434n);
  ok("LatestSeason 少于 5 元素返回 null", parseLatestSeasonState(Buffer.from(encode([1434n, 1n])).toString("hex")) === null);
  ok("LatestSeason 非 hex 返回 null", parseLatestSeasonState("zzzz") === null);
  ok("LatestSeason 奇长度 hex 返回 null", parseLatestSeasonState("abc") === null);
  ok("LatestSeason null/空返回 null", parseLatestSeasonState(null) === null && parseLatestSeasonState("") === null);
  ok("LatestSeason 首元素非法返回 null", parseLatestSeasonState(Buffer.from(encode([
    "oops", 1n, 2n, 3n, 4n,
  ])).toString("hex")) === null);

  // 11) 批量模式离线演练（mock 注入，不联网、不提交、不消耗 AP）
  // 用可控剧本跑完整 runBatchLoop，验证 nonce 连续性 / 补齐 / 伪 INVALID / 轮数上限。
  // script(nonce, call)：call 是「第几次总复核」，据此可确定性地安排剧本。
  const mkR = (s) => ({ txStatus: s, blockIndex: 1, exceptionNames: [] });
  const mockRun = (opts) => {
    let nonce = 72420n, call = 0, submitFailed = false;
    return runBatchLoop({
      target: opts.target ?? 4, maxRounds: opts.maxRounds ?? 3, gapMs: 0,
      gap: async () => {},
      freshNonce: async () => nonce,           // 链上值固定，靠内部游标推进
      submitOne: async (n) => {
        if (opts.failSubmitAt && Number(n) === opts.failSubmitAt && !submitFailed) {
          submitFailed = true; return null;    // 模拟一次提交失败
        }
        return `tx-${Number(n)}`;
      },
      reconcile: async (p) => {
        call++;
        const settled = new Map(), unresolved = [];
        for (const it of p) {
          const r = opts.script(it.nonce, call);
          if (r === "UNRESOLVED") unresolved.push(it.txId);
          else settled.set(it.txId, mkR(r));
        }
        return { settled, unresolved };
      },
      onLog: () => {},
    });
  };

  // A) 全部 SUCCESS：一轮达标，提交 4 笔，nonce 连续
  const A = await mockRun({ script: () => "SUCCESS" });
  ok("演练A 全部成功：1 轮达标", A.rounds === 1 && A.success === 4 && A.submitted === 4);
  ok("演练A nonce 连续 72420..72423", A.results.every((r, i) => r.nonce === 72420 + i));
  ok("演练A 无未决", A.pending.length === 0);

  // B) 首轮 72421/72423 两笔 FAILURE：第 2 轮补齐 2 笔，最终 success=4、提交 6 笔
  const B = await mockRun({
    script: (n, call) => (call === 1 && (n === 72421 || n === 72423) ? "FAILURE" : "SUCCESS"),
  });
  ok("演练B 最终达标 success=4", B.success === 4);
  ok("演练B 触发补齐：提交 6 笔", B.submitted === 6 && B.rounds === 2);
  ok("演练B 无未决残留", B.pending.length === 0);
  ok("演练B nonce 连续 72420..72425", B.results.every((r, i) => r.nonce === 72420 + i));

  // C) 伪 INVALID 表现为 UNRESOLVED：首轮 2 笔未决，不应重复提交，第 2 轮复核转 SUCCESS
  const C = await mockRun({
    maxRounds: 3,
    script: (n, call) => (call === 1 && (n === 72421 || n === 72422) ? "UNRESOLVED" : "SUCCESS"),
  });
  ok("演练C 未决交易不重复提交（submitted=4）", C.submitted === 4);
  ok("演练C 后续复核转成功、最终达标", C.success === 4 && C.pending.length === 0);

  // D) 单笔提交失败：nonce 不推进，下一轮用同一 nonce 补上，链上 nonce 连续
  const D = await mockRun({ target: 3, maxRounds: 3, failSubmitAt: 72421, script: () => "SUCCESS" });
  ok("演练D 提交失败后仍能达标", D.success === 3);
  const dNonces = [...new Set(D.results.map((r) => r.nonce))].sort((a, b) => a - b);
  ok("演练D nonce 无空洞/无重复", dNonces.length === 3 && dNonces[2] - dNonces[0] === 2);

  // E) 轮数上限：始终 UNRESOLVED，不无限循环，且如实留下未决、不盲目补齐
  const E = await mockRun({ target: 3, maxRounds: 2, script: () => "UNRESOLVED" });
  ok("演练E 轮数用尽即收敛", E.rounds === 2 && E.success === 0);
  ok("演练E 未决如实保留、未盲目补齐", E.pending.length === 3 && E.submitted === 3);

  console.log(`\n  self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

// ---------------- 主流程 ----------------
async function main() {
  if (SELF_TEST) {
    console.log("=== 9C Adventure Boss 一键 Sweep · 纯逻辑自测 ===");
    return (await selfTest()) ? 0 : 1;
  }

  log({ level: "info", msg: "一键连续 Sweep 启动", times: TIMES, dryRun: DRY, avatar: CFG.avatarAddress });

  // 1) 私钥 & 归属
  if (!CFG.privateKey) throw new Error("缺少 NC_PRIVATE_KEY（未解密 keystore？）");
  const account = RawPrivateKey.fromHex(CFG.privateKey.replace(/^0x/, ""));
  const pub = await account.getPublicKey();
  const signer = Address.deriveFrom(pub);
  const avQ = "query($a:Address!){ stateQuery { avatar(avatarAddress:$a){ agentAddress } } }";
  const avD = await gqlRpc(avQ, { a: CFG.avatarAddress });
  const agent = avD.data?.stateQuery?.avatar?.agentAddress;
  if (agent && agent.toLowerCase() !== signer.toString().toLowerCase()) {
    throw new Error(`私钥与角色不匹配：signer=${signer} agentAddress=${agent}`);
  }
  log({ level: "info", msg: "私钥归属校验通过", signer: signer.toString() });

  // 2) 赛季进行中？
  const tip = await getTip();
  const status = await getSeasonStatus();
  log({ level: "info", msg: "链上赛季状态", tip: Number(tip.tip),
    start: Number(status.start), end: Number(status.end),
    boss: `${status.bossName}(${status.bossId})`, finished: status.finished,
    floor: status.floor });
  if (status.finished || tip.tip > status.end || tip.tip < status.start) {
    throw new Error("当前没有进行中的 Adventure Boss 赛季（或 tip 不在赛季窗口内），停止提交");
  }
  // 9CAPI 的 floor 对应 Explorer.Floor（本季已通关层数）。按 Lib9c
  // SweepAdventureBoss.cs:119，Floor==0 会抛 "Cannot sweep without cleared stage."
  // 首层/爬层由你手工做，脚本不碰；这里只醒目提示，不硬拦截（该字段未必精确
  // 对应到本角色），最终仍以第一笔链上终态为准。
  log({ level: "info", msg: "前置提醒：首层解锁/爬层由你手工在游戏里完成，脚本不碰。"
    + "必须至少通关 1 层才能 Sweep（未通关时链上会报 Cannot sweep without cleared stage）。"
    + "每笔消耗 = 本季已通关层数 × 1 瓶 AP 药水，10 笔 = 层数 × 10 瓶。",
    boss: `${status.bossName}(${status.bossId})`, reportedFloor: status.floor });
  if (status.floor !== null && status.floor <= 0) {
    log({ level: "warn", msg: "9CAPI 报 floor=0（可能是全局看板值，未必等于你的个人层数）："
      + "若你本季确实还没通关任何层，请先手工打首层，否则 10 笔都会失败。"
      + "脚本不据此拦截，最终以第一笔链上终态为准。", reportedFloor: status.floor });
  }

  // 2.5) 硬门槛（2026-11-24 铁律）：没冲过目标层绝不 sweep。
  // 每笔 sweep 从 fl=1 累加到 explorer.Floor 逐层抽积分；少一层=每笔少该层积分≈6000+分，
  // 20 笔≈12万~14万分，损失巨大。故提交前必须读到真实 floor >= MIN_FLOOR。
  // 读不到真实 floor（节点故障）时也拒绝——宁可不刷，也不冒虚报风险。
  if (MIN_FLOOR > 0) {
    const real = await getMyRealFloor();
    if (!real) {
      throw new Error(`无法从 heimdall6 读到本角色真实通关层数，拒绝 sweep（铁律：没确认冲过 ${MIN_FLOOR} 层不 sweep）。`);
    }
    // 交叉校验：真实 floor 所在赛季窗口必须与链上 LatestSeason 一致，防止节点陈旧
    if (real.start !== status.start || real.end !== status.end) {
      throw new Error(`heimdall6 个人状态窗口[${real.start},${real.end}]与链上[${status.start},${status.end}]不一致，节点可能滞后，拒绝 sweep。`);
    }
    log({ level: "info", msg: "硬门槛校验：本角色真实通关层数", realFloor: real.floor,
      maxFloor: real.maxFloor, minFloor: MIN_FLOOR });
    if (real.floor < MIN_FLOOR) {
      throw new Error(`本角色真实只通关到第 ${real.floor} 层，未达门槛 ${MIN_FLOOR} 层——拒绝 sweep（每少一层/笔≈6000+分，绝不冒险）。请先在游戏里冲过第 ${MIN_FLOOR} 层再跑。`);
    }
  }

  // 3) 当前赛季号：链上 LatestSeason state 为权威，Mimir 交易解析为辅 + 交叉校验
  let season, seasonSource;
  if (SEASON_OVERRIDE !== null) {
    season = SEASON_OVERRIDE; seasonSource = "--season 手工指定";
  } else {
    // 3a) 链上硬事实：赛季一开启就有，不受 Mimir 索引滞后影响
    let chainSeason = null;
    try {
      const ls = await fetchSeasonFromChainState();
      if (ls) {
        chainSeason = ls.season;
        log({ level: "info", msg: "链上 LatestSeason state", season: Number(ls.season),
          start: ls.start, end: ls.end, bossId: ls.bossId });
      }
    } catch (e) {
      log({ level: "warn", msg: "链上 LatestSeason state 读取失败，降级用交易解析", err: String(e.message).slice(0, 140) });
    }

    // 3b) 交易解析（全局优先，其次本角色）
    let txHit = await fetchCurrentSeason(status);
    let txSource = txHit ? `Mimir 全局 ${txHit.typeId}@${txHit.blk} (SUCCESS)` : null;
    if (!txHit) {
      txHit = await fetchSeasonFromMyTxs(status);
      txSource = txHit ? `Mimir 本角色 ${txHit.typeId}@${txHit.blk} (SUCCESS)` : null;
    }

    if (chainSeason !== null) {
      season = chainSeason; seasonSource = "链上 LatestSeason state";
      if (txHit && txHit.season !== chainSeason) {
        log({ level: "warn", msg: "交易解析赛季号与链上状态不一致，以链上为准",
          txSeason: Number(txHit.season), chainSeason: Number(chainSeason), txSource });
      } else if (txHit) {
        seasonSource += `（与 ${txSource} 一致）`;
      }
    } else if (txHit) {
      season = txHit.season; seasonSource = txSource;
    } else {
      throw new Error("无法解析当前赛季号：链上 LatestSeason state 读不到，且本赛季窗口内本角色/全局都没有成功的 adventure boss 交易。请用 --season N 手工指定，或稍后再试。");
    }
  }
  log({ level: "info", msg: "当前赛季号", season: Number(season), source: seasonSource });

  // 4) 模板（自动跟随 Adventure 配装）
  let tpl = await fetchMineLatestSuccess(TYPE_ID);
  let tplSource = tpl ? `Mimir sweep_adventure_boss@${tpl.blockIndex}` : "内置兜底模板@11757007";
  if (!tpl) tpl = { raw: FALLBACK_TEMPLATE_RAW, blockIndex: 11757007 };
  let rawHex = tpl.raw, gearSource = "沿用 sweep 模板原装备";
  if (!NO_GEAR_REFRESH) {
    const gear = await fetchMineAdventureGear();
    if (gear && gear.blockIndex > tpl.blockIndex) {
      const g = refreshGear(rawHex, gear);
      if (g.refreshed) { rawHex = g.rawHex; gearSource = `用 ${gear.typeId}@${gear.blockIndex} 刷新 Adventure 配装`; }
    }
  }
  // 归属校验（buildSweepAction 内部还会再校验一次）
  const probe = buildSweepAction(rawHex, season);
  log({ level: "info", msg: "交易模板就绪", source: tplSource, gear: gearSource,
    actionBytes: Buffer.from(encode(probe)).length });

  // 5) 药水最低门槛 + 成本提示（库存数值由 fetchApStone 内部打印，此处不重复）
  const ap = await fetchApStone();
  if (ap !== null) {
    log({ level: "info", msg: "成本提示",
      note: `每笔消耗 = 当前赛季已通关层数 × 1 瓶；本次 ${TIMES} 笔 = 层数 × ${TIMES} 瓶。层数链上未暴露，脚本不预判，真实消耗由链上裁决` });
    // 只是「笔数」层面的最低门槛：每笔至少 1 瓶，药水少于笔数必然不够。
    // 真实按层数扣，具体够不够交给第一笔链上终态把关。
    if (ap < TIMES) throw new Error(`AP 药水(${ap}) 少于计划次数(${TIMES})，必然不够，停止提交`);
  } else {
    log({ level: "warn", msg: "AP 药水库存读取失败，跳过最低门槛检查（真实消耗由链上裁决）" });
  }

  // 6) dry-run：构造 N 笔并做字节级校验，绝不提交
  if (DRY) {
    log({ level: "info", msg: "本次运行模式", mode: CONFIRM_EACH ? "confirm-each（逐笔等终态）" : "batch（连续提交+末尾总复核+补齐）",
      gapMs: GAP_MS, finalTries: FINAL_TRIES, finalIntervalMs: FINAL_INTERVAL_MS, maxRounds: MAX_ROUNDS });
    log({ level: "info", msg: "DRY-RUN：以下仅预览，不会提交任何交易" });
    for (let i = 1; i <= TIMES; i++) {
      const a = buildSweepAction(rawHex, season);
      const hex = Buffer.from(encode(a)).toString("hex");
      const back = decode(Buffer.from(hex, "hex"));
      const v = back.get("values");
      log({ level: "info", msg: `预览第 ${i}/${TIMES} 笔`, actionBytes: hex.length / 2,
        season: Number(v.get("s")), idHex: v.get("id").toString("hex").slice(0, 12) + "…",
        typeId: String(back.get("type_id")) });
    }
    log({ level: "info", msg: "DRY-RUN 完成：未提交、未消耗任何 AP 药水",
      ready: true, times: TIMES, season: Number(season) });
    return 0;
  }

  // 7) 真实连发
  const results = [];

  // ---- 逐笔模式（--confirm-each，旧行为）----
  // 每笔重新取 nonce、等链上终态，第一笔非 SUCCESS 立即收手。
  // 日常/巡逻奖励链仍是这个策略，但那是 claim.mjs，不受本文件影响。
  if (CONFIRM_EACH) {
    for (let i = 1; i <= TIMES; i++) {
      const nonce = await getNonce(signer.toString());
      const actionValue = buildSweepAction(rawHex, season);
      const txId = await submitTx({ account, pub, signer, nonce, actionValue });
      log({ level: "info", msg: `已提交第 ${i}/${TIMES} 笔`, txId, nonce: Number(nonce) });
      const r = await confirmTx(txId);
      results.push({ i, txId, nonce: Number(nonce), txStatus: r.txStatus,
        exceptionNames: r.exceptionNames || [] });
      log({ level: r.txStatus === "SUCCESS" ? "info" : "error",
        msg: `第 ${i}/${TIMES} 笔链上终态`, txId, txStatus: r.txStatus,
        blockIndex: r.blockIndex ?? null, exceptionNames: r.exceptionNames || [] });
      if (!shouldContinue(r.txStatus)) {
        log({ level: "error", msg: "停止连发（第一笔非 SUCCESS 即收手，不白跑剩余次数）",
          reason: explainFailure(r), txId, at: i });
        break;
      }
      if (i < TIMES && GAP_MS > 0) await sleep(GAP_MS);
    }
    const okCount = results.filter((x) => x.txStatus === "SUCCESS").length;
    log({ level: "info", msg: "本次连发结束", mode: "confirm-each", requested: TIMES,
      submitted: results.length, success: okCount, season: Number(season), results });
    console.log(JSON.stringify({ summary: true, mode: "confirm-each", requested: TIMES,
      submitted: results.length, success: okCount, season: Number(season), results }, null, 2));
    return okCount === TIMES ? 0 : 1;
  }

  // ---- 批量模式（默认，AB 专用）----
  // 连续提交 N 笔（笔间只留 --gap-ms，不等链上终态）-> 末尾一次性总复核
  // -> 按链上 SUCCESS 数与目标的差额自动补齐，最多 --max-rounds 轮。
  log({ level: "info", msg: "批量模式启动：连续提交 + 末尾总复核 + 自动补齐",
    mode: "batch", times: TIMES, gapMs: GAP_MS, finalTries: FINAL_TRIES,
    finalIntervalMs: FINAL_INTERVAL_MS, maxRounds: MAX_ROUNDS });

  const batch = await runBatchLoop({
    target: TIMES, maxRounds: MAX_ROUNDS, gapMs: GAP_MS,
    // 起始 nonce 取链上真实进度（runBatchLoop 内部用 max(链上值, 本地游标)
    // 防止节点索引滞后导致撞号）；每笔构造独立 id 并做 3 次提交重试。
    freshNonce: async () => {
      try { return await getNonce(signer.toString()); }
      catch (e) {
        log({ level: "warn", msg: "起始 nonce 读取失败，交由内部游标兜底", err: String(e?.message || e) });
        return null;
      }
    },
    submitOne: async (nonce) => {
      const actionValue = buildSweepAction(rawHex, season);
      let txId = null, lastErr = null;
      for (let attempt = 1; attempt <= 3 && !txId; attempt++) {
        try { txId = await submitTx({ account, pub, signer, nonce, actionValue }); }
        catch (e) { lastErr = String(e?.message || e); if (attempt < 3) await sleep(GAP_MS); }
      }
      if (!txId) {
        log({ level: "error", msg: "单笔 stageTransaction 连续 3 次失败（nonce 不推进）",
          nonce: Number(nonce), err: lastErr });
      }
      return txId;
    },
    reconcile: async (p) => {
      log({ level: "info", msg: "末尾总复核开始", checking: p.length,
        tries: FINAL_TRIES, intervalMs: FINAL_INTERVAL_MS });
      return reconcileBatch(p, FINAL_TRIES, FINAL_INTERVAL_MS);
    },
    onLog: (o) => log({ level: "info", ...o }),
  });

  // 明确失败的原因打一条人话提示（不改变「只认终态」的结论）
  for (const row of batch.results) {
    if (row.txStatus === "FAILURE" || row.txStatus === "INVALID") {
      log({ level: "warn", msg: "一笔链上终态非 SUCCESS", txId: row.txId,
        txStatus: row.txStatus, reason: explainFailure(row) });
    }
  }
  // 收尾：轮数用尽仍未出终态的交易，如实标注，绝不盲目补齐（避免重复扣药水）
  for (const p of batch.pending) {
    log({ level: "warn", msg: "总复核轮数用尽后仍未出链上终态，不盲目补齐，请事后按 txId 复查",
      txId: p.txId, nonce: p.nonce });
  }
  const failedCount = batch.results.filter((x) => x.txStatus === "FAILURE" || x.txStatus === "INVALID").length;
  log({ level: "info", msg: "本次连发结束", mode: "batch", requested: TIMES,
    submitted: batch.submitted, success: batch.success, failed: failedCount,
    unresolved: batch.pending.length, rounds: batch.rounds, season: Number(season),
    results: batch.results });
  console.log(JSON.stringify({ summary: true, mode: "batch", requested: TIMES,
    submitted: batch.submitted, success: batch.success, failed: failedCount,
    unresolved: batch.pending.length, rounds: batch.rounds, season: Number(season),
    results: batch.results }, null, 2));
  return batch.success === TIMES ? 0 : 1;
}

main().then((code) => { process.exitCode = code; })
  .catch((e) => { log({ level: "error", msg: "脚本异常", detail: String(e?.message || e) }); process.exitCode = 2; });
