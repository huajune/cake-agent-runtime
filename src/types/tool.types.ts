import { Tool, ToolSet } from 'ai';
import { StageGoalConfig, Threshold } from '@biz/strategy/types/strategy.types';
import type { CandidatePrefillHints } from '@resolution/candidate/types';
import type {
  EntityExtractionResult,
  InvitedGroupRecord,
} from '@memory/short-term/short-term.types';
import type { RecommendedJobSummary } from '@resolution/job/types';
import type { UserProfile } from '@memory/long-term/long-term.types';
import type { MessageType } from '@enums/message-callback.enum';
import type { LaborFormIntentDecision } from '@resolution/labor-form';
import type { SessionBrandState } from '@resolution/brand/brand-resolution.types';
import type { GeocodeLocationAnchor, TurnLedger } from './turn.types';
import type { CorpusBlock } from './corpus.types';

export type AiTool = Tool;
export type AiToolSet = ToolSet;

export interface ToolSessionContext {
  userId: string;
  corpId: string;
  sessionId: string;
  chatId?: string;
  token?: string;
  imContactId?: string;
  imRoomId?: string;
  apiType?: 'enterprise' | 'group';
  botUserId?: string;
  botImId?: string;
  groupId?: string;
  turnId?: string;
  contactName?: string;
}

export interface ToolArchiveContext {
  profile?: UserProfile | null;
  sessionFacts?: EntityExtractionResult | null;
  /** medium/system 值的只读确认视图；不得当作已确权事实消费。 */
  candidatePrefillHints?: CandidatePrefillHints;
  sessionBrandState?: SessionBrandState | null;
  currentStage?: string | null;
  availableStages?: string[];
  stageGoals?: Record<string, StageGoalConfig>;
  recalledJobIds?: number[];
  isRecalledJobId?: (jobId: number) => boolean;
  lastJobListQuery?: { signature: string; turnId: string | null } | null;
  activeBookingJobIds?: number[];
  currentFocusJob?: RecommendedJobSummary | null;
  recentBrandPool?: string[];
  bookingCandidateFacts?: EntityExtractionResult['interview_info'] | null;
  /** 已成功拉群事实；岗位工具据此永久关闭后续推荐查询。 */
  invitedGroups?: InvitedGroupRecord[];
}

export interface ToolTurnInputContext {
  messages: unknown[];
  /** 事实相关消费方优先用此结构化旁路；messages 仅保留给对话语义判定与模型 transport。 */
  corpusBlocks?: CorpusBlock[];
  currentUserMessage?: string;
  currentLaborFormIntent?: LaborFormIntentDecision;
  imageMessageIds?: string[];
  imageUrls?: string[];
  visualMessageTypes?: Record<string, MessageType.IMAGE | MessageType.EMOTION>;
  contactBrandAliases?: string[];
  geocodeLocationAnchor?: GeocodeLocationAnchor;
}

export interface ToolRuntimeContext {
  hasNewerUserInput?: () => Promise<boolean>;
  strategySource?: 'released' | 'testing';
  thresholds?: Threshold[];
}

/** 工具输入工作包：档案、原始输入、回合账本和运行探针分组显式。 */
export interface ToolBuildContext {
  session: ToolSessionContext;
  archive: ToolArchiveContext;
  turnInput: ToolTurnInputContext;
  ledger: TurnLedger;
  runtime: ToolRuntimeContext;
}

/** 工具构建函数。 */
export type ToolBuilder = (context: ToolBuildContext) => AiTool;

/** 工具定义。 */
export interface ToolDefinition {
  name: string;
  description: string;
  create: ToolBuilder;
}

/** 创建工具定义。 */
export function createToolDefinition(def: ToolDefinition): ToolDefinition {
  return def;
}

/** 运行时工具注册记录。 */
export interface ToolRegistration {
  name: string;
  source: 'built-in' | 'mcp';
  /** MCP 工具：预构建的 tool */
  tool?: AiTool;
  /** MCP 服务器名称 */
  mcpServer?: string;
}
