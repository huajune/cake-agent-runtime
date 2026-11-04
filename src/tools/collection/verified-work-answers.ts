// business-rules: SH-03, SH-05
import { createHash } from 'node:crypto';
import {
  isPublicWorkConditionField,
  type BookingCollectionForm,
  type ContractFieldDef,
} from '@resolution/collection';
import type { VerifiedCollectionAnswer } from '@shared-types/turn.types';

export const VERIFIED_WORK_ANSWERS_INSTRUCTION =
  '查其他岗位时，直接用 candidateScheduleCitation.collectionAnswerIds 引用下列已核验答案的 id，不重新抄值或拼接原话。引用只证明候选人确实这样回答，不证明排他性限制：必须结合 labelTitle 和 quote 判断。周末两天都在接受门店排班，只说明周末可在岗，没有说工作日不能上，禁止因此设置 onlyWeekends=true 或 maxDaysPerWeek=2；某门店班次选择也不等于其他班次不能上。只保留候选人明确声明的个人限制。';

/** 复用收资写入公证的结果，不在查岗时重新搬运或拼接候选人原话。 */
export function collectVerifiedWorkAnswers(
  form: BookingCollectionForm,
  contract: readonly ContractFieldDef[],
): VerifiedCollectionAnswer[] {
  if (form.candidateScope === 'additional') return [];
  return contract.flatMap((field) => {
    const slot = form.slots[field.labelId];
    if (
      !isPublicWorkConditionField(field) ||
      !slot ||
      slot.state === 'empty' ||
      !slot.value?.sourceText.trim() ||
      slot.value.producer === 'archive'
    )
      return [];
    const answer = {
      jobId: form.jobId,
      labelId: field.labelId,
      labelTitle: field.labelTitle,
      value: slot.value.value,
      quote: slot.value.sourceText,
    };
    return [
      {
        ...answer,
        // 答案或原话变化即换引用；旧引用不能悄悄指向修正后的不同回答。
        // 岗位/字段提供定位，短摘要提供版本；避免模型复制 64 位散列时漏掉中间段。
        id: `${form.jobId}:${field.labelId}:${createHash('sha256').update(JSON.stringify(answer)).digest('hex').slice(0, 12)}`,
      },
    ];
  });
}
