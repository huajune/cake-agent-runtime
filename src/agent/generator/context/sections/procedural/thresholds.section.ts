// 知识归类：procedural —— 本段把业务阈值转成模型行为约束。
// prompt-rule-ledger: docs/prompt-rule-ledger.md（程序性业务阈值总账）
import { buildTextPromptBlock, type PromptSection } from '../section';
import type { PromptModel } from '../../context.types';
import { Threshold } from '@biz/strategy/types/strategy.types';

/**
 * 业务阈值段落 — 从策略配置读取阈值定义
 *
 * 将阈值规则注入系统提示词，告诉模型有哪些业务约束。
 * 数值型阈值同时由工具层硬过滤，prompt 层作为二次保障。
 */
export class ThresholdsSection implements PromptSection {
  readonly id = 'thresholds';
  readonly domain = 'teaching' as const;
  readonly slot = 'strategy' as const;
  readonly dynamic = true;

  build(model: PromptModel) {
    return buildTextPromptBlock(this, this.buildThresholdsText(model.strategy.thresholds));
  }

  private buildThresholdsText(thresholds?: Threshold[]): string {
    if (!thresholds || thresholds.length === 0) return '';

    const lines = ['# 业务阈值', '', '以下业务约束必须严格遵守：'];
    for (const t of thresholds) {
      const parts: string[] = [`**${t.label}**`];
      if (t.min != null || t.max != null) {
        const range = [
          t.min != null ? `最小 ${t.min}` : null,
          t.max != null ? `最大 ${t.max}` : null,
        ]
          .filter(Boolean)
          .join('，');
        parts.push(`（${range}${t.unit ? ' ' + t.unit : ''}）`);
      }
      if (t.rule) parts.push(`：${t.rule}`);
      lines.push(`- ${parts.join('')}`);
    }
    return lines.join('\n');
  }
}
