# 9C 自动挂机（Heimdall）：奖励领取 + 市场扫货

本仓库含**两条相互独立的纯 GitHub 自接力链**：

| 链 | workflow | 脚本 | 作用 |
|---|---|---|---|
| 领奖链 | `claim.yml` | `claim.mjs` | 自动领巡逻奖励 / 日常奖励（含 AP 满先 Sweep） |
| **扫货链** | **`market.yml`** | **`market-buy.mjs`** | 监控并自动低价购买 **Stun Rune (Adventure)**（单价 ≤ 0.2 NCG/件） |

两条链各有独立 `concurrency` 组、独立接力、共用同一 keystore Secrets，互不干扰。

**领奖链**：自动代替你打开 App 点「Get Reward」和「Daily Reward」。链上所有东西都是交易，领取 = 用角色所属 agent 的私钥签名并提交一笔交易。本项目已在真实 Heimdall 网络上端到端验证：构造 → 签名 → `stageTransaction` → 上链确认。

> **市场扫货功能详见第七节 [「七、市场扫货：Stun Rune (Adventure) 低价自动购买」](#七市场扫货stun-rune-adventure-低价自动购买)。**

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

### AP 满时先 Sweep 消耗（仅日常奖励）

日常奖励 `daily_reward7` 领的是 **Action Point（AP，上限 120）**。查 `Lib9c/Action/DailyReward.cs` 源码可知链上**并没有「AP 满不能领」的检查**，它只做
`SetActionPoint(avatar, ActionPointMax = 120)`（把 AP **补满**）。所以 AP 已满时领取照样 `SUCCESS`，只是补满 120 等于**零收益**，还白刷一次 `dailyRewardReceivedIndex`、白等一个 2550 块冷却。游戏 App 里「AP 满点不动领取」是客户端为防浪费做的 UI 限制，链上不设卡。

因此脚本在提交 `daily_reward7` 前先读链上 `stateQuery.avatar.actionPoint`：

- **AP 未满**（< 120）→ 直接领，正常拿到补满的 AP。
- **AP 已满**（≥ 120）→ 先发 `hack_and_slash_sweep10`，把 120 AP 消耗掉（每次 4 AP × 30 次），**确认成功后再领日常**，才能吃到整整 120 AP，并顺带获得 30 次 sweep 掉落。
- **巡逻奖励与 AP 无关，不触发 sweep。**

Sweep 的实现要点（都是为了「绝不因可选步骤而漏领」）：

| 要点 | 做法 |
|---|---|
| 关卡选择 | 复用「本角色最近一笔 `SUCCESS` 的 sweep」原始 action，从 Mimir 动态取；客户端实际用的是 `world 9 / stage 446`（已通关且 CP 达标），不是 `lastClearedStage` 的 495 —— 495 的 `SweepRequiredCPSheet` CP 要求更高，硬造会 `NotEnoughCombatPointException` |
| 参数构造 | 直接复用链上已成功的 action **字节**，只把 `GameAction.Id` 换成新的 16 字节；装备 / 符文 / 关卡 / `actionPoint` / 入场材料一字不改，保证 CP、`playCount`、`EntryCostItemCount` 全部校验与那笔成功交易一致。实测已与链上真实 action **逐字节比对通过** |
| 装备变更 | 每轮动态取最近成功 sweep，用户手动换装后再 sweep 过一次即自动跟随；Mimir 故障回退到内置模板（block `11749808`，同样已 SUCCESS） |
| **失败重试** | sweep 失败 / 超时(`PENDING`) / 提交异常，**最多重试 5 次**（连同首次共 6 笔，默认），尽量把 AP 消耗掉；每笔换新的 `GameAction.Id` 与重新取 `nonce`。**6 笔都未确认成功才降级照常领日常** |
| **重试前只认链上** | 每次重试前先复核链上 `actionPoint`：**AP 已降下来就说明此前某笔其实成功了**（典型是 `confirmTx` 超时但其实 `SUCCESS`），立即收手判成功，绝不重复提交 sweep，也不会出现「AP 已扣却判失败去领日常」的错配 |
| **不重复扣 AP** | 链上幂等：多笔 sweep 先后上链最多一笔能扣掉 120 AP，其余因 AP 不足 `FAILURE` 无副作用；重试只提高成功率，不会多消耗 AP |
| **总预算** | sweep 整体 480s 硬上限，到点无论结果都降级领日常，绝不拖过领取窗口 |
| 最终降级 | 次数用尽 / 预算耗尽 / 全异常：**一律照常领日常**——链上本就无 AP 门槛，绝不让可选的收益优化阻塞领取、错失冷却窗口 |
| 提交顺序 | 每笔 sweep 先 `confirmTx` 等到终态、nonce 推进后，下一笔重新 `getNonce`；最后再 `getNonce` 提交日常，全程串行不撞 nonce |
| 幂等 | 触发判据只看链上 AP：sweep 成功扣掉 AP 后 `shouldSweep` 自动变 false，交棒后新 job 也不会重复 sweep |

> 开关：`--no-sweep` 整体关闭（默认开启）。重试次数 `--sweep-attempts N`（默认 6 = 首次 + 5 次重试，`--sweep-attempts 1` 退回旧版单次行为）；重试间隔 `--sweep-retry-gap-ms`（默认 4000）；每笔确认轮数 `--sweep-confirm-tries`；整体预算 `--sweep-budget-seconds`（默认 480）。演练钩子 `--simulate-ap-full` 仅 `--dry-run` 生效，走一遍 `would_sweep` 路径，绝不联网、不提交。

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
| `claim.mjs` | 领奖链主程序：一次性检查 + `--watch` 蹲守 + `--daemon` 自接力常驻，输出结构化 JSON |
| `market-buy.mjs` | **扫货链主程序**：ticker 精确识别 Stun Rune (Adventure)、单价判定、`buy_product3` 构造、链上终态确认、`--daemon` 自接力常驻 |
| `import-key.mjs` | 私钥导入：keystore JSON / hex / 助记词 → `.env`，并校验归属（两条链共用） |
| `package.json` / `package-lock.json` | 依赖锁定（`npm ci` 必需，缺 lock 文件会失败） |
| `.github/workflows/claim.yml` | GitHub Actions 领奖任务（`--daemon` 常驻 + 接力 step + schedule 重燃 + 手动验证） |
| `.github/workflows/market.yml` | **GitHub Actions 扫货任务**（独立 `concurrency` 组 `9c-market-buy`，与领奖链隔离；接力指向 `market.yml` 自身） |
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

`rewards[].sweep`（仅日常、AP 满时出现）：`{triggered, ap, status, maxAttempts, attempts, attemptLog[], confirmedBy?, chainAp?, template?, txId?, txStatus?}`。
`status` 取值：

| status | 含义 |
|---|---|
| `swept` | 已确认 AP 被消耗。`confirmedBy=tx_status` 表示交易回执 `SUCCESS`；`confirmedBy=chain_ap` 表示重试前复核链上 AP 已下降（此前那笔其实成功了） |
| `sweep_unconfirmed` | 6 笔尝试（或预算）用尽仍未确认成功，已降级照常领日常 |
| `would_sweep` | dry-run 演练，未提交任何交易 |

`attempts` 是实际提交的 sweep 笔数（默认上限 6），`attemptLog[]` 逐笔记录 `{attempt, txId?, txStatus?, nonce?, template?, error?}`。
日志里可见 `AP 已满：提交 sweep 消耗 AP（第 N/6 次尝试）`、`sweep 第 N/6 次未确认成功（…），复查链上状态后重试`、
`sweep 成功（第 N 次尝试），AP 已消耗，继续领日常` 与 `sweep 连续 N 次尝试均未确认成功，降级照常领日常`。

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
node claim.mjs --daemon --no-sweep         # 关闭「AP 满时先 sweep」（默认开启）
node claim.mjs --daemon --sweep-attempts 6 # sweep 最多 6 笔（默认，= 首次 + 重试 5 次）
node claim.mjs --daemon --dry-run          # 演练：只规划一轮，不真睡、不提交
node claim.mjs --daemon --max-run-seconds 19800   # 自定义预算（秒，须 < 6h）
node claim.mjs --self-test                 # 离线自测（含 sweep 判定 + 重试决策 + 模板重建）

# ---- 本地 cron 入口 ----
bash run.sh --dry-run
tail -f claim.log
```

> 演练钩子（**仅在 `--dry-run` 下生效**）：
> - `--simulate-unblock-delta N` 把解锁块伪装成「当前 tip + N 块」；
> - `--simulate-tip-step N` 每轮让 tip 前进 N 块、`--simulate-cycle-blocks N` 领取后跳到下一周期，
>   配合 `--poll-seconds 1 --max-run-seconds 18` 可在十几秒内走完**多个完整周期 + 正常交棒**；
> - `--simulate-ap-full` 模拟 AP=120 满，走一遍 `would_sweep` 前置路径（验证 sweep 触发判定）；
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

---

## 七、市场扫货：Stun Rune (Adventure) 低价自动购买

独立的一条自接力链（`market.yml` + `market-buy.mjs`），与领奖链完全隔离。
需求：**监控市场里 Stun Rune (Adventure) 的单价，出现 ≤ 0.2 NCG/件 就整单买下**；
绝不能和相似的 **Stun Rune (Arena)** 或名字近似物品搞混。

### 7.1 为什么不会搞错（用 id，不用名字）

市场里符文是 `FungibleAssetValue` 挂单，每件资产带**唯一 ticker**。查 Mimir 的
`RuneSheet`（链上表格）得到权威映射：

| 符文 | RuneSheet id | ticker（唯一标识） | 处理 |
|---|---|---|---|
| **Stun Rune (Adventure)** | `10021` | `RUNESTONE_STUN_ADVENTURE` | ✅ 目标 |
| Stun Rune (Arena) | `10022` | `RUNESTONE_STUN_ARENA` | ❌ 明确排除 |

- **数据源头就分开**：请求 9CAPI 时直接用 `tickers=RUNESTONE_STUN_ADVENTURE` 精确参数，
  服务端只返回该资产；Adventure / Arena 是两个不同 ticker，永不交叉。
- **三重校验**：① 逐条本地复核 `ticker === "RUNESTONE_STUN_ADVENTURE"`（严格相等，非 `includes`、
  非模糊匹配），大小写不同 / 名字含相似串 / 其它符文一律拒绝；② `productType` 必须是
  `FUNGIBLE_ASSET_VALUE`；③ 提交前 Mimir 链上二次确认 `asset.ticker` 正确、价格/卖家未变。
- **链上最终兜底**：`BuyProduct` 执行时会校验 `productId / price / seller`，任何不符即
  `FAILURE`，不会买错物品、不会付错钱。这延续了你定的「只认链上、失败无所谓」原则。

### 7.2 单价判定（unit price，不是总价）

9CAPI 的 `fav` 挂单自带 `price`（**整数 NCG 总价**）、`quantity`（件数）、`unitPrice`
（= price ÷ quantity，NCG/件）。NCG 有 2 位小数，0.2 NCG/件 = 20 minor/件。判定用**纯整数
BigInt 运算**，避开浮点误差与总价陷阱：

```
price(NCG) × 100  <=  20 × quantity     // 等价 unitPrice <= 0.2
```

- 恰好 0.2（如 2 NCG / 10 件）**命中**（`<=`）。
- 略超（如 21 NCG / 100 件 = 0.21）**不买**。
- 高价单（如 9 NCG / 10 件 = 0.9）**不买**。
- `price` 实测恒为整数 NCG，非整数/负数/`quantity<=0` 一律拒绝，防止浮点抹平边界。

### 7.3 购买交易 `buy_product3`（FAV 版）

链上购买 action 是 `buy_product3`。复用一笔**链上真实 SUCCESS 交易**（block `11755327`）
的字节作模板，只替换动态字段，与 sweep 复用已验证 action 的思路一致，零字段/类型风险：

```
values = {
  a : 买家 avatarAddress (20B),
  id: 随机 16B action id（每笔换新，防重复交易）,
  p : [ [ productId(16B, UUID→bytes_le),
          [ NCG currency dict, price×100 (BigInt minor) ],
          sellerAgentAddress(20B), sellerAvatarAddress(20B),
          "FungibleAssetValue" ], ... ]   // 最多 20 单/笔（Lib9c Capacity）
}
```

**字节级验证**（全部通过）：
- 用 9CAPI `mobileBuyHeimdall` 返回的合法 action 交叉确认 `a/id/p` 骨架、NCG currency
  dict 编码、`price 9 → i900e`（9 NCG ×100）完全一致；
- `productId` 的 UUID → 16 字节用 `.NET Guid.ToByteArray()`（`bytes_le`）编码，与链上真实
  交易、`mobileBuy` 返回值逐字节对齐：`0fe1ae99-...` → `99aee10f88051a41...`；
- 用模板自身动态字段重建的 action 与链上模板 **逐字节一致（240B）**；
- 真实 `signTx` + `encodeSignedTx` 编码出的 1 单 / 2 单 payload 均可解码、字段正确。

### 7.4 只认链上 / 不锁死 / 不阻塞

- **提交前**：读链上 tip + 归属校验（signer = agentAddress）+ 可选 NCG 余额预检（买不起就跳过，
  不白提交）；Mimir 复核挂单，仅在查到「明确不符」（串货 / 变价 / 卖家变）时拦截，
  **未索引在售挂单（not_found）或网络异常一律放行**，交给链上执行兜底 —— 绝不因二级索引
  滞后误杀候选单、错失低价机会。
- **提交后**：`confirmTx` 只认终态 `SUCCESS / FAILURE / INVALID`；只有 `SUCCESS` 记为买到。
  `FAILURE / PENDING / INCLUDED / 异常` 一律不锁死，下一轮重新拉链上最新挂单再试
  （重复提交最多成功一笔，其余 `FAILURE` 无资金损失）。
- **扫光策略**：命中的单按单价升序（先买最便宜）打包，每笔最多 20 单、逐笔串行提交
  （同一 signer 不并发抢 nonce）；不设预算上限、不设总量上限，一轮没扫完下一轮继续。
- **轮询**：默认每 60s 扫一次（`--poll-seconds` 可调），远离命中时只是一次轻量 HTTP 请求。

### 7.5 命令速查与参数

```
node market-buy.mjs --self-test                  # 离线自测（35/35，含字节级比对，不联网）
node market-buy.mjs --dry-run                   # 联网只读扫描一轮，绝不提交
node market-buy.mjs                            # 真实扫描并购买命中的便宜单
node market-buy.mjs --daemon                   # 自接力常驻 5.5h（线上 workflow 用这个）
node market-buy.mjs --daemon --dry-run --simulate-listings-file sim.json  # 注入挂单演练多轮+交棒
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--max-unit-price-minor N` | `20` | 单价阈值（minor/件）；20 = 0.2 NCG/件 |
| `--poll-seconds N` | `60` | 每轮扫描间隔 |
| `--max-items-per-tx N` | `20` | 单笔 `buy_product3` 最多打包几单（≤ Lib9c Capacity 20） |
| `--max-tx-per-round N` | `20` | 每轮最多提交几笔交易（未扫完下轮继续） |
| `--max-run-seconds N` | `19800` | daemon 常驻预算（5.5h < 单 job 6h 上限） |
| `--no-verify` | 关闭 | 跳过提交前 Mimir 链上复核（默认开启） |
| `--simulate-listings-file F` | — | 仅 dry-run：从 JSON 文件注入挂单，离线演练完整链路 |

### 7.6 线上上线要点

- `market.yml` 用**独立** `concurrency` 组 `9c-market-buy`，绝不与 `claim.yml` 的
  `9c-auto-claim` 共用（两条常驻 daemon 共组会互相排队饿死）。
- schedule 与领奖链错峰（`9,19,29,...` vs `4,14,24,...`），接力 dispatch 指向
  `market.yml` 自身。
- 两条链共用同一 keystore Secrets（同一角色/私钥）。都动态取 `nextTxNonce`；领奖几小时
  才提交一次、扫货只在出现便宜单时提交，撞 nonce 概率极低；万一撞上一笔 `FAILURE`
  无资金损失，下轮重提即可。
- 手动点火：`Actions → 9C 市场扫货 → Run workflow`，**取消勾选 `dry_run`** 即进入真实常驻；
  勾选则只扫描一轮验证、不提交、不接力。
- 观察到便宜单时日志依次为 `已提交 buy_product3（N 单）` → `购买成功（N 单）`；
  未命中时每轮只有 `rawCount / candidateCount=0` 的 daemon 心跳。
