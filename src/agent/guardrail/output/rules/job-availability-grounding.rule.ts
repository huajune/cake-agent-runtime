import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';

/**
 * 零查岗时的正向岗位可用性断言。
 *
 * 只收“岗位很多 / 我们有岗位 / 多家门店在招”这类完成态结论；“我帮你看看附近
 * 有没有岗位”属于合法查询承接，不命中。规则只在本轮完全没有 duliday_job_list 调用时
 * 生效，避免与工具结果的正向转述冲突。
 */
const POSITIVE_AVAILABILITY_PATTERNS = [
  /(?:岗位|工作(?!餐|内容|时间|地点|要求|班次|环境)|机会)[^。！？!?\n]{0,4}(?:挺|蛮|比较|非常|很多|不少|多)(?:的|呢|啊|哈|呀|哦|～|~)?(?:[，。！？!?]|$)/u,
  /(?:我们(?:这边)?|这边|附近|当地|这里)?(?:确实|还是|也)?有(?:不少|很多|一些|合适的)?(?:兼职|全职|小时工|暑假工|寒假工)?(?:岗位|工作(?!餐|内容|时间|地点|要求|班次|环境))(?:在招)?/u,
  /(?:不少|很多|好几|多)(?:家)?(?:门店|岗位|工作(?!餐|内容|时间|地点|要求|班次|环境))[^。！？!?\n]{0,6}(?:在招|招人)/u,
  /(?:兼职|全职|小时工|暑假工|寒假工)[^。！？!?\n]{0,6}(?:我们(?:这边)?|这边)?有(?:的|呢|啊|哈|呀|哦)?(?:[，。！？!?]|$)/u,
] as const;

const NON_ASSERTIVE_CONTEXT =
  /有没有|是否有|有无|哪(?:里|儿)有|有吗|有嘛|有么|有呢[？?]|(?:帮你|给你|先|再)?(?:查|看|找|确认)[^。！？!?\n]{0,8}(?:有|在招)|(?:不能|不该|不要|无法|不敢|未必|不一定|还没|尚未)[^。！？!?\n]{0,12}(?:岗位|工作|机会|有岗|在招|多|不少)|(?:岗位|工作(?!餐|内容|时间|地点|要求|班次|环境)|机会)[^。！？!?\n]{0,5}(?:不多|不算多|没那么多|未必多)/u;

export function detectJobAvailabilityWithoutLookup(text: string, toolCalls: AgentToolCall[] = []) {
  if (toolCalls.some((call) => call.toolName === 'duliday_job_list')) return null;

  const clause = text
    .split(/(?<=[。！？!?\n])/u)
    .map((part) => part.trim())
    .find(
      (part) =>
        part.length > 0 &&
        !NON_ASSERTIVE_CONTEXT.test(part) &&
        POSITIVE_AVAILABILITY_PATTERNS.some((pattern) => pattern.test(part)),
    );

  if (!clause) return null;

  return {
    ruleId: 'job_availability_without_lookup',
    label: `本轮未调用 duliday_job_list，却正向断言岗位可用性（${clause.slice(0, 48)}）`,
    action: GUARDRAIL_ACTION.REVISE,
  };
}
