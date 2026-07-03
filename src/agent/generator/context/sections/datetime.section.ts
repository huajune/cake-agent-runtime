import { PromptContext, PromptSection } from './section.interface';

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
  readonly name = 'datetime';

  build(ctx: PromptContext): string {
    const now = new Date();
    const currentText = ctx.currentTimeText ?? this.formatNow(now);

    const lines: string[] = [`当前时间：${currentText}`];

    const offsetLabels: Array<[number, string]> = [
      [0, '今天'],
      [1, '明天'],
      [2, '后天'],
      [3, '大后天'],
    ];
    for (const [offset, label] of offsetLabels) {
      lines.push(`${label}：${this.formatDateWithWeekday(now, offset)}`);
    }

    return lines.join('\n');
  }

  private formatNow(now: Date = new Date()): string {
    return now.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private formatDateWithWeekday(now: Date, offsetDays: number): string {
    const target = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
    const date = target.toLocaleDateString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const weekday = target.toLocaleDateString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      weekday: 'long',
    });
    // toLocaleDateString 可能返回 "2026/04/29"，统一成 "2026-04-29"
    const normalizedDate = date.replace(/\//g, '-').replace(/-(\d)(?=-|$)/g, '-0$1');
    return `${normalizedDate} ${weekday}`;
  }
}
