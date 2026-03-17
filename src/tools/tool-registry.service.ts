import { Injectable, Logger } from '@nestjs/common';
import {
  AiTool,
  AiToolSet,
  ToolBuildContext,
  ToolFactory,
  ToolRegistration,
} from '@shared-types/tool.types';

/**
 * 统一工具注册表
 *
 * 内置工具通过 ToolFactory 注册，MCP 工具直接注册预构建实例。
 * orchestrator 调用 buildAll(context) 一次性构建所有工具。
 */
@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly registrations = new Map<string, ToolRegistration>();

  // ==================== 注册 ====================

  /** 注册内置工具工厂 */
  registerFactory(factory: ToolFactory): void {
    this.registrations.set(factory.toolName, {
      name: factory.toolName,
      source: 'built-in',
      factory,
    });
    this.logger.log('工具已注册: ' + factory.toolName);
  }

  /** 注册 MCP 动态工具（预构建） */
  registerMcpTool(name: string, tool: AiTool, mcpServer: string): void {
    this.registrations.set(name, {
      name,
      source: 'mcp',
      tool,
      mcpServer,
    });
    this.logger.log(`MCP工具已注册: ${name} (server: ${mcpServer})`);
  }

  // ==================== 查询 ====================

  /** 列出所有已注册工具名 */
  list(): string[] {
    return [...this.registrations.keys()];
  }

  /** 列出指定来源的工具名 */
  listBySource(source: 'built-in' | 'mcp'): string[] {
    return [...this.registrations.entries()]
      .filter(([, r]) => r.source === source)
      .map(([name]) => name);
  }

  // ==================== 构建 ====================

  /**
   * 根据上下文构建所有工具
   *
   * orchestrator 只需传入 context，registry 遍历所有工厂构建。
   * MCP 工具不需要 context，直接返回。
   */
  buildAll(context: ToolBuildContext): AiToolSet {
    const tools: AiToolSet = {};
    for (const [name, reg] of this.registrations) {
      if (reg.source === 'built-in' && reg.factory) {
        tools[name] = reg.factory.buildTool(context);
      } else if (reg.source === 'mcp' && reg.tool) {
        tools[name] = reg.tool;
      }
    }
    return tools;
  }

  /** 只构建指定工具子集 */
  buildSubset(names: string[], context: ToolBuildContext): AiToolSet {
    const tools: AiToolSet = {};
    for (const name of names) {
      const reg = this.registrations.get(name);
      if (!reg) continue;
      if (reg.source === 'built-in' && reg.factory) {
        tools[name] = reg.factory.buildTool(context);
      } else if (reg.source === 'mcp' && reg.tool) {
        tools[name] = reg.tool;
      }
    }
    return tools;
  }

  // ==================== 管理 ====================

  /** 移除指定 MCP 服务器的所有工具 */
  removeByMcpServer(serverName: string): void {
    for (const [name, reg] of this.registrations) {
      if (reg.source === 'mcp' && reg.mcpServer === serverName) {
        this.registrations.delete(name);
        this.logger.log('MCP工具已移除: ' + name);
      }
    }
  }

  remove(name: string): boolean {
    const deleted = this.registrations.delete(name);
    if (deleted) this.logger.log('工具已移除: ' + name);
    return deleted;
  }
}
