import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { QueueFailureService } from '@infra/queue/queue-failure.service';
import { ConfigService } from '@nestjs/config';
import { TaskDelegationTokenService } from '@infra/feishu/services/task-delegation-token.service';
import { fetchWithTimeout } from '@infra/utils/fetch-timeout.util';
import type { FeishuTaskMember } from './feishu-task.types';

@Injectable()
export class DelegatedTaskAssignmentService {
  constructor(
    private readonly config: ConfigService,
    private readonly tokens: TaskDelegationTokenService,
    private readonly failures: QueueFailureService,
  ) {}

  /** Keep authorization alive during quiet periods, without creating tasks or notifications. */
  @Cron('0 */15 * * * *')
  async maintainAuthorization(): Promise<void> {
    if (!this.config.get<string>('HENAN_FEISHU_TASK_TASKLIST_GUID')?.trim()) return;
    try {
      await this.tokens.getToken();
    } catch {
      await this.failures.report(
        'feishu.task_delegation_authorization',
        'henan-task-delegator',
        new Error('河南任务用户授权不可用，请检查凭据配置或重新授权'),
      );
    }
  }

  isRequired(tasklistGuid?: string | null): boolean {
    const henan = this.config.get<string>('HENAN_FEISHU_TASK_TASKLIST_GUID')?.trim();
    return !!henan && henan === tasklistGuid;
  }

  async prepare(tasklistGuid: string, members: FeishuTaskMember[]): Promise<string> {
    const openId = this.config.get<string>('FEISHU_TASK_DELEGATOR_OPEN_ID')?.trim();
    if (
      !this.isRequired(tasklistGuid) ||
      !openId ||
      tasklistGuid === this.config.get<string>('FEISHU_TASK_TASKLIST_GUID')?.trim() ||
      members.length === 0 ||
      members.some((m) => !m.id || m.type !== 'user' || m.role !== 'assignee')
    ) {
      throw new Error('Henan task delegation configuration or assignees invalid');
    }
    await this.tokens.getToken();
    return openId;
  }

  async assign(
    taskGuid: string,
    tasklistGuid: string,
    delegatedBy: string,
    members: FeishuTaskMember[],
  ): Promise<void> {
    if (delegatedBy !== (await this.prepare(tasklistGuid, members))) {
      throw new Error('Task delegator changed; review queued assignment before retry');
    }
    const token = await this.tokens.getToken();
    try {
      const response = await fetchWithTimeout(
        `https://open.feishu.cn/open-apis/task/v2/tasks/${encodeURIComponent(taskGuid)}/add_members?user_id_type=open_id`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ members }),
          timeoutMs: 10_000,
          signal: AbortSignal.timeout(12_000),
        },
      );
      const result = (await response.json()) as {
        code?: number;
        data?: { task?: { members?: FeishuTaskMember[] } };
      };
      if (
        !response.ok ||
        result.code !== 0 ||
        !members.every((expected) =>
          result.data?.task?.members?.some(
            (actual) => actual.id === expected.id && actual.role === expected.role,
          ),
        )
      ) {
        throw new Error('Assignment not confirmed');
      }
    } catch {
      // Bull retries only this idempotent add-members operation, never task creation.
      throw new Error('Henan task assignment failed; task retained for assignment retry');
    }
  }
}
