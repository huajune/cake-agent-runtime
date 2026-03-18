import { Injectable, Logger } from '@nestjs/common';
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

import { buildMemoryStoreTool } from './memory-store.tool';
import { buildMemoryRecallTool } from './memory-recall.tool';
import { buildAdvanceStageTool } from './advance-stage.tool';
import { buildJobListTool } from './duliday-job-list.tool';
import { buildInterviewBookingTool } from './duliday-interview-booking.tool';

/**
 * 统一工具注册表
 *
 * 所有内置工具的 name + description + create 集中定义于此。
 * MCP 工具运行时动态注册。
 * orchestrator 调用 buildAll(context) 一次性构建所有工具。
 */
@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);

  /** MCP 动态工具（运行时注册） */
  private readonly mcpTools = new Map<string, ToolRegistration>();

  // ========== 内置工具注册表 ==========
  //
  // 所有内置工具在此声明。新增工具时：
  // 1. 在对应 *.tool.ts 中实现 build 函数
  // 2. 在此处用 createToolDefinition() 添加一行

  private readonly registry: Record<string, ToolDefinition>;

  constructor(memoryService: MemoryService, spongeService: SpongeService) {
    this.registry = {
      // ===== 记忆工具 =====
      memory_store: createToolDefinition({
        name: 'memory_store',
        description: '存储候选人信息到记忆（增量合并，不覆盖已有信息）',
        create: buildMemoryStoreTool(memoryService),
      }),

      memory_recall: createToolDefinition({
        name: 'memory_recall',
        description: '回忆候选人已知信息（避免重复提问）',
        create: buildMemoryRecallTool(memoryService),
      }),

      // ===== 阶段工具 =====
      advance_stage: createToolDefinition({
        name: 'advance_stage',
        description: '推进对话阶段（当前阶段目标达成后切换）',
        create: buildAdvanceStageTool(memoryService),
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
  //
  // 每个场景声明自己需要的工具。与 scenario.registry.ts 中的 section 映射对应。
  // 新增场景时：在此添加一行。

  private readonly scenarioToolMap: Record<string, string[]> = {
    'candidate-consultation': [
      'memory_store',
      'memory_recall',
      'advance_stage',
      'duliday_job_list',
      'duliday_interview_booking',
    ],
    'group-operations': ['memory_store', 'memory_recall'],
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
    // MCP 工具追加到场景工具之后
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
