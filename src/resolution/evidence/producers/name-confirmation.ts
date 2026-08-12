/**
 * 真名问答证据（confirmation producer）—— city-confirmation 的姓名孪生。
 *
 * 「Agent 索要/复述真名 → 候选人应答」的跨轮问答对，是姓名字段的亲证渠道之一：
 * 本文件只产出证据结论（某个名字被问答确证了吗），动作授权在 ../identity-gates。
 * 语料原语（extractDialogueTurns / 肯定应答词表）在 signal/dialogue，与 city 侧共用底座。
 */

import { isStrictRealChineseName } from '@resolution/candidate';
import { isPlaceholderPhone } from '@resolution/candidate/phone';
import { stripTimeContext } from '@resolution/signal/markers';
import {
  extractDialogueTurns,
  isAffirmativeAnswer,
  normalizeShortAnswer,
  stripQuoteBlocks,
} from '@resolution/signal/dialogue';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 应索要后的无键名表单回复（badcase 6a609570，2026-07-23）：assistant 明确索要姓名
 * （"发下你的姓名、电话和年龄"），候选人裸回"张杰 15800977053 38岁"——没有"姓名："
 * 键也没有"我叫"，parseName 拿不到出处；但"目标姓名 + 11 位手机号同现于对索要的
 * 直接应答"是强证据（昵称党不会连名带手机号一起报）。
 */
export function isNameProvidedAfterAsk(name: string, messages: readonly unknown[]): boolean {
  const target = name?.trim();
  if (!target || target.length < 2) return false;
  const turns = extractDialogueTurns(messages);
  const askRe =
    /(?:发|提供|留|填|报|给)[^，。！？?!；;\n]{0,10}(?:姓名|名字)|(?:姓名|名字)[^，。！？?!；;\n]{0,10}(?:发|提供|留|填|报|给)/u;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== 'assistant' || !askRe.test(turns[i].text)) continue;
    for (let j = i + 1; j < turns.length; j++) {
      if (turns[j].role !== 'user') continue;
      const text = stripQuoteBlocks(stripTimeContext(turns[j].text));
      // 手机号形态收窄（PR #1000 评审 P0-8）：裸 /1\d{10}/ 会把 11111111111 等占位
      // 形态当作"连名带手机号"的强证据。空白折叠会让号码与后续数字粘连
      // （"张杰 15800977053 38岁"），故不加尾边界断言、但号段与占位号照拒。
      const phoneDigits = /1[3-9]\d{9}/.exec(text.replace(/[\s-]/g, ''))?.[0];
      if (text.includes(target) && phoneDigits && !isPlaceholderPhone(phoneDigits)) return true;
      break; // 只认紧随其后的第一条 user 消息
    }
  }
  return false;
}

/**
 * assistant 的**开放式真名索取问句**（"方便问一下你的真实姓名吗"/"门店登记需要本名"）。
 *
 * 与 `countRealNameAsks` 的词表同源但更宽：那边只统计追问次数，这边要作为证据闸门的
 * 锚点，需覆盖"本名/全名/身份证上的姓名"等同义表述。
 */
const REAL_NAME_ASK_RE =
  /(真实姓名|身份证上的(?:本名|姓名)|本名|全名)|(?:问|发|提供|留|填|报|给|确认)[^，。！？?!；;\n]{0,10}(?:姓名|名字)|(?:姓名|名字)[^，。！？?!；;\n]{0,10}(?:发|提供|留|填|报|给)/u;

/** 裸名应答的可选自述前缀（"我叫X"/"就叫X"/"名字是X"）。 */
const BARE_NAME_ANSWER_PREFIX_RE =
  /^(?:我(?:的)?(?:名字|大名)?(?:是|叫)?|就(?:是|叫)|名字(?:是|叫)?|姓名(?:是|叫)?)/u;

/**
 * 不能当姓名的应答词（负向门）。
 *
 * `isStrictRealChineseName` 只校验"2-4 个汉字 + 非占位前缀"，寒暄与推脱词形态上完全
 * 合规——自测实证："稍等"被判合法姓名。索名问句之后的应答尤其高发这类词，故本闸门
 * 必须自带负向表：应答/寒暄、延迟推脱、疑问抗拒三类。
 */
const NON_NAME_REPLY_RE =
  /^(?:好的?|好呀|好嘞|嗯+|可以|行|是的?|对的?|没事|没问题|收到|知道了?|明白了?|了解|谢谢|辛苦了|麻烦了|在的?|在吗|你好|您好|哦+|噢|稍等|等等|等一下|等下|马上|一会|待会|回头|再说|什么|啥|为什么|为啥|干嘛|干什么|不用|不想|不方便|算了|没有|保密|隐私|真名|本名|姓名|名字)$/u;

/**
 * 「Agent 开放式索要真名 → 候选人裸名直答」= 真名亲证。
 *
 * 缺口实证（badcase 2026-08-06，chat 6a7446eb，trace batch_…_1786005914536）：
 * 候选人手打的开场白"我是张丽鑫"命中打招呼语昵称判据（她的微信昵称其实是"AAA春日"，
 * 这里 XX 位恰恰是真名）；Agent 随后问"门店登记需要本名，方便问一下你的真实姓名吗"，
 * 候选人**单独回了一条"张丽鑫"**——已有两个逃生口都够不着：
 * `isNameProvidedAfterAsk` 要求应答里"姓名 + 11 位手机号"同现，
 * `isNameConfirmedInDialogue` 要求问句里已含该名 + 肯定应答。
 * 结果真名被判昵称：sessionFacts.name 全程为 null（7 轮快照实证）、booking 报
 * `suspiciousName: 张丽鑫`、Agent 把同一个问题问了两遍。
 *
 * 判据（三条同时满足，宁可漏不可错）：
 * 1. 存在 assistant 真名索取问句；
 * 2. **紧随其后的第一条** user 消息（剥引用块/时间后缀）整条就是这个名字
 *    （允许"我叫X/就是X"等自述前缀与尾部语气词标点，不允许夹带其它内容）；
 * 3. 该名通过中文真名形态校验。
 *
 * 与"防昵称"初衷不冲突：它要求候选人是在**被明确问真名之后**给出的，昵称党不会在
 * 这个语境下把昵称当本名报——而这恰恰是最自然的一条真名提供路径。
 */
export function resolveNameAnsweredToRealNameAsk(
  messages: readonly unknown[],
): { name: string; quote: string; askQuote: string } | null {
  const turns = extractDialogueTurns(messages);
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== 'assistant' || !REAL_NAME_ASK_RE.test(turns[i].text)) continue;
    for (let j = i + 1; j < turns.length; j++) {
      if (turns[j].role !== 'user') continue;
      const raw = stripQuoteBlocks(stripTimeContext(turns[j].text)).trim();
      const candidate = raw
        .replace(BARE_NAME_ANSWER_PREFIX_RE, '')
        .replace(/[\s，,。.！!？?~～、;；:：]+$/u, '')
        .trim();
      if (candidate && !NON_NAME_REPLY_RE.test(candidate) && isStrictRealChineseName(candidate)) {
        return { name: candidate, quote: raw, askQuote: turns[i].text };
      }
      break; // 只认紧随其后的第一条 user 消息，避免远处无关消息被错误归因
    }
  }
  return null;
}

/** 指定姓名是否由「真名索取问答」确证。 */
export function isNameAnsweredToRealNameAsk(name: string, messages: readonly unknown[]): boolean {
  const target = name?.trim();
  if (!target) return false;
  return resolveNameAnsweredToRealNameAsk(messages)?.name === target;
}

/**
 * 候选人是否已在对话中对 `name` 做出明确确认（姓名闸门的解锁路径）。
 *
 * 业务背景：badcase g4ytra23（chat 6a60856b，2026-07-22）——候选人打招呼语昵称恰好
 * 等于真名（"我是陈佩珊"），`isFromAutoGreeting` 是存在性判断，导致其后无论候选人
 * 怎么确认（"是的"/"就是陈佩珊"/发身份证照片）闸门都持续 reject，booking 连拒 5 次、
 * Agent 重复索名 4 遍。以下三类确认证据满足其一即视为解锁：
 *
 * 1. 直陈确认：候选人原文出现"就是{name}"（对"发一下真实姓名"的直接应答句式）；
 * 2. 问答对确认：assistant 提问句同时含 {name} + 全名/真实姓名/本名 + 疑问尾缀，
 *    且紧随其后的第一条 user 消息是纯肯定答复；
 * 3. 身份证图片证据：vision 描述文本（以 user 消息形态入历史）中"身份证…姓名{name}"
 *    形态匹配——注意 OCR 描述"姓名陈佩珊"无冒号分隔，`hasStructuredNameSubmission`
 *    的键值对正则覆盖不到。
 */
export function isNameConfirmedInDialogue(name: string, messages: readonly unknown[]): boolean {
  const target = name?.trim();
  if (!target || target.length < 2) return false;
  const turns = extractDialogueTurns(messages);
  const escaped = escapeRegExp(target);
  const directConfirmRe = new RegExp(`就是\\s*${escaped}`, 'u');
  const idCardRe = new RegExp(`身份证[^\\n]{0,30}?姓名\\s*[：:]?\\s*${escaped}`, 'u');

  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    const text = stripQuoteBlocks(stripTimeContext(turn.text));
    if (directConfirmRe.test(text) || idCardRe.test(text)) return true;
  }

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role !== 'assistant') continue;
    const askText = turn.text;
    if (!askText.includes(target)) continue;
    if (!/(全名|真实姓名|本名)/u.test(askText)) continue;
    // 疑问尾缀：除"对吧/是吗"类，还要认"是你的本名吗"这种裸"吗/么"结尾
    // （badcase 6a609570：问句是「"张杰"是你的本名吗」，原尾缀表漏掉）。
    // 问句已被 target+本名词双条件约束，放宽到任意疑问标记不会误触发。
    if (!/(对吧|对吗|对么|对不对|是吗|是么|是吧|[吗么？?])/u.test(askText)) continue;
    for (let j = i + 1; j < turns.length; j++) {
      if (turns[j].role !== 'user') continue;
      // 只认紧随其后的第一条 user 消息，避免远处无关的"嗯/对"被错误归因到这次确认。
      if (isAffirmativeAnswer(normalizeShortAnswer(turns[j].text))) return true;
      break;
    }
  }
  return false;
}

/**
 * assistant 已向候选人索要"真实姓名/本名"的次数（同题限问用）。
 * 回复经 delivery 分段后逐段入历史，索名句通常独占一段，按含关键词的消息数计即可。
 */
export function countRealNameAsks(messages: readonly unknown[]): number {
  return extractDialogueTurns(messages).filter(
    (turn) =>
      turn.role === 'assistant' && /(真实姓名|身份证上的本名|身份证上的姓名)/u.test(turn.text),
  ).length;
}
