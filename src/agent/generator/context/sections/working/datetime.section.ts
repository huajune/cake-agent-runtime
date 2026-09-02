// 知识归类：working —— 本段呈现随当前回合变化的时间上下文。
import { formatCurrentTime, formatLocalDateWithWeekday } from '@infra/utils/date.util';
import { buildTextPromptBlock, type PromptSection } from '../section';
import type { PromptModel } from '../../context.types';

/**
 * 时间注入段落
 *
 * 注入当前时间，供提示词中 {{CURRENT_TIME}} 占位符使用，
 * 同时作为独立段落确保 LLM 感知当前时刻。
 *
 * 除了"当前时间"以外，还预先计算"今天/明天/后天/大后天"的日期与星期映射，
 * 直接喂给模型。背景：badcase `bgsjb64r` —— 04-29 周三的对话里，候选人说
 * "后天回来"（=5/1 周五），Agent 把"后天"绑到了"周四"。Date 算术让模型
 * 自己做太容易出错，由系统侧 grounding 才能保证准确。
 */
export class DateTimeSection implements PromptSection {
  readonly id = 'datetime';
  readonly domain = 'tool_result' as const;
  readonly slot = 'working-context' as const;
  readonly dynamic = true;

  build(model: PromptModel) {
    return buildTextPromptBlock(
      this,
      buildDateTimeGroundingLines(new Date(), model.currentTimeText).join('\n'),
    );
  }
}

/**
 * 当前时间 + 今天/明天/后天/大后天映射的 grounding 行（系统侧日历计算）。
 *
 * 主链路 DateTimeSection 与 ReplyRepairAgent 共用：任何产出候选人可见文本的 LLM 调用都
 * 需要这份锚——没有它，相对日期只能从历史消息里猜，会把当天的真实约面复述成"明天"。
 */
export function buildDateTimeGroundingLines(
  now: Date = new Date(),
  currentTextOverride?: string,
): string[] {
  const lines: string[] = [`当前时间：${currentTextOverride ?? formatCurrentTime(now.getTime())}`];

  const offsetLabels: Array<[number, string]> = [
    [0, '今天'],
    [1, '明天'],
    [2, '后天'],
    [3, '大后天'],
  ];
  for (const [offset, label] of offsetLabels) {
    lines.push(`${label}：${formatDateWithWeekday(now, offset)}`);
  }

  return lines;
}

function formatDateWithWeekday(now: Date, offsetDays: number): string {
  return formatLocalDateWithWeekday(new Date(now.getTime() + offsetDays * 86_400_000));
}
