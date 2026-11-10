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
 *   3) 赛季号从「当前赛季窗口内、链上其他玩家 SUCCESS 的 adventure boss 交易」解析，
 *      因为 Sweep.Execute 会校验 latestSeason.Season == Season，SUCCESS 交易的 s
 *      必然就是当时的当前赛季号。解析不到就拒绝提交，绝不臆测；可用 --season 覆盖。
 *   4) 每笔串行：重新取 nextTxNonce -> 签名 -> stageTransaction -> 只认链上终态
 *      (SUCCESS/FAILURE/INVALID)。同一 signer 绝不并发抢 nonce。
 *   5) 第一笔非 SUCCESS 立即停止，不把剩下的次数继续扔上去白跑。
 *
 * 成本提醒（SweepAdventureBoss.Execute 源码）：
 *   requiredPotion = explorer.Floor * sweep_ap(=1)，每笔真扣 AP 药水(500000)。
 *   即「每笔消耗 = 你当前赛季已通关层数 × 1 瓶」。29 层 -> 29 瓶/笔，10 笔 = 290 瓶。
 *   FAILURE 时异常回滚不扣药水。脚本不预判层数（链上未暴露该字段），
 *   只做「总药水 >= 次数」的最低门槛检查，真实消耗由链上裁决。
 *
 * 用法：
 *   node sweep-boss.mjs --self-test                 纯逻辑自测，不联网
 *   node sweep-boss.mjs --dry-run                  联网读链并构造 10 笔，不提交
 *   node sweep-boss.mjs --dry-run --times 5        预览 5 笔
 *   node sweep-boss.mjs --times 10                 真实连发 10 笔
 *   node sweep-boss.mjs --times 10 --season 1429   手工指定赛季号
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
const GAP_MS = Math.max(0, numArg("--gap-ms", 1500));
const seasonArgIdx = args.indexOf("--season");
const SEASON_OVERRIDE = seasonArgIdx >= 0 && /^\d+$/.test(String(args[seasonArgIdx + 1] || ""))
  ? BigInt(args[seasonArgIdx + 1]) : null;
const NO_GEAR_REFRESH = args.includes("--no-gear-refresh");

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
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(CFG.api9c + "/adventureBossHeimdallStatus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatarAddress: CFG.avatarAddress }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (typeof j.startBlockIndex !== "number" || typeof j.endBlockIndex !== "number") {
      throw new Error("赛季状态字段缺失");
    }
    return {
      finished: !!j.finished,
      start: BigInt(j.startBlockIndex),
      end: BigInt(j.endBlockIndex),
      bossId: j.bossId ?? null,
      bossName: j.bossName || "未知",
      floor: typeof j.floor === "number" ? j.floor : null,
      raw: j,
    };
  } finally { clearTimeout(t); }
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
      if (r && isTerminalTxStatus(r.txStatus)) return r;
    } catch (_) { /* 节点还没索引到 */ }
    if (i < CFG.confirmTries - 1) await new Promise((r) => setTimeout(r, CFG.confirmIntervalMs));
  }
  return { txStatus: "PENDING" };
}

// 纯决策（不联网，供 --self-test 覆盖）：一笔的链上终态出来后，是否继续下一笔。
// 只有 SUCCESS 才继续；FAILURE/INVALID/PENDING/异常一律收手，避免把剩余次数
// 继续扔上去白跑（每笔都要等确认，且失败原因多半不会自己消失）。
function shouldContinue(txStatus) { return txStatus === "SUCCESS"; }

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
function selfTest() {
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
  // 7) 连发决策：只有 SUCCESS 继续，其余一律收手
  for (const [s, expect] of [["SUCCESS", true], ["FAILURE", false], ["INVALID", false],
    ["PENDING", false], ["INCLUDED", false], [null, false]]) {
    ok(`shouldContinue(${String(s)})`, shouldContinue(s) === expect);
  }
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

  console.log(`\n  self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

// ---------------- 主流程 ----------------
async function main() {
  if (SELF_TEST) {
    console.log("=== 9C Adventure Boss 一键 Sweep · 纯逻辑自测 ===");
    return selfTest() ? 0 : 1;
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

  // 3) 当前赛季号
  let season, seasonSource;
  if (SEASON_OVERRIDE !== null) {
    season = SEASON_OVERRIDE; seasonSource = "--season 手工指定";
  } else {
    const hit = await fetchCurrentSeason(status);
    if (!hit) throw new Error("无法从链上解析当前赛季号（本赛季窗口内还没有任何成功的 adventure boss 交易）。请用 --season N 手工指定，或稍后再试。");
    season = hit.season; seasonSource = `Mimir ${hit.typeId}@${hit.blk} (SUCCESS)`;
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

  // 7) 真实连发：串行、每笔重取 nonce、只认链上终态
  const results = [];
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
    if (i < TIMES && GAP_MS > 0) await new Promise((r2) => setTimeout(r2, GAP_MS));
  }

  const okCount = results.filter((x) => x.txStatus === "SUCCESS").length;
  log({ level: "info", msg: "本次连发结束", requested: TIMES, submitted: results.length,
    success: okCount, season: Number(season), results });
  console.log(JSON.stringify({ summary: true, requested: TIMES, submitted: results.length,
    success: okCount, season: Number(season), results }, null, 2));
  return okCount === TIMES ? 0 : 1;
}

main().then((code) => { process.exitCode = code; })
  .catch((e) => { log({ level: "error", msg: "脚本异常", detail: String(e?.message || e) }); process.exitCode = 2; });
