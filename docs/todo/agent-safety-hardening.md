# TODO: Agent 高风险流程安全加固

> 创建日期：2026-05-21
> 目标周期：未来一个月逐步完善
> 背景：Agent 接入招聘核心流程后，不能只看单次 demo 上限，需要完善中途监控、回退、人工介入、自检四个维度的工程保障。

---

## P0 — 本周内

### 1. `ReplyFactGuard` 升级为阻断模式

**当前状态**：`src/agent/guardrail/output/hard-rules.service.ts` Phase 1 仅告警，坏回复仍会下发。

**目标**：在配置中增加 `blockOnViolation` 开关（默认 `false`，灰度开启），命中规则时拦截发送并触发 fallback 安全回复（如"稍等，我帮你确认一下"）。

**关键改动点**：
- `ReplyFactGuardService.validate()` 返回 `{ passed, violations }` 结构
- `MessagePipelineService` 在调用 `MessageSenderService` 前检查结果
- fallback 回复文案写入 `hosting_config` 可配置，不硬编码

---

### 2. Booking API / 群邀请工具加熔断

**当前状态**：`duliday-booking.tool.ts`、`invite-to-group.tool.ts` 直接调用外部 API，失败时无熔断，会连续阻塞整条 pipeline。

**目标**：用计数器熔断（或引入 `opossum`）包裹这两个外部调用：
- 连续失败 N 次（建议 3）→ 开路，返回预定义错误结构
- 半开状态：每 30s 放一个探测请求
- 熔断触发时同步发飞书告警

**关键改动点**：
- 新建 `src/infra/circuit-breaker/circuit-breaker.service.ts`（轻量计数器实现，无需引入重型库）
- 工具 `execute()` 包裹 circuit breaker，不修改工具对外接口

---

## P1 — 两周内

### 3. 死信队列：消息处理失败不再静默丢弃

**当前状态**：Bull Job 失败后无死信处理，消息静默丢弃，难以排查。

**目标**：
- 为 `MessageMergeService` 的 Bull Queue 配置 `attempts` + `backoff`（指数退避）
- 超出重试上限的 Job 写入 `failed_messages` 表（chat_id、content、error、failed_at）
- 每日定时任务扫描该表，超 24h 未处理的发飞书汇总告警

**关键改动点**：
- `src/channels/wecom/message/services/message-merge.service.ts` — Bull Job 配置
- 新建 Supabase migration：`failed_messages` 表
- `src/biz/monitoring/` — 定时清理/报警任务

---

### 4. 人工介入后的恢复路径

**当前状态**：`InterventionService` 暂停托管是单向的，无恢复入口，只能线下手动解除。

**目标**：
- 飞书告警卡片增加"恢复托管"按钮（飞书 Interactive Card + Webhook 回调）
- 新增 `/wecom/intervention/resume` 内部接口（`ApiTokenGuard` 保护）
- 恢复后写入 `intervention_logs` 记录操作人和时间戳

**关键改动点**：
- `src/biz/intervention/intervention.service.ts` — 增加 `resumeHosting()`
- `src/infra/feishu/` — 告警卡片模板增加 Action 按钮
- 新建 `InterventionController`

---

### 5. 告警 SLA 闭环追踪

**当前状态**：告警发出后没有"人工是否已处理"的记录，无法统计响应率。

**目标**：
- 每条告警写入 `alert_logs` 表（alert_type、triggered_at、resolved_at、resolved_by）
- 飞书卡片"已处理"按钮点击后回写 `resolved_at`
- 每日 09:00 定时检查昨日未 resolve 的告警并重发提醒

**关键改动点**：
- 新建 Supabase migration：`alert_logs` 表扩展
- `src/infra/alert/alert.service.ts` — 发送时写 DB
- 新增定时 Cron Job

---

## P2 — 一个月内

### 6. 外部服务统一 retry-with-backoff 框架

**当前状态**：各工具 fallback 各自为政，无一致的重试语义。

**目标**：
- 在 `src/infra/` 下封装 `retry-policy.util.ts`：支持固定/指数退避、最大次数、jitter
- `HttpClientFactory` 支持注入 retry policy
- 逐步替换各工具中散落的手工重试逻辑

---

### 7. Agent 自检：中间决策节点守卫

**当前状态**：`ReplyFactGuard` 只检查最终输出，Agent 中间决策（选岗位、筛选答案）无校验。

**目标**：
- 在 `runner.service.ts` 的 `onStepFinish` 钩子中，对关键工具（`duliday_job_list`、`booking_precheck`）的返回值做结构校验
- 工具返回异常结构时，注入补充 system 消息纠偏，而非静默传递

---

### 8. 监控数据驱动自动补救

**当前状态**：Dashboard 数据只展示，不触发动作。

**目标**：
- 定义几个自动补救规则（如：同一 chat_id 30 分钟内连续 3 次错误 → 自动触发 intervention）
- `MonitoringService` 增加规则引擎（轻量：条件列表 + action 函数），不引入外部规则引擎

---

## 验收标准

| 条目 | 验收方式 |
|------|----------|
| ReplyFactGuard 阻断 | 构造违规回复，确认被拦截且 fallback 回复正常下发 |
| 熔断器 | 模拟 API 连续失败，确认第 3 次后开路并触发告警 |
| 死信队列 | 人工让 Bull Job 失败，确认写入 failed_messages 表 |
| 恢复路径 | 飞书卡片点击恢复，确认托管重新开启且有日志 |
| 告警 SLA | 发告警 → 点已处理 → 查 resolved_at 有值 |

---

## 参考文件

- [安全守卫架构](../architecture/security-guardrails.md)
- [人工告警触发清单](../infrastructure/human-alert-triggers.md)
- [Gate 拒绝与人工介入流水线](../architecture/handoff-gate-and-intervention-pipeline.md)
- [监控系统架构](../architecture/monitoring-system-architecture.md)
