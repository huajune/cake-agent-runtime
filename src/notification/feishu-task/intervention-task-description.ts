import { formatLocalMinute } from '@infra/utils/date.util';
import type { InterventionTaskCategory } from './intervention-task-category';

/**
 * 任务描述组装与脱敏（PRD R6「个人信息」）：
 * - 固定段优先，对话逐条截 150 字、从最新往回填，总长 ≤ 2800；
 * - 过滤身份证号、银行卡号、第三方手机号；
 * - T7 及含残障 / 健康 / 工伤内容的任务不贴对话原文，只写「详见企微会话」。
 */

export const DESCRIPTION_MAX_LENGTH = 2800;
export const MESSAGE_SNIPPET_MAX_LENGTH = 150;

export interface DescriptionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface DescriptionInput {
  category: InterventionTaskCategory;
  categoryLabel: string;
  reasonCodeLabel: string;
  reason: string;
  actionAdvice?: string | null;
  missingJobInfo?: string[] | null;
  workOrderId?: number | string | null;
  jobId?: number | string | null;
  brandStore?: string | null;
  interviewTimeText?: string | null;
  lastCandidateMessage?: string | null;
  recentMessages: DescriptionMessage[];
  chatId: string;
  hostingAccountName?: string | null;
  /** 候选人本人手机号：脱敏时保留，其余 11 位手机号视为第三方。 */
  candidatePhone?: string | null;
  triggeredAt: Date;
}

/** 18 位（含末位 X）或 15 位身份证号。 */
const ID_CARD_PATTERN =
  /(?<!\d)(?:\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]|\d{6}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3})(?!\d)/g;
const BANK_CARD_PATTERN = /(?<!\d)\d{16,19}(?!\d)/g;
const MOBILE_PATTERN = /(?<!\d)1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g;

/**
 * 敏感话题关键词：命中即不贴对话原文。
 * 「健康证」是本业务高频词（岗位要求），不算健康状况内容，扫描前先剔除。
 */
const SENSITIVE_TOPIC_PATTERN =
  /残障|残疾|听障|视障|聋|哑|智力障碍|精神病|抑郁|癫痫|工伤|怀孕|孕妇|传染|乙肝|艾滋|健康状况|身体不好|生病|住院|手术|残联/;

export function redactSensitiveNumbers(text: string, candidatePhone?: string | null): string {
  if (!text) return text;
  const ownPhone = normalizeDigits(candidatePhone ?? '');
  return text
    .replace(ID_CARD_PATTERN, '[身份证号已隐藏]')
    .replace(BANK_CARD_PATTERN, '[银行卡号已隐藏]')
    .replace(MOBILE_PATTERN, (match) =>
      ownPhone && normalizeDigits(match) === ownPhone ? match : '[第三方手机号已隐藏]',
    );
}

export function containsSensitiveTopic(text: string): boolean {
  return SENSITIVE_TOPIC_PATTERN.test(text.replace(/健康证/g, ''));
}

export function shouldOmitTranscript(
  input: Pick<DescriptionInput, 'category'> & {
    texts: Array<string | null | undefined>;
  },
): boolean {
  if (input.category === 'T7') return true;
  return input.texts.some((text) => (text ? containsSensitiveTopic(text) : false));
}

export function truncateText(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

export function buildTaskDescription(input: DescriptionInput): string {
  const redact = (text: string) => redactSensitiveNumbers(text, input.candidatePhone);
  const omitTranscript = shouldOmitTranscript({
    category: input.category,
    texts: [
      input.reason,
      input.lastCandidateMessage,
      ...input.recentMessages.map((message) => message.content),
    ],
  });

  const fixedLines: string[] = [`【原因】${redact(truncateText(input.reason || '-', 300))}`];
  if (input.actionAdvice?.trim()) {
    fixedLines.push(`【建议动作】${redact(truncateText(input.actionAdvice, 300))}`);
  }
  const missing = (input.missingJobInfo ?? []).map((item) => item.trim()).filter(Boolean);
  if (missing.length > 0) fixedLines.push(`【缺失字段】${missing.join('、')}`);
  fixedLines.push(`【大类/原因码】${input.categoryLabel} / ${input.reasonCodeLabel}`);
  fixedLines.push(
    input.workOrderId != null && String(input.workOrderId).trim()
      ? `【工单】${input.workOrderId}`
      : '【工单】系统无工单记录',
  );
  const jobParts = [input.brandStore, input.jobId != null ? `jobId ${input.jobId}` : null].filter(
    (part): part is string => Boolean(part),
  );
  if (jobParts.length > 0) fixedLines.push(`【岗位】${jobParts.join(' · ')}`);
  if (input.interviewTimeText) fixedLines.push(`【面试时间】${input.interviewTimeText}`);
  fixedLines.push(`【介入触发时间】${formatLocalMinute(input.triggeredAt)}`);
  if (input.hostingAccountName) fixedLines.push(`【托管账号】${input.hostingAccountName}`);
  fixedLines.push(`【会话ID】${input.chatId}`);
  if (omitTranscript) {
    fixedLines.push('【候选人最后一句】涉及敏感内容，详见企微会话');
  } else if (input.lastCandidateMessage?.trim()) {
    fixedLines.push(
      `【候选人最后一句】${redact(truncateText(input.lastCandidateMessage, MESSAGE_SNIPPET_MAX_LENGTH))}`,
    );
  }

  const fixed = fixedLines.join('\n');
  if (omitTranscript) {
    return truncateText(
      `${fixed}\n\n【近期对话】涉及敏感内容不贴原文，详见企微会话`,
      DESCRIPTION_MAX_LENGTH,
    );
  }

  const header = '\n\n【近期对话】\n';
  const budget = DESCRIPTION_MAX_LENGTH - fixed.length - header.length;
  const transcript = fillTranscript(input.recentMessages, budget, redact);
  if (transcript.length === 0) return truncateText(fixed, DESCRIPTION_MAX_LENGTH);
  return `${fixed}${header}${transcript.join('\n')}`;
}

/** 从最新往回填，每条截 150 字；返回按时间正序排列的行。 */
function fillTranscript(
  messages: DescriptionMessage[],
  budget: number,
  redact: (text: string) => string,
): string[] {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const roleLabel = message.role === 'user' ? '候选人' : '招募经理';
    const time = formatClock(message.timestamp);
    const line = `[${time} ${roleLabel}] ${redact(truncateText(message.content, MESSAGE_SNIPPET_MAX_LENGTH))}`;
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (used + cost > budget) break;
    used += cost;
    lines.unshift(line);
  }
  return lines;
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--:--';
  return formatLocalMinute(date).slice(5);
}

function normalizeDigits(text: string): string {
  return text.replace(/\D/g, '');
}
