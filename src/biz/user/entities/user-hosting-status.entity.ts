/**
 * 用户托管状态记录
 * @table user_hosting_status
 */
export interface UserHostingStatus {
  user_id: string;
  is_paused: boolean;
  paused_at: string | null;
  resumed_at: string | null;
  pause_expires_at: string | null;
  is_permanent: boolean;
  pause_reason: string | null;
  pause_operator: string | null;
  pause_source: string | null;
  pause_count: number;
  created_at: string;
  updated_at: string;
}
