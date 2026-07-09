---
tags: [prompt工程, agent, 学习]
source: src/agent/generator/context/
---

# Prompt Section 动态组装体系

## 解决什么问题

系统提示词如果是一个大 markdown 模板：改一处怕碰全局、无法按会话状态裁剪、多人/多会话协作时冲突不断、也没法单测。本项目把 system prompt 拆成 **13 个独立 Section**，每回合按当前上下文动态组装。

## Section 清单（`src/agent/generator/context/sections/`）

| Section | 职责 |
|---|---|
| identity | Agent 人设身份（招聘顾问 persona，来自 DB 策略配置） |
| channel | 渠道特性（企微私聊的表达约束） |
| datetime | 当前时间（约面试必需，防 LLM 用训练时间） |
| memory | 四层记忆召回结果注入（fact-lines） |
| stage-strategy | 当前招聘阶段 + 该阶段的目标话术策略 |
| red-lines | 业务红线（户籍/民族/专业歧视禁令等，存 DB 可运营更新） |
| hard-constraints | 硬约束 |
| thresholds | 各类阈值 |
| turn-hints | 本回合提示（如备注里解析出的品牌优先） |
| group-inventory | 可邀群清单 |
| policy / static / runtime-context | 通用政策、静态文案、运行时上下文 |

每个 Section 实现统一的 `section.interface.ts`，`context.service.ts` 负责按序拼装。`final-prompt-example.md` 留了一份完整拼装示例作为"活文档"。

## 设计要点

1. **配置与代码分离**：persona、红线、阶段策略存 DB（strategy 域），运营在 Dashboard 改，即时生效不发版。Prompt 工程从"开发者改代码"变成"运营改配置"。
2. **按状态裁剪**：没有可邀群就不注入 group-inventory；不在约面阶段就不注入面试相关阈值——prompt 更短、更聚焦、更便宜。
3. **分层放置原则**（重要裁定）：与某个工具语义强绑定的业务约束放**工具 description**；只有跨工具的全局原则才放 system prompt。否则 system prompt 变成万物垃圾场，模型对局部规则的遵循度反而下降。
4. **可观测**：完整拼装后的 prompt 随 `agent_invocation` 落库（见 [[10-可观测性体系]]），排障时能看到"模型当时到底看到了什么"，Dashboard 有"最终提示词" tab。

## 学习要点

- 这本质是把前端组件化思想（单一职责、组合、props 驱动渲染）迁移到 prompt 工程——对前端转型背景是个天然的叙事桥。
- 反直觉经验：**prompt 不是越全越好**。纯提示词约束（如"优先推荐备注里的品牌"）实测模型会随机忽略，最终靠代码层确定性兜底（prep 阶段解析备注 → 直接带参调岗位接口）。教训：**关键业务规则不能只靠 prompt，要有确定性代码路径兜底**。
