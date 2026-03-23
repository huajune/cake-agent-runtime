import { Injectable, Logger } from '@nestjs/common';
import { ProceduralService } from '@memory/procedural.service';
import { LongTermService } from '@memory/long-term.service';
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
import { buildInterviewBookingTool } from './duliday-interview-booking.tool';

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
    proceduralService: ProceduralService,
    longTermService: LongTermService,
    spongeService: SpongeService,
  ) {
    this.registry = {
      // ===== 阶段工具 =====
      advance_stage: createToolDefinition({
        name: 'advance_stage',
        description: '推进对话阶段（当前阶段目标达成后切换）',
        create: buildAdvanceStageTool(proceduralService),
      }),

      // ===== 记忆工具（按需检索） =====
      recall_history: createToolDefinition({
        name: 'recall_history',
        description: '查询用户历史求职记录（用户提到"上次""之前"时调用）',
        create: buildRecallHistoryTool(longTermService),
      }),

      // ===== 业务工具 =====
      duliday_job_list: createToolDefinition({
        name: 'duliday_job_list',
        description: '查询在招岗位列表（渐进式数据披露，6 个布尔开关控制返回字段）',
        create: buildJobListTool(spongeService),
      }),

      duliday_interview_booking: createToolDefinition({
        name: 'duliday_interview_booking',
        description: '面试预约（需要姓名、电话、性别、年龄、岗位ID、面试时间）',
        create: buildInterviewBookingTool(spongeService),
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
      'duliday_interview_booking',
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
