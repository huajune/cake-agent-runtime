/** daily_ops_report 单行（每日每 bot 投影），供飞书日报 cron 读取。 */
export interface DailyOpsReportRow {
  report_date: string;
  bot_im_id: string;
  manager_name: string | null;
  group_name: string | null;
  friends_added_count: number;
  agent_opening_sent_count: number;
  break_ice_count: number;
  candidate_message_count: number;
  agent_reply_count: number;
  job_recommend_count: number;
  precheck_pass_count: number;
  booking_success_count: number;
  booking_fail_count: number;
  group_invite_count: number;
  handoff_count: number;
  interview_pass_count: number;
  candidate_summary: string | null;
  booking_brands: string[] | null;
}
