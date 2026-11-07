#!/usr/bin/env node
/**
 * 私钥导入工具 —— 把 App 导出的密钥转换成脚本可用的配置，并验证归属。
 * ----------------------------------------------------------------
 * 支持三种输入（任选其一）：
 *   1) hex 私钥：      node import-key.mjs --hex <64位hex>
 *   2) keystore JSON： node import-key.mjs --keystore <文件路径> --passphrase <密码>
 *   3) 助记词：        node import-key.mjs --mnemonic "<12或24个单词>"
 *
 * 工具会：
 *   - 派生出私钥与对应的 agent 地址
 *   - 从链上读取目标角色的 agentAddress，自动比对（助记词会尝试常见派生路径）
 *   - 匹配成功后把 hex 私钥写入 .env（权限 600），供 claim.mjs 读取
 *   - 全程不在终端/日志打印私钥明文
 *
 * 私钥仅落盘到本目录 .env，不上传、不进聊天、不进日志。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet, HDNodeWallet, Mnemonic } from "ethers";
import { RawPrivateKey, Address } from "@planetarium/account";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RPC = [
  "https://heimdall-rpc-1.nine-chronicles.com/graphql",
  "https://heimdall6.9capi.com/graphql",
];

const argv = process.argv.slice(2);
const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k) => argv.includes(k);

async function gql(url, query, variables = {}) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }) });
  return r.json();
}
async function agentAddressOf() {
  const av = get("--avatar") || process.env.NC_AVATAR || "0xAC9D450C69dF27ee290C90EC61c4B76154b0A21c";
  const q = "query($a:Address!){ stateQuery { avatar(avatarAddress:$a){ agentAddress name } } }";
  for (const u of RPC) {
    try {
      const d = await gql(u, q, { a: av });
      const x = d.data?.stateQuery?.avatar;
      if (x?.agentAddress) return { ...x, avatar: av };
    } catch (_) {}
  }
  return null;
}
async function derive(hexPriv) {
  const k = RawPrivateKey.fromHex(hexPriv.replace(/^0x/i, ""));
  const pub = await k.getPublicKey();
  return { hex: hexPriv.replace(/^0x/i, ""), agent: Address.deriveFrom(pub).toString() };
}

async function main() {
  const chain = await agentAddressOf();
  if (!chain) { console.log(JSON.stringify({ ok: false, error: "无法读取链上角色状态，检查网络/角色地址" })); process.exit(1); }
  console.log(`目标角色: ${chain.name || "?"} (${chain.avatar})`);
  console.log(`链上 agent: ${chain.agentAddress}`);

  let candidates = [];   // {hex, label}

  // 1) hex 私钥
  if (has("--hex")) {
    const h = (get("--hex") || "").trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("hex 私钥必须是 64 位十六进制");
    candidates.push({ hex: h, label: "hex" });
  }

  // 2) keystore JSON（Web3 Secret Storage，9C launcher 导出的格式）
  if (has("--keystore")) {
    const file = get("--keystore");
    // 密码可从文件读取（推荐：避免明文出现在命令行历史 / 进程列表 / 对话里）
    const passFile = get("--passphrase-file");
    const pass = passFile && fs.existsSync(passFile)
      ? fs.readFileSync(passFile, "utf8").replace(/\r?\n$/, "")
      : (get("--passphrase") ?? get("--password") ?? "");
    if (!file || !fs.existsSync(file)) throw new Error("keystore 文件不存在: " + file);
    const json = fs.readFileSync(file, "utf8");
    try {
      const w = await Wallet.fromEncryptedJson(json, pass);
      candidates.push({ hex: w.privateKey.slice(2), label: "keystore(ethers)" });
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: "keystore 解密失败（密码错误或非标准 V3 格式）", detail: String(e.message).slice(0, 160) }));
      console.log("提示：可改用 launcher / Chrono 导出的 hex 私钥（--hex），或提供 --mnemonic");
      process.exit(1);
    }
  }

  // 3) 助记词：尝试常见派生路径，用链上 agent 地址自动挑出正确的一条
  if (has("--mnemonic")) {
    const m = (get("--mnemonic") || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!Mnemonic.isValidMnemonic(m) && !has("--allow-raw")) {
      console.log(JSON.stringify({ ok: false, error: "助记词校验失败（BIP39 单词/校验位不匹配）" })); process.exit(1);
    }
    const paths = [
      "m/44'/60'/0'/0/0", "m/44'/1346'/0'/0/0", "m/44'/0'/0'/0/0",
      "m/44'/60'/0'/0", "m/44'/60'/0'", "m/44'/1346'/0'/0",
    ];
    for (let i = 0; i < 5; i++) paths.push(`m/44'/60'/0'/0/${i}`);
    for (const p of paths) {
      try { candidates.push({ hex: HDNodeWallet.fromPhrase(m, "", p).privateKey.slice(2), label: p }); }
      catch (_) {}
    }
    // 也尝试 BIP39 seed 前 32 字节直接作私钥（部分 Libplanet 工具的做法）
    try {
      const seed = Mnemonic.fromPhrase(m).computeSeed();
      candidates.push({ hex: Buffer.from(seed.slice(0, 32)).toString("hex"), label: "seed[0:32]" });
    } catch (_) {}
  }

  if (!candidates.length) {
    console.log(JSON.stringify({ ok: false, error: "未提供密钥：请用 --hex / --keystore / --mnemonic 之一" })); process.exit(1);
  }

  // 逐个派生并与链上 agent 比对
  let matched = null;
  const tried = [];
  for (const c of candidates) {
    try {
      const d = await derive(c.hex);
      tried.push({ label: c.label, agent: d.agent });
      if (d.agent.toLowerCase() === chain.agentAddress.toLowerCase()) { matched = { ...d, label: c.label }; break; }
    } catch (_) {}
  }

  if (!matched) {
    console.log(JSON.stringify({
      ok: false, error: "私钥与角色不匹配：没有任一候选能派生出链上的 agent 地址",
      hint: "请确认这是该角色的密钥；助记词可能需要指定 --path 或不同派生规则",
      tried: tried.slice(0, 12),
    }, null, 1));
    process.exit(1);
  }

  // 写入 .env（仅本地，权限 600）
  const envPath = path.join(DIR, ".env");
  const content = `# Nine Chronicles Heimdall 自动领取配置 —— 含私钥，切勿提交/分享\nNC_AVATAR=${chain.avatar}\nNC_PRIVATE_KEY=${matched.hex}\n`;
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);

  console.log(JSON.stringify({
    ok: true, matchedBy: matched.label, agent: matched.agent,
    envFile: envPath, permission: "600",
    msg: "配置完成。现在可运行: node claim.mjs --dry-run 验证，正式领取由定时任务调用。",
  }, null, 1));
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e.message) })); process.exit(1); });
