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

同样两段式再取：
- `guardrail_review_records`：`count(*)` 审查数、`final_decision='block'` 拦截数、`repaired` 改写数（用 `created_at`）
- `reengagement_touch_records`：`count(*)` 计划数、`status='sent'` 实发数（用 `created_at`）

### 3. BadCase 治理台账（飞书表）

```bash
node scripts/weekly-ops-report/collect-badcase-stats.js <since> <until>
```

输出 JSON：全表总量 / 全表状态分布 / 窗口内提交量 / 窗口内状态与分类分布。凭证走 `.env.production`，只读。

### 4. 交叉校验

本周修复的 badcase 多数来自**上周及更早**的提交，别把「本周提交 N 条」和「本周修了 N 条」混写成同一个数。台账数字在持续回写，同一天两次跑会有几条差异，用最新一次。

## 三、输出格式

```
🍰 蛋糕私域托管 · 本周同步（MM/DD ~ MM/DD）

#### 📊 本周运行数据
- 对话：X 轮 / Y 位候选人，处理成功率 Z%
- 出站守卫：审查 X 条回复，改写 Y 条，拦截 Z 条
- 二次触达：计划 X 条，实发 Y 条
- BadCase：本周新提交 X 条（待分析 a / 处理中 b / 待验证 c / 已解决 d）；累计 M 条，已解决 N 条（P%）
- 发布 K 个版本 vA → vB

#### 🌆 <子领域 1>
- 短句陈述改动点，关键处 **加粗**

#### 📋 <子领域 2>
- ...
```

规则：

- **只写业务段**。AI SDK 升级、Node 版本、架构重构、守卫内部分层、测试基建、文档整理——运营感知不到，一律不写。判断标准：这条改动能不能用「候选人/招募经理会看到什么不一样」说清楚。
- 子领域用 emoji + 加粗标题，每段 3~6 条 bullet，短句。常见子领域：位置与城市识别 🌆、岗位推荐与事实口径 📋、身份与合规 🎓、面试预约与改约 📅、对话流程与收资 💬、二次触达 📣、告警与看板 🚨、质量治理机制 🔧。
- **只写已上线的事**。写「已经做了 X」前确认 X 已经在本周发布的版本里；未发版的分支改动不写。
- 不写验证记录、不写 PR 号（运营用不上）、不写「预计/计划」。
- 长度控制在一屏内读完，宁可合并同类项也不逐 PR 罗列。

## 四、交付

生成后直接在会话里输出全文，并写一份到 `docs/releases/<年>/weekly-YYYY-MM-DD.md` 存档。**不要**自动发企微/飞书——外发由人决定。
