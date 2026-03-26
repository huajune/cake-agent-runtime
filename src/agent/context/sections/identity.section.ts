import { PromptSection, PromptContext } from './section.interface';
import { StrategyPersona, StrategyRoleSetting } from '@shared-types/strategy-config.types';

/**
 * 身份段落 — 角色设定 + 人格设定 + 基础提示词
 *
 * roleSetting 定义 Agent 的角色身份（注入为 ## 角色 段落），
 * persona 的 textDimensions（style 组）构成沟通风格，
 * 基础提示词（.md）定义工作流程、工具使用等核心指令。
 *
 * 三者拼接为完整的身份定义。
 */
export class IdentitySection implements PromptSection {
  readonly name = 'identity';

  constructor(private readonly basePrompt: string) {}

  build(ctx: PromptContext): string {
    const roleText = this.buildRoleText(ctx.strategyConfig.role_setting);
    const personaText = this.buildPersonaText(ctx.strategyConfig.persona);
    const parts: string[] = [];
    if (roleText) parts.push(roleText);
    if (personaText) parts.push(personaText);
    if (this.basePrompt) parts.push(this.basePrompt);
    return parts.join('\n\n');
  }

  private buildRoleText(roleSetting: StrategyRoleSetting | undefined): string {
    if (!roleSetting?.content?.trim()) return '';
    return `## 角色\n\n${roleSetting.content.trim()}`;
  }

  private buildPersonaText(persona: StrategyPersona): string {
    const dims = (persona.textDimensions || []).filter((d) => d.group === 'style' && d.value);
    if (dims.length === 0) return '';

    const sections: string[] = ['# 人格设定'];
    for (const dim of dims) {
      sections.push(`## ${dim.label}\n${dim.value}`);
    }
    return sections.join('\n\n');
  }
}
