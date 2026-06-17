import { Tool, ToolSet } from 'ai';
import { StageGoalConfig, Threshold } from './strategy-config.types';
import type {
  EntityExtractionResult,
  HighConfidenceFacts,
  RecommendedJobSummary,
} from '@memory/types/session-facts.types';
import type { UserProfile } from '@memory/types/long-term.types';
import type { MessageType } from '@enums/message-callback.enum';

export type AiTool = Tool;
export type AiToolSet = ToolSet;

/**
 * 每轮工具共享的上下文。
 *
 * 这层上下文只描述“本轮执行时工具需要知道什么”，
 * 不承载跨轮持久化状态。真正的记忆读写仍由 memory 模块负责。
 */
export interface ToolBuildContext {
  /** 用户 ID */
  userId: string;
  /** 企业 ID */
  corpId: string;
  /** 会话 ID（chatId） */
  sessionId: string;
  /** 对话消息 */
  messages: unknown[];
  /** 记录本轮工具查到的岗位候选池；回合结束后再统一写入会话记忆。 */
  onJobsFetched?: (jobs: unknown[]) => void | Promise<void>;
  /** 本轮面试预约是否成功；由 duliday_interview_booking 写入，invite_to_group 读取做硬拦截。 */
  bookingSucceeded?: boolean;
  /** 业务阈值（策略配置） */
  thresholds?: Threshold[];
  /** 图片/表情消息 ID 列表（当前轮次包含视觉消息时传入，供 save_image_description 工具使用） */
  imageMessageIds?: string[];
  /**
   * 与 imageMessageIds 一一对应的图片/表情 URL（优先原图 artworkUrl）。
   * 供 save_image_description 在识别到简历图片时回写 "简历附件：URL" 行。
   */
  imageUrls?: string[];
  /**
   * messageId → 视觉消息类型映射。
   * 用于 save_image_description 工具按类型选用 `[图片消息]` / `[表情消息]` 前缀；
   * 缺省条目视为 IMAGE。
   */
  visualMessageTypes?: Record<string, MessageType.IMAGE | MessageType.EMOTION>;
  /** 本轮入口阶段；来自程序记忆中的持久化 currentStage。 */
  currentStage?: string | null;
  /** 当前策略里允许使用的合法阶段标识；供 advance_stage 做合法性校验。 */
  availableStages?: string[];
  /** 当前策略的完整阶段配置；供 advance_stage 返回目标阶段的策略快照。 */
  stageGoals?: Record<string, StageGoalConfig>;
  /** 当前与候选人聊天的托管账号企微 userId（企业级 addMember 的 botUserId） */
  botUserId?: string;
  /** 当前候选人微信昵称（企微回调中的 contactName） */
  contactName?: string;
  /**
   * 从企微名称备注里解析出的目标品牌标准名（运营常把「城市+品牌+门店」备注进名称，
   * 标记这位候选人冲着哪个品牌来）。prep 阶段用品牌词典匹配 contactName 得到。
   *
   * 用途：duliday_job_list 在模型本轮没传任何品牌（brandAliasList/brandIdList 均空）时，
   * 默认用它兜底为 brandAliasList，实现「备注品牌优先召回」。纯提示词驱动经实测不可靠
   * （模型会忽略备注、按距离推），故在工具入参层确定性注入。
   */
  contactBrandAliases?: string[];
  /** 当前与候选人聊天的托管账号系统 wxid（企业级 addMember 的 imBotId） */
  botImId?: string;
  /** 当前消息所属小组 ID（企业级回调有值时用于账号级配置兜底） */
  groupId?: string;
  /** 策略来源：testing 链路默认禁用外部副作用工具（如真实拉群）。 */
  strategySource?: 'released' | 'testing';
  /** 长期记忆中的用户档案（姓名/电话/性别/年龄/学历/健康证） */
  profile?: UserProfile | null;
  /** 当前会话已提取事实（用于工具判断已知/缺失字段） */
  sessionFacts?: EntityExtractionResult | null;
  /** 本轮前置高置信识别结果（含字段级置信度/证据），仅当前轮有效。 */
  highConfidenceFacts?: HighConfidenceFacts | null;
  /** 当前会话聚焦岗位快照（用于无参复用 jobId 等上下文） */
  currentFocusJob?: RecommendedJobSummary | null;
  /**
   * 本会话最近推荐过的品牌名集合（去重）。
   *
   * 来源：sessionMemory.presentedJobs ∪ sessionMemory.lastCandidatePool 的 brandName。
   * 用途：duliday_job_list 在 brandAliasList 命中 0 时做同音/字形回指模糊匹配，
   * 识别"刘姐妹"实指上轮推过的"成都你六姐"这类候选人口误，避免直接判 0 拉群。
   */
  recentBrandPool?: string[];
  /** 当前聊天会话的企业级 token（供需要主动发消息的工具使用） */
  token?: string;
  /** 当前聊天对象的系统 wxid（私聊时使用） */
  imContactId?: string;
  /** 当前群聊的系统 wxid（群聊时使用） */
  imRoomId?: string;
  /** 当前聊天会话 ID；wecom 场景下与 sessionId 相同，但保留单独字段便于工具直接发送消息 */
  chatId?: string;
  /** 当前消息发送链路使用的 API 类型 */
  apiType?: 'enterprise' | 'group';
  /**
   * 本轮稳定 trace/turn ID（= 触发本轮的企微 messageId 或聚合 batchId）。
   *
   * 同一批输入重跑（Bull 重试）会得到相同值，故可作运营事件「单次事件」幂等键的稳定种子：
   * 既能区分同一候选人不同轮次/不同天的重复事件（不再被压成每候选人一次），
   * 又能在重试时去重（不会重复 +1）。缺省（test/debug 链路）时由工具回退到时间戳。
   */
  turnId?: string;
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
