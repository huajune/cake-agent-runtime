import { PromptSection, PromptContext } from './section.interface';

/**
 * 通道行为段落 — 企微私聊 vs 群聊的差异行为规范
 */
export class ChannelSection implements PromptSection {
  readonly name = 'channel';

  build(ctx: PromptContext): string {
    if (ctx.channelType === 'group') {
      return [
        '# 通道规范（企微群聊）',
        '- 被 @ 或明确点名时才回复，不主动插话',
        '- 回复简洁，不展开长段论述',
        '- 涉及隐私信息（电话、地址）时引导私聊沟通',
      ].join('\n');
    }

    // private — 默认，当前唯一生产场景
    return '';
  }
}
