# 飞书通知系统

## 概述

通过飞书 Webhook 机器人实现三类通知：系统异常告警、群运营通知、私聊监控通知。
支持 @指定负责人（按托管账号自动映射）和 @all。

## 飞书群组

| 群名             | Channel Key            | 用途                                         | 环境变量                                                                   |
| ---------------- | ---------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| 蛋糕异常告警群   | `ALERT`                | 系统异常、投递失败、Prompt注入、业务指标告警 | `FEISHU_ALERT_WEBHOOK_URL` / `FEISHU_ALERT_SECRET`                         |
| 蛋糕群运营通知群 | `MESSAGE_NOTIFICATION` | 群满员、群任务预览/汇总                      | `MESSAGE_NOTIFICATION_WEBHOOK_URL` / `MESSAGE_NOTIFICATION_WEBHOOK_SECRET` |
| 蛋糕私聊监控群   | `PRIVATE_CHAT_MONITOR` | 面试预约成功/失败/取消                       | `PRIVATE_CHAT_MONITOR_WEBHOOK_URL` / `PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET` |

通道键名登记在 `src/infra/feishu/constants/constants.ts`；Webhook 地址与签名密钥只从上表环境变量读取，代码不内置默认值。
`*_URL` 未配置时该通道跳过发送并记 warn（不阻塞启动）；`*_SECRET` 为空表示机器人未开启签名校验。

## 通知分布

### 蛋糕异常告警群（ALERT）

| 通知类型        | @人                          | 触发场景                       | 代码位置                                          |
| --------------- | ---------------------------- | ------------------------------ | ------------------------------------------------- |
| 降级兜底响应    | @对应负责人（fallback @all） | Agent 返回降级响应             | `pipeline.service.ts` → `sendFallbackAlert()`     |
| 投递彻底失败    | @all                         | 用户完全收不到回复（CRITICAL） | `pipeline.service.ts` → 降级发送失败的 catch      |
| Agent 调试报错  | 无                           | `/agent/debug-chat` 异常       | `agent.controller.ts`                             |
| Prompt 注入检测 | 无                           | 用户消息命中注入模式           | `input-guard.service.ts`                          |
| 消息处理异常    | 无                           | Agent/消息处理失败（投递前）   | `pipeline.service.ts` → `handleProcessingError()` |
| 图片识别失败    | 无                           | Vision 模型连续 3 次失败       | `image-description.service.ts`                    |
| 成功率告警      | 无                           | 成功率低于 80%                 | `analytics-alert.service.ts`                      |
| 响应时间告警    | 无                           | 平均响应 >60s                  | `analytics-alert.service.ts`                      |
| 队列深度告警    | 无                           | 队列积压 >20                   | `analytics-alert.service.ts`                      |
| 错误率告警      | 无                           | 每小时错误 >10                 | `analytics-alert.service.ts`                      |

### 蛋糕群运营通知群（MESSAGE_NOTIFICATION）

| 通知类型       | @人     | 触发场景                    | 代码位置                                                 |
| -------------- | ------- | --------------------------- | -------------------------------------------------------- |
| 群满员告警     | @高雅琪 | 群成员 >=40 或 API 返回 -10 | `invite-to-group.tool.ts`                                |
| 群任务预览     | 无      | 群发前 dry-run              | `notification-sender.service.ts` → `sendFeishuPreview()` |
| 群任务执行汇总 | @高雅琪 | 群发完成后                  | `notification-sender.service.ts` → `reportToFeishu()`    |

### 蛋糕私聊监控群（PRIVATE_CHAT_MONITOR）

| 通知类型     | @人                          | 触发场景                                                         | 代码位置                            |
| ------------ | ---------------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| 面试预约成功 | @对应负责人（fallback @all） | 预约 API 返回成功                                                | `duliday-interview-booking.tool.ts` |
| 面试预约失败 | @对应负责人（fallback @all） | 预约 API 失败或异常                                              | `duliday-interview-booking.tool.ts` |
| 面试预约取消 | @对应负责人（fallback @all） | 候选人主动取消已确认预约，取消工单成功后提醒人工确认是否同步门店 | `duliday-cancel-work-order.tool.ts` |

## @人处理流程

### 托管账号 → 飞书负责人映射

接收人唯一配置源是 `system_config` 表中 `key = hosting_member_config` 的 `value`。
`HostingMemberConfigService` 按归一化后的 botImId 读取 `members[botImId].feishuOpenId/feishuName`，不再读取本地名单。

| 配置字段 | 用途 |
| --- | --- |
| `members[botImId].feishuOpenId/feishuName` | 预约、取消、风险、转人工、消息处理失败等账号通知；普通 Task 负责人 |
| `operationsReceivers: [{openId, name}]` | 群满、群任务汇总的固定 @ 人；拉群失败同时 @ 账号负责人，按 openId 去重 |
| `taskOwners: {supervisor?, T4?, T5?, T8?, default?}` | 总部特殊类别 Task 负责人，各字段为 open_id 数组；未配置时沿用账号负责人 |

配置缓存为 **5 分钟**，修改后无需改代码或重新发版，最长 5 分钟生效。
数据库刷新失败或数据格式无效时保留进程内最后一次有效配置；首次读取失败时没有接收人。
成功读取到删除/清空配置会按新配置生效，不恢复旧名单。未绑定账号的消息沿用原调用方的 @all/无 @ 降级。

### 河南分流

接收人与发送目的地分开解析：河南小组归属继续由现有小组标记解析。
河南通知发到河南私聊监控群；河南 Task 进入独立清单，**只派给本托管账号绑定的人**，不使用总部主管、类别或 default 负责人。
河南账号没有绑定飞书身份时拒绝创建任务，不转派总部。蒋一锋的授权派单身份配置不受此调整影响。

### 配置维护与首次切换

- 新增或修改成员，只更新数据库对应 botImId 的接收人字段，并保留同项 token、人设等字段。
- 固定运营接收人直接维护 `operationsReceivers`；`[]` 表示不 @ 固定人员。
- 运行 `pnpm config:hosting:check:prod` 检查已有成员和固定接收人配置完整性；它不再和代码名单比较，也不会写库。
- 首次切换先执行 `20261118090000_unify_feishu_receivers_in_database.sql`，再部署代码。迁移仅补缺失的历史账号接收人及原固定运营接收人，保留 DB 覆盖值、河南账号和 token，可重复执行。
- 若某环境以前使用 `FEISHU_TASK_OWNER_OPEN_IDS_JSON`，先运行 `node scripts/seed-hosting-member-config.js --env <环境文件>` 预览；确认后加 `--apply` 一次性迁入 `taskOwners`，检查通过后移除旧变量再部署。已有 `taskOwners` 不会被覆盖。
- `seed-hosting-member-config.js` 仅补缺失的旧 token / 导入旧 Task 负责人；不再持有飞书人员名单。写入使用乐观锁，并发变更会停止同步。

### @功能优先级

`atUsers` > `atAll` > 无 @。Webhook/Task 清单的环境配置仍决定发送目的地，不属于人员名单。

## 飞书身份绑定

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

| 配置项                     | 默认值 | 说明               |
| -------------------------- | ------ | ------------------ |
| `ALERT_THROTTLE.WINDOW_MS` | 5 分钟 | 节流窗口时长       |
| `ALERT_THROTTLE.MAX_COUNT` | 3 次   | 窗口内最大发送次数 |

**节流键**：`${errorType}:${scenario}`，例如同一个 `agent_fallback:candidate-consultation` 类型的告警，5 分钟内最多发送 3 次。

配置文件：`src/infra/feishu/constants/constants.ts` → `ALERT_THROTTLE`

## 相关代码

| 文件                                                               | 职责                             |
| ------------------------------------------------------------------ | -------------------------------- |
| `src/infra/feishu/constants/constants.ts`                          | Webhook 通道环境变量键、节流配置 |
| `src/biz/hosting-config/services/hosting-member-config.service.ts` | 数据库接收人、运营名单、Task 负责人解析 |
| `src/infra/feishu/services/alert.service.ts`                       | 告警发送、节流控制               |
| `src/infra/feishu/services/webhook.service.ts`                     | Webhook 签名、HTTP 发送          |
| `src/infra/feishu/services/card-builder.service.ts`                | 飞书卡片构建（Markdown、@人）    |
| `src/channels/wecom/message/services/pipeline.service.ts`          | 降级告警、投递失败告警触发点     |
| `src/tools/duliday-interview-booking.tool.ts`                      | 面试预约通知                     |
| `src/tools/invite-to-group.tool.ts`                                | 群满员告警                       |
| `src/biz/group-task/services/notification-sender.service.ts`       | 群任务预览/汇总通知              |
| `src/biz/monitoring/services/analytics/analytics-alert.service.ts` | 业务指标告警                     |

## 故障排查

### 告警未发送

1. **检查节流**：查看日志是否有 `告警被节流` 字样
2. **检查 Webhook**：确认 Webhook URL 和 Secret 配置正确
3. **检查网络**：确认服务器能访问 `open.feishu.cn`

### @人无效

1. 确认 `open_id` 正确（飞书自定义机器人只支持 open_id）
2. 确认被 @的人在该群中
3. 检查 `hosting_member_config.members[imBotId]` 是否配置该成员，并等待最多 5 分钟缓存刷新

### 新增托管账号

1. 核对 botImId 和本人飞书身份（外部成员可在群里 @ 应用完成绑定）。
2. 在数据库 `hosting_member_config.members[botImId]` 配置 `feishuOpenId`、`feishuName`，保留 token、人设等字段。
3. 等待缓存刷新，验证对应通知群和 Task 清单；无需维护代码名单。
