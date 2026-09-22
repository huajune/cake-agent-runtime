/**
 * 飞书任务 task/v2 客户端类型（只覆盖本仓库用到的字段）。
 * 官方文档：https://open.feishu.cn/document/task-v2/task/overview
 */

export type FeishuTaskMemberRole = 'assignee' | 'follower';

export interface FeishuTaskMember {
  /** open_id（user_id_type=open_id） */
  id: string;
  type?: 'user' | 'chat';
  role?: FeishuTaskMemberRole;
}

export type FeishuCustomFieldType =
  | 'text'
  | 'number'
  | 'datetime'
  | 'member'
  | 'single_select'
  | 'multi_select';

/** 写任务时的自定义字段值；按字段类型只填一个 *_value。 */
export interface FeishuTaskCustomFieldValue {
  guid: string;
  text_value?: string;
  /** 数字以字符串传输（官方要求） */
  number_value?: string;
  /** 毫秒时间戳字符串；精度只到天 */
  datetime_value?: string;
  /** 单选选项 guid */
  single_select_value?: string;
  multi_select_value?: string[];
  member_value?: FeishuTaskMember[];
}

export interface FeishuTaskDue {
  /** 毫秒时间戳字符串 */
  timestamp: string;
  is_all_day?: boolean;
}

export interface CreateFeishuTaskInput {
  summary: string;
  description?: string;
  /** 内置「开始时间」（分钟精度，is_all_day=false）；介入任务用它承载首次触发时刻 */
  startAt?: Date | null;
  dueAt?: Date | null;
  members?: FeishuTaskMember[];
  tasklistGuid?: string | null;
  sectionGuid?: string | null;
  customFields?: FeishuTaskCustomFieldValue[];
  /** 幂等 token（约 5 分钟内有效） */
  clientToken?: string;
}

export interface UpdateFeishuTaskInput {
  summary?: string;
  startAt?: Date | null;
  dueAt?: Date | null;
  customFields?: FeishuTaskCustomFieldValue[];
}

export interface FeishuTaskSummary {
  guid: string;
  summary?: string;
  url?: string;
  completed_at?: string;
}

export interface FeishuCustomFieldOption {
  guid: string;
  name: string;
  isHidden: boolean;
}

export interface FeishuCustomFieldDefinition {
  guid: string;
  name: string;
  type: FeishuCustomFieldType | string;
  options: FeishuCustomFieldOption[];
}

export interface FeishuTasklistFieldCatalog {
  tasklistGuid: string;
  fieldsByName: Map<string, FeishuCustomFieldDefinition>;
  loadedAt: number;
}

export interface FeishuTaskSection {
  guid: string;
  name: string;
}

export interface FeishuTasklistSummary {
  guid: string;
  name: string;
  url?: string;
}

/** 建字段 / 建选项时的选项描述；`colorIndex` 为飞书 color_index（0–54）。 */
export interface CreateCustomFieldOptionInput {
  name: string;
  colorIndex?: number;
}

export interface CreateCustomFieldInput {
  name: string;
  type: FeishuCustomFieldType;
  /** single_select / multi_select 的初始选项；字符串等价于不带颜色的 { name } */
  options?: Array<string | CreateCustomFieldOptionInput>;
}

/** 飞书 OpenAPI 统一响应壳 */
export interface FeishuApiEnvelope<T> {
  code: number;
  msg: string;
  data?: T;
}

export type FeishuTaskApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: number; msg: string };
