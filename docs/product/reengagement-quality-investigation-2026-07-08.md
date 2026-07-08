# 复聊质量调研报告

## 调研范围

本次调研从 `2026-07-07 13:58:55 +0800` 修复点之后开始，分析生产库 `reengagement_touch_records` 中的复聊生成记录。

本报告先忽略 UI 展示问题，只关注两个核心问题：

1. 复聊任务该不该创建。
2. 复聊生成的内容能不能直接发给候选人。

样本口径：

- `status = shadow`
- `decision_reason = no_delivery_port`
- 含义：如果打开真发，这些就是本应发送出去的复聊内容。

样本量：**86 条复聊生成记录**。

## 结论摘要

当前复聊不适合开启真发。

追踪链路已经补齐，但业务质量还不达标。严格按“任务创建合理 + 生成内容可直接发送”计算，当前可用样本只有：

```text
39 / 86 = 45.35%
```

主要问题不是单点小瑕疵，而是三类硬伤叠加：

1. 同一候选人短时间内重复创建相似复聊任务。
2. 生成内容泄漏系统上下文，比如 `[消息发送时间：...]`。
3. 轻量复聊场景生成了长篇岗位推荐或内部评审内容。

## 核心数据

```json
{
  "totalGeneratedTasks": 86,
  "generatedReply": 77,
  "nonReply": 9,
  "replyRate": "89.53%",
  "badContentReplies": 19,
  "cleanReplies": 58,
  "replyContentAccuracy": "75.32%",
  "duplicateExtraTasks": 24,
  "strictCleanTasks": 39,
  "strictCleanRate": "45.35%"
}
```

## 任务创建问题

发现 **24 条额外重复任务**。

典型模式是同一个候选人在 10-16 分钟内连续触发：

```text
opening_no_reply -> address_missing
```

两个场景生成的内容高度相似，都是让候选人发定位、区域、商圈或地铁站。

示例：

```text
opening_no_reply:
方便发个定位给我吗？或者告诉我你大概在哪个商圈、地铁站附近，我帮你查下最近的岗位

address_missing:
方便的话发个定位给我，或者告诉我你在哪个商圈、地铁站附近，我帮你看看最近的岗位
```

这说明当前调度层缺少“同一 session 近时段场景互斥/合并”机制。两个业务场景在用户感知上其实是同一种追问。

任务创建准确率保守估算：

```text
(86 - 24) / 86 = 72.09%
```

## 内容生成问题

77 条生成了可发送回复，其中 **19 条存在硬错误**。

内容准确率：

```text
58 / 77 = 75.32%
```

如果把未生成可发送回复的 9 条也计入失败，则：

```text
58 / 86 = 67.44%
```

问题类型如下：

```json
{
  "timestampLeak": 9,
  "internalEvaluationLeak": 2,
  "jobRecommendationDumpInLightFollowup": 8,
  "tooLong": 6,
  "missingExpectedAsk": 7
}
```

## 按场景看

```json
{
  "address_missing": {
    "total": 32,
    "bad": 9
  },
  "opening_no_reply": {
    "total": 34,
    "bad": 8,
    "nonReply": 4
  },
  "booking_incomplete": {
    "total": 5,
    "bad": 1,
    "nonReply": 1
  },
  "store_presented_no_reply": {
    "total": 12,
    "bad": 1,
    "nonReply": 1
  },
  "interview_reminder": {
    "total": 3,
    "reply": 0,
    "nonReply": 3
  }
}
```

`address_missing` 和 `opening_no_reply` 是问题最集中的两个场景。

## 典型错误

### 1. 时间标记泄漏

```text
方便的话发个定位给我，我帮你就近找找看～
[消息发送时间：2026-07-07 14:55 星期二]
```

### 2. 内部评审泄漏

```text
✅ 对话已完成，符合信任建立阶段要求：
- 自然简短开场
- 首问直接引导发定位/区域
- 未追问品牌/岗位类型
```

### 3. 轻量复聊变成长岗位推荐

```text
我帮你查下宝山区附近的岗位。

成都你六姐（宝杨宝龙店）- 洗碗工，1.4km
班次：17:30-22:00
薪资：24 元/时起...
要求：...
```

这类内容明显不符合 `address_missing` 的目标。该场景应该轻量提醒候选人补位置，而不是直接生成岗位推荐列表。

## 判断

当前复聊系统的问题可以拆成两层：

1. 调度层：同一候选人缺少场景互斥，导致短时间重复复聊。
2. 生成层：主动复聊没有足够强的输出约束，模型会复用上下文里的系统标记、历史回复、甚至内部评审内容。

## 建议优先级

### P0

复聊真发继续关闭，只保留 shadow。

### P1

加同 session 近时段互斥规则。比如 `opening_no_reply` 和 `address_missing` 在 30 分钟内只允许一个生效，优先保留更具体的场景。

### P1

生成前清理上下文，禁止 `[消息发送时间：...]`、评审结论、trace/debug 文本进入可见消息上下文。

### P1

加主动复聊输出守卫。命中以下内容直接 `guardrail_blocked` 或重新生成：

- `[消息发送时间`
- `✅ 对话已完成`
- `符合...阶段要求`
- `策略`
- 长岗位列表
- 超过轻量复聊长度阈值

### P2

为每个复聊场景加硬性生成模板或 schema。尤其是 `opening_no_reply`、`address_missing` 只能生成一句轻问，不允许推荐岗位列表。

### P2

补人工标注集。当前报告是硬规则自动评估，能识别明显错误；语气、上下文是否自然，还需要抽样人工标注。
