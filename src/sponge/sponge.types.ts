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
  includeBasicInfo: boolean;
  includeJobSalary: boolean;
  includeWelfare: boolean;
  includeHiringRequirement: boolean;
  includeWorkTime: boolean;
  includeInterviewProcess: boolean;
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
