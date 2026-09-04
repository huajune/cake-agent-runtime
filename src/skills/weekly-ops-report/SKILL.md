---
name: weekly-ops-report
description: 生成面向业务运营的周报——本周发布的业务改动点 + 可量化运行指标。用户说“出周报”“本周工作同步”“给运营的周报”“weekly report”时使用；每周五 18:00 的定时任务也走这里。
---

# 运营周报生成

面向**业务运营同事**，不是工程同事。读者关心「Agent 这周对候选人的表现有什么变化」和「跑了多少量」，不关心 PR 号、重构、架构文档。

## 一、确定窗口

默认本周一 00:00 到运行时刻（周五 18:00）。用户显式给窗口时以用户为准。

## 二、采集数据（四个源，可并行）

### 1. 本周发布的业务改动（主体内容）

```bash
git fetch origin --tags --quiet
git log --all --since="<周一>" --pretty=format:"%h|%ad|%s" --date=format:"%m-%d %H:%M" \
  | grep -viE "chore\(release\)|docs\(release\)|Merge |sync master|index on|WIP on"
git tag --sort=-creatordate --format='%(creatordate:short) %(refname:short)' | head -12
gh pr list --state merged --limit 120 --json number,title,mergedAt \
  --jq '.[] | select(.mergedAt >= "<周一 UTC>") | "#\(.number)|\(.title)"' \
  | grep -viE "chore\(release\)|docs\(release\)|sync master"
```

改动点吃不准业务含义时，`gh pr view <num> --json title,body` 看原始说明——**不要**抄 CHANGELOG pending 块，那里经常只覆盖最后一个 PR。

### 2. 生产运行量（Supabase MCP 直连生产库）

每条查询必须自带 `SET LOCAL statement_timeout`，严格串行，任一条超时立即停手（生产库连接池打满过一次全线 522）。
`message_processing_records` 的 `created_at` 无索引，**必须用 `received_at`** 并走 `WITH ... AS MATERIALIZED` 两段式。

```sql
SET LOCAL statement_timeout = '25s';
WITH w AS MATERIALIZED (
  SELECT chat_id, status FROM message_processing_records
  WHERE received_at >= '<周一> 00:00:00+08' AND received_at < '<截止>+08'
)
SELECT count(*) AS turns, count(DISTINCT chat_id) AS chats,
       count(*) FILTER (WHERE status = 'success') AS success,
       count(*) FILTER (WHERE status = 'timeout') AS timeout FROM w;
```

**质量密度环比**：把同一条 turns 查询对**上一周窗口**再跑一次（只取 count），配合下面第 3 步
上一周的 badcase 提交量，算「每千回合反馈数」的周环比。

同样两段式再取：

- `guardrail_review_records`：`count(*)` 写入行数、`final_decision='block'` 拦截数、`repaired` 改写数，再按 `first_decision` 分组（用 `created_at`）。**这是单写入者稀疏表——放行回合不写行，行数≠审查量**，不要写成「审查 X 条回复」；`first_decision='pass'` 的行是仅观察命中（误报的主要去处），单独报它的环比更有信息量。
- `reengagement_touch_records`：`count(*)` 计划数、`status='sent'` 实发数（用 `created_at`）

### 3. BadCase 治理台账（飞书表）

```bash
node scripts/weekly-ops-report/collect-badcase-stats.js <since> <until>
```

输出 JSON：全表总量 / 全表状态分布 / 窗口内提交量 / 窗口内状态与分类分布。凭证走 `.env.production`，只读。

对**上一周窗口**再跑一次拿提交量，用于质量密度环比。

### 4. 交叉校验

本周修复的 badcase 多数来自**上周及更早**的提交，别把「本周提交 N 条」和「本周修了 N 条」混写成同一个数。台账数字在持续回写，同一天两次跑会有几条差异，用最新一次。

## 三、输出格式

```
🍰 蛋糕私域托管 · 本周同步（MM/DD ~ MM/DD）

#### 📊 本周运行数据
- 对话：X 轮 / Y 位候选人，处理成功率 Z%
- 招聘漏斗（ops_events）：新增好友 / 破冰 / 岗位推荐 / 拉群邀请 / 预检通过 / 报名成功（失败）/ 改约 / 取消 / 面试通过
- 转人工：X 次，按 `payload->>'reason_code'` 分组（**不是** `payload->>'reason'`，那列是自由文本且含候选人 PII，不要入报告）
- 出站守卫：改写 X 条，拦截 Y 条；仅观察命中 Z 次（环比）
- 二次触达：计划 X 条，实发 Y 条
- BadCase：本周新提交 X 条（待分析 a / 处理中 b / 待验证 c / 已解决 d）；累计 M 条，已解决 N 条（P%）
- 质量密度：每千回合反馈 X.X 条（上周 Y.Y，8 月基线 4.3）
- 发布 K 个版本 vA → vB

#### 🌆 <子领域 1>
- 短句陈述改动点，关键处 **加粗**

#### 📋 <子领域 2>
- ...
```

规则：

- **质量密度 = 窗口内 badcase 提交量 ÷ 窗口内处理回合数 × 1000**，保留一位小数。它是抗业务量波动的质量北极星（历史：04 月 50.4 → 08 月 4.3）；绝对条数受量影响大，涨跌都不要脱离密度单独解读。基线随月度刷新，报告里写当前基线。
- **只写业务段**。AI SDK 升级、Node 版本、架构重构、守卫内部分层、测试基建、文档整理——运营感知不到，一律不写。判断标准：这条改动能不能用「候选人/招募经理会看到什么不一样」说清楚。
- 子领域用 emoji + 加粗标题，每段 3~6 条 bullet，短句。常见子领域：位置与城市识别 🌆、岗位推荐与事实口径 📋、身份与合规 🎓、面试预约与改约 📅、对话流程与收资 💬、二次触达 📣、告警与看板 🚨、质量治理机制 🔧。
- **只写已上线的事**。写「已经做了 X」前确认 X 已经在本周发布的版本里；未发版的分支改动不写。
- 不写验证记录、不写 PR 号（运营用不上）、不写「预计/计划」。
- 长度控制在一屏内读完，宁可合并同类项也不逐 PR 罗列。

## 四、交付

生成后直接在会话里输出全文，并写一份到 `docs/releases/<年>/weekly-YYYY-MM-DD.md` 存档。

### 自动投递运行数据卡片（飞书 · 蛋糕私聊监控群）

存档写完后，**把「📊 本周运行数据」那一段发成飞书卡片**（用户 2026-09-04 授权的常规动作，无需再逐次确认）：

```bash
node scripts/weekly-ops-report/send-weekly-card.js <payload.json> --dry-run   # 先看渲染
node scripts/weekly-ops-report/send-weekly-card.js <payload.json>             # 确认无误再发
```

payload 写到会话 scratchpad（不要提交进仓库），结构：

```json
{
  "windowLabel": "08/31 ~ 09/04",
  "summary": "一句话业务概述，与周报开头的引言同文",
  "metrics": ["运行数据段的每条 bullet，去掉行首的 - "]
}
```

规则：

- 卡片标题固定 `🍰 蛋糕私域托管 · 本周运行同步`，目标群固定蛋糕私聊监控群（`PRIVATE_CHAT_MONITOR_WEBHOOK_URL`，与发版通知同群），脚本已写死，不要改成别的群。
- **卡片只带运行数据**，不带系统改动条目——改动明细留在会话正文与 `docs/releases` 存档里。
- 卡片带 `<at id=all></at>` @所有人（与发版通知一致，用户 2026-09-04 要求），不要去掉。
- 先跑一次 `--dry-run` 核对渲染，再真发；发完在会话里说明已发送。
- 发送失败不要重试超过一次，把错误原样报给用户即可。
- **企微仍然不自动发**——外发企微由人决定。
