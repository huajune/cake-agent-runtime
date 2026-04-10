# 飞书通知类型目录

## 群 1：蛋糕异常告警群（ALERT）— 10 类通知

| 类别 | 触发场景 | 文件 | 级别 | @人 |
|------|----------|------|------|-----|
| Agent 调试报错 | `/agent/debug-chat` 异常 | `agent.controller.ts` | ERROR | 无 |
| Prompt 注入检测 | 用户消息命中注入模式 | `input-guard.service.ts` | WARNING | 无 |
| 降级兜底响应 | Agent 返回降级回复 | `pipeline.service.ts` | WARNING | @对应负责人 |
| 消息处理异常 | Agent/消息处理失败（投递前） | `pipeline.service.ts` | WARNING/ERROR | @对应负责人 |
| 投递彻底失败 | 用户完全收不到回复 | `pipeline.service.ts` | CRITICAL | 无 |
| 图片识别失败 | Vision 模型连续 3 次失败 | `image-description.service.ts` | ERROR | 无 |
| 成功率告警 | 成功率低于 80% | `analytics-alert.service.ts` | CRITICAL/WARNING | 无 |
| 响应时间告警 | 平均响应 >60s | 同上 | CRITICAL/WARNING | 无 |
| 队列深度告警 | 队列积压 >20 | 同上 | CRITICAL/WARNING | 无 |
| 错误率告警 | 每小时错误 >10 | 同上 | CRITICAL/WARNING | 无 |

## 群 2：蛋糕群运营通知群（MESSAGE_NOTIFICATION）— 3 类通知

| 类别 | 触发场景 | 文件 | @人 |
|------|----------|------|-----|
| 群满员告警 | 群成员 >=40 或 API 返回 -10 | `invite-to-group.tool.ts` | @高雅琪 |
| 群任务预览 | 群发前 dry-run | `notification-sender.service.ts` | 无 |
| 群任务执行汇总 | 群发完成后 | `notification-sender.service.ts` | @高雅琪 |

## 群 3：蛋糕私聊监控群（PRIVATE_CHAT_MONITOR）— 2 类通知

| 类别 | 触发场景 | 文件 | @人 |
|------|----------|------|-----|
| 面试预约成功 | 预约 API 返回成功 | `duliday-interview-booking.tool.ts` | @对应负责人 |
| 面试预约失败 | 预约 API 失败或异常 | `duliday-interview-booking.tool.ts` | @对应负责人 |

## @人规则

**@对应负责人**：通过 `BOT_TO_RECEIVER[imBotId]` 映射，未匹配时 fallback 到 @all。

| bot wxid | 小组 | @飞书用户 |
|----------|------|-----------|
| `1688855974513959` | 琪琪组 | 高雅琪 |
| `1688854747775509` | 艾酱组 | 艾酱 |
| `1688855171908166` | 宇航组 | 李宇航 |

配置文件：`src/infra/feishu/constants/receivers.ts`
