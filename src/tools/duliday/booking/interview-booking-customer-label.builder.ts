import {
  type InterviewBookingCustomerLabel,
  SPONGE_CUSTOMER_LABEL_MAX_LENGTH,
} from '@sponge/sponge.types';
import type { SpongeInterviewSupplementDefinition } from '@sponge/sponge-job.util';
import {
  getSpongeEducationLabelById,
  getSpongeGenderLabelById,
  getSpongeHealthCertificateLabelById,
  getSpongeHealthCertificateTypeLabels,
  getSpongeProvinceNameById,
} from '@sponge/sponge.enums';
import type { ToolBuildContext } from '@shared-types/tool.types';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

export interface BuildCustomerLabelListParams {
  supplementDefinitions: SpongeInterviewSupplementDefinition[];
  context: ToolBuildContext;
  name: string;
  phone: string;
  age: number;
  genderId: number;
  /** 面试时间；无面试时段（等通知）岗位缺省，对应标签回填"等待通知" */
  interviewTime?: string;
  householdRegisterProvinceId?: number;
  height?: number;
  weight?: number;
  hasHealthCertificate?: number;
  healthCertificateTypes?: number[];
  educationId?: number;
  uploadResume?: string;
  supplementAnswers?: Record<string, string>;
}

export type BuildCustomerLabelListResult =
  | {
      success: true;
      customerLabelList: InterviewBookingCustomerLabel[];
      customerLabelDefinitions: SpongeInterviewSupplementDefinition[];
    }
  | {
      success: false;
      errorType:
        | typeof TOOL_ERROR_TYPES.BOOKING_MISSING_CUSTOMER_LABEL_VALUES
        | typeof TOOL_ERROR_TYPES.BOOKING_INVALID_CUSTOMER_LABEL_VALUES;
      error: string;
      missingSupplementLabels?: string[];
      invalidSupplementLabels?: string[];
      customerLabelDefinitions: SpongeInterviewSupplementDefinition[];
    };

export function buildCustomerLabelList(
  params: BuildCustomerLabelListParams,
): BuildCustomerLabelListResult {
  const definitions = params.supplementDefinitions;
  if (definitions.length === 0) {
    return {
      success: true,
      customerLabelList: [],
      customerLabelDefinitions: [],
    };
  }

  const customerLabelList: InterviewBookingCustomerLabel[] = [];
  const missingSupplementLabels: string[] = [];
  const invalidSupplementLabels: string[] = [];

  for (const definition of definitions) {
    const value = resolveCustomerLabelValue(definition.labelName, params);
    if (!value) {
      missingSupplementLabels.push(definition.labelName);
      continue;
    }
    if (value.length > SPONGE_CUSTOMER_LABEL_MAX_LENGTH) {
      invalidSupplementLabels.push(definition.labelName);
      continue;
    }

    customerLabelList.push({
      labelId: definition.labelId,
      labelName: definition.labelName,
      name: definition.labelName,
      value,
    });
  }

  if (missingSupplementLabels.length > 0) {
    return {
      success: false,
      errorType: TOOL_ERROR_TYPES.BOOKING_MISSING_CUSTOMER_LABEL_VALUES,
      error: `岗位补充标签缺少取值：${missingSupplementLabels.join('、')}`,
      missingSupplementLabels,
      customerLabelDefinitions: definitions,
    };
  }

  if (invalidSupplementLabels.length > 0) {
    return {
      success: false,
      errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_CUSTOMER_LABEL_VALUES,
      error: `岗位补充标签取值超过 ${SPONGE_CUSTOMER_LABEL_MAX_LENGTH} 字符：${invalidSupplementLabels.join('、')}`,
      invalidSupplementLabels,
      customerLabelDefinitions: definitions,
    };
  }

  return {
    success: true,
    customerLabelList,
    customerLabelDefinitions: definitions,
  };
}

function resolveCustomerLabelValue(
  labelName: string,
  params: BuildCustomerLabelListParams,
): string | null {
  if (/简历/.test(labelName)) return normalizeText(params.uploadResume);

  const directAnswer = getSupplementAnswerValue(params.supplementAnswers, labelName);
  if (directAnswer) return directAnswer;

  if (/学历/.test(labelName)) {
    return params.educationId != null ? getSpongeEducationLabelById(params.educationId) : null;
  }

  if (/(籍贯|户籍)/.test(labelName)) {
    return params.householdRegisterProvinceId != null
      ? getSpongeProvinceNameById(params.householdRegisterProvinceId)
      : null;
  }

  if (/身高/.test(labelName)) return formatNumericValue(params.height);
  if (/体重/.test(labelName)) return formatNumericValue(params.weight);

  if (/健康证类型/.test(labelName)) {
    const labels = getSpongeHealthCertificateTypeLabels(params.healthCertificateTypes);
    return labels.length > 0 ? labels.join('、') : null;
  }

  // 覆盖「健康证情况」「有无健康证」「是否有健康证」「健康证」等常见别名；
  // 只要包含"健康证"三字且不是前面的"健康证类型"，都走 hasHealthCertificate 回填。
  if (/健康证/.test(labelName)) {
    return params.hasHealthCertificate != null
      ? getSpongeHealthCertificateLabelById(params.hasHealthCertificate)
      : null;
  }

  if (/身份/.test(labelName)) {
    return resolveIdentityLabel(params.context);
  }

  if (/姓名/.test(labelName)) return normalizeText(params.name);
  if (/电话|联系方式/.test(labelName)) return normalizeText(params.phone);
  if (/性别/.test(labelName)) return getSpongeGenderLabelById(params.genderId);
  if (/年龄/.test(labelName)) return String(params.age);
  // 等通知岗位 interviewTime 缺省：与平台名单录入表单一致，回填"等待通知"
  if (/面试时间/.test(labelName)) return normalizeText(params.interviewTime) ?? '等待通知';
  return null;
}

function getSupplementAnswerValue(
  supplementAnswers: Record<string, string> | undefined,
  labelName: string,
): string | null {
  if (!supplementAnswers) return null;

  const candidateKeys = [labelName, ...getSupplementAnswerAliases(labelName)];
  for (const key of candidateKeys) {
    const value = normalizeText(supplementAnswers[key]);
    if (value) return value;
  }
  return null;
}

function getSupplementAnswerAliases(labelName: string): string[] {
  if (/(籍贯|户籍)/.test(labelName)) return ['籍贯', '户籍', '户籍省份'];
  if (/身份/.test(labelName)) return ['身份', '是否学生'];
  if (/健康证类型/.test(labelName)) return ['健康证类型'];
  if (/健康证/.test(labelName)) return ['健康证情况', '有无健康证', '是否有健康证', '健康证'];
  return [];
}

function resolveIdentityLabel(context: ToolBuildContext): string | null {
  const interviewInfo = context.sessionFacts?.interview_info;
  if (interviewInfo?.is_student != null) {
    return interviewInfo.is_student ? '学生' : '社会人士';
  }
  if (context.profile?.is_student != null) {
    return context.profile.is_student ? '学生' : '社会人士';
  }
  return null;
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function formatNumericValue(value: number | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}
