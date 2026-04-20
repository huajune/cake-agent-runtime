---
name: analyze-chat-badcases
description: 抽样分析招聘 Agent 的生产对话质量，识别问题并协作修复，生成针对性测试集验证修复。用于以下场景：用户提到"分析生产对话"、"找 badcase"、"Agent 表现怎么样"、"对话回归"、"质量审计"、"候选人流失分析"、"抽查最近的聊天"，或任何涉及招聘 Agent 对话质量改进的闭环任务。即使用户没有显式说"分析 badcase"，只要他们在讨论 Agent 对话问题并想动手改进，就应该用这个 skill。
---

# Analyze Chat Badcases

产品能力：抽样生产对话 → LLM 分析 → 协作修复 → 生成针对性测试集 → 跑测试验证。

## 业务语境

- 招聘 Agent（不要预设细分赛道/目标，让数据说话）
- 失败代价：候选人流失、需要招募经理人工介入

## 数据源

**生产 Supabase 直连**（只读）：
- MCP 工具：`mcp__supabase__execute_sql`
- `project_id`: `uvmbxcilpteaiizplcyp`

两张核心表按 `message_id` 1:1 join：`chat_messages`（完整对话）+ `message_processing_records`（每 turn 工具调用/记忆/异常）。

字段含义见 `references/schema.md`——在 Step 2 读完原始数据后需要参考。

## 执行步骤

### Step 1. 抽样

默认抽最近 15 个候选人完整对话。用户指定了其他数量就按用户说的。

直接用 `queries/latest-chats.sql`：把文件内容读出来，把 `:sample_size` 替换成实际数字，通过 `mcp__supabase__execute_sql` 执行。

一次 SQL 拿全所有 turn，不要循环调多次。

### Step 2. 分析

按 `chat_id` 把原始行拼成对话流水（user/assistant 交替），然后判断每条对话里 Agent 的表现。

**不预设分析维度**——结合业务语境自己识别问题、自己归类命名。预设维度会让你只看见已知问题、错过真正有价值的新发现。

字段不理解时查 `references/schema.md`，尤其 `anomaly_flags` / `tool_calls` / `memory_snapshot` 这三个 JSONB 字段是判案主要依据。

### Step 3. 产出分析报告

在对话里直接输出 markdown。模板：

```markdown
# 对话分析报告（chat × N）

## 概要
- 样本范围：{时间范围}
- 总 turn / assistant turn 数 / 失败率 / 平均时延
- 有 anomaly_flags 的 turn 比例
- 有 fallback 的 turn 比例

## 问题分类

### [你自己命名的问题]
- 触发样本：chat_id={xxx}, chat_id={xxx}
- 典型片段（引用 2~3 行对话原文）
- 判断理由
- 修复方向：具体到代码位置 / prompt 段落 / 工具实现

## 整体观察
（对这批样本的整体判断）
```

### Step 4. 与用户对齐

展示报告后问：哪些问题优先修？修复方向是否认同？按用户回答决定下一步。

**不要跳过这步直接改代码**——用户可能有你看不到的上下文（业务优先级、上线计划、已知正在修的问题）。

### Step 5. 实施修复

按常规开发流程：
- Read 相关代码定位问题点
- 改代码 / prompt / 工具实现
- 遵循 `.claude/agents/code-standards.md`
- 业务规则（红线、阶段目标等）在 `src/biz/strategy/`，需要时去读，不要硬编码进 skill

### Step 6. 生成针对性测试集（草稿）

**针对本次修复的问题类型**生成用例，不是 badcase 全量档案。

每个 case 契约：
- `input`: 触发场景的用户输入（单条或多轮）
- `expected_behavior`: 自然语言描述期望的 Agent 行为（描述行为，别写死回复文本）
- `references_chat_id`: 关联的真实案例 chat_id（可追溯）
- `problem_category`: Step 3 里定义的问题名

在对话里用 markdown 表格或 JSON 展示全量草稿。

### Step 7. 用户对话确认

用户会说"这条删""这条改""加一条 xxx"。直接在对话里迭代，不需要飞书、不需要独立审核流程。

### Step 8. 导入 test-suite

test-suite 模块已有 HTTP 接口。端点速查见 `references/test-suite-api.md`。调用前 Read 对应 DTO 文件确认契约。

### Step 9. 跑测试

调 test-suite 批次执行端点，轮询结果。输出：
- 通过率
- 未通过用例清单 + 失败原因
- 若通过率不理想，回 Step 5 继续迭代

### Step 10.（可选）广播

询问用户："要不要把这次分析+修复+验证结果发飞书群？"

是则使用飞书告警 service（`src/infra/feishu/`）发 markdown 消息。

## 判断边界

**你被期望做**：
- 判断对话好坏（招聘语境 + 业务常识）
- 归类问题模式，自己命名
- 读代码定位、改代码
- 生成测试用例并根据用户反馈迭代

**你不要做**：
- 不要跳过 Step 4 / Step 7 直接改代码或入库——用户需要审查闸门
- 不要硬编码红线清单；业务规则在 `src/biz/strategy/`，要用时去读
- 不要把 SQL 原始结果直接丢给用户——先按 chat_id 聚合成对话流水再分析
- 不要在任何文件里写 `API_GUARD_TOKEN` 的值
- 不要把 `agent_invocation` 列拉出来——90% 是重复 system prompt，爆 context 还没信息量

## 参考文件

- `queries/latest-chats.sql` — 抽样 SQL，Step 1 直接用
- `references/schema.md` — 两表字段含义 + anomaly_flags / tool_calls / memory_snapshot JSONB 结构
- `references/test-suite-api.md` — test-suite 端点速查，Step 8/9 用
