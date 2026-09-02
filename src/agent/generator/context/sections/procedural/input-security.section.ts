// 知识归类：procedural —— Prompt Injection 命中后的条件式模型防护上下文。
// prompt-rule-ledger: docs/prompt-rule-ledger.md（input-guard 条件式 section）
import { buildTextPromptBlock, type PromptSection } from '../section.interface';
import type { PromptModel } from '../../prompt-model.types';

/** 只渲染上游 Detector 已裁定的安全指令；不检测输入、不发送告警。 */
export class InputSecuritySection implements PromptSection {
  readonly id = 'input-guard';
  readonly domain = 'teaching' as const;
  readonly slot = 'input-security' as const;
  readonly dynamic = true;

  build(model: PromptModel) {
    return buildTextPromptBlock(this, model.security.injectionWarning?.instruction ?? '');
  }
}
