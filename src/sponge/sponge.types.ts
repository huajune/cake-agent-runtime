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

/** 岗位查询响应 */
export interface JobListResult {
  jobs: JobDetail[];
  total: number;
}

/** 品牌列表 API 原始响应项 */
export interface RawBrandItem {
  name: string;
  aliases: string[];
  projectIdList: number[];
}

/** 品牌（精简，供事实提取使用） */
export interface BrandItem {
  name: string;
  aliases: string[];
}

/** 面试名单查询参数 */
export interface InterviewScheduleParams {
  /** 查询日期 YYYY-MM-DD */
  date: string;
  /** 城市名称 */
  cityName?: string;
  /** 品牌名称 */
  brandName?: string;
  /** 门店 ID */
  storeId?: number;
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
  /** 面试时间 YYYY-MM-DD HH:mm */
  interviewTime: string;
  /** 应聘岗位 */
  jobName: string;
  /** 面试门店 */
  storeName: string;
  /** 所属品牌 */
  brandName: string;
}

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
