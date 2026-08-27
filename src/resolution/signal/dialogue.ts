import {
  extractMessageText,
  extractQuotedSpeakers as extractQuotedSpeakersFromText,
  stripQuotedBlocks,
  stripTimeContext,
} from './markers';
import type { DialogueTurn } from './types';

/** 从归一化消息（ModelMessage 形态）里抽出全部 user 文本。 */
export function extractUserTexts(messages: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== 'user') continue;
    const text = extractMessageText(record.content);
    if (text.trim().length > 0) texts.push(text);
  }
  return texts;
}

/** 按原始顺序抽出 user/assistant 双角色文本（确认问答对识别需要 assistant 上下文）。 */
export function extractDialogueTurns(messages: readonly unknown[]): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== 'user' && record.role !== 'assistant') continue;
    const text = extractMessageText(record.content);
    if (text.trim().length > 0) turns.push({ role: record.role, text });
  }
  return turns;
}

/** 剥掉引用块，只留候选人自己敲的文字（留空格占位以维持词边界）。 */
export function stripQuoteBlocks(text: string): string {
  return stripQuotedBlocks(text, ' ');
}

/** 候选人消息里全部引用前缀的发言人（被引用方显示名，多为招募经理）。 */
export function extractQuotedSpeakers(messages: readonly unknown[]): string[] {
  const speakers = new Set<string>();
  for (const text of extractUserTexts(messages)) {
    for (const speaker of extractQuotedSpeakersFromText(text)) speakers.add(speaker);
  }
  return [...speakers];
}

/** 剥时间后缀 + 引用块后，去掉空白与常见标点，用于短答复整句匹配。 */
export function normalizeShortAnswer(text: string): string {
  return stripQuoteBlocks(stripTimeContext(text)).replace(/[\s，。！？!?~～、.…；;：:]/gu, '');
}

/**
 * 肯定应答词表——**全库唯一居所**（§7：四份肯定词表分叉收拢至此，禁止另立副本）。
 *
 * 收词纪律（§11 词表禁判语义的边界）：只收**教科书短答**——整句就是一个肯定表态、
 * 脱离上下文也不会有第二种读法的说法。口语长尾（"刚拿到手""健康正式"这类需要理解
 * 语境才知道在肯定什么的）一律不进，交主聊模型作证。
 *
 * 2026-08-20 补 `确定`/`好的`/`没问题`（用户裁定"词表收"）：
 * 生产 0819 确认死循环实测语料里，候选人对复述清单回的正是「确定」，而词表当时只有
 * 「确认」——一字之差，85% 走裸字段通道的调用在复述确认这一步整个退化，
 * 再问一遍直到熔断。这三个与已在表里的「确认/对/嗯」是同一类，不是长尾。
 *
 * ⚠️ 本表**只在整句匹配**下使用（调用方须先过 normalizeShortAnswer）：单短答整句
 * （isAffirmativeAnswer，作证通道）或全句由肯定短答拼接（isAffirmativeAnswerSequence，
 * recap 确认通道），从不做子串匹配；且所有消费方都额外要求"我方消息里出现过被确认
 * 的那个值"——单靠一句"好的"不构成任何事实入账。
 * 加词前先问：这个词单独成句时，还有别的读法吗？答得上来就别加。
 */
const AFFIRMATIVE_TOKEN_SOURCE =
  '是|是的|是滴|是啊|是呀|对|对的|对啊|对呀|嗯|嗯嗯|没错|确认|确定|正确|好的|没问题|(?:就?是)?我?的?(?:本名|真名|真实姓名)';

const AFFIRMATIVE_ANSWER_RE = new RegExp(`^(?:${AFFIRMATIVE_TOKEN_SOURCE})$`, 'u');

/** 入参须先过 normalizeShortAnswer。 */
export function isAffirmativeAnswer(shortAnswer: string): boolean {
  return AFFIRMATIVE_ANSWER_RE.test(shortAnswer);
}

/**
 * 复述确认专用扩展词：只进组合通道，不进上方作证词表。
 * 「可以(的)」答复述清单（"以上信息对吗/帮你报名？"）是明确放行，但答身份求证
 * （"你叫张三对吗"）语气含混，作证通道（identity-gates）维持闭集不收。
 *
 * 2026-08-27 扩词（用户裁定）：生产复现「行」不在表里——候选人对复述清单回"行"，
 * recap 确认整轮退化、booking 被凭据闸拒绝（batch …_1787812777667），与 0819「确定」
 * 一字之缺同病。本通道语义是"对提交放行"，收词从宽：整句即放行表态、无第二种读法的
 * 口语/方言/字母变体都进（行/好/中/妥/要得/得嘞/OK…）。疑问与否定形态天然安全：
 * 「行吗」「行不行」「好了」中的 吗/不/了 不是 token，组合切分失败即不命中。
 */
const RECAP_ONLY_TOKEN_SOURCE =
  '可以(?:的|呀|啊|哒)?|阔以|行(?:的|啊|呀|滴|吧)?|好(?:嘞|呀|啊|哒|滴|吧)?|中(?:的)?|妥(?:的|了)?|要得|得嘞|没毛病|无误|都对|嗯呐|嗯哪|[oO][kK](?:[aA][yY])?|(?:报名?|提交|约)吧';

/** 组合式肯定长度上限：真实复述确认短答远短于此；同时封死歧义切分（嗯嗯…嗯X 型）的回溯放大。 */
const AFFIRMATIVE_SEQUENCE_MAX_LENGTH = 20;

const AFFIRMATIVE_SEQUENCE_RE = new RegExp(
  `^(?:${AFFIRMATIVE_TOKEN_SOURCE}|${RECAP_ONLY_TOKEN_SOURCE})+$`,
  'u',
);

/**
 * 组合式肯定：整句去标点后必须能**完整**切分为若干肯定短答的拼接
 * （「对的，没问题」「嗯嗯可以」「是的没错」）。掺入任何非肯定内容——否定/转折
 * （"对的但是电话错了"）、追问（"可以问一下""对吗"）——都会切分失败而整体不命中，
 * 由此不需要另立否定词表；否定混排应继续走 correct 纠错路径。
 *
 * 2026-08-26 起为收资复述确认（recap）消费：候选人对复述清单回组合式确认时
 * 卡在 confirm_collection 多绕一轮，发生在临门一脚。身份作证通道继续用
 * isAffirmativeAnswer 单短答整句匹配，作证语义从紧不随本通道扩散。
 * 入参须先过 normalizeShortAnswer。
 */
export function isAffirmativeAnswerSequence(shortAnswer: string): boolean {
  if (shortAnswer.length === 0 || shortAnswer.length > AFFIRMATIVE_SEQUENCE_MAX_LENGTH) {
    return false;
  }
  return AFFIRMATIVE_SEQUENCE_RE.test(shortAnswer);
}
