// 知识归类：procedural —— Prompt Injection 命中后的条件式模型防护上下文。
// prompt-rule-ledger: docs/prompt-rule-ledger.md（input-guard 条件式 section）
import type { PromptContext, PromptSection } from '../section.interface';

/** 只渲染上游 Detector 已裁定的安全指令；不检测输入、不发送告警。 */
export class InputSecuritySection implements PromptSection {
  readonly name = 'input-guard';

  build(ctx: PromptContext): string {
    return ctx.inputSecurityInstruction?.trim() ?? '';
  }
}
