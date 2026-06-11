/**
 * 告警日志持久化契约（由 notification 层定义，biz/monitoring 实现）。
 *
 * 设计：notification 模块对 biz 零依赖（架构分层），只声明接口 + 注入 token；
 * MonitoringModule（@Global）绑定真实实现（写 monitoring_error_logs）。
 * AlertNotifierService 通过 @Optional() @Inject(ALERT_LOG_PERSISTER) 注入，
 * 未绑定时（如 notification 独立测试）静默降级为不持久化。
 */
export interface AlertLogEntry {
  /** 系统级告警可能无 messageId */
  messageId?: string;
  /** 发生时间（Unix ms） */
  timestamp: number;
  /** 错误/告警正文 */
  error: string;
  /** 告警 code（AlertContext.code） */
  code?: string;
  severity?: string;
  summary?: string;
  subsystem?: string;
  component?: string;
  action?: string;
  dedupeKey?: string;
  /** 因节流未发送飞书但仍入库（高峰期 KPI 不被节流掩盖） */
  throttled?: boolean;
  /** 飞书是否实际投递成功 */
  delivered?: boolean;
}

export interface AlertLogPersister {
  persist(entry: AlertLogEntry): Promise<void>;
}

/** DI token：MonitoringModule 绑定实现，AlertNotifierService @Optional 注入。 */
export const ALERT_LOG_PERSISTER = Symbol('ALERT_LOG_PERSISTER');
