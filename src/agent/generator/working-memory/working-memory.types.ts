import type { ModelMessage, ToolSet } from 'ai';
import type { TurnLedger } from '@shared-types/turn.types';
import type { CorpusBlock, PromptCorpusBlock } from '@shared-types/corpus.types';
import type { AgentMemorySnapshot } from '../generator.types';

/**
 * Working Memory（CoALA 语义）：本轮工作记忆的初始装配产物——prepare() 的返回值。
 *
 * 覆盖范围是"初始装配"（finalPrompt + 归一化消息 + 工具集 + 回合账本）；
 * 回合内经 prepareStep 增长的部分（工具结果累积）在 generator.agent 侧，回合结束即弃。
 * 命名裁定见 docs/todo/memory-coala-alignment.md M2-B（2026-08-21）。
 */
export interface WorkingMemory {
  finalPrompt: string;
  /** finalPrompt 降维前的结构化分域块，供审计确认教学/证据/工具结果边界。 */
  promptBlocks: PromptCorpusBlock[];
  normalizedMessages: ModelMessage[];
  /** 对话语料的结构化旁路；transport role 不再决定事实出处资格。 */
  conversationCorpusBlocks: CorpusBlock[];
  memoryLoadWarning?: string;
  tools: ToolSet;
  corpId: string;
  userId: string;
  sessionId: string;
  /** 当前与候选人聊天的托管账号 wxid（imBotId）；沉淀时作为长期事实的 bot 血缘。 */
  botImId?: string;
  maxSteps: number;
  /** 本轮入口阶段：stageState currentStage 优先，过期时按长期画像做老用户回访兜底，否则回落策略首阶段。 */
  entryStage: string | null;
  /** 本轮唯一回合账本；回合结束时 drain 快照统一交给 memory lifecycle。 */
  ledger: TurnLedger;
  /** 候选人微信昵称；回合收尾 facts.brand 首次初始化（seed）用。 */
  contactName?: string;
  /** 本轮触发时的记忆上下文快照（写入 message_processing_records.memory_snapshot 用于排障） */
  memorySnapshot?: AgentMemorySnapshot;
  /**
   * toolCallId → 工具 execute 的真实执行耗时（毫秒）。
   * 由 prepare 阶段的 timing wrapper 在每次工具执行时写入；
   * GeneratorAgent.buildRunResult 按 toolCallId 合并进 AgentToolCall.durationMs，
   * 与"步骤墙钟"（含 LLM 思考/输出时间）区分开。
   */
  toolExecutionTimings: Map<string, number>;
}
