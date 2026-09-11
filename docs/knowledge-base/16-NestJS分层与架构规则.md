---
tags: [nestjs, 架构, 学习]
source: src/
---

# NestJS 分层与架构规则

> 最后更新：2026-09-11。依据当前模块注册与 ESLint 依赖约束核对。

## 先确定依赖方向，再划分模块

> 依赖业务数据（用户、消息）→ `biz/`；可独立于业务存在 → `infra/`。
> **`infra/` 禁止 import `biz/`、`channels/`、`agent/`。**

这条规则让 infra（config/redis/supabase/告警/HTTP）保持通用，减少业务变化向基础设施传播。它是依赖约束之一；候选人解析与记忆还有更窄的边界，不能只靠目录名推导。

- **resolution** 提供确定性解析与共享原语，禁止反向依赖 memory、agent、tools、biz、channels；外部依赖上限为品牌目录所需的 sponge 与解释业务日期的 `infra/utils/date.util`。
- **resolution/geo** 采用更严格的零出向域依赖，不依赖 sponge、infra 或 brand。地理供应商接入归 infra，业务适配归 tools。
- **memory** 不依赖 tools 或 biz；需要业务能力时由装配层通过窄端口注入，收资单据和动作留在工具域。

这些约束由 [ESLint 配置](../../.eslintrc.js) 的目录规则检查。允许上层消费共享原语，不意味着共享原语可以反过来调用上层状态机。

## 域的划分（按业务能力而非技术层）

```
providers/ llm/ tools/ memory/ agent/ —— AI 核心链路（各自独立域）
resolution/ —— 确定性解析、公证与共享原语，受窄依赖约束
channels/wecom/ —— 渠道接入（ingress → application → runtime → delivery）
biz/ —— 业务域（monitoring / strategy / user / message / intervention…）
observability/ notification/ analytics/ evaluation/ —— 横切能力
```

channels 内部再分四段是**管道模式**：接收（快速 200 返回）→ 过滤 → 运行时（去重/debounce）→ 投递，每段单一职责、可独立观测。

## 守卫登记、规则执行与修复分属不同职责

`guardrail/catalog.ts` 只聚合 Input、Tool、Output 子目录的审计信息，不重复手写规则 ID、默认动作与源码映射。Input/Output 的执行器消费各自规则定义；Tool catalog 仅登记，实际门禁留在 tools/resolution，避免工具为了被审计而反向依赖 agent。

Output 根目录保留门面、公共类型与 catalog，具体检测及调度归 `output/rules/`，确定性清洗归 `output/sanitizer/`。修复证据包、`RepairEvidenceBuilder` 与回归检查归 `reply-repair/`，Builder 由 `AgentModule` 注册，`GuardrailModule` 不提供或导出修复证据。Runner 负责有限次数的修复编排与最终处置，不能把修复回归和恢复流程也塞进规则登记表。

这是一种所有权约束：检测回答“本次审查发现什么”，修复负责“如何安全得到可投递结果”，Runner 决定最终 `reply/handoff/skipped`。入口：[聚合 catalog](../../src/agent/guardrail/catalog.ts)、[AgentModule](../../src/agent/agent.module.ts)、[GuardrailModule](../../src/agent/guardrail/guardrail.module.ts)。

## 工程约定（有真实事故背书的那几条）

- TS 严格模式禁 `any`（用 `unknown` + 收窄）——LLM 返回值是最大的 `any` 诱惑源，恰恰是最需要 schema 校验（zod parse）的地方
- 禁手动 `new Service()`，一切走 DI——可测试性的前提
- 统一响应包装 ResponseInterceptor + HttpExceptionFilter，第三方回调用 `@RawResponse` 绕过（回调方要求原样格式）
- 全局 ApiTokenGuard 默认鉴权，`@Public()` 显式放行（回调入口）——**默认拒绝**优于默认放行
- Service 超 ~500 行考虑拆分；文件 kebab-case / 类 PascalCase

## 前端（web/）与后端同仓

React 18 + Vite 的运营 Dashboard 随主服务构建部署（`start:dev` 先 build web）。单仓的取舍：部署简单、类型可共享（`@shared-types`），代价是构建耦合。团队规模小时单仓正确。

## 学习要点

被问"你的架构为什么这样分"时，最有力的回答不是画层次图，而是讲**依赖规则如何防事故**：infra 不依赖 biz 意味着任何业务重构都不可能弄坏 Redis/DB 接入层；管道分段意味着去重逻辑的 bug 不会藏在投递代码里。架构的本质是**约束变更的传播范围**。
