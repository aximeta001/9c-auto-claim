# 部署指南：GitHub Actions 方案（A）

> **本文件是「全新部署 / 零基础」操作指南**，重点讲网页上点哪里、以及历史上踩过的坑
> （隐藏文件、Run workflow 按钮层级、日志三层展开），这些说明至今有效。
>
> ⚠️ **但正文里的架构参数已过时**：2026-11-08 最终升级为「**纯 GitHub 自接力长链**」——
> job 内 `claim.mjs --daemon` 常驻 5.5 小时、预算耗尽后用 workflow_dispatch 接力下一个 job，
> **完全不依赖 WorkBuddy**；`timeout-minutes` 355、`permissions` 增加 `actions: write`、
> 新增「接力」step。cron `3,18,33,48` / 每 15 分钟 / `检查并领取` 步骤名 / 费用估算等都是**旧版**。
>
> **如果你是从零新建仓库**：上传文件时直接用交付包里最新的 `claim.mjs` 与
> `.github/workflows/claim.yml`（或 `workflows-to-paste.txt` 第 1 段），下面涉及具体参数的
> 段落以实际文件内容为准；网页操作步骤仍然照做。
>
> **已装好的仓库请看 `TRIGGER.md`**：那里有最终架构、参数、验证结果，以及
> **2026-11-08 15:00 的上线实测记录**（点火 → 第一跳自接力成功 → 停用 WorkBuddy 任务）。
> 系统现已上线运行。**不要用下面的旧参数覆盖已有仓库。**

这是一份**给没用过 GitHub 的人**写的逐步操作说明。全部在网页上点，不用装软件、不用敲命令行（第 2 步有一条可选的命令行捷径）。

先说清楚两件事：

- **为什么换成 GitHub**：WorkBuddy 的云端定时任务每次唤起的是一个**全新隔离沙箱**，看不到上一次会话写的脚本和私钥（实测报错 `run.sh: No such file or directory`）。GitHub Actions 天生是「每次全新 runner、代码由仓库提供、密钥由 Secrets 注入」，正好对症。
- **仓库必须由你自己建**：我这个沙箱没有你的 GitHub 登录（`gh auth status` = 未登录），我没有权限、也不应该替你持有账号。但下面的步骤已经拆到「点哪里、填什么」，约 10 分钟能做完；**私钥不会经过我，也不需要你在对话里贴**。

---

## 一、开始之前，你手上要有的东西

| 东西 | 从哪来 |
|---|---|
| 一个 GitHub 账号 | 没有就去 https://github.com 免费注册 |
| `keystore.json` | 就是你之前从游戏客户端导出的那个文件（**你自己电脑上有**） |
| keystore 密码 | 你设的那个密码 |
| `9c-auto-claim-deploy.zip` | 已经交付给你，解压到本地即可 |

> 解压后会看到 `claim.mjs`、`import-key.mjs`、`package.json`、`package-lock.json`、`.gitignore`、`.github/` 等。**里面没有任何私钥**——我打包时用了显式白名单并核验过。

---

## 二、七步部署

### 第 1 步：新建仓库（建议选 Public）

登录 GitHub → 右上角 `+` → `New repository`：

| 填什么 | 值 |
|---|---|
| Repository name | `9c-auto-claim`（随意） |
| 可见性 | **建议选 Public** |
| 初始化选项 | **都不要勾**（不要 Add README / .gitignore / license） |

**为什么建议 Public（这点反直觉，但很重要）**：

- GitHub 对**公开仓库的标准 runner 完全免费**，不消耗分钟额度；私有仓库免费额度是 $12/月 ≈ 2000 分钟。
- 每 15 分钟 = 约 96 次/天 ≈ **2900 分钟/月**，Linux runner $0.006/分钟 ≈ $17.4/月，**私有仓库会超出免费额度约 $5/月**，额度耗尽后任务会停跑。
- 公开仓库**不含有任何密钥**：仓库里只有脚本代码和一个公开的链上角色地址；keystore 和密码存在 Secrets 里（加密、不对访客可见、不会被 fork 带走）。链上交易本来就是公开的，公开仓库不会多暴露什么。

如果你坚持用 Private，两个办法二选一：在账号里绑定付款方式接受约 $5/月，或把 `claim.yml` 的 cron 改成 `3,33 * * * *`（每 30 分钟、错峰，约 1450 分钟/月，落在免费额度内，代价是最坏晚领 30 分钟）。

### 第 2 步：把文件上传到仓库

在空仓库页面点 `uploading an existing file`（或 `Add file` → `Upload files`），把解压出来的**所有文件**拖进去：

```
claim.mjs
import-key.mjs
package.json
package-lock.json      ← 必须有，否则 npm ci 会失败
run.sh
README.md
DEPLOY.md
.gitignore
.github/workflows/claim.yml
.github/workflows/keepalive.yml
```

> **重要：GitHub 网页的「上传文件」界面会过滤掉以点开头的隐藏文件/文件夹** —— `.github`、`.gitignore`
> 拖不上去、提示看不见，都是正常的。**这不是你电脑的设置问题**，改系统「显示隐藏文件」也没用，
> 上传这一步照样会跳过。**所以这两个隐藏项一个都别上传。**
>
> 正确做法是：**让 GitHub 自己创建这两个文件**，根本不经过上传界面。
> 在 GitHub 里新建的文件，`.github` 会作为**普通可见文件夹**正常显示在仓库里 ——
> 只有「上传」这一步会卡，仓库里不会把它藏起来。
>
> 1. **只**把根目录 **7 个可见文件**拖进上传框并 Commit：
>    `claim.mjs`、`import-key.mjs`、`package.json`、`package-lock.json`、`run.sh`、`README.md`、`DEPLOY.md`
> 2. 仓库页 → `Add file` → `Create new file`，在**文件名框**里原样填 `.github/workflows/claim.yml`
>    （用正斜杠 `/`，不要写成反斜杠；GitHub 会自动创建 `.github/workflows/` 两层目录）
> 3. 把 `claim.yml` 内容粘贴进正文 → `Commit changes`
> 4. 重复 2–3，文件名填 `.github/workflows/keepalive.yml`，粘贴 `keepalive.yml` 内容
>
> **内容从哪复制**：解压后直接打开可见文件 `workflows-to-paste.txt`（双击即可，两段内容已分好、标了文件名），
> 或打开单独交付的 `claim.yml` / `keepalive.yml` 文件卡片全选复制。
> `workflows-to-paste.txt` 只是给你复制内容用的，**不用上传**。
>
> **`.gitignore` 同样是隐藏文件**：跳过即可，不影响运行 —— GitHub 方案里 keystore 和 `.env` 从不进仓库，它只是防误提交的保险。
>
> 建完后**务必**回仓库首页确认能看到 `.github` 文件夹、点进去有 `workflows` 和两个 yml ——
> 缺了 workflow 就不会自动跑，Actions 页也不会出现 `Run workflow` 按钮
> （第 5 步找不到按钮，就是因为隐藏文件没传上去）。
>
> 有 git 基础也可以用命令行捷径（git 会正确处理隐藏文件）：
> ```bash
> git clone https://github.com/<你的用户名>/9c-auto-claim.git
> cd 9c-auto-claim
> # 把解压出的文件全部复制进来（含 .github 目录）
> git add -A && git commit -m "init" && git push
> ```

拉到页面底部点 `Commit changes`。

### 第 3 步：填两个 Secret（私钥只在这里，且是加密形式）

仓库 → `Settings` → 左侧 `Secrets and variables` → `Actions` → `New repository secret`：

| Secret 名 | 值怎么填 |
|---|---|
| `NC_KEYSTORE_JSON` | 用记事本/文本编辑器打开你的 `keystore.json`，**全选复制整个 JSON 文本**，粘贴进 Value |
| `NC_KEYSTORE_PASS` | keystore 密码 |

> 可选：`Variables` 标签页加 `NC_AVATAR` = 主角色地址（仅用于 `import-key.mjs` 归属校验，市场扫货链按它指定单个角色）。**不填也行**。
> 领奖链的**角色列表不来自这里**，而是 `claim.mjs` 内置的三个角色（bnb / bnbyes / tomoon，同一 agent）。如需改动另加 `NC_AVATARS`（逗号分隔的 `名字:0x地址`），留空即用默认三角色。三个角色共用同一把私钥，无需新增任何 Secrets。
>
> 安全说明：这两个 Secret 在日志里会被 GitHub 自动遮蔽；每次运行把加密 keystore 写成 runner 内的临时文件，解密并校验归属后生成 600 权限的 `.env`，跑完即删，runner 随后销毁。**明文私钥从不进仓库、从不进日志。**

### 第 4 步：打开写权限（保活任务需要）

仓库 → `Settings` → `Actions` → `General` → 找到 **Workflow permissions** → 选 **`Read and write permissions`** → Save。

> 不做这步，`keepalive.yml` 的空提交会失败（不影响领奖本身，但 60 天后定时任务会被 GitHub 自动停用）。
>
> **想立刻验证有没有开对**：`Actions` → 左侧点 `保活（防止定时任务被自动停用）` → `Run workflow` 手动跑一次，绿色对勾即表示权限正常，不用等到周一。
> 注意：领奖任务日志开头的 `GITHUB_TOKEN Permissions: Contents: read` 是 `claim.yml` **自己声明**的只读权限，属正常现象，不能用它判断本步是否做对。

### 第 5 步：手动跑一次，验证（可跳过，不会领奖）

> **这步不是必须的。** 按钮怎么都找不到就直接跳过，去做第 6 步：定时任务每 15 分钟会自动跑，
> 等下一次运行（首次可能要等半小时）去 `Actions` 页看记录，验证效果一样。

**先做 10 秒自检**（按钮找不到，九成是这一步没过）：

1. 回到仓库首页文件列表，能不能点进 `.github` → `workflows`，看到 `claim.yml`？
   - **看不到** → 第 2 步的「网页新建文件」还没做成功。此时 Actions 页是空的、**没有任何按钮是正常的**，回到第 2 步补上。
2. 点开 `claim.yml`，**第一行必须是** `name: 9C 自动领奖 (Heimdall)`，且文件里不能出现
   `===== BEGIN =====`、中文说明、`workflows-to-paste` 等字样。
   - **有杂内容** → 把整个 txt 连说明一起粘进去了，YAML 解析失败、workflow 不会出现。只复制
     `BEGIN` 与 `END` 之间的**纯 YAML** 重新粘贴并 Commit。

自检通过后，按钮的**精确层级**（最容易漏的是第 2 步）：

1. 仓库顶部点 **`Actions`**
2. **在左侧边栏点 workflow 名称** `9C 自动领奖 (Heimdall)` —— 必须点进去；停留在
   「All workflows」总览页是看不到按钮的
3. 进入该 workflow 的运行列表页后，**右上方**有一个带下拉箭头的 **`Run workflow`**
   （中文界面叫「运行工作流」/「运行工作流程」）
4. 点开它 → 选分支（默认 `main`）→ **保持 `dry_run` 勾选**（默认就是）→ 点绿色的 `Run workflow` 确认

> 需要写权限（自己建的仓库都有）。如果左侧连 workflow 名称都没有：确认文件在**默认分支**
> （`main`）、路径是 `.github/workflows/`、Actions 没被禁用（`Settings` → `Actions` → `General`
> 允许所有 actions；或点掉 Actions 页顶部的启用横幅）。

### 怎么看日志（GitHub 默认把每一步折叠起来，要点开三层）

等约 30–60 秒后：

1. `Actions` → 左侧 `9C 自动领奖 (Heimdall)` 的运行列表里，**点这次运行的标题**（显示提交信息和时间的那一行）
2. 进入运行详情页 → 点中间那个 job 卡片 **`claim`**
3. 这时看到的是步骤列表，但**每一步默认折叠成一行**；点 **`常驻值守并领取（--daemon）`** 左侧的 `>` 箭头展开，才能看到命令行输出
4. 拉到这一步日志的底部，最后一行就是脚本输出的结构化 JSON

> 也可以在运行详情页右上角 `⋯` → `Download log` / `View raw logs` 看纯文本。
> **「状态提示成功但没看到日志」几乎都是停在第 1～2 层**：停留在运行列表页或 job 概览页，
> 只会看到绿色对勾和几个步骤标题，不会显示命令行输出。这不是日志丢了，是没展开。

**「绿色对勾」本身已经等于验证通过**：它表示全部 step 退出码为 0，反推出
Secrets 值正确、keystore 解密成功、派生地址与链上 agent 匹配、脚本完整跑完。
所以就算暂时没展开日志，也可以确认配置无误。

展开后最后一行类似（手动 `dry_run` 现在是 `--check-all`，逐一核对 3 个角色）：

```json
{"network":"heimdall","mode":"check-all","dryRun":true,"ok":true,
 "avatars":[
   {"label":"bnb","avatar":"0xAC9D…","actionPoint":120,
    "rewards":[{"reward":"daily","unblockBlock":11776652,"blocksRemaining":1942,"ready":false,"wouldSweep":true},
               {"reward":"patrol","unblockBlock":11775559,"blocksRemaining":849,"ready":false,"wouldSweep":false}]},
   {"label":"bnbyes","avatar":"0x3614…","actionPoint":0,"rewards":[…]},
   {"label":"tomoon","avatar":"0x897f…","actionPoint":0,"rewards":[…]}],
 "msg":"已核对 3 个角色，未提交任何交易"}
```

| 日志里的关键字 | 含义 |
|---|---|
| `ok:true` + 列出 3 个角色 | 部署成功，三个角色的链上状态都读到了 |
| `ready:false` | 该角色这项奖励还没到领取时间 |
| `ready:true` | 现在可领（但 `dry_run` 不会领，也不会值守/接力） |
| `wouldSweep:true` | 该角色日常奖励到期时，会因 AP 满先做 30 次 Sweep |
| `ok:false` | 常见原因是 Secret 粘贴不完整（JSON 少了尾部括号）或密码不对，见下方「排错」 |

> **想确认有没有真的领到，就看 `claimed`。** 手动 `dry_run` 只做只读核对、从不提交交易；
> 取消勾选 `dry_run`（或常驻链自动运行）后，日志里出现 `"status":"claimed"` 才是已领取。
> 旧版 `--watch` 演练里的 `would_claim` 已不再出现在手动验证输出中。

**验证通过之后，你什么都不用做**：关掉页面即可。定时任务会自动运行、到期自动领取，
手动运行只是一次性验证，不会开启或关闭任何东西。

> ⚠️ **但「定时任务从没触发过」是另一回事，别把手动运行成功当成定时任务已生效。**
> 手动运行（`workflow_dispatch`）成功只证明脚本和密钥没问题；**自动调度是否生效，
> 要看 Actions 运行列表里有没有出现触发方式为 `Scheduled` 的运行**。
> 全新或刚改过的 `schedule` 需要 GitHub 后台注册，首次可能延迟 15 分钟到 1 小时以上，
> 且 `*/15 * * * *` 这种整点 cron 在高负载时可能被跳过/丢弃。
> 判断方法与处理步骤见下方「四、排错」的「只有手动运行，从没出现过 Scheduled 运行」一条。

### 第 6 步：确认自动运行

首次推送后，**新建的 schedule 需要 GitHub 后台注册，首次触发可能延迟 15 分钟到 1 小时以上**，请耐心等到下一个错峰点（每小时 :03/:18/:33/:48 UTC）。注册生效后按 cron 每 15 分钟触发一次。到期时脚本会签名并提交交易，日志里出现 `"status":"claimed"` 就是领到了，**自动运行的日志同样按第 5 步的三层路径展开查看**。

> 定时任务（schedule）是**真实模式**：与手动验证的 `dry_run` 不同，它到期会真的提交交易。
> 所以你不必再手动点任何东西，也不要为了「确认」反复点 `Run workflow`（并发已加锁，但没必要）。
>
> **想确认「确实由定时任务领到」**：在运行列表里找触发方式标为 **Scheduled**（不是手动的 `workflow_dispatch`）的那次，按第 5 步三层路径展开日志，末尾 JSON 出现 `"status":"claimed"` 就是真实领取成功。
> 另一个间接证据：领取成功后链上解锁块会跳到「领取区块 + 间隔」（日常 +2550、巡逻 +5400），
> 所以对比前后两次日志里的 `unblockBlock`，数值大幅前移 = 已经领过了。
>
> **必须说清的边界**：手动验证（勾了 `dry_run`）**从不提交交易**，只有 Scheduled 运行才是真实模式。
> 所以在第一次出现 `"status":"claimed"` 之前，「签名 → 广播 → 上链确认」这条真实领取链路
> 还没有在 runner 上端到端跑过，它会在下一次奖励到期时自然被验证。
> 到期前的日志一律是 `not_ready`，**这是正常的，不是脚本坏了**；判断定时任务是否生效要看
> 运行列表里有没有出现带 **Scheduled** 标记的运行，而不是看有没有领到。
> 若一直没出现过 Scheduled 运行，先按第四节「定时任务从未触发」处理，否则真实领取永远不会发生。

### 第 7 步（可选）：删掉旧的 WorkBuddy 任务

那个任务 `15237427` 已暂停，不会报错，但已经没用了。你可以在 WorkBuddy 里让它停用或删除，或让我帮你删。

---

## 三、必须知道的三条规则

**1｜费用**
Public 仓库 = 免费。Private + 每 15 分钟 ≈ $17.4/月，超出 Free 的 $12 额度；额度耗尽后任务停止。

**2｜60 天自动停用**
GitHub 官方规则：仓库 60 天无任何活动，会**自动禁用** scheduled workflow。所以包里有一个 `keepalive.yml`，每周一自动打一个空提交制造活动，防止领奖任务静默停摆。它不需要你管，只要第 4 步权限开了就行。

**3｜调度延迟与首次注册**（这一条最容易踩）
- **首次注册延迟**：新建或新改的 `schedule` 需要 GitHub 后台识别，**首次触发可能延迟 15 分钟到 1 小时以上，个别情况更久**；在首次定时运行成功前，界面常常只显示 `workflow_dispatch` 触发器。部署完 Actions 页暂时只有手动运行、没有 Scheduled 运行，是常见现象，不等于配置错。
- **整点高峰丢弃**：官方说明每小时 :00/:30 等高峰负载大，定时运行可能被延迟甚至丢弃。本包已把 cron 设为**错峰** `3,18,33,48 * * * *`（避开 :00/:15/:30/:45）。
- **cron 是「固定钟点」，不是「改完后等 15 分钟」**：`3,18,33,48 * * * *` 只在每小时的第 3、18、33、48 分钟触发。北京比 UTC 快整 8 小时，所以两地**分钟数相同**（UTC 16:48 = 北京 00:48）。刚 Commit 完立刻去看，很可能下一个钟点还没到，属于正常。
- **推送 commit 可尝试重新同步**：GitHub 支持团队在处理调度不同步的个案时给过「向默认分支推一次 commit 会重新同步定时任务」的办法，社区也普遍用它排查。但这是**经验性做法，不是保证生效的开关**——同步延迟由 GitHub 后台决定，改完仍要等下一个钟点，反复改 cron 不会让它更快。
- **多久算异常**：从最后一次 Commit 起，连续跨过 **3～4 个错峰钟点**（约 45～60 分钟）仍没有任何 `Scheduled` 运行，才判定为 GitHub 侧调度异常，此时再考虑第五节的系统 cron 或联系 GitHub Support。
- 综合下来最坏晚领十几到几十分钟；巡逻奖励不累积，属可接受损耗。若要求严格准点，用常开服务器上的系统 cron（见第五节）。

---

## 四、排错

| 现象 | 原因 / 处理 |
|---|---|
| GitHub 上传时提示 `.github` 是隐藏文件 / 看不见、传不上去 | **正常且必然**：网页上传界面会过滤点开头的隐藏项，改电脑的显示设置也无效。**不要上传它**，改用第 2 步的 `Add file → Create new file` 在 GitHub 里直接建；建好后 `.github` 在仓库里是可见的普通文件夹 |
| `.gitignore` 同样传不上去 | 跳过即可，不影响运行；需要的话同样用 `Create new file` 新建 |
| `Actions` 页找不到 `Run workflow` 按钮 | 九成是 workflow 文件没进仓库、或粘了多余说明文字 → 做第 5 步的「10 秒自检」；其次确认已**点进左侧 workflow 名称**（总览页没有按钮）、文件在默认分支、Actions 未被禁用。**这步可直接跳过**，等定时任务自动跑 |
| 运行显示绿色「成功」，但看不到日志 | 日志没丢，是**没展开**：运行列表 → 点运行标题 → 点 job `claim` → 点 `常驻值守并领取（--daemon）` 左侧的 `>` 展开步骤。也可用右上角 `⋯` → `View raw logs`。绿勾本身已说明 Secrets、解密、归属校验全通过 |
| `npm ci` 报 `package-lock.json` 缺失 | 上传时漏了 `package-lock.json`，补传 |
| `缺少 NC_KEYSTORE_JSON / NC_KEYSTORE_PASS Secrets` | 第 3 步两个 Secret 没建或名字拼错 |
| `keystore 解密失败（密码错误或非标准 V3 格式）` | 重新复制完整 JSON（确认首尾花括号都在）、核对密码；不要用聊天里被截断的文本 |
| `私钥与角色不匹配` | 上传的 keystore 不是这个角色的；脚本会**拒绝写 .env、不会产生任何交易** |
| Actions 页看不到定时任务 | 首次推送后等一会；或到 `Actions` → 对应 workflow → `Enable workflow` |
| **只有手动运行，从没出现过 Scheduled 运行** | ① **先算钟点**：cron 是固定钟点而非「改完+15 分钟」，`3,18,33,48` 只在每小时 :03/:18/:33/:48 触发（UTC 与北京分钟数相同），刚 Commit 完没触发是正常的；② 新建 `schedule` 首次注册可能延迟 15 分钟~1 小时以上，**耐心跨过 3～4 个错峰点**再看；③ 在网页上编辑 `claim.yml` 并 Commit 一次，是社区常用的「触发 GitHub 重新同步调度」办法（经验性，非保证）；④ 检查 Actions 页有无黄色「因仓库无活动已暂停」横幅，有则点 `Enable workflow`；⑤ 确认文件在默认分支 `main`、路径 `.github/workflows/`、cron 已是错峰。若跨过 4 个钟点仍为 0 次，多为 GitHub 后端调度问题，可联系 GitHub Support 或改用第五节系统 cron |
| 到期前日志一直是 `not_ready` / 想验证真实领取却没发生 | 手动运行默认 `dry_run`，**只检查不提交**；只有 Scheduled 运行且奖励到期才会提交交易。到期前不强行提交，避免浪费 gas 和产生失败交易留痕 |
| `keepalive` 运行失败 `permission denied` | 第 4 步没开 `Read and write permissions` |
| 跑了一两个月突然不领了 | 大概率是 60 天自动停用，去 Actions 页 `Enable workflow` 重新启用 |

---

## 五、备选：本地 / 常开服务器 cron（方案 C）

如果不想用 GitHub，把本目录放到一台常开的机器（你的电脑、NAS、VPS），装好 Node 22：

```bash
cd /path/to/9c-auto-claim
npm ci --omit=dev
# 用 keystore 生成 .env（一次性）
node import-key.mjs --keystore ./keystore.json --passphrase-file ./pass.txt
rm -f ./pass.txt

# crontab -e 加入（每 15 分钟）
*/15 * * * * cd /path/to/9c-auto-claim && node claim.mjs >> claim.log 2>&1
```

此方案私钥**完全不离开你的机器**，安全性最高；代价是机器要常开。窗口早退（`.state.json`）在本地磁盘持久，能正常生效、省请求。

---

## 六、安全边界（务必读）

1. 私钥 = 该角色账户全部资产。建议用**只放少量资产的专门挂机角色**。
2. `NC_KEYSTORE_JSON` 是加密的，配合密码才有意义；两者分开存放在 Secrets 中，GitHub 会自动遮蔽日志回显。
3. 绝不要把 `.env`、`keystore.json`、密码提交进仓库或贴进聊天；`.gitignore` 已列出这些文件。
4. 自动领取属个人便利工具，请自行确认是否符合游戏服务条款。
5. 停止方式：仓库 `Settings` → 禁用 `9C 自动领奖` workflow，或直接删掉 `.github/workflows/claim.yml`。

---

## 七、（可选）新增「市场扫货链」：Stun Rune (Adventure) 低价自动购买

这是一条**独立于领奖链**的第二条自接力链，启用后可监控 Heimdall 市场，
当 **Stun Rune (Adventure)** 的**单价 ≤ 0.2 NCG/件**时自动整单买下。
不想要这个功能可以完全跳过本节，领奖链照常工作。

### 复用已有配置，无需重新导入私钥

扫货链与领奖链**共用同一账号、同一 keystore Secrets**（`NC_KEYSTORE_JSON` /
`NC_KEYSTORE_PASS`）和 `NC_AVATAR` 变量。第 3 步已经填过就**不用再动**。

### 只需多加 2 个文件

1. `market-buy.mjs`：把交付包里的这个文件**上传**到仓库根目录（普通文件，非隐藏）。
2. `.github/workflows/market.yml`：在 GitHub 网页新建文件，文件名框原样填
   `.github/workflows/market.yml`，内容用 `workflows-to-paste.txt` 里
   **【第 3 个文件】** 那一段 `===== BEGIN =====` / `===== END =====` 之间的纯 YAML 全选复制。
   （隐藏文件网页上传会被过滤，用 Add file → Create new file 创建，详见第 2 步说明。）

> `market.yml` 用独立的 `concurrency` 组，与领奖链互不排队、互不干扰；
> 它的接力会触发 `market.yml` 自己，形成独立的常驻链。

### 点火

`Actions` 左侧选 **「9C 市场扫货 (Heimdall / Stun Rune Adventure)」** → `Run workflow`：
- **取消勾选 `dry_run`** → 进入真实常驻值守（每 ~60s 扫一次，出现便宜单即买）；
- 勾选 `dry_run` → 只扫描一轮验证识别与价格，不提交、不值守、不接力。

之后链条自接力维持，与领奖链并行。想停止：单独禁用或删除 `market.yml` 即可，
不影响领奖链。

### 原理、参数、验证、安全边界

详见 `README.md` 第七节、`TRIGGER.md` 第十节。要点：
- **绝不搞混物品**：用资产唯一 ticker `RUNESTONE_STUN_ADVENTURE` 精确匹配
  （RuneSheet id `10021`），Stun Rune (Arena) 是 `RUNESTONE_STUN_ARENA`（id `10022`），
  从数据源头分开；名字模糊搜索、大小写不符、其它符文一律拒绝；链上执行还会
  校验 `productId/price/seller`，不符即失败、无资金损失。
- **单价判定**：`price(NCG) × 100 ≤ 20 × quantity` 纯整数运算，恰好 0.2 命中，
  避开总价陷阱与浮点误差。
- 账户 NCG 余额不足时会跳过、不白提交；失败/超时不锁死，下轮重扫链上最新挂单。
