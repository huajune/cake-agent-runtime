/**
 * 岗位硬性筛选条件构造 + booking API payload guide。
 *
 * 从 duliday-interview-precheck.tool.ts 拆出（Phase 1.A 机械搬运，0 逻辑改动）：
 * - buildScreeningCriteria：从 JobPolicyAnalysis 提取岗位硬约束（gender/age/edu/healthCert/student/...），
 *   只保留有值的字段
 * - buildApiPayloadGuide：组装 booking 工具入参契约（必填/可选字段、enum 映射、固定值）
 */

import {
  SPONGE_COLLECTABLE_EDUCATION_MAPPING,
  SPONGE_GENDER_MAPPING,
  SPONGE_HEALTH_CERTIFICATE_MAPPING,
  SPONGE_HEALTH_CERTIFICATE_TYPE_MAPPING,
  SPONGE_OPERATE_TYPE_AI_IMPORT,
  SPONGE_OPERATE_TYPE_MAPPING,
  SPONGE_PROVINCE_MAPPING,
} from '@sponge/sponge.enums';
import {
  API_BOOKING_OPTIONAL_PAYLOAD_FIELDS,
  API_BOOKING_REQUIRED_PAYLOAD_FIELDS,
} from '@tools/duliday/booking/job-booking.contract';
import { type JobPolicyAnalysis } from '@tools/utils/job-policy-parser';
import {
  formatConstraintText,
  isUnrestrictedGenderRequirement,
} from '@tools/duliday/precheck/field-normalize.util';

/**
 * 从岗位分析结果构造岗位硬性筛选条件，只保留有值的字段。
 */
export function buildScreeningCriteria(analysis: JobPolicyAnalysis): Record<string, string> {
  const req = analysis.normalizedRequirements;
  const result: Record<string, string> = {};
  const getNonSupplementSignal = (field: string) =>
    analysis.fieldGuidance.fieldSignals.find(
      (signal) => signal.field === field && signal.sourceField !== 'interview_supplement',
    );

  if (!isUnrestrictedGenderRequirement(req.genderRequirement)) {
    result.gender = formatConstraintText(req.genderRequirement) ?? req.genderRequirement;
  }
  if (req.ageRequirement && req.ageRequirement !== '不限') {
    result.age = formatConstraintText(req.ageRequirement) ?? req.ageRequirement;
  }
  if (req.educationRequirement && req.educationRequirement !== '不限') {
    result.education = formatConstraintText(req.educationRequirement) ?? req.educationRequirement;
  }
  if (req.healthCertificateRequirement && req.healthCertificateRequirement !== '未明确要求') {
    result.healthCertificate =
      formatConstraintText(req.healthCertificateRequirement) ?? req.healthCertificateRequirement;
  }

  const studentSignal = getNonSupplementSignal('是否学生');
  if (studentSignal?.evidence) {
    result.isStudent = formatConstraintText(studentSignal.evidence) ?? studentSignal.evidence;
  }

  const experienceSignal = getNonSupplementSignal('过往公司+岗位+年限');
  if (experienceSignal?.evidence) {
    result.experience =
      formatConstraintText(experienceSignal.evidence) ?? experienceSignal.evidence;
  }

  const householdSignal = getNonSupplementSignal('户籍省份');
  if (householdSignal?.evidence) {
    result.householdRegisterProvince =
      formatConstraintText(householdSignal.evidence) ?? householdSignal.evidence;
  }

  const heightSignal = getNonSupplementSignal('身高');
  if (heightSignal?.evidence) {
    result.height = formatConstraintText(heightSignal.evidence) ?? heightSignal.evidence;
  }

  const weightSignal = getNonSupplementSignal('体重');
  if (weightSignal?.evidence) {
    result.weight = formatConstraintText(weightSignal.evidence) ?? weightSignal.evidence;
  }

  const resumeSignal = getNonSupplementSignal('简历附件');
  if (resumeSignal?.evidence) {
    result.resume = formatConstraintText(resumeSignal.evidence) ?? resumeSignal.evidence;
  }

  if (req.remark) result.remark = formatConstraintText(req.remark) ?? req.remark;
  if (req.interviewRemark) {
    result.interviewRemark = formatConstraintText(req.interviewRemark) ?? req.interviewRemark;
  }

  return result;
}

export function buildApiPayloadGuide(
  jobId: number,
  customerLabelDefinitions: Array<{ labelId: number; labelName: string; name: string }>,
  options?: {
    /** 无面试时段（等通知）岗位：interviewTime 不进必填清单，booking 不传该字段 */
    interviewTimeWaitNotice?: boolean;
  },
) {
  return {
    requiredFields: options?.interviewTimeWaitNotice
      ? API_BOOKING_REQUIRED_PAYLOAD_FIELDS.filter((field) => field !== 'interviewTime')
      : [...API_BOOKING_REQUIRED_PAYLOAD_FIELDS],
    optionalFields: [...API_BOOKING_OPTIONAL_PAYLOAD_FIELDS],
    fixedValues: {
      jobId,
      operateType: SPONGE_OPERATE_TYPE_AI_IMPORT,
    },
    customerLabelDefinitions,
    enumMappings: {
      genderId: { ...SPONGE_GENDER_MAPPING },
      hasHealthCertificate: { ...SPONGE_HEALTH_CERTIFICATE_MAPPING },
      healthCertificateTypes: { ...SPONGE_HEALTH_CERTIFICATE_TYPE_MAPPING },
      educationId: { ...SPONGE_COLLECTABLE_EDUCATION_MAPPING },
      householdRegisterProvinceId: { ...SPONGE_PROVINCE_MAPPING },
      operateType: {
        [SPONGE_OPERATE_TYPE_AI_IMPORT]: SPONGE_OPERATE_TYPE_MAPPING[SPONGE_OPERATE_TYPE_AI_IMPORT],
      },
    },
  };
}
