/**
 * 收资表单状态机子域的对外门面。
 *
 * 依赖方向（`.eslintrc.js` 强制）：tools → memory/resolution/sponge；
 * 本子域只 import resolution 兄弟域与 sponge 类型，**不得** import memory/tools/llm。
 * LLM 调用只允许出现在 tools 层（选项含糊时模型作证选 optionCode，产物过公证）。
 */

export * from './form.types';
export * from './form-writes';
export * from './option-matching';
export * from './disclosure-policy';
export * from './adapters/adapter.types';
export * from './adapters/adapter.registry';
export { proposeIdentityCore } from './adapters/identity-core.adapter';
export { proposeEducation } from './adapters/education.adapter';
export { proposeHealthCertificate } from './adapters/health-certificate.adapter';
export {
  containsSensitiveScreeningText,
  SENSITIVE_SCREENING_CRITERIA_NOTICE,
  SENSITIVE_SCREENING_RENDER_NOTICE,
} from './sensitive-screening';
