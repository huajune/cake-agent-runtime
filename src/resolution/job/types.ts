import { z } from 'zod';
import { WELFARE_KINDS } from '@shared-types/welfare.types';

/** 候选岗位池摘要中的福利档位。 */
export const RecommendedJobWelfareKindSchema = z.enum(WELFARE_KINDS);

export type RecommendedJobWelfareKind = z.infer<typeof RecommendedJobWelfareKindSchema>;

/**
 * 精简岗位记忆中的福利事实。
 *
 * 不保存保险：保险/社保属于敏感口径，避免它进入每轮 prompt 后被模型主动包装成普通福利。
 * meals/accommodation 保留明确的“无/未明确”，用于阻止模型在后续追问中把缺失事实脑补成有。
 */
export interface RecommendedJobWelfareFacts {
  meals: RecommendedJobWelfareKind;
  accommodation: RecommendedJobWelfareKind;
  hasTrafficAllowance: boolean;
  hasPromotionWelfare: boolean;
  otherWelfareItems: string[];
}

export const RecommendedJobWelfareFactsSchema = z.object({
  meals: RecommendedJobWelfareKindSchema,
  accommodation: RecommendedJobWelfareKindSchema,
  hasTrafficAllowance: z.boolean(),
  hasPromotionWelfare: z.boolean(),
  otherWelfareItems: z.array(z.string()),
});

/** 候选岗位池摘要 — 复用 jobId 和补充查询。 */
export interface RecommendedJobSummary {
  jobId: number;
  brandName: string | null;
  jobName: string | null;
  storeName: string | null;
  storeAddress?: string | null;
  cityName: string | null;
  regionName: string | null;
  laborForm: string | null;
  /** 兼职类型（laborForm=兼职 时的细分：寒假工/暑假工/小时工）。可选：历史存量记录无此字段。 */
  partTimeJobType?: string | null;
  salaryDesc: string | null;
  /**
   * 结算摘要（正式/培训等多方案分别保留）。可选：历史存量记录无此字段。
   * 不能用综合薪资的“元/月”替代结算周期。
   */
  settlementSummary?: string | null;
  /** 班次摘要（由 composeShiftTimeText 生成）。null 表示工具调用时未获取到班次数据。 */
  shiftSummary?: string | null;
  jobCategoryName: string | null;
  ageRequirement?: string | null;
  educationRequirement?: string | null;
  healthCertificateRequirement?: string | null;
  studentRequirement?: string | null;
  distanceKm?: number | null;
  /** 工具查询时已获取的福利事实。可选：历史存量记录或未请求福利时无此字段。 */
  welfareFacts?: RecommendedJobWelfareFacts | null;
}

export const RecommendedJobSummarySchema = z.object({
  jobId: z.number().int(),
  brandName: z.string().nullable(),
  jobName: z.string().nullable(),
  storeName: z.string().nullable(),
  storeAddress: z.string().nullable().optional(),
  cityName: z.string().nullable(),
  regionName: z.string().nullable(),
  laborForm: z.string().nullable(),
  partTimeJobType: z.string().nullable().optional(),
  salaryDesc: z.string().nullable(),
  settlementSummary: z.string().nullable().optional(),
  shiftSummary: z.string().nullable().optional(),
  jobCategoryName: z.string().nullable(),
  ageRequirement: z.string().nullable().optional(),
  educationRequirement: z.string().nullable().optional(),
  healthCertificateRequirement: z.string().nullable().optional(),
  studentRequirement: z.string().nullable().optional(),
  distanceKm: z.number().nullable().optional(),
  welfareFacts: RecommendedJobWelfareFactsSchema.nullable().optional(),
});
