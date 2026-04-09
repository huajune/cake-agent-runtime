import { Tool, ToolSet } from 'ai';
import { StageGoalConfig, Threshold } from './strategy-config.types';
import type { EntityExtractionResult } from '@memory/types/session-facts.types';
import type { UserProfile } from '@memory/types/long-term.types';

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
  /** 业务阈值（策略配置） */
  thresholds?: Threshold[];
  /** 图片消息 ID 列表（当前轮次包含图片时传入，供 save_image_description 工具使用） */
  imageMessageIds?: string[];
  /** 本轮入口阶段；来自程序记忆中的持久化 currentStage。 */
  currentStage?: string | null;
  /** 当前策略里允许使用的合法阶段标识；供 advance_stage 做合法性校验。 */
  availableStages?: string[];
  /** 当前策略的完整阶段配置；供 advance_stage 返回目标阶段的策略快照。 */
  stageGoals?: Record<string, StageGoalConfig>;
  /** 当前与候选人聊天的托管账号企微 userId（企业级 addMember 的 botUserId） */
  botUserId?: string;
  /** 当前与候选人聊天的托管账号系统 wxid（企业级 addMember 的 imBotId） */
  botImId?: string;
  /** 长期记忆中的用户档案（姓名/电话/性别/年龄/学历/健康证） */
  profile?: UserProfile | null;
  /** 当前会话已提取事实（用于工具判断已知/缺失字段） */
  sessionFacts?: EntityExtractionResult | null;
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
