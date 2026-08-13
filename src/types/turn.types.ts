import type { RuleFactClaims } from '@resolution/evidence/claim.types';
import type { BrandResolution } from '@resolution/brand/brand-resolution.types';
import type { CandidateCollectedField, CandidateFieldKey } from '@resolution/candidate/types';
import type { FinalizedVisualFactSheet } from '@resolution/signal/visual';
import type { LaborFormIntentDecision } from '@resolution/labor-form';
import type { RecommendedJobSummary } from '@resolution/job/types';

/** 本轮 geocode 成功解析的锚点记录。 */
export interface GeocodeResolvedAnchor {
  longitude: number;
  latitude: number;
  areaLevelQuery: boolean;
  areaName: string | null;
  city: string | null;
}

/** 本轮工具确权的候选人城市；轮末由 memory 收编。 */
export interface CityAttestation {
  city: string;
  district?: string | null;
  evidence: string;
  source: 'geocode_unique' | 'location_share';
}

/** geocode 使用的本轮可信位置锚点。 */
export interface GeocodeLocationAnchor {
  city?: string;
  districts: string[];
  source: 'current_user' | 'human_agent' | 'session_memory';
  referenceText?: string;
  evidence: string;
}

export interface TurnVisualSnapshot {
  readonly factSheets: ReadonlyArray<{ messageId: string; sheet: FinalizedVisualFactSheet }>;
  readonly brandResolutions: ReadonlyArray<{
    messageId: string;
    resolutions: BrandResolution[];
  }>;
}

export interface TurnGeoSnapshot {
  readonly anchors: readonly GeocodeResolvedAnchor[];
  readonly cityAttestation: CityAttestation | undefined;
  readonly signalCities: ReadonlySet<string>;
}

/**
 * 本轮岗位召回的规范化最小载荷。
 *
 * 生产者在 job-list 边界已把海绵响应投影成 RecommendedJobSummary；该形状覆盖 jobId
 * 出处闸、轮末候选池和抽取提示词的字段并集，不允许把海绵原始岗位结构泄入账本。
 */
export type TurnFetchedJob = RecommendedJobSummary;

export interface TurnJobsSnapshot {
  readonly fetchedJobs: readonly TurnFetchedJob[];
  /** prep 时刻的当前焦点岗位；供本轮工具与轮末抽取共享同一上下文快照。 */
  readonly currentFocusJob: RecommendedJobSummary | null;
  /** duliday_job_list 查询签名；去掉历史上的单字段对象包装。 */
  readonly querySignature: string | undefined;
  readonly invalidatedJobIds: readonly number[];
  /** undefined 表示本轮尚未尝试预约；false 仅表示预约工具明确失败。 */
  bookingSucceeded: boolean | undefined;
  jobListExecuted: boolean;
  resolvedWorkOrderId?: number;
}

export interface TurnFactsSnapshot {
  readonly ruleFacts: RuleFactClaims | null;
  /** prep 时刻唯一一次 labor-form 规则轨判定；轮末 shadow 对照复用，禁止重跑。 */
  readonly laborFormIntent: LaborFormIntentDecision;
  readonly collectedFields: Readonly<Partial<Record<CandidateFieldKey, CandidateCollectedField>>>;
}

export interface TurnLedgerSnapshot {
  readonly visual: TurnVisualSnapshot;
  readonly geo: TurnGeoSnapshot;
  readonly jobs: TurnJobsSnapshot;
  readonly facts: TurnFactsSnapshot;
}

/** 轮末事实抽取只借阅岗位与视觉域的最小只读投影。 */
export interface TurnExtractionToolFacts {
  readonly jobs: Pick<TurnJobsSnapshot, 'fetchedJobs' | 'currentFocusJob'>;
  readonly visual: Pick<TurnVisualSnapshot, 'factSheets'>;
}

/**
 * 回合账本：agent 运行时拥有实例，工具只借阅只读视图与显式追加方法。
 * 列表没有可写出口；所有变更都经 record* / mark*，轮末以 drain() 快照交档。
 */
export interface TurnLedger extends TurnLedgerSnapshot {
  recordVisualFacts(sheet: FinalizedVisualFactSheet, meta: { messageId: string }): void;
  recordImageBrands(resolutions: BrandResolution[], meta: { messageId: string }): void;
  recordGeocodeAnchor(anchor: GeocodeResolvedAnchor): void;
  recordCityAttestation(attestation: CityAttestation): void;
  recordFetchedJobs(jobs: TurnFetchedJob[]): void;
  recordJobListQuery(query: { signature: string }): void;
  markJobInvalidated(jobId: number): void;
  drain(): TurnLedgerSnapshot;
}
