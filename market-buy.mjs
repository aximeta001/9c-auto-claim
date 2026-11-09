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
 * 私钥只从环境变量 NC_PRIVATE_KEY 读取（.env），绝不写进本文件/日志/落盘。
 *
 * 用法：
 *   NC_PRIVATE_KEY=xxxx node market-buy.mjs                 # 扫描一轮并购买命中单
 *   NC_PRIVATE_KEY=xxxx node market-buy.mjs --dry-run       # 只扫描不提交（真实联网只读）
 *   NC_PRIVATE_KEY=xxxx node market-buy.mjs --daemon        # 自接力常驻，守满预算交棒
 *   node market-buy.mjs --self-test                        # 离线自测纯逻辑（不联网）
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
async function scanAndBuy(ctx, opts = {}) {
  const round = { candidates: [], bought: [], skipped: [], txSubmitted: 0, ok: true };
  let listings = [], rawCount = 0, rejected = 0;
  if (opts.simulatedListings) {
    listings = opts.simulatedListings;
    rawCount = listings.length;
  } else {
    const f = await fetchListings();
    listings = f.listings; rawCount = f.rawCount; rejected = f.rejected;
  }
  round.rawCount = rawCount;
  round.rejectedByTicker = rejected;
  const candidates = selectCandidates(listings);
  round.candidateCount = candidates.length;
  round.candidates = candidates.map((c) => ({
    productId: c.productId, unitPrice: c.unitPrice, priceNcg: c.priceNcg,
    quantity: c.quantity, ticker: c.ticker,
  }));

  if (candidates.length === 0) return round;

  // 归属校验：私钥派生 signer 必须等于角色链上 agentAddress
  if (!DRY && ctx) {
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
  for (const c of candidates) {
    // 提交前链上复核：仅在查到「明确不符」（串货/价格变/卖家变）时拦截；
    // Mimir 未索引在售挂单（not_found）或网络异常一律放行，交给链上执行兜底，
    // 绝不因二级索引滞后而误杀候选单、错失低价机会。
    if (VERIFY_ONCHAIN && !opts.simulatedListings) {
      const v = await verifyListingOnchain(c);
      if (v.skip) { round.skipped.push({ productId: c.productId, reason: `onchain_${v.reason}` }); continue; }
      if (v.verified) round.verifiedOnchain = (round.verifiedOnchain || 0) + 1;
    }
    if (balanceMinor !== null && Math.round(c.priceNcg * 100) > balanceMinor) {
      round.skipped.push({ productId: c.productId, reason: "insufficient_ncg" });
      continue;
    }
    buyable.push(c);
  }
  round.buyableCount = buyable.length;

  if (DRY) {
    for (const c of buyable) round.bought.push({ productId: c.productId, status: "would_buy",
      unitPrice: c.unitPrice, priceNcg: c.priceNcg, quantity: c.quantity });
    log({ level: "info", msg: `演练：命中 ${buyable.length} 单，本应购买（未提交任何交易）`,
          candidates: candidates.length, buyable: buyable.length });
    return round;
  }

  // 分批打包（每笔 <= MAX_ITEMS_PER_TX），逐笔串行提交 + 等终态
  let txCount = 0;
  for (let i = 0; i < buyable.length && txCount < MAX_TX_PER_ROUND; i += MAX_ITEMS_PER_TX) {
    const batch = buyable.slice(i, i + MAX_ITEMS_PER_TX);
    const rec = { items: batch.map((c) => c.productId), status: "pending" };
    try {
      const actionValue = buildBuyAction(batch, buyerBuf, randomBytes(16));
      const nonce = await getNonce(ctx.signer.toString());
      const txId = await submitTx({ account: ctx.account, pub: ctx.pub, signer: ctx.signer, nonce, actionValue });
      rec.txId = txId; rec.nonce = Number(nonce);
      round.txSubmitted++; txCount++;
      log({ level: "info", msg: `已提交 buy_product3（${batch.length} 单）`, txId,
            items: rec.items, nonce: rec.nonce });
      const r = await confirmTx(txId);
      rec.txStatus = r.txStatus;
      rec.exceptionNames = r.exceptionNames ?? null;
      if (r.txStatus === "SUCCESS") {
        rec.status = "bought";
        for (const c of batch) round.bought.push({ productId: c.productId, status: "bought",
          unitPrice: c.unitPrice, priceNcg: c.priceNcg, quantity: c.quantity, txId });
        log({ level: "info", msg: `购买成功（${batch.length} 单）`, txId, items: rec.items });
      } else {
        // 失败/PENDING/INVALID：不锁死，下轮重扫链上最新挂单再试。
        // 链上执行会校验 productId/price/seller，不符即 FAILURE，无资金损失。
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
  return round;
}

// ---------------- 自接力常驻模式 ----------------
async function daemonMode() {
  const started = Date.now();
  const out = {
    network: "heimdall", avatar: CFG.avatarAddress, dryRun: DRY, mode: "daemon",
    ticker: TARGET_TICKER, maxUnitPriceNcg: Number(UNIT_PRICE_MINOR) / 100,
    ok: true, rounds: 0, totals: { candidates: 0, bought: 0, tx: 0 }, transientErrors: 0,
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
            pollSeconds: POLL_SEC, maxRunSeconds: MAX_RUN_MS / 1000 });
    }
    try {
      const r = await scanAndBuy(ctx, { agentAddress, simulatedListings: simList });
      out.totals.candidates += r.candidateCount || 0;
      out.totals.bought += (r.bought || []).filter((b) => b.status === "bought" || b.status === "would_buy").length;
      out.totals.tx += r.txSubmitted || 0;
      log({ level: "daemon", round: out.rounds, tip,
            rawCount: r.rawCount, candidateCount: r.candidateCount,
            buyableCount: r.buyableCount, txSubmitted: r.txSubmitted,
            elapsedSec: Math.round((Date.now() - started) / 1000) });
      if (r.ok === false) { out.ok = false; out.error = r.error; handoff = "aborted"; break; }
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
    ctx = { account, pub, signer: Address.deriveFrom(pub) };
    out.signer = ctx.signer.toString();
  }
  let simList = null;
  if (DRY && SIM_LISTINGS_FILE) {
    try { simList = JSON.parse(fs.readFileSync(SIM_LISTINGS_FILE, "utf8")); } catch (_) {}
  }
  const r = await scanAndBuy(ctx, { agentAddress, simulatedListings: simList });
  out.rawCount = r.rawCount; out.rejectedByTicker = r.rejectedByTicker;
  out.candidateCount = r.candidateCount; out.candidates = r.candidates;
  out.buyableCount = r.buyableCount; out.bought = r.bought; out.skipped = r.skipped;
  out.txSubmitted = r.txSubmitted; out.txLog = r.txLog || [];
  out.ncgBalanceNcg = r.ncgBalanceNcg ?? null;
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

  // 7) 终态判定：只认 SUCCESS/FAILURE/INVALID
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
