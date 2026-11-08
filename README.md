# 9C 巡逻奖励 / 日常奖励 自动领取（Heimdall）

自动代替你打开 App 点「Get Reward」和「Daily Reward」。
链上所有东西都是交易，领取 = 用角色所属 agent 的私钥签名并提交一笔交易。
本项目已在真实 Heimdall 网络上端到端验证：构造 → 签名 → `stageTransaction` → 上链确认。

> **部署看 [`DEPLOY.md`](DEPLOY.md)（全新安装）；最终架构与上线实录看 [`TRIGGER.md`](TRIGGER.md)。**
> **已于 2026-11-08 15:00 上线并端到端实测通过**（点火 → 第一跳自接力成功，WorkBuddy 任务已停用）。
> 本文件只讲原理、输出格式和命令速查。当前线上架构是「**纯 GitHub 自接力长链**」：
> 一个常驻 job 在内部按链上区块自等待、到期即领、跨多个周期；预算耗尽后用
> `workflow_dispatch` 触发下一个常驻 job 无缝接棒，**完全不依赖 WorkBuddy / 外部闹钟**。

---

## 一、原理（很重要）

- **周期不是墙上时钟，是区块数**：
  - 日常奖励 `daily_reward7`：间隔 `2550` 块 × 8 秒 ≈ 5 小时 40 分
  - 巡逻奖励 `claim_patrol_reward`：间隔 `5400` 块 × 8 秒 ≈ 12 小时
  - 出块有波动，所以脚本**每次都读链上当前 tip 与解锁区块**，到了才提交，不按固定小时数盲发。
- **巡逻奖励不累积**：满了不领，下一轮不开始计时。所以漏领是纯损失，自动化才有价值。
- **单笔交易只允许 1 个 action**（实测 `has too many actions: 2`），两个奖励必须分两笔串行提交。
- **判断可领取的依据**：
  - 日常：`stateQuery.avatar.dailyRewardReceivedIndex + 2550 <= tip`（链上权威状态，不受失败交易影响）
  - 巡逻：9CAPI `/PatrolUnblockIndexHeimdall` 返回的 `patrolClaimBlock`；该接口故障时回退到 Mimir 最近领取记录 + 5400
- **归属校验**：私钥派生的地址必须等于角色链上的 `agentAddress`，否则提交前直接拦截，避免白烧 gas/nonce。导入工具 `import-key.mjs` 与运行时的 `claim.mjs` 都会校验。

---

## 二、部署方式（选一种）

| 方式 | 说明 | 私钥在哪 |
|---|---|---|
| **A. GitHub Actions（推荐，当前使用）** | 见 `DEPLOY.md`。代码由仓库提供、密钥由 Secrets 注入、每次全新 runner，天然适配「隔离沙箱」 | GitHub 加密 Secrets，运行时临时解密，runner 销毁即消失 |
| **C. 本地 / 常开服务器 cron** | 见 `DEPLOY.md` 第五节。私钥完全不离机，但要自己装 Node、配调度、机器常开 | 本机 `.env`（600） |

**WorkBuddy 云端定时任务不能跑脚本**：那种任务每次唤起的是一个全新隔离沙箱，`/workspace` 是会话级临时盘，看不到上一次会话写的脚本和私钥（实测报 `run.sh: No such file or directory`）。**最终架构已完全去掉 WorkBuddy**：GitHub Actions 自己接力自己，不再需要任何外部按按钮。`run.sh` 仅为本地 cron 方案保留。

**两种部署的行为差异**：

- **GitHub Actions（当前方案）**：workflow 调 `claim.mjs --daemon`。一个 job 常驻 5.5 小时（< 单 job 6h 上限），每轮读链上解锁块，按剩余区块数休眠（单次 ≤ 15 分钟、醒后重算），剩 40 块起每 1 分钟重读 tip，到期立即提交；**领完不退出**，锁住该解锁块等链上刷新到下一周期后继续。预算耗尽时正常交棒，由「接力」step 用 workflow_dispatch 触发下一个常驻 job（concurrency 同组排队无缝接上）。**领取精度 ±1 分钟，与闹钟准时性无关**；schedule 只作断链重燃。参数与验证见 `TRIGGER.md`。
- **本地 cron**：磁盘持久，`.state.json` 解锁块缓存能正常生效：远离解锁窗口时只发 1 个 tip 请求就 `idle_skip` 退出，进入窗口或缓存失效时才做完整检查。缓存只用于提前跳过，**绝不用于提交判断**；领取成功后删除缓存，下一轮强制从链上刷新到新周期。
- `--watch`（窗口蹲守：临近自等待、领完即止）与不带参数的**一次性检查模式仍完整保留**，供本地调用、调试与旧版 workflow 兼容。

---

## 三、文件说明

| 文件 | 作用 |
|---|---|
| `claim.mjs` | 主程序：一次性检查 + `--watch` 蹲守 + `--daemon` 自接力常驻，输出结构化 JSON |
| `import-key.mjs` | 私钥导入：keystore JSON / hex / 助记词 → `.env`，并校验归属 |
| `package.json` / `package-lock.json` | 依赖锁定（`npm ci` 必需，缺 lock 文件会失败） |
| `.github/workflows/claim.yml` | GitHub Actions 领奖任务（`--daemon` 常驻 + 接力 step + schedule 重燃 + 手动验证） |
| `.github/workflows/keepalive.yml` | 每周空提交，防止 GitHub 60 天无活动自动停用定时任务 |
| `run.sh` | 本地 cron 入口：加锁防重、日志轮转 |
| `DEPLOY.md` | 全新部署指南（零基础逐步操作） |
| `TRIGGER.md` | **最终架构、参数、验证结果与上线实录** |
| `workflows-to-paste.txt` | 两段纯 YAML 的可复制副本（用于网页编辑 workflow） |
| `.gitignore` | 排除 `.env` / keystore / 密码 / 缓存 / `node_modules` |
| `.env` | 你的配置（含私钥），权限 600，**由导入工具生成，不要手动提交/分享** |
| `.state.json` | 解锁块缓存（**不含私钥**），仅供本地一次性模式窗口早退；云端不使用 |

---

## 四、输出格式

一次性模式顶层 `status`：`idle_skip`（本地窗口早退）/ `checked`（完整检查）。

蹲守模式（`mode:"watch"`）顶层 `status`：
`idle_skip`（远离窗口秒退）/ `dry_plan`（演练，不休眠）/ `claimed_and_stop`（领完即止）/
`all_claimed`（两项都领到）/ `watch_timeout`（硬超时退出）/ `unknown` /
`claim_problem`（提交失败）/ `snapshot_error` / `aborted`（私钥不匹配）。
蹲守过程会逐轮打印 `{"level":"watch","phase":"sleep"|"poll","remaining":…,"sleepSec":…}`。

自接力常驻模式（`mode:"daemon"`）顶层 `status` / `handoff`：
`budget_exhausted`（预算耗尽、**正常交棒**，workflow 接力 step 只认这个标记）/
`dry_plan` / `aborted` / `snapshot_error`；逐轮打印
`{"level":"daemon","phase":"sleep"|"poll"|"wait_refresh","round":…,"cycles":{…}}`，
领取时打印 `{"level":"daemon","phase":"claimed","reward":…,"cycle":…}`。
`rewards[].cycles` 是本次 job 内该奖励走过的周期数。

`rewards[].status`：`claimed`（成功）/ `not_ready`（未到时间）/
`pending`（已提交但确认未出终态，**不锁定、冷却后按链上状态复核重提**）/
`failed` / `error` / `unknown` / `would_claim`（dry-run）/ `not_reached`（本轮未处理）。

> **只认链上、不认回执**：`confirmTx` 只在 `SUCCESS` / `FAILURE` / `INVALID` 终态下结论；
> `INCLUDED` / `STAGING` 是中间态（后续可能变成功也可能变失败），一律继续轮询，
> 超时返回 `PENDING`。除「领取成功」外的任何结果都不锁定解锁块，链上没刷新就重提；
> 幂等锁另有 30 分钟 TTL 兜底，到期仍未刷新会主动解锁复核。链上有幂等保护，
> 重复提交最多成功一笔，其余 `FAILURE` 无副作用 —— 宁可多提，绝不漏领一个周期。

`cache`：`refreshed` / `cleared_after_claim` / `cleared_retry`（**仅本地一次性模式有意义**）。

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

# ---- 一次性检查（本地 / 兼容调用）----
node claim.mjs --dry-run                   # 完整检查，不提交任何交易（安全）
node claim.mjs                             # 检查并领取两种（本地含窗口早退）
node claim.mjs --no-idle-skip               # 强制完整检查并领取
node claim.mjs --window-blocks 300          # 自定义一次性模式的早退窗口（块）
node claim.mjs --reward daily               # 只处理日常
node claim.mjs --reward patrol              # 只处理巡逻

# ---- 蹲守模式（--watch，调试用）----
node claim.mjs --watch                     # 真实：远离秒退、窗口内自等待、领完即止
node claim.mjs --watch --dry-run           # 演练：不休眠、不提交，输出计划
node claim.mjs --watch --watch-window 1200 # 自定义蹲守窗口（块，默认 900）

# ---- 自接力常驻模式（--daemon，GitHub Actions 正式使用）----
node claim.mjs --daemon                    # 真实：常驻 5.5h、跨多周期、预算耗尽交棒
node claim.mjs --daemon --dry-run          # 演练：只规划一轮，不真睡、不提交
node claim.mjs --daemon --max-run-seconds 19800   # 自定义预算（秒，须 < 6h）
node claim.mjs --self-test                 # 离线自测休眠策略纯逻辑

# ---- 本地 cron 入口 ----
bash run.sh --dry-run
tail -f claim.log
```

> 演练钩子（**仅在 `--dry-run` 下生效**）：
> - `--simulate-unblock-delta N` 把解锁块伪装成「当前 tip + N 块」；
> - `--simulate-tip-step N` 每轮让 tip 前进 N 块、`--simulate-cycle-blocks N` 领取后跳到下一周期，
>   配合 `--poll-seconds 1 --max-run-seconds 18` 可在十几秒内走完**多个完整周期 + 正常交棒**；
> - 纯离线、不联网、不提交任何交易。

---

## 六、安全与边界（务必读）

1. **私钥 = 账户全部资产**。强烈建议用**只放少量资产的专门挂机角色**，不要放主号。
2. **keystore 是加密的**，且密码与文件分开存放；`.env` **绝不要**提交到 git、贴进聊天、发给任何人。脚本不会打印私钥，日志里也没有。
3. GitHub 方案里明文私钥只在 runner 内存中短暂存在，不进仓库、不进日志、不落持久盘。
4. **失败交易会回滚**，但会消耗少量 gas/nonce，所以做了归属校验与「到点才提交」。
5. 依赖第三方：Heimdall RPC（2 个节点 failover）、Mimir、9CAPI。任一短暂不可用会跳过本轮，下轮重试，不会误领。
6. GitHub 方案注意：**必须用公开仓库**（免费且不限分钟数）。自接力长链接近 24/7 常驻 ≈ 43200 分钟/月，**私有仓库会远远超出免费额度**。**60 天无「仓库活动」会自动停用定时任务**（workflow run 不算活动，包里的 `keepalive.yml` 用于保活）。详见 `DEPLOY.md` 第三节。
7. `concurrency` 的 `cancel-in-progress: false` **不能改成 true**：否则后来的一次触发会掐掉正在常驻的 job。
8. 接力 step 需要 `permissions: actions: write`（已在 `claim.yml` 声明）；可选 Secret `NC_DISPATCH_TOKEN` 可加固接力，详见 `TRIGGER.md`。
8. 自动领取属个人便利工具，请自行确认是否符合游戏服务条款。
9. 想停止：GitHub 里禁用 workflow（或删 `claim.yml`）；本地方案删掉 crontab 行即可。
