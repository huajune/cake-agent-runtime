import { Injectable, Logger } from '@nestjs/common';
import { AiTool, AiToolSet, ToolRegistration } from './tool.types';

@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly tools = new Map();
  register(reg: ToolRegistration): void {
    this.tools.set(reg.name, reg);
    this.logger.log('工具已注册: ' + reg.name);
  }
  registerMany(regs: ToolRegistration[]): void {
    for (const r of regs) this.register(r);
  }
  get(name: string): AiTool | undefined {
    return this.tools.get(name)?.tool;
  }
  getAll(): AiToolSet {
    const s: AiToolSet = {};
    for (const [n, r] of this.tools.entries()) s[n] = r.tool;
    return s;
  }
  list(): string[] {
    return [...this.tools.keys()];
  }
  getBySource(source: 'built-in' | 'mcp'): AiToolSet {
    const s: AiToolSet = {};
    for (const [n, r] of this.tools.entries()) if (r.source === source) s[n] = r.tool;
    return s;
  }
  remove(name: string): boolean {
    const d = this.tools.delete(name);
    if (d) this.logger.log('工具已移除: ' + name);
    return d;
  }
  removeByMcpServer(serverName: string): void {
    for (const [n, r] of this.tools.entries())
      if (r.source === 'mcp' && r.mcpServer === serverName) {
        this.tools.delete(n);
        this.logger.log('工具已移除: ' + n);
      }
  }
}
