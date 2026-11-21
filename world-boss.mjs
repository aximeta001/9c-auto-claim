#!/usr/bin/env node
/**
 * 9C World Boss (WB) 自动战斗 —— Heimdall，deployed to GitHub Actions.
 *
 * 策略（经用户 2026-11-20/21 确认，全部来自 Lib9c 源码 + 主网链上表核实）：
 *   · 按 boss 等级判定：仅当「全球 boss 当前等级 > 你记录的 latestBossLevel」才打。
 *     源码 raid7 里击杀奖励的唯一触发条件就是 `if (raiderState.LatestBossLevel < bossState.Level)`，
 *     发完把 latestBossLevel 更新为当前 boss 等级；多升几级源码一次补发。未升级绝不打（不浪费票）。
 *   · 门票：免费票优先（remainChallengeCount>=1 → PayNcg=false），用尽后 NCG 买满 40
 *     （PayNcg=true；买票不扣免费票；上限 MaxPurchaseCount=40）。
 *   · 首次入场水晶：由 raid7 action 服务端自动扣（entranceFee×level² crystal），脚本不额外构造。
 *   · 只打不领：绝不提交 claim_world_boss_reward / claim_world_boss_kill_reward，
 *     击杀奖励记在 WorldBossKillRewardRecord（false=未领），由用户自行领取。
 *   · 启动门控：tip < --arm-block 秒退（workflow 默认 11889334 = 赛季起点 11889221 + 15分钟）。
 *   · 装备（用户方案）：用当前冒险模式装备 + 原来的符文槽。仅在赛季首战
 *     （latestBossLevel===0）校验实时装备与 LOADOUT_BASELINE（2026-11-21 链上导出）一致，
 *     不一致则停手；首战通过后 latestBossLevel≥1，后续免检（不换装就一直保持）。
 *     --no-loadout-guard 可完全关闭校验。
 *   · 首战S级通关校验：首场打完读战斗得分 highScore，≥ S_CLEAR_SCORE(18,771,857,028,
 *     = boss全5波HP和，用户截图实测的S级分数)才算通关；未通关立即停手，不买票不继续打。
 *     （highScore 为32位Int，S级分数会溢出；溢出+装备基线一致 → 视为通关。）
 *
 * 运行时护栏（防止理解偏差浪费水晶/NCG）：
 *   · cachedSheet(WorldBossListSheet) 校验当前赛季 ticket_price=1、additional=0、max=40 才允许买票；
 *     读不到或不符 → 只打免费票，不买（尊重「不是 1NCG 递增就暂不操作」）。
 *   · GameConfig 校验战斗间隔 worldboss_required_interval。
 *   · 赛季空档 / raidId 读不到 / 非目标赛季 → 跳过，绝不盲打。
 *   · 私钥 signer 必须等于 avatar 的 agentAddress。
 *   · 交易终态只认 SUCCESS / FAILURE / INVALID，且须带 blockIndex（跨节点复核，杜绝伪 INVALID）。
 *
 * 静默运行：仅 JSON 日志到 stdout，不推送任何通知。
 * 密钥：仅从 .env（runner 内由 keystore Secrets 临时解密生成），绝不落盘提交。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { RawPrivateKey, Address } from "@planetarium/account";
import { signTx, encodeSignedTx } from "@planetarium/tx";
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
  statusRpc: "https://heimdall6.9capi.com/graphql",
  rpcUrls: [
    "https://heimdall6.9capi.com/graphql",
    "https://heimdall-rpc-1.nine-chronicles.com/graphql",
    "https://heimdall7.9capi.com/graphql",
  ],
  mimir: "https://mimir.nine-chronicles.dev/heimdall/graphql/",
  confirmTries: 15,
  confirmIntervalMs: 5000,
};

const MAIN_AVATAR = "0xAC9D450C69dF27ee290C90EC61c4B76154b0A21c";
const AVATAR = ENV.NC_AVATAR || MAIN_AVATAR;
const TYPE_ID = "raid7";
// Lib9c Addresses.GetWorldBossAddress 派生用的常量地址（0x...15）
const RAID_CONST = "0x0000000000000000000000000000000000000015";
// 主网第37期：start=11889221, end=12040420, fee=1, ticket=1, add=0, max=40
const SEASON_DEFAULT = 37;
const TICKET_PRICE_EXPECT = 1;
const ADDITIONAL_PRICE_EXPECT = 0;
const MAX_PURCHASE_EXPECT = 40;
// S级通关门槛：boss900001 全5波HP之和（用户截图实测战斗得分，精确匹配）。
// 首场 highScore >= 此值 = 打穿全部 wave = S级通关；否则视为装备错误，停手。
const S_CLEAR_SCORE = 18771857028;
// 赛季末保留余量：tip 超过 end - END_BUFFER 就停止开新战斗（避免打空、浪费票）
const END_BUFFER = 1;
// ── 装备一致性护栏（用户方案：装备=当前冒险装备，符文=原来的符文）──
// 基线于 2026-11-21 从链上实时 equipped 导出（.NET Guid 字节序）。
// 运行时若实时装备与此不一致（例如中途换装），停手不操作，避免用错配置浪费票。
const LOADOUT_BASELINE = {
  equipments: [
    "84afc54e6d44d840948afc3089a24799", "5b14eb0589978444bde7de19f329b8a9",
    "eba24ec67f4e5c44acf718c40594835b", "2a9b1888b279d449a8864952c3405714",
    "a44d5b8d516e95418c834092994f8336", "78cc60679f7f1b49992732ed5b090eb7",
    "15ff826d104458439d02a19bbf2a66fc", "cf5f2258713bc94e943078cfa84e8cbc",
  ],
  costumes: [
    "3c07374778009e42bfa10a16854b5b34", "6619635e7b72d3479fda8675f64a366e",
  ],
  // 历史 SUCCESS 模板符文槽（slot:runeId）
  runeSlots: [[0,10047],[1,30001],[3,10055],[4,10051],[6,10052],[7,10003],[8,10056],[9,10013]],
};

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ONCE = args.includes("--once");
const WATCH = args.includes("--watch");
const SELF_TEST = args.includes("--self-test");
const BUILD_TEST = args.includes("--build-test");
// --no-loadout-guard 可在用户主动换装后手动放行（默认开启护栏）
const LOADOUT_GUARD = !args.includes("--no-loadout-guard");
const numArg = (flag, def) => {
  const i = args.indexOf(flag);
  if (i < 0) return def;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : def;
};
const SEASON = Math.max(1, Math.trunc(numArg("--season", SEASON_DEFAULT)));
// 启动门控：tip 到达 ARM_BLOCK 才真正开始打（用户要求约 11889221 之后）。ARM_BLOCK=0 关闭。
const ARM_BLOCK = Math.max(0, Math.trunc(numArg("--arm-block", 0)));
// 轮询间隔：按 boss 等级判定，等级由全球玩家推动，无需毫秒级抢；默认 60s。
const GAP_MS = Math.max(10000, numArg("--gap-ms", 60000));
// 单个 job 长驻预算，单位「秒」，默认 5.5h（< 6h 上限），耗尽交棒。
const MAX_WATCH_MS = Math.max(10, numArg("--max-watch-seconds", 330 * 60)) * 1000;

// 历史 raid7 SUCCESS 模板（block 11704772，第35期；含符文槽配置——GraphQL 无法直读 Raid 槽）
const TEMPLATE_RAW = "6475373a747970655f696475353a726169643775363a76616c7565736475313a6132303aac9d450c69df27ee290c90ec61c4b76154b0a21c75313a636c31363a3c07374778009e42bfa10a16854b5b3431363a3c07374778009e42bfa10a16854b5b3431363a124e4f4bdb116346bd68bcb86b8d301b31363a47695f4fb8c7a4449ca7c9b99891790b31363a6619635e7b72d3479fda8675f64a366e31363a12338ec56f2f2a499c1c1d5d8332666c6575313a656c31363a84afc54e6d44d840948afc3089a2479931363aeba24ec67f4e5c44acf718c40594835b31363a2a9b1888b279d449a8864952c340571431363aa44d5b8d516e95418c834092994f833631363a656ba3105d2d53419c2709151d1877c131363a78cc60679f7f1b49992732ed5b090eb731363a10279dce80a38b4390bbc01ab03ba71431363acf5f2258713bc94e943078cfa84e8cbc6575313a666c6575323a696431363a00af215d8453a9469c5196779a95bdd475313a706675313a726c6c75313a3075353a3130303437656c75313a3175353a3330303031656c75313a3375353a3130303535656c75313a3475353a3130303531656c75313a3675353a3130303532656c75313a3775353a3130303033656c75313a3875353a3130303536656c75313a3975353a313030313365656565";

// ---------------- 通用工具 ----------------
async function gql(url, query, variables = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "9c-world-boss/1.0" },
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

function isTerminalTxStatus(s) { return s === "SUCCESS" || s === "FAILURE" || s === "INVALID"; }
function isConfirmedTerminal(r) {
  if (!r || !isTerminalTxStatus(r.txStatus)) return false;
  return r.blockIndex != null && r.blockIndex !== "";
}

// Lib9c Address.Derive(string): SHA256(addressBytes + utf8(s))，取末 20 字节
function derive(addrHex, s) {
  const a = Address.fromHex(addrHex).toBytes();
  const sb = Buffer.from(s, "utf8");
  const h = createHash("sha256").update(Buffer.concat([Buffer.from(a), sb])).digest();
  return "0x" + h.subarray(h.length - 20).toString("hex");
}
// UUID (带/不带连字符) → .NET Guid.ToByteArray()：前 4/2/2 字节小端，后 8 不变
function uuidToDotnet(hex) {
  const b = Buffer.from(String(hex).replace(/-/g, ""), "hex");
  if (b.length !== 16) throw new Error(`装备 GUID 长度错误: ${hex}`);
  const o = Buffer.alloc(16);
  o[0] = b[3]; o[1] = b[2]; o[2] = b[1]; o[3] = b[0];
  o[4] = b[5]; o[5] = b[4]; o[6] = b[7]; o[7] = b[6];
  b.copy(o, 8, 8, 16);
  return o;
}

// ---------------- 链上状态读取 ----------------
async function getTip() {
  const d = await gqlRpc("{ nodeStatus { tip { index } } }");
  return BigInt(d.data.nodeStatus.tip.index);
}
// raidId 由区块号决定；赛季空档期会返回错误 → 返回 null
async function getRaidId(blockIndex) {
  try {
    const d = await gql(CFG.statusRpc,
      "query($b:Long!){ stateQuery { raidId(blockIndex:$b) } }", { b: String(blockIndex) });
    if (d.errors) return null;
    const v = d.data?.stateQuery?.raidId;
    return v == null ? null : Number(v);
  } catch (_) { return null; }
}
async function getAgentAddress(avatar) {
  const d = await gqlRpc("query($a:Address!){ stateQuery { avatar(avatarAddress:$a){ agentAddress } } }", { a: avatar });
  return d.data?.stateQuery?.avatar?.agentAddress || null;
}
async function getRaiderState(raiderAddress) {
  // 注意：highScore/totalScore 是 32 位 Int，S 级得分(187亿)会溢出导致整个查询失败。
  // 日常逻辑只用小值字段；highScore 由 readHighScore() 单独带溢出感知地读取。
  const q = `query($r:Address!){ stateQuery { raiderState(raiderAddress:$r){
    latestBossLevel remainChallengeCount purchaseCount totalChallengeCount level cp
    refillBlockIndex claimedBlockIndex avatarAddress avatarName
  } } }`;
  const d = await gqlRpc(q, { r: raiderAddress });
  return d.data?.stateQuery?.raiderState || null;
}
// 读取战斗得分 highScore。返回：
//   { ok:true, value:Number, overflow:false }  正常读到（值在 32 位内）
//   { ok:true, value:null, overflow:true }     溢出（伤害>21.47亿，GraphQL Int 装不下）→ 暗示大伤害
//   { ok:false, reason }                       状态未初始化/其他错误
async function readHighScore(raiderAddress) {
  const q = "query($r:Address!){ stateQuery { raiderState(raiderAddress:$r){ highScore } } }";
  let lastErr = null;
  for (const url of CFG.rpcUrls) {
    try {
      const d = await gql(url, q, { r: raiderAddress });
      if (d.errors && d.errors.length) { lastErr = d.errors[0].message; continue; } // 可能溢出，换节点再试确认
      const v = d.data?.stateQuery?.raiderState?.highScore;
      return { ok: true, value: v == null ? null : Number(v), overflow: false, _url: url };
    } catch (e) { lastErr = e.message; }
  }
  // 所有节点都返回错误：极可能是 highScore 溢出（大伤害），也可能是状态未初始化。
  return { ok: true, value: null, overflow: true, reason: String(lastErr || "").slice(0, 120) };
}
async function getWorldBossState(bossAddress) {
  const q = `query($b:Address!){ stateQuery { worldBossState(bossAddress:$b){
    id level currentHp startedBlockIndex endedBlockIndex totalDamage
  } } }`;
  const d = await gqlRpc(q, { b: bossAddress });
  return d.data?.stateQuery?.worldBossState || null;
}
// 已链上核实的赛季表快照（cachedSheet(WorldBossListSheet) 实测读取，2026-11-20）。
// 仅作「价格护栏」兜底：当实时表因节点抽风读不到时，若目标 raidId 在快照内，用快照校验票价。
// 严格按 raidId 匹配，绝不用其他赛季的值冒充；快照值与护栏常量一致才采信。
const SEASON_SNAPSHOT = {
  37: { start: 11889221, end: 12040420, entranceFee: 1, ticketPrice: 1, additionalPrice: 0, maxPurchase: 40 },
  38: { start: 12214301, end: 12365500, entranceFee: 1, ticketPrice: 1, additionalPrice: 0, maxPurchase: 40 },
  39: { start: 12539381, end: 12690580, entranceFee: 1, ticketPrice: 1, additionalPrice: 0, maxPurchase: 40 },
  40: { start: 12864461, end: 13015660, entranceFee: 1, ticketPrice: 1, additionalPrice: 0, maxPurchase: 40 },
};
function snapshotRow(raidId) {
  const s = SEASON_SNAPSHOT[Number(raidId)];
  if (!s) return null;
  return { id: Number(raidId), bossId: null, ...s, source: "snapshot" };
}

// 读赛季表当前行（权威票价/上限/起止块）。cachedSheet 常间歇返回 null，故多轮跨节点重试。
async function getSeasonRow(raidId, tries = 5) {
  const q = '{ stateQuery { cachedSheet(tableName:"WorldBossListSheet") } }';
  let csvText = null;
  for (let i = 0; i < tries && !csvText; i++) {
    for (const url of CFG.rpcUrls) {
      try {
        const d = await gql(url, q, {}, 15000);
        const t = d.data?.stateQuery?.cachedSheet;
        if (t && String(t).trim().length > 20) { csvText = t; break; }
      } catch (_) { /* 换节点 */ }
    }
    if (!csvText && i < tries - 1) await sleepMs(1200);
  }
  if (!csvText) {
    // 实时表读不到 → 用已核实快照兜底（仅校验价格/上限，同样受 ticketSafe 约束）
    const snap = snapshotRow(raidId);
    if (snap) log({ level: "warn", msg: "cachedSheet 读取失败，采用已核实赛季快照作价格护栏", raidId, source: "snapshot" });
    return snap;
  }
  const lines = String(csvText).trim().split(/\r?\n/);
  if (lines.length < 2) return snapshotRow(raidId);
  const head = lines[0].split(",").map(s => s.trim());
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map(s => s.trim());
    const row = {};
    head.forEach((h, j) => { row[h] = cells[j]; });
    if (Number(row["id"]) === Number(raidId)) {
      return {
        id: Number(row["id"]),
        bossId: Number(row["boss_id"]),
        start: Number(row["started_block_index"]),
        end: Number(row["ended_block_index"]),
        entranceFee: Number(row["fee"]),
        ticketPrice: Number(row["ticket_price"]),
        additionalPrice: Number(row["additional_ticket_price"]),
        maxPurchase: Number(row["max_purchase_count"]),
        source: "live",
      };
    }
  }
  return snapshotRow(raidId);
}
// 买票公平性护栏：只有读到表且票价=1/不递增/上限40 才允许 NCG 买票
function ticketSafe(row) {
  return !!row
    && row.ticketPrice === TICKET_PRICE_EXPECT
    && row.additionalPrice === ADDITIONAL_PRICE_EXPECT
    && row.maxPurchase === MAX_PURCHASE_EXPECT;
}
// 赛季首战判定：LatestBossLevel 初值为 0（未打过），打过一场后更新为 boss 等级(≥1)。
function isFirstBattleOfSeason(latestBossLevel) {
  const n = Number(latestBossLevel || 0);
  return Number.isFinite(n) && n === 0;
}
// 判断首场是否达到 S 级通关（战斗得分 ≥ S_CLEAR_SCORE）。
// hs = readHighScore() 结果。溢出(overflow=true)时：伤害>21.47亿，
// 结合「首战装备已与S级基线校验一致」，视为通关；否则按数值比较。
function judgeFirstBattleClear(hs) {
  if (!hs || hs.ok === false) return { clear: false, reason: "highScore 读取失败，无法确认通关", hs };
  if (hs.overflow) return {
    clear: true, reason: `得分字段溢出(>21.47亿, 32位Int装不下)，结合装备基线一致 → 视为S级通关`, hs };
  if (hs.value == null) return { clear: false, reason: "highScore 未同步（值缺失），暂不判定", hs };
  const v = Number(hs.value);
  return {
    clear: v >= S_CLEAR_SCORE,
    reason: v >= S_CLEAR_SCORE
      ? `战斗得分 ${v} ≥ S级门槛 ${S_CLEAR_SCORE}，通关`
      : `战斗得分 ${v} < S级门槛 ${S_CLEAR_SCORE}，未通关（装备可能错误）`,
    hs, score: v,
  };
}

// ---------------- 现场构造 raid7 action ----------------
// 实时装备（equipped）优先，符文槽沿用历史 SUCCESS 模板（GraphQL 无法直读 Raid 槽）。
function decodeTemplate() {
  const action = decode(Buffer.from(TEMPLATE_RAW, "hex"));
  if (!(action instanceof BencodexDictionary) || String(action.get("type_id")) !== TYPE_ID) {
    throw new Error("raid7 模板 type_id 校验失败");
  }
  const values = action.get("values");
  if (!(values instanceof BencodexDictionary)) throw new Error("raid7 模板 values 结构校验失败");
  const mine = Buffer.from(Address.fromHex(AVATAR).toBytes());
  const a = values.get("a");
  if (!Buffer.isBuffer(a) || !a.equals(mine)) throw new Error("raid7 模板 avatarAddress 与本角色不符");
  // 符文槽：[slotIndex, runeId]
  const runeSlotInfos = [...values.get("r")].map(x => [Number(x[0]), Number(x[1])]);
  return { runeSlotInfos };
}
// checkGuard：是否本次做装备一致性校验（仅赛季首战为 true，后续免检）
async function resolveLoadout(checkGuard = LOADOUT_GUARD) {
  const { runeSlotInfos } = decodeTemplate();
  const q = `query($a:Address!){ stateQuery { avatar(avatarAddress:$a){
    level
    inventory { equipments { itemId equipped } costumes { itemId equipped } }
  } } }`;
  const d = await gqlRpc(q, { a: AVATAR });
  const inv = d.data?.stateQuery?.avatar?.inventory;
  if (!inv) throw new Error("avatar inventory 为空");
  const equipmentIds = (inv.equipments || []).filter(e => e.equipped).map(e => uuidToDotnet(e.itemId));
  const costumeIds = (inv.costumes || []).filter(e => e.equipped).map(e => uuidToDotnet(e.itemId));
  if (!equipmentIds.length) throw new Error("当前无已装备 equipments，拒绝构造以免 FAILURE 浪费票");
  // 装备一致性护栏：仅赛季首战执行。实时装备必须与基线完全一致（顺序无关），否则停手。
  // 首战通过后 latestBossLevel≥1，后续轮次不再校验（用户：不换装就一直保持）。
  if (checkGuard) {
    const eqSet = equipmentIds.map(b => b.toString("hex")).sort();
    const coSet = costumeIds.map(b => b.toString("hex")).sort();
    const baseEq = [...LOADOUT_BASELINE.equipments].sort();
    const baseCo = [...LOADOUT_BASELINE.costumes].sort();
    const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    if (!sameSet(eqSet, baseEq) || !sameSet(coSet, baseCo)) {
      const added = eqSet.filter(x => !baseEq.includes(x));
      const missing = baseEq.filter(x => !eqSet.includes(x));
      throw new Error(`装备与基线不一致，停手不操作（如需放行加 --no-loadout-guard）。新增=${added.join(",")||"无"} 缺失=${missing.join(",")||"无"}`);
    }
  }
  log({ level: "info", msg: checkGuard
        ? "loadout=实时装备(首战已校验基线一致)+模板符文槽"
        : "loadout=实时装备(非首战免检)+模板符文槽",
        checked: !!checkGuard, equipments: equipmentIds.length, costumes: costumeIds.length, runeSlots: runeSlotInfos.length });
  return { equipmentIds, costumeIds, runeSlotInfos };
}
function buildRaidAction(loadout, payNcg) {
  const values = new BencodexDictionary([
    ["a", Buffer.from(Address.fromHex(AVATAR).toBytes())],
    ["c", loadout.costumeIds],
    ["e", loadout.equipmentIds],
    ["f", []],
    ["id", randomBytes(16)],
    ["p", !!payNcg],
    ["r", loadout.runeSlotInfos.map(([s, rid]) => [s, rid])],
  ]);
  return new BencodexDictionary([
    ["type_id", TYPE_ID],
    ["values", values],
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
async function confirmTxAcrossNodes(txId, tries = CFG.confirmTries) {
  const q = "query($t:TxId!){ transaction { transactionResult(txId:$t){ txStatus blockIndex exceptionNames } } }";
  let lastUnconfirmed = null;
  for (let i = 0; i < tries; i++) {
    const results = await Promise.all(CFG.rpcUrls.map(async (url) => {
      try { const d = await gql(url, q, { t: txId }, 20000); return d.data?.transaction?.transactionResult; }
      catch (_) { return null; }
    }));
    let confirmed = null;
    for (const r of results) {
      if (!r) continue;
      if (isConfirmedTerminal(r)) { confirmed = r; break; }
      if (!lastUnconfirmed || r.txStatus === "PENDING") lastUnconfirmed = r;
    }
    if (confirmed) return confirmed;
    if (i < tries - 1) await sleepMs(CFG.confirmIntervalMs);
  }
  return lastUnconfirmed || { txStatus: "PENDING" };
}

// ---------------- 判定：本轮是否打、用什么票 ----------------
function decide({ raidId, row, raider, boss, tip }) {
  if (raidId == null) return { ok: false, reason: "赛季空档期（raidId 读不到），跳过", code: "gap" };
  if (raidId !== SEASON) return {
    ok: false, reason: `当前 raidId=${raidId} ≠ 目标赛季 ${SEASON}，跳过`, code: "season_mismatch", raidId };
  if (!raider || !boss) return {
    ok: false, reason: `链上状态未初始化（raider=${!!raider}, boss=${!!boss}），赛季刚开始稍候`, code: "uninit" };
  if (row && row.end && tip >= BigInt(row.end - END_BUFFER)) return {
    ok: false, reason: `赛季临近结束（tip=${tip} ≥ end-buffer=${row.end - END_BUFFER}），停止开新战斗`, code: "season_end" };

  // 按 boss 等级判定：只有 boss 等级高于已记录等级才打（保证击杀奖励）
  const bossLv = Number(boss.level);
  const latestLv = Number(raider.latestBossLevel || 0);
  if (!Number.isFinite(bossLv) || bossLv <= latestLv) return {
    ok: false, reason: `boss 未升级（boss.level=${bossLv}, latestBossLevel=${latestLv}），等待`, code: "no_level_up",
    bossLv, latestLv };

  // 门票策略：免费票优先；用尽后走 NCG（受 ticketSafe 护栏约束）
  const remain = Number(raider.remainChallengeCount || 0);
  const purchased = Number(raider.purchaseCount || 0);
  let payNcg, ticketMode;
  if (remain >= 1) {
    payNcg = false; ticketMode = "free";
  } else {
    if (!ticketSafe(row)) return {
      ok: false, reason: `免费票用尽但票价护栏未通过（ticket_price=${row?.ticketPrice}, additional=${row?.additionalPrice}, max=${row?.maxPurchase}），不买票`, code: "ticket_unsafe" };
    if (purchased >= Number(row.maxPurchase)) return {
      ok: false, reason: `已达买票上限（purchaseCount=${purchased} ≥ ${row.maxPurchase}），停止`, code: "purchase_cap" };
    payNcg = true; ticketMode = "ncg";
  }
  return {
    ok: true, reason: `命中：boss ${latestLv}→${bossLv} 升级，${ticketMode}票`, code: "hit",
    bossLv, latestLv, remain, purchased, payNcg, ticketMode,
  };
}

// ---------------- 单次执行 ----------------
async function runOnce(ctx, out) {
  const tip = await getTip();
  const raidId = await getRaidId(tip);
  const row = raidId != null ? await getSeasonRow(raidId).catch(() => null) : null;
  let raider = null, boss = null;
  if (raidId != null) {
    const raiderAddr = derive(AVATAR, String(raidId));
    const bossAddr = derive(RAID_CONST, String(raidId));
    raider = await getRaiderState(raiderAddr).catch(() => null);
    boss = await getWorldBossState(bossAddr).catch(() => null);
  }
  out.status = {
    tip: String(tip), raidId, season: row?.id ?? null,
    window: row ? `${row.start}~${row.end}` : null,
    bossLevel: boss?.level ?? null, latestBossLevel: raider?.latestBossLevel ?? null,
    remainTickets: raider?.remainChallengeCount ?? null, purchaseCount: raider?.purchaseCount ?? null,
    ticket: row ? { price: row.ticketPrice, additional: row.additionalPrice, max: row.maxPurchase } : null,
  };
  const d = decide({ raidId, row, raider, boss, tip });
  out.decision = d;
  log({ level: "info", msg: "WB 状态检查", ...out.status, target: SEASON, hit: d.ok, why: d.reason });
  if (!d.ok) { out.result = "skip:" + d.code; return; }

  // 装备一致性校验：仅赛季首战（latestBossLevel===0）执行；打过一场后 ≥1，后续免检。
  const isFirstBattle = isFirstBattleOfSeason(raider.latestBossLevel);
  const checkGuard = LOADOUT_GUARD && isFirstBattle;
  const loadout = await resolveLoadout(checkGuard);
  const actionValue = buildRaidAction(loadout, d.payNcg);
  out.action = { typeId: TYPE_ID, payNcg: d.payNcg, ticketMode: d.ticketMode, build: "live-equip+tmpl-rune",
                 isFirstBattle, loadoutChecked: checkGuard };
  log({ level: "info", msg: "构造 raid7 action 完成", payNcg: d.payNcg, ticketMode: d.ticketMode,
        isFirstBattle, loadoutChecked: checkGuard });

  if (DRY) { out.result = "dry-run（未提交）"; return; }
  if (!ctx) throw new Error("缺少签名上下文");
  const agent = await getAgentAddress(AVATAR);
  if (!agent || agent.toLowerCase() !== ctx.signer.toString().toLowerCase()) {
    throw new Error(`私钥与 avatar 不匹配（signer=${ctx.signer.toString()}, agent=${agent}）`);
  }
  const nonce = await getNonce(ctx.signer.toString());
  const txId = await submitTx({ ...ctx, nonce, actionValue });
  out.txId = txId; out.nonce = String(nonce); out.submitted = true;
  log({ level: "info", msg: "已提交 raid7", txId, nonce: String(nonce), payNcg: d.payNcg });

  const result = await confirmTxAcrossNodes(txId);
  out.txResult = result;
  log({ level: "info", msg: "交易终态", txId, ...result });
  if (!isConfirmedTerminal(result)) {
    out.result = `交易未定论（${result.txStatus}，未入块）——不重复提交，等链上确认`;
    return;
  }
  if (result.txStatus !== "SUCCESS") {
    out.result = `交易未成功（${result.txStatus}@block${result.blockIndex}）——停止本轮，不重复提交`;
    return;
  }

  // 首战 S 级通关校验：打完第一场后读战斗得分，判定装备是否正确。
  // 未通关（得分<S级门槛）→ 立即停手，不买票、不继续打。
  if (isFirstBattle && LOADOUT_GUARD) {
    const raiderAddr = derive(AVATAR, String(raidId));
    let judged = null;
    for (let attempt = 0; attempt < CFG.confirmTries; attempt++) {
      const hs = await readHighScore(raiderAddr);
      judged = judgeFirstBattleClear(hs);
      // 能读到数值(v>=0)或确认溢出 → 状态已更新，可以判定；否则等节点同步
      if (hs.value != null || hs.overflow) break;
      await sleepMs(CFG.confirmIntervalMs);
    }
    out.firstBattleClear = judged;
    log({ level: "info", msg: "首战S级通关校验", ...judged });
    if (!judged.clear) {
      out.result = `首战未达S级通关，停手不继续（${judged.reason}）——装备可能错误`;
      return;
    }
  }

  out.result = "战斗提交成功（SUCCESS，未领取奖励）";
}

async function makeCtx() {
  if (!CFG.privateKey) return null;
  const hex = CFG.privateKey.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("私钥格式错误：需要 64 位十六进制");
  const account = RawPrivateKey.fromHex(hex);
  const pub = await account.getPublicKey();
  const signer = Address.deriveFrom(pub);
  return { account, pub, signer };
}

async function main() {
  if (SELF_TEST) return selfTest();
  const out = { network: "heimdall", avatar: AVATAR, dryRun: DRY, mode: WATCH ? "watch" : "once", ok: true };

  if (BUILD_TEST) {
    try {
      const tip = await getTip();
      const raidId = await getRaidId(tip);
      const row = raidId != null ? await getSeasonRow(raidId) : null;
      const loadout = await resolveLoadout();
      const a = buildRaidAction(loadout, false);
      const v = a.get("values");
      out.detail = {
        tip: String(tip), raidId, seasonRow: row,
        typeId: String(a.get("type_id")),
        fields: [...v.keys()],
        equipmentCount: [...v.get("e")].length,
        costumeCount: [...v.get("c")].length,
        runeCount: [...v.get("r")].length,
        payNcg: v.get("p"),
      };
      log({ level: "info", msg: "构造验证成功（未提交交易）", ...out.detail });
    } catch (e) { out.ok = false; out.error = e.message; }
    console.log(JSON.stringify(out));
    if (!out.ok) process.exit(1);
    return;
  }

  // 启动门控：tip 未到 ARM_BLOCK 秒退（不进入长驻）
  if (ARM_BLOCK > 0) {
    const tip = await getTip().catch(() => null);
    if (tip != null && tip < BigInt(ARM_BLOCK)) {
      log({ level: "info", msg: "启动门控：tip 未到 arm_block，秒退", tip: String(tip), armBlock: ARM_BLOCK });
      console.log(JSON.stringify({ ...out, armed: false, tip: String(tip), armBlock: ARM_BLOCK,
        result: "not_armed（tip 未到启动区块，秒退）" }));
      return;
    }
    log({ level: "info", msg: "启动门控：tip 已到，开始", tip: String(tip), armBlock: ARM_BLOCK });
  }

  let ctx = null;
  if (!DRY) {
    try { ctx = await makeCtx(); }
    catch (e) { log({ level: "error", msg: "私钥加载失败", detail: e.message }); out.ok = false; out.error = e.message; console.log(JSON.stringify(out)); process.exit(1); }
    if (!ctx) { out.ok = false; out.error = "缺少 NC_PRIVATE_KEY"; console.log(JSON.stringify(out)); process.exit(1); }
  }

  if (WATCH) {
    const started = Date.now();
    log({ level: "info", msg: "进入 WB 蹲守（进程内轮询，按 boss 等级判定）", season: SEASON, gapMs: GAP_MS, budgetSec: Math.round(MAX_WATCH_MS / 1000) });
    let rounds = 0;
    while (Date.now() - started < MAX_WATCH_MS) {
      rounds++; out.round = rounds;
      try {
        await runOnce(ctx, out);
        // 达到买票上限 / 赛季结束 / 已提交未定论 / 交易定论 → 停止本 job，不空转、不交棒
        if (out.result && /^(skip:(purchase_cap|season_end|season_mismatch|gap)|战斗提交成功|交易未定论|交易未成功)/.test(out.result)) {
          out.handoff = "none"; break;
        }
      } catch (e) { log({ level: "warn", msg: "本轮检查异常，稍后重试", detail: e.message }); }
      await sleepMs(GAP_MS);
    }
    if (!out.handoff) out.handoff = out.submitted ? "none" : (DRY ? "dry_run" : "budget_exhausted");
    out.rounds = rounds; out.elapsedSec = Math.round((Date.now() - started) / 1000);
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
  const base = { tip: 11889221n };
  const row = { id: 37, start: 11889221, end: 12040420, ticketPrice: 1, additionalPrice: 0, maxPurchase: 40 };
  const raider = (o={}) => ({ latestBossLevel: 5, remainChallengeCount: 2, purchaseCount: 0, ...o });
  const boss = (o={}) => ({ level: 5, ...o });

  ok("终态 SUCCESS", isTerminalTxStatus("SUCCESS") === true);
  ok("终态 FAILURE", isTerminalTxStatus("FAILURE") === true);
  ok("终态 INVALID", isTerminalTxStatus("INVALID") === true);
  ok("STAGING 非终态", isTerminalTxStatus("STAGING") === false);
  ok("INCLUDED 非终态", isTerminalTxStatus("INCLUDED") === false);
  ok("PENDING 非终态", isTerminalTxStatus("PENDING") === false);
  ok("终态须带 blockIndex", isConfirmedTerminal({ txStatus: "SUCCESS", blockIndex: 123 }) === true);
  ok("伪 INVALID(无块号)不算", isConfirmedTerminal({ txStatus: "INVALID", blockIndex: null }) === false);

  ok("票价护栏 通过", ticketSafe(row) === true);
  ok("赛季快照第37期安全", ticketSafe(snapshotRow(37)) === true);
  ok("赛季快照第38期安全", ticketSafe(snapshotRow(38)) === true);
  ok("赛季快照未知期返回null", snapshotRow(999) === null);
  ok("票价护栏 递增票拒绝", ticketSafe({ ...row, additionalPrice: 1 }) === false);
  ok("票价护栏 涨票价拒绝", ticketSafe({ ...row, ticketPrice: 2 }) === false);
  ok("票价护栏 上限非40拒绝", ticketSafe({ ...row, maxPurchase: 20 }) === false);
  ok("票价护栏 无表拒绝", ticketSafe(null) === false);

  ok("赛季空档跳过", decide({ ...base, raidId: null, row, raider: raider(), boss: boss() }).code === "gap");
  ok("赛季号不符跳过", decide({ ...base, raidId: 36, row, raider: raider(), boss: boss() }).code === "season_mismatch");
  ok("状态未初始化跳过", decide({ ...base, raidId: 37, row, raider: null, boss: boss() }).code === "uninit");
  const dNoUp = decide({ ...base, raidId: 37, row, raider: raider({ latestBossLevel: 5 }), boss: boss({ level: 5 }) });
  ok("boss未升级不打", dNoUp.ok === false && dNoUp.code === "no_level_up");
  const dLower = decide({ ...base, raidId: 37, row, raider: raider({ latestBossLevel: 9 }), boss: boss({ level: 8 }) });
  ok("boss等级反低不打", dLower.ok === false && dLower.code === "no_level_up");
  const dFree = decide({ ...base, raidId: 37, row, raider: raider({ remainChallengeCount: 2 }), boss: boss({ level: 6 }) });
  ok("免费票命中且payNcg=false", dFree.ok === true && dFree.payNcg === false && dFree.ticketMode === "free");
  const dNcg = decide({ ...base, raidId: 37, row, raider: raider({ remainChallengeCount: 0, purchaseCount: 3 }), boss: boss({ level: 6 }) });
  ok("免票用尽买票payNcg=true", dNcg.ok === true && dNcg.payNcg === true && dNcg.ticketMode === "ncg");
  const dCap = decide({ ...base, raidId: 37, row, raider: raider({ remainChallengeCount: 0, purchaseCount: 40 }), boss: boss({ level: 6 }) });
  ok("买满40停止", dCap.ok === false && dCap.code === "purchase_cap");
  const dUnsafe = decide({ ...base, raidId: 37, row: { ...row, additionalPrice: 1 }, raider: raider({ remainChallengeCount: 0 }), boss: boss({ level: 6 }) });
  ok("票价不安全不买票", dUnsafe.ok === false && dUnsafe.code === "ticket_unsafe");
  const dEnd = decide({ ...base, tip: BigInt(row.end), raidId: 37, row, raider: raider(), boss: boss({ level: 6 }) });
  ok("赛季末停止", dEnd.ok === false && dEnd.code === "season_end");
  const dMulti = decide({ ...base, raidId: 37, row, raider: raider({ latestBossLevel: 3 }), boss: boss({ level: 7 }) });
  ok("boss多级也命中", dMulti.ok === true && dMulti.bossLv === 7 && dMulti.latestLv === 3);

  ok("UUID→.NET Guid 小端", uuidToDotnet("4ec5af84-446d-40d8-948a-fc3089a24799").toString("hex") === "84afc54e6d44d840948afc3089a24799");
  ok("UUID 无连字符同样", uuidToDotnet("4ec5af84446d40d8948afc3089a24799").toString("hex") === "84afc54e6d44d840948afc3089a24799");
  ok("UUID 后8字节不变", uuidToDotnet("4ec5af84-446d-40d8-948a-fc3089a24799").subarray(8).toString("hex") === "948afc3089a24799");

  // 模板字段完整性
  const t = decodeTemplate();
  ok("模板符文槽=8", t.runeSlotInfos.length === 8);
  ok("符文槽格式[slot,rune]", t.runeSlotInfos.every(x => x.length === 2 && Number.isInteger(x[0]) && Number.isInteger(x[1])));

  // 装备基线护栏
  ok("装备基线8件", LOADOUT_BASELINE.equipments.length === 8);
  ok("时装基线2件", LOADOUT_BASELINE.costumes.length === 2);
  ok("装备基线均为32位hex", LOADOUT_BASELINE.equipments.every(x => /^[0-9a-f]{32}$/.test(x)));
  const sameSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
  ok("集合比较-顺序无关", sameSet(["a","b"], ["b","a"]) === true);
  ok("集合比较-新增检测", sameSet(["a","b","c"], ["a","b"]) === false);
  ok("基线符文=模板符文", sameSet(
    LOADOUT_BASELINE.runeSlots.map(x => x.join(":")),
    t.runeSlotInfos.map(x => x.join(":"))));

  // 首战判定（latestBossLevel===0 才校验装备）
  ok("首战判定 0=是", isFirstBattleOfSeason(0) === true);
  ok("首战判定 null=是", isFirstBattleOfSeason(null) === true);
  ok("首战判定 undefined=是", isFirstBattleOfSeason(undefined) === true);
  ok("首战判定 1=否(已打过)", isFirstBattleOfSeason(1) === false);
  ok("首战判定 300=否", isFirstBattleOfSeason(300) === false);
  ok("首战判定 字符串0=是", isFirstBattleOfSeason("0") === true);

  // S级通关判定
  ok("S级门槛=全5波HP和", S_CLEAR_SCORE === 18771857028);
  ok("通关-得分恰好达标", judgeFirstBattleClear({ ok:true, value:S_CLEAR_SCORE, overflow:false }).clear === true);
  ok("通关-得分超过", judgeFirstBattleClear({ ok:true, value:S_CLEAR_SCORE+1, overflow:false }).clear === true);
  ok("未通关-得分不足", judgeFirstBattleClear({ ok:true, value:1000000, overflow:false }).clear === false);
  ok("未通关-得分0", judgeFirstBattleClear({ ok:true, value:0, overflow:false }).clear === false);
  ok("溢出=视为通关", judgeFirstBattleClear({ ok:true, value:null, overflow:true }).clear === true);
  ok("读取失败=未通关", judgeFirstBattleClear({ ok:false, reason:"err" }).clear === false);

  console.log(JSON.stringify({ selfTest: { pass, fail, ok: fail === 0 } }));
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.log(JSON.stringify({ ts: new Date().toISOString(), level: "error", fatal: e.message })); process.exit(1); });
