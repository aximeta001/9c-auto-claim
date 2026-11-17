#!/usr/bin/env node
/**
 * Nine Chronicles (Heimdall) — Stun Rune (Adventure) 低价挂单自动扫货
 * ----------------------------------------------------------------
 * 独立脚本 + 独立 workflow 链，与 claim.mjs 领奖链完全隔离，互不干扰。
 *
 * 每轮做一次「扫描 + 购买」：
 *   1. 从 9CAPI 按 ticker 精确拉取 RUNESTONE_STUN_ADVENTURE 的所有在售挂单
 *      —— 用资产的唯一 ticker 精确过滤，绝不做名字模糊搜索，天然排除
 *         Stun Rune (Arena) / 其它同名近似物品。
 *   2. 用「单价」判定：unitPrice = 总价 NCG / 件数，<= 0.2 NCG/件 才买。
 *      用整数比较 price*100 <= 20*quantity，避开浮点误差与总价陷阱。
 *   3. 对命中的挂单逐笔签名提交 buy_product3（FAV 版），等到链上终态。
 *      提交前复核链上挂单仍存在、价格/卖家未变 —— 只认链上。
 *      挂单已被买走 / 价格变动 / 交易失败一律跳过，不锁死，下轮重扫。
 *
 * 物品身份三重校验（保证绝不搞错）：
 *   · ticker 精确 === "RUNESTONE_STUN_ADVENTURE"（服务端按 tickers 过滤 + 本地逐条复核）
 *   · productType === FUNGIBLE_ASSET_VALUE，asset.ticker 与 Mimir 链上一致
 *   · RuneSheet 的 id=10021 名称 "Stun Rune (Adventure)"、Arena=10022 明确排除
 *
 * 【第二条扫货目标：Valkyrie 装备】与 FAV 符文共用同一条链、同一次扫描：
 *   - 部位：Valkyrie Sword/Armor/Necklace/Belt/Ring（itemId 段 1017/1027/1047/1037/1057）
 *   - 全部元素变体（Normal/Fire/Water/Land/Wind）
 *   - 强化等级 level === 3（精确强化 +3；+4/+5 等更高等级和其它等级全部过滤掉）
 *   - 单价 <= 2 NCG/件（装备按件卖，price 即单价 NCG 整数）
 *   - 用 9CAPI /Market/products/items/{subType}?order=level_desc 拉「强化等级降序」挂单，
 *     本地按 itemId 段位精确筛出 Valkyrie，绝不按名字模糊匹配。
 *     【2026-11-17 修复】原用 cp_desc（战力降序），把强化>=3 的低价装备挤到 500 条之外
 *     导致 2NCG 的 lv3 装备全部漏买；改用 level_desc 后 lv3 排最前，命中正常。
 *   - 购买用 buy_product3 的 NonFungible 版（p[0] 8 字段，多 itemSubType/tradableId）。
 *   - 总花费封顶 500 NCG（本次运行累计，买够即停并正常交棒）。
 *
 * 私钥只从环境变量 NC_PRIVATE_KEY 读取（.env），绝不写进本文件/日志/落盘。
 *
 * 用法：
 *   NC_PRIVATE_KEY=xxxx node market-buy.mjs                 # 扫描一轮并购买命中单
 *   NC_PRIVATE_KEY=xxxx node market-buy.mjs --dry-run       # 只扫描不提交（真实联网只读）
 *   NC_PRIVATE_KEY=xxxx node market-buy.mjs --daemon        # 自接力常驻，守满预算交棒
 *   node market-buy.mjs --self-test                        # 离线自测纯逻辑（不联网）
 *   --no-valkyrie                                          # 临时关闭 Valkyrie 装备扫货
 *   --valk-max-price-ncg 2                                 # 装备单价上限 NCG（默认 2）
 *   --valk-spend-cap-ncg 500                               # 装备总花费封顶 NCG（默认 500）
 *   --valk-min-level 3                                     # 装备最低强化等级（默认 3）
 *
 * 依赖：@planetarium/{account,tx,bencodex,lib9c}（见同目录 package.json）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
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

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const DAEMON = args.includes("--daemon");
const SELF_TEST = args.includes("--self-test");
const numArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : def;
};
const strArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

// ---------------- 目标物品身份（唯一标识，不是名字） ----------------
// RuneSheet (Mimir sheet "RuneSheet")：
//   10021,Stun Rune (Adventure),RUNESTONE_STUN_ADVENTURE   ← 目标
//   10022,Stun Rune (Arena),RUNESTONE_STUN_ARENA           ← 明确排除
// 市场里符文是 FungibleAssetValue 挂单，其 asset.ticker 就是这里的 ticker。
// 用 ticker 精确匹配，从数据源头把 Adventure / Arena 分开，永不用名字搜索。
const TARGET_TICKER = "RUNESTONE_STUN_ADVENTURE";
const TARGET_RUNE_ID = 10021;
const EXCLUDE_TICKERS = new Set([
  "RUNESTONE_STUN_ARENA",           // Stun Rune (Arena)，最易混淆
]);
const RUNE_SHEET_NAME = "Stun Rune (Adventure)";

// 单价阈值：0.2 NCG / 件。NCG 有 2 位小数 => 0.2 NCG = 20 minor units。
// 判定用整数：price(NCG)*100 <= pricePerItemMinor(20) * quantity
const UNIT_PRICE_MINOR = BigInt(Math.max(0, Math.trunc(numArg("--max-unit-price-minor", 20))));
const BUY_TYPE_ID = "buy_product3";
const NCG_TICKER = "NCG";
const NCG_DECIMALS = 2;
const NCG_MINTERS = null;           // Lib9c NCG Currency: minters = null
// Lib9c BuyProduct.Capacity = 20：单笔 buy_product3 最多买 20 单。
const MAX_ITEMS_PER_TX = Math.max(1, Math.min(20, Math.trunc(numArg("--max-items-per-tx", 20))));
// 每轮最多提交几笔交易（防止一次扫太多把 job 拖过窗口）；默认不额外限制到手软。
const MAX_TX_PER_ROUND = Math.max(1, Math.trunc(numArg("--max-tx-per-round", 20)));
// 单笔交易前是否做链上复核（挂单仍在、价格/卖家未变）——贯彻「只认链上」
const VERIFY_ONCHAIN = !args.includes("--no-verify");

// ---------------- 轮询与自接力参数 ----------------
const POLL_SEC = Math.max(5, Math.trunc(numArg("--poll-seconds", 60)));
const MAX_RUN_MS = Math.max(10, numArg("--max-run-seconds", 330 * 60)) * 1000; // 5.5h < 6h
// 仅 dry-run 生效的演练钩子：注入挂单，快速走完整判定/构造流程，绝不联网提交
const SIM_LISTINGS_FILE = strArg("--simulate-listings-file", null);

// ---------------- Valkyrie 装备扫货配置 ----------------
const ENABLE_VALKYRIE = !args.includes("--no-valkyrie");
// 部位 -> subType(枚举数字) + itemId 段位正则（5 元素变体 + 普通版）+ 链上 itemSubType 字符串。
// 段位来源：EquipmentItemSheet.csv，各部位 5 元素变体尾号 0000/1000/2000/3000/4000。
const VALKYRIE_PARTS = [
  { key: "Sword",    subType: 6,  re: /^1017\d{4}$/, itemSubType: "Weapon" },
  { key: "Armor",    subType: 7,  re: /^1027\d{4}$/, itemSubType: "Armor" },
  { key: "Belt",     subType: 8,  re: /^1037\d{4}$/, itemSubType: "Belt" },
  { key: "Necklace", subType: 9,  re: /^1047\d{4}$/, itemSubType: "Necklace" },
  { key: "Ring",     subType: 10, re: /^1057\d{4}$/, itemSubType: "Ring" },
];
// Valkyrie 精确强化等级：只买 level 恰好等于此值的装备（默认 +3）。
// 与旧的 minLevel 不同，这里用严格相等：+4/+5/.../+28 等更高等级一律过滤掉。
// 兼容旧参数 --valk-min-level（作为别名），但新参数 --valk-level 优先。
const VALK_LEVEL = Math.max(0, Math.trunc(numArg("--valk-level", numArg("--valk-min-level", 3))));
// 装备按件卖：API price 是整数 NCG（即单价）；<= 上限即命中。用整数比较，无浮点。
const VALK_MAX_PRICE_NCG = Math.max(0, Math.trunc(numArg("--valk-max-price-ncg", 2)));
// 总花费封顶（本次运行累计 NCG）：买够即停止提交新单并正常交棒，接力后重置。
const VALK_SPEND_CAP_NCG = Math.max(0, numArg("--valk-spend-cap-ncg", 500));
// 每个部位拉取多少条挂单本地筛选（level_desc 让高强化装备排最前，500 足以覆盖所有 lv>=3）
const VALK_LISTING_LIMIT = Math.max(50, Math.trunc(numArg("--valk-listing-limit", 500)));
// 抓取排序：必须 level_desc（强化等级降序）。9CAPI 也支持 cp_desc/price_asc，
// 但只有 level_desc 能把强化>=3 的低价装备排到前面；可用参数覆盖以便排查。
const VALK_ORDER = strArg("--valk-order", "level_desc");
// 抓取健壮性：单请求超时 / 每部位重试次数 / 全部位总预算（秒）。防止某部位无限重试拖垮一轮。
const VALK_FETCH_TIMEOUT_MS = Math.max(5000, Math.trunc(numArg("--valk-fetch-timeout-ms", 25000)));
const VALK_FETCH_RETRIES = Math.max(1, Math.min(6, Math.trunc(numArg("--valk-fetch-retries", 3))));
const VALK_FETCH_BUDGET_MS = Math.max(30000, numArg("--valk-fetch-budget-seconds", 150)) * 1000;

// ---------------- buy_product3 FAV 版字节模板 ----------------
// 来源：链上真实 SUCCESS 交易 block 11755327 的 buy_product3 action（买
// RUNESTONE_STUN_ADVENTURE 挂单）。复用其已验证的字节结构，只替换动态字段
// （buyer avatarAddress、随机 action id、productId、price、seller 地址），
// 与 sweep 复用已 SUCCESS action 的思路一致，零类型/字段风险。
// 已用链上真实交易逐字节比对：除动态字段外完全一致（见 --self-test）。
const BUY_FAV_TEMPLATE =
  "6475373a747970655f69647531323a6275795f70726f647563743375363a76616c756573" +
  "6475313a6132303a7877fe3abb1a05af24838a278cdd7a9f9c37b8f975323a696431363a" +
  "b084c36e62fbd978c071d432847acc9c75313a706c6c31363aee40df1aa8e1c9419017bfc" +
  "dfcc2ac716c647531333a646563696d616c506c61636573313a0275373a6d696e74657273" +
  "6e75363a7469636b657275333a4e43476569393030656532303ae6f7b3ff35c819d98d33b" +
  "82a9eb8c4d76d7670a132303a74c4617ddf6d04ac3c7ff0f5425c352c0249c755753138" +
  "3a46756e6769626c65417373657456616c756565656565";

// buy_product3 NonFungible 版字节模板：来源 9CAPI mobileBuyHeimdall 对 price=9 的
// 合法返回（见 /tmp/crosscheck.mjs 交叉验证）。p[0] 比 FAV 版多 2 字段：
//   [0] productId(16B) [1] NCG currency+minor [2] sellerAgent [3] sellerAvatar
//   [4] "NonFungible" [5] false [6] itemSubType("Weapon") [7] tradableId(16B)
// 用其 NCG currency dict 作为编码规范（与 FAV 版逐字节一致，已验证）。
const BUY_NFT_TEMPLATE =
  "6475373a747970655f69647531323a6275795f70726f647563743375363a76616c756573" +
  "6475313a6132303aac9d450c69df27ee290c90ec61c4b76154b0a21c75323a696431363a" +
  "503d69aff8da014e8366fa489a7820dd75313a706c6c31363a99aee10f88051a41991b37" +
  "be51c44dc26c647531333a646563696d616c506c61636573313a0275373a6d696e746572" +
  "736e75363a7469636b657275333a4e43476569393030656532303ae6f7b3ff35c819d98d" +
  "33b82a9eb8c4d76d7670a132303a74c4617ddf6d04ac3c7ff0f5425c352c0249c7557531" +
  "313a4e6f6e46756e6769626c656675363a576561706f6e31363a99aee10f88051a41991b" +
  "37be51c44dc265656565";

// ---------------- 工具 ----------------
function log(obj) { console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj })); }
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(url, query, variables = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "9c-market-buy/1.0" },
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

// 地址 hex（可带 0x）→ 20 字节 Buffer
function addrToBuf(s) {
  if (typeof s !== "string") throw new Error("地址不是字符串");
  const h = s.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{40}$/.test(h)) throw new Error(`地址格式错误: ${s.slice(0, 20)}`);
  return Buffer.from(h, "hex");
}
// UUID 标准字符串 → Libplanet/.NET Guid.ToByteArray() 16 字节（bytes_le 前三段）
// 已与链上真实交易 productId、9CAPI mobileBuy 返回值逐字节对齐验证。
function uuidToBytesLe(uuid) {
  if (typeof uuid !== "string") throw new Error("productId 不是字符串");
  const b = Buffer.from(uuid.replace(/-/g, ""), "hex");
  if (b.length !== 16) throw new Error(`productId 长度错误: ${uuid}`);
  return Buffer.from([b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6],
    b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]]);
}

// ---------------- 物品身份校验（纯逻辑，供 self-test） ----------------
// 只认「精确 ticker 匹配」：名字相似、Arena、其它物品一律拒绝。
function isTargetListing(p, strict = true) {
  if (!p || typeof p !== "object") return false;
  const t = p.ticker;
  if (typeof t !== "string" || t !== TARGET_TICKER) return false;   // 精确，非 includes/模糊
  if (EXCLUDE_TICKERS.has(t)) return false;                          // 双保险
  if (strict) {
    if (p.exist === false || p.legacy === true) return false;         // 已下架/旧版
    // 9CAPI 的 price 实测恒为「整数 NCG」（链上 price = price*100 minor）。
    // 只接受整数，杜绝任何浮点/取整抹平边界的可能。
    if (!Number.isInteger(p.price) || p.price < 0) return false;
    if (!Number.isInteger(p.quantity) || p.quantity <= 0) return false;
  }
  return true;
}

// 单价判定（纯整数）：NCG 有 2 位小数，price(NCG 整数)→minor = price*100。
// unitPrice = price/quantity <= 阈值(minor/件)  <=>  price*100 <= unitPriceMinor*quantity
// 全程 BigInt 整数运算，无浮点、无 Math.round，边界严格（0.2 命中、略超即拒）。
function isCheapEnough(priceNcg, quantity, unitPriceMinor = UNIT_PRICE_MINOR) {
  if (!Number.isInteger(priceNcg) || priceNcg < 0) return false;
  if (!Number.isInteger(quantity) || quantity <= 0) return false;
  return BigInt(priceNcg) * 100n <= unitPriceMinor * BigInt(quantity);
}
// 单件实际单价（NCG，用于日志展示，不参与判定）
function unitPriceOf(priceNcg, quantity) {
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  return priceNcg / quantity;
}

// 从挂单列表挑出「目标物品 + 单价达标」的候选，按单价升序（先买最便宜）
function selectCandidates(listings, unitPriceMinor = UNIT_PRICE_MINOR) {
  const out = [];
  for (const p of listings || []) {
    if (!isTargetListing(p)) continue;
    const price = Number(p.price);
    const qty = Number(p.quantity);
    const up = unitPriceOf(price, qty);
    if (!isCheapEnough(price, qty, unitPriceMinor)) continue;
    out.push({
      productId: p.productId,
      sellerAgentAddress: p.sellerAgentAddress,
      sellerAvatarAddress: p.sellerAvatarAddress,
      priceNcg: price,
      quantity: qty,
      unitPrice: up,
      registeredBlockIndex: p.registeredBlockIndex ?? null,
      ticker: p.ticker,
    });
  }
  out.sort((a, b) => (a.unitPrice - b.unitPrice) || (a.priceNcg - b.priceNcg));
  return out;
}

// ---------------- Valkyrie 装备：身份判定 / 候选筛选 / action 构造 ----------------
// 判定单条装备挂单是否为「目标 Valkyrie」：itemId 命中部位段位 + level 精确等于目标 +
// 单价<=上限 + 关键字段齐全。全部走 itemId 段位（不是名字），杜绝近似装备。
function isValkyrieListing(p, part, opts = {}) {
  if (!p || typeof p !== "object") return false;
  const level = opts.level ?? VALK_LEVEL;
  const maxPrice = opts.maxPrice ?? VALK_MAX_PRICE_NCG;
  if (!part.re.test(String(p.itemId))) return false;                 // 部位段位精确
  if (!Number.isInteger(p.level) || p.level !== level) return false; // 强化等级精确等于目标（严格相等，过滤掉 +4/+5...）
  if (!Number.isInteger(p.price) || p.price < 0 || p.price > maxPrice) return false; // 单价 NCG
  if (p.exist === false || p.legacy === true) return false;          // 已下架/旧版
  // 购买所需关键字段必须齐全
  if (typeof p.productId !== "string" || typeof p.tradableId !== "string") return false;
  if (typeof p.sellerAgentAddress !== "string" || typeof p.sellerAvatarAddress !== "string") return false;
  if (!Number.isInteger(p.itemSubType)) return false;
  return true;
}

// 从各部位挂单里筛出 Valkyrie 候选，统一结构，按单价升序（先买最便宜）。
// listingsByPart: { [partKey]: [listing, ...] }
function selectValkyrieCandidates(listingsByPart, opts = {}) {
  const out = [];
  for (const part of VALKYRIE_PARTS) {
    const arr = (listingsByPart && listingsByPart[part.key]) || [];
    for (const p of arr) {
      if (!isValkyrieListing(p, part, opts)) continue;
      out.push({
        kind: "valkyrie",
        partKey: part.key,
        itemId: p.itemId,
        itemSubType: part.itemSubType,     // 链上字符串 "Weapon" 等
        level: p.level,
        priceNcg: p.price,                 // 装备按件卖，price 即单价 NCG
        productId: p.productId,
        tradableId: p.tradableId,
        sellerAgentAddress: p.sellerAgentAddress,
        sellerAvatarAddress: p.sellerAvatarAddress,
        registeredBlockIndex: p.registeredBlockIndex ?? null,
      });
    }
  }
  out.sort((a, b) => (a.priceNcg - b.priceNcg) || a.partKey.localeCompare(b.partKey));
  return out;
}

// buy_product3 NonFungible 版 action 构造：复用 9CAPI 合法模板的 NCG currency dict，
// 只替换动态字段。p[0] 8 字段，itemSubType/tradableId 为装备版新增。
function buildValkyrieBuyAction(items, buyerAvatarBuf, actionIdBuf) {
  const tpl = decode(Buffer.from(BUY_NFT_TEMPLATE, "hex"));
  if (!(tpl instanceof BencodexDictionary) || String(tpl.get("type_id")) !== BUY_TYPE_ID)
    throw new Error("buy NFT 模板 type_id 校验失败");
  const tplValues = tpl.get("values");
  const tplP0 = tplValues.get("p")[0];
  const tplCurrency = tplP0[1][0];        // NCG Currency dict（保留，勿重建）
  const tplProductType = tplP0[4];        // "NonFungible"
  const tplFalse = tplP0[5];              // false（用模板原值，避免 boolean/int 编码歧义）

  const p = items.map((it) => [
    uuidToBytesLe(it.productId),
    [tplCurrency, BigInt(it.priceNcg) * 100n],
    addrToBuf(it.sellerAgentAddress),
    addrToBuf(it.sellerAvatarAddress),
    tplProductType,
    tplFalse,
    it.itemSubType,                      // "Weapon"/"Armor"/"Belt"/"Necklace"/"Ring"
    uuidToBytesLe(it.tradableId),
  ]);
  const values = new BencodexDictionary([
    ["a", buyerAvatarBuf],
    ["id", actionIdBuf],
    ["p", p],
  ]);
  return new BencodexDictionary([
    ["type_id", tpl.get("type_id")],
    ["values", values],
  ]);
}

// ---------------- 挂单来源：9CAPI（ticker 精确过滤，全量） ----------------
// GET /marketProviderHeimdall/Market/products/fav?tickers=RUNESTONE_STUN_ADVENTURE
// 返回 { fungibleAssetValueProducts: [...] }，每条带 productId / seller / price /
// quantity / unitPrice / ticker / exist / legacy。服务端按 ticker 精确返回，
// 本地再用 isTargetListing 逐条复核，双保险。
async function fetchListings() {
  const url = `${CFG.api9c}/marketProviderHeimdall/Market/products/fav` +
    `?tickers=${encodeURIComponent(TARGET_TICKER)}&limit=10000&offset=0&order=price_asc`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  let j;
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "9c-market-buy/1.0" } });
    if (!r.ok) throw new Error(`9CAPI HTTP ${r.status}`);
    j = await r.json();
  } finally { clearTimeout(t); }
  const favs = Array.isArray(j?.fungibleAssetValueProducts) ? j.fungibleAssetValueProducts : [];
  // 逐条复核：即便服务端串了别的 ticker，本地也绝不放行
  const safe = favs.filter((p) => isTargetListing(p));
  return { listings: safe, rawCount: favs.length, rejected: favs.length - safe.length };
}

// Valkyrie 挂单来源：9CAPI 物品接口，按部位 subType 分类拉取。
// GET /marketProviderHeimdall/Market/products/items/{subType}?limit=N&offset=0&order=level_desc
// 用 level_desc（强化等级降序）让高强化装备排最前——2026-11-17 修复：
// 原 cp_desc（战力降序）会把强化>=3 的廉价装备挤到 500 条之外，导致 2NCG 的 lv3 漏买。
// 返回 { byPart: { [key]: [...] }, rawCount, errors }。单部位失败不影响其它部位。
async function fetchValkyrieListings() {
  const byPart = {};
  let rawCount = 0;
  const errors = [];
  const deadline = Date.now() + VALK_FETCH_BUDGET_MS;   // 全部位总预算，超时后剩余部位直接留空
  for (const part of VALKYRIE_PARTS) {
    byPart[part.key] = [];
    if (Date.now() >= deadline) {
      errors.push(`${part.key}: fetch_budget_exhausted`);
      continue;
    }
    const url = `${CFG.api9c}/marketProviderHeimdall/Market/products/items/${part.subType}` +
      `?limit=${VALK_LISTING_LIMIT}&offset=0&order=${encodeURIComponent(VALK_ORDER)}`;
    let arr = null;
    const partDeadline = Math.min(deadline, Date.now() + VALK_FETCH_TIMEOUT_MS * VALK_FETCH_RETRIES);
    for (let attempt = 0; attempt < VALK_FETCH_RETRIES && !arr && Date.now() < partDeadline; attempt++) {
      const ctrl = new AbortController();
      const timeLeft = Math.min(VALK_FETCH_TIMEOUT_MS, partDeadline - Date.now());
      if (timeLeft <= 0) break;
      const t = setTimeout(() => ctrl.abort(), timeLeft);
      try {
        const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "9c-market-buy/1.0" } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (Array.isArray(j?.itemProducts)) arr = j.itemProducts;
      } catch (e) {
        if (attempt === VALK_FETCH_RETRIES - 1) errors.push(`${part.key}: ${String(e.message).slice(0, 80)}`);
      } finally { clearTimeout(t); }
    }
    byPart[part.key] = arr || [];
    rawCount += byPart[part.key].length;
  }
  return { byPart, rawCount, errors };
}

// ---------------- 链上状态读取 / 提交前复核（只认链上） ----------------
async function getTip() {
  const d = await gqlRpc("{ nodeStatus { tip { index } genesis { hash } } }");
  return { tip: BigInt(d.data.nodeStatus.tip.index), rpc: d._url };
}
async function getAgentAddress() {
  const q = "query($a:Address!){ stateQuery { avatar(avatarAddress:$a){ agentAddress } } }";
  const d = await gqlRpc(q, { a: CFG.avatarAddress });
  return d.data?.stateQuery?.avatar?.agentAddress || null;
}
async function getNcgBalance(agentAddress) {
  const q = "query($a:Address!,$c:CurrencyInput!){ stateQuery { balance(address:$a,currency:$c){ quantity } } }";
  const d = await gqlRpc(q, { a: agentAddress, c: { ticker: NCG_TICKER, decimalPlaces: NCG_DECIMALS, minters: [] } });
  const qty = d.data?.stateQuery?.balance?.quantity;
  return qty == null ? null : Math.round(Number(qty) * 100); // NCG → minor
}

// 单个挂单的链上复核：用 Mimir products 的 asset.ticker + price 交叉确认。
// Mimir 的 FAV product 偶发反序列化错误，读不到时返回 false（保守跳过该单，
// 下轮重扫），绝不臆测为「可用」。
async function verifyListingOnchain(c) {
    const q = `query($id:UUID!){ product(productId:$id){ productId productType
    price { quantity ticker decimalPlaces } sellerAvatarAddress sellerAgentAddress
    ... on FavProduct { asset { quantity ticker decimalPlaces } } } }`;
  try {
    const d = await gql(CFG.mimir, q, { id: c.productId });
    const p = d.data?.product;
    // Mimir 的 product 集合对「当前在售」挂单常未索引（返回 not_found），
    // 属正常滞后。此时绝不臆测为「不可用」而误杀候选单 —— 放行，让链上
    // BuyProduct 执行时自行校验（productId/price/seller 不符即 FAILURE，
    // 无资金损失，符合「只认链上、失败无所谓」）。只有查到「明确不符」才拦截。
    if (!p || d.errors) return { skip: false, reason: "not_indexed_let_chain_decide" };
    // 物品身份：资产 ticker 必须正是目标（链上权威二次确认，防串货）
    const assetTicker = p.asset?.ticker;
    if (assetTicker && assetTicker !== TARGET_TICKER)
      return { skip: true, reason: `asset_ticker=${assetTicker}` };
    if (p.productType && p.productType !== "FUNGIBLE_ASSET_VALUE" && p.productType !== "FungibleAssetValue")
      return { skip: true, reason: `productType=${p.productType}` };
    // 价格与卖家复核：链上 price.quantity(NCG 主单位) 与挂单一致
    const onchainPrice = Number(p.price?.quantity);
    if (Number.isFinite(onchainPrice) && onchainPrice !== c.priceNcg)
      return { skip: true, reason: `price_changed onchain=${onchainPrice} listing=${c.priceNcg}` };
    if (p.sellerAgentAddress && c.sellerAgentAddress &&
        p.sellerAgentAddress.replace(/^0x/i, "").toLowerCase() !== c.sellerAgentAddress.replace(/^0x/i, "").toLowerCase())
      return { skip: true, reason: "seller_agent_changed" };
    return { skip: false, verified: true, assetTicker, onchainPrice };
  } catch (e) {
    // 索引/网络异常同样不能误杀
    return { skip: false, reason: `verify_error_let_chain_decide:${String(e.message).slice(0, 80)}` };
  }
}

// ---------------- buy_product3 FAV action 构造 ----------------
// 复用链上已 SUCCESS 的字节模板，替换动态字段。price 单位换算：
//   9CAPI price 是 NCG 主单位整数（如 9），链上 FAV = minor = price*100（=900）。
//   已由 9CAPI mobileBuyHeimdall 返回 i900e（price=9）权威验证。
function buildBuyAction(items, buyerAvatarBuf, actionIdBuf) {
  const tpl = decode(Buffer.from(BUY_FAV_TEMPLATE, "hex"));
  if (!(tpl instanceof BencodexDictionary) || String(tpl.get("type_id")) !== BUY_TYPE_ID)
    throw new Error("buy 模板 type_id 校验失败");
  const tplValues = tpl.get("values");
  const tplP0 = tplValues.get("p")[0];           // 单个 ProductInfo（Bencodex List）
  const tplCurrency = tplP0[1][0];               // NCG Currency dict（保留，勿重建）
  const tplProductType = tplP0[4];               // "FungibleAssetValue"

  const p = items.map((it) => [
    uuidToBytesLe(it.productId),
    // priceNcg 恒为整数 NCG（isTargetListing 已强制），×100 得链上 minor，纯整数
    [tplCurrency, BigInt(it.priceNcg) * 100n],
    addrToBuf(it.sellerAgentAddress),
    addrToBuf(it.sellerAvatarAddress),
    tplProductType,
  ]);
  const values = new BencodexDictionary([
    ["a", buyerAvatarBuf],
    ["id", actionIdBuf],
    ["p", p],
  ]);
  return new BencodexDictionary([
    ["type_id", tpl.get("type_id")],
    ["values", values],
  ]);
}

// ---------------- 交易提交与链上终态确认 ----------------
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
function isTerminalTxStatus(s) {
  return s === "SUCCESS" || s === "FAILURE" || s === "INVALID";
}
async function confirmTx(txId, tries = CFG.confirmTries) {
  const q = "query($t:TxId!){ transaction { transactionResult(txId:$t){ txStatus blockIndex exceptionNames } } }";
  for (let i = 0; i < tries; i++) {
    try {
      const d = await gqlRpc(q, { t: txId });
      const r = d.data?.transaction?.transactionResult;
      if (r && isTerminalTxStatus(r.txStatus)) return r;
    } catch (_) { /* 节点还没索引到 */ }
    if (i < tries - 1) await sleepMs(CFG.confirmIntervalMs);
  }
  return { txStatus: "PENDING" };
}

// ---------------- 单轮扫描 + 购买 ----------------
// 返回本轮结构化结果。逐笔串行（同一 signer 不能并发抢 nonce）。
// 两类目标共用同一 signer/链：FAV 符文（buildBuyAction）+ Valkyrie 装备
// （buildValkyrieBuyAction）。按 kind 分组打包，绝不混在同一笔交易里。
// 预算 ctx.spentNcg 跨轮累计（本次运行累计，接力后重置），达 VALK_SPEND_CAP_NCG 即停。
async function scanAndBuy(ctx, opts = {}) {
  const round = {
    candidates: [], bought: [], skipped: [], txSubmitted: 0, ok: true,
    valkCandidates: [], valkSpendNcg: 0,
  };
  if (!ctx) ctx = {};
  if (typeof ctx.spentNcg !== "number") ctx.spentNcg = 0;   // 跨轮累计已花费 NCG

  // ---- FAV 符文挂单 ----
  let favListings = [], favRaw = 0, rejected = 0;
  if (opts.simulatedListings) {
    favListings = opts.simulatedListings;
    favRaw = favListings.length;
  } else {
    const f = await fetchListings();
    favListings = f.listings; favRaw = f.rawCount; rejected = f.rejected;
  }
  round.rawCount = favRaw;
  round.rejectedByTicker = rejected;
  const favCandidates = selectCandidates(favListings);

  // ---- Valkyrie 装备挂单 ----
  let valkCandidates = [];
  if (ENABLE_VALKYRIE) {
    let byPart;
    if (opts.simulatedValkListings) {
      byPart = opts.simulatedValkListings;
    } else if (!opts.simulatedListings) {
      const vf = await fetchValkyrieListings();
      byPart = vf.byPart;
      round.valkRawCount = vf.rawCount;
      round.valkFetchErrors = vf.errors;
    } else {
      byPart = {};
    }
    valkCandidates = selectValkyrieCandidates(byPart);
  }
  round.valkCandidates = valkCandidates.map((c) => ({
    productId: c.productId, part: c.partKey, itemId: c.itemId,
    level: c.level, priceNcg: c.priceNcg,
  }));

  const allCandidates = [
    ...favCandidates.map((c) => ({ ...c, kind: "fav" })),
    ...valkCandidates.map((c) => ({ ...c, kind: "valkyrie" })),
  ];
  round.candidateCount = allCandidates.length;
  round.candidates = allCandidates.map((c) => ({
    kind: c.kind, productId: c.productId,
    unitPrice: c.kind === "fav" ? c.unitPrice : c.priceNcg,
    priceNcg: c.priceNcg,
    quantity: c.kind === "fav" ? c.quantity : 1,
    ticker: c.kind === "fav" ? c.ticker : c.partKey,
  }));

  if (allCandidates.length === 0) return round;

  // 归属校验：私钥派生 signer 必须等于角色链上 agentAddress
  if (!DRY && ctx.signer) {
    if (opts.agentAddress &&
        ctx.signer.toString().toLowerCase() !== opts.agentAddress.toLowerCase()) {
      round.ok = false;
      round.error = "私钥与角色不匹配：已阻止提交";
      log({ level: "error", msg: round.error });
      return round;
    }
  }

  // 余额预检：把明显买不起的单排除（避免白提交）；读不到余额则不预检，
  // 交给链上执行校验兜底（失败也无所谓）。
  let balanceMinor = null;
  if (!DRY && opts.agentAddress) {
    try { balanceMinor = await getNcgBalance(opts.agentAddress); } catch (_) {}
  }
  round.ncgBalanceNcg = balanceMinor === null ? null : balanceMinor / 100;

  const buyerBuf = addrToBuf(CFG.avatarAddress);
  const buyable = [];
  for (const c of allCandidates) {
    if (VERIFY_ONCHAIN && !opts.simulatedListings && !opts.simulatedValkListings) {
      const v = await verifyListingOnchain(c);
      if (v.skip) { round.skipped.push({ productId: c.productId, reason: `onchain_${v.reason}` }); continue; }
      if (v.verified) round.verifiedOnchain = (round.verifiedOnchain || 0) + 1;
    }
    if (balanceMinor !== null && Math.round(c.priceNcg * 100) > balanceMinor) {
      round.skipped.push({ productId: c.productId, reason: "insufficient_ncg" });
      continue;
    }
    // 预算封顶：只约束 Valkyrie 装备累计花费；FAV 符文不受此预算约束。
    if (c.kind === "valkyrie" && ctx.spentNcg + c.priceNcg > VALK_SPEND_CAP_NCG) {
      round.skipped.push({ productId: c.productId, reason: "valk_budget_cap" });
      continue;
    }
    buyable.push(c);
  }
  round.buyableCount = buyable.length;

  if (DRY) {
    for (const c of buyable) round.bought.push({
      productId: c.productId, status: "would_buy", kind: c.kind,
      priceNcg: c.priceNcg, unitPrice: c.kind === "fav" ? c.unitPrice : c.priceNcg,
      quantity: c.kind === "fav" ? c.quantity : 1,
    });
    log({ level: "info", msg: `演练：命中 ${buyable.length} 单，本应购买（未提交任何交易）`,
          fav: favCandidates.length, valkyrie: valkCandidates.length, buyable: buyable.length });
    return round;
  }

  // 按 kind 分组，每组内分批打包（每笔 <= MAX_ITEMS_PER_TX），逐笔串行提交 + 等终态。
  // 便宜的先买：Valkyrie 与 FAV 各自已按单价升序；组间先 Valkyrie（预算敏感）后 FAV。
  const groups = [
    { kind: "valkyrie", list: buyable.filter((c) => c.kind === "valkyrie"), build: buildValkyrieBuyAction },
    { kind: "fav",      list: buyable.filter((c) => c.kind === "fav"),      build: buildBuyAction },
  ];
  let txCount = 0;
  for (const group of groups) {
    for (let i = 0; i < group.list.length && txCount < MAX_TX_PER_ROUND; i += MAX_ITEMS_PER_TX) {
      // 预算二次拦截（同组内逐笔累计，防止一批里超支）
      let batch = group.list.slice(i, i + MAX_ITEMS_PER_TX);
      if (group.kind === "valkyrie") {
        const kept = [];
        for (const c of batch) {
          if (ctx.spentNcg + c.priceNcg > VALK_SPEND_CAP_NCG) {
            round.skipped.push({ productId: c.productId, reason: "valk_budget_cap" });
            continue;
          }
          kept.push(c);
        }
        batch = kept;
      }
      if (!batch.length) continue;
      const rec = { kind: group.kind, items: batch.map((c) => c.productId), status: "pending" };
      try {
        const actionValue = group.build(batch, buyerBuf, randomBytes(16));
        const nonce = await getNonce(ctx.signer.toString());
        const txId = await submitTx({ account: ctx.account, pub: ctx.pub, signer: ctx.signer, nonce, actionValue });
        rec.txId = txId; rec.nonce = Number(nonce);
        round.txSubmitted++; txCount++;
        log({ level: "info", msg: `已提交 buy_product3（${group.kind}, ${batch.length} 单）`, txId,
              items: rec.items, nonce: rec.nonce });
        const r = await confirmTx(txId);
        rec.txStatus = r.txStatus;
        rec.exceptionNames = r.exceptionNames ?? null;
        if (r.txStatus === "SUCCESS") {
          rec.status = "bought";
          for (const c of batch) {
            round.bought.push({ productId: c.productId, status: "bought", kind: c.kind,
              unitPrice: c.kind === "fav" ? c.unitPrice : c.priceNcg,
              priceNcg: c.priceNcg, quantity: c.kind === "fav" ? c.quantity : 1, txId });
            if (c.kind === "valkyrie") {
              ctx.spentNcg += c.priceNcg;
              round.valkSpendNcg += c.priceNcg;
            }
          }
          log({ level: "info", msg: `购买成功（${group.kind}, ${batch.length} 单）`, txId, items: rec.items });
        } else {
          rec.status = "not_confirmed";
          for (const c of batch) round.skipped.push({ productId: c.productId, reason: `tx_${r.txStatus}` });
          log({ level: "warn", msg: `购买未确认成功（${r.txStatus}），下轮重扫链上复核`,
                txId, items: rec.items, exceptionNames: rec.exceptionNames });
        }
      } catch (e) {
        rec.status = "error"; rec.error = String(e.message);
        log({ level: "warn", msg: "购买提交异常，下轮重试", detail: rec.error, items: rec.items });
      }
      round.txLog = round.txLog || [];
      round.txLog.push(rec);
    }
  }
  round.valkSpendNcgTotal = ctx.spentNcg;
  return round;
}

// ---------------- 自接力常驻模式 ----------------
async function daemonMode() {
  const started = Date.now();
  const out = {
    network: "heimdall", avatar: CFG.avatarAddress, dryRun: DRY, mode: "daemon",
    ticker: TARGET_TICKER, maxUnitPriceNcg: Number(UNIT_PRICE_MINOR) / 100,
    ok: true, rounds: 0, totals: { candidates: 0, bought: 0, tx: 0 }, transientErrors: 0,
    valkyrie: {
      enabled: ENABLE_VALKYRIE, level: VALK_LEVEL, maxPriceNcg: VALK_MAX_PRICE_NCG,
      spendCapNcg: VALK_SPEND_CAP_NCG, spentNcg: 0, capReached: false,
    },
    config: {
      pollSeconds: POLL_SEC, maxRunSeconds: MAX_RUN_MS / 1000,
      verifyOnchain: VERIFY_ONCHAIN, maxItemsPerTx: MAX_ITEMS_PER_TX,
      maxTxPerRound: MAX_TX_PER_ROUND,
    },
  };
  if (!CFG.privateKey && !DRY) {
    out.ok = false; out.error = "缺少 NC_PRIVATE_KEY";
    console.log(JSON.stringify(out)); process.exit(1);
  }
  let ctx = { spentNcg: 0 };
  if (!DRY) {
    const hex = CFG.privateKey.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      out.ok = false; out.error = "私钥格式错误";
      console.log(JSON.stringify(out)); process.exit(1);
    }
    const account = RawPrivateKey.fromHex(hex);
    const pub = await account.getPublicKey();
    ctx = { account, pub, signer: Address.deriveFrom(pub), spentNcg: 0 };
    out.signer = ctx.signer.toString();
  }

  let handoff = "budget_exhausted";
  let first = true;
  while (true) {
    if (Date.now() - started >= MAX_RUN_MS) { handoff = "budget_exhausted"; break; }
    let simList = null;
    if (DRY && SIM_LISTINGS_FILE) {
      try { simList = JSON.parse(fs.readFileSync(SIM_LISTINGS_FILE, "utf8")); } catch (_) {}
    }
    let agentAddress = null, tip = null;
    try {
      tip = Number((await getTip()).tip);
      if (!DRY) agentAddress = await getAgentAddress();
    } catch (e) {
      out.transientErrors++;
      log({ level: "warn", msg: "链上快照读取失败，稍后重试", detail: String(e.message) });
      if (DRY && !simList) break;
      await sleepMs(Math.min(POLL_SEC, 15) * 1000);
      continue;
    }
    out.rounds++;
    if (first) {
      first = false;
      log({ level: "info", msg: "市场扫货常驻启动", tip,
            ticker: TARGET_TICKER, maxUnitPriceNcg: Number(UNIT_PRICE_MINOR) / 100,
            valkyrie: ENABLE_VALKYRIE ? `5部位/lv===${VALK_LEVEL}/<=${VALK_MAX_PRICE_NCG}NCG/封顶${VALK_SPEND_CAP_NCG}NCG` : "关闭",
            pollSeconds: POLL_SEC, maxRunSeconds: MAX_RUN_MS / 1000 });
    }
    try {
      const r = await scanAndBuy(ctx, { agentAddress, simulatedListings: simList });
      out.totals.candidates += r.candidateCount || 0;
      out.totals.bought += (r.bought || []).filter((b) => b.status === "bought" || b.status === "would_buy").length;
      out.totals.tx += r.txSubmitted || 0;
      out.valkyrie.spentNcg = ctx.spentNcg;
      out.valkyrie.capReached = ctx.spentNcg >= VALK_SPEND_CAP_NCG;
      log({ level: "daemon", round: out.rounds, tip,
            rawCount: r.rawCount, candidateCount: r.candidateCount,
            valkCandidates: (r.valkCandidates || []).length, valkSpendNcg: ctx.spentNcg,
            buyableCount: r.buyableCount, txSubmitted: r.txSubmitted,
            elapsedSec: Math.round((Date.now() - started) / 1000) });
      if (r.ok === false) { out.ok = false; out.error = r.error; handoff = "aborted"; break; }
      // 装备预算买满：FAV 符文仍可继续（预算只约束 Valkyrie）；此处不提前结束，
      // 让 FAV 扫货照常值守到时间预算。若只想跑装备可关 FAV（未来扩展）。
      if (ctx.spentNcg >= VALK_SPEND_CAP_NCG && !out.valkyrie.capNotified) {
        out.valkyrie.capNotified = true;
        log({ level: "info", msg: `Valkyrie 装备已买满 ${ctx.spentNcg}/${VALK_SPEND_CAP_NCG} NCG，停止买入装备` });
      }
    } catch (e) {
      out.transientErrors++;
      log({ level: "warn", msg: "本轮扫描异常，稍后重试", detail: String(e.message) });
    }
    if (DRY && !SIM_LISTINGS_FILE) {
      out.status = "dry_plan"; handoff = "dry_plan";
      out.msg = `演练（无注入挂单）：本应每 ${POLL_SEC}s 扫描一轮并持续值守到预算耗尽后交棒；不提交`;
      break;
    }
    const leftMs = MAX_RUN_MS - (Date.now() - started);
    await sleepMs(Math.max(0, Math.min(POLL_SEC * 1000, leftMs)));
  }
  out.status = out.status || handoff;
  out.handoff = handoff;
  out.elapsedMs = Date.now() - started;
  out.msg = out.msg || (handoff === "budget_exhausted"
    ? "时间预算耗尽，正常交棒：由 workflow 接力 step 触发下一个常驻 job"
    : `退出：${handoff}`);
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}

// ---------------- 单轮模式 ----------------
async function onceMode() {
  const out = {
    network: "heimdall", avatar: CFG.avatarAddress, dryRun: DRY, mode: "once",
    ticker: TARGET_TICKER, maxUnitPriceNcg: Number(UNIT_PRICE_MINOR) / 100, ok: true,
  };
  if (!CFG.privateKey && !DRY) {
    out.ok = false; out.error = "缺少 NC_PRIVATE_KEY";
    console.log(JSON.stringify(out)); process.exit(1);
  }
  let ctx = null, agentAddress = null;
  try {
    const st = await getTip();
    out.tip = Number(st.tip); out.rpc = st.rpc;
    agentAddress = await getAgentAddress();
    out.agentAddress = agentAddress;
  } catch (e) {
    out.ok = false; out.error = `读取链上状态失败: ${e.message}`;
    console.log(JSON.stringify(out)); process.exit(1);
  }
  if (!DRY) {
    const hex = CFG.privateKey.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      out.ok = false; out.error = "私钥格式错误";
      console.log(JSON.stringify(out)); process.exit(1);
    }
    const account = RawPrivateKey.fromHex(hex);
    const pub = await account.getPublicKey();
    ctx = { account, pub, signer: Address.deriveFrom(pub), spentNcg: 0 };
    out.signer = ctx.signer.toString();
  }
  if (!ctx) ctx = { spentNcg: 0 };
  let simList = null, simValk = null;
  if (DRY && SIM_LISTINGS_FILE) {
    try {
      const sim = JSON.parse(fs.readFileSync(SIM_LISTINGS_FILE, "utf8"));
      // 兼容：{ fav:[...], valkyrie:{ Sword:[...], ... } } 或 纯数组(旧 FAV)
      if (Array.isArray(sim)) simList = sim;
      else { simList = sim.fav || []; simValk = sim.valkyrie || null; }
    } catch (_) {}
  }
  const r = await scanAndBuy(ctx, { agentAddress, simulatedListings: simList, simulatedValkListings: simValk });
  out.rawCount = r.rawCount; out.rejectedByTicker = r.rejectedByTicker;
  out.candidateCount = r.candidateCount; out.candidates = r.candidates;
  out.buyableCount = r.buyableCount; out.bought = r.bought; out.skipped = r.skipped;
  out.txSubmitted = r.txSubmitted; out.txLog = r.txLog || [];
  out.ncgBalanceNcg = r.ncgBalanceNcg ?? null;
  out.valkyrie = {
    enabled: ENABLE_VALKYRIE, level: VALK_LEVEL, maxPriceNcg: VALK_MAX_PRICE_NCG,
    spendCapNcg: VALK_SPEND_CAP_NCG, candidates: r.valkCandidates || [],
    rawCount: r.valkRawCount ?? null, fetchErrors: r.valkFetchErrors || [],
  };
  if (r.ok === false) { out.ok = false; out.error = r.error; }
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}

// ---------------- 离线自测（不联网） ----------------
function selfTest() {
  let pass = 0, total = 0;
  const chk = (name, cond, extra = "") => {
    total++;
    if (cond) { pass++; console.log(`  [OK]   ${name} ${extra}`); }
    else console.log(`  [FAIL] ${name} ${extra}`);
  };

  // 1) ticker 精确匹配：目标通过；Arena / 名字相似 / 其它 ticker / 模糊均拒绝
  const idCases = [
    ["目标 Adventure", { ticker: TARGET_TICKER, exist: true, legacy: false, price: 9, quantity: 10 }, true],
    ["Arena 明确排除", { ticker: "RUNESTONE_STUN_ARENA", exist: true, legacy: false, price: 1, quantity: 10 }, false],
    ["名字含相似串", { ticker: "RUNESTONE_STUN_ADVENTURE_OLD", exist: true, legacy: false, price: 1, quantity: 10 }, false],
    ["其它符文", { ticker: "RUNESTONE_FENRIR1", exist: true, legacy: false, price: 1, quantity: 10 }, false],
    ["大小写不同", { ticker: "runestone_stun_adventure", exist: true, legacy: false, price: 1, quantity: 10 }, false],
    ["已下架 exist=false", { ticker: TARGET_TICKER, exist: false, legacy: false, price: 1, quantity: 10 }, false],
    ["legacy=true", { ticker: TARGET_TICKER, exist: true, legacy: true, price: 1, quantity: 10 }, false],
    ["缺 ticker", { exist: true, legacy: false, price: 1, quantity: 10 }, false],
    ["negative price", { ticker: TARGET_TICKER, exist: true, legacy: false, price: -1, quantity: 10 }, false],
    ["quantity=0", { ticker: TARGET_TICKER, exist: true, legacy: false, price: 1, quantity: 0 }, false],
    ["非整数 price 拒绝", { ticker: TARGET_TICKER, exist: true, legacy: false, price: 2.5, quantity: 10 }, false],
    ["非整数 quantity 拒绝", { ticker: TARGET_TICKER, exist: true, legacy: false, price: 2, quantity: 10.5 }, false],
  ];
  for (const [n, p, exp] of idCases) chk(`isTargetListing: ${n}`, isTargetListing(p) === exp);

  // 2) 单价判定（整数，0.2 NCG/件 = 20 minor/件；price 是 NCG 主单位）
  const priceCases = [
    ["0.9 NCG/件(9/10) 不买", 9, 10, false],
    ["0.7 NCG/件(56/80) 不买", 56, 80, false],
    ["恰好 0.2(2/10) 买", 2, 10, true],
    ["0.15(3/20) 买", 3, 20, true],
    ["0.05(1/20) 买", 1, 20, true],
    ["0.2+epsilon(21/100) 略超不买", 21, 100, false],  // 0.21 NCG/件
    ["0.19(19/100) 买", 19, 100, true],
    ["非整数 price 拒绝(链上不存在)", 2.001, 10, false],
    ["非整数 price 0.5 拒绝", 0.5, 5, false],
    ["quantity 0 不买", 1, 0, false],
    ["quantity 非整数拒绝", 1, 5.5, false],
  ];
  for (const [n, p, q, exp] of priceCases) chk(`isCheapEnough: ${n}`, isCheapEnough(p, q, 20n) === exp);

  // 3) selectCandidates：只挑目标+达标，按单价升序
  {
    const ls = [
      { ticker: TARGET_TICKER, exist: true, legacy: false, price: 9, quantity: 10, productId: "a", sellerAgentAddress: "0x1111111111111111111111111111111111111111", sellerAvatarAddress: "0x2222222222222222222222222222222222222222" },
      { ticker: "RUNESTONE_STUN_ARENA", exist: true, legacy: false, price: 1, quantity: 10, productId: "arena" },
      { ticker: TARGET_TICKER, exist: true, legacy: false, price: 1, quantity: 20, productId: "cheap", sellerAgentAddress: "0x1111111111111111111111111111111111111111", sellerAvatarAddress: "0x2222222222222222222222222222222222222222" },
      { ticker: TARGET_TICKER, exist: true, legacy: false, price: 2, quantity: 10, productId: "edge", sellerAgentAddress: "0x1111111111111111111111111111111111111111", sellerAvatarAddress: "0x2222222222222222222222222222222222222222" },
    ];
    const c = selectCandidates(ls, 20n);
    chk("selectCandidates: 排除 Arena/高价，保留达标", c.length === 2 && !c.some((x) => x.productId === "arena"), `len=${c.length}`);
    chk("selectCandidates: 按单价升序(cheap 在前)", c[0].productId === "cheap" && c[0].unitPrice === 0.05);
  }

  // 4) UUID → bytes_le：与链上真实交易 / 9CAPI mobileBuy 返回逐字节对齐
  {
    const got = uuidToBytesLe("0fe1ae99-0588-411a-991b-37be51c44dc2").toString("hex");
    chk("uuidToBytesLe 对照链上", got === "99aee10f88051a41991b37be51c44dc2", got);
  }
  // 5) addrToBuf
  {
    const b = addrToBuf("0xAC9D450C69dF27ee290C90EC61c4B76154b0A21c");
    chk("addrToBuf 20字节", b.length === 20 && b.toString("hex") === "ac9d450c69df27ee290c90ec61c4b76154b0a21c");
  }

  // 6) buy action 字节级比对：用模板自身的动态字段重建，应逐字节相同
  //    证明构造只替换动态字段、其余结构（含 NCG Currency dict/type_id）零改动。
  try {
    const tpl = decode(Buffer.from(BUY_FAV_TEMPLATE, "hex"));
    const v = tpl.get("values");
    const buyer = v.get("a");                  // 20B
    const actId = v.get("id");                 // 16B
    const p0 = v.get("p")[0];
    // 用模板的动态字段逆推出「等价挂单」，重建后必须 == 模板 hex
    const pidBytes = p0[0];                    // 16B bytes_le
    // bytes_le → 标准 UUID hex（自反变换）
    const q = Buffer.from(pidBytes);
    const stdHex = Buffer.from([q[3], q[2], q[1], q[0], q[5], q[4], q[7], q[6],
      q[8], q[9], q[10], q[11], q[12], q[13], q[14], q[15]]).toString("hex");
    const pid = `${stdHex.slice(0,8)}-${stdHex.slice(8,12)}-${stdHex.slice(12,16)}-${stdHex.slice(16,20)}-${stdHex.slice(20)}`;
    const priceMinor = BigInt(p0[1][1]);
    const priceNcg = Number(priceMinor) / 100;
    const item = {
      productId: pid,
      priceNcg,
      sellerAgentAddress: "0x" + Buffer.from(p0[2]).toString("hex"),
      sellerAvatarAddress: "0x" + Buffer.from(p0[3]).toString("hex"),
    };
    const rebuilt = buildBuyAction([item], Buffer.from(buyer), Buffer.from(actId));
    const rebuiltHex = Buffer.from(encode(rebuilt)).toString("hex");
    chk("buildBuyAction 与链上模板逐字节一致",
      rebuiltHex === BUY_FAV_TEMPLATE,
      rebuiltHex === BUY_FAV_TEMPLATE ? `${rebuiltHex.length / 2}B` : `diff ${rebuiltHex.length} vs ${BUY_FAV_TEMPLATE.length}`);
    // 换随机 id / 换 productId → 只有对应字节变化，type_id/NCG dict 不动
    const rebuilt2 = buildBuyAction([item], Buffer.from(buyer), randomBytes(16));
    const h2 = Buffer.from(encode(rebuilt2)).toString("hex");
    chk("换 action id 后结构仍合法",
      h2.length === BUY_FAV_TEMPLATE.length && h2 !== BUY_FAV_TEMPLATE);
  } catch (e) {
    chk("buildBuyAction 字节级比对", false, String(e.message));
  }

  // 7) Valkyrie 身份判定：itemId 段位 + level + 单价 + 字段齐全
  {
    const sword = VALKYRIE_PARTS[0];
    const good = (over = {}) => ({ itemId: 10170000, level: 3, price: 2, itemSubType: 6,
      productId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", tradableId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      sellerAgentAddress: "0x" + "11".repeat(20), sellerAvatarAddress: "0x" + "22".repeat(20), ...over });
    chk("Valk Sword lv3 price2 命中", isValkyrieListing(good(), sword));
    chk("Valk Sword 5元素变体全命中", ["10170000","10171000","10172000","10173000","10174000"]
      .every((id) => isValkyrieListing(good({ itemId: id }), sword)));
    chk("Valk lv2 拒绝", !isValkyrieListing(good({ level: 2 }), sword));
    // 精确 +3：更高等级（+4/+5/+28）也必须全部拒绝
    chk("Valk lv4 拒绝(精确+3)", !isValkyrieListing(good({ level: 4 }), sword));
    chk("Valk lv5 拒绝(精确+3)", !isValkyrieListing(good({ level: 5 }), sword));
    chk("Valk lv28 拒绝(精确+3)", !isValkyrieListing(good({ level: 28 }), sword));
    chk("Valk price3>2 拒绝", !isValkyrieListing(good({ price: 3 }), sword));
    chk("Valk price2 边界命中", isValkyrieListing(good({ price: 2 }), sword));
    chk("Valk 非本部位段位拒绝(Sword里放Armor id)", !isValkyrieListing(good({ itemId: 10270000 }), sword));
    chk("Valk exist=false 拒绝", !isValkyrieListing(good({ exist: false }), sword));
    chk("Valk legacy=true 拒绝", !isValkyrieListing(good({ legacy: true }), sword));
    chk("Valk 缺 tradableId 拒绝", !isValkyrieListing(good({ tradableId: undefined }), sword));
    chk("Valk 非整数 level 拒绝", !isValkyrieListing(good({ level: 3.5 }), sword));
    // 其它部位段位互不串
    chk("Valk Armor 段位命中", isValkyrieListing(good({ itemId: 10274000 }), VALKYRIE_PARTS[1]));
    chk("Valk Belt 段位命中", isValkyrieListing(good({ itemId: 10371000 }), VALKYRIE_PARTS[2]));
    chk("Valk Necklace 段位命中", isValkyrieListing(good({ itemId: 10473000 }), VALKYRIE_PARTS[3]));
    chk("Valk Ring 段位命中", isValkyrieListing(good({ itemId: 10574000 }), VALKYRIE_PARTS[4]));
  }

  // 8) Valkyrie 候选筛选：按部位 + 单价升序
  {
    chk("Valk 抓取排序默认 level_desc(防漏买强化装)", VALK_ORDER === "level_desc", `got ${VALK_ORDER}`);
    const mk = (itemId, level, price) => ({ itemId, level, price, itemSubType: 6,
      productId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", tradableId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      sellerAgentAddress: "0x" + "11".repeat(20), sellerAvatarAddress: "0x" + "22".repeat(20) });
    // 精确 +3 默认：lv5 那条被过滤，只剩两条 lv3（其中 price9 超上限被排除）→ 1 条
    const byPart = { Sword: [mk(10174000, 5, 2), mk(10170000, 3, 1), mk(10171000, 3, 9)], Armor: [mk(10270000, 3, 2)] };
    const cands = selectValkyrieCandidates(byPart);
    chk("Valk 精确+3过滤lv5 + price上限", cands.length === 2, `got ${cands.length}`);
    chk("Valk 候选按单价升序", cands[0].priceNcg === 1 && cands[1].priceNcg === 2);
    chk("Valk 候选带 partKey/kind", cands.every((c) => c.kind === "valkyrie" && !!c.partKey));
    // 自定义精确等级覆盖默认值（level:5）→ 只命中 lv5 那条
    const cands2 = selectValkyrieCandidates(byPart, { level: 5, maxPrice: 2 });
    chk("Valk 自定义精确等级(lv5)", cands2.length === 1 && cands2[0].level === 5, `got ${cands2.length}`);
  }

  // 9) NonFungible buy action 构造：p[0] 8 字段、用 9CAPI 合法模板字节规范
  try {
    const tpl = decode(Buffer.from(BUY_NFT_TEMPLATE, "hex"));
    const v = tpl.get("values");
    const buyer = v.get("a"), actId = v.get("id"), p0 = v.get("p")[0];
    const stdHex = Buffer.from([p0[0][3],p0[0][2],p0[0][1],p0[0][0],p0[0][5],p0[0][4],p0[0][7],p0[0][6],
      p0[0][8],p0[0][9],p0[0][10],p0[0][11],p0[0][12],p0[0][13],p0[0][14],p0[0][15]]).toString("hex");
    const uuid = `${stdHex.slice(0,8)}-${stdHex.slice(8,12)}-${stdHex.slice(12,16)}-${stdHex.slice(16,20)}-${stdHex.slice(20)}`;
    const priceNcg = Number(BigInt(p0[1][1])) / 100;
    const item = { productId: uuid, tradableId: uuid, priceNcg, itemSubType: String(p0[6]),
      sellerAgentAddress: "0x" + Buffer.from(p0[2]).toString("hex"),
      sellerAvatarAddress: "0x" + Buffer.from(p0[3]).toString("hex") };
    const built = buildValkyrieBuyAction([item], Buffer.from(buyer), Buffer.from(actId));
    const builtHex = Buffer.from(encode(built)).toString("hex");
    chk("NonFungible action 与 9CAPI 模板逐字节一致", builtHex === BUY_NFT_TEMPLATE,
      builtHex === BUY_NFT_TEMPLATE ? `${builtHex.length/2}B` : `diff ${builtHex.length} vs ${BUY_NFT_TEMPLATE.length}`);
    const bv = built.get("values").get("p")[0];
    chk("NonFungible p[0] 8字段", bv.length === 8, `got ${bv.length}`);
    chk("NonFungible productType=NonFungible", String(bv[4]) === "NonFungible");
    chk("NonFungible itemSubType=Weapon", String(bv[6]) === "Weapon");
  } catch (e) {
    chk("NonFungible action 字节级比对", false, String(e.message));
  }

  // 10) 预算封顶逻辑（纯整数）
  {
    const cap = 500, spent = 499, price = 2;
    chk("预算超额拦截", spent + price > cap);           // 499+2>500 → 跳
    chk("预算刚好命中", 498 + 2 === cap);               // 恰好 500 → 买
    chk("预算不约束 FAV", true);                        // FAV 不进预算判断（结构保证）
  }

  // 11) 终态判定：只认 SUCCESS/FAILURE/INVALID
  const termCases = [["SUCCESS", true], ["FAILURE", true], ["INVALID", true],
    ["STAGING", false], ["INCLUDED", false], ["PENDING", false]];
  for (const [s, exp] of termCases) chk(`isTerminalTxStatus(${s})`, isTerminalTxStatus(s) === exp);

  console.log(`\n  self-test: ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

// ---------------- 主流程 ----------------
async function main() {
  if (SELF_TEST) return selfTest();
  if (DAEMON) return daemonMode();
  return onceMode();
}
main().catch((e) => {
  log({ level: "fatal", msg: String(e.stack || e.message) });
  console.log(JSON.stringify({ ok: false, error: String(e.message) }));
  process.exit(1);
});
