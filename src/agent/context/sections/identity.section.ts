import { PromptSection, PromptContext } from './section.interface';
import { StrategyPersona } from '@shared-types/strategy-config.types';

/**
 * 身份段落 — 人格设定 + 基础提示词
 *
 * persona 的 textDimensions（style 组）构成沟通风格，
 * 基础提示词（.md）定义角色、工作流程、工具使用等核心指令。
 *
 * 两者拼接为完整的身份定义。
 */
export class IdentitySection implements PromptSection {
  readonly name = 'identity';

  constructor(private readonly basePrompt: string) {}

  build(ctx: PromptContext): string {
    const personaText = this.buildPersonaText(ctx.strategyConfig.persona);
    const parts: string[] = [];
    if (personaText) parts.push(personaText);
    if (this.basePrompt) parts.push(this.basePrompt);
    return parts.join('\n\n');
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
