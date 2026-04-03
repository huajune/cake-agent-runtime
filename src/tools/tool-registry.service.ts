import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemoryService } from '@memory/memory.service';
import { SpongeService } from '@sponge/sponge.service';
import {
  AiTool,
  AiToolSet,
  ToolBuildContext,
  ToolDefinition,
  ToolRegistration,
  createToolDefinition,
} from '@shared-types/tool.types';

import { buildAdvanceStageTool } from './advance-stage.tool';
import { buildRecallHistoryTool } from './recall-history.tool';
import { buildJobListTool } from './duliday-job-list.tool';
import { buildInterviewPrecheckTool } from './duliday-interview-precheck.tool';
import { buildInterviewBookingTool } from './duliday-interview-booking.tool';
import { buildGeocodeTool } from './geocode.tool';
import { buildSaveImageDescriptionTool } from './save-image-description.tool';
import { buildInviteToGroupTool } from './invite-to-group.tool';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { RoomService } from '@channels/wecom/room/room.service';
import { RedisService } from '@infra/redis/redis.service';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';

/**
 * 统一工具注册表
 *
 * 所有内置工具的 name + description + create 集中定义于此。
 * MCP 工具运行时动态注册。
 * orchestrator 调用 buildAll(context) 一次性构建所有工具。
 *
 * 记忆工具策略：
 * - memory_store / memory_recall 已删除（编排层固定读写，不由 LLM 自主决定）
 * - advance_stage 保留（程序记忆，只有 LLM 能判断推进时机）
 */
@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);

  /** MCP 动态工具（运行时注册） */
  private readonly mcpTools = new Map<string, ToolRegistration>();

  // ========== 内置工具注册表 ==========

  private readonly registry: Record<string, ToolDefinition>;

  constructor(
    memoryService: MemoryService,
    spongeService: SpongeService,
    geocodingService: GeocodingService,
    private readonly chatSessionService: ChatSessionService,
    groupResolverService: GroupResolverService,
    roomService: RoomService,
    redisService: RedisService,
    alertService: FeishuAlertService,
    configService: ConfigService,
  ) {
    const memberLimit = parseInt(configService.get('GROUP_MEMBER_LIMIT', '190'), 10);
    const enterpriseToken = configService.get<string>('STRIDE_ENTERPRISE_TOKEN', '');
    this.registry = {
      // ===== 阶段工具 =====
      advance_stage: createToolDefinition({
        name: 'advance_stage',
        description: '推进对话阶段（当前阶段目标达成后切换）',
        create: buildAdvanceStageTool(memoryService),
      }),

      // ===== 记忆工具（按需检索） =====
      recall_history: createToolDefinition({
        name: 'recall_history',
        description: '查询用户历史求职记录（用户提到"上次""之前"时调用）',
        create: buildRecallHistoryTool(memoryService),
      }),

      // ===== 业务工具 =====
      duliday_job_list: createToolDefinition({
        name: 'duliday_job_list',
        description:
          '查询在招岗位列表（负责推荐阶段的数据查询与摘要；传入 userLatitude/userLongitude 后会按距离排序并按业务阈值过滤）',
        create: buildJobListTool(spongeService),
      }),

      duliday_interview_booking: createToolDefinition({
        name: 'duliday_interview_booking',
        description: '面试预约（仅做接口字段校验与提交；仅在确认进入约面时调用）',
        create: buildInterviewBookingTool(spongeService),
      }),

      duliday_interview_precheck: createToolDefinition({
        name: 'duliday_interview_precheck',
        description:
          '面试前置校验（按岗位返回可约日期/时段、备注解析后的字段建议、报名补充信息；不真正提交预约）',
        create: buildInterviewPrecheckTool(spongeService),
      }),

      geocode: createToolDefinition({
        name: 'geocode',
        description: '地理编码（将地名解析为标准化地址 + 经纬度；做附近推荐或距离过滤前优先调用）',
        create: buildGeocodeTool(geocodingService),
      }),

      invite_to_group: createToolDefinition({
        name: 'invite_to_group',
        description: '邀请候选人加入企微兼职群（穷尽推荐无匹配/登记完成后触发）',
        create: buildInviteToGroupTool(
          groupResolverService,
          roomService,
          redisService,
          alertService,
          memoryService,
          memberLimit,
          enterpriseToken,
        ),
      }),
    };

    this.logger.log(`内置工具已注册: ${Object.keys(this.registry).join(', ')}`);
  }

  // ==================== 场景工具映射 ====================

  private readonly scenarioToolMap: Record<string, string[]> = {
    'candidate-consultation': [
      'advance_stage',
      'recall_history',
      'duliday_job_list',
      'duliday_interview_precheck',
      'duliday_interview_booking',
      'geocode',
      'invite_to_group',
    ],
    'group-operations': [],
    evaluation: [],
  };

  // ==================== MCP 动态注册 ====================

  registerMcpTool(name: string, tool: AiTool, mcpServer: string): void {
    this.mcpTools.set(name, { name, source: 'mcp', tool, mcpServer });
    this.logger.log(`MCP工具已注册: ${name} (server: ${mcpServer})`);
  }

  removeByMcpServer(serverName: string): void {
    for (const [name, reg] of this.mcpTools) {
      if (reg.mcpServer === serverName) {
        this.mcpTools.delete(name);
        this.logger.log('MCP工具已移除: ' + name);
      }
    }
  }

  // ==================== 查询 ====================

  list(): string[] {
    return [...Object.keys(this.registry), ...this.mcpTools.keys()];
  }

  listBySource(source: 'built-in' | 'mcp'): string[] {
    if (source === 'built-in') return Object.keys(this.registry);
    return [...this.mcpTools.keys()];
  }

  // ==================== 构建 ====================

  buildAll(context: ToolBuildContext): AiToolSet {
    const tools: AiToolSet = {};

    for (const [name, def] of Object.entries(this.registry)) {
      tools[name] = def.create(context);
    }

    for (const [name, reg] of this.mcpTools) {
      if (reg.tool) tools[name] = reg.tool;
    }

    return tools;
  }

  /** 按场景构建工具子集，未注册场景回退到 buildAll */
  buildForScenario(scenario: string, context: ToolBuildContext): AiToolSet {
    const names = this.scenarioToolMap[scenario];
    if (!names) {
      this.logger.warn(`场景 "${scenario}" 无工具映射，回退到 buildAll`);
      return this.buildAll(context);
    }
    const tools = this.buildSubset(names, context);
    for (const [name, reg] of this.mcpTools) {
      if (reg.tool) tools[name] = reg.tool;
    }

    // 动态注入：当前轮次有图片消息时，注册 save_image_description 工具
    if (context.imageMessageIds?.length) {
      const imgTool = buildSaveImageDescriptionTool(
        this.chatSessionService,
        context.imageMessageIds,
      );
      tools['save_image_description'] = imgTool(context);
      this.logger.log(
        `动态注入 save_image_description 工具, imageMessageIds=${context.imageMessageIds.join(',')}`,
      );
    }

    return tools;
  }

  buildSubset(names: string[], context: ToolBuildContext): AiToolSet {
    const tools: AiToolSet = {};

    for (const name of names) {
      const def = this.registry[name];
      if (def) {
        tools[name] = def.create(context);
        continue;
      }
      const mcp = this.mcpTools.get(name);
      if (mcp?.tool) tools[name] = mcp.tool;
    }

    return tools;
  }

  // ==================== 管理 ====================

  remove(name: string): boolean {
    const deleted = this.mcpTools.delete(name);
    if (deleted) this.logger.log('工具已移除: ' + name);
    return deleted;
  }
}
