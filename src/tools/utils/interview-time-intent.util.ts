/**
 * 候选人只是在询问某个面试时段是否仍可约，而没有明确要求提交改约。
 *
 * 这里故意只拦截“还有吗 / 有没有”这类强可用性问句；“能不能改到上午”包含明确
 * 改约动作，不属于本函数的命中范围。工具描述仍负责更广泛的语义约束，本函数只做
 * 不可逆改约提交前的确定性兜底。
 */
export function isInterviewSlotAvailabilityInquiryOnly(message: string | undefined): boolean {
  const normalized = message?.replace(/\s+/g, '') ?? '';
  if (!normalized) return false;

  const asksAvailability =
    /(?:面试|场次|时段).{0,12}(?:还有吗|还有么|还有嘛|有没有|还有没有)/.test(normalized) ||
    /(?:还有吗|还有么|还有嘛|有没有|还有没有).{0,12}(?:面试|场次|时段)/.test(normalized) ||
    /(?:还有|有没有|还有没有).{0,12}(?:面试|场次|时段)(?:吗|么|嘛)/.test(normalized);
  if (!asksAvailability) return false;

  const explicitlyRequestsChange =
    /(?:帮我|给我|我要|我想|想要|麻烦)?(?:(?:改约|改期|修改|调整|挪|换)(?:到|成|为|一下|个)?|改(?:到|成|为|一下|个))/.test(
      normalized,
    ) || /(?:那就|就)(?:约|改到|换到)/.test(normalized);

  return !explicitlyRequestsChange;
}
