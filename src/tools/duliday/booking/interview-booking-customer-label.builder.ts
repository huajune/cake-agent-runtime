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
import { classifySupplementLabel } from '@tools/utils/supplement-label-classifier';
import { findLatestExplicitIdentityEvidence } from '@resolution/candidate/student-identity';
import { selectEvidenceDialogueMessages } from '@resolution/signal/corpus';
import { isIdentityStatusSupplementLabel } from '@tools/duliday/precheck/supplement-overlap.util';

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
  // screening 标签是岗位约束，由 precheck / booking guards 判定是否通过；
  // 它们不是候选人资料字段，不应进 customerLabelList，更不应反向要求填“不要学生”。
  // 与 precheck 共用同一分类器，避免“预检已过、booking 又报缺值”的契约分叉。
  const definitions = params.supplementDefinitions.filter(
    (definition) =>
      classifySupplementLabel(definition.labelName).type === 'collect' ||
      // “是否有健康证”这类标准资料标签形式上也是二元问句，但已能从
      // booking 标准入参确定性回填，必须保留；只跳过真正无客户值的筛选约束。
      resolveCustomerLabelValue(definition.labelName, params) !== null,
  );
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
  const evidenceMessages = params.context.turnInput.corpusBlocks
    ? selectEvidenceDialogueMessages(params.context.turnInput.corpusBlocks)
    : (params.context.turnInput.messages ?? []);
  if (/简历/.test(labelName)) return normalizeText(params.uploadResume);

  const directAnswer = getSupplementAnswerValue(params.supplementAnswers, labelName);
  if (directAnswer) return directAnswer;

  // 候选人常直接回填整张「字段：值」表单。模型偶发会漏传 supplementAnswers，
  // 但原始候选人消息仍是可信的一手数据；从最近消息确定性回填，避免 booking 在
  // precheck 已收齐后又因同一个补充标签缺值而失败。
  const messageAnswer = extractSupplementAnswerFromMessages(evidenceMessages, labelName);
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

  if (isIdentityStatusSupplementLabel(labelName)) {
    // 与 precheck 的重叠表同源：只复制候选人的身份回答原文，不把“学生/社会人士”
    // 语义换算成“在籍/不在籍”。模型漏传 supplementAnswers 时仍能确定性兜底。
    return findLatestExplicitIdentityEvidence(evidenceMessages)?.evidence ?? null;
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
 * 接受两种回填形态，都只读 user 消息、都要求**字段名命中 checklist label 或其别名**——
 * 不从自然语言推断，也不读 assistant 消息，防止把系统发出的空模板或岗位要求误当成答案：
 *  1. 独占一行的「字段名：非空值」（模板逐行回填）；
 *  2. 顿号/逗号切段的一行流「字段名[：]值」（移动端粘贴常见形态，议题 9-3）。
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

    const answer =
      getSupplementAnswerValue(answers, labelName) ?? extractInlineFormAnswer(text, labelName);
    if (answer) return answer;
  }

  return null;
}

/** 一行流表单的切段符：顿号 / 中英文逗号 / 分号。 */
const INLINE_FORM_SEGMENT_RE = /[、，,；;]+/u;

/**
 * 一行流表单解析（议题 9-3）。
 *
 * 候选人常把模板压成一行回填（"身高153、体重130、健康证情况（有/无）无"），逐行解析
 * 一个字段都读不出来——badcase chat 6a7e7846 里 04:03 那条一行流表单给全了资料，
 * 四轮 precheck 仍报同样四个字段缺失。
 *
 * 安全边界与逐行解析一致：只读 user 消息（调用方保证）、字段名必须归一化命中 label 或
 * 其别名才采纳；数值型字段允许省略冒号（"身高153"），非数值必须带冒号，避免把
 * "健康证要求" 这类岗位要求文本吸成答案。
 */
function extractInlineFormAnswer(text: string, labelName: string): string | null {
  const candidateKeys = [labelName, ...getSupplementAnswerAliases(labelName)];
  const normalizedCandidateKeys = new Set(candidateKeys.map(normalizeSupplementKey));

  for (const rawSegment of text.split(INLINE_FORM_SEGMENT_RE)) {
    // 段内先做与 key 同一套归一化（NFKC / 去空白 / 去括号注记 / 剥语气前缀），
    // 这样 `健康证情况（有/无）无`、`有无本地健康证无`、`身高153` 都能与 label 前缀对齐。
    const segment = normalizeSupplementKey(rawSegment);
    if (!segment) continue;

    for (const key of normalizedCandidateKeys) {
      // 单字 key 会把任意句子吸成答案；与品牌脏别名同类风险，直接排除。
      if (key.length < 2 || !segment.startsWith(key)) continue;
      const value = normalizeText(segment.slice(key.length).replace(/^[：:＝=]+/u, ''));
      // 值必须存在且短——一行流表单的字段值是「153」「无」「无经验」这类，
      // 长文本说明这不是表单段而是自然语言句子，不采纳。
      if (value && value.length <= INLINE_FORM_VALUE_MAX_CHARS) return value;
    }
  }

  return null;
}

/** 一行流字段值长度上限；超过即判定为自然语言而非表单回填。 */
const INLINE_FORM_VALUE_MAX_CHARS = 20;

/**
 * 真正的语义别名兜底（同一字段的不同说法，归一化对不上的那些）。
 *
 * 归一化匹配（normalizeSupplementKey）是主路径；这里只保留归一后仍不相等的语义别名
 * （籍贯/户籍、健康证情况族、工作经历族等）。新加词形前先确认归一化确实覆盖不了——
 * 补丁式别名表是本类死循环的历史成因。
 */
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

/** 括号注记：`（有/无）`、`(cm)`、`【选填】` 等——是展示装饰，不参与键名判定。 */
const SUPPLEMENT_ANNOTATION_RE = /[（(【[][^）)】\]]*[)）】\]]/gu;

/**
 * 键名前缀语气词。岗位后台配的是"需要中餐厅服务员经验"，模型问候选人时会自然改写成
 * "有无中餐厅服务员经验"——两端指的是同一个字段。只剥一层，避免"是否需要 X" 被剥空。
 */
const SUPPLEMENT_MODAL_PREFIX_RE = /^(?:是否有|是否|有无|是不是|需要|要求|能否|可否|请填写|填写)/u;

/**
 * 补充标签键名归一（判定用，非展示用）。
 *
 * NFKC 折叠 + 去空白 + 去括号注记 + 剥一层语气前缀。
 *
 * 病根（badcase chat 6a7e7846，2026-08-14）：此前只去空白做全等比对，于是
 * 「模型按自己问出口的名字回填」与「后台配的名字」永远对不上——
 * supplementAnswers 键 "有无中餐厅服务员经验" 命不中 label "需要中餐厅服务员经验"，
 * 字段永远留在 missingFields，precheck 每轮都指示"请向候选人补问"，候选人答了 3 遍
 * 之后模型只能谎称"资料已经齐了，我帮你提交报名"（booking 从未调用）。
 * 手工别名表按族维护是补丁式的：每出现一个新词形就再卡死一次（6a2fac72 工作经历族
 * 是同一个 bug 的上一例）。归一化匹配替代它成为主路径，别名表退为真正的语义别名兜底。
 */
export function normalizeSupplementKey(value: string): string {
  const folded = value.normalize('NFKC').replace(/\s+/gu, '').trim();
  const withoutAnnotations = folded.replace(SUPPLEMENT_ANNOTATION_RE, '');
  const stripped = withoutAnnotations.replace(SUPPLEMENT_MODAL_PREFIX_RE, '');
  // 剥空说明整个键名就是语气词（"是否"/"有无"），退回上一层保留可比对形态。
  return stripped || withoutAnnotations || folded;
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
  const interviewInfo = context.archive.sessionFacts?.interview_info;
  if (interviewInfo?.is_student != null) {
    return interviewInfo.is_student ? '学生' : '社会人士';
  }
  if (context.archive.profile?.is_student != null) {
    return context.archive.profile.is_student ? '学生' : '社会人士';
  }
  return null;
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function formatNumericValue(value: number | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}
