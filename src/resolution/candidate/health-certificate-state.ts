import { z } from 'zod';

/** 收资表单与记忆共用的健康证四态；optionCode 始终取实际岗位契约，不在此硬编码。 */
export const HEALTH_CERTIFICATE_LABELS = {
  local_valid: '有本地有效健康证',
  accepts_local_application: '无本地有效健康证，接受办理',
  rejects_local_application: '无本地有效健康证，不接受办理',
  processing: '办理中',
} as const;

export const HEALTH_CERTIFICATE_STATES = [
  HEALTH_CERTIFICATE_LABELS.local_valid,
  HEALTH_CERTIFICATE_LABELS.accepts_local_application,
  HEALTH_CERTIFICATE_LABELS.rejects_local_application,
  HEALTH_CERTIFICATE_LABELS.processing,
] as const;

export type HealthCertificateState = (typeof HEALTH_CERTIFICATE_STATES)[number];
export const HealthCertificateStateSchema = z.enum(HEALTH_CERTIFICATE_STATES);

/** 封闭表单选项及已核查旧值的精确别名；不根据任意自然语言推断资格。 */
const HEALTH_CERTIFICATE_ALIASES: ReadonlyMap<string, HealthCertificateState> = new Map(
  (
    [
      ...HEALTH_CERTIFICATE_STATES.map((value): [string, HealthCertificateState] => [value, value]),
      ['有本地有效', HEALTH_CERTIFICATE_LABELS.local_valid],
      ['无且不接受', HEALTH_CERTIFICATE_LABELS.rejects_local_application],
      ['无且不接受办理', HEALTH_CERTIFICATE_LABELS.rejects_local_application],
      ['无但接受办理健康证', HEALTH_CERTIFICATE_LABELS.accepts_local_application],
      ['无但接受办理', HEALTH_CERTIFICATE_LABELS.accepts_local_application],
      ['无（愿意办理）', HEALTH_CERTIFICATE_LABELS.accepts_local_application],
      ['无（准备面试后办理）', HEALTH_CERTIFICATE_LABELS.accepts_local_application],
      ['可重新办', HEALTH_CERTIFICATE_LABELS.accepts_local_application],
      ['无且不接受办理健康证', HEALTH_CERTIFICATE_LABELS.rejects_local_application],
      ['在办', '办理中'],
      ['还没出来', '办理中'],
      ['无（补办中）', '办理中'],
      ['正在办理', '办理中'],
      ['有（未领证）', '办理中'],
      ['正在办', '办理中'],
      ['体检了，还没出证', '办理中'],
    ] as Array<[string, HealthCertificateState]>
  ).map(([label, state]) => [label.normalize('NFKC'), state]),
);

export function normalizeHealthCertificateState(value: unknown): HealthCertificateState | null {
  // “有/true/电子版/已办”未证明本地有效，“无/过期/异地”未表态办理意愿。
  // 无法归入四个表单选项时保留原始证据，结构化值留空待确认。
  if (typeof value !== 'string') return null;
  return HEALTH_CERTIFICATE_ALIASES.get(value.normalize('NFKC').trim()) ?? null;
}

/** 未知旧值仅令本字段缺席，不使整份会话事实解析失败。 */
export const StoredHealthCertificateStateSchema = z.preprocess(
  normalizeHealthCertificateState,
  HealthCertificateStateSchema.nullable(),
);
