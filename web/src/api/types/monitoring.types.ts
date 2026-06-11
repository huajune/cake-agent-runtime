export interface WorkerStatus {
  concurrency: number;
  activeJobs: number;
  minConcurrency: number;
  maxConcurrency: number;
  messageMergeEnabled: boolean;
}

export interface WorkerConcurrencyResponse {
  success: boolean;
  message: string;
  concurrency: number;
}

export interface GroupInfo {
  id: string;
  name: string;
  description: string;
}

/** 提取质量对账：单字段一行 */
export interface ExtractionAccuracyField {
  /** 字段名：name / phone / age / gender */
  field: string;
  /** 有真值的 booking 样本数 */
  bookings: number;
  /** 提取侧有值（无论对错）的样本数 */
  extracted: number;
  /** 覆盖率 % */
  coveragePct: number;
  /** 准确率 % */
  accuracyPct: number;
  /** 提取有值但与真值不一致的样本数 */
  mismatches: number;
  /** 提取置信度为 high 的样本数 */
  highConf: number;
  /** 高置信准确率 % */
  highConfAccuracyPct: number;
}

/** 提取质量对账响应 */
export interface ExtractionAccuracyReport {
  /** 统计天数 */
  days: number;
  /** 时间窗起点 ISO */
  start: string;
  /** 时间窗终点 ISO */
  end: string;
  /** 逐字段对账行 */
  fields: ExtractionAccuracyField[];
}
