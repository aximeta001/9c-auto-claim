#!/usr/bin/env node
/**
 * 9C Adventure Boss —— 自动爬楼 / 挑战（explore + unlock，全程 Golden Dust 门票）
 * ============================================================================
 * 只做一件事：反复提交 `explore_adventure_boss`，把本季个人通关层数爬到目标层数；
 * 需要解锁下一批楼层时提交 `unlock_floor`，且**门票一律用 Golden Dust（u=false），
 * 绝不用 NCG**。除此之外什么都不做：
 *   · 不做 sweep / 不领奖 / 不定时 / 不常驻 / 不自接力
 *   · 纯手动触发：你下指令才跑，跑到目标层数或预算用尽就退出
 *
 * 为什么这样设计（Lib9c 源码 + 链上真实交易双重确认）：
 *   · ExploreAdventureBoss.Execute：从 explorer.Floor+1 一路模拟到 explorer.MaxFloor，
 *     打得过就 `explorer.Floor = fl`，打不过就停在上一层（但这笔交易仍是 SUCCESS！）。
 *     所以「交易 SUCCESS」≠「通关到目标层」，必须重新读链上个人 floor 判定。
 *   · 由于每笔的随机种子不同，同一层「这次打不过、下次可能过」，因此脚本按
 *     「提交 explore -> 等链上终态 -> 重读 floor -> 没到目标就再来一笔」循环，
 *     直到 floor >= 目标层数（正是你说的 hella 25 层要试两三次、28 层要多试几次）。
 *   · UnlockFloor.Execute：u=false -> 用 GoldenDust(itemId 600201)；u=true -> 用 NCG。
 *     每次 MaxFloor += 5（OpeningFloor=5），上限 TotalFloor=30。
 *     前提 explorer.Floor == explorer.MaxFloor（当前解锁的层全通关才能解锁下一批）。
 *     门票点 6/11/16/21/26 层 = 爬到 5/10/15/20/25 层后各解锁一次。
 *
 * 目标层数：
 *   · 默认按 BOSS 决定：Surtr(211000)=29，其它三个(Laufey/Jormungandr/Hella)=28。
 *     依据你的实测：surtr 能到 29，hella 保底 28，其余一般 28 没问题。
 *   · --floor N 可整体覆盖；--surtr-floor N 单独改 Surtr 目标（默认 29）。
 *
 * 权威数据源（只认链上）：
 *   · 个人 floor/maxFloor/bossId/赛季窗口：Heimdall6
 *       stateQuery.adventureBossSeasonStatus(avatarAddress)
 *     —— 这是节点上的个人 Explorer 状态，不是 9CAPI 的展示值，也不依赖交易索引。
 *   · 赛季号：链上 LatestSeason state（SeasonInfo）为权威，Mimir SUCCESS 交易交叉校验。
 *   · 交易终态：跨全部 RPC 节点查，只认 SUCCESS/FAILURE/INVALID；伪 INVALID 不算。
 *
 * 门票支付铁律：unlock_floor 的 u 字段被 buildUnlockAction 强制写 false（Golden Dust），
 * 即使模板来自一笔曾用 NCG 的历史交易也会被改正；日志会醒目标注。绝不花 NCG。
 *
 * 用法：
 *   node explore-boss.mjs --self-test                     纯逻辑自测，不联网
 *   node explore-boss.mjs --dry-run                       联网读链并预览，不提交
 *   node explore-boss.mjs --dry-run --floor 28            预览（指定目标 28 层）
 *   node explore-boss.mjs --floor 28                      实际爬楼到 28 层（Surtr 自动 29）
 *   node explore-boss.mjs --floor 29 --max-attempts 20    指定 29 层、最多 20 笔
 *   node explore-boss.mjs --floor 28 --season 1445        手工指定赛季号
 *   node explore-boss.mjs --floor 28 --no-unlock          禁止解锁（只爬已解锁的层）
 *
 * 参数：
 *   --floor N             目标层数（覆盖按 BOSS 的自动值）
 *   --surtr-floor N       Surtr 目标层数，默认 29
 *   --max-attempts N      最多提交多少笔 explore（防无限重试），默认 15
 *   --gap-ms N            两笔之间的间隔，默认 3000
 *   --final-tries N       单笔终态轮询轮数，默认 12
 *   --final-interval-ms N 单笔终态轮询间隔，默认 3000
 *   --season N            手工指定赛季号
 *   --no-unlock           禁止提交 unlock_floor（门票相关），只爬当前已解锁层
 *   --dry-run / --self-test / --json
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
  // 个人赛季状态只在 heimdall6 上暴露（adventureBossSeasonStatus）
  statusUrl: "https://heimdall6.9capi.com/graphql",
  mimir: "https://mimir.nine-chronicles.dev/heimdall/graphql/",
  api9c: "https://api.9capi.com",
  confirmTries: 12,
  confirmIntervalMs: 3000,
};

const TYPE_EXPLORE = "explore_adventure_boss";
const TYPE_UNLOCK = "unlock_floor";
const AP_STONE_ID = 500000;
const GOLDEN_DUST_ID = 600201;
const TOTAL_FLOOR = 30;          // Lib9c UnlockFloor.TotalFloor
const OPENING_FLOOR = 5;         // Lib9c UnlockFloor.OpeningFloor（每次 +5）
const BOSS_SURTR = 211000;

// 赛季号来源白名单（同 sweep：只取严格校验 Season == 当前赛季的 SUCCESS 交易）
const AB_TYPES = new Set(["sweep_adventure_boss", "explore_adventure_boss", "unlock_floor"]);
const ADVENTURE_BOSS_ACCOUNT = "0x0000000000000000000000000000000000000100";
const LATEST_SEASON_KEY = "0x0000000000000000000000000000000000000000";
const INVENTORY_ACCOUNT = "0x000000000000000000000000000000000000001c";

// 兜底模板：本角色真实 SUCCESS 交易原始 action（season 会被覆盖成当前赛季）
// explore @ blk 11844176 season=1445；unlock @ blk 11844174 season=1445 u=false(GoldenDust)
const FALLBACK_EXPLORE_RAW =
  "6475373a747970655f69647532323a6578706c6f72655f616476656e747572655f626f737375363a76616c756573647531333a6176617461724164647265737332303aac9d450c69df27ee290c90ec61c4b76154b0a21c75383a636f7374756d65736c31363a3c07374778009e42bfa10a16854b5b3431363a6619635e7b72d3479fda8675f64a366e657531303a65717569706d656e74736c31363a5b14eb0589978444bde7de19f329b8a931363a84afc54e6d44d840948afc3089a2479931363acf5f2258713bc94e943078cfa84e8cbc31363a78cc60679f7f1b49992732ed5b090eb731363a15ff826d104458439d02a19bbf2a66fc31363a2a9b1888b279d449a8864952c340571431363aa44d5b8d516e95418c834092994f833631363aeba24ec67f4e5c44acf718c40594835b6575353a666f6f64736c6575323a696431363a2ee6e3fa68d1e84d844ab04d0732095675313a726c6c75313a3075353a3130303536656c75313a3175353a3130303437656c75313a3375353a3130303531656c75313a3475353a3130303433656c75313a3675353a3330303031656c75313a3775353a3130303231656c75313a3875353a3130303532656c75313a3975353a3130303535656575363a736561736f6e6931343435656565";
const FALLBACK_UNLOCK_RAW =
  "6475373a747970655f69647531323a756e6c6f636b5f666c6f6f7275363a76616c7565736475313a6132303aac9d450c69df27ee290c90ec61c4b76154b0a21c75323a696431363ad3713db778ae3846b6d79509af17210175313a7369313434356575313a75666565";

// ---------------- 参数 ----------------
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const SELF_TEST = args.includes("--self-test");
const JSON_OUT = args.includes("--json");
const NO_UNLOCK = args.includes("--no-unlock");
const numArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : def;
};
const FLOOR_OVERRIDE = args.includes("--floor") && Number.isFinite(Number(args[args.indexOf("--floor") + 1]))
  ? Math.trunc(Number(args[args.indexOf("--floor") + 1])) : null;
const SURTR_FLOOR = Math.max(1, Math.min(TOTAL_FLOOR, Math.trunc(numArg("--surtr-floor", 29))));
const MAX_ATTEMPTS = Math.max(1, Math.min(60, Math.trunc(numArg("--max-attempts", 15))));
const GAP_MS = Math.max(0, numArg("--gap-ms", 3000));
const FINAL_TRIES = Math.max(1, Math.min(60, Math.trunc(numArg("--final-tries", CFG.confirmTries))));
const FINAL_INTERVAL_MS = Math.max(200, numArg("--final-interval-ms", CFG.confirmIntervalMs));
const seasonArgIdx = args.indexOf("--season");
const SEASON_OVERRIDE = seasonArgIdx >= 0 && /^\d+$/.test(String(args[seasonArgIdx + 1] || ""))
  ? BigInt(args[seasonArgIdx + 1]) : null;

function log(obj) {
  if (JSON_OUT) { console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj })); return; }
  const { ts, ...rest } = obj;
  const tag = rest.level ? `[${rest.level.toUpperCase()}] ` : "";
  const msg = rest.msg ? rest.msg + " " : "";
  const extra = Object.entries(rest).filter(([k]) => k !== "level" && k !== "msg")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ");
  console.log(`${tag}${msg}${extra}`);
}

// ---------------- 网络 ----------------
async function gql(url, query, variables = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "9c-boss-explore/1.0" },
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 链上读取 ----------------
async function getTip() {
  const d = await gqlRpc("{ nodeStatus { tip { index } } }");
  return BigInt(d.data.nodeStatus.tip.index);
}

// 个人 Explorer 赛季状态。
// 个人赛季状态：heimdall6 的 adventureBossSeasonStatus 是唯一暴露真实 floor/maxFloor
// 的权威字段。2026-11-24 曾因该节点临时卡在旧块而改用「Mimir 交易笔数推算 floor」，
// 但 explore 推进受 CP 限制、交易 raw 里也没有 floor 字段，推算会把 floor 虚报成 maxFloor，
// 导致误判达标、虚报爬到 30 层（实际只到 27）——已废弃该推算。
// 现状：以真实字段为准，并用最新节点的 LatestSeason 赛季元数据做一致性校验；
// 节点若落后/不一致，直接抛错停止，绝不拿推算值去提交交易。
async function getMySeasonStatus() {
  const q = `query($a:Address!){ stateQuery { adventureBossSeasonStatus(avatarAddress:$a){
    floor maxFloor bossId name finished startBlockIndex endBlockIndex
    usedApPotion usedGoldenDust usedNcg } } }`;
  const d = await gql(CFG.statusUrl, q, { a: CFG.avatarAddress });
  if (d.errors || !d.data?.stateQuery?.adventureBossSeasonStatus) {
    throw new Error("读取 adventureBossSeasonStatus 失败: " + (d.errors?.[0]?.message || "空结果"));
  }
  const s = d.data.stateQuery.adventureBossSeasonStatus;
  const st = {
    floor: Number(s.floor), maxFloor: Number(s.maxFloor), bossId: Number(s.bossId),
    bossName: s.name, finished: !!s.finished,
    start: BigInt(s.startBlockIndex), end: BigInt(s.endBlockIndex),
    usedApPotion: Number(s.usedApPotion), usedGoldenDust: Number(s.usedGoldenDust),
    usedNcg: Number(s.usedNcg),
  };

  // 一致性校验：heimdall6 的赛季窗口必须和最新节点 LatestSeason 一致；
  // 若节点落后（返回旧赛季），宁可停止也不提交——避免用错赛季/虚报状态。
  try {
    const ls = await fetchSeasonFromChainState();   // 最新节点 chain raw state
    if (ls) {
      const chainStart = BigInt(ls.start), chainEnd = BigInt(ls.end);
      if (chainStart !== st.start || chainEnd !== st.end || Number(ls.bossId) !== st.bossId) {
        throw new Error(
          `heimdall6 个人状态落后于链上：字段窗口=[${st.start},${st.end}] boss=${st.bossId}，` +
          `链上窗口=[${chainStart},${chainEnd}] boss=${ls.bossId}。等待节点同步后再运行，拒绝用陈旧状态提交。`
        );
      }
    }
  } catch (e) {
    // 校验失败（含落后检测抛出的错）一律向上抛，不能吞掉
    throw e;
  }
  return st;
}

// 从 action raw 解赛季号：sweep/unlock 用 `s`，explore 用 `season`
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
  } catch (_) { /* 忽略 */ }
  return null;
}

// 链上 LatestSeason state 权威赛季号
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
// 交易解析赛季号兜底（本角色 SUCCESS 的 AB 交易）
async function fetchSeasonFromMyTxs(take = 160) {
  const q = `query($a:Address!){ transactions(filter:{avatarAddress:$a},take:${take}){
    items { blockIndex object { txStatus actions { typeId raw } } } } }`;
  const d = await gql(CFG.mimir, q, { a: CFG.avatarAddress });
  const found = [];
  for (const it of d.data?.transactions?.items || []) {
    if (it.object?.txStatus !== "SUCCESS") continue;
    for (const ac of it.object?.actions || []) {
      if (!AB_TYPES.has(ac.typeId) || !ac.raw) continue;
      const s = readSeasonFromRaw(ac.raw);
      if (s !== null) found.push({ season: s, blk: Number(it.blockIndex), typeId: ac.typeId });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => (a.blk === b.blk ? 0 : a.blk > b.blk ? 1 : -1));
  return found[found.length - 1];
}

// 本角色最近一笔 SUCCESS 的指定类型交易（做模板，自动跟随装备/符文）
async function fetchMineLatestSuccess(typeId, take = 160) {
  const q = `query($a:Address!){ transactions(filter:{avatarAddress:$a},take:${take}){
    items { blockIndex object { txStatus actions { typeId raw } } } } }`;
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

// ---------------- 交易构造 ----------------
// 通用：复用模板字节，只强制改写 id（每笔随机）与赛季号字段；其余一字不改。
// seasonKey: 'season'(explore) 或 's'(unlock)。extra: 额外强制覆盖的字段（如 unlock 的 u=false）。
function buildAction(rawHex, typeId, season, seasonKey, extra = {}) {
  const action = decode(Buffer.from(rawHex, "hex"));
  if (!(action instanceof BencodexDictionary) || String(action.get("type_id")) !== typeId) {
    throw new Error(`模板 type_id 校验失败（期望 ${typeId}）`);
  }
  const values = action.get("values");
  if (!(values instanceof BencodexDictionary)) throw new Error("模板 values 结构校验失败");

  // 归属校验：模板里的角色地址必须就是本角色
  const mine = Buffer.from(Address.fromHex(CFG.avatarAddress).toBytes());
  const av = values.get("avatarAddress") ?? values.get("a");
  if (!av || !Buffer.isBuffer(av) || !av.equals(mine)) {
    throw new Error("模板 avatarAddress 与本角色不符");
  }

  const entries = [];
  let hasId = false, hasSeason = false;
  const seenExtra = new Set();
  for (const k of values.keys()) {
    const key = String(k);
    if (key === "id") { entries.push([k, randomBytes(16)]); hasId = true; continue; }
    if (key === seasonKey) { entries.push([k, BigInt(season)]); hasSeason = true; continue; }
    if (Object.prototype.hasOwnProperty.call(extra, key)) {
      entries.push([k, extra[key]]); seenExtra.add(key); continue;
    }
    entries.push([k, values.get(k)]);
  }
  // extra 里若模板没有该字段也补上（防止漏字段）
  for (const [k, v] of Object.entries(extra)) {
    if (!seenExtra.has(k)) entries.push([k, v]);
  }
  if (!hasId || !hasSeason) throw new Error(`模板缺少 id 或 ${seasonKey} 字段`);
  return new BencodexDictionary([
    ["type_id", action.get("type_id")],
    ["values", new BencodexDictionary(entries)],
  ]);
}

// explore：改 id + season；装备/符文/foods 全部沿用模板
function buildExploreAction(rawHex, season) {
  return buildAction(rawHex, TYPE_EXPLORE, season, "season");
}
// unlock：改 id + s，且**强制 u=false（Golden Dust）**，绝不用 NCG
function buildUnlockAction(rawHex, season) {
  return buildAction(rawHex, TYPE_UNLOCK, season, "s", { u: false });
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

// ---------------- 终态判定（只认链上）----------------
function isTerminalTxStatus(s) { return s === "SUCCESS" || s === "FAILURE" || s === "INVALID"; }
function isPhantomInvalid(r) {
  if (!r || r.txStatus !== "INVALID") return false;
  if (r.blockIndex !== null && r.blockIndex !== undefined) return false;
  return (r.exceptionNames || []).filter(Boolean).length === 0;
}
const RESULT_Q = "query($t:TxId!){ transaction { transactionResult(txId:$t){ txStatus blockIndex exceptionNames } } }";
async function queryResultAcrossNodes(txId) {
  const rs = await Promise.all(CFG.rpcUrls.map(async (url) => {
    try {
      const d = await gql(url, RESULT_Q, { t: txId }, 20000);
      const r = d.data?.transaction?.transactionResult;
      return (r && !d.errors) ? r : null;
    } catch (_) { return null; }
  }));
  const results = rs.filter(Boolean);
  const decisive = results.filter((r) => isTerminalTxStatus(r.txStatus) && !isPhantomInvalid(r));
  if (decisive.length) return decisive.find((r) => r.txStatus === "SUCCESS") || decisive[0];
  return null;
}
// 等一笔到终态并确定 SUCCESS；返回 {ok, result}
async function confirmOne(txId, tries, intervalMs) {
  for (let i = 0; i < tries; i++) {
    const r = await queryResultAcrossNodes(txId);
    if (r) return { ok: r.txStatus === "SUCCESS", result: r };
    if (i < tries - 1) await sleep(intervalMs);
  }
  return { ok: false, result: { txStatus: "PENDING" } };
}

// ---------------- 纯决策（供自测）----------------
function computeTargetFloor(bossId, override, surtrFloor) {
  if (override !== null && override > 0) return Math.min(TOTAL_FLOOR, override);
  return bossId === BOSS_SURTR ? surtrFloor : 28;
}
// 根据当前状态决定下一步：done / unlock / explore / error
function planNext(status, target) {
  if (status.finished) return { action: "error", reason: "赛季已结束" };
  if (status.floor >= target) return { action: "done" };
  if (status.floor >= status.maxFloor) {
    if (status.maxFloor >= TOTAL_FLOOR) return { action: "error", reason: "已到 30 层上限仍未达标" };
    return { action: "unlock" };
  }
  return { action: "explore" };
}
function explainFailure(r) {
  const names = (r.exceptionNames || []).filter(Boolean).join(",");
  if (/NotEnoughMaterial/i.test(names)) return "材料不足：AP 药水或 Golden Dust 不够";
  if (/InvalidAdventureBossSeason|InvalidSeason/i.test(names)) return "赛季号不匹配/赛季已结束";
  if (/ReachedToLockedFloor|Unlock floor first/i.test(names)) return "需先解锁楼层（floor==maxFloor）";
  if (/You have to clear floor/i.test(names)) return "当前最高层还没通关，不能解锁下一批";
  if (/NotEnoughGoldenDust|NotEnoughMaterial/i.test(names)) return "Golden Dust 不足，无法解锁";
  if (/ValidateEquipments|ValidateCostume|ItemRequirement|FailedLoadState/i.test(names)) return "装备/符文校验失败，请先在游戏里手工挑战一次刷新模板";
  return names || "链上判定失败（无异常名）";
}

// ---------------- 自测（纯逻辑，不联网）----------------
async function selfTest() {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };

  // 模板基本结构
  const ex = decode(Buffer.from(FALLBACK_EXPLORE_RAW, "hex"));
  const exv = ex.get("values");
  ok("explore 模板 type_id", String(ex.get("type_id")) === TYPE_EXPLORE);
  ok("explore 模板字段集合", JSON.stringify([...exv.keys()].map(String).sort()) ===
    JSON.stringify(["avatarAddress", "costumes", "equipments", "foods", "id", "r", "season"]));
  ok("explore season 是 Integer", typeof exv.get("season") === "bigint");
  ok("explore id 是 16B", Buffer.isBuffer(exv.get("id")) && exv.get("id").length === 16);
  ok("explore 无楼层/门票字段", !exv.keys().some((k) => /floor|ncg|dust|ticket/i.test(String(k))));

  const un = decode(Buffer.from(FALLBACK_UNLOCK_RAW, "hex"));
  const unv = un.get("values");
  ok("unlock 模板 type_id", String(un.get("type_id")) === TYPE_UNLOCK);
  ok("unlock 模板字段集合 = a,id,s,u", JSON.stringify([...unv.keys()].map(String).sort()) ===
    JSON.stringify(["a", "id", "s", "u"]));
  ok("unlock 模板 u=false(GoldenDust)", unv.get("u") === false);
  ok("unlock s 是 Integer", typeof unv.get("s") === "bigint");

  // buildExploreAction：只改 id + season，其余字节不变
  const builtE = buildExploreAction(FALLBACK_EXPLORE_RAW, 1445n);
  const beHex = Buffer.from(encode(builtE)).toString("hex");
  const be = decode(Buffer.from(beHex, "hex")).get("values");
  ok("explore 改写后字节长度不变", beHex.length === FALLBACK_EXPLORE_RAW.length);
  ok("explore 改写 season=1445n", be.get("season") === 1445n);
  ok("explore 改写 id 不同且 16B", !be.get("id").equals(exv.get("id")) && be.get("id").length === 16);
  for (const k of ["avatarAddress", "costumes", "equipments", "foods", "r"]) {
    ok(`explore 改写后 ${k} 字节不变`,
      Buffer.from(encode(be.get(k))).toString("hex") === Buffer.from(encode(exv.get(k))).toString("hex"));
  }

  // buildUnlockAction：强制 u=false，即使模板原本 u=true
  const unlockNcgRaw = (() => {
    const a = decode(Buffer.from(FALLBACK_UNLOCK_RAW, "hex"));
    const v = a.get("values");
    const entries = [...v.keys()].map((k) => [k, String(k) === "u" ? true : v.get(k)]);
    return Buffer.from(encode(new BencodexDictionary([
      ["type_id", a.get("type_id")], ["values", new BencodexDictionary(entries)],
    ]))).toString("hex");
  })();
  ok("构造的 NCG 模板 u=true", decode(Buffer.from(unlockNcgRaw, "hex")).get("values").get("u") === true);
  const builtU = decode(Buffer.from(encode(buildUnlockAction(unlockNcgRaw, 1445n)))).get("values");
  ok("buildUnlockAction 强制 u=false(GoldenDust)", builtU.get("u") === false);
  ok("unlock 改写 s=1445n", builtU.get("s") === 1445n);
  ok("unlock 改写 id 16B", builtU.get("id").length === 16);
  ok("unlock 改写 a 字节不变", Buffer.from(encode(builtU.get("a"))).toString("hex") === Buffer.from(encode(unv.get("a"))).toString("hex"));

  // 每笔 id 唯一
  const ids = new Set();
  for (let i = 0; i < 10; i++) ids.add(buildExploreAction(FALLBACK_EXPLORE_RAW, 1445n).get("values").get("id").toString("hex"));
  ok("连发 10 笔 explore id 全不同", ids.size === 10);

  // 赛季号解析
  ok("readSeasonFromRaw 解析 explore season=1445", readSeasonFromRaw(FALLBACK_EXPLORE_RAW) === 1445n);
  ok("readSeasonFromRaw 解析 unlock s=1445", readSeasonFromRaw(FALLBACK_UNLOCK_RAW) === 1445n);

  // 目标层数按 BOSS
  ok("Surtr 默认 29 层", computeTargetFloor(211000, null, 29) === 29);
  ok("Hella 默认 28 层", computeTargetFloor(211003, null, 29) === 28);
  ok("Laufey 默认 28 层", computeTargetFloor(211001, null, 29) === 28);
  ok("--floor 覆盖为 29", computeTargetFloor(211003, 29, 29) === 29);
  ok("目标不超过 30 层", computeTargetFloor(211000, 99, 29) === 30);

  // 决策 planNext
  ok("floor>=target => done", planNext({ floor: 28, maxFloor: 30, finished: false }, 28).action === "done");
  ok("floor<maxFloor => explore", planNext({ floor: 25, maxFloor: 30, finished: false }, 28).action === "explore");
  ok("floor==maxFloor<30 => unlock", planNext({ floor: 25, maxFloor: 25, finished: false }, 28).action === "unlock");
  ok("floor==maxFloor==30 未达标 => error", planNext({ floor: 30, maxFloor: 30, finished: false }, 30).action === "done"
    && planNext({ floor: 30, maxFloor: 30, finished: false }, 31).action === "error");
  ok("赛季结束 => error", planNext({ floor: 10, maxFloor: 30, finished: true }, 28).action === "error");

  // 终态/伪 INVALID
  for (const [s, e] of [["SUCCESS", true], ["FAILURE", true], ["INVALID", true], ["INCLUDED", false], ["STAGING", false], [null, false]]) {
    ok(`isTerminalTxStatus(${String(s)})`, isTerminalTxStatus(s) === e);
  }
  ok("伪 INVALID 识别", isPhantomInvalid({ txStatus: "INVALID", blockIndex: null, exceptionNames: [null] }));
  ok("真 INVALID 不误判", !isPhantomInvalid({ txStatus: "INVALID", blockIndex: 1, exceptionNames: [] }));

  // 参数边界
  ok("MAX_ATTEMPTS 在 1..60", MAX_ATTEMPTS >= 1 && MAX_ATTEMPTS <= 60);

  console.log(`\n  self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

// ---------------- 主流程 ----------------
async function main() {
  if (SELF_TEST) {
    console.log("=== 9C Adventure Boss 自动爬楼 · 纯逻辑自测 ===");
    return (await selfTest()) ? 0 : 1;
  }

  log({ level: "info", msg: "9C AB 自动爬楼启动", dryRun: DRY, avatar: CFG.avatarAddress,
    floorOverride: FLOOR_OVERRIDE, surtrFloor: SURTR_FLOOR, maxAttempts: MAX_ATTEMPTS, noUnlock: NO_UNLOCK });

  // 1) 私钥 & 归属
  if (!CFG.privateKey) throw new Error("缺少 NC_PRIVATE_KEY");
  const account = RawPrivateKey.fromHex(CFG.privateKey.replace(/^0x/, ""));
  const pub = await account.getPublicKey();
  const signer = Address.deriveFrom(pub);
  const avQ = "query($a:Address!){ stateQuery { avatar(avatarAddress:$a){ agentAddress } } }";
  const avD = await gqlRpc(avQ, { a: CFG.avatarAddress });
  const agent = avD.data?.stateQuery?.avatar?.agentAddress;
  if (agent && agent.toLowerCase() !== signer.toString().toLowerCase()) {
    throw new Error(`私钥与角色不匹配：signer=${signer} agent=${agent}`);
  }
  log({ level: "info", msg: "私钥归属校验通过", signer: signer.toString() });

  // 2) 个人赛季状态（权威）
  let st = await getMySeasonStatus();
  log({ level: "info", msg: "链上个人赛季状态（Heimdall）", floor: st.floor, maxFloor: st.maxFloor,
    boss: `${st.bossName}(${st.bossId})`, finished: st.finished,
    start: Number(st.start), end: Number(st.end), usedGoldenDust: st.usedGoldenDust, usedNcg: st.usedNcg });

  const tip = await getTip();
  if (st.finished || tip > st.end || tip < st.start) {
    throw new Error("当前没有进行中的 Adventure Boss 赛季（或 tip 不在窗口内），停止");
  }

  // 3) 赛季号：链上 LatestSeason 权威 + 交易兜底
  let season, seasonSource;
  if (SEASON_OVERRIDE !== null) {
    season = SEASON_OVERRIDE; seasonSource = "--season 手工指定";
  } else {
    let chainSeason = null;
    try {
      const ls = await fetchSeasonFromChainState();
      if (ls) { chainSeason = ls.season; log({ level: "info", msg: "链上 LatestSeason", season: Number(ls.season), bossId: ls.bossId }); }
    } catch (e) {
      log({ level: "warn", msg: "LatestSeason 读取失败，降级交易解析", err: String(e.message).slice(0, 120) });
    }
    const txHit = await fetchSeasonFromMyTxs();
    if (chainSeason !== null) {
      season = chainSeason; seasonSource = "链上 LatestSeason state";
      if (txHit && txHit.season !== chainSeason) {
        log({ level: "warn", msg: "交易赛季与链上不一致，以链上为准", tx: Number(txHit.season), chain: Number(chainSeason) });
      }
    } else if (txHit) {
      season = txHit.season; seasonSource = `Mimir ${txHit.typeId}@${txHit.blk}`;
    } else {
      throw new Error("无法解析赛季号，请用 --season 指定");
    }
  }
  log({ level: "info", msg: "当前赛季号", season: Number(season), source: seasonSource });

  // 4) 目标层数
  const target = computeTargetFloor(st.bossId, FLOOR_OVERRIDE, SURTR_FLOOR);
  log({ level: "info", msg: "目标层数", target, boss: st.bossName,
    rule: FLOOR_OVERRIDE !== null ? "--floor 指定" : (st.bossId === BOSS_SURTR ? "Surtr=29" : "默认=28") });

  // 5) 模板
  let exTpl = await fetchMineLatestSuccess(TYPE_EXPLORE);
  const exSrc = exTpl ? `Mimir explore@${exTpl.blockIndex}` : "内置兜底 explore@11844176";
  if (!exTpl) exTpl = { raw: FALLBACK_EXPLORE_RAW, blockIndex: 11844176 };
  let unTpl = await fetchMineLatestSuccess(TYPE_UNLOCK);
  const unSrc = unTpl ? `Mimir unlock@${unTpl.blockIndex}` : "内置兜底 unlock@11844174";
  if (!unTpl) unTpl = { raw: FALLBACK_UNLOCK_RAW, blockIndex: 11844174 };
  // 归属校验（buildAction 内部也校验）
  buildExploreAction(exTpl.raw, season);
  buildUnlockAction(unTpl.raw, season);
  log({ level: "info", msg: "交易模板就绪", explore: exSrc, unlock: unSrc,
    ticketPolicy: "unlock 门票强制 u=false = GoldenDust（绝不用 NCG）" });

  // dry-run：预览，不提交
  if (DRY) {
    log({ level: "info", msg: "DRY-RUN 预览（不提交、不花 AP / Golden Dust）" });
    const step = planNext(st, target);
    log({ level: "info", msg: "下一步决策", action: step.action, reason: step.reason || "", floor: st.floor, maxFloor: st.maxFloor, target });
    const exA = decode(Buffer.from(encode(buildExploreAction(exTpl.raw, season)))).get("values");
    const unA = decode(Buffer.from(encode(buildUnlockAction(unTpl.raw, season)))).get("values");
    log({ level: "info", msg: "explore 预览", season: Number(exA.get("season")),
      id: exA.get("id").toString("hex").slice(0, 12) + "…", typeId: TYPE_EXPLORE });
    log({ level: "info", msg: "unlock 预览", season: Number(unA.get("s")), useNcg: unA.get("u"),
      id: unA.get("id").toString("hex").slice(0, 12) + "…", typeId: TYPE_UNLOCK });
    return 0;
  }

  // 6) 实际爬楼循环
  let attempts = 0, unlocks = 0, explores = 0;
  const timeline = [];
  while (attempts < MAX_ATTEMPTS) {
    st = await getMySeasonStatus();               // 每轮重读链上，判定是否真推进
    const step = planNext(st, target);
    log({ level: "info", msg: "循环决策", attempt: attempts + 1, action: step.action,
      floor: st.floor, maxFloor: st.maxFloor, target });

    if (step.action === "done") {
      log({ level: "info", msg: "达标：个人通关层数已达目标", floor: st.floor, target });
      break;
    }
    if (step.action === "error") {
      log({ level: "error", msg: "无法继续", reason: step.reason, floor: st.floor, maxFloor: st.maxFloor, target });
      return 2;
    }
    if (step.action === "unlock" && NO_UNLOCK) {
      log({ level: "error", msg: "需要解锁但 --no-unlock 已禁止", floor: st.floor, maxFloor: st.maxFloor });
      return 2;
    }

    const nonce = await getNonce(signer.toString());
    const isUnlock = step.action === "unlock";
    const actionValue = isUnlock
      ? buildUnlockAction(unTpl.raw, season)
      : buildExploreAction(exTpl.raw, season);
    let txId = null;
    for (let a = 1; a <= 3 && !txId; a++) {
      try {
        txId = await submitTx({ account, pub, signer, nonce, actionValue });
      } catch (e) {
        log({ level: "warn", msg: "提交失败，重试", attempt: a, err: String(e.message).slice(0, 120) });
        if (a < 3) await sleep(GAP_MS);
      }
    }
    if (!txId) { log({ level: "error", msg: "连续 3 次提交失败，停止" }); return 2; }
    attempts++;
    if (isUnlock) unlocks++; else explores++;

    log({ level: "info", msg: "已提交", kind: isUnlock ? "unlock(GoldenDust)" : "explore",
      txId, nonce: Number(nonce), floorBefore: st.floor, maxFloorBefore: st.maxFloor });

    const conf = await confirmOne(txId, FINAL_TRIES, FINAL_INTERVAL_MS);

    // 只认链上终态：即使记录的 txId 是网络重试产生的"影子"(PENDING/INVALID)，
    // 只要重读状态发现 floor/maxFloor 已推进，就说明同内容交易其实 SUCCESS 了，继续推进。
    // 2026-11-24：曾因影子 txId 判 INVALID 而误停，实际状态已到 floor10/max15。
    const before = { floor: st.floor, maxFloor: st.maxFloor };
    let after = null;
    for (let w = 0; w < (conf.ok ? 5 : 8); w++) {
      await sleep(GAP_MS);
      try {
        const s2 = await getMySeasonStatus();
        after = { floor: s2.floor, maxFloor: s2.maxFloor };
        const moved = s2.floor > before.floor || s2.maxFloor > before.maxFloor || s2.floor >= target;
        if (moved) break;
      } catch (_) { /* 稍后重试读取 */ }
    }
    const advanced = after && (after.floor > before.floor || after.maxFloor > before.maxFloor);
    if (!conf.ok && !advanced) {
      log({ level: "error", msg: "交易未成功且链上状态未推进，停止", kind: isUnlock ? "unlock" : "explore",
        txId, status: conf.result.txStatus, why: explainFailure(conf.result), before, after });
      timeline.push({ kind: isUnlock ? "unlock" : "explore", txId, ok: false, status: conf.result.txStatus });
      return 2;
    }
    if (!conf.ok && advanced) {
      log({ level: "info", msg: "记录的txId非SUCCESS，但链上状态已推进（影子交易SUCCESS），继续",
        kind: isUnlock ? "unlock" : "explore", shadowTxId: txId, shadowStatus: conf.result.txStatus, before, after });
    }
    timeline.push({ kind: isUnlock ? "unlock" : "explore", txId, ok: true,
      status: conf.ok ? conf.result.txStatus : "SUCCESS(shadow)", blockIndex: conf.result.blockIndex ?? null });

    log({ level: "info", msg: "交易成功，链上状态", kind: isUnlock ? "unlock" : "explore",
      before, after: after || "读取失败" });

    if (attempts < MAX_ATTEMPTS) await sleep(GAP_MS);
  }

  st = await getMySeasonStatus();
  const reached = st.floor >= target;
  log({ level: reached ? "info" : "warn", msg: "爬楼结束",
    floor: st.floor, maxFloor: st.maxFloor, target, reached,
    attempts, explores, unlocks, season: Number(season) });
  console.log(JSON.stringify({ summary: true, reached, floor: st.floor, maxFloor: st.maxFloor,
    target, bossId: st.bossId, season: Number(season), attempts, explores, unlocks, timeline }, null, 2));
  return reached ? 0 : 3;
}

main().then((code) => { process.exitCode = code; })
  .catch((e) => { log({ level: "error", msg: "运行异常", err: String(e?.stack || e).slice(0, 1200) }); process.exitCode = 1; });
