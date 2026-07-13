import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import type { GroupContext } from '@biz/group-task/group-task.types';
import { normalizeCity } from '@biz/group-task/utils/city-normalize.util';
import { formatExtractionFactLines } from '@memory/formatters/fact-lines.formatter';
import { MemoryService } from '@memory/memory.service';
import type {
  InvitedGroupRecord,
  RecommendedJobSummary,
  SessionFacts,
} from '@memory/types/session-facts.types';
import type {
  UserProfileFacts,
  UserProfileFactValue,
  LongTermPreferenceFacts,
  LongTermPreferenceFieldKey,
} from '@memory/types/long-term.types';

const MAX_RECENT_MESSAGES = 8;
const MAX_FACT_LINES = 40;
const MAX_JOBS = 6;

export interface ReplyRepairContext {
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  factLines: string[];
  /** 长期画像渲染成的字段行（含置信度/来源/更新时间），非裸结构。 */
  profileLines: string[];
  /** 历史求职意向渲染成的字段行（快照，仅供参考，以本次会话为准）。 */
  longTermPreferenceLines: string[];
  currentStage?: string | null;
  /** 焦点/已推荐/候选池岗位渲染成的行（带来源标签）。 */
  jobLines: string[];
  /** 已邀请入群记录渲染成的行。 */
  invitedGroupLines: string[];
  groupInventory?: {
    city: string;
    lines: string[];
    hasAnyGroup: boolean;
  };
  warnings?: string[];
}

export interface ReplyRepairJobSummary {
  jobId: number;
  brandName?: string | null;
  jobName?: string | null;
  storeName?: string | null;
  cityName?: string | null;
  regionName?: string | null;
  laborForm?: string | null;
  partTimeJobType?: string | null;
  salaryDesc?: string | null;
  shiftSummary?: string | null;
  distanceKm?: number | null;
  welfareFacts?: RecommendedJobSummary['welfareFacts'];
}

@Injectable()
export class ReplyRepairContextProvider {
  private readonly logger = new Logger(ReplyRepairContextProvider.name);
  private readonly groupMemberLimit: number;

  constructor(
    private readonly memory: MemoryService,
    private readonly groupResolver: GroupResolverService,
    config: ConfigService,
  ) {
    this.groupMemberLimit = parseInt(config.get<string>('GROUP_MEMBER_LIMIT', '200'), 10);
  }

  async build(input: {
    corpId: string;
    userId: string;
    sessionId: string;
    currentUserMessage?: string;
    shortTermEndTimeInclusive?: number;
  }): Promise<ReplyRepairContext> {
    const memory = await this.memory.onTurnStart(
      input.corpId,
      input.userId,
      input.sessionId,
      input.currentUserMessage,
      {
        includeShortTerm: true,
        shortTermEndTimeInclusive: input.shortTermEndTimeInclusive,
      },
    );

    const session = memory.sessionMemory;
    const factLines = session?.facts ? formatExtractionFactLines(session.facts) : [];
    const city = this.readCity(session?.facts ?? null);

    const focusJob = this.toJobSummary(session?.currentFocusJob ?? null);
    const jobLines = [
      ...(focusJob ? [this.formatJob('焦点', focusJob)] : []),
      ...this.toJobSummaries(session?.presentedJobs ?? []).map((job) =>
        this.formatJob('已推荐', job),
      ),
      ...this.toJobSummaries(session?.lastCandidatePool ?? []).map((job) =>
        this.formatJob('候选池', job),
      ),
    ];

    return {
      recentMessages: this.buildRecentMessages(memory.shortTerm.messageWindow),
      factLines: factLines.slice(0, MAX_FACT_LINES),
      profileLines: this.formatProfileLines(memory.longTerm.profile),
      longTermPreferenceLines: this.formatLongTermPreferenceLines(
        memory.longTerm.preferences ?? null,
      ),
      currentStage: memory.procedural.currentStage ?? null,
      jobLines,
      invitedGroupLines: (session?.invitedGroups ?? []).map((group) =>
        this.formatInvitedGroup(group),
      ),
      groupInventory: city ? await this.buildGroupInventory(city) : undefined,
      ...(memory._warnings?.length ? { warnings: memory._warnings } : {}),
    };
  }

  private buildRecentMessages(
    messages: Array<{ role: string; content: string }>,
  ): ReplyRepairContext['recentMessages'] {
    return messages
      .slice(-MAX_RECENT_MESSAGES)
      .map((message): ReplyRepairContext['recentMessages'][number] | null => {
        if (message.role !== 'user' && message.role !== 'assistant') return null;
        const content = this.stripInjectedTimeContext(message.content);
        return content ? { role: message.role, content } : null;
      })
      .filter((message): message is ReplyRepairContext['recentMessages'][number] => !!message);
  }

  private toJobSummaries(jobs: RecommendedJobSummary[]): ReplyRepairJobSummary[] {
    return jobs
      .slice(-MAX_JOBS)
      .map((job) => this.toJobSummary(job))
      .filter(Boolean);
  }

  private toJobSummary(job: RecommendedJobSummary | null): ReplyRepairJobSummary | null {
    if (!job) return null;
    return {
      jobId: job.jobId,
      brandName: job.brandName,
      jobName: job.jobName,
      storeName: job.storeName,
      cityName: job.cityName,
      regionName: job.regionName,
      laborForm: job.laborForm,
      partTimeJobType: job.partTimeJobType ?? null,
      salaryDesc: job.salaryDesc,
      shiftSummary: job.shiftSummary,
      distanceKm: job.distanceKm,
      welfareFacts: job.welfareFacts,
    };
  }

  private formatJob(tag: string, job: ReplyRepairJobSummary): string {
    const name = [job.brandName, job.storeName, job.jobName].filter(Boolean).join('-');
    const meta = [
      job.partTimeJobType && job.partTimeJobType !== job.laborForm
        ? `${job.laborForm ?? '兼职'}(${job.partTimeJobType})`
        : job.laborForm,
      job.salaryDesc,
      job.shiftSummary,
      job.distanceKm != null ? `${job.distanceKm}km` : null,
      this.formatWelfare(job.welfareFacts),
    ]
      .filter(Boolean)
      .join(' / ');
    return `- [${tag}] ${name || `岗位#${job.jobId}`}${meta ? `（${meta}）` : ''}`;
  }

  private formatWelfare(welfare: ReplyRepairJobSummary['welfareFacts']): string | null {
    if (!welfare) return null;
    const labels = {
      company: '公司提供',
      allowance: '仅补贴',
      self_or_none: '无',
      unspecified: '未明确',
    } as const;
    return `员工餐${labels[welfare.meals]}，住宿${labels[welfare.accommodation]}`;
  }

  private formatInvitedGroup(group: InvitedGroupRecord): string {
    return `- ${group.groupName}（${group.city}${group.industry ? `/${group.industry}` : ''}，邀请于 ${group.invitedAt.slice(0, 10)}）`;
  }

  private readCity(facts: SessionFacts | null): string | undefined {
    const value = facts?.preferences?.city?.value;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private async buildGroupInventory(
    city: string,
  ): Promise<ReplyRepairContext['groupInventory'] | undefined> {
    try {
      const allGroups = await this.groupResolver.resolveGroups('兼职群');
      const normalizedTargetCity = normalizeCity(city);
      const cityGroups = allGroups.filter(
        (group) => normalizeCity(group.city) === normalizedTargetCity,
      );

      if (cityGroups.length === 0) {
        return {
          city,
          hasAnyGroup: false,
          lines: [
            '- 该城市暂无可用兼职群',
            '本城市群库为空：不要承诺拉群/进群/发群邀请；礼貌说明后续有匹配会主动联系。',
          ],
        };
      }

      return {
        city,
        hasAnyGroup: true,
        lines: this.summarizeGroups(cityGroups),
      };
    } catch (error) {
      this.logger.warn(`reply repair 群资源读取失败 (city=${city}): ${(error as Error).message}`);
      return undefined;
    }
  }

  private summarizeGroups(groups: GroupContext[]): string[] {
    const byIndustry = new Map<string, { groupCount: number; availableCount: number }>();
    for (const group of groups) {
      const industry = group.industry ?? '未分类';
      const entry = byIndustry.get(industry) ?? { groupCount: 0, availableCount: 0 };
      entry.groupCount += 1;
      const hasCapacity =
        group.memberCount === undefined || group.memberCount < this.groupMemberLimit;
      if (hasCapacity) entry.availableCount += 1;
      byIndustry.set(industry, entry);
    }
    return Array.from(byIndustry.entries())
      .sort((left, right) => right[1].groupCount - left[1].groupCount)
      .map(([industry, stats]) => {
        const capacity =
          stats.availableCount === stats.groupCount
            ? '均有空位'
            : `可用 ${stats.availableCount}/${stats.groupCount}`;
        return `- ${industry}：${stats.groupCount} 个群（${capacity}）`;
      });
  }

  private formatProfileLines(profile: UserProfileFacts | null): string[] {
    if (!profile) return [];
    const lines: string[] = [];
    const push = (
      label: string,
      fact: UserProfileFactValue<unknown> | null,
      render: (value: unknown) => string = String,
    ): void => {
      if (!fact || fact.value === null || fact.value === undefined) return;
      const meta = `（置信度: ${fact.confidence}，来源: ${fact.source}，更新于: ${fact.updatedAt?.slice(0, 10) ?? '未知'}）`;
      lines.push(`- ${label}: ${render(fact.value)}${meta}`);
    };
    push('姓名', profile.name);
    push('联系方式', profile.phone);
    push('性别', profile.gender);
    push('年龄', profile.age);
    push('是否学生', profile.is_student, (value) => (value ? '是' : '否'));
    push('学历', profile.education);
    push('健康证', profile.has_health_certificate);
    return lines;
  }

  private formatLongTermPreferenceLines(prefs: LongTermPreferenceFacts | null): string[] {
    if (!prefs) return [];
    const labels: Array<[LongTermPreferenceFieldKey, string]> = [
      ['city', '意向城市'],
      ['district', '意向区域'],
      ['location', '意向地点'],
      ['brands', '意向品牌'],
      ['position', '意向岗位'],
      ['schedule', '意向班次'],
      ['salary', '意向薪资'],
      ['labor_form', '用工形式'],
      ['schedule_constraint', '排班硬约束'],
      ['delayed_intent', '推迟意向'],
      ['available_after', '最早可面日期'],
    ];
    const lines: string[] = [];
    for (const [key, label] of labels) {
      const fact = prefs[key];
      if (!fact || fact.value === null || fact.value === undefined) continue;
      const rendered = this.renderPreferenceValue(key, fact.value);
      if (rendered) lines.push(`- ${label}: ${rendered}`);
    }
    return lines;
  }

  /** 渲染单个历史意向值；返回 null 表示不注入（如已过期的最早可面日期）。 */
  private renderPreferenceValue(key: LongTermPreferenceFieldKey, value: unknown): string | null {
    if (Array.isArray(value)) {
      return value.length > 0 ? value.map(String).join('、') : null;
    }
    if (key === 'available_after' && typeof value === 'object' && value !== null) {
      const fact = value as { date?: string; raw?: string };
      if (!fact.date) return null;
      const today = new Date().toISOString().slice(0, 10);
      if (fact.date < today) return null; // 过期日期不注入
      return `${fact.date}（原话: ${fact.raw ?? ''}）`;
    }
    if (key === 'delayed_intent' && typeof value === 'object' && value !== null) {
      const fact = value as { until?: string; raw?: string };
      return fact.until ? `${fact.until}（原话: ${fact.raw ?? ''}）` : null;
    }
    if (key === 'schedule_constraint' && typeof value === 'object' && value !== null) {
      const c = value as {
        onlyWeekends?: boolean | null;
        onlyEvenings?: boolean | null;
        onlyMornings?: boolean | null;
        maxDaysPerWeek?: number | null;
      };
      const parts: string[] = [];
      if (c.onlyWeekends) parts.push('只周末');
      if (c.onlyEvenings) parts.push('只晚班');
      if (c.onlyMornings) parts.push('只早班');
      if (c.maxDaysPerWeek) parts.push(`每周最多${c.maxDaysPerWeek}天`);
      return parts.length > 0 ? parts.join('、') : null;
    }
    return String(value);
  }

  private stripInjectedTimeContext(content: string): string {
    return content
      .replace(/\s*(?:\[|【)消息发送时间[:：][\s\S]*?(?:\]|】|$)/g, '')
      .replace(/\s*(?:\[|【)当前时间[:：][\s\S]*?(?:\]|】|$)/g, '')
      .trim();
  }
}
