/**
 * booking 提交前的身份字段动作授权闸门（姓名 / 手机号）—— 快照闸（snapshot-gate）的同类。
 *
 * 沿革（HC-2）：booking 曾通过模型自报的 `prechecked` 入参信任 precheck 结论，候选人
 * 字段也直接取模型 args。本文件是 defense-in-depth 的确定性判定：模型给的 name/phone
 * 必须能在候选人原文里找到出处或亲证，否则打回索要（呼应
 * [[feedback_booking_nickname_vs_legal_name]]）。原居所 tools/shared/precheck-core →
 * candidate/name-qa，2026-08-10 按「动作授权归 evidence、与 city-confirmation 对称」拆分至此。
 *
 * 闸门判定用完即弃、不产事实（"判过/为何拒"由调用方落观测）；问答证据的产出在
 * ./producers/name-confirmation，语料原语在 @resolution/signal/dialogue。
 */

import { isFromAutoGreeting, parseName } from '@resolution/candidate';
import {
  extractDialogueTurns,
  extractQuotedSpeakers,
  extractUserTexts,
  isAffirmativeAnswer,
  normalizeShortAnswer,
  stripQuoteBlocks,
} from '@resolution/signal/dialogue';
import {
  isNameAnsweredToRealNameAsk,
  isNameConfirmedInDialogue,
  isNameProvidedAfterAsk,
} from './producers/name-confirmation';
import type { NameGateVerdict } from './claim.types';

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
  if (isNameProvidedAfterAsk(target, messages)) return { decision: 'allow' };
  // 开放式索名 → 裸名直答（badcase 6a7446eb）：最自然的真名提供路径，上面两个
  // 逃生口都够不着（一个要名+手机号同现，一个要问句里已含该名）。
  if (isNameAnsweredToRealNameAsk(target, messages)) return { decision: 'allow' };
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
 * 「Agent 复述档案手机号求证 → 候选人肯定应答」= 手机号亲证（姓名侧
 * `isNameConfirmedInDialogue` 的手机号孪生）。
 *
 * 缺口实证（badcase gu2kra6p，chat 6a72978f，2026-08-06）：手机号来自长期画像，Agent
 * 复述求证「我记得你之前登记过姓名是蔡瑾琳，电话是17870159396，现在还是吗？」，候选人
 * 回「[引用 …] 是的」——**号码写在引用块里，`isPhoneAuthoritative` 剥引用块后手里只剩
 * "是的"**，出处门判臆造，booking 连拒两轮。结果同一句"方便留个联系电话吗"问了 3 遍，
 * 候选人自己把号码打出来才解锁。这与姓名侧 6a7446eb 的死锁是同一形态（候选人已明确
 * 确认，闸门看不见），见 [[badcase-identity-evidence-deadlock]]。
 *
 * 判据（三条同时满足，宁可漏不可错）：
 * 1. assistant 消息里出现该号码本身（复述档案号求证）；
 * 2. 该消息带疑问标记（是在求证，不是单纯播报）；
 * 3. **紧随其后的第一条** user 消息是肯定应答（复用姓名侧肯定词表，
 *    "这里不是""不对"等否定形态天然不匹配）。
 *
 * 与"防臆造"初衷不冲突：号码是当着候选人的面复述、由候选人本人拍板的，与"模型凭空
 * 塞一个候选人从没见过的号"（6e9ar9gd 簇）不是一回事。
 */
export function isPhoneConfirmedInDialogue(phone: string, messages: readonly unknown[]): boolean {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(digits)) return false;
  const turns = extractDialogueTurns(messages);
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== 'assistant') continue;
    const askText = turns[i].text;
    if (!askText.replace(/\D/gu, '').includes(digits)) continue;
    if (!/(对吧|对吗|对么|对不对|是吗|是么|是吧|[吗么？?])/u.test(askText)) continue;
    for (let j = i + 1; j < turns.length; j++) {
      if (turns[j].role !== 'user') continue;
      // 只认紧随其后的第一条 user 消息，避免远处无关的"嗯/对"被错误归因到这次求证。
      if (isAffirmativeAnswer(normalizeShortAnswer(turns[j].text))) return true;
      break;
    }
  }
  return false;
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
 *
 * 唯一的解锁路径是候选人**本人当面确认**过该号码（`isPhoneConfirmedInDialogue`，
 * badcase gu2kra6p 死锁修复）——否则闸门会把"候选人已经说过是的"也判成臆造。
 */
export function evaluateBookingPhoneGate(
  phone: string,
  messages: readonly unknown[],
): NameGateVerdict {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!digits) return { decision: 'allow' }; // 空值交给必填字段校验，不在本闸门重复报
  if (isPhoneAuthoritative(phone, messages)) return { decision: 'allow' };
  if (isPhoneConfirmedInDialogue(phone, messages)) return { decision: 'allow' };
  return {
    decision: 'reject_collect',
    reason:
      '提交的手机号在候选人原文中不存在，疑似臆造或来自非候选人渠道，必须先向候选人索要联系方式',
  };
}
