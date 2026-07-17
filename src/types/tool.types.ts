import { Tool, ToolSet } from 'ai';
import { StageGoalConfig, Threshold } from './strategy-config.types';
import type {
  EntityExtractionResult,
  HighConfidenceFacts,
  RecommendedJobSummary,
} from '@memory/types/session-facts.types';
import type { UserProfile } from '@memory/types/long-term.types';
import type { MessageType } from '@enums/message-callback.enum';
import type { LaborFormIntentDecision } from '@memory/facts/labor-form';
import type { BrandResolution, SessionBrandState } from '@resolution/brand/brand-resolution.types';

export type AiTool = Tool;
export type AiToolSet = ToolSet;

/** geocode 用的本轮可信位置锚点；只来自候选人高置信事实或真人招募经理最近确认。 */
export interface GeocodeLocationAnchor {
  city?: string;
  districts: string[];
  source: 'current_user' | 'human_agent' | 'session_memory';
  /** 锚点来源原文/结构化地点摘要，用于确认模型 geocode query 确实在回指同一地点。 */
  referenceText?: string;
  /** 排障证据，禁止直接展示给候选人。 */
  evidence: string;
}

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
  /** 当前轮末尾的候选人原话；供工具区分“用户明说”与“模型从昵称臆测”。 */
  currentUserMessage?: string;
  /** 当前轮对用工形式偏好的明确变更；用于让工具覆盖或撤销跨轮旧事实。 */
  currentLaborFormIntent?: LaborFormIntentDecision;
  /** 记录本轮工具查到的岗位候选池；回合结束后再统一写入会话记忆。 */
  onJobsFetched?: (jobs: unknown[]) => void | Promise<void>;
  /** 本轮面试预约是否成功；由 duliday_interview_booking 写入，invite_to_group 读取做硬拦截。 */
  bookingSucceeded?: boolean;
  /**
   * 本轮工具实时解析出的工单号。用于处理“海绵已存在工单，但工单挂在另一微信联系人，
   * 或当前用户的 active_booking 尚未写入”的情况：改约/取消工具拿到有效工单后写入，
   * request_handoff 可据此关联正确工单并避免误判首次约面。
   */
  runtimeWorkOrderId?: number;
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
  /**
   * 本轮生效的会话品牌状态（§9）：已持久化状态，或首轮由昵称/旧数组 seed 出的初始状态。
   * duliday_job_list 的会话品牌兜底只读 currentBrand（§8.1）；状态存在即旧昵称兜底档禁用。
   */
  sessionBrandState?: SessionBrandState | null;
  /**
   * save_image_description 落描述时同步解析出的图片品牌（§10.2）。
   * 解析结果挂回合上下文，供 turn-finalizer 统一写 brand_state；不干预本轮查询。
   */
  onImageBrandResolved?: (resolutions: BrandResolution[], meta: { messageId: string }) => void;
  /** 本轮前置高置信识别结果（含字段级置信度/证据），仅当前轮有效。 */
  highConfidenceFacts?: HighConfidenceFacts | null;
  /**
   * 本轮“附近/这边”等回指查询所依赖的可信位置锚点。
   * geocode 的 unique 结果若与锚点区县冲突，必须带完整上下文重查或要求澄清，
   * 不能把错区坐标继续交给岗位查询。
   */
  geocodeLocationAnchor?: GeocodeLocationAnchor;
  /** 当前会话聚焦岗位快照（用于无参复用 jobId 等上下文） */
  currentFocusJob?: RecommendedJobSummary | null;
  /**
   * 当前仍在进行中的预约工单所属 jobId。
   * 定位工具用它区分“普通咨询工作门店”与“已约面后去哪里面试”：
   * 后者在面试地址与门店地址不同时必须优先面试地址。
   */
  activeBookingJobIds?: number[];
  /**
   * 本会话是否召回/展示过任何岗位（turn-start 的 presentedJobs ∪ lastCandidatePool ∪
   * currentFocusJob，并实时并入本轮 onJobsFetched 抓取的候选池——故自救闭环里"先 job_list
   * 再 precheck"的二次调用能看到本轮刚召回的岗位）。
   *
   * 用途：duliday_interview_precheck / duliday_interview_booking 的 jobId provenance 闸门。
   * **成员判定**（非"是否召回过任意岗位"的布尔）：传入 jobId 是否出自本会话真实召回集。
   * 返回 false 时该 jobId 无合法来源——典型幻觉簇：空会话候选人只发"应聘"模型凭空编 jobId；
   * 或"召回了 A 岗位、模型另编一个恰好真实的 B 岗位 jobId"绕过（P0）。工具直接拒绝并要求先 job_list。
   * 缺省（test/debug 链路未注入）时工具跳过该闸门，保持向后兼容。
   */
  isRecalledJobId?: (jobId: number) => boolean;
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
  /**
   * 不可逆工具提交前的输入新鲜度检查。
   * 返回 true 表示 Agent 运行期间候选人又发了消息，当前工具入参已经过期。
   */
  hasNewerUserInput?: () => Promise<boolean>;
  /**
   * 本轮可用于真实报名的候选人字段权威视图：高置信会话事实与当前轮确定性自报合并结果。
   * booking 用它核对最终 API payload，防止模型绕过 precheck 重新塞入旧记忆。
   */
  bookingCandidateFacts?: EntityExtractionResult['interview_info'] | null;
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
