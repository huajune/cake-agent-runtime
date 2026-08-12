/**
 * 性别表内确认证据（confirmation producer）—— name-confirmation 的性别孪生。
 *
 * 背景（PR #1000 评审 P0-4）：precheck 对 medium/system 来源的性别预填走「表内确认」
 * 协议——templateText 写成「性别：女（如有误请改）」随整张表发出。此前
 * `genderNeedsInlineConfirmation` 的全部清除路径都要求候选人字面重打「男/女」，
 * 「都对的」类肯定应答清不掉 → ready_to_book 永不可达（表内确认死锁）。
 *
 * 本模块识别「Agent 发出带性别预填的表内确认 → 候选人肯定应答」的跨轮问答对：
 * 判据对齐 name/phone 侧确认器（宁可漏不可错）——
 * 1. assistant 消息含「性别：{value}」预填行，且带表内确认标记（如有误请改/对吧/确认）；
 * 2. 其后第一条实质 user 消息是肯定短答（「都对的/没问题/对/是的」），
 *    或后续 user 消息复打了同值性别；
 * 3. 后续 user 消息一旦出现**反值**性别陈述，视为纠正，确认不成立。
 */

import { parseGender } from '@resolution/candidate';
import {
  extractDialogueTurns,
  normalizeShortAnswer,
  stripQuoteBlocks,
} from '@resolution/signal/dialogue';
import { stripTimeContext } from '@resolution/signal/markers';

/** 表内确认场景的肯定短答：比 name 侧 AFFIRMATIVE_ANSWER_RE 多认「都对/没问题/好的」族。 */
const INLINE_CONFIRM_AFFIRMATION_RE =
  /^(?:都?(?:对|是|没错)的?|是的|是滴|是啊|是呀|对的|对啊|对呀|嗯+|好的?|没问题|可以|确认|正确|信息(?:都)?(?:对|没错|无误)的?)$/u;

function buildInlineGenderAskRe(gender: '男' | '女'): RegExp {
  return new RegExp(
    `性别\\s*[：:]?\\s*${gender}[^\\n]{0,16}(?:如有误|有误(?:请|的话)?改|对吧|对吗|对不对|是吧|是吗|确认)`,
    'u',
  );
}

/**
 * 「性别预填表内确认 → 候选人肯定应答/同值复打」是否成立。
 * messages 为完整会话消息（识别器自带清洗）。
 */
export function isGenderConfirmedInline(
  gender: string | null | undefined,
  messages: readonly unknown[],
): boolean {
  if (gender !== '男' && gender !== '女') return false;
  const askRe = buildInlineGenderAskRe(gender);
  const turns = extractDialogueTurns(messages);
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== 'assistant' || !askRe.test(turns[i].text)) continue;
    for (let j = i + 1; j < turns.length; j++) {
      if (turns[j].role !== 'user') continue;
      const text = stripQuoteBlocks(stripTimeContext(turns[j].text, '\n'));
      const restated = parseGender(text);
      if (restated) {
        // 反值复打是纠正而非确认；同值复打按确认处理。
        if (restated.value === gender) return true;
        break;
      }
      if (INLINE_CONFIRM_AFFIRMATION_RE.test(normalizeShortAnswer(text))) return true;
      break; // 只认紧随其后的第一条实质 user 消息，避免远处应答被错误归因
    }
  }
  return false;
}
