# 人工告警触发场景清单

> 当前所有触发飞书告警的代码点。底层统一走 `AlertNotifierService.sendAlert` /
> `OpsNotifierService` / `ConversationRiskNotifierService` / `OnboardFollowupNotifierService`，
> 由 `IncidentReporterService` 与 `InterventionService` 等做编排，最终落到飞书机器人卡片。
>
> 配套查阅：
> - 飞书群组与 webhook 配置：[feishu-alert-system.md](./feishu-alert-system.md)
> - 按目标群组聚合的简表：[feishu-notification-catalog.md](./feishu-notification-catalog.md)

## 人工介入路径对比

| 触发器 | 是否短路 Agent | 本轮是否回复候选人 | 暂停托管/告警执行方式 |
|---|---|---|---|
| `request_handoff` 工具 | ✅ runtime 立即结束本轮 | ❌ 候选人本次不会收到任何回复 | 异步 fire-and-forget |
| `raise_risk_alert` 工具 | ❌ Agent 继续走完本轮 | ✅ Agent 自主组织共情/安抚话术 | 异步 fire-and-forget |
| 规则前置拦截（regex） | ❌ Agent 继续走完本轮 | ✅ Agent 正常生成回复 | 异步 fire-and-forget |

---

## 一、对话风险类（人工接管会话）

> 路径：`InterventionService.dispatch` → 异步暂停托管 + 异步飞书人工介入卡（fire-and-forget）

### 1. 规则前置拦截

- **位置**：[pre-agent-risk-intercept.service.ts](../../src/channels/wecom/message/application/pre-agent-risk-intercept.service.ts)
- **来源**：`source=regex_intercept`
- **条件**：用户消息命中高置信关键词正则（辱骂 / 投诉 / 举报 / 情绪升级）
- **效果**：Agent 仍继续生成回复，dispatch 异步暂停托管 + 发卡

### 2. Agent 主动告警（`raise_risk_alert` 工具）

- **位置**：[raise-risk-alert.tool.ts](../../src/tools/raise-risk-alert.tool.ts)
- **来源**：Agent 工具调用
- **条件**：LLM 在推理中识别到 `abuse / complaint_risk / escalation`
- **效果**：Agent 仍输出共情/安抚话术，dispatch 异步暂停托管 + 发卡

### 3. 转人工短路（`request_handoff` 工具）

- **位置**：[request-handoff.tool.ts](../../src/tools/request-handoff.tool.ts)、runner 短路：[runner.service.ts](../../src/agent/runner.service.ts)（`SHORT_CIRCUIT_TOOL_NAMES`）
- **来源**：Agent 工具调用
- **条件**：面试 / 入职跟进阶段需人工，原因码：
  - `cannot_find_store`
  - `no_reception`
  - `booking_conflict`
  - `onboarding_paperwork`
  - `interview_result_inquiry`
  - `modify_appointment`
  - `self_recruited_or_completed`
  - `other`
- **效果**：runtime 立即结束本轮 loop（与 `skip_reply` 同属短路工具），候选人本次不会收到任何回复；
  暂停托管 + case 改为 handoff + 飞书告警全部异步执行；
  即便没有 active case，也会异步暂停托管，避免继续对话。

---

## 二、消息处理链路异常（候选人无响应风险）

> 路径：`AlertNotifierService.sendAlert`，标注 `requiresHumanIntervention: true`

### 4. Agent / 消息管道处理失败

- **位置**：[message-processing-failure.service.ts:102](../../src/channels/wecom/message/application/message-processing-failure.service.ts#L102)
- **code**：`agent.invoke_failed` 或 `message.processing_failed`
- **条件**：发送降级回复前的告警（非投递错误）

### 5. 降级回复也失败（CRITICAL）

- **位置**：[message-processing-failure.service.ts:216](../../src/channels/wecom/message/application/message-processing-failure.service.ts#L216)
- **code**：`message.delivery_failed`
- **条件**：用户彻底收不到任何回复

### 6. Agent 主动降级（`isFallback`）

- **位置**：[message-processing-failure.service.ts:301](../../src/channels/wecom/message/application/message-processing-failure.service.ts#L301)
- **code**：`agent.fallback_required`
- **触发链路**：[reply-workflow.service.ts:348](../../src/channels/wecom/message/application/reply-workflow.service.ts#L348) → `sendFallbackAlert`

---

## 三、Agent 输入安全

### 7. Prompt 注入检测

- **位置**：[input-guard.service.ts:124](../../src/agent/input-guard.service.ts#L124)
- **code**：`prompt_injection`
- **条件**：用户输入命中 prompt injection 检测

### 8. 调试接口异常

- **位置**：[agent.controller.ts:81](../../src/agent/agent.controller.ts#L81)
- **code**：`agent.debug_chat_failed`
- **条件**：`/agent/debug-chat` 接口异常

---

## 四、业务指标周期性告警（cron 5 分钟）

> [analytics-alert.service.ts:84](../../src/biz/monitoring/services/alerts/analytics-alert.service.ts#L84)
> → `BusinessMetricRuleEngine` 评估，阈值由 Supabase `hosting_config` 动态读取，每条 30 分钟节流。

### 9. 成功率（`success-rate`）

- **WARNING**：低于 `successRateCritical + 10`（默认 90%）
- **CRITICAL**：低于 `successRateCritical`（默认 80%）

### 10. 平均响应时间（`avg-duration`）

- **WARNING**：超过 `avgDurationCritical / 2`（默认 30s）
- **CRITICAL**：超过 `avgDurationCritical`（默认 60s）

### 11. 在途请求队列（`queue-depth`）

- **WARNING**：超过阈值/2（默认 10）
- **CRITICAL**：超过阈值（默认 20）

### 12. 错误率（`error-rate`）

- **WARNING**：24h 错误数小时均值超过阈值/2（默认 5/h）
- **CRITICAL**：超过阈值（默认 10/h）

---

## 五、群任务（Bull Queue）

### 13. job 重试耗尽

- **位置**：[group-task.processor.ts:127](../../src/biz/group-task/queue/group-task.processor.ts#L127)
- **code**：`group_task.<jobName>_exhausted`

### 14. 未解析到任何目标群

- **位置**：[group-task.processor.ts:193](../../src/biz/group-task/queue/group-task.processor.ts#L193)
- **code**：`group_task.no_groups_resolved`
- **条件**：plan 阶段 `resolveGroups` 返回空（多半是 token 失效 / room label 缺失 / 缓存污染）

### 15. summarize 阶段汇总卡发送失败

- **位置**：[group-task.processor.ts:509](../../src/biz/group-task/queue/group-task.processor.ts#L509)
- **code**：`group_task.summary_failed`

### 16. 整次执行零成功

- **位置**：[group-task.processor.ts:531](../../src/biz/group-task/queue/group-task.processor.ts#L531)
- **code**：`group_task.all_skipped`（全跳过）或 `group_task.total_failure`（全失败）

### 17. 飞书运营汇总卡发送失败

- **位置**：[notification-sender.service.ts:218](../../src/biz/group-task/services/notification-sender.service.ts#L218)
- **code**：`group_task.feishu_report_failed`

### 18. 飞书运营预览卡发送失败

- **位置**：[notification-sender.service.ts:280](../../src/biz/group-task/services/notification-sender.service.ts#L280)
- **code**：`group_task.feishu_preview_failed`

---

## 六、定时任务失败

> 统一使用 `cron.job_failed` code

### 19. Supabase keep-alive ping 失败（WARNING）

- **位置**：[supabase.service.ts:102](../../src/infra/supabase/supabase.service.ts#L102)
- **频率**：每天 1 次

### 20. 业务指标检查 cron 自身失败

- **位置**：[analytics-alert.service.ts:109](../../src/biz/monitoring/services/alerts/analytics-alert.service.ts#L109)

### 21. 小时统计聚合失败

- **位置**：[analytics-maintenance.service.ts:171](../../src/biz/monitoring/services/maintenance/analytics-maintenance.service.ts#L171)

### 22. 日统计聚合失败

- **位置**：[analytics-maintenance.service.ts:305](../../src/biz/monitoring/services/maintenance/analytics-maintenance.service.ts#L305)

### 23. 数据清理 cron 失败

- **位置**：[data-cleanup.service.ts:299](../../src/biz/monitoring/services/cleanup/data-cleanup.service.ts#L299)

### 24. 聊天记录飞书同步失败

- **位置**：[chat-record.service.ts:107](../../src/biz/feishu-sync/chat-record.service.ts#L107)

### 25. 飞书多维表格同步失败

- **位置**：[bitable-sync.service.ts:166](../../src/biz/feishu-sync/bitable-sync.service.ts#L166)

---

## 七、运营提醒（`OpsNotifierService`）

### 26. 候选群全部满员

- **位置**：[invite-to-group.tool.ts:142](../../src/tools/invite-to-group.tool.ts#L142) / [:263](../../src/tools/invite-to-group.tool.ts#L263)
- **方法**：`sendGroupFullAlert`
- **条件**：拉群时所在城市/行业候选群全部满员

---

## 八、进程级 / HTTP 级兜底

### 27. 未捕获异常（CRITICAL）

- **位置**：[process-exception-monitor.service.ts:37](../../src/observability/runtime/process-exception-monitor.service.ts#L37)
- **code**：`system.process_uncaught_exception`
- **条件**：进程层 `uncaughtException`

### 28. 未处理 Promise 拒绝（CRITICAL）

- **位置**：[process-exception-monitor.service.ts:59](../../src/observability/runtime/process-exception-monitor.service.ts#L59)
- **code**：`system.process_unhandled_rejection`
- **条件**：进程层 `unhandledRejection`

### 29. HTTP 5xx

- **位置**：[http-exception.filter.ts:85](../../src/infra/server/response/filters/http-exception.filter.ts#L85)
- **code**：`server.http_exception`
- **条件**：任意 HTTP 5xx 抛出

---

## 九、子系统错误阈值

### 30. Vision 描述连续失败（WARNING）

- **位置**：[image-description.service.ts:87](../../src/channels/wecom/message/application/image-description.service.ts#L87)
- **条件**：图片/表情描述连续失败达到 `ALERT_THRESHOLD`

---

## 节流与环境策略

- 走 `AlertNotifierService` 的告警按 `dedupe.key`（缺省退化为 `code`）在
  `ALERT_THROTTLE.WINDOW_MS / MAX_COUNT` 内做去重。
- `AnalyticsAlertService` 在去重之上另有 `alertIntervalMinutes`（默认 30 分钟）的最小间隔。
- 非生产环境默认不发，需显式设置 `FEISHU_ALERT_ALLOW_NON_PROD=true` 才打开。

## 关联但非"告警"的通知

- **面试预约结果通知** [duliday-interview-booking.tool.ts:715](../../src/tools/duliday-interview-booking.tool.ts#L715)：
  走 `PrivateChatMonitorNotifierService`，成功/失败都发；失败时同步暂停托管，
  但定位是"结果通知卡"而非告警。
