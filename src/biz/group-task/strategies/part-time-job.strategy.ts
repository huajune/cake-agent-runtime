import { Injectable, Logger } from '@nestjs/common';
import { SpongeService } from '@sponge/sponge.service';
import { JobDetail } from '@sponge/sponge.types';
import { NotificationStrategy } from './notification.strategy';
import { BrandRotationService } from '../services/brand-rotation.service';
import { GroupTaskType, GroupContext, NotificationData } from '../group-task.types';
import {
  PART_TIME_JOB_SYSTEM_PROMPT,
  buildPartTimeJobUserMessage,
  enforcePartTimeSalaryLine,
} from '../prompts/part-time-job.prompt';

const MAX_DISPLAY_STORES = 15;

/**
 * 兼职群通知策略（真实数据 + AI 润色）
 *
 * - 数据源：海绵在招岗位 (SpongeService.fetchJobs)
 * - 行业过滤：按 jobCategoryName 契约解析一级类目（如 餐饮/中餐/普通服务员）
 * - 品牌轮转：每次推不同品牌，避免重复
 * - AI 负责排版润色，但只能用提供的真实数据
 * - 小程序卡片由 NotificationSenderService 单独发送
 */
@Injectable()
export class PartTimeJobStrategy implements NotificationStrategy {
  private readonly logger = new Logger(PartTimeJobStrategy.name);

  readonly type = GroupTaskType.PART_TIME_JOB;
  readonly tagPrefix = '兼职群';
  readonly needsAI = true;

  constructor(
    private readonly spongeService: SpongeService,
    private readonly brandRotation: BrandRotationService,
  ) {}

  async fetchData(context: GroupContext): Promise<NotificationData> {
    // 1. 拉取该城市所有岗位（含薪资、福利、工作时段）
    const { jobs } = await this.spongeService.fetchJobs({
      cityNameList: [context.city],
      pageSize: 500,
      sort: 'desc',
      sortField: 'create_time',
      options: {
        includeBasicInfo: true,
        includeJobSalary: true,
        includeWelfare: true,
        includeWorkTime: true,
        includeHiringRequirement: true,
      },
    });

    // 2. 按行业过滤。当前契约要求 jobCategoryName 返回层级类目，
    // 例如“餐饮/中餐/普通服务员”或“零售/食品/导购”，这里按一级类目解析。
    const filtered = jobs.filter((job: JobDetail) => {
      if (!context.industry) return true;
      return this.inferIndustry(job) === context.industry;
    });

    if (filtered.length === 0) {
      return {
        hasData: false,
        payload: {},
        summary: `${context.city}/${context.industry}: 无岗位`,
      };
    }

    // 3. 按品牌分组
    const brandMap = new Map<string, JobDetail[]>();
    for (const job of filtered) {
      const brand = job.basicInfo?.brandName;
      if (!brand) continue;
      if (!brandMap.has(brand)) brandMap.set(brand, []);
      brandMap.get(brand)!.push(job);
    }

    // 4. 品牌轮转
    const availableBrands = [...brandMap.keys()];
    const selectedBrand = await this.brandRotation.getNextBrand(context.imRoomId, availableBrands);

    if (!selectedBrand) {
      return {
        hasData: false,
        payload: {},
        summary: `${context.city}/${context.industry}: 无品牌`,
      };
    }

    const selectedJobs = brandMap.get(selectedBrand) || [];
    this.logger.log(
      `[兼职群] ${context.city}/${context.industry} 选中品牌: ${selectedBrand} (${selectedJobs.length}个岗位)`,
    );

    return {
      hasData: selectedJobs.length > 0,
      payload: {
        brand: selectedBrand,
        jobs: selectedJobs,
        hasMore: selectedJobs.length > MAX_DISPLAY_STORES,
      },
      summary: `${context.city}/${context.industry} - ${selectedBrand}: ${selectedJobs.length}个岗位`,
    };
  }

  buildPrompt(
    data: NotificationData,
    context: GroupContext,
  ): { systemPrompt: string; userMessage: string } {
    return {
      systemPrompt: PART_TIME_JOB_SYSTEM_PROMPT,
      userMessage: buildPartTimeJobUserMessage({
        brand: data.payload.brand as string,
        city: context.city,
        industry: context.industry || '餐饮',
        jobs: data.payload.jobs as JobDetail[],
      }),
    };
  }

  appendFooter(aiMessage: string, data: NotificationData): string {
    return enforcePartTimeSalaryLine(aiMessage, data.payload.jobs as JobDetail[]);
  }

  private inferIndustry(job: JobDetail): '餐饮' | '零售' | null {
    const categoryName = job.basicInfo?.jobCategoryName;
    if (typeof categoryName !== 'string' || categoryName.trim().length === 0) {
      return null;
    }

    const primaryCategory = categoryName
      .split('/')
      .map((segment) => segment.trim())
      .find(Boolean);

    if (primaryCategory === '餐饮') return '餐饮';
    if (primaryCategory === '零售') return '零售';

    return null;
  }
}
