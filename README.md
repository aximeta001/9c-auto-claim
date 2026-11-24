# 9C 自动挂机（Heimdall）：奖励领取 + 市场扫货 + 无限塔冲塔 + AB 爬楼

> ⚠️ **动手前必读 [`RULES.md`](./RULES.md)**：AB/sweep 铁律（没冲过 28 层绝不 sweep、
> 层数只认链上权威字段、门票只用 Golden Dust）、通用交易纪律、动手前检查清单。

本仓库含**两条相互独立的纯 GitHub 自接力链**、**两条纯手工触发的 AB 链**，外加**一条无限塔新赛季冲塔链**：

| 链 | workflow | 脚本 | 作用 | 触发 |
|---|---|---|---|---|
| 领奖链 | `claim.yml` | `claim.mjs` | 自动领巡逻奖励 / 日常奖励（含 AP 满先 Sweep） | 自接力常驻 |
| **扫货链** | **`market.yml`** | **`market-buy.mjs`** | 低价购买 **Stun Rune (Adventure)**（≤0.2 NCG/件）+ **Valkyrie 五部位装备**（lv≥3、≤2 NCG/件、封顶 500 NCG） | 自接力常驻 |
| **AB Sweep 链** | **`sweep-boss.yml`** | **`sweep-boss.mjs`** | Adventure Boss 一键连续 Sweep | **仅手工 `workflow_dispatch`** |
| **AB 爬楼链** | **`explore-boss.yml`** | **`explore-boss.mjs`** | Adventure Boss 自动挑战爬楼到目标层（门票全程 Golden Dust） | **仅手工 `workflow_dispatch`** |
| **无限塔链** | **`infinite-tower.yml`** | **`infinite-tower.mjs`** | 新赛季一上线立刻自动打第 1 层（启动个人补票时钟） | **自接力常驻（20 秒轮询）+ 手工** |

各链有独立 `concurrency` 组、共用同一 keystore Secrets，互不干扰。AB 两条链都不常驻、不定时、不自动触发。无限塔链采用与领奖链相同的自接力常驻架构（详见下节），**不依赖不稳的 schedule cron 抢首层**。

### AB 爬楼链：自动挑战到目标层（2026-11-17 起）

在游戏里一层一层点「挑战」很慢、网络又卡，这条链替你自动爬楼。只手工触发，跑到目标层或预算用尽就退出。

**目标层数**：默认按 BOSS 自动 —— Surtr(211000)=29 层，其余三个（含 Hella）=28 层（依据实测：surtr 能到 29，hella 保底 28）；dispatch 时填 `floor` 可强制指定（1~30）。

**关键机制（Lib9c 源码 + 链上真实交易确认）**：

| 点 | 说明 |
|---|---|
| explore 自动连爬 | `explore_adventure_boss` 没有楼层字段，一笔从 `Floor+1` 自动连爬到 `MaxFloor`；打不动就停在上一层，但**交易仍是 SUCCESS**——所以判定真通关必须重读链上个人 `floor`，不能只看终态 |
| 失败重试 | 同一层随机种子不同，这次不过下次可能过；脚本「提交→等终态→重读 floor→没到目标再来一笔」循环，直到 `floor >= 目标`（正是 hella 25 层要试两三次、28 层要多试几次） |
| 门票全程 Golden Dust | 需要解锁时提交 `unlock_floor`，`buildUnlockAction` **强制 `u=false` = GoldenDust(600201)，绝不用 NCG**；即使模板来自曾用 NCG 的历史交易也会被改正 |
| 解锁时机 | `floor == maxFloor` 且未达标时解锁下一批 5 层（门票点 6/11/16/21/26 层），上限 30 层；前提是当前解锁的层已全部通关 |
| 权威状态 | 个人 `floor/maxFloor/bossId` 读 Heimdall `stateQuery.adventureBossSeasonStatus`，是节点上的 Explorer 状态，不看 9CAPI 展示值、不依赖交易索引 |
| 只认链上终态 | SUCCESS/FAILURE/INVALID，伪 INVALID 不算；非 SUCCESS 立即停并说明原因 |
| 预算保护 | `--max-attempts`（默认 15）限制最多提交笔数，防无限重试烧 AP |

**成本**：explore 每层消耗 2 瓶 AP 药水；解锁用 Golden Dust。AP / Golden Dust 不足时链上 FAILURE，脚本停下说明原因。

**用法**：dispatch `explore-boss.yml` → 真跑取消勾选 `dry_run`；`floor` 留空自动、填数字强制；`max_attempts` 控制预算；`no_unlock` 可禁止解锁（只爬已解锁层）。默认 `dry_run=true`，绝不误触发。

### 无限塔链：新赛季自动冲第 1 层（2026-11-17 起）

**为什么越早打越好**：无限塔的个人计时器锚定在「首次进塔那一笔」——Lib9c `PerformSeasonReset` 在首次进入某赛季时把 `LastTicketRefillBlockIndex` 设为当前块并发 1 张票，之后每天免费票都按这个锚点每 5400 块补 1 张。**越早打第 1 层，你的补票时钟就越早开始滚动**，整个赛季能多领若干张免费票。

**判定（只读链上权威状态，四条全满足才提交）**：

1. `infiniteTowerStatus.infiniteTowerId >= 目标赛季`（默认 11，新赛季排期由官方 patch 注入链上才出现）；
2. `isActive === true`（赛季窗口进行中）；
3. `clearedFloor < 1`（第 1 层未通关 —— **通关后永久幂等跳过，绝不重复提交**）；
4. `remainingTickets >= 1`（新赛季首笔送 1 票，正好够第 1 层，**不花 NCG / 材料 / AP**）。

**交易构造**：复用你本人最近一笔 `SUCCESS` 的 `infinite_tower_battle.raw` 作字节级模板，只改 `id`（新 16 字节）、`infiniteTowerId`→链上实际赛季号、`floorId`→1；装备 / 时装 / 符文槽原样保留，自动跟随养成。提交后跨节点并行复核终态（只认 `SUCCESS/FAILURE/INVALID`），成功后再次读链上确认 `clearedFloor>=1`。

**为什么不用 schedule 当主力**：GitHub 的 schedule cron 在高负载时会延迟数十分钟甚至整点丢弃，抢首层完全靠不住（这正是早期"几笔操作失败/延迟很久"的根因）。本链复用领奖链已验证的高可用架构：

| 机制 | 行为 |
|---|---|
| **主力：`--watch` 常驻蹲守** | job 内进程每 **20 秒**轮询一次链上状态，赛季一排期上链最多 20 秒内命中并提交；一个 job 守满 5.5h（< 单 job 6h 上限） |
| **自接力** | 预算耗尽打印 `{"handoff":"budget_exhausted"}`，接力 step 用 `workflow_dispatch` REST API 即时刻下一个 job，`concurrency` 同组排队**无缝衔接**，不受 cron 调度延迟影响 |
| **自动停止** | 冲塔成功 / 交易定论后打印 `{"done":...}`，接力 step 不再接力，赛季内不再空转浪费 runner |
| **schedule（每 10 分钟）** | 仅作「接力链意外断裂时重新点火」的保险，链正常时根本用不到；即使被延迟/丢弃也不影响主力 |
| `workflow_dispatch` | 手工验证用，`dry_run` 默认勾选 = 只轮询不提交 |

> 赛季排期表（`InfiniteTowerScheduleSheet`）只有在新赛季被官方 patch 注入链上后才会出现第 11 行。在那之前脚本每轮只会输出「目标第 11 期尚未上线」并安静跳过，**不会误提交**。当前正处第 10 期结束后、第 11 期 patch 注入前的切换真空期，headless 偶发返回空状态属正常，脚本会 catch 后继续轮询。

---

### AB 链：批量提交（2026-11-16 起）

AB 与领奖链的**风险模型不同**：领取是「一次机会、重复领取就浪费」，必须逐笔等链上终态确认；AB 是「同一操作重复执行、失败可事后补齐」，逐笔确认纯属浪费时间。因此 `sweep-boss.mjs` 默认走**批量模式**：

1. 整批取一次 `nextTxNonce`，之后本地严格 `+1` 连续递增，同一 signer 不并发抢号，每笔独立随机 `id`；
2. 连续提交 N 笔，笔间只留 `--gap-ms`（默认 2000ms，实测单笔「签名 + `stageTransaction`」约 200~600ms），**不等链上终态**；
3. 全部提交完做**一次总复核**：并行轮询所有 txId 的终态、跨节点取结果，只认 `SUCCESS/FAILURE/INVALID`；节点尚未索引时短暂的「伪 INVALID」（`blockIndex=null` 且无异常名）不算结论，继续等；
4. 按链上 `SUCCESS` 数与目标次数的**差额自动补齐**，最多 `--max-rounds` 轮；未决交易先占位、不重复提交，避免多刷 / 重复扣药水。

需要回退到旧的「每笔等终态」时加 `--confirm-each`（workflow 里勾 `confirm_each`）。**领奖链 `claim.mjs` 不受影响**，仍是逐笔复核 + 幂等锁。

> **铁律（2026-11-24 血泪教训）：没冲过目标层，绝不 sweep。**
> `SweepAdventureBoss.cs` 的积分是 `for fl=1..explorer.Floor` 逐层各抽一次、累加进 `explorer.Score`（赛季排名分）。少打第 28 层 = 每笔 sweep 少抽一次第 28 层积分 ≈ **6000+ 分**，20 笔就是 **约 12 万~14 万分**，且这部分直接决定奖励占比，绝不是「差异极小」。
> 事故经过：heimdall6 节点一度卡在旧赛季，`explore-boss.mjs` 被临时改成「用 Mimir 交易笔数推算 floor」，而 `explore_adventure_boss` 受 CP 限制打不满、raw 里也没有层数——推算把 floor 虚报成 30（真实只到 27），脚本据此提前收手，20 笔 sweep 全在 27 层做，白丢约 12 万+ 分。
> 因此现在有**两道硬闸**：
> 1. `explore-boss.mjs` 的 `getMySeasonStatus()` 只认 heimdall6 真实 `floor/maxFloor`，并用链上 `LatestSeason` 窗口做一致性校验；节点落后就报错停，**绝不再用交易笔数推算**。
> 2. `sweep-boss.mjs` 提交前必读真实 `floor`，`floor < --min-floor`（默认 28）或读不到 / 窗口不一致，一律**拒绝 sweep**。层数从交易推算这条路已彻底废弃。
> 以后流程：**先把角色真实冲过 28 层（读链上 floor 确认）→ 再跑 sweep**，顺序不可颠倒。

| 参数 | 默认 | 说明 |
|---|---|---|
| `--min-floor` | 28 | **硬门槛**：本角色真实通关层数必须 ≥ 此值才 sweep，否则拒绝（0=关闭，不推荐） |
| `--gap-ms` | 2000 | 笔间间隔，应略大于单笔提交耗时 |
| `--final-tries` | 12 | 总复核最多轮询轮数 |
| `--final-interval-ms` | 3000 | 总复核轮询间隔（并行查全部 txId，不随笔数增长） |
| `--max-rounds` | 3 | 最多「提交＋复核」轮数，防止无限补齐 |
| `--confirm-each` | 关 | 回退到逐笔等终态的旧模式 |

**领奖链**：自动代替你打开 App 点「Get Reward」和「Daily Reward」。链上所有东西都是交易，领取 = 用角色所属 agent 的私钥签名并提交一笔交易。本项目已在真实 Heimdall 网络上端到端验证：构造 → 签名 → `stageTransaction` → 上链确认。

### 领奖链同时值守 3 个角色（2026-11-11 起）

同一个 keystore / agent 下可以挂多个 avatar，它们的日常奖励与巡逻奖励互相独立。链上核实三个角色同属 agent `0x491bd35CA5F8F261a0ad33A01c74501e6Bc5bc3f`，因此**同一把私钥就能签三个角色的交易，无需新增任何 Secrets**。

| 角色 | avatar 地址 | 等级 |
|---|---|---|
| `bnb` | `0xAC9D450C69dF27ee290C90EC61c4B76154b0A21c` | 506 |
| `bnbyes` | `0x3614521b77116568211b70d109A2822C15ec5044` | 424 |
| `tomoon` | `0x897fD3F58c87F26b5C13F78656E688B2a89C6eF1` | 440 |

> **为什么是「一条链串行」而不是三条并行链**：三个角色共用同一 signer，也就共用同一条 nonce 队列；三条常驻链同时提交会互抢 nonce 造成 `FAILURE`。所以 `claim.mjs --daemon` 在每一轮里依次切换角色、逐个检查并**串行提交**，每笔都重新取 `nextTxNonce`；幂等锁、结果、计数都按「角色|奖励」分键，互不覆盖。
>
> 角色列表默认内置在脚本里；如需改动，在仓库 `Variables` 里设 `NC_AVATARS`（逗号分隔的 `名字:0x地址`），留空即用默认三角色。注意 `.env` 中的 `NC_AVATAR` 只用于归属校验参考，不决定角色列表。
>
> 三个角色**都启用**「AP 满先 30 次 Sweep 消耗 120AP 再领日常」，各自从 Mimir 取自己最近一笔 `SUCCESS` 的 sweep 模板，`buildSweepAction` 会校验模板里的 `avatarAddress` 必须等于当前角色，绝不串用他人模板。
>
> 手动验证用 `node claim.mjs --check-all`（只读，逐一列出三个角色的解锁块 / AP / 归属，不签名、不提交）；workflow 的 `dry_run` 分支已改为调用它。

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
| 参数构造 | 复用链上已成功 action 的**字节**，但强制改写 3 个字段：`GameAction.Id`（换新 16 字节）、`actionPoint → "120"`、`apStoneCount → "0"`；装备 / 符文 / 关卡 / 入场材料声明一字不改，自动跟随最新养成。这样无论用户手动做过 80AP 的 sweep、还是勾过 AP 药水，脚本都恒定为 **120AP / 30 次 / 不消耗药水**。覆盖时保持模板原值类型（Unicode Text），字段集合与编码类型零漂移 |
| 装备变更 | 每轮动态取最近成功 sweep，用户手动换装后再 sweep 过一次即自动跟随；Mimir 故障回退到内置模板（block `11749808`，同样已 SUCCESS） |
| **失败重试** | sweep 失败 / 超时(`PENDING`) / 提交异常，**最多重试 5 次**（连同首次共 6 笔，默认），尽量把 AP 消耗掉；每笔换新的 `GameAction.Id` 与重新取 `nonce`。**6 笔都未确认成功才降级照常领日常** |
| **重试前只认链上** | 每次重试前先复核链上 `actionPoint`：**AP 已降下来就说明此前某笔其实成功了**（典型是 `confirmTx` 超时但其实 `SUCCESS`），立即收手判成功，绝不重复提交 sweep，也不会出现「AP 已扣却判失败去领日常」的错配 |
| **不重复扣 AP** | 链上幂等：多笔 sweep 先后上链最多一笔能扣掉 120 AP，其余因 AP 不足 `FAILURE` 无副作用；重试只提高成功率，不会多消耗 AP |
| **总预算** | sweep 整体 480s 硬上限，到点无论结果都降级领日常，绝不拖过领取窗口 |
| 最终降级 | 次数用尽 / 预算耗尽 / 全异常：**一律照常领日常**——链上本就无 AP 门槛，绝不让可选的收益优化阻塞领取、错失冷却窗口 |
| 提交顺序 | 每笔 sweep 先 `confirmTx` 等到终态、nonce 推进后，下一笔重新 `getNonce`；最后再 `getNonce` 提交日常，全程串行不撞 nonce |
| 幂等 | 触发判据只看链上 AP：sweep 成功扣掉 AP 后 `shouldSweep` 自动变 false，交棒后新 job 也不会重复 sweep |

> 开关：`--no-sweep` 整体关闭（默认开启）。**单笔 sweep 固定消耗 AP：`--sweep-ap N`（默认 120，钳制 1~120）**；重试次数 `--sweep-attempts N`（默认 6 = 首次 + 5 次重试，`--sweep-attempts 1` 退回旧版单次行为）；重试间隔 `--sweep-retry-gap-ms`（默认 4000）；每笔确认轮数 `--sweep-confirm-tries`；整体预算 `--sweep-budget-seconds`（默认 480）。演练钩子 `--simulate-ap-full` 仅 `--dry-run` 生效，走一遍 `would_sweep` 路径，绝不联网、不提交。
>
> **为什么锁定 `actionPoint` / `apStoneCount`**：模板来自「最近一笔 SUCCESS sweep」，会跟着手动 sweep 漂移（实测出现过 80AP 与 120AP）。若沿用 80，只消耗 80AP、剩 40AP 被日常补满 = 白丢 40AP；若模板带 `apStoneCount=N`，链上 `playCount = 30×N + actionPoint/costAp` 且会真扣背包药水，不足即 `FAILURE`。两者都由脚本写死，手动操作不会再影响脚本行为。

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
| `market-buy.mjs` | **扫货链主程序**：ticker 精确识别 Stun Rune (Adventure)（≤0.2 NCG/件）+ Valkyrie 五部位装备（itemId 段位 + lv≥3 + ≤2 NCG/件 + 500 NCG 封顶）、FAV/NonFungible 两版 `buy_product3` 构造、链上终态确认、`--daemon` 自接力常驻 |
| `infinite-tower.mjs` | **无限塔链主程序**：轮询 `infiniteTowerStatus` 判新赛季+第1层未通关、`infinite_tower_battle` 字节模板改赛季/楼层、跨节点终态复核、`--once`/`--watch`/`--dry-run`/`--self-test` |
| `import-key.mjs` | 私钥导入：keystore JSON / hex / 助记词 → `.env`，并校验归属（各链共用） |
| `package.json` / `package-lock.json` | 依赖锁定（`npm ci` 必需，缺 lock 文件会失败） |
| `.github/workflows/claim.yml` | GitHub Actions 领奖任务（`--daemon` 常驻 + 接力 step + schedule 重燃 + 手动验证） |
| `.github/workflows/market.yml` | **GitHub Actions 扫货任务**（独立 `concurrency` 组 `9c-market-buy`，与领奖链隔离；接力指向 `market.yml` 自身） |
| `.github/workflows/infinite-tower.yml` | **GitHub Actions 无限塔冲塔任务**（`--watch` 20 秒轮询常驻 + 接力 step + schedule 重燃 + 手工验证；独立 `concurrency` 组 `9c-infinite-tower`） |
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

# ---- 三角色只读核对（workflow 的 dry_run 分支使用）----
node claim.mjs --check-all                 # 逐一列出 3 个角色解锁块/AP/归属，绝不提交
node claim.mjs --self-test                 # 48 项离线自测（含多角色不串号校验）

# ---- 一次性 / 蹲守（兼容调用；这两种模式只处理主角色 bnb）----
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

# ---- 无限塔新赛季冲塔链 ----
node infinite-tower.mjs --self-test              # 24 项离线自测（判定 + action 构造 + 归属校验）
node infinite-tower.mjs --watch --dry-run         # 只读演练：20 秒轮询蹲守，命中也不提交
node infinite-tower.mjs --watch                   # 真跑主力：常驻蹲守 5.5h、20 秒轮询，命中即提交第1层，成功即停
node infinite-tower.mjs --watch --season 11      # 指定目标赛季蹲守
node infinite-tower.mjs --watch --gap-ms 20000 --max-watch-seconds 19800  # 轮询间隔/预算（默认 20s / 5.5h）
node infinite-tower.mjs --watch --max-watch-seconds 60 --dry-run  # 快速验证交棒：预算60秒，耗尽打印 handoff
node infinite-tower.mjs --once                   # 单次检查（备用），命中即提交一笔

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

## 七、市场扫货：Stun Rune (Adventure) + Valkyrie 装备 低价自动购买

独立的一条自接力链（`market.yml` + `market-buy.mjs`），与领奖链完全隔离。两个目标共用
同一条链、同一次扫描、同一私钥：

1. **Stun Rune (Adventure)**：单价 ≤ 0.2 NCG/件就整单买下；绝不能和相似的
   **Stun Rune (Arena)** 或名字近似物品搞混（7.1–7.6）。
2. **Valkyrie 五部位装备**：强化等级 ≥3、单价 ≤2 NCG、全部元素变体，本次运行累计
   封顶 500 NCG（7.7）。

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
node market-buy.mjs --self-test                  # 离线自测（60/60，含 FAV/NonFungible 字节级比对，不联网）
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

### 7.7 Valkyrie 五部位装备扫货（新增）

**目标**：Valkyrie Sword / Armor / Necklace / Belt / Ring 五部位，**同时满足**：
- 强化等级 `level >= 3`（链上装备的 `level` 字段，不是 item grade；**同价位下强化越高越划算，+4/+5 等高等级一律照常纳入，不过滤**）；
- 单价 `price <= 2 NCG`（装备按件卖，`price` 即单价整数 NCG）；
- 全部 5 种元素变体（Normal / Fire / Water / Land / Wind）都纳入；
- **本次运行累计买够 500 NCG 就停止买装备**（接力后额度重置，符文扫货不受此预算约束）。

> **为什么用 `order=level_desc` 抓取排序**：9CAPI 市场接口**不支持服务端按强化等级过滤**（实测 `level` / `minLevel` / `enhancement` 等参数均被忽略），只能在脚本本地筛。本地只能筛「拉到的」数据，因此用 `level_desc` 把高强化装备排到最前、配合 500 条拉取量确保 ≥3 级挂单被拉到，再由本地 `level>=3` 设门槛。**同价位下强化越高性价比越好，高等级一律纳入**——排序把高等级排前面，也利于优先买入。

**身份判定（用 id，不用名字）**：从 `EquipmentItemSheet` 拿权威 itemId 段位，逐条精确匹配：

| 部位 | itemId 段位 | 链上 itemSubType |
|---|---|---|
| Valkyrie Sword | `1017xxxx` | `Weapon` |
| Valkyrie Armor | `1027xxxx` | `Armor` |
| Valkyrie Belt | `1037xxxx` | `Belt` |
| Valkyrie Necklace | `1047xxxx` | `Necklace` |
| Valkyrie Ring | `1057xxxx` | `Ring` |

名字里带 `Valkyrie` 的其它装备（如 5 级 `Valkyrie's Sword` = `10155000`）段位不符，**一律排除**。

**数据源**：9CAPI 物品接口 `/marketProviderHeimdall/Market/products/items/{subType}?order=cp_desc`，
Valkyrie 是高 CP 装备，`cp_desc` 让它们排在最前（默认每部位拉 500 条本地筛）。接口返回的
`itemId / level / price / productId / tradableId / seller*` 就是判定与构造所需的全部字段。
某部位请求失败不影响其它部位；Mimir 挂单索引不作放行前置，延续「只认链上、失败无所谓」。

**购买 action（NonFungible 版 `buy_product3`）**：与 FAV 版同骨架，仅 `p[0]` 从 5 字段变 8 字段
（末尾多 `itemSubType` 字符串 + `tradableId` 16B）：

```
p[0] = [ productId(16B), [NCG currency, price×100], sellerAgent(20B), sellerAvatar(20B),
         "NonFungible", false, itemSubType("Weapon"...), tradableId(16B) ]
```

模板来自 9CAPI `mobileBuyHeimdall` 的合法返回，已验证与 FAV 版 NCG currency dict 编码一致、
自测中 **NonFungible action 模板逐字节复现（262B）**、FAV action 逐字节不变（240B）。

**新参数**（都有默认值，通常无需改）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--valk-max-price-ncg N` | `2` | 装备单价上限 NCG |
| `--valk-spend-cap-ncg N` | `500` | 装备总花费封顶 NCG（本次运行累计） |
| `--valk-min-level N` | `3` | 最低强化等级 |
| `--valk-listing-limit N` | `500` | 每部位拉取多少条高 CP 挂单本地筛 |
| `--valk-fetch-timeout-ms N` | `25000` | 单部位单次请求超时 |
| `--valk-fetch-retries N` | `3` | 每部位最多重试次数 |
| `--valk-fetch-budget-seconds N` | `150` | 5 部位抓取总预算，超时后剩余部位留空、不拖垮一轮 |
| `--no-valkyrie` | 关闭 | 临时只跑符文扫货 |

**演练**：`--simulate-listings-file sim.json` 现支持 `{ "fav":[...], "valkyrie":{ "Sword":[...], ... } }`
结构，离线验证筛选 / 排序 / 预算，不提交任何交易。自测已扩到 **60/60**（含装备段位、
等级/单价边界、元素变体、NonFungible 字节级比对、预算封顶）。
