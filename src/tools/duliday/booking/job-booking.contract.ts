export const API_BOOKING_REQUIRED_PAYLOAD_FIELDS = [
  'jobId',
  'interviewTime',
  'name',
  'phone',
  'age',
  'genderId',
  'operateType',
] as const;

export const API_BOOKING_OPTIONAL_PAYLOAD_FIELDS = [
  'avatar',
  'householdRegisterProvinceId',
  'height',
  'weight',
  'hasHealthCertificate',
  'healthCertificateTypes',
  'educationId',
  'uploadResume',
  'customerLabelList',
  'logId',
] as const;

/**
 * 需要向候选人补充收集的用户侧核心字段。
 * `jobId` 和 `operateType` 由系统上下文提供，不进入用户收单模版。
 */
export const API_BOOKING_USER_REQUIRED_FIELDS = [
  '姓名',
  '联系电话',
  '性别',
  '年龄',
  '面试时间',
] as const;

/**
 * 可能随岗位要求额外需要候选人提供的补充字段。
 */
export const API_BOOKING_USER_OPTIONAL_FIELDS = [
  '学历',
  '健康证情况',
  '健康证类型',
  '籍贯',
  '户籍',
  '户籍省份',
  '身高',
  '体重',
  '简历附件',
  '身份',
  '是否学生',
  '过往公司+岗位+年限',
  '应聘门店',
  '应聘岗位',
] as const;

/**
 * 供工具内部复用的用户侧核心预约字段集合，与当前 supplier/entryUser 契约一致。
 */
export const API_BOOKING_SUBMISSION_FIELDS = [...API_BOOKING_USER_REQUIRED_FIELDS] as const;
