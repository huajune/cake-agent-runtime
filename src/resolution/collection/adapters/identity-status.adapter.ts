/**
 * 社会身份槽位（学生 / 社会人士 / 第二职业）写入适配器。
 *
 * 包装 `classifyIdentityAnswerText`——它是身份问答的唯一识别器，处理了生产里那些
 * 难缠的形态：二选一模板未回填（"学生/社会人士"本身不是答案）、短答（"社会"/"工作"）、
 * 布尔序列化（true/False/是/否）。识别逻辑一行不改，只换输出端。
 *
 * 契约实测有两种形态：
 * - 「社会身份」(labelId 1)：三选项（全日制在校学生 / 社会人士 / 第二职业）；
 * - 学生族脏配置：12 个 labelId 语义分裂，标题往往携带筛选指令
 *   （「是否学生（不要学生及暑假工）」），选项形态不定。
 * 故映射按**选项标签语义**匹配而非 optionCode 字面量（D4）：匹配不上就留空追问，
 * 不按位置硬猜。
 */

import { classifyIdentityAnswerText } from '@resolution/candidate/student-identity';
import { findOptionBySemantics } from '../option-matching';
import type { AdapterInput, SlotProposal } from './adapter.types';

export function proposeIdentityStatus(input: AdapterInput): SlotProposal | null {
  const { field, candidateText } = input;
  const identity = classifyIdentityAnswerText(candidateText);
  if (!identity) return null;

  // 学生档要认「全日制在校学生」「学生」「在籍」；社会档要认「社会人士」「社会」。
  // 「第二职业」不由本识别器产出（它是另一个语义），匹配不上即留空追问。
  const matcher =
    identity === '学生'
      ? (label: string) => /学生|在籍|在校/u.test(label) && !/不要|非/u.test(label)
      : (label: string) => /社会人士|社会$/u.test(label);

  const option = findOptionBySemantics(field, matcher);
  if (!option) return null;

  return {
    labelId: field.labelId,
    value: option.optionLabel,
    optionCodes: [option.optionCode],
    sourceText: candidateText.trim(),
    producer: 'candidate_quote',
  };
}
