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
  // booking 侧提交海绵前会重跑同族硬规则（booking-guards defense-in-depth），并做
  // jobId/姓名/手机号溯源闸门与候选人快照对账；本分节错误码覆盖接口契约入参校验、
  // 上述闸门拒绝、active case 兜底、customerLabel 构造与海绵接口结果错误。
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
  /** jobId 无召回出处：本会话从未召回过任何岗位（precheck 同型闸门的 booking 侧 defense-in-depth）。 */
  BOOKING_JOB_NOT_PROVIDED: 'booking.job_not_provided',
  BOOKING_REJECTED: 'booking.rejected',
  BOOKING_REQUEST_FAILED: 'booking.request_failed',
  BOOKING_MISSING_CUSTOMER_LABEL_VALUES: 'booking.missing_customer_label_values',
  BOOKING_INVALID_CUSTOMER_LABEL_VALUES: 'booking.invalid_customer_label_values',

  // ============================================================
  // 测试链路（strategySource === 'testing'）
  // ============================================================
  /**
   * 测试链路 PII 白名单闸门：booking/cancel 等生产写操作的手机号不在测试
   * 假身份白名单（兮兮/18271421690 等）内，拒绝触达海绵生产网关。
   * 2026-07-27 事故实证：复测用了真实候选人手机号误建工单 453264。
   */
  TEST_LINK_REAL_PII_BLOCKED: 'test_link.real_pii_blocked',
  /** 测试链路禁止真实改约提交（modify 无手机号入参，无法白名单校验，保守整拦）。 */
  TEST_LINK_MODIFY_BLOCKED: 'test_link.modify_blocked',

  // ============================================================
  // duliday_interview_precheck
  // ============================================================
  PRECHECK_INVALID_REQUESTED_DATE: 'precheck.invalid_requested_date',
  PRECHECK_JOB_NOT_FOUND: 'precheck.job_not_found',
  /**
   * jobId 无召回出处：本会话（含本轮 job_list）从未召回/展示过任何岗位，模型却传入了 jobId。
   * 典型幻觉簇——空会话里候选人只发"应聘/约面试"，模型凭空编出 jobId + 整张候选人报名表直接 precheck。
   * 与 job_not_found 区别开：后者"未找到岗位"措辞会被模型脑补成"岗位下架了"，本类型明确要求先走 job_list。
   */
  PRECHECK_JOB_NOT_PROVIDED: 'precheck.job_not_provided',
  PRECHECK_FAILED: 'precheck.failed',

  // ============================================================
  // duliday_cancel_work_order
  // ============================================================
  CANCEL_MISSING_WORK_ORDER_ID: 'cancel.missing_work_order_id',
  /** 未传/传错 cancelReasonId：返回可选取消原因列表，让 LLM 据候选人原话选一个 id 重试。 */
  CANCEL_REASON_REQUIRED: 'cancel.reason_required',
  /** 取消原因字典拉取失败：无法确定 cancelReasonId，转人工。 */
  CANCEL_REASON_FETCH_FAILED: 'cancel.reason_fetch_failed',
  CANCEL_REJECTED: 'cancel.rejected',
  CANCEL_REQUEST_FAILED: 'cancel.request_failed',
  /** workOrderId 不在候选人当前有效预约（active_booking）集合内：疑似臆造/串档案工单，硬拒。 */
  CANCEL_WORK_ORDER_NOT_OWNED: 'cancel.work_order_not_owned',
  /** 工单已面试通过/入职推进中：不可自助取消，转人工核实。 */
  CANCEL_BLOCKED_BY_STATUS: 'cancel.blocked_by_status',

  // ============================================================
  // duliday_modify_interview_time
  // ============================================================
  MODIFY_INTERVIEW_MISSING_WORK_ORDER_ID: 'modify_interview.missing_work_order_id',
  /** 候选人只询问时段可用性，尚未明确确认提交改约。 */
  MODIFY_INTERVIEW_UNCONFIRMED: 'modify_interview.unconfirmed',
  /** 手机号查到的工单不属于当前微信联系人的 active_booking，禁止自助修改并直接转人工。 */
  MODIFY_INTERVIEW_WORK_ORDER_NOT_IN_MEMORY: 'modify_interview.work_order_not_in_memory',
  MODIFY_INTERVIEW_INVALID_TIME: 'modify_interview.invalid_time',
  MODIFY_INTERVIEW_REJECTED: 'modify_interview.rejected',
  MODIFY_INTERVIEW_REQUEST_FAILED: 'modify_interview.request_failed',

  // ============================================================
  // duliday_job_list
  // ============================================================
  JOB_LIST_MISSING_CITY_CONTEXT: 'job_list.missing_city_context',
  JOB_LIST_NO_RESULTS: 'job_list.no_results',
  /**
   * regionNameList 传入的是乡镇/街道/新镇/地标级地名（川沙、九亭、周浦 等）而非区级行政区名。
   * 后端只精确匹配区级 storeRegionName，乡镇名必然命中 0 ≠ 该片区无岗。引导 Agent 先 geocode
   * 解析成区级 district + 经纬度再重查，而不是直接照 noMatchScript 拉群收口。
   */
  JOB_LIST_REGION_NEEDS_GEOCODE: 'job_list.region_needs_geocode',
  JOB_LIST_SCHEDULE_FILTER_EMPTY: 'job_list.schedule_filter_empty',
  JOB_LIST_STUDENT_FILTER_EMPTY: 'job_list.student_filter_empty',
  JOB_LIST_JOBID_NO_PROVENANCE: 'job_list.jobid_no_provenance',
  /** 品牌列表为空却传了 enforce/exclude：矛盾组合，引导补品牌或改 mode（§8.1）。 */
  JOB_LIST_BRAND_MODE_CONFLICT: 'job_list.brand_mode_conflict',
  /**
   * 候选人想要某个合法用工形式，但本轮召回的岗位经 laborForm 严格匹配后为空。
   * 引导 Agent 如实告知附近暂无该用工形式岗位，不得把别的用工形式包装回去。
   */
  JOB_LIST_LABOR_FORM_FILTER_EMPTY: 'job_list.labor_form_filter_empty',
  JOB_LIST_FETCH_FAILED: 'job_list.fetch_failed',

  // ============================================================
  // geocode
  // ============================================================
  /**
   * @deprecated 自 [松绑 city 必填 + 引入多候选验证] 之后，geocode 工具不再因为 city 缺失
   * 硬报错——除非命中「通用后缀黑名单」，那条路径报的是 GEOCODE_AMBIGUOUS_SUFFIX。
   * 代码零引用，保留仅为错误码目录完整性（历史观测数据里存的是字符串字面量，
   * 不依赖本常量存在）。
   */
  GEOCODE_CITY_REQUIRED: 'geocode.city_required',
  GEOCODE_AMBIGUOUS_SUFFIX: 'geocode.ambiguous_suffix',
  /**
   * 未传 city + address 含明确"X区/X县"行政区名，但高德单城返回的 POI 落在
   * 另一个区（跨城同名区被模糊匹配到错城）。线上 case：候选人"雨花区板桥"无 city
   * 时被高德解析成"长沙县板桥小区"并以 unique 返回，Agent 误判长沙无岗静默收口。
   * 命中本类型时禁止采用坐标，先中性反问候选人城市再带 city 重调。
   */
  GEOCODE_DISTRICT_CITY_MISMATCH: 'geocode.district_city_mismatch',
  GEOCODE_ANCHOR_MISMATCH: 'geocode.anchor_mismatch',
  GEOCODE_UNRESOLVED_ADDRESS: 'geocode.unresolved_address',
  GEOCODE_FAILED: 'geocode.failed',

  // ============================================================
  // invite_to_group
  // ============================================================
  INVITE_BOOKING_NOT_SUCCESS: 'invite.booking_not_success',
  INVITE_ENTERPRISE_TOKEN_MISSING: 'invite.enterprise_token_missing',
  INVITE_MISSING_BOT_IDENTITY: 'invite.missing_bot_identity',
  INVITE_INVALID_CITY_SCOPE: 'invite.invalid_city_scope',
  /**
   * 城市 provenance gate：city 入参与会话记忆中的高置信城市不一致。
   * 模型应改用 expectedCity 重新调用，或先与候选人确认后再拉群。
   */
  INVITE_CITY_CONFLICT: 'invite.city_conflict',
  /**
   * 城市 provenance gate：city 入参在会话记忆与候选人原文中都找不到依据（模型凭空指定）。
   * 模型应先向候选人确认所在城市，得到明确回复后再调用本工具。
   */
  INVITE_CITY_UNVERIFIED: 'invite.city_unverified',
  /**
   * 时机 gate：本会话已给该城市拉过群，重复邀请只会骚扰候选人。
   * 模型应据实回应"你已经在 X 群里了"，不要再次发起邀请。
   */
  INVITE_ALREADY_INVITED: 'invite.already_invited',
  /**
   * 时机 gate：本轮还没跑过 duliday_job_list，候选人不知道有岗没岗就收到群邀请（突兀拉群）。
   * 模型应先查岗并给出结论，再决定是否拉群。
   */
  INVITE_NO_JOB_RESULT: 'invite.no_job_result',
  /**
   * 时机 gate：候选人本轮正在推进某岗位的报名/约面（问怎么报名、几点面试…）。
   * 拉群是"无岗维护"场景，此时拉群等于打断成单。
   */
  INVITE_BOOKING_IN_PROGRESS: 'invite.booking_in_progress',
  INVITE_NO_GROUP_AVAILABLE: 'invite.no_group_available',
  INVITE_NO_GROUP_IN_CITY: 'invite.no_group_in_city',
  INVITE_GROUP_FULL: 'invite.group_full',
  INVITE_API_REJECTED: 'invite.api_rejected',
  /**
   * 全部候选群都因 errcode=-8 "is not a friend" 被拒：候选人不是接客 bot 的外部联系人
   * （已拉黑/删好友，或外部联系人关系从未建立）。这是候选人侧真实状态、人工无可作为，
   * 故不发运维告警、也不转人工，Agent 自然收口即可。
   */
  INVITE_CANDIDATE_NOT_FRIEND: 'invite.candidate_not_friend',
  INVITE_API_FAILED: 'invite.api_failed',

  // ============================================================
  // send_store_location
  // ============================================================
  STORE_LOCATION_MISSING_JOB_ID: 'store_location.missing_job_id',
  STORE_LOCATION_MISSING_DELIVERY_CONTEXT: 'store_location.missing_delivery_context',
  STORE_LOCATION_JOB_NOT_FOUND: 'store_location.job_not_found',
  STORE_LOCATION_UNAVAILABLE: 'store_location.unavailable',
  STORE_LOCATION_INTERVIEW_GEOCODE_FAILED: 'store_location.interview_geocode_failed',
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
  READ_RESUME_UNSUPPORTED_FORMAT: 'read_resume.unsupported_format',
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
 *                     request_handoff 用 'dispatched'，raise_risk_alert 用 'accepted'；
 *                     'found' 为 recall_history 的成功字段名预留（该工具无错误返回，不经本工厂）
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
