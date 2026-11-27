# 操作铁律（动手前必读）

> 这份清单不是备忘，是**硬约束**。凡涉及链上提交（爬楼 / sweep / 领取）的任务，
> 动手前逐条对照，任一条不满足就不许提交。
>
> 每条都尽量落到**代码**里，而不是靠"记得"。代码会拦，人不会犯错。

---

## 一、AB / sweep 铁律（血泪教训，勿犯）

### 1. 没冲过目标层，绝不 sweep

- **规则**：sweep 前必须读到**链上真实 floor ≥ 目标层（默认 28）**，否则拒绝提交。
- **为什么**：sweep 积分是从第 1 层累加到 `explorer.Floor` 逐层抽取。少打一层，
  每笔就少拿那一层的分；20 笔少约 12~14 万分，直接影响赛季排名与奖励占比。
- **代码落点**：`sweep-boss.mjs` 的 `--min-floor`（默认 28）硬门槛。
  读不到 floor / floor < 门槛 / 赛季窗口不一致 → **直接拒绝，不提交**。

### 2. 顺序不可颠倒：先确认达标，再 sweep

- 爬楼 → 读链上 floor 复核 → 确认 ≥ 目标层 → 才允许 sweep。
- 绝不"边爬边扫"或"按推算的层数扫"。

### 3. 层数只认链上权威字段，绝不用交易笔数推算

- 个人 floor / maxFloor **只能**从 heimdall6 的 `adventureBossSeasonStatus` 读。
- 禁止"每笔 explore 就当打满到 maxFloor"这类推算——explore 受 CP 限制会打不满
  （历史真实出现过 `20→24` 未打满）。
- 节点落后 / 字段读不到 → **报错停止**，不许拿推算值顶替、更不许据此判"达标"。
- **代码落点**：`explore-boss.mjs` 已删除 Mimir 推算路径，改回真实字段 + 一致性校验。

### 4. 门票只用 Golden Dust（爬楼解锁）

- `unlock_floor` 强制 `u=false`（Golden Dust），**绝不使用 NCG**。
- 复核 `usedNcg` 必须为 0。

### 5. 日常 sweep 绝不能用空符文（会把你身上的符文清空）

- **规则**：日常 sweep 的 `runeInfos` 必须来自**当前链上真实符文槽**；读不到就拒绝
  sweep，宁可不领日常也**绝不用空符文提交**。
- **为什么**：`HackAndSlashSweep.cs` 会 `runeSlotState.UpdateSlot(runeInfos, ...)`，把
  action 携带的符文**写回冒险符文槽**（先全卸下再重装）。空 runeInfos = 清空全部符文。
  旧脚本从最近一次 sweep 反推符文、失败时改空符文降 CP，bnb 因此每笔 sweep 都被清空，
  用户每次都要手动重装（2026-11-26）。
- **代码落点**：`claim.mjs` 的 `fetchSweepTemplate()` 从最近一笔**非空**冒险 action
  （hack_and_slash / sweep / event dungeon / adventure boss，翻页最多 600 笔）读符文；
  `pickLatestAdventureRuneSlots()` 跳过空符文 / 失败 / 非本角色 / 非冒险 action；
  读不到返回 null → `spendApBySweep` 拒绝提交。所有失败修复维度**不得清空符文**。
- **换符文后**：在游戏里装好符文并打一笔冒险战斗，脚本自动跟随最新符文。

---

## 二、通用交易纪律

### 6. 只认链上终态

- SUCCESS / FAILURE / INVALID 以链上 `transactionResult`（多节点交叉）为准。
- 节点短暂返回 `INVALID + blockIndex=null + 无异常名` 是**伪 INVALID**（尚未索引），
  不是真终态，必须继续轮询到真终态。
- **代码落点**：`sweep-boss.mjs` 批量模式 `isPhantomInvalid()`；逐笔模式 `confirmTx()`
  已加同样防护。

### 7. 不重复扣资源

- 未出真终态的交易，不盲目重发（可能已上链成功，重发=重复扣药水）。
- 有疑问先查链上真实笔数（Mimir / transactionResult），再决定补几笔。

---

## 三、协作纪律（我的行为准则）

### 8. 约定过的东西不改，要改先问

- 批量模式 / 逐笔模式、次数、层数、门票，凡是**约定好的**，不得擅自变更。
- 遇到状况需要改方案 → **先停下来问，不自行选边**。

### 9. 没查清不下结论

- 不说"差异极小""应该没问题"这类拍脑袋判断。
- 数字要算、状态要查，拿不准就明说"不确定"。

### 10. 动手前先只读确认

- 任何提交前，先只读查：赛季号 / boss / 窗口 / 真实 floor / AP 药水 / nonce 竞争。
- 确认无误再提交；发现问题如实报告，不硬上。

---

## 四、事故记录索引

| 日期 | 事故 | 复盘 |
|---|---|---|
| 2026-11-24 | floor 虚报 30（真实 27）→ 20 笔 sweep 少第 28 层，损失约 12~14 万分 | `ab-1459-第28层积分损失复盘.md` |
| 2026-11-26 | 日常 sweep 带空符文写回冒险符文槽，bnb 每次都被清空 | 本文件第 5 条；代码 `claim.mjs` `pickLatestAdventureRuneSlots()` |

---

## 五、动手前检查清单（逐条打勾）

- [ ] 赛季号、boss、窗口已从**最新节点**确认
- [ ] 真实 floor 已从**链上权威字段**读到，且 ≥ 目标层
- [ ] AP 药水 / Golden Dust 充足
- [ ] 门票策略确认（爬楼仅 Golden Dust，NCG=0）
- [ ] 符文槽已读到**非空**真实符文；读不到就拒绝 sweep，绝不用空符文清空
- [ ] 无并发 nonce 竞争（claim daemon 不与本次撞车）
- [ ] 模式/次数/层数与**约定一致**，未擅自变更
- [ ] 提交后只认链上终态，伪 INVALID 不误判
