/**
 * 会话列表查询的原始数据库行（snake_case 字段对应数据库列）
 */
export interface SessionDbRow {
  chat_id: string;
  candidate_name?: string;
  manager_name?: string;
  content: string;
  timestamp: string;
  avatar?: string;
  contact_type?: string;
  role: string;
}
