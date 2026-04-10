# TODO: 告警链路全链路上下文富化

## 问题背景

生产环境出现 "Agent 返回空响应" 和 "Invalid prompt: messages must not be empty" 错误，排障时发现飞书告警卡片信息严重不足。根因不是数据缺失，而是错误在传播链路上逐层丢失上下文：

```
LLM Provider (HTTP 429/500) → reliable.service → runner.service → pipeline.service → alert.service → 飞书卡片
                                 ↑丢结构化元数据    ↑不富化直接抛    ↑分类错误+少传extra  ↑模板缺字段
```

目标：一次性修复全链路，让飞书卡片包含足够的排障信息。

## 涉及文件（8 个）

| # | 文件 | 改什么 | 预估行数 |
|---|------|--------|---------|
| 1 | `src/providers/reliable.service.ts` | 抛出错误时附加结构化元数据 | +15 |
| 2 | `src/agent/runner.service.ts` | catch 中富化错误上下文 | +15 |
| 3 | `src/memory/services/short-term.service.ts` | 暴露 lastLoadError 标记 | +5 |
| 4 | `src/memory/types/memory-runtime.types.ts` | MemoryRecallContext 加 `_warnings` | +3 |
| 5 | `src/memory/services/memory-lifecycle.service.ts` | 传播 shortTerm 加载失败警告 | +5 |
| 6 | `src/agent/agent-preparation.service.ts` | PreparedAgentContext 加 `memoryLoadWarning`；空消息抛出诊断信息 | +10 |
| 7 | `src/channels/wecom/message/services/pipeline.service.ts` | 修复 isAgentError 分类 + 补全 extra 字段 | +20 |
| 8 | `src/infra/feishu/services/alert.service.ts` | 两种卡片模板补字段 + extra 结构化渲染 | +30 |

**总计约 ~100 行新增/修改代码。**

---

## 具体改动

### 1. `src/providers/reliable.service.ts` — 错误附加结构化元数据

在 retry 循环前新增两个变量追踪最后一次原始错误：

```typescript
// line ~38, 在 const attempts: string[] = []; 后面
let lastRawError: unknown = null;
let lastCategory: ErrorCategory = 'retryable';
```

内层 catch 中记录：
```typescript
// line ~53, 在 const category = this.classifyError(err); 后面
lastRawError = err;
lastCategory = category;
```

替换 line 72-73 的 throw：
```typescript
const trail = attempts.join('\n  ');
const error = new Error(`所有模型均失败:\n  ${trail}`);
(error as any).isAgentError = true;
(error as any).agentMeta = {
  modelsAttempted: modelChain,
  totalAttempts: attempts.length,
  lastCategory,
};
throw error;
```

### 2. `src/agent/runner.service.ts` — 富化执行上下文

**invoke 方法**：替换空消息校验，附加诊断：
```typescript
if (ctx.typedMessages.length === 0) {
  const err = new Error(
    `messages 为空，无法调用 LLM | sessionId=${ctx.sessionId}` +
    ` | memoryWarning=${ctx.memoryLoadWarning ?? 'none'}`,
  );
  (err as any).isAgentError = true;
  (err as any).agentMeta = {
    sessionId: ctx.sessionId,
    userId: ctx.userId,
    messageCount: 0,
    memoryLoadWarning: ctx.memoryLoadWarning,
  };
  throw err;
}
```

**invoke catch 块**：在 re-throw 前富化：
```typescript
} catch (err) {
  this.logger.error('Agent 执行失败', err);
  if (err instanceof Error) {
    (err as any).isAgentError = true;
    const existing = (err as any).agentMeta ?? {};
    (err as any).agentMeta = {
      ...existing,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      messageCount: ctx.typedMessages.length,
      memoryLoadWarning: ctx.memoryLoadWarning,
    };
  }
  throw err;
}
```

**stream 方法**：同样处理空消息校验和 catch（与 invoke 对称）。

### 3. `src/memory/services/short-term.service.ts` — 暴露加载失败标记

class 新增属性：
```typescript
public lastLoadError: string | null = null;
```

getMessages 中：
- try 开头：`this.lastLoadError = null;`
- catch 中：`this.lastLoadError = msg;`（仍然 return []，不改行为）

### 4. `src/memory/types/memory-runtime.types.ts` — 加 _warnings

MemoryRecallContext 接口新增：
```typescript
/** 记忆子系统的诊断警告（非用户可见）。 */
_warnings?: string[];
```

### 5. `src/memory/services/memory-lifecycle.service.ts` — 传播警告

onTurnStart 返回值中：
```typescript
const warnings: string[] = [];
if (includeShortTerm && this.shortTerm.lastLoadError) {
  warnings.push(`shortTerm: ${this.shortTerm.lastLoadError}`);
}

return {
  ...existing fields,
  ...(warnings.length > 0 ? { _warnings: warnings } : {}),
};
```

### 6. `src/agent/agent-preparation.service.ts` — 暴露 memoryLoadWarning

PreparedAgentContext 接口新增：
```typescript
memoryLoadWarning?: string;
```

prepare 方法中，onTurnStart 后：
```typescript
const memoryLoadWarning = memory._warnings?.join('; ') || undefined;
```

返回值中带上 `memoryLoadWarning`。

### 7. `src/channels/wecom/message/services/pipeline.service.ts` — 分类修复 + 补全 extra

**7a. getAlertLevelFromError** — 增加 agentMeta 识别：
```typescript
const category = (error as any)?.agentMeta?.lastCategory;
if (category === 'rate_limited') return AlertLevel.WARNING;
```

**7b. handleProcessingError 的 sendAlert 调用** — 构建丰富的 extra：
```typescript
const agentMeta = (error as any)?.agentMeta;
const extraInfo: Record<string, unknown> = {};
if (maskedApiKey) extraInfo.apiKey = maskedApiKey;
if (options?.batchId) extraInfo.batchId = options.batchId;
if (options?.dispatchMode) extraInfo.dispatchMode = options.dispatchMode;
if (agentMeta) {
  if (agentMeta.modelsAttempted) extraInfo.modelsAttempted = agentMeta.modelsAttempted;
  if (agentMeta.lastCategory) extraInfo.errorCategory = agentMeta.lastCategory;
  if (agentMeta.totalAttempts) extraInfo.totalAttempts = agentMeta.totalAttempts;
  if (agentMeta.messageCount != null) extraInfo.messageCount = agentMeta.messageCount;
  if (agentMeta.sessionId) extraInfo.sessionId = agentMeta.sessionId;
  if (agentMeta.memoryLoadWarning) extraInfo.memoryWarning = agentMeta.memoryLoadWarning;
}
// 替换原来的 extra: maskedApiKey ? { apiKey: maskedApiKey } : undefined
extra: Object.keys(extraInfo).length > 0 ? extraInfo : undefined,
```

### 8. `src/infra/feishu/services/alert.service.ts` — 卡片模板优化

**8a. atUsers 模板（requiresImmediateAttention 分支）**：

在 `Agent 报错` 和 `时间` 之间，补充：
```typescript
if (context.conversationId) {
  fields.push(`**会话 ID**: ${context.conversationId}`);
}
```

在末尾 return 前，渲染 extra 中的关键字段：
```typescript
if (context.extra) {
  const inlineKeys: Record<string, string> = {
    errorCategory: '错误分类', modelsAttempted: '模型链',
    totalAttempts: '重试次数', memoryWarning: '记忆告警',
    dispatchMode: '调度模式', messageCount: '消息条数',
  };
  const parts: string[] = [];
  for (const [k, label] of Object.entries(inlineKeys)) {
    if (context.extra[k] != null) {
      const v = Array.isArray(context.extra[k]) ? (context.extra[k] as string[]).join('→') : String(context.extra[k]);
      parts.push(`${label}: ${v}`);
    }
  }
  if (parts.length > 0) fields.push(`📎 ${parts.join(' | ')}`);
}
```

**8b. 普通模板的 extra 渲染**：

替换原来的 JSON dump，改为结构化渲染（已知字段用中文 label，未知字段仍 JSON）：

```typescript
if (context.extra) {
  const knownKeys: Record<string, string> = {
    modelsAttempted: '模型链', errorCategory: '错误分类',
    totalAttempts: '重试次数', messageCount: '消息条数',
    batchId: '批次 ID', dispatchMode: '调度模式',
    apiKey: 'API Key', memoryWarning: '记忆告警', sessionId: '会话 ID',
  };
  const formatted: string[] = [];
  const remaining: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context.extra)) {
    if (knownKeys[key]) {
      const display = Array.isArray(value) ? value.join(' → ') : String(value);
      formatted.push(`**${knownKeys[key]}**: ${display}`);
    } else {
      remaining[key] = value;
    }
  }
  if (formatted.length > 0) fields.push('---\n' + formatted.join('\n'));
  if (Object.keys(remaining).length > 0) {
    fields.push(`**其他**:\n\`\`\`json\n${JSON.stringify(remaining, null, 2)}\n\`\`\``);
  }
}
```

---

## 改后卡片效果

### atUsers 卡片（@人的）
```
用户昵称: H-eveQ³
用户消息: 好
小蛋糕已回复: 我确认下哈，马上回你~
---
Agent 报错: messages 为空，无法调用 LLM | sessionId=69d5e4... | memoryWarning=shortTerm: Connection timeout
会话 ID: 69d5e4e69d6d3a463bf682c7
时间: 2026/4/10 14:57:03
场景: candidate-consultation
📎 错误分类: retryable | 记忆告警: shortTerm: Connection timeout | 调度模式: merged

请关注: @利威尔（李宇杭）
```

### 普通卡片
```
时间: 2026/4/10 14:56:45
级别: WARNING
类型: agent
消息: 所有模型均失败: anthropic/claude-sonnet... attempt 1/2: rate_limited; 429 Too Many Requests
会话 ID: 69d5e4e69d6d3a463bf682c7
用户消息: 明天7点半~10点半。
用户昵称: H-eveQ³
API 端点: /api/v1/chat
场景: candidate-consultation
降级消息: 我这边查一下，稍等~
---
模型链: anthropic/claude-sonnet-4-5-20250929
错误分类: rate_limited
重试次数: 2
消息条数: 8
批次 ID: abc123
调度模式: merged
```

## 验证方式

1. `pnpm run build` — 编译通过
2. `pnpm run test` — 现有测试通过
3. 手动验证：本地启动后，构造一个会导致 Agent 失败的请求（如无效 API Key），检查飞书告警卡片是否包含新增的诊断字段
