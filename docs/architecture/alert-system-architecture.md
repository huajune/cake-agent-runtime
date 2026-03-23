# 告警系统架构设计

> Cake Agent Runtime - 告警与通知系统

**最后更新**：2025-11-25

---

## 目录

1. [架构概览](#架构概览)
2. [告警类型](#告警类型)
3. [服务组件](#服务组件)
4. [数据流详解](#数据流详解)
5. [配置指南](#配置指南)
6. [告警展示](#告警展示)
7. [API 接口](#api-接口)
8. [故障排查](#故障排查)

---

## 架构概览

告警系统采用 **编排器模式（Orchestrator Pattern）**，由 `AlertOrchestratorService` 统一协调各个子服务完成告警流程。

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           业务层（触发源）                                        │
│     MessageService  │  AgentService  │  MonitoringAlertService（定时任务）       │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    AlertOrchestratorService（编排中枢）                           │
│  ┌───────────────────────────────────────────────────────────────────────────┐ │
│  │  1. 检查全局开关      (AlertConfigService)                                 │ │
│  │  2. 判断严重程度      (AlertSeverityService)                               │ │
│  │  3. 检查是否静默      (AlertSilenceService)                                │ │
│  │  4. 记录故障状态      (AlertRecoveryService)                               │ │
│  │  5. 检查限流聚合      (AlertThrottleService)                               │ │
│  │  6. 发送到通知渠道    (FeiShuAlertService)                                 │ │
│  └───────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                    ┌───────────────────┴───────────────────┐
                    ▼                                       ▼
┌───────────────────────────────────┐    ┌───────────────────────────────────────┐
│       配置层                       │    │       通知渠道                         │
│  AlertConfigService               │    │  FeiShuAlertService                   │
│  ├── config/alert-rules.json     │    │  └── 飞书 Webhook                      │
│  └── 环境变量 (.env)              │    │                                       │
│  支持热加载，无需重启              │    │  (可扩展: 邮件、短信、钉钉...)         │
└───────────────────────────────────┘    └───────────────────────────────────────┘
```

### 核心特性

| 特性 | 说明 |
|-----|------|
| **多层次告警** | 错误告警 + 业务指标主动告警 |
| **智能限流** | 自动聚合重复告警，防止告警风暴 |
| **严重程度分级** | CRITICAL / ERROR / WARNING / INFO |
| **恢复检测** | 自动发送故障恢复通知 |
| **静默管理** | 支持临时屏蔽告警（计划维护） |
| **配置热加载** | 修改配置文件即时生效，无需重启 |

---

## 告警类型

### 1. 错误告警（实时触发）

当业务代码发生错误时立即触发：

| 类型 | 触发场景 | 默认严重程度 |
|-----|---------|-------------|
| `agent` | Agent API 调用失败（401/403/429/5xx） | CRITICAL / ERROR / WARNING |
| `message` | 消息处理失败（非 Agent 错误） | WARNING |
| `delivery` | 消息发送失败 | WARNING |
| `merge` | 消息聚合处理失败 | WARNING |

**触发代码示例**：
```typescript
// MessageService 中的错误告警
await this.alertOrchestrator.sendAlert({
  errorType: 'agent',
  error: new Error('Agent API timeout'),
  conversationId: 'conv-123',
  userMessage: '用户问题内容',
  contactName: '张三',
  scenario: 'candidate_consulting',
  apiEndpoint: '/api/v1/chat',
  statusCode: 500,
});
```

### 2. 业务指标告警（定时检查）

由 `MonitoringAlertService` 每分钟自动检查，异常时主动告警：

| 指标 | WARNING 阈值 | CRITICAL 阈值 | 说明 |
|-----|-------------|--------------|------|
| **成功率** | < 90% | < 80% | 消息处理成功率 |
| **平均响应时间** | > 5000ms | > 10000ms | 从接收到回复的总耗时 |
| **队列积压** | > 50 条 | > 100 条 | 当前处理中的消息数 |
| **错误率** | > 10/分钟 | > 20/分钟 | 24小时平均每分钟错误数 |

**定时任务实现**：
```typescript
@Cron(CronExpression.EVERY_MINUTE)
async checkBusinessMetrics(): Promise<void> {
  const dashboard = this.monitoringService.getDashboardData();

  await this.checkSuccessRate(dashboard.overview.successRate, config.successRate);
  await this.checkAvgDuration(dashboard.overview.avgDuration, config.avgDuration);
  await this.checkQueueDepth(dashboard.queue.currentProcessing, config.queueDepth);
  await this.checkErrorRate(dashboard.alertsSummary.last24Hours, config.errorRate);
}
```

---

## 服务组件

### 服务列表

| 服务 | 文件位置 | 职责 |
|-----|---------|------|
| **AlertOrchestratorService** | `services/alert-orchestrator.service.ts` | 告警编排中枢，协调所有子服务 |
| **AlertConfigService** | `services/alert-config.service.ts` | 配置管理，支持文件热加载 |
| **AlertSeverityService** | `services/alert-severity.service.ts` | 严重程度判断（错误码 → 级别） |
| **AlertThrottleService** | `services/alert-throttle.service.ts` | 限流聚合，防止告警风暴 |
| **AlertRecoveryService** | `services/alert-recovery.service.ts` | 恢复检测，追踪故障状态 |
| **AlertSilenceService** | `services/alert-silence.service.ts` | 静默管理，临时屏蔽告警 |
| **FeiShuAlertService** | `feishu-alert.service.ts` | 飞书渠道发送 |
| **MonitoringAlertService** | `monitoring/monitoring-alert.service.ts` | 业务指标主动告警（定时任务） |

### AlertOrchestratorService（编排器）

**核心方法**：

```typescript
// 发送错误告警
async sendAlert(context: AlertContext): Promise<AlertResult>

// 发送恢复通知
async sendRecoveryNotification(recoveryKey: string): Promise<void>

// 发送业务指标告警
async sendMetricAlert(context: MetricAlertContext): Promise<void>
```

**处理流程**：

```
sendAlert(context)
    │
    ├── 1. 检查全局开关 (configService.isEnabled())
    │       └── 禁用 → 返回 { sent: false, reason: 'globally-disabled' }
    │
    ├── 2. 判断严重程度 (severityService.determineSeverity())
    │       └── 根据 errorType + statusCode 确定级别
    │
    ├── 3. 检查是否静默 (silenceService.isSilenced())
    │       └── 静默中 → 返回 { sent: false, reason: 'silenced-Xs-remaining' }
    │
    ├── 4. 记录故障状态 (recoveryService.recordFailure())
    │       └── 用于后续恢复检测
    │
    ├── 5. 检查限流 (throttleService.shouldSendAlert())
    │       └── 限流中 → 返回 { sent: false, reason: 'throttled' }
    │
    └── 6. 发送到通知渠道 (sendToChannels())
            └── 飞书 → feiShuAlertService.sendAgentApiFailureAlert()
```

### AlertThrottleService（限流服务）

**解决问题**：Agent API 持续故障导致每秒产生 10+ 条告警，飞书群被刷屏。

**限流策略**：
- 同类型告警在窗口期内（默认 5 分钟）只发送 **1 次**
- 后续告警自动计数聚合
- 窗口期结束后发送 **聚合告警**（包含总次数、错误分布）

**效果对比**：
```
Before: 300 条独立告警（5 分钟内）❌
After:  1 条聚合告警 ✅
内容: "5分钟内发生 300 次，错误分布：超时(189次)、限流(111次)"
```

### AlertRecoveryService（恢复检测）

**原理**：
1. 记录每个告警键的首次故障时间
2. 追踪连续成功次数
3. 达到阈值（默认 5 次）后认为恢复
4. 自动发送恢复通知

**使用示例**：
```typescript
// 业务代码中记录成功
const recovered = this.alertRecovery.recordSuccess({
  errorType: 'agent',
  scenario: 'candidate_consulting',
});

if (recovered) {
  // 发送恢复通知
  await this.alertOrchestrator.sendRecoveryNotification('agent:candidate_consulting');
}
```

### AlertSilenceService（静默管理）

**使用场景**：
- Agent API 计划内维护（已知停机）
- 非紧急问题修复中（避免重复打扰）
- 测试环境临时关闭告警

---

## 数据流详解

### 错误告警流程

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 错误发生                                                                         │
│                                                                                 │
│   MessageService.handleMessage()                                                │
│       │                                                                         │
│       └── try-catch 捕获异常                                                     │
│           │                                                                     │
│           ▼                                                                     │
│   alertOrchestrator.sendAlert({                                                 │
│     errorType: 'agent',                                                         │
│     error: error,                                                               │
│     conversationId: 'xxx',                                                      │
│     ...                                                                         │
│   })                                                                            │
│       │                                                                         │
│       ▼                                                                         │
│   [编排器处理流程]                                                               │
│       │                                                                         │
│       ├── 全局开关？ ─── 禁用 ───► 跳过                                          │
│       │                                                                         │
│       ├── 被静默？ ──── 是 ─────► 跳过                                          │
│       │                                                                         │
│       ├── 被限流？ ──── 是 ─────► 计数聚合，跳过发送                              │
│       │                                                                         │
│       └── 发送告警                                                               │
│           │                                                                     │
│           ▼                                                                     │
│   FeiShuAlertService.sendAgentApiFailureAlert()                                 │
│       │                                                                         │
│       ▼                                                                         │
│   飞书群收到告警卡片                                                              │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 业务指标告警流程

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 定时触发（每分钟）                                                                │
│                                                                                 │
│   @Cron(EVERY_MINUTE)                                                           │
│   MonitoringAlertService.checkBusinessMetrics()                                 │
│       │                                                                         │
│       ├── 获取仪表盘数据                                                         │
│       │   monitoringService.getDashboardData()                                  │
│       │                                                                         │
│       ├── 检查成功率                                                             │
│       │   currentValue: 67% < critical: 80%                                     │
│       │       │                                                                 │
│       │       ├── 检查最小告警间隔（5分钟）                                       │
│       │       │                                                                 │
│       │       └── alertOrchestrator.sendMetricAlert({                           │
│       │             metricName: '成功率严重下降',                                 │
│       │             currentValue: 67,                                           │
│       │             threshold: 80,                                              │
│       │             severity: CRITICAL                                          │
│       │           })                                                            │
│       │                                                                         │
│       ├── 检查响应时间                                                           │
│       ├── 检查队列积压                                                           │
│       └── 检查错误率                                                             │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 恢复检测流程

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 恢复检测                                                                         │
│                                                                                 │
│   [故障期间]                                                                     │
│       │                                                                         │
│       ├── recordFailure() × N 次                                                │
│       │   └── 记录: startTime, failureCount++                                   │
│       │                                                                         │
│   [开始恢复]                                                                     │
│       │                                                                         │
│       ├── recordSuccess() × 1                                                   │
│       │   └── consecutiveSuccess = 1                                            │
│       │                                                                         │
│       ├── recordSuccess() × 2                                                   │
│       │   └── consecutiveSuccess = 2                                            │
│       │                                                                         │
│       ├── ... (继续成功)                                                         │
│       │                                                                         │
│       └── recordSuccess() × 5 (达到阈值)                                         │
│           │                                                                     │
│           ├── isRecovered = true                                                │
│           │                                                                     │
│           └── 返回 true → 触发恢复通知                                           │
│               │                                                                 │
│               ▼                                                                 │
│   alertOrchestrator.sendRecoveryNotification('agent:scenario')                  │
│       │                                                                         │
│       ▼                                                                         │
│   飞书群收到恢复通知:                                                            │
│   "✅ 告警已恢复 [agent:scenario]                                               │
│    故障时长: 33 分钟                                                             │
│    故障期间失败次数: 127"                                                        │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 配置指南

### 环境变量配置

```bash
# .env

# ========== 必须配置 ==========
# 飞书告警 Webhook（必须）
ENABLE_FEISHU_ALERT=true
FEISHU_ALERT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx
FEISHU_ALERT_SECRET=your-secret-key

# ========== 可选配置 ==========
# 告警系统总开关（默认 true）
ALERT_ENABLED=true

# 业务指标告警开关（默认 true）
ALERT_METRICS_ENABLED=true

# 限流窗口（默认 5 分钟）
ALERT_THROTTLE_WINDOW_MS=300000

# 业务指标阈值（可选，覆盖 JSON 配置）
ALERT_SUCCESS_RATE_WARNING=90
ALERT_SUCCESS_RATE_CRITICAL=80
ALERT_AVG_DURATION_WARNING=5000
ALERT_AVG_DURATION_CRITICAL=10000
```

### 规则配置文件

**文件位置**：`config/alert-rules.json`

```json
{
  "enabled": true,
  "rules": [
    {
      "name": "agent-auth-failure",
      "enabled": true,
      "match": {
        "errorType": "agent",
        "errorCode": "401|403"
      },
      "severity": "critical",
      "throttle": {
        "enabled": true,
        "windowMs": 300000,
        "maxOccurrences": 3
      }
    },
    {
      "name": "agent-rate-limit",
      "enabled": true,
      "match": {
        "errorType": "agent",
        "errorCode": "429"
      },
      "severity": "warning",
      "throttle": {
        "enabled": true,
        "windowMs": 600000,
        "maxOccurrences": 5
      }
    }
  ],
  "metrics": {
    "successRate": {
      "warning": 90,
      "critical": 80
    },
    "avgDuration": {
      "warning": 5000,
      "critical": 10000
    },
    "queueDepth": {
      "warning": 50,
      "critical": 100
    },
    "errorRate": {
      "warning": 10,
      "critical": 20
    }
  },
  "defaultThrottle": {
    "windowMs": 300000,
    "maxOccurrences": 1
  }
}
```

**配置热加载**：修改文件后自动生效，无需重启服务！

---

## 告警展示

### 严重程度说明

| 级别 | 图标 | 颜色 | 使用场景 |
|-----|------|------|---------|
| **CRITICAL** | `🔴` | 紫色 | 认证失败、服务不可用、成功率<80% |
| **ERROR** | `🚨` | 红色 | 5xx 错误、Agent 调用失败、响应超时 |
| **WARNING** | `⚠️` | 橙色 | 限流、成功率<90%、队列积压 |
| **INFO** | `ℹ️` | 蓝色 | 恢复通知、信息提示 |

### 告警卡片示例

#### 普通告警

```
🚨 Agent 调用失败告警

告警时间: 2025-11-25 14:32:15
环境: production
会话ID: conv-123-456
错误类型: Agent Invocation Error
严重程度: ERROR
用户昵称: 张三
场景: candidate_consulting

─────────────────────────
错误信息: Request timeout after 60000ms
HTTP 状态码: N/A
API 端点: /api/v1/chat

─────────────────────────
用户消息: 请问有哪些UI设计师的职位？

[查看监控大盘] [查看日志]
```

#### 聚合告警（限流后）

```
🚨 Agent 调用失败告警（聚合）

⚠️ 5分钟内发生 127 次

时间窗口: 10:00:01 - 10:04:58
影响会话: 45 个
严重程度: ERROR

─────────────────────────
聚合的错误信息:
1. Request timeout after 60000ms (89次)
2. Agent API返回 429 Rate Limit (38次)

─────────────────────────
建议操作:
1. 检查 Agent API 服务状态
2. 查看错误日志分布
3. 考虑增加请求配额

[查看监控大盘] [查看日志]
```

#### 恢复通知

```
✅ 告警已恢复 [agent:candidate_consulting]

恢复时间: 2025-11-25 15:05:30
故障时长: 33 分钟 (1980 秒)
故障期间失败次数: 127
恢复判定: 连续成功 5 次

系统已恢复正常运行 ✨
```

#### 业务指标告警

```
🔴 业务指标告警: 成功率严重下降

指标名称: 成功率严重下降
当前值: 67%
阈值: 80%
严重程度: CRITICAL
时间窗口: 当前

─────────────────────────
附加信息:
message: 成功率已降至临界值以下，大量用户受影响
suggestion: 立即检查 Agent API 状态、数据库连接、网络状况

[查看监控大盘] [检查 Agent 健康]
```

---

## API 接口

### AlertController 端点

| 方法 | 路径 | 用途 |
|-----|------|------|
| POST | `/alert/silence` | 添加静默规则 |
| GET | `/alert/silence` | 查询所有静默规则 |
| DELETE | `/alert/silence/:key` | 删除静默规则 |
| POST | `/alert/test/metrics` | 测试业务指标告警 |
| POST | `/alert/test/error` | 测试错误告警 |

### 静默管理 API

```bash
# 添加静默规则 - 静默 agent 类型告警 1 小时
curl -X POST http://localhost:8080/alert/silence \
  -H "Content-Type: application/json" \
  -d '{
    "errorType": "agent",
    "durationMs": 3600000,
    "reason": "Agent API 计划内维护"
  }'

# 添加静默规则 - 静默特定场景的告警
curl -X POST http://localhost:8080/alert/silence \
  -H "Content-Type: application/json" \
  -d '{
    "errorType": "agent",
    "scenario": "candidate_consulting",
    "durationMs": 3600000,
    "reason": "候选人咨询场景维护中"
  }'

# 查询所有静默规则（包括剩余时间）
curl http://localhost:8080/alert/silence

# 删除静默规则
curl -X DELETE http://localhost:8080/alert/silence/agent
curl -X DELETE http://localhost:8080/alert/silence/agent:candidate_consulting
```

### 测试告警 API

```bash
# 测试业务指标告警
curl -X POST http://localhost:8080/alert/test/metrics

# 测试错误告警
curl -X POST http://localhost:8080/alert/test/error \
  -H "Content-Type: application/json" \
  -d '{
    "errorType": "agent",
    "message": "测试告警消息"
  }'
```

---

## 故障排查

### 告警没有发送？

**排查步骤**：

1. **检查全局开关**
   ```bash
   echo $ALERT_ENABLED        # 应为 true
   echo $ENABLE_FEISHU_ALERT  # 应为 true
   ```

2. **检查配置文件**
   ```bash
   cat config/alert-rules.json | jq '.enabled'  # 应为 true
   ```

3. **检查是否被静默**
   ```bash
   curl http://localhost:8080/alert/silence
   ```

4. **查看日志**
   ```bash
   tail -f logs/combined-$(date +%Y-%m-%d).log | grep -E "(Alert|告警)"
   ```

5. **检查飞书 Webhook**
   ```bash
   # 测试 Webhook 是否可用
   curl -X POST "$FEISHU_ALERT_WEBHOOK_URL" \
     -H "Content-Type: application/json" \
     -d '{"msg_type":"text","content":{"text":"测试消息"}}'
   ```

### 告警太频繁？

**解决方案**：

1. **调整限流窗口**
   ```bash
   # .env
   ALERT_THROTTLE_WINDOW_MS=600000  # 改为 10 分钟
   ```

2. **修改规则配置**
   ```json
   // config/alert-rules.json
   {
     "rules": [{
       "name": "agent-timeout",
       "throttle": {
         "windowMs": 600000,
         "maxOccurrences": 5
       }
     }]
   }
   ```

3. **临时静默**
   ```bash
   curl -X POST http://localhost:8080/alert/silence \
     -d '{"errorType":"agent","durationMs":3600000,"reason":"临时静默"}'
   ```

### 业务指标告警不触发？

**排查步骤**：

1. **检查指标告警开关**
   ```bash
   echo $ALERT_METRICS_ENABLED  # 应为 true
   ```

2. **检查阈值配置**
   ```bash
   cat config/alert-rules.json | jq '.metrics'
   ```

3. **检查当前指标值**
   ```bash
   curl http://localhost:8080/monitoring/dashboard | jq '.overview'
   ```

4. **检查最小告警间隔**
   - 同一指标告警最小间隔为 5 分钟
   - 查看日志确认是否因间隔被跳过

---

## 相关文档

- [监控系统架构](./monitoring-system-architecture.md)
- [Redis 与 Supabase 资源使用指南](../infrastructure/redis-supabase-usage.md)
- [消息服务架构](./message-service-architecture.md)

---

**维护者**：DuLiDay Team
