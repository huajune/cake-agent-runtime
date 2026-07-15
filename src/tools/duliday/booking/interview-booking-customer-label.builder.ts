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

  // 候选人常直接回填整张「字段：值」表单。模型偶发会漏传 supplementAnswers，
  // 但原始候选人消息仍是可信的一手数据；从最近消息确定性回填，避免 booking 在
  // precheck 已收齐后又因同一个补充标签缺值而失败。
  const messageAnswer = extractSupplementAnswerFromMessages(
    params.context.messages ?? [],
    labelName,
  );
  if (messageAnswer) return messageAnswer;

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

export function getSupplementAnswerValue(
  supplementAnswers: Record<string, string> | undefined,
  labelName: string,
): string | null {
  if (!supplementAnswers) return null;

  const candidateKeys = [labelName, ...getSupplementAnswerAliases(labelName)];
  const normalizedCandidateKeys = new Set(candidateKeys.map(normalizeSupplementKey));
  for (const [key, rawValue] of Object.entries(supplementAnswers)) {
    if (!normalizedCandidateKeys.has(normalizeSupplementKey(key))) continue;
    const value = normalizeText(rawValue);
    if (value) return value;
  }
  return null;
}

/**
 * 从候选人最近填写的结构化表单中读取岗位补充字段。
 *
 * 仅接受 user 消息中独占一行的「字段名：非空值」，不从自然语言推断，也不读取
 * assistant 消息，防止把系统发出的空模板或岗位要求误当成候选人答案。
 */
export function extractSupplementAnswerFromMessages(
  messages: readonly unknown[] | undefined,
  labelName: string,
): string | null {
  const recentUserMessages = (messages ?? []).filter(isUserMessage).slice(-12).reverse();

  for (const message of recentUserMessages) {
    const text = extractMessageContent(message.content);
    if (!text) continue;

    const answers: Record<string, string> = {};
    for (const line of text.split(/\r?\n/u)) {
      const match = line.match(/^\s*([^：:\n]{1,80})\s*[：:]\s*(\S.*?)\s*$/u);
      if (!match) continue;
      answers[match[1]] = match[2];
    }

    const answer = getSupplementAnswerValue(answers, labelName);
    if (answer) return answer;
  }

  return null;
}

function getSupplementAnswerAliases(labelName: string): string[] {
  if (/出生日期|出生年月|生日/.test(labelName))
    return ['出生日期', '出生年月日', '出生年月', '生日'];
  if (/(籍贯|户籍)/.test(labelName)) return ['籍贯', '户籍', '户籍省份'];
  if (/身份/.test(labelName)) return ['身份', '是否学生'];
  if (/健康证类型/.test(labelName)) return ['健康证类型'];
  if (/健康证/.test(labelName)) return ['健康证情况', '有无健康证', '是否有健康证', '健康证'];
  // 工作经历类标签：岗位后台 labelName 常配成"近一段工作经历"，但 precheck 把它归一成
  // checklist 显示名"过往公司+岗位+年限"，Agent 也按显示名回答。两端名字不同会导致
  // getSupplementAnswerValue 取不到答案、字段一直留在 missingFields、卡死 collect_fields
  // （badcase chat 6a2fac72…）。这里把同一族的所有写法互相打通。
  if (/(工作经历|工作经验|过往公司|过往经历|近一段|年限)/.test(labelName)) {
    return ['过往公司+岗位+年限', '工作经历', '工作经验', '近一段工作经历', '过往经历'];
  }
  return [];
}

function normalizeSupplementKey(value: string): string {
  return value.replace(/\s+/gu, '').trim();
}

function isUserMessage(message: unknown): message is Record<string, unknown> {
  return Boolean(
    message && typeof message === 'object' && (message as Record<string, unknown>).role === 'user',
  );
}

function extractMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(extractMessageContent).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return '';
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
