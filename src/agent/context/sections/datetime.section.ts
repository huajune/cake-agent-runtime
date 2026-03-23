import { PromptSection } from './section.interface';

/**
 * 时间注入段落
 *
 * 注入当前时间，供提示词中 {{CURRENT_TIME}} 占位符使用，
 * 同时作为独立段落确保 LLM 感知当前时刻。
 */
export class DateTimeSection implements PromptSection {
  readonly name = 'datetime';

  build(): string {
    const now = new Date();
    const formatted = now.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
    return `当前时间：${formatted}`;
  }
}
