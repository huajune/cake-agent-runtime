# 飞书通知系统

## 概述

通过飞书 Webhook 机器人实现三类通知：系统异常告警、群运营通知、私聊监控通知。
支持 @指定负责人（按托管账号自动映射）和 @all。

## 飞书群组

| 群名 | Channel Key | 用途 | 环境变量 |
|------|-------------|------|----------|
| 蛋糕异常告警群 | `ALERT` | 系统异常、投递失败、Prompt注入、业务指标告警 | `FEISHU_ALERT_WEBHOOK_URL` / `FEISHU_ALERT_SECRET` |
| 蛋糕群运营通知群 | `MESSAGE_NOTIFICATION` | 群满员、群任务预览/汇总 | `MESSAGE_NOTIFICATION_WEBHOOK_URL` / `MESSAGE_NOTIFICATION_WEBHOOK_SECRET` |
| 蛋糕私聊监控群 | `PRIVATE_CHAT_MONITOR` | 面试预约成功/失败 | `PRIVATE_CHAT_MONITOR_WEBHOOK_URL` / `PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET` |

配置文件：`src/infra/feishu/constants/constants.ts`

## 通知分布

### 蛋糕异常告警群（ALERT）

| 通知类型 | @人 | 触发场景 | 代码位置 |
|----------|-----|----------|----------|
| 降级兜底响应 | @对应负责人（fallback @all） | Agent 返回降级响应 | `pipeline.service.ts` → `sendFallbackAlert()` |
| 投递彻底失败 | @all | 用户完全收不到回复（CRITICAL） | `pipeline.service.ts` → 降级发送失败的 catch |
| Agent 调试报错 | 无 | `/agent/debug-chat` 异常 | `agent.controller.ts` |
| Prompt 注入检测 | 无 | 用户消息命中注入模式 | `input-guard.service.ts` |
| 消息处理异常 | 无 | Agent/消息处理失败（投递前） | `pipeline.service.ts` → `handleProcessingError()` |
| 图片识别失败 | 无 | Vision 模型连续 3 次失败 | `image-description.service.ts` |
| 成功率告警 | 无 | 成功率低于 80% | `analytics-alert.service.ts` |
| 响应时间告警 | 无 | 平均响应 >60s | `analytics-alert.service.ts` |
| 队列深度告警 | 无 | 队列积压 >20 | `analytics-alert.service.ts` |
| 错误率告警 | 无 | 每小时错误 >10 | `analytics-alert.service.ts` |

### 蛋糕群运营通知群（MESSAGE_NOTIFICATION）

| 通知类型 | @人 | 触发场景 | 代码位置 |
|----------|-----|----------|----------|
| 群满员告警 | @高雅琪 | 群成员 >=40 或 API 返回 -10 | `invite-to-group.tool.ts` |
| 群任务预览 | 无 | 群发前 dry-run | `notification-sender.service.ts` → `sendFeishuPreview()` |
| 群任务执行汇总 | @高雅琪 | 群发完成后 | `notification-sender.service.ts` → `reportToFeishu()` |

### 蛋糕私聊监控群（PRIVATE_CHAT_MONITOR）

| 通知类型 | @人 | 触发场景 | 代码位置 |
|----------|-----|----------|----------|
| 面试预约成功 | @对应负责人（fallback @all） | 预约 API 返回成功 | `duliday-interview-booking.tool.ts` |
| 面试预约失败 | @对应负责人（fallback @all） | 预约 API 失败或异常 | `duliday-interview-booking.tool.ts` |

## @人处理流程

### 托管账号 → 飞书负责人映射

通过 `BOT_TO_RECEIVER` 映射表，根据消息来源的托管账号 wxid（`imBotId`）自动找到对应的飞书负责人：

```
消息到达 → 携带 imBotId（托管账号 wxid）
                ↓
        BOT_TO_RECEIVER[imBotId]
                ↓
    ┌───────────┴───────────┐
    ↓                       ↓
  找到映射                 未找到
    ↓                       ↓
 atUsers: [receiver]     atAll: true（兜底）
```

### 映射表

配置文件：`src/infra/feishu/constants/receivers.ts`

| bot wxid | 小组 | bot 昵称 | @飞书用户 |
|----------|------|----------|-----------|
| `1688855974513959` | 琪琪组 | 高雅琪 | GAO_YAQI |
| `1688854747775509` | 艾酱组 | 朱洁 | AI_JIANG |
| `1688855171908166` | 宇航组 | 李宇杭 | LI_YUHANG |

> 南瓜组暂无托管 bot，添加后在 `BOT_TO_RECEIVER` 补一行即可。

### 使用此映射的场景

- **降级兜底响应**：`imBotId` 来自 `params.primaryMessage.imBotId`
- **面试预约通知**：`imBotId` 来自 tool 的 `context.botImId`

### 固定 @人的场景

- **群满员告警**：固定 @高雅琪
- **群任务执行汇总**：固定 @高雅琪

### @功能优先级

`atUsers` > `atAll` > 无@

## 飞书接收人配置

配置文件：`src/infra/feishu/constants/receivers.ts`

| Key | open_id | 姓名 |
|-----|---------|------|
| `AI_JIANG` | `ou_72e8d17db5dab36e4feeddfccaa6568d` | 艾酱 |
| `GAO_YAQI` | `ou_54b8b053840d689ae42d3ab6b61800d8` | 高雅琪 |
| `NAN_GUA` | `ou_954fb7341fd7fdd320de2d419d26df19` | 南瓜 |
| `LI_YUHANG` | `ou_e6868065cb0baa3c0304441a6a8c16e7` | 李宇航 |

### 获取 open_id

通过飞书 API 用手机号查询：

```bash
# 1. 获取 tenant_access_token
curl -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"$FEISHU_APP_ID","app_secret":"$FEISHU_APP_SECRET"}'

# 2. 用手机号查 open_id
curl -X POST 'https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id' \
  -H "Authorization: Bearer <tenant_access_token>" \
  -H 'Content-Type: application/json' \
  -d '{"mobiles":["手机号"]}'
```

> `open_id` 是应用维度的，同一用户在不同飞书应用下 open_id 不同。

## 节流机制

防止告警刷屏，对 ALERT 通道的告警做节流控制：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `ALERT_THROTTLE.WINDOW_MS` | 5 分钟 | 节流窗口时长 |
| `ALERT_THROTTLE.MAX_COUNT` | 3 次 | 窗口内最大发送次数 |

**节流键**：`${errorType}:${scenario}`，例如同一个 `agent_fallback:candidate-consultation` 类型的告警，5 分钟内最多发送 3 次。

配置文件：`src/infra/feishu/constants/constants.ts` → `ALERT_THROTTLE`

## 相关代码

| 文件 | 职责 |
|------|------|
| `src/infra/feishu/constants/constants.ts` | Webhook 群通道配置、节流配置 |
| `src/infra/feishu/constants/receivers.ts` | 接收人配置、BOT_TO_RECEIVER 映射 |
| `src/infra/feishu/services/alert.service.ts` | 告警发送、节流控制 |
| `src/infra/feishu/services/webhook.service.ts` | Webhook 签名、HTTP 发送 |
| `src/infra/feishu/services/card-builder.service.ts` | 飞书卡片构建（Markdown、@人） |
| `src/channels/wecom/message/services/pipeline.service.ts` | 降级告警、投递失败告警触发点 |
| `src/tools/duliday-interview-booking.tool.ts` | 面试预约通知 |
| `src/tools/invite-to-group.tool.ts` | 群满员告警 |
| `src/biz/group-task/services/notification-sender.service.ts` | 群任务预览/汇总通知 |
| `src/biz/monitoring/services/analytics/analytics-alert.service.ts` | 业务指标告警 |

## 故障排查

### 告警未发送

1. **检查节流**：查看日志是否有 `告警被节流` 字样
2. **检查 Webhook**：确认 Webhook URL 和 Secret 配置正确
3. **检查网络**：确认服务器能访问 `open.feishu.cn`

### @人无效

1. 确认 `open_id` 正确（飞书自定义机器人只支持 open_id）
2. 确认被 @的人在该群中
3. 检查 `BOT_TO_RECEIVER` 映射是否包含对应 `imBotId`

### 新增托管账号

1. 在 `receivers.ts` 的 `FEISHU_RECEIVER_USERS` 添加飞书用户（需 open_id）
2. 在 `BOT_TO_RECEIVER` 添加 `'bot wxid': FEISHU_RECEIVER_USERS.XXX`
