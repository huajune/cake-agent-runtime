import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { type RuleContradiction } from '../output-rule.types';

const VISUAL_MESSAGE_MARKER_PATTERN =
  /\[(?:图片|表情)(?:\s+messageId=[^\]]+)?\]|\[(?:图片|表情)消息\]/;
const IMAGE_FACT_CLAIM_PATTERN =
  /(?:图片|截图|照片)(?:里|上|中|显示|看起来|内容)|看(?:到|清|不清)[^。！？\n]{0,16}(?:图片|截图|照片|健康证|简历|二维码|岗位|薪资|门店|地址)/;

export function detectImageDescriptionNotSaved(
  text: string,
  toolCalls: AgentToolCall[],
  userMessage?: string,
): RuleContradiction | null {
  const source = userMessage ?? '';
  if (!VISUAL_MESSAGE_MARKER_PATTERN.test(source)) return null;
  if (!IMAGE_FACT_CLAIM_PATTERN.test(text)) return null;
  if (hasSuccessfulImageDescriptionSave(toolCalls)) return null;

  return {
    ruleId: 'image_description_not_saved',
    label:
      '本轮包含图片/表情消息，回复已基于图片内容做判断，但没有成功调用 save_image_description 保存图片描述',
    action: GUARDRAIL_ACTION.REPLAN,
  };
}

function hasSuccessfulImageDescriptionSave(toolCalls: AgentToolCall[]): boolean {
  return toolCalls.some((call) => {
    if (call.toolName !== 'save_image_description') return false;
    const result = call.result;
    if (!result || typeof result !== 'object') return false;
    return (result as Record<string, unknown>).success === true;
  });
}
