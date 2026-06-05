/**
 * 工具错误类型字典 —— 所有 tool 的 errorType 枚举单一来源。
 *
 * 为什么集中管理：
 * - 杜绝字符串字面量硬编码（拼写漏洞编译器抓不到）
 * - 解决跨工具同名冲突（job_not_found 曾在 booking / precheck / store_location 三处并存）
 * - 给下游消费方（badcase 表"错误原因"、监控告警面板、按 errorType 路由的 stage 策略）一个稳定锚点
 *
 * 命名规范：
 * - 字符串值用 `namespace.code` 形式，namespace 与工具名对齐；用前缀聚合做监控告警时更清晰
 * - 常量 key 用 SCREAMING_SNAKE_CASE
 * - 新增 errorType 时必须同步：
 *   1) 调用工具的代码
 *   2) 测试快照
 *   3) 监控/告警面板配置
 *   4) 飞书 badcase 表的"错误原因"单选字段（如已经按 errorType 收口）
 */
export const TOOL_ERROR_TYPES = {
  // ============================================================
  // duliday_interview_booking
  // 注意：时段/筛选答案/真实姓名等硬规则由 duliday_interview_precheck 前置拦截，
  // 本工具只保留接口契约层面的入参校验、active case 兜底、customerLabel 构造、
  // 海绵接口结果错误。
  // ============================================================
  BOOKING_ALREADY_BOOKED: 'booking.already_booked',
  BOOKING_MISSING_FIELDS: 'booking.missing_fields',
  BOOKING_INVALID_INTERVIEW_TIME: 'booking.invalid_interview_time',
  BOOKING_INVALID_AGE: 'booking.invalid_age',
  BOOKING_INVALID_GENDER_ID: 'booking.invalid_gender_id',
  BOOKING_INVALID_OPERATE_TYPE: 'booking.invalid_operate_type',
  BOOKING_INVALID_EDUCATION_ID: 'booking.invalid_education_id',
  BOOKING_INVALID_HEALTH_CERTIFICATE: 'booking.invalid_health_certificate',
  BOOKING_INVALID_HEALTH_CERTIFICATE_TYPES: 'booking.invalid_health_certificate_types',
  BOOKING_JOB_NOT_FOUND: 'booking.job_not_found',
  BOOKING_REJECTED: 'booking.rejected',
  BOOKING_REQUEST_FAILED: 'booking.request_failed',
  BOOKING_MISSING_CUSTOMER_LABEL_VALUES: 'booking.missing_customer_label_values',
  BOOKING_INVALID_CUSTOMER_LABEL_VALUES: 'booking.invalid_customer_label_values',

  // ============================================================
  // duliday_interview_precheck
  // ============================================================
  PRECHECK_INVALID_REQUESTED_DATE: 'precheck.invalid_requested_date',
  PRECHECK_JOB_NOT_FOUND: 'precheck.job_not_found',
  PRECHECK_FAILED: 'precheck.failed',

  // ============================================================
  // duliday_job_list
  // ============================================================
  JOB_LIST_MISSING_CITY_CONTEXT: 'job_list.missing_city_context',
  JOB_LIST_NO_RESULTS: 'job_list.no_results',
  JOB_LIST_SCHEDULE_FILTER_EMPTY: 'job_list.schedule_filter_empty',
  JOB_LIST_FETCH_FAILED: 'job_list.fetch_failed',

  // ============================================================
  // geocode
  // ============================================================
  /**
   * @deprecated 自 [松绑 city 必填 + 引入多候选验证] 之后，
   * geocode 工具不再因为 city 缺失硬报错——除非命中
   * `GENERIC_AMBIGUOUS_SUFFIX` 黑名单。常量保留只为兼容历史 badcase 记录。
   */
  GEOCODE_CITY_REQUIRED: 'geocode.city_required',
  GEOCODE_AMBIGUOUS_SUFFIX: 'geocode.ambiguous_suffix',
  GEOCODE_UNRESOLVED_ADDRESS: 'geocode.unresolved_address',
  GEOCODE_FAILED: 'geocode.failed',

  // ============================================================
  // invite_to_group
  // ============================================================
  INVITE_BOOKING_NOT_SUCCESS: 'invite.booking_not_success',
  INVITE_ENTERPRISE_TOKEN_MISSING: 'invite.enterprise_token_missing',
  INVITE_MISSING_BOT_IDENTITY: 'invite.missing_bot_identity',
  INVITE_INVALID_CITY_SCOPE: 'invite.invalid_city_scope',
  INVITE_NO_GROUP_AVAILABLE: 'invite.no_group_available',
  INVITE_NO_GROUP_IN_CITY: 'invite.no_group_in_city',
  INVITE_GROUP_FULL: 'invite.group_full',
  INVITE_API_REJECTED: 'invite.api_rejected',
  INVITE_API_FAILED: 'invite.api_failed',

  // ============================================================
  // send_store_location
  // ============================================================
  STORE_LOCATION_MISSING_JOB_ID: 'store_location.missing_job_id',
  STORE_LOCATION_MISSING_DELIVERY_CONTEXT: 'store_location.missing_delivery_context',
  STORE_LOCATION_JOB_NOT_FOUND: 'store_location.job_not_found',
  STORE_LOCATION_UNAVAILABLE: 'store_location.unavailable',
  STORE_LOCATION_SEND_FAILED: 'store_location.send_failed',

  // ============================================================
  // advance_stage
  // ============================================================
  STAGE_INVALID_TARGET: 'stage.invalid_target',
  STAGE_ALREADY_AT_TARGET: 'stage.already_at_target',

  // ============================================================
  // save_image_description
  // ============================================================
  SAVE_IMAGE_INVALID_MESSAGE_ID: 'save_image.invalid_message_id',

  // ============================================================
  // read_resume_attachment
  // ============================================================
  READ_RESUME_NO_ATTACHMENT: 'read_resume.no_attachment',
  READ_RESUME_FORBIDDEN_URL: 'read_resume.forbidden_url',
  READ_RESUME_TOO_LARGE: 'read_resume.too_large',
  READ_RESUME_DOWNLOAD_FAILED: 'read_resume.download_failed',
  READ_RESUME_NOT_PDF: 'read_resume.not_pdf',
  READ_RESUME_PARSE_FAILED: 'read_resume.parse_failed',
  READ_RESUME_EMPTY_TEXT: 'read_resume.empty_text',

  // ============================================================
  // 跨工具共享（涉及通用前置/上下文）
  // ============================================================
  MISSING_CHAT_ID: 'shared.missing_chat_id',
  NO_ACTIVE_CASE: 'shared.no_active_case',
  /** request_handoff(modify_appointment) 但候选人并无已确认预约 → 不短路，让 Agent 按首次约面继续。 */
  HANDOFF_NO_BOOKING: 'handoff.no_booking',
} as const;

/** 所有合法的 errorType 字符串值的联合类型 */
export type ToolErrorType = (typeof TOOL_ERROR_TYPES)[keyof typeof TOOL_ERROR_TYPES];

/**
 * 工具错误返回的标准形状。
 *
 * 字段约定：
 * - `success` / `dispatched` / `accepted` / `found`：成功标志，按工具语义保留原字段名
 * - `errorType`：机器可读的错误分类，必须来自 TOOL_ERROR_TYPES
 * - `_outcome`：一句话人类可读的结果摘要（招募经理/开发者看，不直接给 LLM 复读）
 * - `_replyInstruction`：给 LLM 的下一步动作指导（必填，禁止具体地名/案例/接口报错原文）
 * - `reason` 等其他字段：放工具特有的详情，不进 LLM prompt 的应避免出现在 reply
 */
export interface ToolErrorReturn {
  success?: false;
  dispatched?: false;
  accepted?: false;
  found?: false;
  errorType: ToolErrorType;
  _outcome?: string;
  _replyInstruction: string;
  [key: string]: unknown;
}

/**
 * 工具错误返回值构造器。
 *
 * 强制约束（编译期 + 运行期）：
 * - errorType 必须来自 TOOL_ERROR_TYPES 枚举
 * - _replyInstruction 必填，强制让调用方思考"失败后 LLM 该做什么"
 * - 异常 catch 的 err.message 应放进 `details.reason`（不进 prompt），不要拼到 _replyInstruction
 *
 * @param successField 成功标志的字段名。通用工具用 'success'；
 *                     request_handoff 用 'dispatched'，raise_risk_alert 用 'accepted'，
 *                     recall_history 用 'found'
 */
export function buildToolError(args: {
  errorType: ToolErrorType;
  replyInstruction: string;
  outcome?: string;
  details?: Record<string, unknown>;
  successField?: 'success' | 'dispatched' | 'accepted' | 'found';
}): ToolErrorReturn {
  const successKey = args.successField ?? 'success';
  return {
    [successKey]: false,
    errorType: args.errorType,
    ...(args.outcome ? { _outcome: args.outcome } : {}),
    _replyInstruction: args.replyInstruction,
    ...args.details,
  } as ToolErrorReturn;
}
