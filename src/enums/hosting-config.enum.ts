/**
 * 系统配置键枚举
 */
export enum SystemConfigKey {
  AI_REPLY_ENABLED = 'ai_reply_enabled',
  MESSAGE_MERGE_ENABLED = 'message_merge_enabled',
  GROUP_BLACKLIST = 'group_blacklist',
  AGENT_REPLY_CONFIG = 'agent_reply_config',
  SYSTEM_CONFIG = 'system_config',
  /** 飞书任务清单（人工介入 → 任务）运行时开关 { enabled }，读取方 InterventionTaskService（FEISHU_TASK_CONFIG_KEY）。 */
  FEISHU_TASK_CONFIG = 'feishu_task_config',
  /** 带外工单对账扫描 cron 运行时配置 { enabled, maxRowsPerRun, maxPagesPerAccount }，读取方 OobReconcileScanCronService（OOB_RECONCILE_SCAN_CONFIG_KEY）。 */
  OOB_RECONCILE_SCAN_CONFIG = 'oob_reconcile_scan_config',
}
