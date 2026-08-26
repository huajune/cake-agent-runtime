/**
 * 报名筛选标签契约 v2 —— **收资判决的唯一判据源**。
 *
 * 接口：`POST /ai/api/jobs/interview-labels/batch-query`
 *
 * 判决单源纪律（蓝图 §5）：收什么、必不必填、选项筛、值域筛全部由本契约承载；
 * 岗位详情接口回归展示域。**契约没带的判据 = 该岗没有这道筛**——不读岗位数据补筛、
 * 不走岗位自由文本解析兜底。⚠️ 这条"没带=无此筛"只适用于**字段级缺失**；整岗
 * 返回空标签是数据异常，见 `isEmptyLabelAnomaly`。
 *
 * 后端契约要求标签字段保持完整；整岗返回空标签按数据异常处理。
 */

import { z } from 'zod';

/** 后端契约支持的字段类型。 */
export const CONTRACT_FIELD_TYPES = ['TEXT', 'SINGLE_OPTION', 'MULTIPLE_OPTION', 'FILE'] as const;
export const ContractFieldTypeSchema = z.enum(CONTRACT_FIELD_TYPES);

/**
 * 披露级别。
 *
 * `RESTRICTED` = 该字段的不合格原因**绝不能**告诉候选人。AI 侧的披露兜底注册表
 * 与契约标记并行，防止新建敏感标签漏标
 * （`resolution/collection/disclosure-policy.ts`，红线压过契约的 PLAIN）。
 */
export const CONTRACT_DISCLOSURE_LEVELS = ['PLAIN', 'RESTRICTED'] as const;
export const ContractDisclosureSchema = z.enum(CONTRACT_DISCLOSURE_LEVELS);

export const ContractOptionSchema = z.object({
  optionCode: z.string(),
  optionLabel: z.string(),
});

/**
 * 分性别值域。同一字段对男女给不同区间，
 * 判据选取需要先知道候选人性别——性别未知时该值域**不参与判决**（漏斗优先，多报下游可截）。
 */
export const ContractGenderRangeSchema = z.object({
  gender: z.enum(['MALE', 'FEMALE']),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
});

/**
 * 值域筛（契约诉求 #5，0820 落地超预期）。
 * 实测三例：年龄[687] min/max/unit=岁；身高[4]/体重[50] 顶层 min/max 为 null、
 * 区间全在 genderRanges 里。故两处都要读，且都可能为空。
 */
export const ContractValueSpecSchema = z.object({
  kind: z.string(),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
  genderRanges: z.array(ContractGenderRangeSchema).default([]),
});

export const ContractFieldSchema = z.object({
  labelId: z.number().int(),
  labelTitle: z.string(),
  labelInstructions: z.string().nullable().optional(),
  fieldType: ContractFieldTypeSchema,
  /** 实测恒返回；缺失时按最保守档 RESTRICTED 兜底（未知不明说）。 */
  disclosure: ContractDisclosureSchema.default('RESTRICTED'),
  /** 实测恒 true（诉求 #1 落地）；缺失按「返回即须收」。 */
  required: z.boolean().default(true),
  valueSpec: ContractValueSpecSchema.nullable().optional(),
  acceptedOptions: z.array(ContractOptionSchema).default([]),
  rejectedOptions: z.array(ContractOptionSchema).default([]),
  // 身份核不走契约语义标记：原诉求 #3（systemField）已于 0826 裁定废弃，身份四槽由
  // AI 侧「环境级 labelId 锚点 + labelTitle 每轮核验」识别（contract-mapping.ts）。
});

export const ContractJobLabelsSchema = z.object({
  jobId: z.number().int(),
  /** 实测 529020 返回空数组——**数据异常**，不是"该岗无筛"，见 isEmptyLabelAnomaly。 */
  labels: z.array(ContractFieldSchema).nullable().default([]),
});

export const CollectionContractResponseSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z.array(ContractJobLabelsSchema).nullable().default([]),
});

export type ContractOption = z.infer<typeof ContractOptionSchema>;
export type ContractGenderRange = z.infer<typeof ContractGenderRangeSchema>;
export type ContractValueSpec = z.infer<typeof ContractValueSpecSchema>;
export type ContractField = z.infer<typeof ContractFieldSchema>;
export type ContractFieldType = (typeof CONTRACT_FIELD_TYPES)[number];
export type ContractDisclosure = (typeof CONTRACT_DISCLOSURE_LEVELS)[number];

/** 单岗契约：字段集 + 该岗是否属于「空标签数据异常」。 */
export interface JobCollectionContract {
  jobId: number;
  fields: ContractField[];
}

/**
 * 空标签岗判据（0820 用户裁定 + 后端确认）。
 *
 * 后端确认：正常在招岗位必有标签，529020 返回空是**数据问题**（排查中）。
 * 因此 AI 侧口径是：空标签 = 数据异常 → 转人工 + 落告警；**禁止**解释成"该岗无筛"
 * 裸放行，也不做兜底续收。判决单源的"没带=无此筛"只适用字段级缺失，
 * 不适用整岗空标签——两者的区别是：前者是后端明确表达"这岗不卡这一项"，
 * 后者是后端什么都没表达。
 */
export function isEmptyLabelAnomaly(contract: JobCollectionContract): boolean {
  return contract.fields.length === 0;
}

/** 空标签异常的统一转人工原因串（表单 escalatedReason 与告警共用同一措辞）。 */
export const EMPTY_CONTRACT_ESCALATION_REASON = 'empty_contract_data_anomaly';
