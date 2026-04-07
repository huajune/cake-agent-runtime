# MessageSender 模块 — 消息发送全景

## 核心路由逻辑

所有企微消息发送最终经过 `MessageSenderService.sendMessage()`，靠 `_apiType` 字段路由到不同的 Stride API：

```
MessageSenderService.sendMessage(data)
  ├── _apiType === 'group'   → 小组级 API
  └── _apiType === undefined → 企业级 API
```

## 两套 Stride API 对比

| | 小组级 API | 企业级 API |
|---|---|---|
| **URL** | `POST /stream-api/message/send` | `POST /enterprise-v2/message/send?token=xxx` |
| **认证** | token 在 body 里 | token 在 URL 参数里 |
| **寻址** | `chatId`（会话 ID） | `imBotId` + `imContactId`（私聊）/ `imRoomId`（群聊） |
| **文本 messageType** | `0` | `7`（SendMessageType.TEXT） |

> `MessageSenderService` 内部自动做 messageType 转换（企业级 → 小组级），调用方统一用企业级类型编号。

## 各场景发送路径

### 1. Agent 对话回复（"从哪来，回哪去"）

回复的 API 路由由**消息回调来源**决定：

```
企业级回调进来 → _apiType 为空 → 回复走企业级 API（imBotId + imContactId）
小组级回调进来 → _apiType='group' → 回复走小组级 API（token + chatId）
```

链路：`MessageController → CallbackAdapter → Pipeline → DeliveryService → MessageSenderService`

### 2. 群任务通知（抢单群/兼职群/店长群/工作小贴士）

固定走**小组级 API**（主动发送，没有回调触发）。

```
GroupTaskSchedulerService → Strategy → NotificationSenderService
  → MessageSenderService.sendMessage({ _apiType: 'group', token, chatId })
```

### 3. 邀人进群（invite_to_group 工具）

整个流程发生在 1v1 私聊中：

1. Agent 调用 `invite_to_group` 工具 → 内部调 `RoomService.addMember()`（群管理 API，不是消息发送）
2. 工具返回结果后，Agent 在回复中自然输出话术（如"已帮你加入了XX群"）
3. 话术作为 Agent 回复的一部分，走场景 1 的回复链路（跟私聊回复完全一致）

> `addMember` 是 `POST /stream-api/room/addMember`，属于群成员管理接口，不经过 `MessageSenderService`。

### 4. Controller `/message/send`（手动调用）

DTO 校验强制走**企业级 API**（不支持 `_apiType` / `chatId` 字段）。

### 5. 降级回复（fallback）

跟回调来源一致，与场景 1 相同。

## messageType 映射表（企业级 → 小组级）

```
TEXT:         7 → 0
IMAGE:        6 → 1
LINK:        12 → 2
FILE:         1 → 3
MINI_PROGRAM: 9 → 4
VIDEO:       13 → 5
CHANNELS:    14 → 7
VOICE:        2 → 8
EMOTION:      5 → 9
LOCATION:     8 → 10
```
