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
import type { FinalizedVisualFactSheet } from '@resolution/signal/visual';

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

export interface ToolBookingWorkOrderRef {
  workOrderId: number;
  jobId: number | null;
  /**
   * active_booking：蛋糕自建（AI 建单或指针路径）；out_of_band：供应商后台建单（signupSource=SUPPLIER）
   * 或旧带外查询路径。工具只据此决定措辞，归属判定看 ownedByCandidate。
   */
  source: 'active_booking' | 'out_of_band';
  /** 海绵 signupSource；快照路径必有，指针路径为 undefined。 */
  signupSource?: 'AI' | 'SUPPLIER' | null;
  /**
   * 本人校验：海绵登记姓名与会话/档案姓名一致。true 视同自有工单（取消/改约放行、排提醒）；
   * false 只渲染；undefined 表示该引用来自指针路径（归属由 active_booking 保证）。
   */
  ownedByCandidate?: boolean;
  brandName?: string | null;
  jobName?: string | null;
  /** 海绵 `yyyy-MM-dd HH:mm`；等通知单为 null。 */
  interviewTime?: string | null;
  signUpTime?: string | null;
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
  /** 与 [当前预约信息] 同门可见的工单引用（含来源）；带外工单只在这里可见，不进 active_booking。 */
  bookingWorkOrders?: ToolBookingWorkOrderRef[];
  currentFocusJob?: RecommendedJobSummary | null;
  recentBrandPool?: string[];
  bookingCandidateFacts?: EntityExtractionResult['interview_info'] | null;
  /** 已成功拉群事实；用于阻止重复拉群及 Agent 主动续推，候选人明确点名详情时不作永久封口。 */
  invitedGroups?: InvitedGroupRecord[];
}

export interface ToolTurnInputContext {
  messages: unknown[];
  /**
   * 候选人当前消息块之前最近一条经理侧消息是否为真人手动发送（见
   * conversation-normalizer.resolveHumanTakeoverActive）。skip_reply(scene=human_takeover)
   * 的确定性准入条件；缺省视为 false。
   */
  humanTakeoverActive?: boolean;
  /** 事实相关消费方优先用此结构化旁路；messages 仅保留给对话语义判定与模型 transport。 */
  corpusBlocks?: CorpusBlock[];
  currentUserMessage?: string;
  currentLaborFormIntent?: LaborFormIntentDecision;
  imageMessageIds?: string[];
  imageUrls?: string[];
  visualMessageTypes?: Record<string, MessageType.IMAGE | MessageType.EMOTION>;
  contactBrandAliases?: string[];
  geocodeLocationAnchor?: GeocodeLocationAnchor;
  /**
   * 剥时间后缀内容 → 视觉事实 sheet（visual-fact-structuring 消费侧读路径）。
   * 出处公证按 sheet kind 认候选人自陈材料（简历/证件），缺此映射则回落文本兜底、
   * 证件类自陈原话会被排除出出处池。prep 每轮装配一次，工具只读。
   */
  visualSheetsByContent?: ReadonlyMap<string, FinalizedVisualFactSheet>;
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
