# 观测链路优化 · 执行清单（P1 采集补洞）

> 背景：Web 后台消息处理页看不全 agent 回合的过程信息。审计结论：大量数据**库里有但前端不渲染**，另有若干采集空洞。
> **P0（展示侧七项）已全部执行完毕（2026-08-24/25）**：P0-1 执行事件时间线 `e1c5d0d8`、P0-2 工具面板换数据源 `2b5bdf06`、P0-3 守卫语义判例渲染 `c04a1eeb`、P0-4 右栏关键字段 `72ad418d`、P0-5 会话↔流水互跳 `99f7d5fe`、P0-6 实时刷新修复+死代码清理 `07c60265`、P0-7 断流事件按方案 B 下线消费端 `03494c19`。原 P0 清单见 git 历史。
> 本文档剩余范围 = **P1 采集补洞**；P2（保留策略/落库可靠性/迁移类）仍不做。

---

## 0. 仓库约定（开工前必读）

1. **环境**：Node 20+（实践用 `nvm use 22.16.0`），包管理 pnpm。本地起服务需要 Redis 相关环境变量（见 CLAUDE.md），跑测试不需要。
2. **分支**：Conventional Commits（`feat:` / `fix:` / `refactor:`）。
3. **并发保护**：仓库常有多个 AI 会话并发改码——**不要 `git add -A`、不要 `git stash`，commit 一律用 pathspec 限定自己改的文件**；工作树发现他人改动勿动。
4. **质量检查**：提交前自跑 `pnpm run lint:check && pnpm run typecheck && pnpm run test`。
5. **Jest 坑**：单测这样跑：`pnpm run test tests/path/to.spec.ts --watchman=false`（**不带 `--` 分隔符**；不加 `--watchman=false` 会静默 0 测试）。`tests/` 目录镜像 `src/` 结构，新增后端方法补最小单测。
6. **代码规范**：TS 严格模式，禁 `any`（用 `unknown` + 收窄）、禁 `console.log`（用 NestJS `Logger`）、禁手动 `new Service()`（走 DI）。文件 kebab-case。

## 0.1 关键事实（已实测验证，直接采信）

- **跨表 join 键**：`agent_execution_events.trace_id` = `message_processing_records.message_id` = `guardrail_review_records.trace_id`。mpr 表**没有** trace_id 列。
- `agent_execution_events` 事件类型定义在 `src/observability/observer.interface.ts`，落库白名单在 `src/observability/persisting-observer.ts`，保留 60 天。
- mpr 的 `tool_calls` / `agent_steps` / `agent_invocation` 三列 **7 天后被 NULL 化**。

---

## P1 —— 采集补洞

> 新增事件类型的固定三件套：`observer.interface.ts` 加判别联合成员 → `persisting-observer.ts` 白名单（若需落库）→ 生产方 emit。检查 `logger-observer.ts` 对未知类型是否有 default 分支，没有则补 case。

### P1-1 模型身份与重试可见

- `persisting-observer.ts`：白名单加入 `model_call`（每回合 1-3 条，量可控）——补上「未降级回合用了哪个模型」的盲区（model_fallback 一天约百次，未降级轮模型不可知）。
- `src/llm/llm-executor.service.ts`：同模型重试路径（现只有 logger.warn）emit 新事件 `model_retry { modelId, attempt, reason }`，进白名单。

### P1-2 守卫过程事件

- `src/agent/runner/agent-runner.service.ts` repair 循环四种终局（repair_exhausted / repair_exhausted_fail_open / repair_regression_blocked / repair_unusable_fail_open，现仅 logger.warn）emit `guardrail_repair { outcome, ... }`。
- 入站守卫拦截分支（agent-runner 前段 risk-intercept）emit `inbound_guardrail_block`。
- 出站 hard-rules 命中可并入同一事件族。
- 配合已上线的执行事件时间线（P0-1），这些直接在抽屉可见。

### P1-3 booking 路径收资审计

- `src/tools/tool-registry.service.ts`：booking 工具注入处（现注入了 collectionForms/identityAnchors 但**没注入 observer**，对照 precheck 的注入方式）补 observer。
- booking 工具内 anchor 映射失败 / `escalate(form,'booking_identity_anchor_unavailable')` 处 emit 与 precheck 同族的 `collection_*` 事件。

### P1-4 工具事件采样放行 empty/narrow

- `persisting-observer.ts` 的 `shouldPersist`：tool_call 落库条件（现为 sideEffect / error / ≥3s）追加 `status === 'empty' || status === 'narrow'`。量约 +250 条/天，可控。

### P1-5 主动回合 ttft 伪值修正

- `src/agent/reengagement/follow-up.processor.ts`：主动回合不再写 `ttftMs`（现在用整轮生成耗时冒充 TTFT，系统性拉高 avg_ttft）。置 undefined 即可，`avg_ttft` 聚合对 NULL 自动排除，无需改 RPC。

---

## 整体验证

1. `pnpm run lint:check && pnpm run typecheck && pnpm run test`（注意 Node 版本与 --watchman=false 坑）。
2. 完成报告按 P1-1…P1-5 编号逐项列改动与验收状态；未做的项明确写「未做及原因」。
