# Test-Suite 模块架构重构计划

> 创建时间: 2025-01-15
> 状态: 规划中

## 背景

当前 `src/test-suite/` 模块承载了过多职责：
- 场景测试执行
- 对话验证测试
- 批次生命周期管理
- 评审系统
- Bull Queue 任务队列
- 飞书数据同步
- 用户反馈收集

导致的问题：
- Controller 1156 行，难以维护
- 存在循环依赖（2 处 forwardRef）
- 代码重复（extractResponseText 等方法）
- 改动影响范围大

## 目标架构

```
src/
├── core/                           # 基础设施层 (保持不变)
├── shared/                         # 共享层 (保持不变)
├── agent/                          # AI Agent 域 (保持不变)
├── wecom/                          # 企微域 (保持不变)
│
└── testing/                        # 测试平台域 (重构目标)
    ├── testing.module.ts           # 主模块
    │
    ├── execution/                  # 测试执行子域
    │   ├── execution.controller.ts
    │   ├── execution.service.ts
    │   ├── execution.repository.ts
    │   └── dto/
    │
    ├── batch/                      # 批次管理子域
    │   ├── batch.controller.ts
    │   ├── batch.service.ts
    │   ├── batch.repository.ts
    │   ├── batch.processor.ts
    │   └── dto/
    │
    ├── conversation/               # 对话验证子域
    │   ├── conversation.controller.ts
    │   ├── conversation.service.ts
    │   ├── conversation-source.repository.ts
    │   ├── similarity.service.ts
    │   └── dto/
    │
    ├── review/                     # 评审子域
    │   ├── review.controller.ts
    │   ├── review.service.ts
    │   └── dto/
    │
    └── shared/                     # 测试平台内共享
        ├── enums/
        ├── types/
        └── utils/
            └── agent-response-parser.ts
```

## 迁移阶段

### Phase 1: 准备工作
- [ ] 创建 `src/testing/` 目录结构
- [ ] 创建 `testing/shared/utils/agent-response-parser.ts` 提取重复代码
- [ ] 配置 tsconfig.json 路径别名 `@testing`

### Phase 2: 迁移 conversation 子域 (最独立)
- [ ] 创建 `testing/conversation/` 目录
- [ ] 迁移 `ConversationTestService`
- [ ] 迁移 `ConversationSourceRepository`
- [ ] 迁移 `SemanticSimilarityService`
- [ ] 创建 `ConversationController`
- [ ] 更新路由前缀
- [ ] 测试验证

### Phase 3: 迁移 batch 子域
- [ ] 创建 `testing/batch/` 目录
- [ ] 迁移 `TestBatchService`
- [ ] 迁移 `TestBatchRepository`
- [ ] 迁移 `TestSuiteProcessor`
- [ ] 创建 `BatchController`
- [ ] 使用事件驱动替代 forwardRef

### Phase 4: 迁移 execution 子域
- [ ] 创建 `testing/execution/` 目录
- [ ] 迁移 `TestExecutionService`
- [ ] 迁移 `TestExecutionRepository`
- [ ] 创建 `ExecutionController`

### Phase 5: 迁移 review 子域
- [ ] 创建 `testing/review/` 目录
- [ ] 从 batch 服务中提取评审逻辑
- [ ] 创建 `ReviewController`

### Phase 6: 清理
- [ ] 删除旧 `src/test-suite/` 目录
- [ ] 更新所有导入路径
- [ ] 更新 CLAUDE.md 文档
- [ ] 运行完整测试

## 模块间通信

### 事件驱动 (替代循环依赖)

```typescript
// 定义事件
export class BatchCompletedEvent {
  constructor(public readonly batchId: string) {}
}

// 发布事件 (BatchProcessor)
this.eventEmitter.emit('batch.completed', new BatchCompletedEvent(batchId));

// 订阅事件 (StatsService)
@OnEvent('batch.completed')
async handleBatchCompleted(event: BatchCompletedEvent) {
  await this.updateBatchStats(event.batchId);
}
```

### 模块导出

```typescript
// testing.module.ts
@Module({
  imports: [
    ExecutionModule,
    BatchModule,
    ConversationModule,
    ReviewModule,
  ],
  exports: [
    ExecutionModule,
    BatchModule,
  ],
})
export class TestingModule {}
```

## API 路由映射

| 旧路由 | 新路由 | 子域 |
|-------|--------|------|
| `POST /test-suite/chat` | `POST /testing/executions/run` | execution |
| `POST /test-suite/chat/stream` | `POST /testing/executions/stream` | execution |
| `GET /test-suite/batches` | `GET /testing/batches` | batch |
| `POST /test-suite/batches/quick-create` | `POST /testing/batches/quick-create` | batch |
| `GET /test-suite/conversations` | `GET /testing/conversations` | conversation |
| `PATCH /test-suite/executions/:id/review` | `PATCH /testing/reviews/:id` | review |

## 风险控制

1. **保持向后兼容**: 旧路由保留 1-2 个版本，标记为 deprecated
2. **渐进式迁移**: 每个 Phase 独立提交，可随时回滚
3. **测试覆盖**: 每个阶段完成后运行完整测试
4. **文档同步**: 及时更新 API 文档

## 预期收益

| 指标 | 当前 | 目标 |
|-----|------|------|
| 最大 Controller 行数 | 1156 | <300 |
| 循环依赖数 | 2 | 0 |
| 代码重复 | 3 处 | 0 |
| 单元测试难度 | 高 | 低 |
