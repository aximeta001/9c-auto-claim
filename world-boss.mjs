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
 *   · 只打不领（2026-11-22 事故后铁律）：绝不提交任何 claim action——既不手动 claim
 *     击杀奖励，也不 claim 排名奖励。真相：raid7 战斗结算内部 SetWorldBossKillReward
 *     已【自动】领掉所有 level<boss.level 的击杀奖励，并留下一条未领"引子"。
 *     单独 claim 会把引子领光 → rewardRecord 全 claimed=true → 下次 raid7 结算
 *     IsClaimable(boss.level)=false → 抛 InvalidClaimException → 整笔战斗永久 FAILURE（死锁）。
 *     本赛季37已因此死锁。故本脚本永远只提交 raid7，一个 claim 都不发。
 *   · 赛季：默认自动跟随链上当前 raidId（跨赛季无需改代码）；仅显式 --season N 才锁定。
 *   · 启动门控：tip < --arm-block 秒退（0=关闭门控）。
 *   · 装备（用户 2026-11-21 最终确认方案）：一律取【当前穿戴装备】= Heimdall
 *     avatar.inventory 中 equipped=true 的 6 件常规装备(武器/甲/腰带/项链/戒指×2)，
 *     气场固定取 itemId=10670003 (Barrage Aura, Lv11)，魔典固定取 itemId=10780009
 *     (SPD Gri(S), grade8) —— 这两件在背包里无 equipped 标记，故按 itemId 取最高等级实例。
 *     共 8 件 equipment。时装取 inventory.costumes 中 equipped=true 的 2 件。
 *     注：绝不再用 Mimir itemSlot(RAID) —— 那是旧赛季残留的 Surt 套装（用户实测"6件全错"）。
 *     气场/魔典 属 equipment(ValidateEquipmentsV3)，非 costume。
 *     符文沿用【上赛季 SUCCESS 模板】槽位——冒险/Raid 两模式符文不通用，绝不用实时冒险符文。
 *     任何装备读取不全则保守停手。装备对错的唯一裁决是"首战 S 级通关"：
 *     打不出 S 级即停手（用户："第一次没通关说明装备错了"）。
 *   · 首战S级通关校验：首场打完读战斗得分 highScore，必须【精确≥】S_CLEAR_SCORE
 *     (18,771,857,028 = boss全5波HP和，用户截图实测S级分数)才算通关；否则立即停手。
 *     得分读自 Mimir(worldBossRaider.highScore=Long 64位，精确)；Heimdall 的 highScore
 *     是32位Int会溢出，【绝不用"溢出"当通关】——因 wave4 累计67.7亿也溢出，
 *     会把"打过wave4没过wave5"误判通关。拿不到精确值一律保守停手，不买票不继续。
 *
 * 运行时护栏（防止理解偏差浪费水晶/NCG）：
 *   · cachedSheet(WorldBossListSheet) 校验当前赛季 ticket_price=1、additional=0、max=40 才允许买票；
 *     读不到或不符 → 只打免费票，不买（尊重「不是 1NCG 递增就暂不操作」）。
 *   · GameConfig 校验战斗间隔 worldboss_required_interval。
 *   · 赛季空档 / raidId 读不到 → 跳过，绝不盲打；显式锁定赛季时非目标赛季也跳过。
 *   · 私钥 signer 必须等于 avatar 的 agentAddress。
 *   · 交易终态只认 SUCCESS / FAILURE / INVALID，且须带 blockIndex（跨节点复核，杜绝伪 INVALID）。
 *
 * 静默运行：仅 JSON 日志到 stdout，不推送任何通知。
 * 密钥：仅从 .env（runner 内由 keystore Secrets 临时解密生成），绝不落盘提交。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes } from "node:crypto";
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
// 赛季跟随：默认 0 = 自动跟随链上当前 raidId（2026-11-23 起，跨赛季无需改代码）。
// 仅当显式传 --season N（N>0）时才锁定到指定赛季（应急/调试用）。
const SEASON_DEFAULT = 0;
const TICKET_PRICE_EXPECT = 1;
const ADDITIONAL_PRICE_EXPECT = 0;
const MAX_PURCHASE_EXPECT = 40;
// S级通关门槛：boss900001 全5波HP之和（用户截图实测战斗得分，精确匹配）。
// 首场 highScore >= 此值 = 打穿全部 wave = S级通关；否则视为装备错误，停手。
const S_CLEAR_SCORE = 18771857028;
// 赛季末保留余量：tip 超过 end - END_BUFFER 就停止开新战斗（避免打空、浪费票）
const END_BUFFER = 1;
// ── 旧基线快照（仅供日志参照，不用于拦截）──
// 2026-11-21 从上赛季链上实时 equipped 导出（.NET Guid 字节序）。
// 用户随后卖/升级/换装，实时装备与它不同是正常的；脚本一律用实时装备，
// 装备对错由"首战 S 级通关"裁决，绝不拿这份旧快照卡住。runeSlots 仍用于模板一致性自检。
const LOADOUT_BASELINE = {
  equipments: [
    "84afc54e6d44d840948afc3089a24799", "5b14eb0589978444bde7de19f329b8a9",
    "eba24ec67f4e5c44acf718c40594835b", "2a9b1888b279d449a8864952c3405714",
    "a44d5b8d516e95418c834092994f8336", "78cc60679f7f1b49992732ed5b090eb7",
    "15ff826d104458439d02a19bbf2a66fc", "cf5f2258713bc94e943078cfa84e8cbc",
  ],
  // 当前穿戴时装 2 件（equipped=true）的 .NET Guid，仅日志参照
  costumes: [
    "3c07374778009e42bfa10a16854b5b34", "3dbdcb4788e4ea4aa7a8bfc396c12cb9",
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
// 首战 S 级通关校验开关（默认开启）。已无"装备基线拦截"，此项只控制首战 S 级实战裁决；
// --no-loadout-guard 可跳过首战 S 级校验（一般不需要，保留作应急）。
const LOADOUT_GUARD = !args.includes("--no-loadout-guard");
// 2026-11-22 事故后：自动领取代码已【彻底删除】，脚本永不提交任何 claim action。
// 击杀奖励由 raid7 战斗结算内部自动领取；单独 claim 会领光引子导致永久死锁（详见文件头）。
const numArg = (flag, def) => {
  const i = args.indexOf(flag);
  if (i < 0) return def;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : def;
};
// SEASON=0 表示跟随链上 raidId；>0 表示显式锁定该赛季。
const SEASON = Math.max(0, Math.trunc(numArg("--season", SEASON_DEFAULT)));
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

// Lib9c Nekoyume.Action.AddressExtension.Derive(address, string):
//   HMACSHA1(key=utf8(s), data=addressBytes) -> new Address(20 bytes)。
// 2026-11-22 关键修复：旧实现误用 SHA256(addr+string)，派生出的 boss/raider 地址
// 全部错误 → 链上状态读 null → 被误判为「赛季空档期 skip:gap」，整个赛季一次没打。
// 现按 Lib9c 源码改为 HMACSHA1（key 是字符串，data 是地址字节）。
function derive(addrHex, s) {
  const a = Address.fromHex(addrHex).toBytes();
  const h = createHmac("sha1", Buffer.from(s, "utf8")).update(a).digest();
  return "0x" + h.subarray(0, 20).toString("hex");
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
    // 2026-11-22 修复：blockIndex 必须作为 Long 传入（数字/BigInt），
    // 旧代码传 String 导致 GraphQL "Unable to convert to Long" 报错 → null → 误判赛季空档。
    const d = await gql(CFG.statusRpc,
      "query($b:Long!){ stateQuery { raidId(blockIndex:$b) } }", { b: Number(blockIndex) });
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
  // 2026-11-22 修复：cp 字段是 BigInteger，Heimdall GraphQL 暴露时 OVERFLOW 会
  // 让整条查询失败（连 latestBossLevel 都读不到）。日常判定不需要 cp，去掉它。
  const q = `query($r:Address!){ stateQuery { raiderState(raiderAddress:$r){
    latestBossLevel remainChallengeCount purchaseCount totalChallengeCount level
    refillBlockIndex claimedBlockIndex avatarAddress avatarName
  } } }`;
  const d = await gqlRpc(q, { r: raiderAddress });
  return d.data?.stateQuery?.raiderState || null;
}
// 读取战斗得分 highScore 的【精确 64 位值】。
//
// 背景（2026-11-21 源码实测）：
//   · 链上 RaiderState.HighScore 是 long（64 位），S级得分 18,771,857,028 存得下。
//   · Heimdall 的 GraphQL `raiderState.highScore` 暴露成 Int（32 位），187亿会溢出——
//     而打到 wave4（67.7亿）同样溢出，故【绝不能】把"溢出"当作通关信号。
//   · Mimir 的 `worldBossRaider(avatarAddress).highScore` 暴露成 Long（64 位），可拿真值；
//     但其 resolver 可能未部署（当前实测报 MetadataRepository 未注册）。
//
// 因此按优先级取真值，取不到就明确返回 ok:false（由 judge 保守停手），绝不猜：
//   来源A：Mimir Long（精确）  → value=完整值
//   来源B：Heimdall Int（仅当数值在 32 位内可直接采信；若报错/溢出则不采信）
// 返回：{ ok:true, value:Number(>=0), source } 或 { ok:false, reason, overflow }
async function readHighScore(raiderAddress, avatarAddress = AVATAR) {
  const errs = [];

  // —— 来源A：Mimir 64 位 Long（首选，能精确区分 wave4 67亿 与 wave5 187亿）——
  for (let attempt = 0; attempt < 2; attempt++) {
    const q = "query($a:Address!){ worldBossRaider(avatarAddress:$a){ highScore } }";
    try {
      const d = await gql(CFG.mimir, q, { a: avatarAddress });
      if (!d.errors && d.data?.worldBossRaider?.highScore != null) {
        const v = Number(d.data.worldBossRaider.highScore);
        if (Number.isFinite(v) && v >= 0) return { ok: true, value: v, source: "mimir:Long" };
      }
      if (d.errors?.length) errs.push("mimir:" + String(d.errors[0].message).slice(0, 100));
    } catch (e) { errs.push("mimir:" + String(e.message).slice(0, 100)); }
    if (attempt === 0) await sleepMs(800);
  }

  // —— 来源B：Heimdall 32 位 Int（只在读到具体数值时采信；溢出/报错一律不采信）——
  const q2 = "query($r:Address!){ stateQuery { raiderState(raiderAddress:$r){ highScore } } }";
  for (const url of CFG.rpcUrls) {
    try {
      const d = await gql(url, q2, { r: raiderAddress });
      if (d.errors && d.errors.length) { errs.push("heimdall:" + String(d.errors[0].message).slice(0, 80)); continue; }
      const v = d.data?.stateQuery?.raiderState?.highScore;
      // Int32 能装下的值（wave1-3，<21.47亿）才是可信真值；S级/wave4 都会溢出到这里读不到。
      if (v != null && Number.isFinite(Number(v)) && Number(v) >= 0) {
        return { ok: true, value: Number(v), source: "heimdall:Int", caveat: "32位值，若实际已溢出则不可信" };
      }
    } catch (e) { errs.push("heimdall:" + String(e.message).slice(0, 80)); }
  }

  // 两条路都拿不到精确值——保守返回失败，绝不把"溢出"当通关。
  return { ok: false, reason: "无法读取精确64位得分（Mimir Long不可用 + Heimdall Int溢出/缺失）", overflow: true, errs };
}
async function getWorldBossState(bossAddress) {
  // 2026-11-22 修复：WorldBossStateType 无 totalDamage 字段，带上它会让整条查询失败 → null。
  const q = `query($b:Address!){ stateQuery { worldBossState(bossAddress:$b){
    id level currentHp startedBlockIndex endedBlockIndex
  } } }`;
  const d = await gqlRpc(q, { b: bossAddress });
  return d.data?.stateQuery?.worldBossState || null;
}
// 读取击杀等级奖励记录：[{ level, claimed }]。地址 = avatar.Derive(`reward_info_${raidId}`)。
async function getKillRewardRecord(raidId) {
  const killAddr = derive(AVATAR, `reward_info_${raidId}`);
  const q = "query($a:Address!){ stateQuery { worldBossKillRewardRecord(worldBossKillRewardRecordAddress:$a){ map { bossLevel claimed } } } }";
  const d = await gqlRpc(q, { a: killAddr });
  const map = d.data?.stateQuery?.worldBossKillRewardRecord?.map || [];
  return map.map(x => ({ level: Number(x.bossLevel), claimed: !!x.claimed }))
           .filter(x => Number.isFinite(x.level));
}
// 判断当前是否有「可领」的击杀等级奖励：
// Lib9c IsClaimable(boss.level) 要求存在 key < boss.level 且 claimed=false 的记录。
// 刚打完当级（只记录当级）时领不了，必须等 boss 再升一级——故领取天然滞后一级。
function claimableLevels(record, bossLevel) {
  const b = Number(bossLevel || 0);
  return record.filter(x => !x.claimed && x.level < b).map(x => x.level);
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
// 判断首场是否达到 S 级通关：战斗得分必须【精确 ≥】S_CLEAR_SCORE。
//
// 关键（2026-11-21 修复）：绝不再用"字段溢出"当通关信号——
//   wave4 累计 67.7亿、wave5 187亿都会让 32 位 Int 溢出，
//   若"溢出=通关"则"打穿wave4没打过wave5"会被误判通关并继续买票。
// 现在只认精确 64 位值；读不到（ok:false）一律判未通关 → 保守停手。
function judgeFirstBattleClear(hs) {
  if (!hs || hs.ok === false) {
    return { clear: false, reason: `无法取得精确得分，保守停手（${hs?.reason || "读取失败"}）`, hs };
  }
  if (hs.value == null || !Number.isFinite(Number(hs.value))) {
    return { clear: false, reason: "得分值缺失/非法，保守停手", hs };
  }
  const v = Number(hs.value);
  // 26亿～187亿这段若来自 Heimdall Int 是不可信的（其实已被溢出拦截，这里再兜一层）：
  // 只有 Mimir Long 或 <21.47亿 的 Heimdall Int 才会走到这里。
  const clear = v >= S_CLEAR_SCORE;
  return {
    clear,
    reason: clear
      ? `战斗得分 ${v} ≥ S级门槛 ${S_CLEAR_SCORE}，通关（来源 ${hs.source}）`
      : `战斗得分 ${v} < S级门槛 ${S_CLEAR_SCORE}，未通关（装备可能错误，来源 ${hs.source}）`,
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

// 2026-11-22 用户要求：既然本季已手动打过第一次（装备/时装/符文已被链上验证），
// 后续买票攻击【直接复用那笔 SUCCESS raid7 交易里的 c/e/r/f】，不再现场构造：
//   · 100% 与"身上的装备"一致，杜绝装备/气场/魔典/符文现场拼装出错；
//   · 每笔只改 p（是否 NCG 买票）与 id（16 随机字节），其余字节级沿用，链上校验必过。
// 从 Mimir 取本角色最近一笔 SUCCESS 的 raid7 原始交易做模板（与 sweep-boss 同款做法）。
const USE_SUCCESS_TEMPLATE = !args.includes("--no-success-template");
// 2026-11-22：用户本季免费票（2 张）自己打，自动化这边只负责 NCG 买票部分。
// --ncg-only 强制忽略剩余免费票，直接走 NCG 买票分支，避免与用户手动操作抢免费票/重复提交。
const NCG_ONLY = args.includes("--ncg-only");
async function resolveLoadoutFromMimir() {
  const q = `query($a:Address!){ transactions(filter:{avatarAddress:$a},take:60){
    items { blockIndex object { txStatus actions { typeId raw } } } } }`;
  const d = await gql(CFG.mimir, q, { a: AVATAR });
  if (d.errors?.length) throw new Error("Mimir 交易查询失败: " + d.errors[0].message.slice(0, 120));
  const items = d.data?.transactions?.items || [];
  for (const it of items) {
    if (it.object?.txStatus !== "SUCCESS") continue;
    const ac = (it.object?.actions || []).find(x => x.typeId === TYPE_ID && x.raw);
    if (!ac) continue;
    let action;
    try { action = decode(Buffer.from(ac.raw, "hex")); } catch (_) { continue; }
    if (!(action instanceof BencodexDictionary)) continue;
    const v = action.get("values");
    if (!(v instanceof BencodexDictionary)) continue;
    const mine = Buffer.from(Address.fromHex(AVATAR).toBytes());
    const a = v.get("a");
    if (!Buffer.isBuffer(a) || !a.equals(mine)) continue;   // 必须是本角色
    const e = [...v.get("e")], c = [...v.get("c")], r = [...v.get("r")];
    const f = v.get("f") != null ? [...v.get("f")] : [];
    if (e.length < 1 || c.length < 1 || r.length < 1) continue;
    log({ level: "info", msg: "装备模板=复用本角色最近一笔 SUCCESS raid7（身上装备，未现场构造）",
          block: Number(it.blockIndex), equipments: e.length, costumes: c.length, runeSlots: r.length });
    return { equipmentIds: e, costumeIds: c, runeSlotInfos: r.map(x => [Number(x[0]), Number(x[1])]), foodIds: f };
  }
  throw new Error("未找到本角色 SUCCESS raid7 交易作装备模板，拒绝用错装备浪费票");
}
// 气场 / 魔典在背包里没有 equipped 标记，按 itemId 取最高等级实例（用户 2026-11-21 确认）。
const AURA_ITEM_ID = 10670003;      // Barrage Aura (grade7, 用户已升到 Lv11)
const GRIMOIRE_ITEM_ID = 10780009; // SPD Gri(S) (grade8, Lv4) —— 用户明确选 grade8 这件
// 常规装备槽类型（equipped=true 的这 6 类 = 武器/甲/腰带/项链/戒指×2）。
const REGULAR_EQUIP_TYPES = new Set(["WEAPON", "ARMOR", "BELT", "NECKLACE", "RING"]);
// 装备来源（用户 2026-11-21 最终确认）：读【当前穿戴装备】= Heimdall avatar.inventory。
//   equipment = equipped=true 的常规装备(6) + 气场(id 10670003) + 魔典(id 10780009) = 8 件
//   costume   = equipped=true 的时装 (2 件)
//   符文 = decodeTemplate() 上赛季 SUCCESS 模板槽（冒险/Raid 符文不通用，绝不用实时冒险符文）。
// 绝不再用 Mimir itemSlot(RAID)：那是上赛季残留的 Surt 套装（用户实测"6件全错"）。
// 任一装备不全 / 读不到 → 保守停手，绝不拿旧基线兜底浪费票。
async function resolveLoadout() {
  const { runeSlotInfos } = decodeTemplate();
  const q = `query($a:Address!){ stateQuery{ avatar(avatarAddress:$a){ inventory{
    equipments{ itemId id level grade itemSubType equipped }
    costumes{ itemId id equipped }
  } } } }`;
  let inv = null, lastErr = null;
  for (const url of CFG.rpcUrls) {
    try {
      const d = await gql(url, q, { a: AVATAR });
      if (d.errors?.length) { lastErr = d.errors[0].message; continue; }
      inv = d.data?.stateQuery?.avatar?.inventory;
      if (inv) break;
    } catch (e) { lastErr = e.message; }
  }
  if (!inv) throw new Error(`avatar.inventory 读取失败，拒绝构造以免用错装备浪费票：${String(lastErr || "无数据").slice(0, 120)}`);

  const eqs = inv.equipments || [];
  const cos = inv.costumes || [];
  // 6 件常规装备：equipped=true 且类型为常规槽（排除 AURA/GRIMOIRE）
  const regular = eqs.filter(e => e.equipped && REGULAR_EQUIP_TYPES.has(e.itemSubType));
  const aura = eqs.filter(e => Number(e.id) === AURA_ITEM_ID).sort((a, b) => (b.level || 0) - (a.level || 0))[0] || null;
  const grimoire = eqs.filter(e => Number(e.id) === GRIMOIRE_ITEM_ID).sort((a, b) => (b.level || 0) - (a.level || 0))[0] || null;
  const costumes = cos.filter(c => c.equipped);

  // 完整性护栏：装备不全则停手（宁可不打，也不用错装备浪费票）
  const missing = [];
  if (regular.length !== 6) missing.push(`常规装备=${regular.length}(期望6)`);
  if (!aura) missing.push(`气场 id=${AURA_ITEM_ID} 缺失`);
  if (!grimoire) missing.push(`魔典 id=${GRIMOIRE_ITEM_ID} 缺失`);
  if (costumes.length !== 2) missing.push(`时装=${costumes.length}(期望2)`);
  if (missing.length) throw new Error(`当前穿戴装备不完整(${missing.join("; ")})，拒绝构造以免用错装备浪费票`);

  // UUID → .NET Guid 字节序（GraphQL itemId 为标准 UUID 字符串）
  const equipmentIds = [...regular, aura, grimoire].map(e => uuidToDotnet(e.itemId));
  const costumeIds = costumes.map(c => uuidToDotnet(c.itemId));
  // 仅记录与已确认基线的差异供观测，不拦截、不影响构造。
  const eqSet = equipmentIds.map(b => b.toString("hex"));
  const coSet = costumeIds.map(b => b.toString("hex"));
  const vsBaseline = {
    newEquip: eqSet.filter(x => !LOADOUT_BASELINE.equipments.includes(x)),
    missingEquip: LOADOUT_BASELINE.equipments.filter(x => !eqSet.includes(x)),
    newCostume: coSet.filter(x => !LOADOUT_BASELINE.costumes.includes(x)),
    missingCostume: LOADOUT_BASELINE.costumes.filter(x => !coSet.includes(x)),
  };
  log({ level: "info", msg: "loadout=当前穿戴装备(6常规equipped+气场10670003+魔典10780009)+2时装+上赛季模板符文",
        equipments: equipmentIds.length, costumes: costumeIds.length, runeSlots: runeSlotInfos.length,
        aura: { id: aura.id, level: aura.level }, grimoire: { id: grimoire.id, level: grimoire.level }, vsBaseline });
  return { equipmentIds, costumeIds, runeSlotInfos };
}
function buildRaidAction(loadout, payNcg) {
  const values = new BencodexDictionary([
    ["a", Buffer.from(Address.fromHex(AVATAR).toBytes())],
    ["c", loadout.costumeIds],
    ["e", loadout.equipmentIds],
    ["f", loadout.foodIds || []],
    ["id", randomBytes(16)],
    ["p", !!payNcg],
    // 2026-11-22 修复：Bencodex 不接受 JS number（浮点），而 Lib9c RuneSlotInfo 用
    // ToInteger() 读值——String（如 u5:0/u5:10047）与 Integer 都能读。原 SUCCESS 模板
    // 里 slot/runeId 是 String，故统一输出 String，做到与该模板字节级一致、链上校验必过。
    ["r", loadout.runeSlotInfos.map(([s, rid]) => [String(s), String(rid)])],
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
function decide({ raidId, row, raider, boss, tip, season = SEASON }) {
  if (raidId == null) return { ok: false, reason: "赛季空档期（raidId 读不到），跳过", code: "gap" };
  // season=0 → 自动跟随链上当前 raidId（不校验赛季号）；>0 → 仅打显式锁定的赛季。
  if (season > 0 && raidId !== season) return {
    ok: false, reason: `当前 raidId=${raidId} ≠ 锁定赛季 ${season}，跳过`, code: "season_mismatch", raidId };
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

  // 门票策略：默认免费票优先；--ncg-only 时忽略免费票只用 NCG（用户自己打免费票）
  const remain = Number(raider.remainChallengeCount || 0);
  const purchased = Number(raider.purchaseCount || 0);
  let payNcg, ticketMode;
  if (remain >= 1 && !NCG_ONLY) {
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
  log({ level: "info", msg: "WB 状态检查", ...out.status, target: SEASON > 0 ? SEASON : "follow:" + raidId, hit: d.ok, why: d.reason });
  if (!d.ok) { out.result = "skip:" + d.code; return; }

  // ── 死锁保护（2026-11-22 事故）──
  // raid7 结算要求 IsClaimable(boss.level)=存在 key<boss.level 且 claimed=false 的记录，
  // 否则抛 InvalidClaimException 让整笔战斗 FAILURE。正常流程 raid7 打完会留一条未领"引子"，
  // 链式往前推。若 rewardRecord 非空却没有任何可领引子（被引子被单独 claim 领光），
  // raid7 必 FAILURE——此时跳过提交，绝不每轮白送一笔失败交易浪费 gas。
  // 赛季初 record 为空走 else 分支（new 空 record）不抛异常，可正常打，故 record.length>0 才判。
  if (raidId != null) {
    const record = await getKillRewardRecord(raidId).catch(() => []);
    const claimable = claimableLevels(record, boss?.level);
    if (record.length > 0 && claimable.length === 0) {
      out.result = "skip:reward_deadlock（rewardRecord 全已领、无未领引子，raid7 必 FAILURE）——本赛季无法继续，等下赛季新地址；不提交避免浪费 gas";
      out.deadlock = { record: record.map(x => `${x.level}${x.claimed ? "✓" : "✗"}`).join(","), bossLevel: boss?.level, latestLevel: raider?.latestBossLevel };
      log({ level: "warn", msg: "击杀奖励死锁，跳过提交", ...out.deadlock });
      return;
    }
  }

  // 装备来源（2026-11-22 用户确认）：本季已手动打过第一次，直接复用那笔 SUCCESS raid7
  // 的 c/e/r/f（= 身上的装备），不再现场构造；仅当 Mimir 模板不可用才回退现场构造。
  const isFirstBattle = isFirstBattleOfSeason(raider.latestBossLevel);
  let loadout, buildMode;
  if (USE_SUCCESS_TEMPLATE) {
    try {
      loadout = await resolveLoadoutFromMimir();
      buildMode = "reuse-last-success-raid7";
    } catch (e) {
      log({ level: "warn", msg: "SUCCESS 模板不可用，回退现场构造（当前穿戴装备）", detail: e.message });
    }
  }
  if (!loadout) { loadout = await resolveLoadout(); buildMode = "live-equip+tmpl-rune"; }
  const actionValue = buildRaidAction(loadout, d.payNcg);
  out.action = { typeId: TYPE_ID, payNcg: d.payNcg, ticketMode: d.ticketMode, build: buildMode,
                 isFirstBattle };
  log({ level: "info", msg: "构造 raid7 action 完成", payNcg: d.payNcg, ticketMode: d.ticketMode,
        isFirstBattle });

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
    // 首战成功后链上状态可能尚未同步，轮询到"拿到精确值"为止；始终读不到就保守停手。
    for (let attempt = 0; attempt < CFG.confirmTries; attempt++) {
      const hs = await readHighScore(raiderAddr, AVATAR);
      judged = judgeFirstBattleClear(hs);
      if (hs.ok) break; // 拿到精确值即可判定；ok:false 则继续等节点同步，仍失败就停手
      await sleepMs(CFG.confirmIntervalMs);
    }
    out.firstBattleClear = judged;
    log({ level: "info", msg: "首战S级通关校验", ...judged });
    if (!judged.clear) {
      out.result = `首战未达S级通关或无法确认，停手不继续（${judged.reason}）——绝不误判通关`;
      return;
    }
  }

  out.result = "战斗提交成功（SUCCESS）";
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
    log({ level: "info", msg: "进入 WB 蹲守（进程内轮询，按 boss 等级判定）", season: SEASON > 0 ? SEASON : "follow", gapMs: GAP_MS, budgetSec: Math.round(MAX_WATCH_MS / 1000) });
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
  // 默认跟随（season=0）：任意 raidId 都不因赛季号被跳过；下赛季无需改代码即可续打。
  ok("跟随模式-任意赛季都打", decide({ ...base, raidId: 36, season: 0, row, raider: raider(), boss: boss({ level: 6 }) }).ok === true);
  ok("跟随模式-38赛季也打", decide({ ...base, raidId: 38, season: 0, row, raider: raider(), boss: boss({ level: 6 }) }).ok === true);
  // 显式锁定（season>0）：非目标赛季跳过。
  ok("锁定赛季-不符跳过", decide({ ...base, raidId: 36, season: 37, row, raider: raider(), boss: boss() }).code === "season_mismatch");
  ok("锁定赛季-相符放行", decide({ ...base, raidId: 37, season: 37, row, raider: raider(), boss: boss({ level: 6 }) }).ok === true);
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
  // 当前穿戴气场/魔典/时装的 UUID→.NET 字节序转换正确（装备/时装/气场/魔典同一转换函数）。
  // 这些 GUID 是 2026-11-21 从 avatar.inventory 实测（用户逐件确认）的当前穿戴值。
  ok("当前气场BarrageAura UUID→.NET序", uuidToDotnet("6d82ff15-4410-4358-9d02-a19bbf2a66fc").toString("hex") === "15ff826d104458439d02a19bbf2a66fc");
  ok("当前魔典SPDGriS UUID→.NET序", uuidToDotnet("6760cc78-7f9f-491b-9927-32ed5b090eb7").toString("hex") === "78cc60679f7f1b49992732ed5b090eb7");
  ok("当前时装Title UUID→.NET序", uuidToDotnet("47cbbd3d-e488-4aea-a7a8-bfc396c12cb9").toString("hex") === "3dbdcb4788e4ea4aa7a8bfc396c12cb9");
  ok("气场itemId常量=10670003", AURA_ITEM_ID === 10670003);
  ok("魔典itemId常量=10780009", GRIMOIRE_ITEM_ID === 10780009);

  // 模板字段完整性
  const t = decodeTemplate();
  ok("模板符文槽=8", t.runeSlotInfos.length === 8);
  ok("符文槽格式[slot,rune]", t.runeSlotInfos.every(x => x.length === 2 && Number.isInteger(x[0]) && Number.isInteger(x[1])));

  // 旧基线参照数据（不用于拦截；仅校验数据完整+符文模板未被改动）
  ok("基线装备8件(参照)", LOADOUT_BASELINE.equipments.length === 8);
  ok("基线时装2件(参照)", LOADOUT_BASELINE.costumes.length === 2);
  ok("装备基线均为32位hex", LOADOUT_BASELINE.equipments.every(x => /^[0-9a-f]{32}$/.test(x)));
  const sameSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
  ok("集合比较-顺序无关", sameSet(["a","b"], ["b","a"]) === true);
  ok("集合比较-新增检测", sameSet(["a","b","c"], ["a","b"]) === false);
  ok("基线符文=模板符文", sameSet(
    LOADOUT_BASELINE.runeSlots.map(x => x.join(":")),
    t.runeSlotInfos.map(x => x.join(":"))));

  // 首战判定（latestBossLevel===0 才做首战 S 级实战裁决；装备始终用实时装备）
  ok("首战判定 0=是", isFirstBattleOfSeason(0) === true);
  ok("首战判定 null=是", isFirstBattleOfSeason(null) === true);
  ok("首战判定 undefined=是", isFirstBattleOfSeason(undefined) === true);
  ok("首战判定 1=否(已打过)", isFirstBattleOfSeason(1) === false);
  ok("首战判定 300=否", isFirstBattleOfSeason(300) === false);
  ok("首战判定 字符串0=是", isFirstBattleOfSeason("0") === true);

  // S级通关判定（精确比较，绝不用溢出当通关）
  ok("S级门槛=全5波HP和", S_CLEAR_SCORE === 18771857028);
  ok("门槛=逐波HP累加", [21857028,250000000,1500000000,5000000000,12000000000].reduce((a,b)=>a+b,0) === S_CLEAR_SCORE);
  ok("通关-得分恰好达标", judgeFirstBattleClear({ ok:true, value:S_CLEAR_SCORE, source:"mimir:Long" }).clear === true);
  ok("通关-得分超过", judgeFirstBattleClear({ ok:true, value:S_CLEAR_SCORE+1, source:"mimir:Long" }).clear === true);
  ok("未通关-得分不足", judgeFirstBattleClear({ ok:true, value:1000000, source:"heimdall:Int" }).clear === false);
  ok("未通关-得分0", judgeFirstBattleClear({ ok:true, value:0, source:"heimdall:Int" }).clear === false);
  // 关键回归：wave4 累计 67.7亿 < S门槛 —— 即便它已让32位Int溢出，也绝不判通关
  ok("wave4累计67.7亿未通关", judgeFirstBattleClear({ ok:true, value:6771857028, source:"mimir:Long" }).clear === false);
  ok("wave3累计17.7亿未通关", judgeFirstBattleClear({ ok:true, value:1771857028, source:"heimdall:Int" }).clear === false);
  ok("S门槛-1未通关", judgeFirstBattleClear({ ok:true, value:S_CLEAR_SCORE-1, source:"mimir:Long" }).clear === false);
  // 读不到精确值 → 保守停手
  ok("溢出读取失败=未通关", judgeFirstBattleClear({ ok:false, reason:"Int溢出", overflow:true }).clear === false);
  ok("值缺失=未通关", judgeFirstBattleClear({ ok:true, value:null }).clear === false);
  ok("读取失败=未通关", judgeFirstBattleClear({ ok:false, reason:"err" }).clear === false);

  // 2026-11-22 事故后铁律：脚本内不得再有任何 claim action 构造函数/开关。
  // 若未来有人重新引入自动领取，这两条静态断言会立刻失败，防止死锁重演。
  const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  // 用拼接构造被检索词，避免断言字符串本身被当成"残留"自我匹配。
  const forbidden = ["build" + "ClaimAction", "AUTO" + "_CLAIM", "claim_" + "world_boss_kill_reward"];
  ok("无自动领取函数/开关残留", forbidden.every(w => !src.includes(w)));
  ok("TYPE_ID 常量就是 raid7", TYPE_ID === "raid7");
  ok("默认跟随赛季 SEASON=0", SEASON === 0);
  // 死锁检测仍依赖 IsClaimable 逻辑：只认 level < boss.level 的未领记录当"引子"。
  const rec = [{level:195,claimed:false},{level:197,claimed:false},{level:198,claimed:true}];
  ok("claimable 只取低于boss的未领", JSON.stringify(claimableLevels(rec,198)) === JSON.stringify([195,197]));
  ok("claimable boss=195时无引子(195<195不成立)", claimableLevels([{level:195,claimed:false}],195).length === 0);
  ok("claimable 已领的不算引子", claimableLevels([{level:190,claimed:true}],198).length === 0);
  ok("claimable 空记录返回空", claimableLevels([],198).length === 0);

  console.log(JSON.stringify({ selfTest: { pass, fail, ok: fail === 0 } }));
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.log(JSON.stringify({ ts: new Date().toISOString(), level: "error", fatal: e.message })); process.exit(1); });
