# 9C 巡逻奖励 / 日常奖励 自动领取（Heimdall）

自动代替你打开 App 点「Get Reward」和「Daily Reward」。
链上所有东西都是交易，领取 = 用角色所属 agent 的私钥签名并提交一笔交易。
本项目已在真实 Heimdall 网络上端到端验证：构造 → 签名 → `stageTransaction` → 上链确认。

> **部署请直接看 [`DEPLOY.md`](DEPLOY.md)**（GitHub Actions 方案，附零基础逐步操作）。
> 本文件只讲原理、输出格式和命令速查，不含部署步骤。

---

## 一、原理（很重要）

- **周期不是墙上时钟，是区块数**：
  - 日常奖励 `daily_reward7`：间隔 `2550` 块 × 8 秒 ≈ 5 小时 40 分
  - 巡逻奖励 `claim_patrol_reward`：间隔 `5400` 块 × 8 秒 ≈ 12 小时
  - 出块有波动，所以脚本**每次运行都读链上当前 tip 与解锁区块**，到了才提交，不按固定小时数盲发。
- **巡逻奖励不累积**：满了不领，下一轮不开始计时。所以漏领是纯损失，自动化才有价值。
- **单笔交易只允许 1 个 action**（实测 `has too many actions: 2`），两个奖励必须分两笔提交。
- **判断可领取的依据**：
  - 日常：`stateQuery.avatar.dailyRewardReceivedIndex + 2550 <= tip`（链上权威状态，不受失败交易影响）
  - 巡逻：9CAPI `/PatrolUnblockIndexHeimdall` 返回的 `patrolClaimBlock`；该接口故障时回退到 Mimir 最近领取记录 + 5400
- **归属校验**：私钥派生的地址必须等于角色链上的 `agentAddress`，否则提交前直接拦截，避免白烧 gas/nonce。导入工具 `import-key.mjs` 与运行时的 `claim.mjs` 都会校验。

---

## 二、部署方式（选一种）

| 方式 | 说明 | 私钥在哪 |
|---|---|---|
| **A. GitHub Actions（推荐）** | 见 `DEPLOY.md`。代码由仓库提供、密钥由 Secrets 注入、每次全新 runner，天然适配「隔离沙箱」 | GitHub 加密 Secrets，运行时临时解密，runner 销毁即消失 |
| **C. 本地 / 常开服务器 cron** | 见 `DEPLOY.md` 第五节。私钥完全不离机，但要自己装 Node、配调度、机器常开 | 本机 `.env`（600） |

**WorkBuddy 云端定时任务不可用**：那种任务每次唤起的是一个全新隔离沙箱，`/workspace` 是会话级临时盘，看不到上一次会话写的脚本和私钥（实测报 `run.sh: No such file or directory`）。`run.sh` 仅为本地 cron 方案保留。

**两种部署的行为差异**：

- GitHub Actions 每次 runner 全新、`.state.json` 不跨运行持久，所以 workflow 用 `--no-idle-skip` **每次做完整链上检查**（约 5~8 秒），最稳、不会漏领。
- 本地 cron 磁盘持久，`.state.json` 解锁块缓存能正常生效：远离解锁窗口时只发 1 个 tip 请求就 `idle_skip` 退出（约 1 秒），进入窗口或缓存失效时才做完整检查。缓存只用于提前跳过，**绝不用于提交判断**；领取成功后删除缓存，下一轮强制从链上刷新到新周期。

---

## 三、文件说明

| 文件 | 作用 |
|---|---|
| `claim.mjs` | 主程序：检查 + 领取，输出结构化 JSON |
| `import-key.mjs` | 私钥导入：keystore JSON / hex / 助记词 → `.env`，并校验归属 |
| `package.json` / `package-lock.json` | 依赖锁定（`npm ci` 必需，缺 lock 文件会失败） |
| `.github/workflows/claim.yml` | GitHub Actions 领奖任务（每 15 分钟 + 手动验证） |
| `.github/workflows/keepalive.yml` | 每周空提交，防止 GitHub 60 天无活动自动停用定时任务 |
| `run.sh` | 本地 cron 入口：加锁防重、日志轮转 |
| `DEPLOY.md` | 部署指南 |
| `.gitignore` | 排除 `.env` / keystore / 密码 / 缓存 / `node_modules` |
| `.env` | 你的配置（含私钥），权限 600，**由导入工具生成，不要手动提交/分享** |
| `.state.json` | 解锁块缓存（**不含私钥**），仅供本地窗口早退；可随时删除 |

---

## 四、输出格式

顶层 `status`：`idle_skip`（本地窗口早退）/ `checked`（完整检查）。

`rewards[].status`：`claimed`（成功）/ `not_ready`（未到时间）/ `failed`（交易失败）/
`error`（异常）/ `unknown`（状态读取失败，保守跳过）/ `would_claim`（dry-run）。

`cache`：`refreshed` / `cleared_after_claim` / `cleared_retry`（仅本地方案有意义）。

完整检查示例：

```json
{
  "network": "heimdall",
  "avatar": "0xAC9D...A21c",
  "status": "checked",
  "tip": 11736952,
  "agentAddress": "0x491b...c3f",
  "rewards": [
    { "reward": "daily",  "unblockBlock": 11737669, "blocksRemaining": 717, "status": "not_ready" },
    { "reward": "patrol", "unblockBlock": 11737565, "blocksRemaining": 613, "status": "not_ready" }
  ],
  "ok": true
}
```

`ok:false` 或出现 `failed` / `error` 表示本轮有问题，退出码为 1。

---

## 五、命令速查

```bash
npm ci --omit=dev                          # 安装依赖（首次）

# 导入私钥（任选其一；工具会校验归属，不匹配则拒绝写 .env）
node import-key.mjs --keystore <文件> --passphrase-file <密码文件>
node import-key.mjs --hex <64位hex>
node import-key.mjs --mnemonic "word1 word2 ... word12"
# 角色不是默认地址时加： --avatar 0x你的角色地址

node claim.mjs --dry-run                   # 完整检查，不提交任何交易（安全）
node claim.mjs --dry-run --no-idle-skip    # GitHub Actions 首次验证用的组合
node claim.mjs                             # 检查并领取两种（本地含窗口早退）
node claim.mjs --no-idle-skip               # 强制完整检查并领取
node claim.mjs --window-blocks 300          # 自定义窗口宽度（块）
node claim.mjs --reward daily               # 只领日常
node claim.mjs --reward patrol              # 只领巡逻
bash run.sh --dry-run                       # 走本地入口（含日志）
tail -f claim.log                           # 看日志
```

---

## 六、安全与边界（务必读）

1. **私钥 = 账户全部资产**。强烈建议用**只放少量资产的专门挂机角色**，不要放主号。
2. **keystore 是加密的**，且密码与文件分开存放；`.env` **绝不要**提交到 git、贴进聊天、发给任何人。脚本不会打印私钥，日志里也没有。
3. GitHub 方案里明文私钥只在 runner 内存中短暂存在，不进仓库、不进日志、不落持久盘。
4. **失败交易会回滚**，但会消耗少量 gas/nonce，所以做了归属校验与「到点才提交」。
5. 依赖第三方：Heimdall RPC（2 个节点 failover）、Mimir、9CAPI。任一短暂不可用会跳过本轮，下轮重试，不会误领。
6. GitHub 方案注意：**公开仓库免费**，私有仓库每 15 分钟会超出免费额度；**60 天无活动会自动停用定时任务**（包里的 `keepalive.yml` 用于保活）。详见 `DEPLOY.md` 第三节。
7. 自动领取属个人便利工具，请自行确认是否符合游戏服务条款。
8. 想停止：GitHub 里禁用 workflow（或删 `claim.yml`）；本地方案删掉 crontab 行即可。
