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

import { isFromAutoGreeting } from '@memory/facts/name-guard';
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
