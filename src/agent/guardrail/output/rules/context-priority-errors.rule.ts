import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { type RuleContradiction } from '../output-rule.types';

const FIELD_DETECTORS: Array<{ field: string; provided: RegExp; requested: RegExp }> = [
  {
    field: '姓名',
    provided:
      /(?:姓名|名字)[：:\s]*[\u4e00-\u9fa5]{2,4}|^[\u4e00-\u9fa5]{2,4}[，,\s]+(?:男|女|\d{2})/m,
    requested: /(?:姓名|名字)[：:]?\s*$|(?:发|提供|补充|填写)[^。！？\n]{0,8}(?:姓名|名字)/m,
  },
  {
    field: '电话',
    provided: /1[3-9]\d{9}|(?:电话|手机号|联系方式)[：:\s]*\d{6,}/,
    requested:
      /(?:电话|手机号|联系方式)[：:]?\s*$|(?:发|提供|补充|填写)[^。！？\n]{0,8}(?:电话|手机号|联系方式)/m,
  },
  {
    field: '年龄',
    provided: /(?:年龄)[：:\s]*\d{1,2}|(?:^|[，,\s])\d{1,2}\s*岁/m,
    requested: /年龄[：:]?\s*$|(?:发|提供|补充|填写)[^。！？\n]{0,8}年龄/m,
  },
  {
    field: '性别',
    provided: /(?:性别)[：:\s]*(?:男|女)|(?:^|[，,\s])(?:男|女)(?:[，,\s]|$)/m,
    requested: /性别[：:]?\s*$|(?:发|提供|补充|填写)[^。！？\n]{0,8}性别/m,
  },
  {
    field: '学历',
    provided:
      /(?:学历)[：:\s]*(?:小学|初中|高中|中专|大专|本科|硕士|博士)|(?:小学|初中|高中|中专|大专|本科|硕士|博士)学历?/,
    requested: /学历[：:]?\s*$|(?:发|提供|补充|填写)[^。！？\n]{0,8}学历/m,
  },
  {
    field: '健康证',
    provided:
      /(?:健康证)[：:\s]*(?:有|无|没有|可办|可以办|接受办理)|(?:有|没有|无)[^。！？\n]{0,4}健康证/,
    requested: /健康证(?:情况|类型)?[：:]?\s*$|(?:发|提供|补充|填写)[^。！？\n]{0,8}健康证/m,
  },
  {
    field: '经验',
    provided: /(?:经验|经历|做过|干过|从事过)[：:\s]*[^。！？\n]{2,30}/,
    requested:
      /(?:经验|经历|过往工作经验)[：:]?\s*$|(?:发|提供|补充|填写)[^。！？\n]{0,8}(?:经验|经历)/m,
  },
];

export function detectProvidedBookingFieldsIgnored(
  replyText: string,
  userMessage?: string,
): RuleContradiction | null {
  const source = userMessage ?? '';
  if (!source.trim()) return null;

  const provided = FIELD_DETECTORS.filter(({ provided }) => provided.test(source)).map(
    ({ field }) => field,
  );
  if (provided.length < 3) return null;

  const repeated = FIELD_DETECTORS.filter(
    ({ field, requested }) => provided.includes(field) && requested.test(replyText),
  ).map(({ field }) => field);
  if (repeated.length < 2) return null;

  return {
    ruleId: 'provided_booking_fields_ignored',
    label: `候选人本轮已提供多项报名资料（${provided.join('/')}），但回复仍要求重复填写: ${repeated.join(
      '/',
    )}`,
    action: GUARDRAIL_ACTION.REVISE,
  };
}
