# TODO: 告警持久化入口统一 + 监控 KPI 修正

## 问题背景

`monitoring_error_logs` 表是 dashboard "今日错误" KPI、错误分布列表、错误趋势图的唯一数据源，但**只有消息处理失败链路在写入**，子系统告警（群任务、Cron、Infra 异常等）全部丢失。

```
┌─────────────────────────────────────────────┐
│ 链路 A：消息处理失败                         │
│   MessageTrackingService.recordFailure()     │
│     ├─ saveErrorLog → monitoring_error_logs ✓
│     └─ persistTerminalState → message_processing_records
│                                              │
│   同事件还会触发：                           │
│   MessageProcessingFailureService            │
│     └─ alertNotifier.sendAlert → 飞书        │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ 链路 B：子系统告警                           │
│   IncidentReporterService.notifyAsync()      │
│     └─ alertNotifier.sendAlert → 飞书        │
│        ❌ 没有任何持久化                     │
│                                              │
│   AlertNotifierService.sendSimpleAlert()     │
│     └─ 同上 ❌                               │
└─────────────────────────────────────────────┘
```

实际表现：群任务"飞书预览发送失败"告警飞到 bot 群，但 dashboard 的"今日错误"显示 0。**告警群叮叮响 + dashboard 岁月静好**。

同时还有 3 个独立的算法/文案 bug，整页监控配置半瘫痪：

1. `business-metric-rule.engine.ts:159` `hourlyRate = errorCount / 24` ——"10/h"阈值实际门槛是 24h 累计 240+ 次，**永远不会触发**
2. `avgDurationCritical` 默认 60s 阈值 + warning = critical/2 = 30s，因 totalMs 含 ~3s 合并窗口，**warning 几乎必报**
3. 前端"错误趋势 (24小时)" 文案与数据源 `'today'`（今日 0 点起）不一致

---

## 目标

1. **统一告警出口**：所有走飞书的告警都先持久化再发送；节流被丢的也写表（标记 throttled）
2. **错误日志多维度**：补 subsystem / severity / summary / dedupe_key 字段，dashboard 按子系统聚合错误分布
3. **修 3 个监控配置 bug**：让告警阈值真正生效

---

## 核心设计

### 入口收敛

`AlertNotifierService.sendAlert` 成为 `monitoring_error_logs` 的**唯一**写入点：

```ts
async sendAlert(context: AlertContext): Promise<boolean> {
  const throttleKey = context.dedupe?.key || context.code;
  const willThrottle = !this.shouldSend(throttleKey);

  // 1. 无论是否节流、是否发送成功都先持久化
  let delivered = false;
  let sendError: unknown;

  if (!willThrottle && this.isFeishuDeliveryEnabled()) {
    try {
      const card = this.alertCardRenderer.buildAlertCard(context);
      delivered = await this.alertChannel.send(card);
      if (delivered) this.recordSent(throttleKey);
    } catch (error) {
      sendError = error;
    }
  }

  // 持久化失败不影响主流程
  this.persistAlertLog(context, { throttled: willThrottle, delivered }).catch((err) => {
    this.logger.warn(`持久化告警日志失败: ${err.message}`);
  });

  if (sendError) {
    this.logger.error(`发送告警失败: ${sendError}`);
    return false;
  }
  return delivered;
}
```

### 链路 A 的去重写

`MessageTrackingService.recordFailure` 删掉 `saveErrorLog` 调用——失败消息会通过 `MessageProcessingFailureService.handleProcessingError` 触发 `alertNotifier.sendAlert`，由新入口统一记录。

> 注意：少数 recordFailure 路径可能不触发 sendAlert（例如已 fallback 成功的失败）。需要逐个 audit 确认；如果有"应该入 KPI 但不发飞书"的场景，要么补 sendAlert，要么显式调 errorLogRepository。

---

## Schema 变更（一条 migration）

```sql
ALTER TABLE monitoring_error_logs
  ALTER COLUMN message_id DROP NOT NULL,        -- 系统告警可能没 messageId
  ADD COLUMN subsystem text,                    -- AlertContext.source.subsystem
  ADD COLUMN component text,                    -- AlertContext.source.component
  ADD COLUMN action text,                       -- AlertContext.source.action
  ADD COLUMN severity text,                     -- info | warning | error | critical
  ADD COLUMN summary text,                      -- 短标题
  ADD COLUMN code text,                         -- AlertContext.code
  ADD COLUMN dedupe_key text,
  ADD COLUMN throttled boolean DEFAULT false,
  ADD COLUMN delivered boolean DEFAULT false;

CREATE INDEX idx_error_logs_subsystem ON monitoring_error_logs(subsystem, "timestamp" DESC);
CREATE INDEX idx_error_logs_severity ON monitoring_error_logs(severity, "timestamp" DESC);
```

老字段（`error`, `alert_type`）保留，新写入填全字段、老数据继续可读。1-2 周观察期后可清理 `alert_type`。

---

## 涉及文件

### 主改动（~9 个）

| # | 文件 | 改什么 | 预估行数 |
|---|------|--------|---------|
| 1 | `supabase/migrations/<ts>_unify_alert_persistence.sql` | 加新字段 + 索引 | +20 |
| 2 | `src/biz/monitoring/entities/error-log.entity.ts` | 新字段 | +10 |
| 3 | `src/types/tracking.types.ts` (MonitoringErrorLog) | 同上 | +10 |
| 4 | `src/biz/monitoring/repositories/error-log.repository.ts` | toDbRecord/fromDbRecord 支持新字段 | +30 |
| 5 | `src/notification/services/alert-notifier.service.ts` | 入口加 persistAlertLog | +50 |
| 6 | `src/notification/notification.module.ts` | 注入 ErrorLogRepository（跨 module，可能要新建一个轻量 token） | +10 |
| 7 | `src/biz/monitoring/services/tracking/message-tracking.service.ts` | 删除 saveErrorLog 调用 | -15 |
| 8 | `src/analytics/metrics/analytics-metrics.service.ts` | buildAlertTypeMetrics 改按 subsystem | +20 |
| 9 | `web/src/view/system/list/components/ConsolePanel/index.tsx` | 错误分布展示 subsystem 友好名 + 文案"24小时"→"今日" | +15 |

### 顺手修 3 个 bug

| # | 文件 | 改什么 |
|---|------|--------|
| 10 | `src/analytics/rules/business-metric-rule.engine.ts:159` | `hourlyRate = errorCount / windowHours`（snapshot 多带 errorCountLastHour，规则用真 1h 窗口） |
| 11 | `src/analytics/rules/business-metric-rule.engine.ts:94` | `warning = Math.floor(critical * 0.7)` 替换 `/ 2` |
| 12 | `src/biz/hosting-config/types/hosting-config.types.ts:59` | `avgDurationCritical: 90000` |

### 跨模块依赖

`AlertNotifierService` 在 `notification` 模块，`ErrorLogRepository` 在 `biz/monitoring` 模块。注入路径：
- 选项 A：在 `MonitoringModule` 把 ErrorLogRepository 改成 global export
- 选项 B：抽一个 `IAlertLogPersister` 接口放 `notification/types`，`biz/monitoring` 实现并注册

推荐 **B**——保持 notification 模块对 biz 的零依赖。

---

## 风险 & 防回归

| 风险 | 缓解 |
|---|---|
| 双写过渡期（老 saveErrorLog 删除前 + 新 persistAlertLog 上线后）会重复计数 | 一个 PR 同时改两边，不分 PR 上线 |
| 节流告警写表会让 KPI 数字"偏高" | 默认 KPI 含 throttled，前端列表加 badge 区分；可选地在 KPI 卡片加 tooltip 说明 |
| 老数据 subsystem 全 NULL | 前端展示兜底为 "未知子系统"；按 subsystem 聚合时 NULL 归一类 |
| recordFailure 有"无 sendAlert 的失败路径"导致漏记 | 上线前 audit 所有 recordFailure 调用点 + 每条路径的 sendAlert 触发情况，必要时补调用 |
| ErrorLogRepository 跨 module 注入循环依赖 | 用接口抽离（方案 B） |

---

## 测试计划

### 单元测试

- `AlertNotifierService.sendAlert` 新增 4 个 case：
  - 正常发送 → 持久化 1 条 `delivered=true, throttled=false`
  - 被节流 → 持久化 1 条 `throttled=true, delivered=false`
  - 发送失败（webhook 5xx）→ 持久化 1 条 `delivered=false, throttled=false`
  - 持久化失败 → 不影响 sendAlert 返回值
- `MessageTrackingService.recordFailure` 不再调用 `errorLogRepository.saveErrorLog`（断言不调用）
- `analytics-metrics.service.ts` 的 buildAlertTypeMetrics → buildSubsystemMetrics 测试更新

### 端到端验证

1. 本地 `start:dev` 启动
2. 手动触发一次群任务 dryRun（`POST /admin/group-task/trigger {type:'part_time'}`）
3. 故意让飞书 webhook 失败（环境变量临时改错 URL）
4. 在 Supabase 看 `monitoring_error_logs` 应该有一条 `subsystem='group-task'` 的新记录
5. dashboard 刷新："今日错误" +1，"错误分布"出现 group-task

---

## 实施顺序

1. **Migration 落 test 库** → `pnpm db:push:test` → `pnpm db:status:test` 确认
2. **代码改动一次成型**：types → repository → AlertNotifierService → MessageTrackingService → dashboard query → 前端
3. **跑 lint + test**（约 20 个 spec 受影响，主要在 alert-notifier、message-tracking、analytics-metrics）
4. **本地自测**（端到端验证步骤）
5. **Migration 落 prod 库** + 部署

预计改动：**~12 个文件**，新增 1 个 migration，~250 行代码，改 ~15 处测试。**1.5-2 小时**。

---

## 待拍板的设计决定

1. **节流被丢掉的告警是否写表？**
   - 推荐：写（throttled=true）
   - 理由：高峰期节流后 KPI 反而看起来正常会误导
2. **错误分布按 subsystem 还是 code 聚合？**
   - 推荐：subsystem
   - 理由：粒度刚好，code 太细碎（每个错误码一行）；可保留按 code 钻取的二级页
3. **老的 `alert_type` 字段何时清理？**
   - 推荐：保留 1-2 周观察期再删
   - 理由：避免新字段写入有 bug 时回退困难

---

## 后续相关工作（不在本 TODO 范围）

- 告警分级展示：critical 红 / error 橙 / warning 黄
- 错误日志保留策略：当前 `cleanupErrorLogs(30)` 默认 30 天，加上 throttled 后量级可能涨 3-5 倍，考虑分级保留（throttled=true 留 7 天即可）
- 告警节流改为按 subsystem + severity 分维度，而不是单一全局
