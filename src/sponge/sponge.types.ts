import { z } from 'zod';

/** 岗位查询请求参数 */
export interface JobListQueryParams {
  cityNameList?: string[];
  regionNameList?: string[];
  brandAliasList?: string[];
  storeNameList?: string[];
  jobCategoryList?: string[];
  brandIdList?: number[];
  projectNameList?: string[];
  projectIdList?: number[];
  jobIdList?: number[];
  pageNum?: number;
  pageSize?: number;
  sort?: string;
  sortField?: string;
  options?: JobListOptions;
}

export interface JobListOptions {
  includeBasicInfo?: boolean;
  includeJobSalary?: boolean;
  includeWelfare?: boolean;
  includeHiringRequirement?: boolean;
  includeWorkTime?: boolean;
  includeInterviewProcess?: boolean;
}

/** 岗位基础信息（从 API 返回中提取的常用字段） */
export interface JobBasicInfo {
  jobId: number;
  jobName?: string;
  jobNickName?: string;
  jobCategoryName?: string;
  jobContent?: string;
  laborForm?: string;
  requirementNum?: number;
  minAge?: number;
  maxAge?: number;
  storeName?: string;
  storeAddress?: string;
  storeInfo?: Record<string, unknown>;
  brandName?: string;
  cityName?: string;
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
export interface JobDetail {
  basicInfo?: JobBasicInfo;
  jobSalary?: Record<string, unknown>;
  welfare?: Record<string, unknown>;
  hiringRequirement?: Record<string, unknown>;
  workTime?: Record<string, unknown>;
  interviewProcess?: Record<string, unknown>;
  [key: string]: unknown;
}

export const JobDetailSchema = z
  .object({
    basicInfo: JobBasicInfoSchema.nullish(),
    jobSalary: UnknownRecordSchema.nullish(),
    welfare: UnknownRecordSchema.nullish(),
    hiringRequirement: UnknownRecordSchema.nullish(),
    workTime: UnknownRecordSchema.nullish(),
    interviewProcess: UnknownRecordSchema.nullish(),
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
  name: string;
  aliases: string[];
  projectIdList: number[];
}

export const RawBrandItemSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  projectIdList: z.array(z.number()).default([]),
});

/** 品牌（精简，供事实提取使用） */
export interface BrandItem {
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
  name: string;
  phone: string;
  age: string;
  genderId: number;
  jobId: number;
  interviewTime: string;
  educationId: number;
  hasHealthCertificate: number;
}

/** 面试预约响应 */
export interface InterviewBookingResult {
  success: boolean;
  code?: number;
  message?: string;
  notice?: string | null;
  errorList?: unknown[] | null;
}

export const InterviewBookingApiResponseSchema = z
  .object({
    code: z.number(),
    message: z.string().optional(),
    data: z
      .object({
        notice: z.string().nullable().optional(),
        errorList: z.array(z.unknown()).nullable().optional(),
      })
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
  regionName?: string;
  companyName?: string;
  orderStatus?: string;
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

/** 观远BI 过滤类型 */
export const BI_FILTER_TYPES = {
  GREATER_EQUAL: 'GE',
  LESS_EQUAL: 'LE',
  EQUAL: 'EQ',
  CONTAINS: 'CONTAINS',
} as const;
