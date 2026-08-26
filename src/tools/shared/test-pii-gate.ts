/**
 * 测试链路 PII 白名单闸门（tool guardrail，纯函数）。
 *
 * 测试重放可能携带原对话的真实姓名或手机号，而 booking / cancel / modify 会调用
 * 生产写网关。本闸门把“测试统一使用白名单假身份”固化为系统校验，避免测试链路
 * 对真实候选人产生副作用。
 *
 * 语义：仅在 strategySource === 'testing'（test-suite / debug-chat 重放）时生效；
 * released 生产链路完全不经过本判定。测试链路下：
 * - booking / cancel 等携带手机号的生产写操作：手机号必须在测试白名单内；
 * - 白名单外一律拒绝执行（返回 buildToolError，引导模型如实说明，不产生任何真实副作用）。
 *
 * 白名单与 scripts/audit-test-assets.js 保持同源口径。
 */

/** 测试假身份手机号白名单；新增号码必须同步审计脚本。 */
export const TEST_PII_PHONE_WHITELIST: readonly string[] = ['18271421690', '13800000000'];

/** 手机号是否为可在测试链路执行真实写操作的假身份。 */
export function isTestPiiPhoneAllowed(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const normalized = phone.replace(/[^\d]/g, '');
  return TEST_PII_PHONE_WHITELIST.includes(normalized);
}

/** 打码手机号用于错误详情回显（避免在工具结果里二次扩散 PII）。 */
export function maskPhoneForDetails(phone: string | null | undefined): string {
  if (!phone) return '(空)';
  const normalized = phone.replace(/[^\d]/g, '');
  if (normalized.length < 7) return '***';
  return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`;
}
