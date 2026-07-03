# Biz 分层边界规范

更新时间：2026-07-03

本文约束 `src/biz/**` 的 Controller / Service / Repository 分层，避免业务约束、DB 访问和 HTTP 适配逻辑混在一起。

## 核心原则

1. Controller 只负责对外接口适配
   - 允许：读取 `@Param` / `@Query` / `@Body`、做轻量类型转换、组装 HTTP 响应外壳。
   - 不允许：直接访问 Repository / Supabase / Redis / Queue / LLM / 外部 API。
   - 不允许：承载业务判定、幂等语义、跨服务编排、复杂错误恢复。

2. Service 负责业务约束和用例编排
   - 对外模块应消费 Service，而不是跨模块消费 Repository。
   - 业务不变量、写入条件、幂等三态、失败兜底、DTO 到领域入参的约束，放在 Service。
   - Service 可以组合本模块 Repository、其他模块公开 Service、基础设施服务。

3. Repository 只负责 DB / 存储访问
   - 允许：表名、投影列、snake_case ↔ camelCase 映射、查询分页、upsert/insert/update/delete、RPC 调用。
   - 不允许：作为模块导出的业务消费面。
   - 不允许：承载需要被 Controller / 外部模块复用的业务规则。

4. Module 导出只导出业务能力
   - 默认导出 Service。
   - Repository 只在本模块内部 providers 中注册。
   - 若确需导出 Repository，必须在本文“允许例外”登记原因和迁移计划。

## 推荐目录

标准业务模块使用：

```text
src/biz/<module>/
  <module>.controller.ts
  <module>.module.ts
  dto/
  entities/
  repositories/
  services/
  types/
```

无 HTTP 接口的模块可省略 controller；定时任务放 `crons/`，队列 processor 放 `queue/`。

## 当前扫描结果

扫描范围：`src/biz/**`

### 已符合或已修正

- `message`
  - `GuardrailReviewService` 是 `guardrail_review_records` 的业务消费入口。
  - `MessageController` 暴露 `GET /analytics/guardrail-reviews/:traceId` 读取审查档案。
  - `AgentRunnerService` 写入时只调用 `GuardrailReviewService.recordReview()`。
  - `GuardrailReviewRepository` 只做 DB 幂等写入和行映射。

- `ops-events`
  - 目录已拆成 `crons/`、`entities/`、`providers/`、`repositories/`、`services/`、`types/`。
  - `DailyOpsReportService` 是 `daily_ops_report` 的业务读取入口。
  - `OpsEventsModule` 导出 `DailyOpsReportService`，不再跨模块导出 `DailyOpsReportRepository`。
  - `AnalyticsDashboardService` 和 `OpsDailyReportCronService` 均消费 `DailyOpsReportService`。

- 常规 CRUD / 查询类 controller
  - `candidate-blacklist`
  - `hosting-config`
  - `message`
  - `monitoring`
  - `strategy`
  - 这些 controller 未直接依赖 Repository。

- `group-task`
  - `GroupTaskController` 只对外暴露 trigger / retry / status / test-send 路由。
  - Bull Queue、LLM、群解析、通知发送编排已下沉到 `GroupTaskAdminService`。

- `test-suite`
  - SSE / Vercel AI stream 管道和 advisory guardrail 已下沉到 `TestSuiteStreamingService`。
  - 队列进度、取消、清理失败任务已下沉到 `TestSuiteQueueService`。
  - goodcase / badcase 飞书反馈回写已下沉到 `TestFeedbackService`。
  - 测试会话重置和 `MemoryService` 写入已下沉到 `TestSuiteSessionService`。

- `feishu-sync`
  - 日期参数校验、北京时间范围解析、错误折叠已下沉到 `ChatRecordSyncService.syncByDateRange()`。
  - `FeishuSyncController` 只转发手动同步和按日期同步请求。

- `strategy`
  - status 选择和合法性校验已下沉到 `StrategyConfigService.getConfigForStatus()`。
  - role setting 的 `content` 业务约束已下沉到 `StrategyConfigService.updateRoleSetting()`。

- `monitoring`
  - probe skip 写入已下沉到 `MonitoringProbeService.recordReplySkippedProbe()`。
  - `MonitoringController` 仅保留兼容路由、query 归一和 service 委托。

### 当前待迁移违规点

本次扫描未发现 `src/biz/**` controller 直接依赖 Repository / Bull Queue / LLM / Guardrail / Feishu Bitable / Memory / MessageTracking 等被禁止的业务或基础设施写入面。

### 允许例外

- `monitoring/services/cleanup/data-cleanup.service.ts`
  - 直接依赖 `SupabaseService` 用于启动可用性检查与维护任务。
  - 这是维护型 service，不是普通业务读写入口；允许保留，但新增直接 DB 操作应优先放 Repository。

- Repository 单测
  - `tests/**/repositories/*.spec.ts` 可以直接实例化 Repository，验证 DB 映射和查询形状。

## 评审清单

新增或修改 `src/biz/**` 时，至少检查：

1. Controller 是否只注入 Service / Facade。
2. Controller 是否没有直接注入 Repository、Queue、LLM、Supabase、Redis、外部 API client。
3. 跨模块依赖是否依赖对方公开 Service，而不是 Repository。
4. Module exports 是否没有导出 Repository。
5. 写入型用例是否由 Service 定义输入类型、幂等语义和失败语义。
6. Repository 是否只包含 DB 查询、映射、投影、RPC 调用。
7. 新增 DB row 类型是否放在 `entities/`，业务入参/输出类型是否放在 `types/`。

## 本次扫描命令

```bash
rg -n "from .*repositories|Repository" src/biz --glob '*controller.ts' --glob '*.controller.ts'
rg -n "getClient\\(|\\.from\\(['\\\"]|\\.rpc\\(['\\\"]|SupabaseService|BaseRepository" src/biz --glob '!**/repositories/**' --glob '!**/*.repository.ts'
rg -n "exports:\\s*\\[[^\\]]*Repository|exports:\\s*\\[[\\s\\S]{0,300}Repository" src/biz --glob '*module.ts'
```
