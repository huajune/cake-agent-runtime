/**
 * collect_fields 断路器（core-flow-review 议题 9-2）。
 *
 * 事故形态（badcase chat 6a7e7846ce406a6aeee2e232 / 6a4229f2 案，2026-08-14）：
 * missingFields 集合连续 4 轮不变、模型每轮都把针对这些字段的答案传了进来（三通道全传），
 * 工具仍指示"请向候选人补问"——模型没有诚实出路，最后只能谎称"资料已经齐了，我帮你提交
 * 报名"（将来时逃逸 B-5 完成口径守卫），booking 从未调用。
 *
 * 这是**结构性**缺陷，独立于任何具体词形 bug：键名归一化（议题 9-1）修不完所有未来词形，
 * 只要"模型已作答但工具仍退回去问"这条路存在，下一个词形就会再卡死一次。
 * 本模块给模型两条诚实出口：
 *  A. 答案能归一化对上缺失项 → 按"模型转写、低置信"如实采纳进 checklist，推进 nextAction；
 *  B. 采纳后仍缺、且同一份清单已被反复追问且候选人已作答 → 转人工，禁止再向候选人重复收资。
 */

import { normalizeSupplementKey } from '@tools/duliday/booking/interview-booking-customer-label.builder';

/** 收资模板的固定抬头（buildChecklistTemplate 渲染），assistant 是否在发收资清单的最强信号。 */
const COLLECT_TEMPLATE_HEADER_RE = /先将以下资料补充|资料补充下发给我/u;

export interface CollectFieldAdoption {
  /** checklist 字段名（missingFields 里的原值）。 */
  field: string;
  /** 模型转写的答案原文。 */
  value: string;
  /** 命中的入参键名，供排障回看模型用了哪个词形。 */
  answerKey: string;
}

/**
 * 出口 A：把模型已提交、但因键名对不上而没被消费的答案匹配回缺失字段。
 *
 * 归一化两端后比对（NFKC / 去括号注记 / 剥语气前缀），命中即采纳。
 * 只认非空值；同一字段多个键命中时取第一个（Object.entries 顺序 = 模型给的顺序）。
 */
export function resolveCollectFieldAdoptions(
  missingFields: readonly string[],
  supplementAnswers: Readonly<Record<string, string>> | undefined,
): CollectFieldAdoption[] {
  if (!supplementAnswers || missingFields.length === 0) return [];

  const answerEntries = Object.entries(supplementAnswers)
    .map(([key, rawValue]) => ({
      key,
      normalizedKey: normalizeSupplementKey(key),
      value: typeof rawValue === 'string' ? rawValue.trim() : '',
    }))
    .filter((entry) => entry.value.length > 0);
  if (answerEntries.length === 0) return [];

  const adoptions: CollectFieldAdoption[] = [];
  for (const field of missingFields) {
    const normalizedField = normalizeSupplementKey(field);
    const hit = answerEntries.find((entry) => entry.normalizedKey === normalizedField);
    if (!hit) continue;
    adoptions.push({ field, value: hit.value, answerKey: hit.key });
  }
  return adoptions;
}

export interface CollectAskRounds {
  /** assistant 就这批字段发出收资请求的次数。 */
  askCount: number;
  /** 最近一次收资请求之后候选人是否回过话。 */
  userRepliedAfterLatestAsk: boolean;
}

/**
 * 统计「这批字段已经被追问过几轮」。
 *
 * 与身份追问升级（summarizeIdentityAskRounds）同法：不引入新的会话状态，直接从本轮
 * 可见的对话证据里数——收资模板抬头，或 assistant 消息里点名了任一缺失字段。
 */
export function summarizeCollectAskRounds(
  messages: readonly unknown[],
  missingFields: readonly string[],
): CollectAskRounds {
  let askCount = 0;
  let userRepliedAfterLatestAsk = false;
  const fieldNeedles = buildFieldNeedles(missingFields);

  for (const message of messages) {
    const parsed = readMessageText(message);
    if (!parsed?.text) continue;
    if (parsed.role === 'assistant') {
      if (isCollectAskMessage(parsed.text, fieldNeedles)) {
        askCount += 1;
        userRepliedAfterLatestAsk = false;
      }
      continue;
    }
    if (parsed.role === 'user' && askCount > 0) {
      userRepliedAfterLatestAsk = true;
    }
  }
  return { askCount, userRepliedAfterLatestAsk };
}

/**
 * 出口 B 的判据：采纳之后仍缺字段，且同一份清单已发过 ≥2 次、候选人也已作答。
 *
 * 阈值取 2 与身份追问升级一致：第 3 次再退回"去问候选人"就是本事故的形态。
 */
export function isCollectionStalled(
  remainingMissingFields: readonly string[],
  askRounds: CollectAskRounds,
): boolean {
  return (
    remainingMissingFields.length > 0 &&
    askRounds.askCount >= 2 &&
    askRounds.userRepliedAfterLatestAsk
  );
}

function buildFieldNeedles(missingFields: readonly string[]): string[] {
  const needles = new Set<string>();
  for (const field of missingFields) {
    const trimmed = field.trim();
    if (trimmed.length >= 2) needles.add(trimmed);
    const normalized = normalizeSupplementKey(field);
    if (normalized.length >= 2) needles.add(normalized);
  }
  return [...needles];
}

function isCollectAskMessage(text: string, fieldNeedles: readonly string[]): boolean {
  if (COLLECT_TEMPLATE_HEADER_RE.test(text)) return true;
  return fieldNeedles.some((needle) => text.includes(needle));
}

function readMessageText(message: unknown): { role: string; text: string } | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role : '';
  if (!role) return null;
  return { role, text: flattenContent(record.content) };
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(flattenContent).filter(Boolean).join('\n');
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return '';
}
