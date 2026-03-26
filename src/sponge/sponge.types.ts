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

/** 岗位查询响应 */
export interface JobListResult {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  jobs: any[];
  /* eslint-enable @typescript-eslint/no-explicit-any */
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
  /* eslint-disable @typescript-eslint/no-explicit-any */
  errorList?: any[] | null;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
