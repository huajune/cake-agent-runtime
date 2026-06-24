import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  JobListQueryParams,
  JobListResult,
  InterviewBookingParams,
  InterviewBookingResult,
  BrandItem,
  RawBrandItem,
  BrandListApiResponseSchema,
  InterviewBookingApiResponseSchema,
  InterviewScheduleParams,
  InterviewScheduleItem,
  InterviewScheduleApiResponseSchema,
  BIOrderQueryParams,
  BIOrder,
  JobListApiResponseSchema,
  SelfSignupWorkOrdersParams,
  SignupWorkOrdersParams,
  SignupWorkOrdersResult,
  SignupWorkOrderItem,
  SignupWorkOrdersApiResponseSchema,
  UploadAttachmentApiResponseSchema,
  UploadAttachmentFromUrlParams,
  UploadAttachmentResult,
  CancelWorkOrderParams,
  ModifyInterviewTimeParams,
  WorkOrderMutationResult,
  WorkOrderMutationApiResponseSchema,
  FailureReasonItem,
  FailureReasonsByPidsApiResponseSchema,
} from './sponge.types';
import { SpongeBiService } from './sponge-bi.service';
import { RedisService } from '@infra/redis/redis.service';
import { stripNullish } from '@infra/utils/object.util';
import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';
import { SpongeTokenResolveContext } from './sponge-token.config';

// 报名/上传仍走旧的 supplier 域（a/supplier/*，非 海绵2.0 ai接口，未随网关迁移）。
const INTERVIEW_BOOKING_API = 'https://k8s.duliday.com/persistence/a/supplier/entryUser';
const UPLOAD_ATTACHMENT_API = 'https://k8s.duliday.com/persistence/a/supplier/uploadAttachment';

/** 海绵网关默认 base url（可被 SPONGE_API_BASE_URL 覆盖）。 */
const DEFAULT_SPONGE_API_BASE_URL = 'https://gateway.duliday.com/sponge';

const DEFAULT_PAGE_NUM = 1;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_SORT = 'desc';
const DEFAULT_SORT_FIELD = 'create_time';
const BRAND_LIST_CACHE_TTL_MS = 30 * 60 * 1000;
const FAILURE_REASONS_CACHE_TTL_MS = 30 * 60 * 1000;
const FAILURE_REASONS_CACHE_MAX_ENTRIES = 50;
/** Agent 上下文按 workOrderId 查工单的 Redis 缓存 TTL（秒）。 */
const WORKORDER_CACHE_TTL_SECONDS = 5 * 60;
const MAX_ATTACHMENT_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * 海绵网关在每个响应头里下发的链路追踪 ID。
 *
 * 预约失败时（如"麻麻呀，服务器暂时跑丢了～"这类网关兜底报错），后端需要凭
 * traceId 去查海绵侧日志定位。实测 k8s.duliday.com 网关固定下发 `Traceid` 头
 * （Headers.get 大小写不敏感）；无论成功/失败/坏请求都会带。
 */
const SPONGE_TRACE_HEADER_NAME = 'traceid';

/** 从响应头里提取海绵链路 traceId，取不到返回 null。 */
function extractSpongeTraceId(headers: Headers): string | null {
  return headers.get(SPONGE_TRACE_HEADER_NAME)?.trim() || null;
}

/**
 * 海绵数据服务 — 杜力岱业务数据 HTTP 客户端
 *
 * 负责调用海绵平台 API（岗位查询、面试预约等）。
 * Token 通过 ConfigService 内部管理，工具层无需关心认证。
 * BI 相关功能委托给 SpongeBiService。
 */
@Injectable()
export class SpongeService {
  private readonly logger = new Logger(SpongeService.name);
  private readonly fallbackToken: string;
  private readonly jobListApi: string;
  private readonly brandListApi: string;
  private readonly interviewScheduleApi: string;
  private readonly signupListApi: string;
  private readonly selfSignupListApi: string;
  private readonly cancelWorkOrderApi: string;
  private readonly modifyInterviewTimeApi: string;
  private readonly failureReasonsApi: string;
  private brandListCache: { data: BrandItem[]; fetchedAt: number } | null = null;
  private brandListFetchPromise: Promise<BrandItem[]> | null = null;
  /** 失败原因字典缓存（key=排序后的 pidList），字典稳定，缓存避免每次取消都打接口。 */
  private readonly failureReasonsCache = new Map<
    string,
    { data: FailureReasonItem[]; fetchedAt: number }
  >();

  constructor(
    private readonly configService: ConfigService,
    private readonly biService: SpongeBiService,
    private readonly redisService: RedisService,
    private readonly hostingMemberConfig: HostingMemberConfigService,
  ) {
    this.fallbackToken = this.configService.get<string>('DULIDAY_API_TOKEN', '');
    const spongeBaseUrl = this.configService
      .get<string>('SPONGE_API_BASE_URL', DEFAULT_SPONGE_API_BASE_URL)
      .replace(/\/+$/, '');
    // 海绵2.0 ai接口统一走网关 base（k8s.duliday.com/persistence → gateway.duliday.com/sponge）。
    this.jobListApi = `${spongeBaseUrl}/ai/api/job/list`;
    this.brandListApi = `${spongeBaseUrl}/ai/api/brand/list`;
    this.interviewScheduleApi = `${spongeBaseUrl}/ai/api/interview/schedule`;
    this.signupListApi = `${spongeBaseUrl}/ai/api/workorder/signup/list`;
    this.selfSignupListApi = `${spongeBaseUrl}/ai/api/workorder/signup/self/list`;
    this.cancelWorkOrderApi = `${spongeBaseUrl}/ai/api/workorder/cancel`;
    this.modifyInterviewTimeApi = `${spongeBaseUrl}/ai/api/workorder/interviewTime/modify`;
    this.failureReasonsApi = `${spongeBaseUrl}/ai/api/workorder/failureReasons/byPids`;
  }

  /** 查询在招岗位列表 */
  async fetchJobs(
    params: JobListQueryParams,
    tokenContext?: SpongeTokenResolveContext,
  ): Promise<JobListResult> {
    const token = await this.resolveDulidayToken(tokenContext);

    const requestBody = {
      pageNum: params.pageNum ?? DEFAULT_PAGE_NUM,
      pageSize: params.pageSize ?? DEFAULT_PAGE_SIZE,
      sort: params.sort ?? DEFAULT_SORT,
      sortField: params.sortField ?? DEFAULT_SORT_FIELD,
      queryParam: {
        ...(params.cityNameList?.length && { cityNameList: params.cityNameList }),
        ...(params.regionNameList?.length && { regionNameList: params.regionNameList }),
        ...(params.brandAliasList?.length && { brandAliasList: params.brandAliasList }),
        ...(params.brandIdList?.length && { brandIdList: params.brandIdList }),
        ...(params.projectNameList?.length && { projectNameList: params.projectNameList }),
        ...(params.projectIdList?.length && { projectIdList: params.projectIdList }),
        ...(params.storeNameList?.length && { storeNameList: params.storeNameList }),
        ...(params.searchJobName?.trim() && { searchJobName: params.searchJobName.trim() }),
        ...(params.jobCategoryList?.length && { jobCategoryList: params.jobCategoryList }),
        ...(params.jobIdList?.length && { jobIdList: params.jobIdList }),
        ...(params.salaryPeriodNameList?.length && {
          salaryPeriodNameList: params.salaryPeriodNameList,
        }),
        // 海绵侧默认 onlySignableJobs=true（仅可报名岗位），仅在显式传入时下发以覆盖默认。
        ...(params.onlySignableJobs != null && { onlySignableJobs: params.onlySignableJobs }),
        ...((params.location?.longitude != null ||
          params.location?.latitude != null ||
          params.location?.range != null) && {
          location: {
            ...(params.location?.longitude != null && { longitude: params.location.longitude }),
            ...(params.location?.latitude != null && { latitude: params.location.latitude }),
            ...(params.location?.range != null && { range: params.location.range }),
          },
        }),
      },
      options: params.options ?? { includeBasicInfo: true },
    };

    const response = await fetch(this.jobListApi, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Duliday-Token': token,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const parsed = JobListApiResponseSchema.safeParse(data);
    if (!parsed.success) {
      this.logger.warn(
        `岗位查询返回结构异常: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
      return { jobs: [], total: 0 };
    }

    if (parsed.data.code !== 0) {
      // 历史上这里曾静默吞错返回 empty，导致 "lng/lat 缺 range" 之类的参数错被
      // 误判为"没岗位"。改为抛错以便上层暴露真实原因。
      const reason = data?.message ?? `code=${parsed.data.code}`;
      this.logger.warn(`岗位查询返回非零: ${reason}`);
      throw new Error(`岗位查询失败: ${reason}`);
    }

    return {
      jobs: parsed.data.data?.result ?? [],
      total: parsed.data.data?.total ?? 0,
    };
  }

  /** 预约面试 */
  async bookInterview(
    params: InterviewBookingParams,
    tokenContext?: SpongeTokenResolveContext,
  ): Promise<InterviewBookingResult> {
    const token = await this.resolveDulidayToken(tokenContext);

    this.logger.log(`预约面试: ${params.name}, jobId=${params.jobId}`);

    const payload = stripNullish({
      jobId: params.jobId,
      interviewTime: params.interviewTime,
      name: params.name,
      phone: params.phone,
      age: params.age,
      genderId: params.genderId,
      avatar: params.avatar,
      householdRegisterProvinceId: params.householdRegisterProvinceId,
      height: params.height,
      weight: params.weight,
      hasHealthCertificate: params.hasHealthCertificate,
      healthCertificateTypes: params.healthCertificateTypes,
      educationId: params.educationId,
      uploadResume: params.uploadResume,
      customerLabelList: params.customerLabelList ?? [],
      logId: params.logId,
      operateType: params.operateType,
    });

    const response = await fetch(INTERVIEW_BOOKING_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Duliday-Token': token,
      },
      body: JSON.stringify(payload),
    });

    // traceId 在 fetch 一拿到响应就抓，无论后续 body 解析成败都能带给排障同学。
    const traceId = extractSpongeTraceId(response.headers);

    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
    }

    const rawData = await response.json();
    const parsed = InterviewBookingApiResponseSchema.safeParse(rawData);
    if (!parsed.success) {
      this.logger.warn(
        `预约接口返回结构异常: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
      return {
        success: false,
        code: -1,
        message: '预约接口返回结构异常',
        notice: null,
        errorList: null,
        traceId,
      };
    }

    const isSuccess = parsed.data.code === 0;

    if (!isSuccess) {
      this.logger.warn(
        `预约失败: ${parsed.data.message || '未知错误'}${traceId ? ` (traceId=${traceId})` : ''}`,
      );
    }

    const workOrderId = parsed.data.data?.workOrder?.workOrderId ?? null;
    if (isSuccess && workOrderId == null) {
      // 成功但未拿到 workOrderId：上游可能改了结构，记一笔便于排查（不阻断流程）
      this.logger.warn('预约成功但响应未携带 workOrderId，请检查海绵返回结构');
    }

    return {
      success: isSuccess,
      code: parsed.data.code,
      message: parsed.data.message,
      notice: parsed.data.data?.notice ?? null,
      errorList: parsed.data.data?.errorList ?? null,
      workOrderId,
      traceId,
    };
  }

  /**
   * 上传附件到海绵侧云存储。
   *
   * WeCom 回调里的 fileUrl 是临时下载地址，不能直接作为 entryUser.uploadResume。
   * 报名前必须先上传附件，拿到 cloudStorageKey 后再传给预约接口。
   */
  async uploadAttachmentFromUrl(
    params: UploadAttachmentFromUrlParams,
    tokenContext?: SpongeTokenResolveContext,
  ): Promise<UploadAttachmentResult> {
    const token = await this.resolveDulidayToken(tokenContext);

    const sourceUrl = params.fileUrl.trim();
    if (!sourceUrl) {
      throw new Error('缺少附件下载地址');
    }

    const downloaded = await this.downloadAttachment(sourceUrl);
    const fileName = this.resolveAttachmentFileName(
      params.fileName,
      sourceUrl,
      downloaded.contentType,
    );
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([downloaded.buffer], { type: downloaded.contentType }),
      fileName,
    );

    this.logger.log(`上传附件: ${fileName}, size=${downloaded.buffer.byteLength}`);

    const response = await fetch(UPLOAD_ATTACHMENT_API, {
      method: 'POST',
      headers: {
        'Duliday-Token': token,
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`上传附件失败: ${response.status} ${response.statusText}`);
    }

    const rawData = await response.json();
    const parsed = UploadAttachmentApiResponseSchema.safeParse(rawData);
    if (!parsed.success) {
      throw new Error(
        `上传附件返回结构异常: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
    }

    if (parsed.data.code !== 0 || !parsed.data.data?.cloudStorageKey) {
      throw new Error(`上传附件失败: ${parsed.data.message || `code=${parsed.data.code}`}`);
    }

    return {
      fileName: parsed.data.data.fileName,
      cloudStorageKey: parsed.data.data.cloudStorageKey,
    };
  }

  /**
   * 查询候选人工单（海绵 signup/list，source of truth）。
   *
   * 约束：workOrderId / phone 至少传一个；响应为该候选人**全部**工单列表。
   * 失败时抛错由调用方决定降级（cron 容忍、Agent 上下文不渲染）。
   */
  async fetchSignupWorkOrders(
    params: SignupWorkOrdersParams,
    tokenContext?: SpongeTokenResolveContext,
  ): Promise<SignupWorkOrdersResult> {
    if (params.workOrderId == null && !params.phone) {
      throw new Error('fetchSignupWorkOrders 需至少传 workOrderId 或 phone');
    }

    const payload = stripNullish({
      workOrderId: params.workOrderId,
      phone: params.phone,
      queryParam: params.queryParam,
    });

    return this.postSignupWorkOrders(this.signupListApi, payload, tokenContext, '海绵工单查询');
  }

  /**
   * 查询当前供应商账号提交的报名工单（海绵 signup/self/list）。
   *
   * 该接口不需要 workOrderId / phone，用 Duliday-Token 识别当前供应商账号。运营日报按
   * botImId 解析托管账号 token 后，用时间段筛选直接取该账号当天报名/通过数据。
   */
  async fetchSelfSignupWorkOrders(
    params: SelfSignupWorkOrdersParams,
    tokenContext?: SpongeTokenResolveContext,
  ): Promise<SignupWorkOrdersResult> {
    const payload = stripNullish({
      queryParam: params.queryParam,
    });

    return this.postSignupWorkOrders(
      this.selfSignupListApi,
      payload,
      tokenContext,
      '海绵当前供应商工单查询',
      { allowDefaultToken: false },
    );
  }

  private async postSignupWorkOrders(
    url: string,
    payload: Record<string, unknown>,
    tokenContext: SpongeTokenResolveContext | undefined,
    label: string,
    options?: { allowDefaultToken?: boolean },
  ): Promise<SignupWorkOrdersResult> {
    const token = await this.resolveDulidayToken(tokenContext, {
      allowDefaultToken: options?.allowDefaultToken ?? true,
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Duliday-Token': token,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`${label}失败: ${response.status} ${response.statusText}`);
    }

    const rawData = await response.json();
    const parsed = SignupWorkOrdersApiResponseSchema.safeParse(rawData);
    if (!parsed.success) {
      this.logger.warn(
        `${label}返回结构异常: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
      return { total: 0, workOrders: [] };
    }

    if (parsed.data.code !== 0) {
      this.logger.warn(`${label}业务失败: ${parsed.data.message || '未知错误'}`);
      return { total: 0, workOrders: [] };
    }

    const data = parsed.data.data;
    const workOrders: SignupWorkOrderItem[] = (data?.workOrders ?? []) as SignupWorkOrderItem[];
    return {
      candidateName: data?.candidateName ?? null,
      gender: data?.gender ?? null,
      phone: data?.phone ?? null,
      age: data?.age ?? null,
      total: data?.total ?? workOrders.length,
      workOrders,
    };
  }

  private async downloadAttachment(
    fileUrl: string,
  ): Promise<{ buffer: ArrayBuffer; contentType: string }> {
    const response = await fetch(fileUrl, {
      method: 'GET',
      headers: { Accept: 'application/pdf,application/octet-stream,*/*' },
    });

    if (!response.ok) {
      throw new Error(`下载附件失败: ${response.status} ${response.statusText}`);
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_UPLOAD_BYTES) {
      throw new Error(`附件过大: ${contentLength} bytes`);
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_ATTACHMENT_UPLOAD_BYTES) {
      throw new Error(`附件过大: ${buffer.byteLength} bytes`);
    }

    return {
      buffer,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
    };
  }

  private resolveAttachmentFileName(
    explicitFileName: string | undefined,
    fileUrl: string,
    contentType: string,
  ): string {
    const explicit = this.sanitizeFileName(explicitFileName);
    if (explicit) return explicit;

    try {
      const pathname = new URL(fileUrl).pathname;
      const fromPath = this.sanitizeFileName(decodeURIComponent(pathname.split('/').pop() ?? ''));
      if (fromPath) return fromPath;
    } catch {
      // Ignore invalid URL path parsing; fall back below.
    }

    if (contentType.includes('pdf')) return 'resume.pdf';
    // 图片简历（手写简历拍照等）：企微图片 URL 的 path 通常没有可用文件名，
    // 按 content-type 补扩展名，避免云存储 key 无后缀导致海绵侧打不开。
    const imageExt = contentType.match(/image\/(jpeg|jpg|png|webp)/i)?.[1]?.toLowerCase();
    if (imageExt) return `resume.${imageExt === 'jpeg' ? 'jpg' : imageExt}`;
    return 'attachment';
  }

  private sanitizeFileName(value: string | undefined): string | null {
    const sanitized = value?.trim().replace(/[\\/]/g, '_');
    return sanitized && sanitized.length > 0 ? sanitized : null;
  }

  /**
   * 按 workOrderId 取单个工单当前状态（Agent 上下文用，带 5min Redis 缓存）。
   *
   * 命中缓存直接返回；miss 调海绵、从候选人工单列表里挑出该条、写缓存。
   * 海绵失败返回 null，由上层决定不渲染。
   */
  async getCachedWorkOrderById(
    workOrderId: number,
    tokenContext?: SpongeTokenResolveContext,
  ): Promise<SignupWorkOrderItem | null> {
    const cacheKey = this.workOrderCacheKey(workOrderId);

    try {
      const cached = await this.redisService.get<SignupWorkOrderItem>(cacheKey);
      if (cached) {
        return cached;
      }
    } catch (error) {
      this.logger.warn(`读取工单缓存失败 workOrderId=${workOrderId}: ${this.errorMessage(error)}`);
    }

    let result: SignupWorkOrdersResult;
    try {
      result = await this.fetchSignupWorkOrders({ workOrderId }, tokenContext);
    } catch (error) {
      this.logger.warn(`查询工单失败 workOrderId=${workOrderId}: ${this.errorMessage(error)}`);
      return null;
    }

    const target = result.workOrders.find((wo) => wo.workOrderId === workOrderId) ?? null;
    if (target) {
      try {
        await this.redisService.setex(cacheKey, WORKORDER_CACHE_TTL_SECONDS, target);
      } catch (error) {
        this.logger.warn(
          `写入工单缓存失败 workOrderId=${workOrderId}: ${this.errorMessage(error)}`,
        );
      }
    }
    return target;
  }

  private workOrderCacheKey(workOrderId: number): string {
    return `sponge:workorder:${workOrderId}`;
  }

  /**
   * 失效单个工单的实时状态缓存。
   *
   * 工单状态变更（取消 / 改约）成功后调用：清掉 5min 缓存，确保下一轮 [当前预约信息]
   * 重新拉取到最新状态，不会继续渲染旧态。失败仅 warn，不阻断主流程。
   */
  private async invalidateWorkOrderCache(workOrderId: number): Promise<void> {
    try {
      await this.redisService.del(this.workOrderCacheKey(workOrderId));
    } catch (error) {
      this.logger.warn(`失效工单缓存失败 workOrderId=${workOrderId}: ${this.errorMessage(error)}`);
    }
  }

  /**
   * 取消工单（海绵 ai/api/workorder/cancel）。
   *
   * 成功后失效该工单的状态缓存。接口非 2xx 抛错由调用方兜底（自助失败再转人工）；
   * 业务 code≠0 返回 success:false（不抛），让工具按失败话术处理。
   */
  async cancelWorkOrder(
    params: CancelWorkOrderParams,
    tokenContext?: SpongeTokenResolveContext,
  ): Promise<WorkOrderMutationResult> {
    const token = await this.resolveDulidayToken(tokenContext);

    this.logger.log(
      `取消工单: workOrderId=${params.workOrderId}, cancelReasonId=${params.cancelReasonId}`,
    );

    const payload = stripNullish({
      workOrderId: params.workOrderId,
      cancelReasonId: params.cancelReasonId,
      cancelReasonDesc: params.cancelReasonDesc,
    });

    const result = await this.mutateWorkOrder(this.cancelWorkOrderApi, payload, '取消工单', token);
    if (result.success) {
      await this.invalidateWorkOrderCache(params.workOrderId);
    }
    return result;
  }

  /**
   * 修改约面时间（海绵 ai/api/workorder/interviewTime/modify）。
   *
   * 成功后失效该工单的状态缓存。newInterviewTime 格式 yyyy-MM-dd HH:mm，由工具层校验。
   */
  async modifyInterviewTime(
    params: ModifyInterviewTimeParams,
    tokenContext?: SpongeTokenResolveContext,
  ): Promise<WorkOrderMutationResult> {
    const token = await this.resolveDulidayToken(tokenContext);

    this.logger.log(
      `修改约面时间: workOrderId=${params.workOrderId}, newInterviewTime=${params.newInterviewTime}`,
    );

    const payload = {
      workOrderId: params.workOrderId,
      newInterviewTime: params.newInterviewTime,
    };

    const result = await this.mutateWorkOrder(
      this.modifyInterviewTimeApi,
      payload,
      '修改约面时间',
      token,
    );
    if (result.success) {
      await this.invalidateWorkOrderCache(params.workOrderId);
    }
    return result;
  }

  /**
   * 工单变更类接口的统一 POST 执行（cancel / interviewTime/modify 同形返回）。
   * 接口非 2xx 抛错；结构异常 / 业务 code≠0 返回 success:false。
   */
  private async mutateWorkOrder(
    url: string,
    payload: Record<string, unknown>,
    label: string,
    token: string,
  ): Promise<WorkOrderMutationResult> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Duliday-Token': token,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`${label}失败: ${response.status} ${response.statusText}`);
    }

    const rawData = await response.json();
    const parsed = WorkOrderMutationApiResponseSchema.safeParse(rawData);
    if (!parsed.success) {
      this.logger.warn(
        `${label}接口返回结构异常: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
      return { success: false, code: -1, message: `${label}接口返回结构异常` };
    }

    const isSuccess = parsed.data.code === 0;
    if (!isSuccess) {
      this.logger.warn(`${label}失败: ${parsed.data.message || '未知错误'}`);
    }

    return { success: isSuccess, code: parsed.data.code, message: parsed.data.message };
  }

  /**
   * 按父级原因 ID 列表查询失败原因字典（海绵 ai/api/workorder/failureReasons/byPids）。
   *
   * 返回扁平化的叶子原因列表（{ id, info }）。取消工单时用某父级 pid 拉取候选取消原因，
   * 由 LLM 据候选人原话挑选 id 作为 cancelReasonId。字典稳定，带 30min 进程内缓存。
   * 接口非 2xx 抛错；结构异常 / 业务 code≠0 返回空数组（由调用方决定降级）。
   */
  async fetchFailureReasonsByPids(
    pidList: number[],
    tokenContext?: SpongeTokenResolveContext,
  ): Promise<FailureReasonItem[]> {
    const cacheKey = [...pidList].sort((a, b) => a - b).join(',');
    const cached = this.failureReasonsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < FAILURE_REASONS_CACHE_TTL_MS) {
      return cached.data;
    }

    const token = await this.resolveDulidayToken(tokenContext);

    const response = await fetch(this.failureReasonsApi, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Duliday-Token': token,
      },
      body: JSON.stringify({ pidList }),
    });

    if (!response.ok) {
      throw new Error(`失败原因字典查询失败: ${response.status} ${response.statusText}`);
    }

    const rawData = await response.json();
    const parsed = FailureReasonsByPidsApiResponseSchema.safeParse(rawData);
    if (!parsed.success) {
      this.logger.warn(
        `失败原因字典返回结构异常: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
      return [];
    }

    if (parsed.data.code !== 0) {
      this.logger.warn(`失败原因字典业务失败: ${parsed.data.message || '未知错误'}`);
      return [];
    }

    const reasons: FailureReasonItem[] = (parsed.data.data ?? []).flatMap((group) =>
      (group.failureReasonsDTOList ?? [])
        .filter((item): item is { id: number; info?: string | null } => item.id != null)
        .map((item) => ({ id: item.id, info: item.info ?? '' })),
    );

    this.setFailureReasonsCache(cacheKey, reasons);
    return reasons;
  }

  private setFailureReasonsCache(cacheKey: string, data: FailureReasonItem[]): void {
    if (
      !this.failureReasonsCache.has(cacheKey) &&
      this.failureReasonsCache.size >= FAILURE_REASONS_CACHE_MAX_ENTRIES
    ) {
      this.failureReasonsCache.clear();
    }
    this.failureReasonsCache.set(cacheKey, { data, fetchedAt: Date.now() });
  }

  private async resolveDulidayToken(
    tokenContext?: SpongeTokenResolveContext,
    options?: { allowMissing?: boolean; allowDefaultToken?: boolean },
  ): Promise<string> {
    const allowDefaultToken = options?.allowDefaultToken !== false;
    const configuredToken = await this.resolveConfiguredDulidayToken(tokenContext);
    const token = configuredToken ?? (allowDefaultToken ? this.fallbackToken.trim() : '');

    if (!token && !options?.allowMissing) {
      throw new Error('缺少 DULIDAY_API_TOKEN');
    }

    return token;
  }

  private async resolveConfiguredDulidayToken(
    tokenContext?: SpongeTokenResolveContext,
  ): Promise<string | null> {
    // 单一配置源：system_config.hosting_member_config（按 botImId 数字 wxid 索引，
    // 内部已归一化 prod-sync: 前缀）。查不到返回 null，由调用方回退 DULIDAY_API_TOKEN。
    // 注：daily_ops_report.bot_im_id 历史上可能落 wecomUserId，但调用方（运营日报 cron）
    // 已在调用前归一化为当前托管账号的数字 wxid，故此处只按 botImId 解析即可命中。
    return this.hostingMemberConfig.resolveDulidayToken(tokenContext?.botImId);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 获取品牌列表（含别名）
   *
   * 返回 { name, aliases }[] 格式，供事实提取时品牌别名映射使用。
   * API 不可用时返回空数组（graceful 降级）。
   */
  async fetchBrandList(): Promise<BrandItem[]> {
    const now = Date.now();
    if (
      this.brandListCache &&
      now - this.brandListCache.fetchedAt < BRAND_LIST_CACHE_TTL_MS &&
      this.brandListCache.data.length > 0
    ) {
      return this.brandListCache.data;
    }

    const token = await this.resolveDulidayToken(undefined, { allowMissing: true });
    if (!token) {
      this.logger.warn('缺少 DULIDAY_API_TOKEN，品牌列表不可用');
      return this.brandListCache?.data ?? [];
    }

    if (this.brandListFetchPromise) {
      return this.brandListFetchPromise;
    }

    this.brandListFetchPromise = (async () => {
      try {
        const response = await fetch(this.brandListApi, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Duliday-Token': token,
          },
          body: JSON.stringify({ pageNum: 1, pageSize: 1000 }),
        });

        if (!response.ok) {
          this.logger.warn(`品牌列表 API 返回 ${response.status}`);
          return this.brandListCache?.data ?? [];
        }

        const rawData = await response.json();
        const parsed = BrandListApiResponseSchema.safeParse(rawData);
        if (!parsed.success) {
          this.logger.warn(
            `品牌列表返回结构异常: ${parsed.error.issues
              .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
              .join('; ')}`,
          );
          return this.brandListCache?.data ?? [];
        }

        if (parsed.data.code !== 0 || !parsed.data.data?.result) {
          this.logger.warn('品牌列表返回非零: ' + (parsed.data.message || parsed.data.code));
          return this.brandListCache?.data ?? [];
        }

        const brandList = (parsed.data.data.result as RawBrandItem[]).map((item) => ({
          id: item.id,
          name: item.name,
          aliases: (item.aliases ?? []).filter((a: string) => a !== item.name),
        }));

        this.brandListCache = {
          data: brandList,
          fetchedAt: Date.now(),
        };

        return brandList;
      } catch (err) {
        this.logger.warn('品牌列表获取失败，降级为空列表', err);
        return this.brandListCache?.data ?? [];
      } finally {
        this.brandListFetchPromise = null;
      }
    })();

    return this.brandListFetchPromise;
  }

  // ==================== 观远BI（委托 SpongeBiService）====================

  async fetchBIOrders(params: BIOrderQueryParams): Promise<BIOrder[]> {
    return this.biService.fetchBIOrders(params);
  }

  async refreshBIDataSource(): Promise<boolean> {
    return this.biService.refreshBIDataSource();
  }

  async refreshBIDataSourceAndWait(): Promise<boolean> {
    return this.biService.refreshBIDataSourceAndWait();
  }

  // ==================== 海绵面试名单 ====================

  /**
   * 获取面试名单
   *
   * POST /persistence/ai/api/interview/schedule
   * 认证方式与岗位接口一致（Duliday-Token）
   */
  async fetchInterviewSchedule(params: InterviewScheduleParams): Promise<InterviewScheduleItem[]> {
    const token = await this.resolveDulidayToken(undefined, { allowMissing: true });
    if (!token) {
      this.logger.warn('缺少 DULIDAY_API_TOKEN，面试名单不可用');
      return [];
    }

    try {
      const requestBody: Record<string, unknown> = {
        pageNum: params.pageNum ?? 1,
        pageSize: params.pageSize ?? 100,
        queryParam: {
          interviewStartTime: params.interviewStartTime,
          interviewEndTime: params.interviewEndTime,
          ...(params.cityName && { cityName: params.cityName }),
          ...(params.brandName && { brandName: params.brandName }),
        },
      };

      const response = await fetch(this.interviewScheduleApi, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Duliday-Token': token,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
      }

      const rawData = await response.json();
      const parsed = InterviewScheduleApiResponseSchema.safeParse(rawData);
      if (!parsed.success) {
        this.logger.warn(
          `面试名单返回结构异常: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')}`,
        );
        return [];
      }

      if (parsed.data.code !== 0) {
        this.logger.warn('面试名单查询返回非零: ' + (parsed.data.message || parsed.data.code));
        return [];
      }

      return (parsed.data.data?.result as InterviewScheduleItem[]) || [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`获取面试名单失败: ${message}`);
      throw new Error(`面试名单获取失败: ${message}`);
    }
  }
}
