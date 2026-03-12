# TODO: LLM 结构化输出优化

## 问题背景

当前 `LlmEvaluationService` 通过 prompt 要求 LLM 返回 JSON 格式，然后用大量防御性代码解析：

**文件**: `src/test-suite/services/llm-evaluation.service.ts:235-317`

```typescript
// 当前实现：80+ 行防御性解析代码
private parseEvaluationResult(responseText: string, evaluationId: string) {
  // 1. 清理 markdown 代码块
  // 2. 提取 JSON 边界
  // 3. 解析 JSON
  // 4. 验证必需字段
  // 5. 验证字段类型
  // 6. 验证数值范围
  // 7. 验证 passed 与 score 一致性
  // 8. 限制 reason 长度
}
```

**问题**：
- LLM 可能用 markdown 包裹 JSON
- 可能输出多余文字
- 字段类型可能不对
- `passed` 和 `score` 可能不一致

## 优化方案：Tool-based Pattern

### 原理

将 Schema 包装成 tool，让 LLM 通过 tool call 返回结构化数据：

```typescript
// 理想方案
const EvaluationSchema = z.object({
  score: z.number().min(0).max(100),
  passed: z.boolean(),
  reason: z.string().max(200),
});

// LLM 必须通过 tool call 返回，参数强制符合 schema
tools: {
  submit_evaluation_result: tool({
    inputSchema: EvaluationSchema,
  }),
}
```

### 优势

- **类型安全**：参数必须符合 schema
- **无需解析**：不用处理 markdown 包裹、多余文字
- **兼容性好**：几乎所有模型都支持 tool calling

### 前提条件

需要确认花卷平台是否支持：
1. 自定义工具定义（不只是使用预定义工具）
2. 或者是否有类似 `structuredOutputs` 的功能

## 参考资料

- [Vercel AI SDK Issue #9002](https://github.com/vercel/ai/issues/9002) - Output.object() 兼容性问题
- Tool-based structured output 是 AI SDK 社区的常见模式

## 状态

- [ ] 确认花卷平台是否支持自定义工具定义
- [ ] 如支持，实现 tool-based 方案
- [ ] 如不支持，保持当前方案并优化 prompt

---

**创建时间**: 2026-01-21
**优先级**: 低（当前方案可用，属于优化项）
