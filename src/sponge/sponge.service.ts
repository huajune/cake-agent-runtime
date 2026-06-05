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
  SignupWorkOrdersParams,
  SignupWorkOrdersResult,
  SignupWorkOrderItem,
  SignupWorkOrdersApiResponseSchema,
  UploadAttachmentApiResponseSchema,
  UploadAttachmentFromUrlParams,
  UploadAttachmentResult,
} from './sponge.types';
import { SpongeBiService } from './sponge-bi.service';
import { RedisService } from '@infra/redis/redis.service';
import { stripNullish } from '@infra/utils/object.util';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';
import {
  SPONGE_TOKEN_CONFIG_KEY,
  SpongeTokenAccountConfig,
  SpongeTokenConfig,
  SpongeTokenResolveContext,
  SpongeTokenValue,
} from './sponge-token.config';

const JOB_LIST_API = 'https://k8s.duliday.com/persistence/ai/api/job/list';
const BRAND_LIST_API = 'https://k8s.duliday.com/persistence/ai/api/brand/list';
const INTERVIEW_BOOKING_API = 'https://k8s.duliday.com/persistence/a/supplier/entryUser';
const UPLOAD_ATTACHMENT_API = 'https://k8s.duliday.com/persistence/a/supplier/uploadAttachment';
const INTERVIEW_SCHEDULE_API = 'https://k8s.duliday.com/persistence/ai/api/interview/schedule';

/** 海绵网关默认 base url（可被 SPONGE_API_BASE_URL 覆盖）。 */
const DEFAULT_SPONGE_API_BASE_URL = 'https://gateway.duliday.com/sponge';

const DEFAULT_PAGE_NUM = 1;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_SORT = 'desc';
const DEFAULT_SORT_FIELD = 'create_time';
const BRAND_LIST_CACHE_TTL_MS = 30 * 60 * 1000;
/** Agent 上下文按 workOrderId 查工单的 Redis 缓存 TTL（秒）。 */
const WORKORDER_CACHE_TTL_SECONDS = 5 * 60;
const MAX_ATTACHMENT_UPLOAD_BYTES = 20 * 1024 * 1024;
const TOKEN_CONFIG_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  private readonly signupListApi: string;
  private tokenConfigCache: { value: SpongeTokenConfig | null; expiresAt: number } | null = null;
  private tokenConfigLoadPromise: Promise<SpongeTokenConfig | null> | null = null;
  private brandListCache: { data: BrandItem[]; fetchedAt: number } | null = null;
  private brandListFetchPromise: Promise<BrandItem[]> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly biService: SpongeBiService,
    private readonly redisService: RedisService,
    private readonly systemConfigService: SystemConfigService,
    private readonly hostingMemberConfig: HostingMemberConfigService,
  ) {
    this.fallbackToken = this.configService.get<string>('DULIDAY_API_TOKEN', '');
    const spongeBaseUrl = this.configService
      .get<string>('SPONGE_API_BASE_URL', DEFAULT_SPONGE_API_BASE_URL)
      .replace(/\/+$/, '');
    this.signupListApi = `${spongeBaseUrl}/ai/api/workorder/signup/list`;
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
        ...(params.jobCategoryList?.length && { jobCategoryList: params.jobCategoryList }),
        ...(params.jobIdList?.length && { jobIdList: params.jobIdList }),
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

    const response = await fetch(JOB_LIST_API, {
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
      };
    }

    const isSuccess = parsed.data.code === 0;

    if (!isSuccess) {
      this.logger.warn('预约失败: ' + (parsed.data.message || '未知错误'));
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
    const token = await this.resolveDulidayToken(tokenContext);
    if (params.workOrderId == null && !params.phone) {
      throw new Error('fetchSignupWorkOrders 需至少传 workOrderId 或 phone');
    }

    const payload = stripNullish({
      workOrderId: params.workOrderId,
      phone: params.phone,
      queryParam: params.queryParam,
    });

    const response = await fetch(this.signupListApi, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Duliday-Token': token,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`海绵工单查询失败: ${response.status} ${response.statusText}`);
    }

    const rawData = await response.json();
    const parsed = SignupWorkOrdersApiResponseSchema.safeParse(rawData);
    if (!parsed.success) {
      this.logger.warn(
        `海绵工单查询返回结构异常: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
      return { total: 0, workOrders: [] };
    }

    if (parsed.data.code !== 0) {
      this.logger.warn(`海绵工单查询业务失败: ${parsed.data.message || '未知错误'}`);
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

    return contentType.includes('pdf') ? 'resume.pdf' : 'attachment';
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
    const cacheKey = `sponge:workorder:${workOrderId}`;

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

  private async resolveDulidayToken(
    tokenContext?: SpongeTokenResolveContext,
    options?: { allowMissing?: boolean },
  ): Promise<string> {
    const configuredToken = await this.resolveConfiguredDulidayToken(tokenContext);
    const token = configuredToken ?? this.fallbackToken.trim();

    if (!token && !options?.allowMissing) {
      throw new Error('缺少 DULIDAY_API_TOKEN');
    }

    return token;
  }

  private async resolveConfiguredDulidayToken(
    tokenContext?: SpongeTokenResolveContext,
  ): Promise<string | null> {
    // 统一配置优先：hosting_member_config（按 botImId）→ 回退既有 sponge_token_config / env。
    const memberToken = await this.hostingMemberConfig.resolveDulidayToken(tokenContext?.botImId);
    if (memberToken) return memberToken;

    const config = await this.loadSpongeTokenConfig();
    if (!config) return null;

    const botImId = tokenContext?.botImId?.trim();
    const botUserId = tokenContext?.botUserId?.trim();
    const groupId = tokenContext?.groupId?.trim();

    return (
      this.resolveAccountToken(config, 'botImId', botImId) ??
      this.resolveMappedToken(config.byBotImId, botImId) ??
      this.resolveAccountToken(config, 'botUserId', botUserId) ??
      this.resolveMappedToken(config.byBotUserId, botUserId) ??
      this.resolveAccountToken(config, 'groupId', groupId) ??
      this.resolveMappedToken(config.byGroupId, groupId) ??
      this.resolveTokenValue({
        token: config.defaultToken,
        tokenEnv: config.defaultTokenEnv,
      })
    );
  }

  private async loadSpongeTokenConfig(): Promise<SpongeTokenConfig | null> {
    if (this.tokenConfigCache && Date.now() < this.tokenConfigCache.expiresAt) {
      return this.tokenConfigCache.value;
    }

    if (this.tokenConfigLoadPromise) {
      return this.tokenConfigLoadPromise;
    }

    this.tokenConfigLoadPromise = this.reloadSpongeTokenConfig();
    try {
      return await this.tokenConfigLoadPromise;
    } finally {
      this.tokenConfigLoadPromise = null;
    }
  }

  private async reloadSpongeTokenConfig(): Promise<SpongeTokenConfig | null> {
    try {
      const value = await this.systemConfigService.getConfigValue<unknown>(SPONGE_TOKEN_CONFIG_KEY);
      const config = this.normalizeSpongeTokenConfig(value);
      this.tokenConfigCache = {
        value: config,
        expiresAt: Date.now() + TOKEN_CONFIG_CACHE_TTL_MS,
      };
      return config;
    } catch (error) {
      this.logger.warn(
        `读取海绵 token 配置失败，回退 DULIDAY_API_TOKEN: ${this.errorMessage(error)}`,
      );
      this.tokenConfigCache = {
        value: null,
        expiresAt: Date.now() + TOKEN_CONFIG_CACHE_TTL_MS,
      };
      return null;
    }
  }

  private normalizeSpongeTokenConfig(value: unknown): SpongeTokenConfig | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as SpongeTokenConfig;
  }

  private resolveAccountToken(
    config: SpongeTokenConfig,
    field: 'botImId' | 'botUserId' | 'groupId',
    value: string | undefined,
  ): string | null {
    if (!value || !Array.isArray(config.accounts)) return null;
    const account = config.accounts.find((item) => {
      if (!item || item.enabled === false) return false;
      const candidate = item[field]?.trim();
      return Boolean(candidate) && candidate === value;
    });
    return this.resolveTokenValue(account);
  }

  private resolveMappedToken(
    map: Record<string, SpongeTokenValue> | undefined,
    key: string | undefined,
  ): string | null {
    if (!map || !key) return null;
    return this.resolveTokenValue(map[key]);
  }

  private resolveTokenValue(
    value: SpongeTokenValue | SpongeTokenAccountConfig | undefined | null,
  ): string | null {
    if (!value) return null;
    if (typeof value === 'string') {
      return value.trim() || null;
    }

    const token = value.token?.trim();
    if (token) return token;

    const tokenEnv = value.tokenEnv?.trim();
    if (!tokenEnv) return null;

    return this.configService.get<string>(tokenEnv, '')?.trim() || null;
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
        const response = await fetch(BRAND_LIST_API, {
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

      const response = await fetch(INTERVIEW_SCHEDULE_API, {
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
