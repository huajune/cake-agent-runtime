/**
 * 身份四槽（姓名 / 手机号 / 年龄 / 性别）写入适配器。
 *
 * 槽位识别按契约的 `systemField` 语义标记，**不认 labelId 字面量**（D4，0818 用户裁定）：
 * 769/770/687/771 是生产实测值，只出现在诉求单与测试里作核对基准，不进代码。
 *
 * 本适配器只做「原话 → 值 + 出处」的翻译，四道身份闸门（真名闸 / 手机号出处闸 /
 * 值形状 / 年龄值域）全部在 `proposeValue` 的公证链里执行——闸门只设一处，
 * 避免「一处识别器多处消费」的架空（9fdbf84c）。
 */

import { parseAge } from '@resolution/candidate/age';
import { parseGender } from '@resolution/candidate/gender';
import { parseName } from '@resolution/candidate/name';
import { parsePhone } from '@resolution/candidate/phone';
import { matchOptionInText } from '../option-matching';
import type { AdapterInput, SlotProposal } from './adapter.types';

/** 命中即产提案；`systemField` 不是身份四槽之一时返回 null（交通用道）。 */
export function proposeIdentityCore(input: AdapterInput): SlotProposal | null {
  const { field, candidateText } = input;
  switch (field.systemField) {
    case 'name': {
      const parsed = parseName(candidateText);
      return parsed ? proposal(field.labelId, parsed.value, parsed.excerpt) : null;
    }
    case 'phone': {
      const parsed = parsePhone(candidateText);
      return parsed ? proposal(field.labelId, parsed.value, parsed.excerpt) : null;
    }
    case 'age': {
      const parsed = parseAge(candidateText);
      return parsed ? proposal(field.labelId, String(parsed.value), parsed.excerpt) : null;
    }
    case 'gender':
      return proposeGender(input);
    default:
      return null;
  }
}

/**
 * 性别是身份四槽里唯一的选项型字段（基线实测 SINGLE_OPTION，accepted[男]34 /
 * [男,女]413 / [女]21，rejected 成对出现）。
 *
 * 两条轨都要走：`parseGender` 负责"这句话是不是候选人在自陈性别"（疑问/岗位要求/
 * 第三人称三道子句守卫都在它里面），契约选项负责"这个自陈对应哪个 optionCode"。
 * 只用选项直配会把「岗位要求：仅限男」当候选人自陈——`matchOptionInText` 认不出
 * 招聘要求语境，那是 parseGender 的活。
 */
function proposeGender(input: AdapterInput): SlotProposal | null {
  const { field, candidateText } = input;
  const parsed = parseGender(candidateText);
  if (!parsed) return null;
  // 用解析出的标准值（男/女）去契约选项集里定位 optionCode：语义锚点，非 ID 字面量。
  const matched = matchOptionInText(field, parsed.value);
  if (!matched) return null;
  return {
    ...proposal(field.labelId, parsed.value, parsed.excerpt),
    optionCodes: [matched.option.optionCode],
  };
}

function proposal(labelId: number, value: string, sourceText: string): SlotProposal {
  return { labelId, value, sourceText, producer: 'candidate_quote' };
}
