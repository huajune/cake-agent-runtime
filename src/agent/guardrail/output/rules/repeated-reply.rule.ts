import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { MessageSplitter } from '@channels/wecom/message/utils/message-splitter.util';
import type { RuleContradiction } from '../output-rule.types';

/**
 * 重复输出检测。
 *
 * 业务背景（运营反馈簇）：
 * - recvnVdWUh8E84：对话中途又重复说"你好"，候选人观感像机器人；
 * - recvlmGXDwMZrz：候选人提到已发过的门店，Agent 把整段岗位详情原样再发一遍；
 * - recvlsYa5SSOn9：反复问"你活动区域在哪"，候选人直接评价"像机器人"。
 *
 * 外生信号：短期记忆里本会话已投递的 assistant 消息（OutputGuardrail 读取后传入）。
 * 与 prompt 提醒的区别：这里对齐的是"真实发过什么"，模型忘了历史也拦得住。
 *
 * 分档：
 * - repeated_reply_verbatim（observe）：delivery 同款分段后去空白标点全等；长段在组合器
 *   里确定性删除，不进入模型 repair；
 * - repeated_reply（observe）：bigram 相似度 ≥ 0.85 但非全等。措辞相近可能是合理的
 *   口径复述（同一岗位事实再确认），本层只观察。
 */

const RECENT_WINDOW = 8;
/** 短确认（"好的""收到"）天然会重复，只对足够长的内容判定复读。 */
const MIN_REPEAT_LENGTH = 16;
const SIMILARITY_THRESHOLD = 0.85;
const RESEND_MARKERS = ['再发一遍', '重新发一遍', '再发一次', '重新发我', '重发'] as const;

/** 去空白与常见标点，只留内容字符，避免标点差异躲过全等判定。 */
function normalizeReply(text: string): string {
  return text.replace(/[\s，。！？!?、；;：:~～…\-—"'"'（）()【】\[\]]/g, '').toLowerCase();
}

function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) {
    grams.add(text.slice(i, i + 2));
  }
  return grams;
}

function bigramSimilarity(a: string, b: string): number {
  const gramsA = bigrams(a);
  const gramsB = bigrams(b);
  if (gramsA.size === 0 || gramsB.size === 0) return 0;
  let intersection = 0;
  for (const gram of gramsA) {
    if (gramsB.has(gram)) intersection++;
  }
  return intersection / (gramsA.size + gramsB.size - intersection);
}

export function pruneRepeatedReplySegments(
  text: string,
  recentAssistantTexts: readonly string[] | undefined,
  userMessage: string | undefined,
): { text: string; droppedSegments: string[] } {
  if (
    !recentAssistantTexts?.length ||
    RESEND_MARKERS.some((marker) => userMessage?.includes(marker))
  ) {
    return { text, droppedSegments: [] };
  }

  const deliveredSegments = recentAssistantTexts
    .slice(-RECENT_WINDOW)
    .flatMap((item) => MessageSplitter.split(item))
    .map(normalizeReply)
    .filter((item) => item.length >= MIN_REPEAT_LENGTH);
  const droppedSegments: string[] = [];
  const keptSegments = MessageSplitter.split(text).filter((segment) => {
    const normalized = normalizeReply(segment);
    const repeated =
      normalized.length >= MIN_REPEAT_LENGTH && deliveredSegments.includes(normalized);
    if (repeated) droppedSegments.push(segment);
    return !repeated;
  });

  return {
    text: droppedSegments.length > 0 ? keptSegments.join('\n\n') : text,
    droppedSegments,
  };
}

/**
 * 整段复读检测：当前回复与近 N 条已发 assistant 消息近乎相同。
 */
export function detectRepeatedReply(
  text: string,
  recentAssistantTexts: readonly string[] | undefined,
): RuleContradiction | null {
  if (!recentAssistantTexts?.length) return null;
  const current = normalizeReply(text);
  if (current.length < MIN_REPEAT_LENGTH) return null;

  for (const previous of recentAssistantTexts.slice(-RECENT_WINDOW)) {
    const normalized = normalizeReply(previous);
    if (normalized.length < MIN_REPEAT_LENGTH) continue;
    const similarity = normalized === current ? 1 : bigramSimilarity(current, normalized);
    if (similarity === 1) {
      return {
        ruleId: 'repeated_reply_verbatim',
        label:
          '回复与本会话已发送的消息逐字相同（去空白标点后全等），整段复读像机器人（badcase 6a5df7e7 复读两轮后候选人辱骂流失）',
        action: GUARDRAIL_ACTION.OBSERVE,
      };
    }
    if (similarity >= SIMILARITY_THRESHOLD) {
      return {
        ruleId: 'repeated_reply',
        label: `回复与本会话已发送的消息近乎相同（相似度 ${(similarity * 100).toFixed(0)}%），整段复读像机器人（badcase recvlmGXDwMZrz / recvlsYa5SSOn9）`,
        action: GUARDRAIL_ACTION.OBSERVE,
      };
    }
  }
  return null;
}
