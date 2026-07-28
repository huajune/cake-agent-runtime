import { scanGeoSignalsFromText } from '@resolution/geo';
import { stripQuotedBlocks } from './high-confidence-facts';

/**
 * 确认问答裁决（候选人资料证据化 P1，证据渠道 T1「confirmation」）。
 *
 * 背景（badcase 6a671722 沈阳 / 6a618a6e 上海浦东 / 6a61bb34 佛山）：
 * Agent 问"你是在沈阳市对吧？"、候选人答"好的"——系统自己设计的确认协议，
 * 答案却不构成任何证据：规则/LLM 抽取都只看候选人原文，"好的"两个字里没有
 * 城市名，导致确认后闸门仍拒、被迫再问一遍字面城市。
 *
 * 本模块把「Agent 城市确认句 + 候选人纯肯定应答」识别为候选人亲证（T1）：
 * - 纯确定性：确认句模板 + 肯定词表 + geo 白名单城市提取，零 LLM；
 * - 宁可漏不可错：确认句必须恰好含一个可识别城市、应答必须是纯肯定词——
 *   任一含糊即不产出事实（含糊回答"好的"绑定多城市问句不算确认）；
 * - 确认发问方不限 Agent/真人经理（经理确认同样权威）。
 *
 * 已知边界：
 * - 城市识别依赖 resolution/geo 词典（白名单城市裸名 / 全国"XX市"后缀）；
 *   词典外城市的确认句不产出事实，随 geo 区划库扩容自动变宽；
 * - 只处理"最近一条 assistant 消息是确认句"的紧邻形态——隔了其他话题的
 *   历史确认句不回溯（应答的指向性无法确定性判定）。
 */

/**
 * 城市确认句式："在/是"引导 + 句尾确认疑问词，片段内禁止跨逗号/分句——
 * 防止"之前在上海，现在是在沈阳市这边对吧"把确认关联到前半句的城市。
 * 全局匹配后取最后一段（确认句通常在消息末尾）。
 */
const CITY_CONFIRM_QUESTION_PATTERN =
  /(?:在|是)[^，,、；;？?。！!\n]{0,16}(?:对吧|对吗|是吧|是不是|对不对|吗)[？?]?/g;

/**
 * 纯肯定应答：整条消息（去时间后缀/标点）由 1-2 个肯定词构成。
 * 刻意窄于 isPureAcknowledgment 的应答词表——"在吗/你好/收到/谢谢"不是对
 * 是非问句的肯定，不得确认事实。
 */
const AFFIRMATION_WORD =
  '(?:好的|好呀|好嘞|好滴|好|嗯+呢?|对的|对啊|对呀|对|是的|是啊|是呀|是|没错|可以|行|确定|ok|okk|👌)';
const PURE_AFFIRMATION_PATTERN = new RegExp(
  `^(?:${AFFIRMATION_WORD}[~～。.!！?？，,、\\s]*){1,2}$`,
  'i',
);
const MAX_AFFIRMATION_TEXT_LENGTH = 10;

/** 消息注入的时间后缀（与 MessageParser.injectTimeContext 渲染约定一致）。 */
function stripTimeContext(content: string): string {
  return content
    .replace(/\s*(?:\[|【)消息发送时间[:：][\s\S]*?(?:\]|】|$)/g, '')
    .replace(/\s*(?:\[|【)当前时间[:：][\s\S]*?(?:\]|】|$)/g, '')
    .trim();
}

export interface ConfirmedCityFact {
  /** 确认的城市（geo 词典标准裸名，如"沈阳"）。 */
  city: string;
  /** 确认问句原文片段（截断前），入档 evidence 用。 */
  question: string;
  /** 候选人应答原文。 */
  reply: string;
}

export function isPureAffirmation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_AFFIRMATION_TEXT_LENGTH) return false;
  return PURE_AFFIRMATION_PATTERN.test(trimmed);
}

/**
 * 从会话尾部识别「城市确认句 + 纯肯定应答」对。
 *
 * 形态要求（全部满足才产出）：
 * 1. 尾部连续 user 块的**首条**消息是纯肯定应答（首条才是对上一条 assistant
 *    的直接回应；块内后续消息可能已换话题，不影响确认成立）；
 * 2. 紧邻的上一条 assistant 消息（剥引用块/时间后缀）命中城市确认句式；
 * 3. 确认句文本经 geo 扫描恰好解析出一个城市。
 */
export function resolveConfirmedCityFact(
  messages: ReadonlyArray<{ role: string; content: string }>,
): ConfirmedCityFact | null {
  // 定位尾部 user 块与其首条消息
  let index = messages.length - 1;
  while (index >= 0 && messages[index].role === 'user') index -= 1;
  const firstUserIndex = index + 1;
  if (firstUserIndex >= messages.length) return null;
  const reply = stripTimeContext(messages[firstUserIndex].content);
  if (!isPureAffirmation(reply)) return null;

  // 紧邻的上一条必须是 assistant（中间隔了别的角色/没有上文都不算）
  if (index < 0 || messages[index].role !== 'assistant') return null;
  const assistantText = stripQuotedBlocks(stripTimeContext(messages[index].content));
  if (!assistantText) return null;

  const questionMatches = Array.from(assistantText.matchAll(CITY_CONFIRM_QUESTION_PATTERN));
  const question = questionMatches.at(-1)?.[0];
  if (!question) return null;

  // 城市只从确认片段内提取，且必须唯一——含糊即不产出
  const geoScan = scanGeoSignalsFromText(question);
  const city = geoScan.city?.value?.trim();
  if (!city) return null;
  const distinctCityHits = new Set(
    [geoScan.city?.value, ...geoScan.cityHits.map((hit) => hit.key)].filter(Boolean),
  );
  if (distinctCityHits.size > 1) return null;

  return { city, question, reply };
}
