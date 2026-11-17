#!/usr/bin/env node
// 9C 扫货「跨运行总花费」监控（配合当前会话后台提醒使用）
//
// 目的：daemon 在 GitHub Actions 云端跑、每轮运行内累计花费会重置，本地看不到；
//       本脚本以「链上」为唯一数据源，统计启动基线之后所有 buy_product3 SUCCESS
//       真正花掉的 NCG，跨多次 daemon 运行持续累加；一旦累计 > 阈值就输出醒目提醒标记。
//
// 数据源：Mimir transactions(filter.avatarAddress) —— 所有扫货交易的 avatar 都固定。
//     每笔 buy_product3 的 action.values.p 是本次买到的商品数组，
//     每项 [tradableId, [currency, minor], ...]；currency.get("ticker") 必须是 NCG，
//     minor 是 BigInt（NCG×100）。sum(minor)/100 = 该笔 NCG 花费。
//
// 去重：用交易 id(txId)。状态持久化到 --state-file，重启不重复计数、不漏计。
// 基线：首次运行记录当前 tip blockIndex，只统计 baseline+1 之后上链的交易。
//       如需把「之前某时刻起」也算进来，可用 --baseline-block 显式指定。
//
// 输出：
//   常规轮询打印一行 JSON 状态（含 spentNcg / threshold / newTx 等），便于观察。
//   超过阈值时打印一行包含 "SPEND_ALERT" 的 JSON（只打印一次，除非 --alert-repeat）。
//
// 用法：
//   node spend-watch.mjs --self-test
//   node spend-watch.mjs --dry-run                    # 只读跑一次，打印当前累计，不常驻
//   node spend-watch.mjs                              # 常驻轮询（默认 30s）
//   node spend-watch.mjs --threshold 300 --poll-seconds 30
//   node spend-watch.mjs --baseline-block 11844985    # 从指定区块之后算（含刚才两笔之前的起点）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode, decode, BencodexDictionary } from "@planetarium/bencodex";

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

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");
const DRY = args.includes("--dry-run");
const numArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : def;
};
const strArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const AVATAR = strArg("--avatar", ENV.NC_AVATAR || "0xAC9D450C69dF27ee290C90EC61c4B76154b0A21c");
const MIMIR = strArg("--mimir", "https://mimir.nine-chronicles.dev/heimdall/graphql/");
const THRESHOLD_NCG = Math.max(0, numArg("--threshold", 300));
const POLL_MS = Math.max(5, Math.trunc(numArg("--poll-seconds", 30))) * 1000;
const TAKE = Math.max(20, Math.min(500, Math.trunc(numArg("--take", 200))));
const FETCH_TIMEOUT_MS = Math.max(10000, Math.trunc(numArg("--fetch-timeout-ms", 45000)));
const STATE_FILE = strArg("--state-file", path.join(DIR, ".spend-watch-state.json"));
const BASELINE_BLOCK_ARG = args.includes("--baseline-block") ? Math.trunc(numArg("--baseline-block", 0)) : null;
const ALERT_REPEAT = args.includes("--alert-repeat");

const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

// ---------------- 核心：从 action raw 解析 NCG 花费（纯函数，可自测） ----------------
// 返回 { ok:true, minor:bigint } 或 { ok:false, reason }
function parseBuyNcgMinor(rawHex, { typeId = "buy_product3", ncgTicker = "NCG" } = {}) {
  try {
    const action = decode(Buffer.from(String(rawHex), "hex"));
    const values = action.get("values");
    if (!values || typeof values.get !== "function") return { ok: false, reason: "no_values" };
    const products = values.get("p");
    if (!Array.isArray(products)) return { ok: false, reason: "no_products" };
    let total = 0n;
    for (const item of products) {
      if (!Array.isArray(item) || item.length < 2) return { ok: false, reason: "bad_item" };
      const fav = item[1];
      if (!Array.isArray(fav) || fav.length < 2) return { ok: false, reason: "bad_fav" };
      const currency = fav[0];
      const minor = fav[1];
      // currency 是 BencodexDictionary，ticker 必须是 NCG，避免把别的货币算进来
      const ticker = currency && typeof currency.get === "function" ? String(currency.get("ticker")) : "";
      if (ticker !== ncgTicker) return { ok: false, reason: "not_ncg:" + ticker };
      if (typeof minor !== "bigint") return { ok: false, reason: "minor_not_bigint" };
      total += minor;
    }
    return { ok: true, minor: total };
  } catch (e) {
    return { ok: false, reason: "decode:" + String(e.message).slice(0, 80) };
  }
}
const minorToNcg = (minor) => Number(BigInt(minor)) / 100;

// ---------------- 状态持久化 ----------------
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!s || typeof s !== "object") return null;
    return s;
  } catch { return null; }
}
function saveState(s) {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------------- 链上查询 ----------------
// 真实 tip 用 Heimdall RPC（nodeStatus.tip.index）；Mimir 没有该字段，用交易最大块作回退。
async function fetchTip() {
  const urls = ["https://heimdall-rpc-1.nine-chronicles.com/graphql", "https://heimdall6.9capi.com/graphql"];
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      let j;
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "{ nodeStatus { tip { index } } }" }), signal: ctrl.signal });
        j = await r.json();
      } finally { clearTimeout(t); }
      if (!j.errors && j.data?.nodeStatus?.tip?.index != null) return Number(j.data.nodeStatus.tip.index);
    } catch { /* 换下一个 */ }
  }
  return null;
}
async function approximateTip() {
  const tip = await fetchTip();
  if (tip != null) return tip;
  const items = await fetchBuyTxs();
  let max = 0;
  for (const it of items) max = Math.max(max, Number(it.blockIndex) || 0);
  return max;
}

async function fetchBuyTxs() {
  const q = `query($a:Address!,$take:Int!){
    transactions(filter:{avatarAddress:$a},take:$take){
      items { blockIndex id object { txStatus actions { typeId raw } } }
    }
  }`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(MIMIR, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, variables: { a: AVATAR, take: TAKE } }), signal: ctrl.signal });
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 120));
    return (j.data?.transactions?.items) || [];
  } finally { clearTimeout(t); }
}

// 扫描一批交易，返回本批新增花费（minor）、新增 tx 列表、以及是否碰到基线边界（可提前停）
function scanBatch(items, state) {
  let newMinor = 0n;
  const added = [];
  const seen = new Set(state.seenTxIds || []);
  const buyTxIds = new Set(state.buyTxIds || []);
  for (const it of items) {
    const blk = Number(it.blockIndex);
    if (state.baselineBlock != null && blk <= state.baselineBlock) continue; // 基线之前，跳过
    const txId = it.id;
    if (!txId || seen.has(txId)) continue;
    const acts = (it.object?.actions) || [];
    let txMinor = 0n;
    let hasBuy = false;
    for (const ac of acts) {
      if (ac.typeId !== "buy_product3" || !ac.raw) continue;
      if (it.object?.txStatus !== "SUCCESS") continue;   // 只认链上 SUCCESS
      const parsed = parseBuyNcgMinor(ac.raw);
      if (!parsed.ok) continue;
      txMinor += parsed.minor;
      hasBuy = true;
    }
    // 非 buy 交易也记入 seen（避免每次都重新遍历老交易），但不计花费
    seen.add(txId);
    if (hasBuy && txMinor > 0n) {
      newMinor += txMinor;
      buyTxIds.add(txId);
      added.push({ txId, blockIndex: blk, ncg: minorToNcg(txMinor) });
    }
  }
  state.seenTxIds = [...seen].slice(-2000);   // 控制体积
  state.buyTxIds = [...buyTxIds].slice(-2000);
  return { newMinor, added };
}

async function pollOnce(state) {
  const items = await fetchBuyTxs();
  const { newMinor, added } = scanBatch(items, state);
  state.spentMinor = (BigInt(state.spentMinor || 0) + newMinor).toString();
  state.lastPoll = new Date().toISOString();
  const spentNcg = minorToNcg(state.spentMinor);
  const crossed = spentNcg > THRESHOLD_NCG;
  const shouldAlert = crossed && (ALERT_REPEAT || !state.alerted);
  if (shouldAlert) state.alerted = true;
  saveState(state);
  log({ event: "status", avatar: AVATAR, baselineBlock: state.baselineBlock,
        spentNcg, thresholdNcg: THRESHOLD_NCG, newTx: added, buyTxCount: (state.buyTxIds || []).length,
        alerted: !!state.alerted });
  if (shouldAlert) {
    log({ event: "SPEND_ALERT", msg: `⚠️ 扫货跨运行累计花费已超过 ${THRESHOLD_NCG} NCG`,
          spentNcg, thresholdNcg: THRESHOLD_NCG });
  }
  return { spentNcg, crossed, added };
}

async function initState() {
  let s = loadState();
  if (!s) {
    const tip = BASELINE_BLOCK_ARG != null ? BASELINE_BLOCK_ARG : await approximateTip();
    s = { baselineBlock: tip, spentMinor: "0", seenTxIds: [], alerted: false, createdAt: new Date().toISOString() };
    saveState(s);
  }
  return s;
}

// ---------------- 自测 ----------------
function selfTest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  [OK]   ${name}`); }
    else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
  };
  // 用真实 bencodex 编码构造 action raw，走完整 decode 路径（就是链上真实的样子）
  const ncgCurrency = () => new BencodexDictionary([
    ["decimalPlaces", Buffer.from([2])], ["minters", null], ["ticker", "NCG"],
  ]);
  const otherCurrency = () => new BencodexDictionary([
    ["decimalPlaces", Buffer.from([2])], ["minters", null], ["ticker", "OTHER"],
  ]);
  const mkItem = (minor, cur = ncgCurrency()) => [Buffer.alloc(16, 1), [cur, BigInt(minor)], "NonFungible"];
  const rawOf = (items) => Buffer.from(encode(new BencodexDictionary([
    ["type_id", "buy_product3"], ["values", new BencodexDictionary([["a", Buffer.alloc(20, 9)],
      ["id", Buffer.alloc(16, 8)], ["p", items]])],
  ]))).toString("hex");
  const spent = (items) => { const r = parseBuyNcgMinor(rawOf(items)); return r.ok ? minorToNcg(r.minor) : ("ERR:" + r.reason); };
  ok("单件 2NCG=200minor", spent([mkItem(200)]) === 2, String(spent([mkItem(200)])));
  ok("15件合计30NCG", spent(Array.from({ length: 15 }, () => mkItem(200))) === 30);
  ok("混合件数累计4NCG", spent([mkItem(200), mkItem(150), mkItem(50)]) === 4);
  ok("空 p 列表=0", spent([]) === 0);
  ok("非NCG货币被拒", (() => { const r = parseBuyNcgMinor(rawOf([mkItem(200, otherCurrency())])); return !r.ok && r.reason.startsWith("not_ncg"); })());
  ok("坏 raw 返回失败", !parseBuyNcgMinor("zzzz").ok);
  ok("轮询间隔单位是秒(默认30s)", POLL_MS === 30000, `POLL_MS=${POLL_MS}`);
  // scanBatch 去重 / 基线 / 只认 SUCCESS
  const base = { baselineBlock: 100, spentMinor: "0", seenTxIds: [] };
  const mkTx = (id, blk, status, minor) => ({ id, blockIndex: blk, object: { txStatus: status,
    actions: minor == null ? [{ typeId: "transfer", raw: "" }] : [{ typeId: "buy_product3", raw: "RAW:" + minor }] } });
  // 注入一个假的 parse 以便 scanBatch 测数值（用 monkey: 直接改 raw 编码不可行，改用真实 parse 测试另一路）
  // 这里只测去重与基线：用 parse 无法识别的 raw，newMinor 应为 0，但 seen 会记录
  const s2 = JSON.parse(JSON.stringify(base));
  const r1 = scanBatch([mkTx("t1", 101, "SUCCESS", "bad"), mkTx("t0", 99, "SUCCESS", "bad")], s2);
  ok("基线之前的交易被跳过", r1.added.length === 0 && !s2.seenTxIds.includes("t0"), JSON.stringify(s2.seenTxIds));
  ok("基线之后的交易记入 seen", s2.seenTxIds.includes("t1"));
  const r2 = scanBatch([mkTx("t1", 101, "SUCCESS", "bad")], s2);
  ok("同一 txId 不重复计数", r2.added.length === 0);
  console.log(`\n  self-test: ${pass}/${pass + fail} 通过`);
  if (fail) process.exit(1);
}
// ---------------- 主流程 ----------------
async function main() {
  if (SELF_TEST) return selfTest();
  const state = await initState();
  if (DRY) { await pollOnce(state); return; }
  log({ event: "watch_start", avatar: AVATAR, baselineBlock: state.baselineBlock,
        spentNcg: minorToNcg(state.spentMinor), thresholdNcg: THRESHOLD_NCG, pollSeconds: POLL_MS / 1000 });
  // 启动即先扫一次
  await pollOnce(state);
  // 常驻轮询；每次都重新 loadState，避免多进程写冲突（单实例场景足够）
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const cur = loadState() || state;
    try { await pollOnce(cur); }
    catch (e) { log({ event: "poll_error", error: String(e.message) }); }
  }
}
main().catch((e) => { log({ event: "fatal", error: String(e.stack || e.message) }); process.exit(1); });
