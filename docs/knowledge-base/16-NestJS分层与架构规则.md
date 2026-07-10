---
tags: [nestjs, 架构, 学习]
source: src/
---

# NestJS 分层与架构规则

## 一条铁律统治依赖方向

> 依赖业务数据（用户、消息）→ `biz/`；可独立于业务存在 → `infra/`。
> **`infra/` 禁止 import `biz/`、`channels/`、`agent/`。**

这是整个仓库唯一需要背下来的分层规则，其余都能推导。价值在于：infra（config/redis/supabase/告警/HTTP）可以被任何模块安全依赖而不会出现循环；业务概念的变化永远不会波及基础设施。

## 域的划分（按业务能力而非技术层）

```
providers/ llm/ tools/ memory/ agent/ —— AI 核心链路（各自独立域）
channels/wecom/ —— 渠道接入（ingress → application → runtime → delivery）
biz/ —— 业务域（monitoring / strategy / user / message / intervention…）
observability/ notification/ analytics/ evaluation/ —— 横切能力
```

channels 内部再分四段是**管道模式**：接收（快速 200 返回）→ 过滤 → 运行时（去重/debounce）→ 投递，每段单一职责、可独立观测。

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
