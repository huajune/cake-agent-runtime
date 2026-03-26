import { Injectable, Logger } from '@nestjs/common';
import { SpongeService } from '@sponge/sponge.service';
import { NotificationStrategy } from './notification.strategy';
import { BrandRotationService } from '../services/brand-rotation.service';
import { GroupTaskType, GroupContext, NotificationData } from '../group-task.types';
import {
  PART_TIME_JOB_SYSTEM_PROMPT,
  buildPartTimeJobUserMessage,
} from '../prompts/part-time-job.prompt';

const MAX_DISPLAY_STORES = 15;

/**
 * 兼职群通知策略（真实数据 + AI 润色 + 固定尾部）
 *
 * - 数据源：海绵在招岗位 (SpongeService.fetchJobs)
 * - 行业过滤：jobCategoryName 包含"零售" → 零售，否则 → 餐饮
 * - 品牌轮转：每次推不同品牌，避免重复
 * - AI 负责排版润色，但只能用提供的真实数据
 * - 尾部固定追加（引导语 + 小程序提示）
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

    // 2. 按行业过滤
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const filtered = jobs.filter((job: any) => {
      const category: string = job.basicInfo?.jobCategoryName || '';
      if (context.industry === '零售') {
        return category.includes('零售');
      }
      return !category.includes('零售');
    });

    if (filtered.length === 0) {
      return {
        hasData: false,
        payload: {},
        summary: `${context.city}/${context.industry}: 无岗位`,
      };
    }

    // 3. 按品牌分组
    const brandMap = new Map<string, any[]>();
    for (const job of filtered) {
      const brand: string = job.basicInfo?.brandName;
      if (!brand) continue;
      if (!brandMap.has(brand)) brandMap.set(brand, []);
      brandMap.get(brand)!.push(job);
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

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
        jobs: data.payload.jobs as unknown[],
      }),
    };
  }
}
