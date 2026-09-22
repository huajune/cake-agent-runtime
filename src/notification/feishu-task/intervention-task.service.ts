import { createHash } from 'node:crypto';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { AlertLevel } from '@enums/alert.enum';
import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import type { InterventionPayload } from '@biz/intervention/intervention.service';
import { RedisService } from '@infra/redis/redis.service';
import { formatLocalMinute, parseLocalDateTime } from '@infra/utils/date.util';
import { toErrorMessage } from '@infra/utils/error.util';
import { LongTermService } from '@memory/long-term/long-term.service';
import type { ActiveBookingEntry } from '@memory/long-term/long-term.types';
import { unwrapSessionFactValue } from '@memory/short-term/short-term.types';
import { AlertNotifierService } from '../services/alert-notifier.service';
import { FeishuTaskClient, buildCustomFieldValue } from './feishu-task.client';
import type { FeishuTaskCustomFieldValue, FeishuTaskMember } from './feishu-task.types';
import {
  CATEGORY_META,
  PRIORITY_LABELS,
  maxPriority,
  parsePriority,
  resolveBasePriority,
  resolveReasonCodeLabel,
  resolveTaskCategory,
  type InterventionTaskCategory,
  type InterventionTaskPriority,
} from './intervention-task-category';
import { resolveOptionColorIndex } from './intervention-task-colors';
import {
  COMMENT_MAX_LENGTH,
  buildTaskDescription,
  redactSensitiveNumbers,
  shouldOmitTranscript,
  truncateText,
} from './intervention-task-description';
import { computeFollowUpDue } from './intervention-task-due';

/** system_config 运行时开关键；默认关。 */
export const FEISHU_TASK_CONFIG_KEY = 'feishu_task_config';

export interface FeishuTaskRuntimeConfig {
  enabled: boolean;
}

/**
 * 自定义字段名（PRD R6 表头）。可用 FEISHU_TASK_FIELD_NAMES_JSON 覆盖。
 *
 * 键顺序即清单表头列顺序：飞书自定义字段列顺序 = 创建顺序，事后无法重排
 * （探测脚本按此顺序建字段），改顺序前先确认清单尚未建表头。
 * 介入触发时刻不建自定义字段，由任务内置「开始时间」承载（createTask.startAt，分钟精度）。
 */
export const DEFAULT_FIELD_NAMES = {
  status: '状态',
  priority: '优先级',
  category: '介入大类',
  reasonCode: '原因码',
  nickname: '候选人昵称',
  name: '候选人姓名',
  phone: '手机号',
  hostingAccount: '托管账号',
  workOrderId: '工单号',
  jobId: '岗位 ID',
  brandStore: '品牌门店',
  interviewTime: '面试时间',
  interventionCount: '第几次介入',
  couldBeAutomated: '本可由蛋糕完成',
  remark: '备注',
} as const;

export type FieldKey = keyof typeof DEFAULT_FIELD_NAMES;

/** 「状态」选项：新建时写「待处理」，之后由运营翻为「已处理」；合并追加不改。 */
export const TASK_STATUS_LABELS = {
  pending: '待处理',
  done: '已处理',
} as const;

/**
 * 运营维护的单选字段选项：由脚本建表头；运行时只在新建时写 status=待处理，
 * couldBeAutomated 运行时不写。「备注」是文本字段，运营手填，不在此列。
 */
export const BACKFILL_FIELD_OPTIONS: Partial<Record<FieldKey, string[]>> = {
  status: Object.values(TASK_STATUS_LABELS),
  couldBeAutomated: ['是', '否'],
};

interface OwnerConfig {
  supervisor?: string[];
  T4?: string[];
  T5?: string[];
  T8?: string[];
  default?: string[];
}

interface MergeRecord {
  taskGuid: string;
  firstTriggeredAt: string;
  count: number;
  priority: InterventionTaskPriority;
}

interface TaskDraft {
  category: InterventionTaskCategory;
  categoryLabel: string;
  reasonCode: string | null;
  reasonCodeLabel: string;
  reason: string;
  priority: InterventionTaskPriority;
  title: string;
  description: string;
  dueAt: Date;
  triggeredAt: Date;
  interviewImminent: boolean;
  nickname: string | null;
  candidateName: string | null;
  candidatePhone: string | null;
  hostingAccountName: string | null;
  workOrderId: number | null;
  jobId: number | null;
  brandStore: string | null;
  interviewTimeText: string | null;
  lastCandidateMessage: string;
  members: FeishuTaskMember[];
  mergeKey: string;
  clientToken: string;
}

const TEST_CORP_IDS = new Set(['test', 'debug']);
const TEST_SESSION_PREFIXES = ['test-', 'p1-fixed-', 'p2-fixed-', 'p3-fixed-'];
const MERGE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MERGE_KEY_PREFIX = 'feishu-task:intervention:v1';
const RUNTIME_CONFIG_TTL_MS = 30 * 1000;
const TITLE_REASON_MAX = 30;

/**
 * 人工介入 → 飞书任务（G2 + G3）。
 *
 * 输入一次介入 payload，输出：按 PRD R6 表头组装任务、按上班时间算最晚跟进时间、
 * 合并键（会话 + 大类，T5 按岗位）命中时追加评论并刷新 due / 优先级 / 标题前缀。
 * 任务数据不落库，只留 Redis 合并键（7 天）。任何失败只记日志 + 飞书告警，不抛给调用方。
 */
@Injectable()
export class InterventionTaskService implements OnApplicationBootstrap {
  private readonly logger = new Logger(InterventionTaskService.name);
  private readonly tasklistGuid: string;
  private readonly fieldNames: Record<FieldKey, string>;
  private readonly owners: OwnerConfig;
  private runtimeConfig: FeishuTaskRuntimeConfig | null = null;
  private runtimeConfigExpiry = 0;
  private longTermService: LongTermService | null = null;

  constructor(
    private readonly client: FeishuTaskClient,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
    private readonly hostingMemberConfig: HostingMemberConfigService,
    private readonly alertNotifier: AlertNotifierService,
    private readonly moduleRef: ModuleRef,
  ) {
    this.tasklistGuid = (this.configService.get<string>('FEISHU_TASK_TASKLIST_GUID') ?? '').trim();
    this.fieldNames = this.loadFieldNames();
    this.owners = this.loadOwners();
  }

  onApplicationBootstrap(): void {
    // MemoryModule 装配重（Bull/LLM/Sponge），不在模块层 import；装配完成后懒解析，
    // 拿不到时面试时间留空（与 AlertNotifierService 解析 ALERT_LOG_PERSISTER 同款）。
    try {
      this.longTermService = this.moduleRef.get(LongTermService, { strict: false });
    } catch {
      this.logger.warn('LongTermService 未注册，飞书任务的面试时间将留空');
    }
  }

  // ==================== public ====================

  /** 介入提交后异步调用；永不抛错。 */
  async submit(payload: InterventionPayload): Promise<void> {
    try {
      if (this.isTestSession(payload.corpId, payload.chatId)) return;
      if (!(await this.isEnabled())) return;
      const draft = await this.buildDraft(payload);
      const existing = await this.readMergeRecord(draft.mergeKey);
      if (existing && (await this.mergeIntoExisting(existing, draft))) return;
      await this.createNewTask(draft);
    } catch (error) {
      this.logger.warn(
        `[FeishuTask] submit 异常: chatId=${payload.chatId}, error=${toErrorMessage(error)}`,
      );
      await this.alertFailure('submit', payload.chatId, toErrorMessage(error), payload.contactName);
    }
  }

  async isEnabled(): Promise<boolean> {
    if (!this.tasklistGuid) return false;
    const config = await this.getRuntimeConfig();
    return config.enabled;
  }

  async getRuntimeConfig(): Promise<FeishuTaskRuntimeConfig> {
    if (this.runtimeConfig && Date.now() < this.runtimeConfigExpiry) return this.runtimeConfig;
    try {
      const stored =
        await this.systemConfigService.getConfigValue<Partial<FeishuTaskRuntimeConfig>>(
          FEISHU_TASK_CONFIG_KEY,
        );
      this.runtimeConfig = { enabled: stored?.enabled === true };
    } catch (error) {
      this.logger.warn(`[FeishuTask] 读取运行时开关失败，按关闭处理: ${toErrorMessage(error)}`);
      this.runtimeConfig = { enabled: false };
    }
    this.runtimeConfigExpiry = Date.now() + RUNTIME_CONFIG_TTL_MS;
    return this.runtimeConfig;
  }

  getFieldNames(): Record<FieldKey, string> {
    return { ...this.fieldNames };
  }

  // ==================== 组装 ====================

  private async buildDraft(payload: InterventionPayload): Promise<TaskDraft> {
    const triggeredAt = new Date();
    const reasonCode =
      payload.kind === 'conversation_risk' ? payload.riskType : (payload.reasonCode ?? null);
    const category = resolveTaskCategory(reasonCode);
    const categoryLabel = CATEGORY_META[category].label;
    const reasonCodeLabel = resolveReasonCodeLabel(reasonCode);
    const reason = payload.reason?.trim() || reasonCodeLabel;

    const interviewInfo = payload.sessionState?.facts?.interview_info;
    const candidateName = unwrapSessionFactValue(interviewInfo?.name)?.trim() || null;
    const candidatePhone = unwrapSessionFactValue(interviewInfo?.phone)?.trim() || null;
    const focusJob = payload.sessionState?.currentFocusJob ?? null;
    const workOrderId = payload.kind === 'general_handoff' ? (payload.workOrderId ?? null) : null;

    const booking = await this.lookupBooking(payload.corpId, payload.userId, workOrderId);
    const interviewAt = booking?.interview_time ? parseLocalDateTime(booking.interview_time) : null;
    const jobId = booking?.job_id ?? focusJob?.jobId ?? null;
    const brandStore = focusJob
      ? [focusJob.brandName, focusJob.storeName].filter(Boolean).join('-') || null
      : null;

    const due = computeFollowUpDue({ category, triggeredAt, interviewAt });
    const basePriority = resolveBasePriority({ category, reasonCode, reasonText: reason });
    const priority: InterventionTaskPriority = due.interviewImminent ? 'urgent' : basePriority;
    const interviewTimeText = interviewAt ? formatLocalMinute(interviewAt) : null;
    const hostingAccountName = await this.resolveHostingAccountName(payload);
    const nickname = payload.contactName?.trim() || null;
    const lastCandidateMessage = payload.currentMessageContent?.trim() ?? '';

    const title = this.buildTitle({
      priority,
      categoryLabel,
      nickname,
      brandStore,
      reason,
      interviewTimeText,
      interviewImminent: due.interviewImminent,
    });
    const description = buildTaskDescription({
      category,
      categoryLabel,
      reasonCodeLabel,
      reason,
      actionAdvice: payload.kind === 'general_handoff' ? payload.actionAdvice : null,
      missingJobInfo: payload.kind === 'general_handoff' ? payload.missingJobInfo : null,
      workOrderId: booking?.work_order_id ?? workOrderId,
      jobId,
      brandStore,
      interviewTimeText,
      lastCandidateMessage,
      recentMessages: payload.recentMessages,
      chatId: payload.chatId,
      hostingAccountName,
      candidatePhone,
      triggeredAt,
    });

    const members = await this.resolveMembers(category, payload.botImId);
    const mergeKey =
      category === 'T5' && jobId != null
        ? `${MERGE_KEY_PREFIX}:job:${jobId}:T5`
        : `${MERGE_KEY_PREFIX}:chat:${payload.chatId}:${category}`;
    const minuteBucket = Math.floor(triggeredAt.getTime() / 60_000);
    const clientToken = createHash('sha1')
      .update(`${payload.chatId}|${category}|${reasonCode ?? ''}|${minuteBucket}`)
      .digest('hex');

    return {
      category,
      categoryLabel,
      reasonCode,
      reasonCodeLabel,
      reason,
      priority,
      title,
      description,
      dueAt: due.dueAt,
      triggeredAt,
      interviewImminent: due.interviewImminent,
      nickname,
      candidateName,
      candidatePhone,
      hostingAccountName,
      workOrderId: booking?.work_order_id ?? workOrderId,
      jobId,
      brandStore,
      interviewTimeText,
      lastCandidateMessage,
      members,
      mergeKey,
      clientToken,
    };
  }

  private buildTitle(params: {
    priority: InterventionTaskPriority;
    categoryLabel: string;
    nickname: string | null;
    brandStore: string | null;
    reason: string;
    interviewTimeText: string | null;
    interviewImminent: boolean;
  }): string {
    const oneLineReason = truncateText(
      params.reason.split(/[。；;\n]/)[0] ?? params.reason,
      TITLE_REASON_MAX,
    );
    const parts = [
      params.interviewImminent ? '下班期间触发，面试已临近/已过' : null,
      params.nickname ?? '未知昵称',
      params.brandStore,
      oneLineReason,
      params.interviewTimeText ? `面试 ${params.interviewTimeText}` : null,
    ].filter((part): part is string => Boolean(part));
    return `【${PRIORITY_LABELS[params.priority]}·${params.categoryLabel}】${parts.join(' · ')}`;
  }

  private async buildCustomFields(
    draft: TaskDraft,
    count: number,
    scope: 'create' | 'update',
  ): Promise<FeishuTaskCustomFieldValue[]> {
    const values: FeishuTaskCustomFieldValue[] = [];
    const push = (value: FeishuTaskCustomFieldValue | null) => {
      if (value) values.push(value);
    };
    const text = async (key: FieldKey, value: string | null | undefined) => {
      if (value == null || value === '') return;
      const guid = await this.client.resolveFieldGuid(this.tasklistGuid, this.fieldNames[key]);
      if (guid) push(buildCustomFieldValue(guid, { text: value }));
    };
    const select = async (key: FieldKey, optionName: string | null | undefined) => {
      if (!optionName) return;
      const fieldName = this.fieldNames[key];
      const guid = await this.client.resolveFieldGuid(this.tasklistGuid, fieldName);
      if (!guid) return;
      const optionGuid = await this.client.resolveOptionGuid(
        this.tasklistGuid,
        fieldName,
        optionName,
        resolveOptionColorIndex(key, optionName),
      );
      if (optionGuid) push(buildCustomFieldValue(guid, { singleSelectOptionGuid: optionGuid }));
    };
    const number = async (key: FieldKey, value: number) => {
      const guid = await this.client.resolveFieldGuid(this.tasklistGuid, this.fieldNames[key]);
      if (guid) push(buildCustomFieldValue(guid, { number: value }));
    };

    await select('priority', PRIORITY_LABELS[draft.priority]);
    await number('interventionCount', count);
    await text('interviewTime', draft.interviewTimeText);
    if (scope === 'update') return values;

    await select('status', TASK_STATUS_LABELS.pending);
    await text('nickname', draft.nickname);
    await text('name', draft.candidateName);
    await text('phone', draft.candidatePhone);
    await select('hostingAccount', draft.hostingAccountName);
    await text('workOrderId', draft.workOrderId != null ? String(draft.workOrderId) : null);
    await select('category', draft.categoryLabel);
    await select('reasonCode', draft.reasonCodeLabel);
    await text('brandStore', draft.brandStore);
    await text('jobId', draft.jobId != null ? String(draft.jobId) : null);
    return values;
  }

  // ==================== 创建 / 合并 ====================

  private async createNewTask(draft: TaskDraft): Promise<void> {
    const customFields = await this.buildCustomFields(draft, 1, 'create');
    const sectionGuid = await this.client.resolveSectionGuid(
      this.tasklistGuid,
      `${draft.category === 'UNCLASSIFIED' ? '' : `${draft.category} `}${draft.categoryLabel}`,
    );
    const task = await this.client.createTask({
      summary: draft.title,
      description: draft.description,
      startAt: draft.triggeredAt,
      dueAt: draft.dueAt,
      members: draft.members,
      tasklistGuid: this.tasklistGuid,
      sectionGuid,
      customFields,
      clientToken: draft.clientToken,
    });
    if (!task) {
      await this.alertFailure(
        'createTask',
        draft.mergeKey,
        '飞书任务创建失败（详见日志）',
        draft.nickname,
      );
      return;
    }
    if (draft.members.length === 0) {
      this.logger.warn(
        `[FeishuTask] 任务无负责人（托管账号未配置飞书接收人且无默认负责人）: guid=${task.guid}, key=${draft.mergeKey}`,
      );
    }
    await this.writeMergeRecord(draft.mergeKey, {
      taskGuid: task.guid,
      firstTriggeredAt: draft.triggeredAt.toISOString(),
      count: 1,
      priority: draft.priority,
    });
    this.logger.log(
      `[FeishuTask] 已建任务: guid=${task.guid} category=${draft.category} priority=${draft.priority} due=${formatLocalMinute(draft.dueAt)} key=${draft.mergeKey}`,
    );
  }

  /**
   * 合并命中：追加评论 + 刷新 due / 优先级 / 标题前缀；开始时间保持首次触发时刻不动。
   * 任务已不存在时返回 false 走新建。
   */
  private async mergeIntoExisting(existing: MergeRecord, draft: TaskDraft): Promise<boolean> {
    const count = existing.count + 1;
    const priority = maxPriority(existing.priority, draft.priority);
    const merged: TaskDraft = { ...draft, priority };
    merged.title = this.buildTitle({
      priority,
      categoryLabel: draft.categoryLabel,
      nickname: draft.nickname,
      brandStore: draft.brandStore,
      reason: draft.reason,
      interviewTimeText: draft.interviewTimeText,
      interviewImminent: draft.interviewImminent,
    });
    const customFields = await this.buildCustomFields(merged, count, 'update');
    const updated = await this.client.updateTask(existing.taskGuid, {
      summary: merged.title,
      dueAt: draft.dueAt,
      customFields,
    });
    if (!updated) {
      this.logger.warn(
        `[FeishuTask] 合并更新失败，改为新建: guid=${existing.taskGuid} key=${draft.mergeKey}`,
      );
      return false;
    }
    await this.client.addComment(existing.taskGuid, this.buildMergeComment(draft, count));
    await this.writeMergeRecord(draft.mergeKey, {
      taskGuid: existing.taskGuid,
      firstTriggeredAt: existing.firstTriggeredAt,
      count,
      priority,
    });
    this.logger.log(
      `[FeishuTask] 已合并到既有任务: guid=${existing.taskGuid} count=${count} priority=${priority} due=${formatLocalMinute(draft.dueAt)}`,
    );
    return true;
  }

  private buildMergeComment(draft: TaskDraft, count: number): string {
    const omit = shouldOmitTranscript({
      category: draft.category,
      texts: [draft.reason, draft.lastCandidateMessage],
    });
    const lines = [
      `第 ${count} 次介入 · ${formatLocalMinute(draft.triggeredAt)}`,
      `原因码：${draft.reasonCodeLabel}`,
      `原因：${redactSensitiveNumbers(truncateText(draft.reason, 300), draft.candidatePhone)}`,
      omit
        ? '候选人最后一句：涉及敏感内容，详见企微会话'
        : `候选人最后一句：${redactSensitiveNumbers(truncateText(draft.lastCandidateMessage || '-', 150), draft.candidatePhone)}`,
      `最晚跟进时间已刷新为 ${formatLocalMinute(draft.dueAt)}`,
    ];
    return truncateText(lines.join('\n'), COMMENT_MAX_LENGTH);
  }

  // ==================== 解析 ====================

  private async lookupBooking(
    corpId: string,
    userId: string,
    workOrderId: number | null,
  ): Promise<ActiveBookingEntry | null> {
    if (!this.longTermService) return null;
    try {
      const bookings = await this.longTermService.tryGetActiveBookings(corpId, userId);
      if (!bookings || bookings.length === 0) return null;
      if (workOrderId != null) {
        const hit = bookings.find((entry) => entry.work_order_id === workOrderId);
        if (hit) return hit;
      }
      return bookings[0];
    } catch (error) {
      this.logger.warn(`[FeishuTask] 读取 active_booking 失败: ${toErrorMessage(error)}`);
      return null;
    }
  }

  private async resolveHostingAccountName(payload: InterventionPayload): Promise<string | null> {
    try {
      const entry = await this.hostingMemberConfig.getByBotImId(payload.botImId);
      const nickname = entry?.wecomNickname?.trim() || entry?.feishuName?.trim();
      if (nickname) return nickname;
    } catch (error) {
      this.logger.warn(`[FeishuTask] 读取托管账号配置失败: ${toErrorMessage(error)}`);
    }
    return payload.botUserName?.trim() || payload.botImId?.trim() || null;
  }

  /** 负责人：T7 → 主管；T4/T5/T8 → 配置的对接人；其余 → 托管账号对应运营；缺省回退 default。 */
  private async resolveMembers(
    category: InterventionTaskCategory,
    botImId: string | undefined,
  ): Promise<FeishuTaskMember[]> {
    const meta = CATEGORY_META[category];
    const ordered: string[][] = [];
    if (meta.owner === 'supervisor') ordered.push(this.owners.supervisor ?? []);
    if (meta.owner === 'configured') {
      const configured =
        category === 'T4' || category === 'T5' || category === 'T8'
          ? this.owners[category]
          : undefined;
      ordered.push(configured ?? []);
    }
    const hosting = await this.resolveHostingReceiverOpenId(botImId);
    ordered.push(hosting ? [hosting] : []);
    ordered.push(this.owners.default ?? []);

    const picked = ordered.find((ids) => ids.length > 0) ?? [];
    return Array.from(new Set(picked)).map((id) => ({ id, type: 'user', role: 'assignee' }));
  }

  private async resolveHostingReceiverOpenId(botImId: string | undefined): Promise<string | null> {
    try {
      const receiver = await this.hostingMemberConfig.resolveFeishuReceiver(botImId);
      return receiver?.openId ?? null;
    } catch (error) {
      this.logger.warn(`[FeishuTask] 解析托管账号飞书接收人失败: ${toErrorMessage(error)}`);
      return null;
    }
  }

  // ==================== Redis 合并键 ====================

  private async readMergeRecord(key: string): Promise<MergeRecord | null> {
    try {
      const raw = await this.redisService.get<Partial<MergeRecord> | null>(key);
      if (!raw || typeof raw !== 'object' || typeof raw.taskGuid !== 'string') return null;
      return {
        taskGuid: raw.taskGuid,
        firstTriggeredAt:
          typeof raw.firstTriggeredAt === 'string'
            ? raw.firstTriggeredAt
            : new Date().toISOString(),
        count: typeof raw.count === 'number' && raw.count > 0 ? raw.count : 1,
        priority: parsePriority(raw.priority) ?? 'normal',
      };
    } catch (error) {
      this.logger.warn(
        `[FeishuTask] 读取合并键失败，按新建处理: key=${key} error=${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  private async writeMergeRecord(key: string, record: MergeRecord): Promise<void> {
    try {
      await this.redisService.setex(key, MERGE_TTL_SECONDS, record);
    } catch (error) {
      this.logger.warn(`[FeishuTask] 写入合并键失败: key=${key} error=${toErrorMessage(error)}`);
    }
  }

  // ==================== 配置 / 告警 ====================

  private loadFieldNames(): Record<FieldKey, string> {
    const names: Record<FieldKey, string> = { ...DEFAULT_FIELD_NAMES };
    const raw = this.configService.get<string>('FEISHU_TASK_FIELD_NAMES_JSON')?.trim();
    if (!raw) return names;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const key of Object.keys(names) as FieldKey[]) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim()) names[key] = value.trim();
      }
    } catch (error) {
      this.logger.warn(
        `FEISHU_TASK_FIELD_NAMES_JSON 解析失败，使用默认字段名: ${toErrorMessage(error)}`,
      );
    }
    return names;
  }

  private loadOwners(): OwnerConfig {
    const raw = this.configService.get<string>('FEISHU_TASK_OWNER_OPEN_IDS_JSON')?.trim();
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const pick = (key: string): string[] | undefined => {
        const value = parsed[key];
        if (!Array.isArray(value)) return undefined;
        const ids = value.filter(
          (item): item is string => typeof item === 'string' && item.trim() !== '',
        );
        return ids.length > 0 ? ids : undefined;
      };
      return {
        supervisor: pick('supervisor'),
        T4: pick('T4'),
        T5: pick('T5'),
        T8: pick('T8'),
        default: pick('default'),
      };
    } catch (error) {
      this.logger.warn(
        `FEISHU_TASK_OWNER_OPEN_IDS_JSON 解析失败，负责人只回退托管账号: ${toErrorMessage(error)}`,
      );
      return {};
    }
  }

  private async alertFailure(
    action: string,
    key: string,
    message: string,
    contactName?: string | null,
  ): Promise<void> {
    try {
      await this.alertNotifier.sendAlert({
        code: 'feishu_task.create_failed',
        severity: AlertLevel.WARNING,
        summary: `飞书任务创建失败（${action}）`,
        source: {
          subsystem: 'notification',
          component: 'InterventionTaskService',
          action,
          trigger: 'tool',
        },
        scope: { contactName: contactName ?? undefined, sessionId: key },
        diagnostics: { errorMessage: message },
        dedupe: { key: 'feishu_task.create_failed' },
      });
    } catch (error) {
      this.logger.warn(`[FeishuTask] 失败告警发送异常: ${toErrorMessage(error)}`);
    }
  }

  private isTestSession(corpId: string, chatId: string): boolean {
    if (TEST_CORP_IDS.has(corpId)) return true;
    return TEST_SESSION_PREFIXES.some((prefix) => chatId.startsWith(prefix));
  }
}
