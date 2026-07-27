/**
 * 测试链路 PII 白名单闸门（tool guardrail，纯函数）。
 *
 * 背景（2026-07-27 事故）：复测策展沿用了原对话的真实姓名/手机号，
 * booking 在测试链路真调海绵生产网关，误建了真实工单（453264，项目经理
 * 收到预约通知后又收到撤销告警）。测试链路对 invite_to_group 早有
 * simulated 沙箱，但 booking / cancel / modify 这类生产写工具是裸的——
 * 唯一防线是"测试统一用假身份（兮兮/18271421690）"的人工纪律。
 * 纪律靠自觉必然会穿，本闸门把它固化为系统校验。
 *
 * 语义：仅在 strategySource === 'testing'（test-suite / debug-chat 重放）时生效；
 * released 生产链路完全不经过本判定。测试链路下：
 * - booking / cancel 等携带手机号的生产写操作：手机号必须在测试白名单内；
 * - 白名单外一律拒绝执行（返回 buildToolError，引导模型如实说明，不产生任何真实副作用）。
 *
 * 白名单与 scripts/audit-test-assets.js 保持同源口径。
 */

/** 测试假身份手机号白名单（兮兮=2026-07-02 用户指定；13800000000 为旧约定测试号）。 */
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
