import { Injectable } from '@nestjs/common';
import { FeishuCardColor } from '../interfaces/interface';
import { FeishuReceiver } from '../constants/receivers';

export interface FeishuCardBuildOptions {
  title: string;
  content: string;
  color?: FeishuCardColor;
  atAll?: boolean;
  atUsers?: FeishuReceiver[];
}

/**
 * 飞书卡片构建器。
 * 统一负责把 markdown 文本和 @ 规则转成飞书 interactive card。
 */
@Injectable()
export class FeishuCardBuilderService {
  buildMarkdownCard({
    title,
    content,
    color = 'blue',
    atAll = false,
    atUsers,
  }: FeishuCardBuildOptions): Record<string, unknown> {
    const elements: Array<Record<string, unknown>> = [
      {
        tag: 'markdown',
        content,
      },
    ];

    if (atUsers && atUsers.length > 0) {
      elements.push({
        tag: 'hr',
      });
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**请关注**: ${atUsers.map((user) => `<at id=${user.openId}></at>`).join(' ')}`,
        },
      });
    } else if (atAll) {
      elements.push({
        tag: 'hr',
      });
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '**请关注**: <at id=all></at>',
        },
      });
    }

    return {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: title },
          template: color,
        },
        elements,
      },
    };
  }
}
