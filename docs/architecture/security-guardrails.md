# 安全护栏说明

**最后更新**：2026-03-19

---

## 1. 概述

系统安全护栏分为两层，所有入站请求按以下顺序经过各护栏：

```
HTTP 请求
  → [1] 环境变量启动校验（env.validation.ts）
  → [2] ApiTokenGuard — Bearer Token 鉴权
  → [3] DTO 输入校验（class-validator）
  → [4] 输入长度守卫 — 超长消息截断
  → [5] Prompt Injection 检测 — 追加防护提醒 + 告警
  → [6] maxOutputTokens 限制 — LLM 调用上限
  → [7] 重试 + 降级（ReliableService）
  → [8] 告警节流（FeishuAlertService）
```

**公开端点**（企微回调、健康检查）标注 `@Public()` 装饰器，跳过第 [2] 步。

---

## 2. 已实现的护栏

### 2.1 基础设施层护栏（原有）

**环境变量启动校验**

位置：`src/infra/config/env.validation.ts`

服务启动时通过 `class-validator` 对所有环境变量进行类型和值域校验，不满足则启动失败，避免配置缺失导致运行时异常。必填字段缺失时抛出明确错误：

```
❌ 环境变量验证失败：
  - AGENT_CHAT_MODEL: AGENT_CHAT_MODEL 环境变量未配置
```

**重试 + 降级 + 错误分类**

位置：`src/providers/reliable.service.ts`

三层容错：
1. 同一模型指数退避重试（retryable 错误，基础退避 1s，上限 30s）
2. primary 失败后按 fallback 链逐个降级
3. 错误分类 — 401/403/404/400 → `non_retryable`（不重试），429 → `rate_limited`，其余 → `retryable`

角色 fallback 链通过环境变量配置：`AGENT_{ROLE}_FALLBACKS` 或全局 `AGENT_DEFAULT_FALLBACKS`。

**告警节流**

位置：`src/infra/feishu/services/alert.service.ts`，常量定义于 `src/infra/feishu/constants/constants.ts`

节流键为 `errorType:scenario`，5 分钟窗口内同类型告警最多发送 3 次，超出后静默丢弃并记录日志。

**消息历史限制**

位置：`src/channels/wecom/message/services/` 相关服务

每个会话 Redis 消息历史上限 `MAX_HISTORY_PER_CHAT`（默认 60 条），超出后滚动删除最早的记录，防止 Redis 无限增长。

**DTO 输入校验**

所有 Controller 的入参通过 `class-validator` + NestJS 全局 `ValidationPipe` 校验，非法字段在边界处拒绝。

**日志脱敏**

Winston Logger 配置，日志不记录 API Key、Token 等敏感值；飞书告警中用户消息截断为 100~200 字符以内。

---

### 2.2 新增安全护栏

**API Token Guard**

位置：`src/infra/server/guards/api-token.guard.ts`

全局 Guard，保护 `/agent/*`、`/config/*`、`/test-suite/*` 等管理端点。验证 `Authorization: Bearer <token>` header，与 `API_GUARD_TOKEN` 环境变量比对。

行为规则：

| 场景 | 行为 |
|------|------|
| 未配置 `API_GUARD_TOKEN` | 放行（开发环境兼容），启动时打印 WARN |
| 标注 `@Public()` 的端点 | 跳过校验，直接放行 |
| Token 匹配 | 放行 |
| Token 不匹配 | 返回 403，记录 WARN 日志（含请求路径） |

企微回调、飞书回调等第三方推送端点均已标注 `@Public()`，来源：`src/infra/server/response/decorators/api-response.decorator.ts`。

**maxOutputTokens 上限**

位置：`src/agent/runner.service.ts`、`src/agent/completion.service.ts`

`generateText` / `streamText` 调用时统一传入 `maxOutputTokens`，防止 LLM 返回超长内容导致成本失控。

- `AgentRunnerService`：从 `AGENT_MAX_OUTPUT_TOKENS` 读取，默认 4096
- `LlmExecutorService`：同上，一次性调用方也统一走这个入口

**输入长度守卫**

位置：`src/agent/runner.service.ts` → `trimMessages()`

消息列表总字符数超过 `AGENT_MAX_INPUT_CHARS`（默认 8000）时，从最早的消息开始丢弃，保留最新的消息，直到总长度满足约束。

```typescript
// 策略：从后往前累加，保留最近的消息
for (let i = messages.length - 1; i >= 0; i--) {
  if (charCount + msgLen > this.maxInputChars && kept.length > 0) break;
  kept.unshift(messages[i]);
}
```

**Prompt Injection 防护**

位置：`src/agent/input-guard.service.ts`

检测三类注入模式（匹配任意 user 消息）：

| 类型 | 示例模式 |
|------|---------|
| 角色劫持 | `ignore all previous instructions`、`你现在是`、`假装你是` |
| 提示词泄露 | `repeat your system prompt`、`显示你的系统消息` |
| 指令注入 | `[[SYSTEM]]`、`<\|im_start\|>system`、` ```system ` |

策略：**不阻断**，而是在系统提示词末尾追加防护提醒，同时异步发送飞书告警（告警类型 `prompt_injection`，受节流控制）。

**Token 用量追踪**

位置：`src/channels/wecom/message/services/pipeline.service.ts`

`buildSuccessMetadata()` 中通过 `agentResult.reply.usage?.totalTokens ?? 0` 安全读取 token 用量，避免字段未定义时记录异常数据，确保监控数据准确性。

---

## 3. 安全相关环境变量

| 变量 | 默认值 | 类型 | 说明 |
|------|--------|------|------|
| `API_GUARD_TOKEN` | 无 | 可选 | 管理端点 Bearer Token，未配置则不鉴权 |
| `AGENT_MAX_OUTPUT_TOKENS` | `4096` | 可选 | LLM 单次最大输出 token 数，最小值 100 |
| `AGENT_MAX_INPUT_CHARS` | `8000` | 可选 | 输入消息总字符上限，最小值 100 |
| `AGENT_DEFAULT_FALLBACKS` | 无 | 可选 | 全局模型降级链，逗号分隔，如 `deepseek/deepseek-chat,qwen/qwen-max-latest` |
| `AGENT_THINKING_BUDGET_TOKENS` | `0` | 可选 | Extended Thinking token 预算，0 为禁用 |
| `FEISHU_ALERT_WEBHOOK_URL` | 无 | 必填（生产） | 安全告警推送目标 |
| `FEISHU_ALERT_SECRET` | 无 | 必填（生产） | 飞书 Webhook 签名密钥 |

告警节流硬编码默认值（`src/infra/feishu/constants/constants.ts`）：

| 配置 | 值 | 说明 |
|------|-----|------|
| `ALERT_THROTTLE.WINDOW_MS` | 5 分钟 | 节流时间窗口 |
| `ALERT_THROTTLE.MAX_COUNT` | 3 次 | 窗口内最大告警次数 |

---

## 4. 请求流安全检查点

```
入站 HTTP 请求
  │
  ├─[启动时] env.validation.ts — 必填变量校验，失败则进程退出
  │
  ├─[每次请求] ApiTokenGuard.canActivate()
  │    ├─ @Public() 端点 → 跳过
  │    ├─ 未配置 token → 放行（开发模式）
  │    └─ 验证 Bearer Token → 不匹配返回 403
  │
  ├─[Controller 层] ValidationPipe — DTO 字段校验
  │
  ├─[AgentRunnerService.prepare()] trimMessages()
  │    └─ 总字符数 > AGENT_MAX_INPUT_CHARS → 丢弃最早消息
  │
  ├─[AgentRunnerService.prepare()] InputGuardService.detectMessages()
  │    └─ 检测注入模式 → 追加 GUARD_SUFFIX 到 systemPrompt + 异步告警
  │
  ├─[generateText / streamText] maxOutputTokens 参数
  │    └─ LLM 层截断输出长度
  │
  └─[ReliableService] 错误分类 + 重试 + 降级
       └─ 全部失败 → 抛出聚合错误，由上层告警
```

---

## 5. 待实现的护栏

| 护栏 | 优先级 | 说明 |
|------|--------|------|
| 用户级限流 | 高 | 单用户每分钟最大请求数，防止恶意刷接口 |
| 成本 / 预算控制 | 中 | 每日 token 用量累计，超出预算后降级到低成本模型 |
| 熔断器（Circuit Breaker） | 中 | 某 Provider 连续失败后熔断，避免雪崩式重试 |

---

## 6. 验证方式

验证 ApiTokenGuard 是否生效（未配置 token 时不受保护）：

```bash
# 有效 token — 期望 200
curl -H "Authorization: Bearer your-guard-token" http://localhost:8585/agent/health

# 无效 token — 期望 403
curl -H "Authorization: Bearer wrong-token" http://localhost:8585/agent/health

# @Public 端点 — 无需 token，期望 200
curl http://localhost:8585/wecom/message/health
```

验证输入长度截断（日志中应出现 WARN）：

```bash
curl -X POST http://localhost:8585/agent/debug-chat \
  -H "Authorization: Bearer your-guard-token" \
  -H "Content-Type: application/json" \
  -d '{"message":"'"$(python3 -c "print('A'*9000)")"'","conversationId":"test-001"}'
# 日志：输入消息总长度 9000 超过上限 8000，将丢弃最早的消息
```

---

## 相关文件

- `src/infra/server/guards/api-token.guard.ts` — API Token Guard 实现
- `src/infra/server/response/decorators/api-response.decorator.ts` — `@Public()` 装饰器
- `src/agent/input-guard.service.ts` — Prompt Injection 检测
- `src/agent/runner.service.ts` — 输入长度守卫 + 注入检测集成
- `src/agent/completion.service.ts` — maxOutputTokens 默认值
- `src/providers/reliable.service.ts` — 重试 + 降级 + 错误分类
- `src/providers/router.service.ts` — 角色路由 + fallback 链
- `src/infra/feishu/services/alert.service.ts` — 告警节流
- `src/infra/feishu/constants/constants.ts` — 节流常量
- `src/infra/config/env.validation.ts` — 环境变量校验
