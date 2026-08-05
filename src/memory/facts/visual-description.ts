/**
 * 图片/表情 vision 描述识别 —— 第三方图片内容不得当候选人自陈事实。
 *
 * 背景（badcase 2026-08-04 `vkikct39`，chat 6a714c00…，P0）：
 * `save_image_description` 把 vision 描述**回写进用户消息内容**（`[图片消息] <描述>`），
 * 描述文本因此与候选人自己敲的字并列在同一条 user message 流里。该会话中候选人转发的是
 * BOSS 直聘岗位截图，描述里带着**发布方**的手机号和"18-40岁"这类岗位年龄区间——
 * 规则轨把它们当候选人自陈落进 `interview_info`（`age="18"`），LLM 轨的身份出处门
 * 因为"prompt 里找得到"同样放行了 `phone`，最终两个字段一起被提交进真实报名接口，
 * AI 面试短信发到了招募经理手机上。
 *
 * 与 `stripQuotedBlocks` 是同一取向、同一理由：一条消息里属于第三方的段落，其中的
 * 年龄/电话/薪资是别人的信息或岗位要求，不是候选人自陈。
 *
 * 例外——**候选人自己的简历图片**：描述以"简历图片："开头，或消息带"简历附件："行。
 * 这类图片本就是候选人提交的自陈材料，报名简历链路依赖从中提取的身份字段，必须保留。
 *
 * 刻意不覆盖：品牌线索。图片品牌解析是 §10.2 显式设计的独立通道
 * （`save_image_description` → `brandResolution.resolve`），不走本文件的收窄。
 */

/** vision 描述回写前缀，与 `save-image-description.tool.ts` 的 `resolvePrefix` 对齐。 */
const VISUAL_MESSAGE_PREFIXES = ['[图片消息]', '[表情消息]'] as const;

/** 简历图片标记：描述开头的"简历图片："与回写追加的"简历附件："行。 */
const RESUME_MARKER_REGEX = /简历图片：|(?:^|\n)简历附件：/u;

/**
 * 整条消息是否为 vision 描述回写产物。
 *
 * 判据是消息级而非行级：`updateMessageContent` 按 messageId 整条替换，图片描述
 * 独占一条 chat_messages 行，不会与候选人手打文本混在同一条消息里。
 */
export function isVisualDescriptionMessage(message: string | null | undefined): boolean {
  const trimmed = (message ?? '').trim();
  return VISUAL_MESSAGE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** 是否为候选人自己的简历图片（自陈材料，不做第三方收窄）。 */
export function isResumeImageMessage(message: string | null | undefined): boolean {
  return RESUME_MARKER_REGEX.test(message ?? '');
}

/**
 * 只保留可作为"候选人自陈"证据的消息：候选人手打文本 + 自己的简历图片描述。
 *
 * 用于身份/自陈类字段的提取与出处校验；不要用它去掉品牌、门店指代等
 * 本就依赖图片描述的通道。
 */
export function keepSelfReportedMessages(messages: readonly string[]): string[] {
  return messages.filter(
    (message) => !isVisualDescriptionMessage(message) || isResumeImageMessage(message),
  );
}

/**
 * 手机号是否有候选人自陈出处。
 *
 * 数字流子串比对，容忍"158 8726 5838"等分隔写法——与
 * `assertExtractionIdentityProvenance` 的 phone 口径一致，区别只在语料范围：
 * 那道门认整个提取 prompt（含图片描述），这道门只认候选人自陈。
 */
export function hasSelfReportedPhoneProvenance(
  phone: string | null | undefined,
  messages: readonly string[],
): boolean {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 7) return true;
  return keepSelfReportedMessages(messages).some((message) =>
    message.replace(/\D/g, '').includes(digits),
  );
}

/**
 * 姓名形态门：纯数字（含手机号）不可能是姓名。
 *
 * 同一 badcase 里 LLM 把手机号写进了 `interview_info.name`
 * （evidence 原文："**name / phone**：沿用已确认事实 13788930869"）——
 * `sanitizeInterviewName` 只拦"我是XX"打招呼语昵称，纯数字值直接穿透。
 * 只拦"去掉分隔符后不含任何非数字字符"这一种形态，不误伤含数字的真实昵称。
 */
export function isDigitsOnlyName(name: string | null | undefined): boolean {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return false;
  return /^[\d\s\-+()（）]+$/u.test(trimmed) && /\d/.test(trimmed);
}
