# 观测链路优化 · 执行清单（P1 采集补洞 · 剩余 3 项）

> 背景：Web 后台消息处理页看不全 agent 回合的过程信息。审计结论：大量数据**库里有但前端不渲染**，另有若干采集空洞。
> **P0（展示侧七项）已全部执行完毕（2026-08-24/25）**：P0-1 执行事件时间线 `e1c5d0d8`、P0-2 工具面板换数据源 `2b5bdf06`、P0-3 守卫语义判例渲染 `c04a1eeb`、P0-4 右栏关键字段 `72ad418d`、P0-5 会话↔流水互跳 `99f7d5fe`、P0-6 实时刷新修复+死代码清理 `07c60265`、P0-7 断流事件按方案 B 下线消费端 `03494c19`。原 P0 清单见 git 历史。
> **P1 已完成两项（2026-09-02 核对）**：P1-1 模型身份与重试可见——由 `llm_execution` 事件承接（每回合一条，含 attempts 数组 / finalModelId / 重试与退避，常驻落库，v11.1.0）；P1-3 booking 路径收资审计——booking 工具已注入 observer 并发 `collection_form_audit`（v11.1.0，`error_list_unmapped` 已有事件）。
> 本文档剩余范围 = **P1-2 / P1-4 / P1-5**；P2（保留策略/落库可靠性/迁移类）仍不做。仓库约定（Node 版本、pathspec 提交、jest 坑）见 CLAUDE.md。

---

## 关键事实（已实测验证，直接采信）

- **跨表 join 键**：`agent_execution_events.trace_id` = `message_processing_records.message_id` = `guardrail_review_records.trace_id`。mpr 表**没有** trace_id 列。
- `agent_execution_events` 事件类型定义在 `src/observability/observer.interface.ts`，落库白名单在 `src/observability/persisting-observer.ts`（`ALWAYS_PERSISTED_EVENT_TYPES` + `shouldPersist` 条件采样），保留 60 天（数据保留策略统一后为 90 天）。
- mpr 的 `tool_calls` / `agent_steps` / `agent_invocation` 三列 **7 天后被 NULL 化**。
- 新增事件类型的固定三件套：`observer.interface.ts` 加判别联合成员 → `persisting-observer.ts` 白名单（若需落库）→ 生产方 emit。检查 `logger-observer.ts` 对未知类型是否有 default 分支，没有则补 case。

---

## P1-2 守卫过程事件

- `src/agent/runner/agent-runner.service.ts` repair 循环四种终局（repair_exhausted / repair_exhausted_fail_open / repair_regression_blocked / repair_unusable_fail_open，现仅 logger.warn）emit `guardrail_repair { outcome, ... }`。
- 入站守卫拦截分支（agent-runner 前段 risk-intercept）emit `inbound_guardrail_block`。
- 出站 hard-rules 命中可并入同一事件族。
- 配合已上线的执行事件时间线（P0-1），这些直接在抽屉可见。

## P1-4 工具事件采样放行 empty/narrow

- `persisting-observer.ts` 的 `shouldPersist`：tool_call 落库条件（现为 sideEffect / error / ≥3s）追加 `status === 'empty' || status === 'narrow'`。量约 +250 条/天，可控。

## P1-5 主动回合 ttft 伪值修正

- `src/agent/reengagement/follow-up.processor.ts`（2026-09-02 仍在 `ttftMs: Math.max(execution.aiEndAt - params.receivedAt, 0)`）：主动回合不再写 `ttftMs`（现在用整轮生成耗时冒充 TTFT，系统性拉高 avg_ttft）。置 undefined 即可，`avg_ttft` 聚合对 NULL 自动排除，无需改 RPC。

---

## 整体验证

1. `pnpm run lint:check && pnpm run typecheck && pnpm run test`（注意 Node 版本与 --watchman=false 坑）。
2. 完成报告按 P1-2 / P1-4 / P1-5 编号逐项列改动与验收状态；未做的项明确写「未做及原因」。
