# 部署指南：GitHub Actions 方案（A）

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

如果你坚持用 Private，两个办法二选一：在账号里绑定付款方式接受约 $5/月，或把 `claim.yml` 第 10 行的 `*/15` 改成 `*/30`（每 30 分钟，约 1450 分钟/月，落在免费额度内，代价是最坏晚领 30 分钟）。

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

> **上传后请核对一件事**：在仓库文件列表里点进 `.github/workflows/`，确认能看到 `claim.yml` 和 `keepalive.yml` 两个文件。
> GitHub 网页拖拽文件夹一般会保留子目录；如果 `.github` 这个以点开头的目录没被带进去，就手动补：
> `Add file` → `Create new file`，文件名填 `.github/workflows/claim.yml`，把交付给你的 `claim.yml` 内容整段粘贴进去；`keepalive.yml` 同样操作。
>
> 有 git 基础也可以用命令行捷径：
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

> 可选：`Variables` 标签页加 `NC_AVATAR` = 角色地址。**不填也行**，脚本里已有默认地址 `0xAC9D450C69dF27ee290C90EC61c4B76154b0A21c`。
>
> 安全说明：这两个 Secret 在日志里会被 GitHub 自动遮蔽；每次运行把加密 keystore 写成 runner 内的临时文件，解密并校验归属后生成 600 权限的 `.env`，跑完即删，runner 随后销毁。**明文私钥从不进仓库、从不进日志。**

### 第 4 步：打开写权限（保活任务需要）

仓库 → `Settings` → `Actions` → `General` → 找到 **Workflow permissions** → 选 **`Read and write permissions`** → Save。

> 不做这步，`keepalive.yml` 的空提交会失败（不影响领奖本身，但 60 天后定时任务会被 GitHub 自动停用）。

### 第 5 步：手动跑一次，验证（这一步不会领奖）

仓库 → `Actions` 标签 → 左侧选 `9C 自动领奖 (Heimdall)` → 右侧 `Run workflow` → **保持 `dry_run` 勾选（默认就是）** → 点绿色的 `Run workflow`。

等约 30–60 秒，点开这次运行看日志，最后一行应该是类似这样的 JSON：

```json
{"ok":true,"status":"checked","dryRun":true,"tip":11736xxx,
 "rewards":[{"reward":"daily","status":"not_ready",...},
            {"reward":"patrol","status":"not_ready",...}]}
```

- `ok:true` + 两个 `not_ready` = **部署成功，只是还没到领取时间**。
- 若显示 `would_claim` = 正好到期了，但因为你勾了 dry_run，**没有提交任何交易**。
- 若 `ok:false`：常见原因是 Secret 粘贴不完整（JSON 少了尾部括号）或密码不对，见下方「排错」。

### 第 6 步：确认自动运行

首次推送后，scheduled workflow 可能需要几分钟到半小时才在 Actions 页出现。之后每 15 分钟自动跑一次。到期时脚本会签名并提交交易，日志里出现 `"status":"claimed"` 就是领到了。

### 第 7 步（可选）：删掉旧的 WorkBuddy 任务

那个任务 `15237427` 已暂停，不会报错，但已经没用了。你可以在 WorkBuddy 里让它停用或删除，或让我帮你删。

---

## 三、必须知道的三条规则

**1｜费用**
Public 仓库 = 免费。Private + 每 15 分钟 ≈ $17.4/月，超出 Free 的 $12 额度；额度耗尽后任务停止。

**2｜60 天自动停用**
GitHub 官方规则：仓库 60 天无任何活动，会**自动禁用** scheduled workflow。所以包里有一个 `keepalive.yml`，每周一自动打一个空提交制造活动，防止领奖任务静默停摆。它不需要你管，只要第 4 步权限开了就行。

**3｜调度延迟**
GitHub 高峰期可能延迟几分钟，`*/15` 也可能被跳过一次。最坏晚领十几分钟；巡逻奖励不累积，属于可接受损耗。若要严格准点，用常开服务器上的系统 cron（见第五节）。

---

## 四、排错

| 现象 | 原因 / 处理 |
|---|---|
| `npm ci` 报 `package-lock.json` 缺失 | 上传时漏了 `package-lock.json`，补传 |
| `缺少 NC_KEYSTORE_JSON / NC_KEYSTORE_PASS Secrets` | 第 3 步两个 Secret 没建或名字拼错 |
| `keystore 解密失败（密码错误或非标准 V3 格式）` | 重新复制完整 JSON（确认首尾花括号都在）、核对密码；不要用聊天里被截断的文本 |
| `私钥与角色不匹配` | 上传的 keystore 不是这个角色的；脚本会**拒绝写 .env、不会产生任何交易** |
| Actions 页看不到定时任务 | 首次推送后等一会；或到 `Actions` → 对应 workflow → `Enable workflow` |
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
