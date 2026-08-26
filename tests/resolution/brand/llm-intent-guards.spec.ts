/**
 * LLM 品牌意图输入闸单元测试（2026-07-27 审计：助手话术回声 + 系统文本回流）。
 */

import { isAssistantEchoUtterance, isSystemTextReflow } from '@resolution/brand/llm-intent-guards';
import { normalizeForBrandMatch } from '@resolution/brand/brand-normalize';

describe('isSystemTextReflow（守卫 repair 反馈回流）', () => {
  it('守卫档案条目前缀 / 守卫反馈措辞命中', () => {
    expect(
      isSystemTextReflow('- [brand_alias_fuzzy_match_ignored] 问题：工具品牌回指为"肯德基"'),
    ).toBe(true);
    expect(isSystemTextReflow('工具实际应用品牌为："麦当劳"')).toBe(false); // 无标签前缀且措辞不同
    expect(isSystemTextReflow('规则ID: brand_name_error')).toBe(true);
  });

  it('正常品牌名与普通句子不误伤', () => {
    expect(isSystemTextReflow('肯德基')).toBe(false);
    expect(isSystemTextReflow('成都你六姐')).toBe(false);
    expect(isSystemTextReflow('M Stand')).toBe(false);
  });
});

describe('isAssistantEchoUtterance（2026-07-24 chat 6a633590 塔可贝尔实证）', () => {
  const assistantSentence = '我看下有家塔可贝尔（中骏广场店）离你大概9公里';
  const normalizedAssistantTexts = [normalizeForBrandMatch(assistantSentence)];

  it('整句形态且逐字出现在助手消息 → 回声', () => {
    expect(
      isAssistantEchoUtterance({
        normalizedBrandField: normalizeForBrandMatch(assistantSentence),
        normalizedMatchedTexts: [normalizeForBrandMatch('塔可贝尔')],
        normalizedAssistantTexts,
      }),
    ).toBe(true);
  });

  it('裸品牌名不拦——指代链接是 LLM 轨本职，Agent 提过该品牌不构成回声', () => {
    expect(
      isAssistantEchoUtterance({
        normalizedBrandField: normalizeForBrandMatch('塔可贝尔'),
        normalizedMatchedTexts: [normalizeForBrandMatch('塔可贝尔')],
        normalizedAssistantTexts,
      }),
    ).toBe(false);
  });

  it('候选人自己的长表达（不在助手消息里）不拦', () => {
    expect(
      isAssistantEchoUtterance({
        normalizedBrandField: normalizeForBrandMatch('我想去塔可贝尔中骏广场店上班'),
        normalizedMatchedTexts: [normalizeForBrandMatch('塔可贝尔')],
        normalizedAssistantTexts,
      }),
    ).toBe(false);
  });
});
