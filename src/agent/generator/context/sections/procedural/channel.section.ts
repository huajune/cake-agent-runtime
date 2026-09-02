// 知识归类：procedural —— 本段定义不同消息通道下的行为规范。
// prompt-rule-ledger: docs/prompt-rule-ledger.md（程序性通道规则总账）
import { buildTextPromptBlock, type PromptSection } from '../section.interface';
import type { PromptModel } from '../../prompt-model.types';

/**
 * 通道行为段落 — 企微私聊 vs 群聊的差异行为规范
 */
export class ChannelSection implements PromptSection {
  readonly id = 'channel';
  readonly domain = 'teaching' as const;
  readonly slot = 'stable-instructions' as const;
  readonly dynamic = true;

  build(model: PromptModel) {
    if (model.channelType === 'group') {
      return buildTextPromptBlock(
        this,
        [
          '# 通道规范（企微群聊）',
          '- 被 @ 或明确点名时才回复，不主动插话',
          '- 回复简洁，不展开长段论述',
          '- 涉及隐私信息（电话、地址）时引导私聊沟通',
        ].join('\n'),
      );
    }

    // private — 默认，当前唯一生产场景
    return [];
  }
}
