/**
 * 飞书相关接口定义
 */

/**
 * 飞书卡片消息颜色
 */
export type FeishuCardColor =
  | 'blue'
  | 'wathet'
  | 'turquoise'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'carmine'
  | 'violet'
  | 'purple'
  | 'indigo'
  | 'grey';

/**
 * 告警级别
 * 重新导出集中化枚举，保持向后兼容
 */
export { AlertLevel } from '@enums/alert.enum';

/**
 * 面试预约信息
 */
export interface InterviewBookingInfo {
  candidateName?: string;
  chatId?: string;
  brandName?: string;
  storeName?: string;
  interviewTime?: string;
  contactInfo?: string;
  toolOutput?: Record<string, unknown>;
  // 用户信息（用于统计）
  userId?: string; // 用户的系统 wxid (imContactId)
  userName?: string; // 用户昵称 (contactName)
  // 招募经理信息
  managerId?: string; // 招募经理 ID (botUserId)
  managerName?: string; // 招募经理昵称
}

/**
 * 飞书 API 响应
 */
export interface FeishuApiResponse {
  code: number;
  msg?: string;
  data?: Record<string, unknown>;
}

/**
 * 飞书多维表格字段配置
 */
export interface BitableFieldConfig {
  field_name: string;
  type: number;
  property?: Record<string, unknown>;
}

/**
 * 飞书多维表格记录
 */
export interface BitableRecord {
  record_id?: string;
  fields: Record<string, unknown>;
}
