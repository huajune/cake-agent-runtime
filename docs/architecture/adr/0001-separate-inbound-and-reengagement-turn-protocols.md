# ADR-0001：被动入站与主动复聊使用不同运行协议

- 状态：Accepted
- 日期：2026-09-02
- 决策范围：Agent Runner、Generator Preparation、Reengagement

## 背景

主聊天链路处理候选人已经发来的消息，需要入站风险预检、上下文装配、工具执行、出站审核、Replay、
投递和记忆结算。主动复聊由定时任务触发，没有新的候选人消息，只允许生成一条受约束的触达文案，
并有独立的停止条件、频控、outbox 和投递底账。

旧 `TurnTrigger = inbound | proactive` 把两种协议包装为同一种 Runner 输入。为了让主动事件穿过只接受
messages 的 Generator，代码不得不伪造 user placeholder，并在 Runner、Preparation、错误处理和测试替身
中不断判断 `trigger.kind`。类型表达的统一与实际运行链路不一致。

## 决策

1. `AgentRunnerService.runInboundTurn(InboundTurnRequest)` 是主 Runner 唯一公开回合协议；
2. `InboundTurnRequest.input` 直接表达候选人文本和图片，不再使用 trigger union；
3. `ReengagementAgent` 保持独立，不进入主 Runner、Preparation、Prompt Compiler 或 Generator tool loop；
4. 不为主动任务伪造 user message，也不在主 Generator 保留 `proactiveDirective`；
5. 两条链可以共享 LLM 执行基础设施、`TurnOutcome` 数据形态和投递组件，但不得借共享类型掩盖不同的
   准入、工具、副作用和结算语义。

## 同步裁定：入站回合采用显式编译边界

主 Generator 的 Preparation 只做阶段编排：

```text
NormalizedTurnInput
→ TurnSourceSnapshot
→ ResolvedTurnContext
   ├─ PromptModel → Section → Prompt Compiler
   └─ ToolContextModel + ledgerSeed → Tool Runtime
→ WorkingMemory
```

- 外部 IO 集中在 Loader；
- 事实与安全决策集中在 Resolver；
- Section 是同步纯渲染器；
- Prompt 的跨类别位置由 Slot 决定，场景 Manifest 只声明集合与同 slot 顺序；
- Tool Runtime 只消费已裁决模型，不反查外部源。

## 后果

正向后果：

- 主 Runner 不再有 `trigger.kind` 分支和虚假用户输入；
- 主动任务不会被误计为候选人消息，也不会误入记忆提取和 Prompt Injection；
- Loader / Resolver / Prompt / Tool 可以分别测试和观测；
- 新的系统触发协议必须显式设计，不能悄悄塞回 inbound union。

代价：

- inbound 与 reengagement 各自维护入口测试和协议文档；
- 想复用某项能力时，需要把它下沉为明确的共享组件，而不是复用整条 Runner。

## 执法检查

- `src/agent/runner/` 不允许出现 `trigger.kind`、`TurnTrigger` 或 proactive placeholder；
- WeCom 只构造 `InboundTurnRequest` 并调用 `runInboundTurn()`；
- Reengagement 测试必须证明无工具物理边界、停止条件和投递底账仍独立；
- Prompt 兼容测试锁定 block id/domain/slot 顺序、最终字符串、工具集合、entryStage 和 ledger seed。

## 关联文档

- [Agent Runtime 架构](../agent-runtime-architecture.md)
- [主动复聊与二次触达流水线](../reengagement-pipeline.md)
- [Agent 回合装配边界重构方案](../../todo/agent-turn-assembly-refactor.md)
