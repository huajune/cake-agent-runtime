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
const RETAIL_BRAND_KEYWORDS = ['奥乐齐', '山姆', '来伊份', '盒马', '全家', '罗森', '便利蜂'];
const CATERING_BRAND_KEYWORDS = [
  '必胜客',
  '肯德基',
  '麦当劳',
  '塔可贝尔',
  '成都你六姐',
  '西贝',
  '大米先生',
  '瑞幸',
  '霸王茶姬',
  '沪上阿姨',
  '茶百道',
  '喜茶',
  '奈雪',
  '蜜雪冰城',
  '星巴克',
];
const RETAIL_ROLE_KEYWORDS = ['理货', '分拣', '导购', '收银'];
const CATERING_ROLE_KEYWORDS = ['服务员', '帮厨', '后厨', '洗碗', '咖啡师', '配菜', '厨'];

/**
 * 兼职群通知策略（真实数据 + AI 润色）
 *
 * - 数据源：海绵在招岗位 (SpongeService.fetchJobs)
 * - 行业过滤：品牌/岗位双重推断匹配群标签行业
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

    // 2. 按行业过滤。海绵当前返回的 jobCategoryName 多为岗位名本身，
    // 不能再假设它是“餐饮/中餐/服务员”这种层级结构，因此改为品牌/岗位双重推断。
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
    const basicInfo = job.basicInfo;
    const brandSignals = [
      basicInfo?.brandName,
      (basicInfo as Record<string, unknown> | undefined)?.projectName,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ');

    if (RETAIL_BRAND_KEYWORDS.some((keyword) => brandSignals.includes(keyword))) {
      return '零售';
    }

    if (CATERING_BRAND_KEYWORDS.some((keyword) => brandSignals.includes(keyword))) {
      return '餐饮';
    }

    const roleSignals = [basicInfo?.jobCategoryName, basicInfo?.jobNickName, basicInfo?.jobName]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ');

    if (RETAIL_ROLE_KEYWORDS.some((keyword) => roleSignals.includes(keyword))) {
      return '零售';
    }

    if (CATERING_ROLE_KEYWORDS.some((keyword) => roleSignals.includes(keyword))) {
      return '餐饮';
    }

    return null;
  }
}
