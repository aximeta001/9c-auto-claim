# 最终架构：纯 GitHub 自接力长链（完全不依赖 WorkBuddy）

> 状态：**已上线并端到端实测通过（2026-11-08 15:00 北京）**。
> 两个文件已推送到 `aximeta001/9c-auto-claim@main`；点火 → 第一跳自接力已实测成功；
> WorkBuddy 任务 `15237427` 已停用。**系统现在完全靠 GitHub Actions 自己维持，不再需要任何外部闹钟。**

---

## 一、为什么最终改成自接力长链

三次实证把问题指向同一处：**「谁把 job 叫醒」这一层，两个外部时钟都不合格**。

| 时钟 | 实测 | 结论 |
|---|---|---|
| GitHub 原生 `schedule` | 全历史 28 次运行只有 **2 次** `schedule`（04:26、07:49）；且这两次的分钟数 26 / 49 都不在 cron `3,18,33,48` 里 —— 是严重延迟的补跑。07:49 之后 16 个应触发点命中 0 次 | 官方明说高负载会延迟/丢弃，**只能当断链重燃种子** |
| WorkBuddy 心跳 | 12:00 后有效间隔漂到 13.7 / 30.2 / 31.6 分钟，约一半唤起失败；11:44 那次连 curl 都没发出 | 隔离沙箱链路太长，**不适合当主时钟** |
| 一次性检查 | 12:15:09 读到日常只差 15 块（约 2 分钟）仍判 `not_ready` 退出，12:30 才发现解锁块已刷新 —— 奖励在两次运行之间被领走 | **等待不能交给闹钟** |

关键结论：**别再找更准的闹钟，让 GitHub Actions 自己当连续运行的实体**。runner 是稳定环境、网络由 GitHub 保证，比外部沙箱可靠得多。

---

## 二、最终架构

```
点火（已完成，之后不再需要）
  ├─ 手动 Run workflow（取消勾选 dry_run），或 schedule 偶尔命中
  ↓
GitHub Actions job：claim.mjs --daemon   ← 常驻 5.5 小时（< 单 job 6h 上限）
  ├─ 每轮读链上 tip / dailyRewardReceivedIndex / 9CAPI 巡逻解锁块
  ├─ 远离解锁 → 按剩余「区块数」休眠（单次 ≤ 15 分钟，醒后重算）
  ├─ 剩 ≤ 40 块 → 每 1 分钟重读 tip（不靠墙上时间，块速变化自适应）
  ├─ tip ≥ 解锁块 → 立即签名、广播、确认上链
  ├─ 领取成功 → 锁住该「解锁块」，链上刷新到下一周期后自动解锁重来
  └─ 预算 5.5h 耗尽 → 正常退出（打印 handoff:"budget_exhausted"）
        ↓
接力 step（if: always()，用内置 GITHUB_TOKEN 调 workflow_dispatch API）
  → 触发下一个常驻 job 进入同组 pending
  → 当前 job 一结束，pending 立即接上（空窗几秒）
  → 如此自维持，永不停止   【第一跳已实测成功，见第六节】
        ↓
重燃保险：schedule 4,14,24,34,44,54（每 10 分钟错峰）
  仅在接力链意外断裂时，偶尔命中一次把链重新点起来
```

**WorkBuddy 完全退出**：任务 `15237427` 已停用（status:0），不再有定时唤起、不再有任务通知。

### 为什么自接力在 GitHub 上成立

GitHub 官方明确：**`GITHUB_TOKEN` 触发的事件不会创建新的 workflow run（防递归），但 `workflow_dispatch` / `repository_dispatch` 是例外，始终会创建 run**。`Create a workflow dispatch event` 端点只需 `Actions: write`，workflow 里写 `permissions: actions: write` 即可 —— **实测不需要把 PAT 放进 Secrets**。

配合 `concurrency: group: 9c-auto-claim` + `cancel-in-progress: false`：同一时刻只有 1 个 running + 1 个 pending，接力 dispatch 的新 run 排队，当前 job 结束即无缝接上，**绝不会两个 job 同时抢同一个 signer 的 nonce**。

### 参数

| 参数 | 值 | 说明 |
|---|---|---|
| 常驻预算 | 19800 秒（5.5h） | `--max-run-seconds`，必须 < 单 job 6h 上限 |
| job 超时 | 355 分钟 | 留 25 分钟给安装/收尾/接力 step，避免被 timeout 强杀导致来不及交棒 |
| 单次休眠上限 | 900 秒 | `--daemon-sleep-cap`，远离解锁时醒后重读链上修正 |
| 密集轮询起点 / 间隔 | 40 块 / 60 秒 | 与 `--watch` 共用逻辑 |
| 幂等静默期 | 30 分钟 | 宽限期内等链上刷新；**到期仍未刷新则主动解锁重提**，绝不无限等待 |
| schedule | `4,14,24,34,44,54` | 只作重燃，不指望准点 |
| permissions | `contents: read` + `actions: write` | `actions: write` 供接力 API |
| concurrency | `group: 9c-auto-claim`, `cancel-in-progress: false` | **绝不能改成 true** |

### 两个奖励各自独立

`daily`（`daily_reward7`）与 `patrol`（`claim_patrol_reward`）各有自己的解锁块、到期判定、幂等锁、周期计数；提交时**串行**以防抢 nonce。一项进入下一周期不影响另一项。也可用 `--reward daily` / `--reward patrol` 完全拆成两条独立链。

---

## 三、防重复、防断链、防空转

- **幂等锁（只认链上，不认回执）**：`handled` Map 记住每个奖励「已成功领取过的解锁块」，
  防止索引刷新延迟期间重复提交；读到严格更大的解锁块（新周期）即解锁。**只有领取成功才上锁**——
  `confirmTx` 只在 `SUCCESS` / `FAILURE` / `INVALID` 终态下结论，`INCLUDED` / `STAGING` 中间态
  继续轮询，超时记 `PENDING`；这些以及失败/异常一律不锁定，冷却后重读链上，没刷新就重提。
- **TTL 兜底**：锁超过 30 分钟而链上解锁块仍未刷新，主动解锁并按链上状态复核重提，
  绝不因「怕重提」错失整个周期。链上有幂等保护，重复提交最多成功一笔，其余 `FAILURE` 无副作用。
- **防高频空转**：接力 step 只在日志里检测到 `"handoff":"budget_exhausted"`（预算正常耗尽）时才触发。演练、私钥不匹配、安装失败、被强杀等**一律不接力**，由 schedule 重燃，避免异常 job 秒退后疯狂 dispatch 刷爆 run 次数。
- **接力失败不算 job 失败**：dispatch 失败会重试 3 次并打 `::warning::`，但 step 仍 `exit 0`，不误报红色。
- **块速 / 网络抖动**：按剩余区块数休眠、单次最多 15 分钟重算；快照读取失败重试，不会永久卡住。
- **解锁块读不到**（9CAPI 与 Mimir 都失败）→ 保守不提交，60 秒后重读。

### 领取精度与漏领边界

领取精度 ±1 分钟，由 job 内部轮询保证，**与任何闹钟准时性无关**。链正常时是连续值守，不存在「到期后必须恰好有一次心跳」的窗口。唯一空窗在交接瞬间（几秒）。

即便整条链意外断裂，最坏延迟 = 一次 schedule 命中时间（实测 schedule 命中率低，可能数十分钟到数小时）。**巡逻/日常奖励不累积也不衰减，晚领没有收益损失**，只是到账晚一点。

### 两个不确定性（上线后状态）

1. **`GITHUB_TOKEN` 自接力是否成立**：✅ **已实测通过**。点火 run 用完 60s 预算交棒后，接力 step 用 `github.token` 发出 `dispatch → HTTP 204`，几秒后自动出现新的 `workflow_dispatch` run。第一跳成立，无需 `NC_DISPATCH_TOKEN`。
   - 仍保留可选加固：若长期观察发现「连续多跳后不再触发」（社区有递归深度反馈），在网页加 Secret `NC_DISPATCH_TOKEN`（值＝PAT，仅需 Actions 读写）即可，workflow 已内置双通道 `${{ secrets.NC_DISPATCH_TOKEN || github.token }}`，加了自动生效、无需改代码。
2. **24/7 常驻是否触发平台侧节流**：⏳ 待长期观察。public 仓库 GitHub-hosted runner 免费且不限分钟数，但持续占用一个 runner 是否被判定异常，只能上线观察。schedule 重燃是这一情形下的兜底。

---

## 四、本地验证结果（2026-11-08 13:40，全部只读 / dry-run）

| 项 | 结果 |
|---|---|
| `node --check claim.mjs` | 通过 |
| `--self-test`（休眠策略 6 例） | 6/6 通过 |
| 原一次性模式 `--dry-run --no-idle-skip` | `checked`、两项 `not_ready`，**旧路径未破坏** |
| `--watch --dry-run` | `idle_skip`（剩 1878 块 ≈ 4.2h），秒退，`ok:true` |
| `--daemon --dry-run`（无模拟） | `dry_plan` 秒退，不真睡、不提交 |
| **自接力多周期闭环演练**（模拟 tip 每轮 +8、解锁块领后 +12、预算 18s） | 18 秒走完 **35 轮**，两项各 **17 个周期**，预算耗尽 `handoff:"budget_exhausted"`、正常交棒；幂等锁生效，无重复误判 |
| 演练期间真实交易 | **零**：无 `stageTransaction`、无 `claimed`、无 `txId`、无 `SUCCESS` |
| `claim.yml` YAML 解析与字段核对 | 合法；`actions: write`、timeout 355、`always()` 接力、交接标记校验、token 双通道全部正确 |

真实提交链路在更早的端到端验证中已跑通（`daily_reward7` → `claimed` / `SUCCESS`，txId `aa8e06d5…e31fb63`，区块 `11740803`），本次改造**一行未动**签名与广播代码。

---

## 五、上线实录（2026-11-08 14:46~15:00 北京）

### 5.1 权限调整（你完成）

在 GitHub fine-grained token 详情页给 `9c-claim-trigger` 这个 PAT 补齐了 `Contents` / `Workflows` 写权限（**token 字符串不变**）。补齐后实测：

| 能力 | 调整前 | 调整后 |
|---|---|---|
| 列 workflows / 触发 dispatch | 200 / 204 | 200 / 204 ✅ |
| 写 `claim.mjs` / `claim.yml` | 403 | **200 ✅** |
| PAT 对仓库能力位 | 只读 | `admin / maintain / push / triage / pull` |

> 说明：之前在「详情页」找不到权限编辑入口是对的 —— fine-grained token 的**权限列表只在创建/编辑表单里**，详情页的 `Repository permissions` 白框是只读摘要，标题右侧和 `Access on` 右侧的 `Edit` 分别只管名称/描述和资源所有者。要改权限需进入完整编辑表单（或重新生成 token）。

### 5.2 推送（2 文件，先脚本后 workflow）

| 文件 | 大小 | 结果 |
|---|---|---|
| `claim.mjs` | 39008 bytes | PUT 200，推送后逐字节复核 sha256 `6e9de896…` 与本地一致 |
| `.github/workflows/claim.yml` | 7711 bytes | PUT 200，推送后逐字节复核 sha256 `b2ef2a38…` 与本地一致 |

### 5.3 停用 WorkBuddy 任务

任务 `15237427`：`status 1 → 0`（HTTP 200），cron 保持 `0 */15 * * * *`，静默 prompt 与 `deliveryConfig` 一字未动。**至此彻底不依赖 WorkBuddy。**

### 5.4 点火 + 第一跳实测

点火前安全窗口（只读链上）：tip `11744527`，日常剩 **1427 块 ≈ 3.17h**、巡逻剩 **3998 块 ≈ 8.88h**，都远离解锁；GitHub 侧无在跑/排队 job。

| 步骤 | run id | 时刻 | 结果 |
|---|---|---|---|
| 点火 `workflow_dispatch` `dry_run=false` `max_run_seconds=60` | `42456831018` | 14:57:52 | `completed / success` |
| 第一跳（接力 step 自动创建） | `42456899172` | 14:59:01 | `in_progress`，正常 5.5h 常驻 |
| 停用 WorkBuddy 任务 | — | 14:57 | `status:0` |

点火 job 日志关键证据：

```
检测到正常交棒，发起接力…
接力 dispatch HTTP=204
{"mode":"daemon","status":"budget_exhausted","ok":true,"handoff":"budget_exhausted",
 "rounds":1,"transientErrors":0,
 "msg":"时间预算耗尽，正常交棒：由 workflow 接力 step 触发下一个常驻 job",
 "rewards":[{"reward":"daily","cycles":0,"status":"watching"},
            {"reward":"patrol","cycles":0,"status":"watching"}]}
```

- **零交易**：日志中无 `交易已提交` / `claimed` / `txId` / `stageTransaction` / `SUCCESS`。
- 链上复核：`dailyRewardReceivedIndex` 仍为 `11743404`，与点火前一致 → 期间无任何领取。
- 第一跳 run 由 `workflow_dispatch` 事件创建、不带 `max_run_seconds` → 走默认 5.5h 常驻。**「GitHub 自己叫醒自己」成立，且不需要 NC_DISPATCH_TOKEN。**

---

## 六、文件改动清单（最终）

| 文件 | 状态 |
|---|---|
| `claim.mjs` | 已上线：新增 `--daemon` 常驻循环（复用已验证的快照/领取/休眠函数）、`planSleepSec` 自定义上限、多周期演练钩子；原一次性模式与 `--watch` 一行未动 |
| `claim.yml` | 已上线：`permissions: actions: write`、`timeout-minutes: 355`、短预算调试 input `max_run_seconds`、`--daemon` 命令、**接力 step**；`concurrency` 保持 `cancel-in-progress: false` |
| `keepalive.yml` | **不变**（60 天无「仓库活动」仍会禁用 schedule；workflow run 不算活动，保活保留） |
| WorkBuddy 任务 `15237427` | **已停用**（status:0），不再有任何外部唤起 |
| 文档 / zip | 本文件、README.md、DEPLOY.md、workflows-to-paste.txt 已同步 |

---

## 七、日常使用与维护

- **看板**：GitHub Actions 运行列表是唯一看板。链正常时会看到**一个长驻 run（in_progress，最长 5.5h）+ 一个排队的 pending**，属正常（concurrency 合并）。逐条日志形如 `{"level":"daemon","phase":"sleep"|"poll","remaining":…}`。
- **验证领取**：下一次日常解锁（约 15:00 起 3 小时后）应看到 `phase:"claimed"` + `txStatus:"SUCCESS"` 由脚本自动领走；Mimir 可查到对应 `daily_reward7` 交易。
- **手动安全检查**：随时可勾选 `dry_run=true` 点 `Run workflow` —— 只做一次链上检查，不值守、不提交、**不接力**，安全。
- **停止**：禁用 workflow，或删 `.github/workflows/claim.yml`；也可先把 schedule 注释掉。停用后链在最后一个 job 预算耗尽时自然终止（或手动取消 run）。
- **PAT 到期 / Revoke**：只影响「我这边」推送与手动点火；链内接力用内置 `github.token`，**不依赖任何 PAT**。若加了 `NC_DISPATCH_TOKEN` 才需要随 PAT 更新该 Secret。
- **费用**：public 仓库免费且不限分钟数；**private 仓库绝不可用**（24/7 常驻 ≈ 43200 分钟/月，远超免费额度）。
- **游戏私钥 / keystore 密码**只在 GitHub Secrets 与本会话沙箱 `.env`（600），不进仓库、不进日志、不进交付 zip。
- 交付包为 12 个白名单文件，已扫描确认无真实 PAT / 明文私钥 / keystore / `.env`。

### 上线过程中的链上动作（如实记录）

- 权限探测：2 次无内容变更 PUT（调整前 403，未改动仓库）。
- 推送：2 次真实 PUT（仅代码/workflow，无链上交易）。
- 点火：1 次 `workflow_dispatch`（60s 短预算，链上远离窗口，**未提交任何交易**）。
- 接力：1 次 `workflow_dispatch`（内置 token，创建第一跳常驻 job）。
- **本阶段零链上领取交易**。当前链上：日常剩约 3.0h、巡逻剩约 8.8h，链会自己等到期后领取。

---

## 八、AP 满时先 Sweep（2026-11-09 新增）

### 起因与纠错

用户提出「日常领的是 AP，上限 120，满了就领不了，得先 Sweep 消耗完再领」。查
`Lib9c/Action/DailyReward.cs` 源码后纠正了一个前提：**链上并没有「AP 满不能领」的检查**，
`Execute` 只校验冷却块，最后无条件 `SetActionPoint(avatar, ActionPointMax = 120)`（**补满**）。
即 AP 满时领取照样 `SUCCESS`，只是收益为 0 且白刷一次冷却 —— App 里点不动是客户端 UI 限制。

所以真实诉求不是「修漏领」，而是「别浪费这次领取」：AP 满时先消耗掉 120 AP 再领，
才能拿到整整 120 AP（外加 30 次 sweep 掉落）。用户确认按此实现并上线。

### 链上排查结论

| 项 | 结论 |
|---|---|
| 真实 action | `hack_and_slash_sweep10`（不是 `hack_and_slash_sweep`） |
| 该角色成功记录 | block `11749808`、`11746256` 等 7 笔，均 `SUCCESS` |
| 实际 sweep 关卡 | **world 9 / stage 446**，不是 `lastClearedStage` 的 world 10 / stage 495 —— 客户端按 `SweepRequiredCPSheet` 的 CP 要求选关，硬用 495 会 `NotEnoughCombatPointException` |
| 关键参数 | `actionPoint=120`（一笔扣完）、`apStoneCount=0`、装备/服装/符文列表、每次新 `id` |
| 失败代价 | CP 校验在扣 AP **之前**，sweep 失败不扣 AP，只费一个 nonce |
| 构造方式 | Mimir `actions.raw` 与链上真实 action（`transaction.getTx.serializedPayload` 解出的 actions[0]）**逐字节完全相同**（1058 字节），仅换 `id` 即可，零类型风险 |
| 当前 AP | 上线前实测 `actionPoint = 120`（满），下次日常解锁块 `11753626` |

### 实现（只动 `claim.mjs`，未改 workflow）

- `getAvatarState` 增读 `actionPoint`；`shouldSweep` 仅当「日常 + AP ≥ 120 + 开关开启」为真。
- `fetchSweepTemplate`：从 Mimir 取**本角色最近一笔 `SUCCESS` 的 sweep** 原始字节，自动跟随装备/关卡变化；故障回退内置模板（block `11749808`）。
- `buildSweepAction`：复用字节，只把 `GameAction.Id` 换成新的 16 字节，其余一字不改（保证 CP、`playCount`、`EntryCostItemCount` 全部与成功交易一致）。
- `spendApBySweep`：提交 sweep → `confirmTx` 等终态 → 再提交日常（nonce 自动递增）。初版「失败/超时/异常一律降级照常领日常」，第九节已升级为**失败重试 5 次**。
- 触发判据只看链上 AP：sweep 成功扣完 AP 后 `shouldSweep` 自动变 false，交棒后新 job 不会重复 sweep。
- 开关 `--no-sweep`（默认开）；演练钩子 `--simulate-ap-full`。

> 第八节描述的是初版单次 sweep 行为；**当前以第九节的重试版为准**。

### 验证（全部通过）

- `node --check` + `self-test` **24/24**（新增 `shouldSweep` 8 例 + 模板重建保真）。
- 内置模板与链上真实 action **逐字节一致**；除 `id` 外所有字段一致。
- 真实链上 dry-run：日常剩 544 块未到期、不误触发。
- daemon 演练 `--simulate-ap-full`：正确出现 `would_sweep`，仅 daily 触发、patrol 不触发，正常交棒。
- mock 变异副本 8 场景：AP 满+sweep 成功 → **先 sweep(#7) 再 daily(#8)** nonce 递增正确；
  sweep FAILURE/PENDING/模板异常均降级照常领；AP 未满/读不到/patrol/`--no-sweep` 均不 sweep。
- 真实签名链路：两笔 `signTx` + `encodeSignedTx` 均可解码，
  action 依次为 `hack_and_slash_sweep10`（stage 446、AP 120、新 16 字节 id）与 `daily_reward7`。
- **本次改动全程未提交任何真实链上交易**（除只读查询）。

### 上线

- `claim.mjs` → commit `b839c55`（sha `cbd9aac`），`README.md`、`TRIGGER.md`、部署包同步。
- 云端 runner 用仓库代码，已在两个奖励都远离解锁（日常剩数百块）时切换到新代码的 run，
  旧提交锁定的 in_progress/pending run 已取消，链条无缝接管。
- 观察点：下次日常到期（约 tip `11753626`）时，日志应出现
  `AP 已满：已提交 sweep 消耗 AP` → `sweep 成功，AP 已消耗，继续领日常` → `领取成功`，
  随后 Mimir 可查到 `hack_and_slash_sweep10` 与 `daily_reward7` 两笔 `SUCCESS`。

---

## 九、Sweep 失败重试 5 次（2026-11-09 加固）

### 起因

用户指出：「**如果 sweep 失败超时或异常，就会浪费 120AP，可不可以 sweep 先重试 5 次，如果再失败，再照常领取**」。

初版 `spendApBySweep` 只提交**一笔** sweep，只要回执是 `FAILURE` / `INVALID` / `PENDING`（确认超时）
或提交异常，就立即降级「照常领日常」。这里的隐患比「少一次 sweep 掉落」更微妙：

1. **超时错配**：`confirmTx` 超时返回 `PENDING` 时，那笔 sweep 交易可能还在飞、nonce 被占着，
   甚至稍后就 `SUCCESS` 了。脚本却马上 `getNonce` 提交 `daily_reward7`，可能出现
   「sweep 后来成功扣了 120AP，但日常已经领过（AP 满时补满=零收益）」的错配 —— 白等一个冷却周期。
2. **偶发抖动**：一次 RPC / Mimir 抖动就放弃整个 sweep，太脆弱，尤其 AP 已满时等于这次领取白费。

### 实现（只动 `claim.mjs`，workflow 不变）

- 新增 `SWEEP_MAX_ATTEMPTS`（默认 **6** = 首次 + 重试 5 次）、`SWEEP_RETRY_GAP_MS`（默认 4000）、
  `SWEEP_CONFIRM_TRIES`（每笔给足确认时间）、`SWEEP_BUDGET_MS`（整体 480s 硬上限）。
  全部可用命令行覆盖：`--sweep-attempts` / `--sweep-retry-gap-ms` /
  `--sweep-confirm-tries` / `--sweep-budget-seconds`。
- `spendApBySweep` 改为重试循环：失败 / `PENDING` / 异常都继续尝试；
  **每笔换新的 `GameAction.Id`（16 随机字节）+ 重新 `getNonce`**，不撞 id、不撞 nonce。
- 新增纯函数 `sweepDecision({txStatus, chainAp, attempt, maxAttempts})` → `success` / `retry` / `degrade`，
  便于离线自测；新增 `readChainApQuiet()` 在**每次重试前复核链上 `actionPoint`**。
- **只认链上**：重试前若链上 AP 已 < 120，说明此前某笔其实成功了（典型的「超时但其实 SUCCESS」），
  立即判 `swept`、`confirmedBy=chain_ap` 并收手，**绝不重复提交 sweep**。这既避免了多扣 AP，
  也消除了上面第 1 条的错配。
- `confirmTx(txId, tries)` 增加可选轮询次数参数，日常领取行为完全不变。
- 次数用尽 / 预算耗尽 / 全异常 → `sweep_unconfirmed`，**一律降级照常领日常**，
  绝不因可选优化阻塞领取、错失冷却窗口。
- 结构化输出 `rewards[].sweep` 增加 `maxAttempts` / `attempts` / `attemptLog[]` /
  `confirmedBy` / `chainAp`，逐笔可追溯。

### 链上安全性

- **不会重复消耗 AP**：`hack_and_slash_sweep10` 执行时会扣 120 AP；多笔先后上链时，
  第一笔成功后 AP 归零，后续笔因 AP 不足 `FAILURE`，无副作用。链上幂等天然兜底。
- 每笔都重新取 `nonce`，与前一笔（哪怕还 `STAGING`）串行不冲突；`daily_reward7` 始终在
  sweep 循环彻底结束后才提交。
- 重试只在「AP 满 + 日常奖励」时发生，巡逻奖励、AP 未满、`--no-sweep` 均不受影响。

### 验证（全部通过，未提交任何真实链上交易）

- `node --check` + `self-test` **40/40**（新增 `sweepDecision` 14 例、两次重建 id 不同、默认 6 笔语义）。
- 离线 mock 副本（真实 `signTx`/`encodeSignedTx` 签名编码链路，仅替换网络层）**30/30**：
  | 场景 | 结果 |
  |---|---|
  | A 首次 SUCCESS | sweep 1 笔 + daily 1 笔，nonce 7→8，`swept` |
  | B 前 2 次 FAILURE 第 3 次 SUCCESS | sweep 3 笔，attempts=3，nonce 7,8,9,10 连续 |
  | C 第 1 笔 PENDING 但链上 AP 已扣 | **只提交 1 笔**，`confirmedBy=chain_ap`，不重复提交 |
  | D 6 次全 FAILURE | 恰好 6 笔后 `sweep_unconfirmed`，降级照常领日常且成功 |
  | E 第 1 笔提交异常 | 重试第 2 笔成功，attempts=2 |
  | F AP 未满 / 巡逻 | 完全不触发 sweep |
  | G sweep 全失败 + daily 也失败 | 不抛异常，daily 交调用方按链上复核重提 |
- 真实链上 `--dry-run --watch --simulate-ap-full` 演练：日志正确显示
  `本应最多 6 次尝试 sweep 消耗 AP 后再领日常`，`would_sweep`，未提交任何交易。
- 每笔 sweep 的 payload 均真实可解码为 `hack_and_slash_sweep10`，日常为 `daily_reward7`。

### 上线与观察

- 改动时链上 tip `11754456`，日常解锁块 `11756185`（剩 1729 块 ≈ 3.8h）、
  巡逻 `11759335`（剩 4879 块），两个奖励都远离解锁，是安全切换窗口。
- 上线后在下一轮冷却窗口触发新 run / 取消锁定旧 commit 的 run，链条无缝接管。
- 观察点：AP 满时日志应出现
  `AP 已满：提交 sweep 消耗 AP（第 1/6 次尝试）`；
  若首笔失败则有 `sweep 第 N/6 次未确认成功（…），复查链上状态后重试`；
  成功为 `sweep 成功（第 N 次尝试），AP 已消耗，继续领日常 → 领取成功`；
  全失败为 `sweep 连续 6 次尝试均未确认成功，降级照常领日常`。
