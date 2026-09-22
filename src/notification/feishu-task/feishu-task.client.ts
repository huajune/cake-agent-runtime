import { Injectable, Logger } from '@nestjs/common';
import { FeishuApiService } from '@infra/feishu/services/api.service';
import { toErrorMessage } from '@infra/utils/error.util';
import { fetchWithTimeout } from '@infra/utils/fetch-timeout.util';
import type {
  CreateCustomFieldInput,
  CreateFeishuTaskInput,
  FeishuApiEnvelope,
  FeishuCustomFieldDefinition,
  FeishuCustomFieldOption,
  FeishuTaskApiResult,
  FeishuTaskCustomFieldValue,
  FeishuTaskDue,
  FeishuTaskMember,
  FeishuTaskSection,
  FeishuTaskSummary,
  FeishuTasklistFieldCatalog,
  FeishuTasklistSummary,
  UpdateFeishuTaskInput,
} from './feishu-task.types';

interface RawOption {
  guid?: string;
  name?: string;
  is_hidden?: boolean;
}

interface RawCustomField {
  guid?: string;
  name?: string;
  type?: string;
  single_select_setting?: { options?: RawOption[] };
  multi_select_setting?: { options?: RawOption[] };
}

interface RawSection {
  guid?: string;
  name?: string;
}

interface RawTasklist {
  guid?: string;
  name?: string;
  url?: string;
}

interface PagedItems<T> {
  items?: T[];
  page_token?: string;
  has_more?: boolean;
}

const FEISHU_RATE_LIMIT_CODES = new Set([99991400, 99991661, 11232]);
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const PAGE_SIZE = 100;

/**
 * 飞书任务 task/v2 客户端（G1）。
 *
 * - tenant_access_token 复用 FeishuApiService 的缓存；
 * - 所有出站请求走 fetchWithTimeout，HTTP 429 / 限流错误码指数退避重试；
 * - 任何失败只 Logger.warn 并返回 null/false，不向调用方抛错（介入主链路不能被任务失败拖住）；
 * - 清单自定义字段定义（字段名 → guid、单选选项名 → guid）与分组按清单缓存在内存，
 *   缺选项 / 缺分组时自动创建并刷新缓存。
 */
@Injectable()
export class FeishuTaskClient {
  private readonly logger = new Logger(FeishuTaskClient.name);
  private readonly apiBase = 'https://open.feishu.cn/open-apis';
  private readonly fieldCatalogs = new Map<string, FeishuTasklistFieldCatalog>();
  private readonly sectionCatalogs = new Map<
    string,
    { sections: FeishuTaskSection[]; loadedAt: number }
  >();

  constructor(private readonly feishuApi: FeishuApiService) {}

  // ==================== 任务 ====================

  async createTask(input: CreateFeishuTaskInput): Promise<FeishuTaskSummary | null> {
    const body: Record<string, unknown> = {
      summary: input.summary,
      description: input.description ?? '',
    };
    const due = toDue(input.dueAt);
    if (due) body.due = due;
    if (input.members && input.members.length > 0) body.members = normalizeMembers(input.members);
    if (input.tasklistGuid) {
      body.tasklists = [
        {
          tasklist_guid: input.tasklistGuid,
          ...(input.sectionGuid ? { section_guid: input.sectionGuid } : {}),
        },
      ];
    }
    if (input.customFields && input.customFields.length > 0)
      body.custom_fields = input.customFields;
    if (input.clientToken) body.client_token = input.clientToken;

    const result = await this.request<{ task?: FeishuTaskSummary }>('POST', '/task/v2/tasks', {
      query: { user_id_type: 'open_id' },
      body,
    });
    if (isFailure(result)) {
      this.warnFailure('createTask', result, { summary: input.summary });
      return null;
    }
    const task = result.data.task;
    if (!task?.guid) {
      this.logger.warn(`[FeishuTask] createTask 响应缺少 task.guid: summary=${input.summary}`);
      return null;
    }
    return task;
  }

  async addMembers(taskGuid: string, members: FeishuTaskMember[]): Promise<boolean> {
    if (members.length === 0) return true;
    const result = await this.request<unknown>('POST', `/task/v2/tasks/${taskGuid}/add_members`, {
      query: { user_id_type: 'open_id' },
      body: { members: normalizeMembers(members) },
    });
    if (isFailure(result)) {
      this.warnFailure('addMembers', result, { taskGuid, members: members.map((m) => m.id) });
      return false;
    }
    return true;
  }

  async addComment(taskGuid: string, content: string): Promise<string | null> {
    const result = await this.request<{ comment?: { id?: string } }>('POST', '/task/v2/comments', {
      query: { user_id_type: 'open_id' },
      body: { content, resource_type: 'task', resource_id: taskGuid },
    });
    if (isFailure(result)) {
      this.warnFailure('addComment', result, { taskGuid });
      return null;
    }
    return result.data.comment?.id ?? '';
  }

  async updateTask(taskGuid: string, input: UpdateFeishuTaskInput): Promise<boolean> {
    const task: Record<string, unknown> = {};
    const updateFields: string[] = [];
    if (input.summary !== undefined) {
      task.summary = input.summary;
      updateFields.push('summary');
    }
    const due = toDue(input.dueAt);
    if (due) {
      task.due = due;
      updateFields.push('due');
    }
    if (input.customFields && input.customFields.length > 0) {
      task.custom_fields = input.customFields;
      updateFields.push('custom_fields');
    }
    if (updateFields.length === 0) return true;

    const result = await this.request<unknown>('PATCH', `/task/v2/tasks/${taskGuid}`, {
      query: { user_id_type: 'open_id' },
      body: { task, update_fields: updateFields },
    });
    if (isFailure(result)) {
      this.warnFailure('updateTask', result, { taskGuid, updateFields });
      return false;
    }
    return true;
  }

  async getTask(taskGuid: string): Promise<FeishuTaskSummary | null> {
    const result = await this.request<{ task?: FeishuTaskSummary }>(
      'GET',
      `/task/v2/tasks/${taskGuid}`,
      { query: { user_id_type: 'open_id' } },
    );
    if (isFailure(result)) {
      this.warnFailure('getTask', result, { taskGuid });
      return null;
    }
    return result.data.task ?? null;
  }

  /** 仅探测脚本用（删除试建的测试任务）。 */
  async deleteTask(taskGuid: string): Promise<boolean> {
    const result = await this.request<unknown>('DELETE', `/task/v2/tasks/${taskGuid}`);
    if (isFailure(result)) {
      this.warnFailure('deleteTask', result, { taskGuid });
      return false;
    }
    return true;
  }

  // ==================== 清单 / 分组 ====================

  async listTasklists(): Promise<FeishuTasklistSummary[]> {
    const items = await this.listAll<RawTasklist>('/task/v2/tasklists', {
      user_id_type: 'open_id',
    });
    return items
      .filter((item): item is RawTasklist & { guid: string } => Boolean(item.guid))
      .map((item) => ({ guid: item.guid, name: item.name ?? '', url: item.url }));
  }

  async getTasklist(tasklistGuid: string): Promise<FeishuTasklistSummary | null> {
    const result = await this.request<{ tasklist?: RawTasklist }>(
      'GET',
      `/task/v2/tasklists/${tasklistGuid}`,
      { query: { user_id_type: 'open_id' } },
    );
    if (isFailure(result)) {
      this.warnFailure('getTasklist', result, { tasklistGuid });
      return null;
    }
    const raw = result.data.tasklist;
    return raw?.guid ? { guid: raw.guid, name: raw.name ?? '', url: raw.url } : null;
  }

  async listSections(
    tasklistGuid: string,
    options?: { refresh?: boolean },
  ): Promise<FeishuTaskSection[]> {
    const cached = this.sectionCatalogs.get(tasklistGuid);
    if (cached && !options?.refresh && Date.now() - cached.loadedAt < CATALOG_TTL_MS) {
      return cached.sections;
    }
    const items = await this.listAll<RawSection>('/task/v2/sections', {
      resource_type: 'tasklist',
      resource_id: tasklistGuid,
      user_id_type: 'open_id',
    });
    const sections = items
      .filter((item): item is RawSection & { guid: string } => Boolean(item.guid))
      .map((item) => ({ guid: item.guid, name: item.name ?? '' }));
    if (sections.length > 0 || !cached) {
      this.sectionCatalogs.set(tasklistGuid, { sections, loadedAt: Date.now() });
    }
    return sections;
  }

  /** 按分组名取 guid；缺则创建并刷新缓存。失败返回 null（任务落清单默认分组）。 */
  async resolveSectionGuid(tasklistGuid: string, name: string): Promise<string | null> {
    const sections = await this.listSections(tasklistGuid);
    const hit = sections.find((section) => section.name === name);
    if (hit) return hit.guid;

    const result = await this.request<{ section?: RawSection }>('POST', '/task/v2/sections', {
      query: { user_id_type: 'open_id' },
      body: { name, resource_type: 'tasklist', resource_id: tasklistGuid },
    });
    if (isFailure(result)) {
      this.warnFailure('createSection', result, { tasklistGuid, name });
      return null;
    }
    const guid = result.data.section?.guid ?? null;
    await this.listSections(tasklistGuid, { refresh: true });
    return guid;
  }

  // ==================== 自定义字段 ====================

  async getFieldCatalog(
    tasklistGuid: string,
    options?: { refresh?: boolean },
  ): Promise<FeishuTasklistFieldCatalog | null> {
    const cached = this.fieldCatalogs.get(tasklistGuid);
    if (cached && !options?.refresh && Date.now() - cached.loadedAt < CATALOG_TTL_MS) {
      return cached;
    }
    const items = await this.listAll<RawCustomField>('/task/v2/custom_fields', {
      resource_type: 'tasklist',
      resource_id: tasklistGuid,
      user_id_type: 'open_id',
    });
    if (items.length === 0 && cached) return cached;

    const fieldsByName = new Map<string, FeishuCustomFieldDefinition>();
    for (const raw of items) {
      const definition = normalizeField(raw);
      if (definition) fieldsByName.set(definition.name, definition);
    }
    const catalog: FeishuTasklistFieldCatalog = {
      tasklistGuid,
      fieldsByName,
      loadedAt: Date.now(),
    };
    this.fieldCatalogs.set(tasklistGuid, catalog);
    return catalog;
  }

  async resolveFieldGuid(tasklistGuid: string, fieldName: string): Promise<string | null> {
    const catalog = await this.getFieldCatalog(tasklistGuid);
    return catalog?.fieldsByName.get(fieldName)?.guid ?? null;
  }

  /** 单选选项名 → guid；缺选项时创建并刷新缓存。字段不存在返回 null。 */
  async resolveOptionGuid(
    tasklistGuid: string,
    fieldName: string,
    optionName: string,
  ): Promise<string | null> {
    const catalog = await this.getFieldCatalog(tasklistGuid);
    const field = catalog?.fieldsByName.get(fieldName);
    if (!field) return null;
    const existing = field.options.find((option) => option.name === optionName);
    if (existing) return existing.guid;

    const result = await this.request<{ option?: RawOption }>(
      'POST',
      `/task/v2/custom_fields/${field.guid}/options`,
      { body: { name: optionName } },
    );
    if (isFailure(result)) {
      this.warnFailure('createOption', result, { tasklistGuid, fieldName, optionName });
      return null;
    }
    const guid = result.data.option?.guid ?? null;
    const refreshed = await this.getFieldCatalog(tasklistGuid, { refresh: true });
    return (
      guid ??
      refreshed?.fieldsByName.get(fieldName)?.options.find((o) => o.name === optionName)?.guid ??
      null
    );
  }

  /** 建字段（探测脚本 --write 初始化清单表头用）。 */
  async createCustomField(
    tasklistGuid: string,
    input: CreateCustomFieldInput,
  ): Promise<FeishuCustomFieldDefinition | null> {
    const body: Record<string, unknown> = {
      resource_type: 'tasklist',
      resource_id: tasklistGuid,
      name: input.name,
      type: input.type,
    };
    if (input.type === 'single_select' || input.type === 'multi_select') {
      const setting = { options: (input.options ?? []).map((name) => ({ name })) };
      body[input.type === 'single_select' ? 'single_select_setting' : 'multi_select_setting'] =
        setting;
    }
    if (input.type === 'number') {
      body.number_setting = { format: 'normal', decimal_count: 0, separator: 'none' };
    }
    const result = await this.request<{ custom_field?: RawCustomField }>(
      'POST',
      '/task/v2/custom_fields',
      { query: { user_id_type: 'open_id' }, body },
    );
    if (isFailure(result)) {
      this.warnFailure('createCustomField', result, { tasklistGuid, name: input.name });
      return null;
    }
    await this.getFieldCatalog(tasklistGuid, { refresh: true });
    return normalizeField(result.data.custom_field ?? {});
  }

  // ==================== HTTP 底座 ====================

  private async listAll<T>(path: string, query: Record<string, string>): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request<PagedItems<T>>('GET', path, {
        query: {
          ...query,
          page_size: String(PAGE_SIZE),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      if (isFailure(result)) {
        this.warnFailure('list', result, { path });
        break;
      }
      items.push(...(result.data.items ?? []));
      if (!result.data.has_more || !result.data.page_token) break;
      pageToken = result.data.page_token;
    }
    return items;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options?: { query?: Record<string, string>; body?: unknown },
  ): Promise<FeishuTaskApiResult<T>> {
    let token: string;
    try {
      token = await this.feishuApi.getToken();
    } catch (error) {
      return {
        ok: false,
        status: 0,
        code: -1,
        msg: `获取 tenant token 失败: ${toErrorMessage(error)}`,
      };
    }

    const url = this.buildUrl(path, options?.query);
    let lastFailure: FeishuTaskApiResult<T> = { ok: false, status: 0, code: -1, msg: 'unknown' };
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (attempt > 0) await this.sleep(this.retryDelayMs(attempt));
      try {
        const response = await fetchWithTimeout(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: options?.body === undefined ? undefined : JSON.stringify(options.body),
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        const envelope = await this.parseEnvelope<T>(response);
        if (response.status === 429 || (envelope && FEISHU_RATE_LIMIT_CODES.has(envelope.code))) {
          lastFailure = {
            ok: false,
            status: response.status,
            code: envelope?.code ?? 429,
            msg: envelope?.msg ?? 'rate limited',
          };
          continue;
        }
        if (!envelope) {
          return { ok: false, status: response.status, code: -1, msg: '响应非 JSON' };
        }
        if (envelope.code !== 0) {
          return { ok: false, status: response.status, code: envelope.code, msg: envelope.msg };
        }
        return { ok: true, data: (envelope.data ?? {}) as T };
      } catch (error) {
        lastFailure = { ok: false, status: 0, code: -1, msg: toErrorMessage(error) };
      }
    }
    return lastFailure;
  }

  private async parseEnvelope<T>(response: Response): Promise<FeishuApiEnvelope<T> | null> {
    try {
      const json = (await response.json()) as unknown;
      if (json && typeof json === 'object' && 'code' in json) {
        return json as FeishuApiEnvelope<T>;
      }
      return null;
    } catch {
      return null;
    }
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    return url.toString();
  }

  private retryDelayMs(attempt: number): number {
    return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private warnFailure(
    action: string,
    failure: FeishuTaskApiFailure,
    context: Record<string, unknown>,
  ): void {
    this.logger.warn(
      `[FeishuTask] ${action} 失败: status=${failure.status} code=${failure.code} msg=${failure.msg} ctx=${JSON.stringify(context)}`,
    );
  }
}

// ==================== 纯转换 ====================

type FeishuTaskApiFailure = Extract<FeishuTaskApiResult<unknown>, { ok: false }>;

function isFailure<T>(result: FeishuTaskApiResult<T>): result is FeishuTaskApiFailure {
  return !result.ok;
}

function toDue(date: Date | null | undefined): FeishuTaskDue | undefined {
  if (!date || Number.isNaN(date.getTime())) return undefined;
  return { timestamp: String(date.getTime()), is_all_day: false };
}

function normalizeMembers(members: FeishuTaskMember[]): FeishuTaskMember[] {
  return members.map((member) => ({
    id: member.id,
    type: member.type ?? 'user',
    role: member.role ?? 'assignee',
  }));
}

function normalizeField(raw: RawCustomField): FeishuCustomFieldDefinition | null {
  if (!raw.guid || !raw.name) return null;
  const rawOptions = raw.single_select_setting?.options ?? raw.multi_select_setting?.options ?? [];
  const options: FeishuCustomFieldOption[] = rawOptions
    .filter((option): option is RawOption & { guid: string } => Boolean(option.guid))
    .map((option) => ({
      guid: option.guid,
      name: option.name ?? '',
      isHidden: option.is_hidden === true,
    }));
  return { guid: raw.guid, name: raw.name, type: raw.type ?? 'text', options };
}

export function buildCustomFieldValue(
  guid: string,
  value: { text?: string; number?: number; singleSelectOptionGuid?: string },
): FeishuTaskCustomFieldValue | null {
  if (value.singleSelectOptionGuid)
    return { guid, single_select_value: value.singleSelectOptionGuid };
  if (value.number !== undefined) return { guid, number_value: String(value.number) };
  if (value.text !== undefined) return { guid, text_value: value.text };
  return null;
}
