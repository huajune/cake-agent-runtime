import { z } from 'zod';

/** 岗位查询请求参数 */
export interface JobListQueryParams {
  cityNameList?: string[];
  regionNameList?: string[];
  brandAliasList?: string[];
  storeNameList?: string[];
  /** 岗位名称模糊匹配（对整条 jobName 子串匹配，jobName 形如「品牌-门店-工种-用工形式」，故传门店名/地标即可按门店模糊召回） */
  searchJobName?: string;
  jobCategoryList?: string[];
  brandIdList?: number[];
  projectNameList?: string[];
  projectIdList?: number[];
  jobIdList?: number[];
  /** 结算周期名称列表（取 salary_period 字典名称，如 日结算/周结算/月结算/半月结/完结） */
  salaryPeriodNameList?: string[];
  /** 是否仅查询可报名岗位；不传时海绵侧默认为 true */
  onlySignableJobs?: boolean;
  pageNum?: number;
  pageSize?: number;
  sort?: string;
  sortField?: string;
  location?: JobListLocation;
  options?: JobListOptions;
}

export interface JobListLocation {
  longitude?: number;
  latitude?: number;
  range?: number;
}

export interface JobListOptions {
  includeBasicInfo?: boolean;
  includeJobSalary?: boolean;
  includeWelfare?: boolean;
  includeHiringRequirement?: boolean;
  includeWorkTime?: boolean;
  includeInterviewProcess?: boolean;
}

/**
 * 岗位基础信息（从 API 返回中提取的常用字段）
 *
 * ⚠️ 现网（海绵 ai/api/job/list）实测：basicInfo 顶层**不返回** requirementNum / minAge /
 * maxAge / storeName / storeAddress / cityName / regionName。它们的真实位置：
 *  - minAge / maxAge → hiringRequirement.basicPersonalRequirements.{minAge,maxAge}
 *  - storeName / storeAddress / 城市 / 大区 → basicInfo.storeInfo.{storeName,storeAddress,storeCityName,storeRegionName}
 *  - requirementNum（招聘人数）→ 当前接口无此字段
 * 下列声明保留仅为前向兼容（万一上游补回）+ 历史 fixture，**不要据此从 basicInfo 顶层取值**。
 */
export interface JobBasicInfo {
  jobId: number;
  jobName?: string;
  jobNickName?: string;
  jobCategoryName?: string;
  jobContent?: string;
  laborForm?: string;
  /** @deprecated 现网不返回，见上方说明 */
  requirementNum?: number;
  /** @deprecated 现网在 hiringRequirement.basicPersonalRequirements.minAge */
  minAge?: number;
  /** @deprecated 现网在 hiringRequirement.basicPersonalRequirements.maxAge */
  maxAge?: number;
  /** @deprecated 现网在 storeInfo.storeName */
  storeName?: string;
  /** @deprecated 现网在 storeInfo.storeAddress */
  storeAddress?: string;
  storeInfo?: Record<string, unknown>;
  brandName?: string;
  /** @deprecated 现网在 storeInfo.storeCityName */
  cityName?: string;
  /** @deprecated 现网在 storeInfo.storeRegionName */
  regionName?: string;
  [key: string]: unknown;
}

const UnknownRecordSchema = z.object({}).catchall(z.unknown());
const NullableOptionalStringSchema = z.string().nullish();
const NullableOptionalNumberSchema = z.number().nullish();

export const JobBasicInfoSchema = z
  .object({
    jobId: z.number().int(),
    jobName: NullableOptionalStringSchema,
    jobNickName: NullableOptionalStringSchema,
    jobCategoryName: NullableOptionalStringSchema,
    jobContent: NullableOptionalStringSchema,
    laborForm: NullableOptionalStringSchema,
    requirementNum: NullableOptionalNumberSchema,
    minAge: NullableOptionalNumberSchema,
    maxAge: NullableOptionalNumberSchema,
    storeName: NullableOptionalStringSchema,
    storeAddress: NullableOptionalStringSchema,
    storeInfo: UnknownRecordSchema.nullish(),
    brandName: NullableOptionalStringSchema,
    cityName: NullableOptionalStringSchema,
    regionName: NullableOptionalStringSchema,
  })
  .catchall(z.unknown());

/** 岗位详情（包含薪资、福利等可选信息） */
export interface JobInterviewSupplementItem {
  interviewSupplementId?: number | null;
  interviewSupplement?: string | null;
  InterviewSupplementId?: number | null;
  InterviewSupplement?: string | null;
  [key: string]: unknown;
}

export interface JobInterviewProcess {
  interviewSupplement?: JobInterviewSupplementItem[] | null;
  [key: string]: unknown;
}

export interface JobDetail {
  basicInfo?: JobBasicInfo;
  jobSalary?: Record<string, unknown>;
  welfare?: Record<string, unknown>;
  hiringRequirement?: Record<string, unknown>;
  workTime?: Record<string, unknown>;
  interviewProcess?: JobInterviewProcess | Record<string, unknown>;
  [key: string]: unknown;
}

const JobInterviewSupplementItemSchema = z
  .object({
    interviewSupplementId: z.number().nullish(),
    interviewSupplement: z.string().nullish(),
    InterviewSupplementId: z.number().nullish(),
    InterviewSupplement: z.string().nullish(),
  })
  .catchall(z.unknown());

const JobInterviewProcessSchema = z
  .object({
    interviewSupplement: z.array(JobInterviewSupplementItemSchema).nullish(),
  })
  .catchall(z.unknown());

export const JobDetailSchema = z
  .object({
    basicInfo: JobBasicInfoSchema.nullish(),
    jobSalary: UnknownRecordSchema.nullish(),
    welfare: UnknownRecordSchema.nullish(),
    hiringRequirement: UnknownRecordSchema.nullish(),
    workTime: UnknownRecordSchema.nullish(),
    interviewProcess: JobInterviewProcessSchema.nullish(),
  })
  .catchall(z.unknown());

/** 岗位查询响应 */
export interface JobListResult {
  jobs: JobDetail[];
  total: number;
}

export const JobListApiResponseSchema = z
  .object({
    code: z.number(),
    message: z.string().optional(),
    data: z
      .object({
        result: z.array(JobDetailSchema).default([]),
        total: z.number().default(0),
      })
      .nullish(),
  })
  .passthrough();

/** 品牌列表 API 原始响应项 */
export interface RawBrandItem {
  /** 品牌ID（海绵2.0 新增） */
  id?: number;
  name: string;
  aliases: string[];
  projectIdList: number[];
}

export const RawBrandItemSchema = z.object({
  id: z.number().nullish(),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  projectIdList: z.array(z.number()).default([]),
});

/** 品牌（精简，供事实提取使用） */
export interface BrandItem {
  /** 品牌ID（海绵2.0 新增；旧响应缺失时为空） */
  id?: number;
  name: string;
  aliases: string[];
}

export const BrandListApiResponseSchema = z
  .object({
    code: z.number(),
    message: z.string().optional(),
    data: z
      .object({
        result: z.array(RawBrandItemSchema).default([]),
        total: z.number().nullish(),
      })
      .optional(),
  })
  .passthrough();

/** 面试名单查询参数 */
export interface InterviewScheduleParams {
  /** 面试开始时间 YYYY-MM-DD HH:mm:ss */
  interviewStartTime: string;
  /** 面试结束时间 YYYY-MM-DD HH:mm:ss */
  interviewEndTime: string;
  /** 城市名称 */
  cityName?: string;
  /** 品牌名称 */
  brandName?: string;
  /** 页码，默认 1 */
  pageNum?: number;
  /** 每页条数，默认 100 */
  pageSize?: number;
}

/** 面试名单响应项 */
export interface InterviewScheduleItem {
  /** 候选人姓名 */
  name: string;
  /** 候选人电话 */
  phone: string;
  /** 候选人性别（"男"/"女"），上游缺失时为空 */
  gender?: string;
  /** 候选人年龄，上游缺失时为空 */
  age?: number;
  /** 面试时间 YYYY-MM-DD HH:mm */
  interviewTime: string;
  /** 应聘岗位 */
  jobName: string;
  /** 面试门店 */
  storeName: string;
  /** 所属品牌 */
  brandName: string;
}

export const InterviewScheduleItemSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  gender: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  age: z
    .number()
    .nullish()
    .transform((value) => value ?? undefined),
  interviewTime: z.string().min(1),
  jobName: z.string().min(1),
  storeName: z.string().min(1),
  brandName: z.string().min(1),
});

/** 面试名单查询结果 */
export interface InterviewScheduleResult {
  interviews: InterviewScheduleItem[];
  total: number;
}

/** 面试预约请求参数 */
export interface InterviewBookingParams {
  jobId: number;
  /** 面试时间；无面试时段（等通知）岗位不传，stripNullish 会将其从 payload 中剔除 */
  interviewTime?: string;
  name: string;
  phone: string;
  age: number;
  genderId: number;
  operateType: number;
  avatar?: string;
  householdRegisterProvinceId?: number;
  height?: number;
  weight?: number;
  hasHealthCertificate?: number;
  healthCertificateTypes?: number[];
  educationId?: number;
  uploadResume?: string;
  customerLabelList?: InterviewBookingCustomerLabel[];
  logId?: number;
}

export interface InterviewBookingCustomerLabel {
  labelId: number;
  labelName: string;
  name: string;
  value?: string;
}

export interface UploadAttachmentFromUrlParams {
  fileUrl: string;
  fileName?: string;
}

export interface UploadAttachmentResult {
  fileName: string;
  cloudStorageKey: string;
}

export interface InterviewBookingErrorItem {
  field: string;
  msg: string;
}

/** 面试预约响应 */
export interface InterviewBookingResult {
  success: boolean;
  code?: number;
  message?: string;
  notice?: string | null;
  errorList?: InterviewBookingErrorItem[] | null;
  /**
   * 海绵工单 ID（预约成功时返回）。
   *
   * ⚠️ 历史 bug：旧 schema 未解析 `data.workOrder`，导致 recruitment_cases.booking_id
   * 全部为 NULL、本地状态与海绵脱节。修复后这里携带真正的 workOrderId，
   * 供 active_booking 指针与 ops_events(booking.succeeded) 使用。
   */
  workOrderId?: number | null;
  /**
   * 海绵网关响应头里的链路追踪 ID（取不到为 null）。
   *
   * 预约失败时透传到「面试预约失败」告警卡片，方便后端凭此查海绵侧日志排障。
   */
  traceId?: string | null;
}

/**
 * Sponge `customerLabel.value` 字段最大长度。
 *
 * 来源：杜力岱后台对岗位补充字段值的硬约束。booking 工具的 customer-label
 * builder 在拼装入参前会先按本常量裁剪/校验，避免接口报错。
 */
export const SPONGE_CUSTOMER_LABEL_MAX_LENGTH = 51;

export const InterviewBookingCustomerLabelSchema = z.object({
  labelId: z.number().int(),
  labelName: z.string().min(1),
  name: z.string().min(1),
  value: z.string().max(SPONGE_CUSTOMER_LABEL_MAX_LENGTH).optional(),
});

export const InterviewBookingErrorItemSchema = z.object({
  field: z.string().min(1),
  msg: z.string().min(1),
});

export const InterviewBookingApiResponseSchema = z
  .object({
    code: z.number(),
    message: z.string().optional(),
    data: z
      .object({
        notice: z.string().nullable().optional(),
        errorList: z.array(InterviewBookingErrorItemSchema).nullable().optional(),
        // 预约成功时海绵返回的工单对象。int64，可能以 number 或 string 形式下发，
        // 统一 coerce 成 number；缺失时为 null（不阻断解析）。
        workOrder: z
          .object({
            workOrderId: z.coerce.number().int().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

export const UploadAttachmentApiResponseSchema = z
  .object({
    code: z.number(),
    message: z.string().optional(),
    data: z
      .object({
        fileName: z.string(),
        cloudStorageKey: z.string().min(1),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

export const InterviewScheduleApiResponseSchema = z
  .object({
    code: z.number(),
    message: z.string().optional(),
    data: z
      .object({
        result: z.array(InterviewScheduleItemSchema).default([]),
      })
      .optional(),
  })
  .passthrough();

// ==================== 观远BI 类型 ====================

/** 观远BI 订单查询参数 */
export interface BIOrderQueryParams {
  startDate?: string;
  endDate?: string;
  /** BI 的“城市”字段，不是“订单所属地区”字段 */
  cityName?: string;
  companyName?: string;
  orderStatus?: BIOrderStatusCode;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
  refreshBeforeQuery?: boolean;
}

/** 观远BI 订单（行式对象） */
export type BIOrder = Record<string, unknown>;

/** 观远BI 字段名常量 */
export const BI_FIELD_NAMES = {
  COMPANY_NAME: '所属企业',
  CITY: '城市',
  ORDER_DATE: '订单归属日期',
  ORDER_STATUS: '订单状态',
  STORE_NAME: '订单所属门店',
  STORE_ADDRESS: '门店地址',
  BIG_REGION: '大区归属',
  ORDER_REGION: '订单所属地区',
  SERVICE_DATE: '订单计划时间',
  SERVICE_CONTENT: '服务内容',
  EXPECTED_REVENUE: '预计收入',
  SHARE_LINK: '分享链接',
  SHARE_TEXT: '分享文案',
} as const;

/** 观远BI 订单状态（BI API 返回和过滤均使用中文值） */
export const BI_ORDER_STATUS = {
  PENDING_ACCEPTANCE: '待接受',
  IN_PROGRESS: '进行中',
  PENDING_INSPECTION: '待验收',
  INSPECTED: '已验收',
  CONFIRMED: '已确认',
  REJECTED: '已拒绝',
  CANCELED: '已取消',
} as const;

export type BIOrderStatusCode = (typeof BI_ORDER_STATUS)[keyof typeof BI_ORDER_STATUS];

/** 观远BI 过滤类型 */
export const BI_FILTER_TYPES = {
  GREATER_EQUAL: 'GE',
  LESS_EQUAL: 'LE',
  EQUAL: 'EQ',
  CONTAINS: 'CONTAINS',
} as const;

// ==================== 海绵工单查询 signup/list ====================

/**
 * 海绵工单查询参数（POST ${SPONGE_API_BASE_URL}/ai/api/workorder/signup/list）。
 *
 * 两条硬约束：
 * 1. 必须按候选人定位：workOrderId / phone 至少传一个（没有"全局列出所有工单"的查法）。
 * 2. 响应是该候选人**全部**工单列表 → 用 workOrderId 定位时仍要在 workOrders[] 里挑出目标那条。
 */
export interface SignupWorkOrdersParams {
  /** 定位键：定位到某候选人；与 phone 至少传一个 */
  workOrderId?: number;
  /** 定位键：定位到某候选人；与 workOrderId 至少传一个 */
  phone?: string;
  queryParam?: {
    signUpStartTime?: string;
    signUpEndTime?: string;
    interviewPassStartTime?: string;
    interviewPassEndTime?: string;
    /** 当前状态中文列表过滤（9 态之一） */
    currentStatus?: string[];
  };
}

/** 当前供应商账号提交的工单查询参数（POST /ai/api/workorder/signup/self/list）。 */
export interface SelfSignupWorkOrdersParams {
  queryParam?: SignupWorkOrdersParams['queryParam'];
}

/** 单个工单（候选人维度响应的 workOrders[] 元素）。 */
export interface SignupWorkOrderItem {
  workOrderId: number;
  /** self/list 可能把候选人信息下发在工单行上；signup/list 通常下发在顶层。 */
  candidateName?: string | null;
  phone?: string | null;
  signUpTime?: string | null;
  /** 面试通过时间；非空即视为"面试成功"（interview.passed 判定依据）。 */
  interviewPassTime?: string | null;
  brandId?: number | null;
  brandName?: string | null;
  companyId?: number | null;
  companyName?: string | null;
  projectId?: number | null;
  projectName?: string | null;
  jobId?: number | null;
  jobBasicInfoId?: number | null;
  jobName?: string | null;
  /** 当前状态中文：约面待确认/约面失败/约面取消/约面成功/面试失败/面试成功/上岗失败/上岗成功/已离职 */
  currentStatus?: string | null;
  workOrderStatus?: number | string | null;
  salary?: number | string | null;
  salaryUnit?: string | null;
  salaryPeriod?: string | null;
}

/** 候选人维度的工单查询结果。 */
export interface SignupWorkOrdersResult {
  candidateName?: string | null;
  gender?: string | number | null;
  phone?: string | null;
  age?: number | null;
  total: number;
  workOrders: SignupWorkOrderItem[];
}

export const SignupWorkOrderItemSchema = z
  .object({
    workOrderId: z.coerce.number().int(),
    candidateName: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    signUpTime: z.string().nullable().optional(),
    interviewPassTime: z.string().nullable().optional(),
    brandId: z.number().nullable().optional(),
    brandName: z.string().nullable().optional(),
    companyId: z.number().nullable().optional(),
    companyName: z.string().nullable().optional(),
    projectId: z.number().nullable().optional(),
    projectName: z.string().nullable().optional(),
    jobId: z.number().nullable().optional(),
    jobBasicInfoId: z.number().nullable().optional(),
    jobName: z.string().nullable().optional(),
    currentStatus: z.string().nullable().optional(),
    workOrderStatus: z.union([z.number(), z.string()]).nullable().optional(),
    salary: z.union([z.number(), z.string()]).nullable().optional(),
    salaryUnit: z.string().nullable().optional(),
    salaryPeriod: z.string().nullable().optional(),
  })
  .passthrough();

export const SignupWorkOrdersApiResponseSchema = z
  .object({
    code: z.number(),
    message: z.string().optional(),
    data: z
      .object({
        candidateName: z.string().nullable().optional(),
        gender: z.union([z.string(), z.number()]).nullable().optional(),
        phone: z.string().nullable().optional(),
        age: z.number().nullable().optional(),
        total: z.number().nullable().optional(),
        workOrders: z.array(SignupWorkOrderItemSchema).nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

// ==================== 海绵工单变更 cancel / interviewTime/modify ====================

/** 取消工单参数（POST ${SPONGE_API_BASE_URL}/ai/api/workorder/cancel）。 */
export interface CancelWorkOrderParams {
  /** 工单 ID */
  workOrderId: number;
  /** 取消原因 ID（来自失败原因字典）。 */
  cancelReasonId: number;
  /** 取消原因具体描述（候选人原话，可选）。 */
  cancelReasonDesc?: string;
}

/** 修改约面时间参数（POST ${SPONGE_API_BASE_URL}/ai/api/workorder/interviewTime/modify）。 */
export interface ModifyInterviewTimeParams {
  /** 工单 ID */
  workOrderId: number;
  /** 新约面时间，格式 yyyy-MM-dd HH:mm。 */
  newInterviewTime: string;
}

/** 工单变更类接口的统一返回（cancel / interviewTime/modify 同形：code/message/data）。 */
export interface WorkOrderMutationResult {
  success: boolean;
  code: number;
  message?: string;
}

/** cancel / interviewTime/modify 响应结构（data 为字符串，不承载业务数据）。 */
export const WorkOrderMutationApiResponseSchema = z
  .object({
    code: z.number(),
    message: z.string().optional(),
    data: z.string().nullable().optional(),
  })
  .passthrough();

// ==================== 海绵失败原因字典 failureReasons/byPids ====================

/** 单个失败原因（字典叶子项）。 */
export interface FailureReasonItem {
  /** 失败原因 ID（取消工单时作为 cancelReasonId）。 */
  id: number;
  /** 失败原因描述。 */
  info: string;
}

export const FailureReasonsByPidsApiResponseSchema = z
  .object({
    code: z.number(),
    message: z.string().optional(),
    data: z
      .array(
        z
          .object({
            pid: z.number(),
            info: z.string().nullable().optional(),
            failureReasonsDTOList: z
              .array(
                z
                  .object({
                    id: z.coerce.number().int(),
                    info: z.string().nullable().optional(),
                  })
                  .passthrough(),
              )
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();
