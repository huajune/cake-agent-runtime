/**
 * HC-2：precheck/booking 共用的权威字段判定纯函数。
 *
 * 现状：booking 通过模型自报的 `prechecked` 入参信任 precheck 结论，候选人字段也直接
 * 取模型 args。本模块抽出**确定性、可被 precheck 与 booking 共用**的判定原语，先落地
 * 风险最小、价值最高的一类——**姓名权威性**（呼应 [[feedback_booking_nickname_vs_legal_name]]）：
 * 模型给的 name 必须能在候选人原文里找到 user_text 出处，否则疑似自证昵称。
 *
 * 完整的 `evaluatePrecheck`（时段/筛选/年龄全量重算）抽离仍待后续：precheck 校验逻辑与
 * 工具 execute 上下文耦合很深，贸然整体外提会动到直连 sponge 的实时预约路径。这里先做
 * booking 侧 defense-in-depth 的姓名闸门，不改 precheck 内部。
 */

import { isFromAutoGreeting, stripTimeContextSuffix } from '@memory/facts/name-guard';
import { parseName } from './candidate-field-parser';

/** 从归一化消息（ModelMessage 形态）里抽出全部 user 文本。 */
export function extractUserTexts(messages: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== 'user') continue;
    const text = extractText(msg.content);
    if (text.trim().length > 0) texts.push(text);
  }
  return texts;
}

export interface DialogueTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** 按原始顺序抽出 user/assistant 双角色文本（确认问答对识别需要 assistant 上下文）。 */
export function extractDialogueTurns(messages: readonly unknown[]): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const text = extractText(msg.content);
    if (text.trim().length > 0) turns.push({ role: msg.role, text });
  }
  return turns;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (
          part &&
          typeof part === 'object' &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join(' ');
  }
  return '';
}

// 企微引用气泡在消息管线里被渲染成单行前缀 `[引用 <speaker>：<snippet>]`
// （message-parser.formatQuoteMessage）。speaker 是**被引用方**（候选人引用岗位卡时
// 即招募经理）的显示名，snippet 是被引用消息原文（可能含 bot 发过的"姓名：X"表单）。
// 引用块整体都是别人说的话，不能作为候选人姓名出处。
const QUOTE_BLOCK_RE = /\[引用[^\n]*?\]\s*/g;
const QUOTE_SPEAKER_RE = /\[引用\s*([^：\n]{1,40})：/g;

/** 剥掉引用块，只留候选人自己敲的文字。 */
export function stripQuoteBlocks(text: string): string {
  return text.replace(QUOTE_BLOCK_RE, ' ');
}

/** 候选人消息里全部引用前缀的发言人（被引用方显示名，多为招募经理）。 */
export function extractQuotedSpeakers(messages: readonly unknown[]): string[] {
  const speakers = new Set<string>();
  for (const text of extractUserTexts(messages)) {
    for (const m of text.matchAll(QUOTE_SPEAKER_RE)) {
      const speaker = m[1]?.trim();
      if (speaker) speakers.add(speaker);
    }
  }
  return [...speakers];
}

/**
 * `name` 是否**只**以引用前缀被引用方的身份出现：命中某个引用 speaker（全等，或作为
 * "琪琪(高雅琪)"式复合显示名的组成部分），且剥掉引用块后的候选人原文里再找不到它。
 * 命中即极可能是招募经理名——候选人引用经理发的岗位卡追问时，经理显示名随
 * `[引用 XXX：...]` 进入对话，模型会把这个"最像真名的名字"误当候选人姓名
 * （生产 badcase：姓名预填"高雅琪"/"辛瑜琦"）。botUserId 落库是拼音
 * （gaoyaqi/XinYuQi），与中文显示名全等比对必然失配，必须直接从引用前缀取证。
 */
export function isNameOnlyQuotedSpeaker(name: string, messages: readonly unknown[]): boolean {
  const target = name?.trim();
  if (!target || target.length < 2) return false;
  const speakers = extractQuotedSpeakers(messages);
  if (!speakers.some((s) => s === target || s.includes(target))) return false;
  return !extractUserTexts(messages).some((text) => stripQuoteBlocks(text).includes(target));
}

/**
 * 是否能在候选人原文里找到与 `name` 一致的 user_text 真名出处
 * （结构化"姓名：X" / "我叫X"，经严格真名校验、排打招呼语昵称）。
 * 引用块先剥除：被引用的往往是 bot 自己发的收资表单，里面的"姓名：X"不是候选人说的。
 */
export function isNameAuthoritative(name: string, messages: readonly unknown[]): boolean {
  const target = name?.trim();
  if (!target) return false;
  for (const text of extractUserTexts(messages)) {
    if (parseName(stripQuoteBlocks(text)) === target) return true;
  }
  return false;
}

export interface NameGateVerdict {
  decision: 'allow' | 'reject_collect';
  reason?: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 剥时间后缀 + 引用块后，去掉空白与常见标点，用于短答复整句匹配。 */
function normalizeShortAnswer(text: string): string {
  return stripQuoteBlocks(stripTimeContextSuffix(text)).replace(
    /[\s，。！？!?~～、.…；;：:]/gu,
    '',
  );
}

/** 纯肯定答复（对确认问句的整句应答）。 */
const AFFIRMATIVE_ANSWER_RE =
  /^(是|是的|是滴|是啊|是呀|对|对的|对啊|对呀|嗯|嗯嗯|没错|确认|正确)$/u;

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
    const text = stripQuoteBlocks(stripTimeContextSuffix(turn.text));
    if (directConfirmRe.test(text) || idCardRe.test(text)) return true;
  }

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role !== 'assistant') continue;
    const askText = turn.text;
    if (!askText.includes(target)) continue;
    if (!/(全名|真实姓名|本名)/u.test(askText)) continue;
    if (!/(对吧|对吗|对么|对不对|是吗|是么|是吧)/u.test(askText)) continue;
    for (let j = i + 1; j < turns.length; j++) {
      if (turns[j].role !== 'user') continue;
      // 只认紧随其后的第一条 user 消息，避免远处无关的"嗯/对"被错误归因到这次确认。
      if (AFFIRMATIVE_ANSWER_RE.test(normalizeShortAnswer(turns[j].text))) return true;
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

/**
 * booking 提交前的姓名权威闸门（HC-2，**负向证据**口径，避免误拒）。
 *
 * 与现有 `runBookingGuards.checkRealName`（纯形态校验 isStrictRealChineseName）互补、不重叠：
 * - 有结构化 user_text 出处（"姓名：X" / "我叫X"）→ allow（最强）；
 * - **name 在原文里仅以"我是X"打招呼语昵称形式出现** → reject_collect。这是形态校验拦不住
 *   的缺口：2-4 字昵称（"小王"/"阿强"）形态上是合法真名，checkRealName 放行，但它只是微信
 *   打招呼昵称（[[feedback_booking_nickname_vs_legal_name]]）；
 * - **name 只以引用前缀被引用方（多为招募经理）名字出现** → reject_collect。经理真名形态
 *   完全合规，checkRealName 与打招呼语识别都拦不住；
 * - 其余（含裸答真名"张伟"、无任何负向证据）→ allow，形态交给 checkRealName，避免误拒。
 */
export function evaluateBookingNameGate(
  name: string,
  messages: readonly unknown[],
): NameGateVerdict {
  const target = name?.trim();
  if (!target) return { decision: 'allow' };
  if (isNameAuthoritative(target, messages)) return { decision: 'allow' };
  // 解锁路径：负向证据（打招呼语昵称/引用前缀）可被候选人后续的明确确认覆盖——
  // "就是X"/确认问答对/身份证图片证据（badcase g4ytra23 死锁修复）。
  if (isNameConfirmedInDialogue(target, messages)) return { decision: 'allow' };
  if (isNameOnlyQuotedSpeaker(target, messages)) {
    return {
      decision: 'reject_collect',
      reason:
        '提交的姓名仅以"[引用 XXX：...]"引用前缀里被引用方（多为招募经理）的名字出现，不是候选人自己提供的，需先向候选人确认真实姓名',
    };
  }
  if (isFromAutoGreeting(target, extractUserTexts(messages))) {
    return {
      decision: 'reject_collect',
      reason: '提交的姓名仅以"我是X"打招呼语昵称形式出现，需先向候选人确认真实姓名',
    };
  }
  return { decision: 'allow' };
}

/**
 * 提交的手机号是否能在候选人原文中找到出处（剥引用块后按纯数字子串匹配，
 * 容忍"155 2189 9062"等分隔写法）。
 */
export function isPhoneAuthoritative(phone: string, messages: readonly unknown[]): boolean {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(digits)) return false;
  return extractUserTexts(messages).some((text) =>
    stripQuoteBlocks(text).replace(/\D/g, '').includes(digits),
  );
}

/**
 * booking 提交前的手机号溯源闸门（正向证据口径）。
 *
 * 业务背景：badcase 6e9ar9gd 簇（2026-07-22）——抽取示例回声臆造的档案经"沿用"洗白后，
 * booking 曾拿**候选人从未提供过的编造手机号**（15921708092）提交真实预约网关；当时全部
 * 字段中只有姓名有溯源守卫。手机号是预约表单里错误代价最高的字段（门店按它联系候选人），
 * 必须能追溯到候选人亲口发送的消息，否则一律打回索要。
 *
 * 与姓名闸门口径不同：姓名允许"无负向证据即放行"（裸答真名很常见），手机号採正向证据——
 * 合法手机号只可能来自候选人原文，原文里不存在即臆造/串档案，没有灰区。
 */
export function evaluateBookingPhoneGate(
  phone: string,
  messages: readonly unknown[],
): NameGateVerdict {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!digits) return { decision: 'allow' }; // 空值交给必填字段校验，不在本闸门重复报
  if (isPhoneAuthoritative(phone, messages)) return { decision: 'allow' };
  return {
    decision: 'reject_collect',
    reason:
      '提交的手机号在候选人原文中不存在，疑似臆造或来自非候选人渠道，必须先向候选人索要联系方式',
  };
}
