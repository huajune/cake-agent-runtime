# 飞书告警系统设计文档

## 概述

本项目使用飞书 Webhook 机器人实现告警通知，支持：
- 系统异常告警（Agent API 错误、消息处理失败等）
- 话术降级告警（需要人工介入）
- 面试预约成功通知

## 飞书群组

| 群组 | 用途 | Webhook 类型 |
|------|------|--------------|
| 飞书告警群 | 系统告警 + 话术降级 | `ALERT` |
| 面试报名通知群 | 面试预约成功通知 | `INTERVIEW_BOOKING` |

## 告警触发场景

### 1. 话术降级告警（@ 琪琪）

**触发条件**：Agent API 返回降级响应（`isFallback: true`）

**触发路径**：
```
用户发消息
  → MessagePipelineService.processSingleMessage() / processMergedMessages()
  → agentGateway.invoke()
  → Agent 返回 isFallback: true
  → sendFallbackAlert() ← 触发告警，@ 琪琪
  → 正常发送降级消息给用户
```

**典型场景**：
- Agent API 调用失败（401 认证错误、500 服务器错误）
- Agent 内部处理异常后返回降级响应
- 服务启动时 `REGISTRY_INIT_FAILED` 后用户发消息

**告警内容**：
```
标题：🆘 小蛋糕出错了，需人工介入
---
用户昵称：xxx
用户消息：xxx
小蛋糕已回复：收到，我需要跟同事同步一下再回复您～
---
Agent 报错：Agent 调用失败
时间：2024-12-15 16:30:00
---
请关注：@琪琪
```

### 2. 异常处理告警（不 @ 人）

**触发条件**：`processSingleMessage()` / `processMergedMessages()` 的 `catch` 块捕获到异常

**触发路径**：
```
用户发消息
  → MessagePipelineService.processSingleMessage()
  → 某个步骤抛出异常
  → catch 块
  → handleProcessingError() ← 触发告警，不 @ 人
  → 发送降级消息给用户
```

**典型场景**：
- Agent 配置验证失败
- 历史消息获取失败
- 其他未预期的运行时异常

**告警内容**：
```
标题：🤖 Agent 出错了（根据 errorType 动态选择）
---
时间：2024-12-15 16:30:00
级别：ERROR
类型：agent
消息：xxx
会话 ID：xxx
用户消息：xxx
用户昵称：xxx
...
```

### 3. 消息发送失败告警（CRITICAL 级别，不 @ 人）

**触发条件**：降级消息发送也失败（用户完全无响应）

**触发路径**：
```
handleProcessingError()
  → deliveryService.deliverReply() 失败
  → 发送 CRITICAL 告警
```

### 4. 服务初始化告警（不 @ 人）

**触发条件**：服务启动时初始化失败

| 告警类型 | 触发时机 |
|----------|----------|
| `REGISTRY_INIT_FAILED` | 服务启动时初始化失败 |
| `REGISTRY_AUTO_REFRESH_FAILED` | 定时刷新（每小时）时失败 |

### 5. 面试预约成功通知（@ 琪琪）

**触发条件**：用户成功预约面试

**触发路径**：
```
Agent 调用 zhipin_book_interview 工具
  → ToolResultHandler 检测到预约成功
  → FeishuBookingService.notifyInterviewBooked()
  → 发送到「面试报名通知群」
```

## 告警流程图

```
                                  ┌─────────────────────────────────┐
                                  │     MessagePipelineService      │
                                  └─────────────────────────────────┘
                                               │
                         ┌─────────────────────┼─────────────────────┐
                         │                     │                     │
                         ▼                     ▼                     ▼
                 ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
                 │ try 块成功    │    │ try 块异常    │    │ 发送消息失败  │
                 │ isFallback?   │    │ catch 块      │    │ (二次异常)    │
                 └───────────────┘    └───────────────┘    └───────────────┘
                         │                     │                     │
              ┌──────────┴──────────┐          │                     │
              │                     │          │                     │
              ▼                     ▼          ▼                     ▼
       ┌─────────────┐      ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
       │ 正常响应    │      │ 降级响应    │  │ 异常处理    │  │ CRITICAL    │
       │ 无告警      │      │ @ 琪琪      │  │ 不 @ 人     │  │ 不 @ 人     │
       └─────────────┘      └─────────────┘  └─────────────┘  └─────────────┘
                                  │                │                │
                                  ▼                ▼                ▼
                            sendFallbackAlert  handleProcessingError
                                  │                │
                                  └────────┬───────┘
                                           ▼
                                  ┌─────────────────┐
                                  │ FeishuAlertService │
                                  │   节流检查       │
                                  │   (5分钟/3次)    │
                                  └─────────────────┘
                                           │
                                           ▼
                                  ┌─────────────────┐
                                  │ 飞书告警群      │
                                  └─────────────────┘
```

## @ 人规则

### 当前生效的规则

| 场景 | @ 谁 | 原因 | 代码位置 |
|------|------|------|----------|
| 话术降级（`sendFallbackAlert`） | @ 琪琪 | 需要人工介入回复用户 | `message-pipeline.service.ts` |
| 面试预约成功 | @ 琪琪 | 业务通知，需要跟进 | `feishu-booking.service.ts` |
| 异常处理（`handleProcessingError`） | 不 @ | 技术问题，开发自行关注 | `message-pipeline.service.ts` |
| 消息发送失败（CRITICAL） | 不 @ | 技术问题，开发自行关注 | `message-pipeline.service.ts` |
| 服务初始化失败 | 不 @ | 技术问题，开发自行关注 | 各模块 `onModuleInit()` |
| @ 所有人 | **无此场景** | 功能已实现但未启用 | - |

### @ 功能说明

1. **@ 特定用户**：通过 `atUsers` 参数指定，使用 `open_id`
2. **@ 所有人**：通过 `atAll: true` 参数，调用 `buildCardWithAtAll()` 方法
3. **优先级**：`atUsers` > `atAll` > 无 @

### @ 所有人功能（预留）

`atAll` 功能已实现但当前未启用，可用于未来的紧急场景：
- 服务完全不可用
- 数据库连接全部失败
- 其他需要全员关注的 CRITICAL 级别事件

启用方法：在 `sendAlert()` 调用时设置 `atAll: true`

## 节流机制

为防止告警刷屏，实现了节流控制：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `ALERT_THROTTLE.WINDOW_MS` | 5 分钟 | 节流窗口时长 |
| `ALERT_THROTTLE.MAX_COUNT` | 3 次 | 窗口内最大发送次数 |

**节流键**：`${errorType}:${scenario}`

例如：同一个 `agent:CANDIDATE_CONSULTATION` 类型的告警，5 分钟内最多发送 3 次。

节流配置支持通过 Supabase `agent_reply_config` 表动态调整。

## 配置说明

### 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `FEISHU_ALERT_WEBHOOK_URL` | 告警群 Webhook URL | 否（有默认值） |
| `FEISHU_ALERT_SECRET` | 告警群签名密钥 | 否（有默认值） |
| `INTERVIEW_BOOKING_WEBHOOK_URL` | 面试通知群 Webhook URL | 否（有默认值） |
| `INTERVIEW_BOOKING_WEBHOOK_SECRET` | 面试通知群签名密钥 | 否（有默认值） |

### 接收人配置

接收人在 `src/infra/feishu/constants/feishu.constants.ts` 中配置：

```typescript
export const ALERT_RECEIVERS = {
  // 默认告警接收人（预留，当前未使用）
  DEFAULT: [{ openId: 'ou_72e8d17db5dab36e4feeddfccaa6568d', name: '艾酱' }],

  // 话术降级告警接收人（当前使用）
  FALLBACK: [{ openId: 'ou_54b8b053840d689ae42d3ab6b61800d8', name: '琪琪' }],

  // 严重告警接收人（预留，当前未使用）
  CRITICAL: [{ openId: 'ou_72e8d17db5dab36e4feeddfccaa6568d', name: '艾酱' }],

  // 面试预约通知接收人（当前使用）
  INTERVIEW_BOOKING: [{ openId: 'ou_54b8b053840d689ae42d3ab6b61800d8', name: '琪琪' }],
};
```

**使用状态**：
| 配置项 | 状态 | 用途 |
|--------|------|------|
| `FALLBACK` | ✅ 使用中 | 话术降级告警 @ 琪琪 |
| `INTERVIEW_BOOKING` | ✅ 使用中 | 面试预约通知 @ 琪琪 |
| `DEFAULT` | ⏸️ 预留 | 普通告警（当前不 @ 人） |
| `CRITICAL` | ⏸️ 预留 | 严重告警（当前不 @ 人） |

**获取 open_id 方法**：
1. 在飞书群里 @ 某人，复制消息链接，链接中包含 open_id
2. 通过飞书开放平台 API 获取用户信息
3. 飞书管理后台 → 通讯录 → 成员详情页查看

## 相关代码

| 文件 | 职责 |
|------|------|
| `src/infra/feishu/services/feishu-alert.service.ts` | 告警发送、节流控制、消息格式化 |
| `src/infra/feishu/services/feishu-webhook.service.ts` | Webhook 签名、HTTP 发送、卡片构建 |
| `src/infra/feishu/services/feishu-booking.service.ts` | 面试预约通知 |
| `src/infra/feishu/constants/feishu.constants.ts` | Webhook URL、接收人配置 |
| `src/channels/wecom/message/services/message-pipeline.service.ts` | 告警触发点（`sendFallbackAlert`、`handleProcessingError`） |

## 告警卡片样式

### 话术降级卡片（@ 人）

```
┌──────────────────────────────────────┐
│ 🆘 小蛋糕出错了，需人工介入    [红色] │
├──────────────────────────────────────┤
│ **用户昵称**                         │
│ 张三                                 │
│                                      │
│ **用户消息**                         │
│ 请问你们公司的地址在哪里？           │
│                                      │
│ **小蛋糕已回复**                     │
│ 收到，我需要跟同事同步一下再回复您～ │
│ ──────────────────────────────────── │
│ **Agent 报错**: Payment Required       │
│ **时间**: 2024/12/15 16:30:00        │
│ ──────────────────────────────────── │
│ **请关注**: @琪琪                    │
└──────────────────────────────────────┘
```

### 普通告警卡片（不 @ 人）

```
┌──────────────────────────────────────┐
│ 🤖 Agent 出错了                [红色] │
├──────────────────────────────────────┤
│ **时间**: 2024/12/15 16:30:00        │
│ **级别**: ERROR                      │
│ **类型**: agent                      │
│ **消息**: Request timeout            │
│ **会话 ID**: chat_xxx                │
│ **用户消息**: 你好                   │
│ **用户昵称**: 张三                   │
│ **API 端点**: /api/v1/chat           │
│ **场景**: CANDIDATE_CONSULTATION     │
│ **降级消息**: 收到，我需要跟同事...  │
└──────────────────────────────────────┘
```

## 故障排查

### 告警未发送

1. **检查节流**：查看日志是否有 `告警被节流` 字样
2. **检查 Webhook**：确认 Webhook URL 和 Secret 配置正确
3. **检查网络**：确认服务器能访问 `open.feishu.cn`

### @ 人无效

1. 确认 `open_id` 正确（飞书自定义机器人只支持 open_id）
2. 确认被 @ 的人在该群中
3. 检查机器人是否有 @ 人权限

### 告警刷屏

1. 调整 `ALERT_THROTTLE` 配置
2. 通过 Supabase `agent_reply_config` 表动态调整节流参数
