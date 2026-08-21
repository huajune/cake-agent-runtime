/**
 * 阶段状态 — 招聘流程阶段状态。
 *
 * 只有 `currentStage` 一个字段（2026-08-19 记忆审计 S10）：原先还落
 * `fromStage` / `advancedAt` / `reason` 三个"审计"字段，但它们**只写不读**——
 * `StageStateService.get()` 把它们读回结构体后，全库没有一处消费；它们住在
 * 会话 TTL 的 Redis 里，既不进库也不上 Dashboard。
 * 阶段变迁的真实审计链在别处：advance_stage 的 logger 行、`agent_execution_events`
 * 的工具调用事件、`message_processing_records` 的回合流水（同 traceId 可 join），
 * 以及工具返回给模型的 `fromStage`（那是本轮返回值，不是持久状态）。
 */
export interface StageState {
  /** 当前这段会话停留在哪个业务阶段。 */
  currentStage: string | null;
}
