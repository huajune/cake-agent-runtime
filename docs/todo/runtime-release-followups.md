# 运行时改造发版后续

**最后核对**：2026-09-02

上下文装配与记忆终态改造已随 v11.0.0 / v11.0.1（2026-08-27）上线。本单原有三项，两项已核验并
写入 [v11.0.0 发版底账](../releases/2026/v11.0.0.md)：五个 migration 生产库对齐（§6）、
system 段序上线后的缓存命中数字（§7，24h 窗口 64.2%）。

## 唯一剩余项：badcase / test-suite 基线复测

生产 `test_batches` 最近一批仍是 2026-08-20（收资记忆切换 58 条复测），v11 上线后**没有跑过
基线批**。日频观测（`logs/observability/`）未见系统性回升，但那不是 test-suite 口径，不能代替。

**完成条件**：在 Dashboard test-suite 用既有 badcase 策展集跑一批，`pass_rate` 不低于 08-20 各批
均值；批次 id 与 pass_rate 补进 v11.0.0 底账 §7 后删除本 todo。若回升，按 case 归因另立 todo。

## 相关文档

- [v11.0.0 发版底账](../releases/2026/v11.0.0.md)
- [Agent 运行时架构](../architecture/agent-runtime-architecture.md)
- [Memory 当前实现](../../src/memory/README.md)
