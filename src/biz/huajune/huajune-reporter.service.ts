import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  HuajuneCandidate,
  HuajuneEvent,
  HuajuneJob,
  HuajuneSourcePlatform,
} from './huajune.types';

const VALID_PLATFORMS: HuajuneSourcePlatform[] = ['zhipin', 'yupao', 'duliday'];

interface BaseReportInput {
  agentId: string;
  candidateName: string;
  idempotencyKey?: string;
  eventTime?: string;
  job?: HuajuneJob;
  candidateExtra?: Omit<HuajuneCandidate, 'name'>;
}

/**
 * 花卷招聘事件上报。
 *
 * 全部 fire-and-forget：失败只 warn、不阻塞主流程；未配置 HUAJUNE_API_TOKEN 时静默跳过。
 * 幂等由花卷端按 agentId+idempotencyKey 保证（复用 ops_events 的 idempotency_key）。
 *
 * sourcePlatform 取 env HUAJUNE_SOURCE_PLATFORM（默认 duliday；花卷枚举只认 zhipin|yupao|duliday，
 * 不认 cake——“cake”身份体现在 agentId 上）。
 */
@Injectable()
export class HuajuneReporterService {
  private readonly logger = new Logger(HuajuneReporterService.name);
  private readonly endpoint: string;
  private readonly token: string;
  private readonly sourcePlatform: HuajuneSourcePlatform;

  constructor(configService: ConfigService) {
    const baseUrl = configService
      .get<string>('HUAJUNE_API_BASE_URL', 'https://huajune.duliday.com')
      .replace(/\/+$/, '');
    this.endpoint = `${baseUrl}/api/v1/recruitment-events`;
    this.token = configService.get<string>('HUAJUNE_API_TOKEN', '').trim();
    const platform = configService.get<string>('HUAJUNE_SOURCE_PLATFORM', 'duliday').trim();
    this.sourcePlatform = VALID_PLATFORMS.includes(platform as HuajuneSourcePlatform)
      ? (platform as HuajuneSourcePlatform)
      : 'duliday';
  }

  /** 主动打招呼 → candidate_contacted。 */
  reportCandidateContacted(input: BaseReportInput): void {
    this.report({ ...this.baseEvent('candidate_contacted', input), details: {} });
  }

  /** 候选人入站消息 → message_received。 */
  reportMessageReceived(input: BaseReportInput & { unreadCount?: number }): void {
    this.report({
      ...this.baseEvent('message_received', input),
      details: input.unreadCount != null ? { unreadCount: input.unreadCount } : {},
    });
  }

  /** 我方发送消息 → message_sent（content 必填）。主动打招呼场景不要调用本方法（只报 contacted）。 */
  reportMessageSent(input: BaseReportInput & { content: string; isAutoReply?: boolean }): void {
    this.report({
      ...this.baseEvent('message_sent', input),
      details: { content: input.content, isAutoReply: input.isAutoReply ?? true },
    });
  }

  /** 预约成功 → interview_booked（interviewTime 必填）。 */
  reportInterviewBooked(
    input: BaseReportInput & { interviewTime: string; candidatePhone?: string; address?: string },
  ): void {
    this.report({
      ...this.baseEvent('interview_booked', input),
      details: {
        interviewTime: input.interviewTime,
        ...(input.candidatePhone ? { candidatePhone: input.candidatePhone } : {}),
        ...(input.address ? { address: input.address } : {}),
      },
    });
  }

  /** 上岗成功 → candidate_hired。 */
  reportCandidateHired(input: BaseReportInput & { hireDate?: string }): void {
    this.report({
      ...this.baseEvent('candidate_hired', input),
      details: input.hireDate ? { hireDate: input.hireDate } : {},
    });
  }

  private baseEvent(eventType: HuajuneEvent['eventType'], input: BaseReportInput): HuajuneEvent {
    return {
      eventType,
      agentId: input.agentId,
      idempotencyKey: input.idempotencyKey,
      eventTime: input.eventTime,
      candidate: { name: input.candidateName, ...input.candidateExtra },
      job: input.job,
    };
  }

  private report(event: HuajuneEvent): void {
    if (!this.token) {
      this.logger.debug('HUAJUNE_API_TOKEN 未配置，跳过花卷上报');
      return;
    }
    if (!event.agentId || !event.candidate?.name) {
      this.logger.debug(`花卷上报缺少 agentId/candidate.name，跳过: eventType=${event.eventType}`);
      return;
    }
    void this.send({ ...event, sourcePlatform: this.sourcePlatform, dataSource: 'api_callback' });
  }

  private async send(event: HuajuneEvent): Promise<void> {
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ events: [event] }),
      });

      if (!response.ok) {
        this.logger.warn(
          `花卷上报失败 eventType=${event.eventType} status=${response.status} ${response.statusText}`,
        );
        return;
      }

      const body = (await response.json()) as {
        data?: { results?: Array<{ status?: string; error?: { message?: string } }> };
      };
      const result = body.data?.results?.[0];
      if (result?.status === 'error') {
        this.logger.warn(
          `花卷上报被拒 eventType=${event.eventType}: ${result.error?.message ?? '未知原因'}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `花卷上报异常 eventType=${event.eventType}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
