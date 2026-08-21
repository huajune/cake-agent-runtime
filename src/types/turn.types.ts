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

/**
 * 本轮工具确权的候选人城市；轮末由 memory 收编（saveToolAttestedCity 经裁决写 pref.city）。
 *
 * **单值后写覆盖**，但按证据强度设了一道例外（议题 4-2）：
 * `location_share`（候选人人在哪，真实位置）强于 `geocode_unique`（模型查了哪，文本解析）——
 * prep 的定位分享 seed 恒在最前、工具轮 geocode 在后，纯时序定胜负会让"候选人先发定位、
 * 模型又对另一城市地址 geocode 成功"的轮次以后者入档。同源异城（模型连续 geocode 多地）
 * 维持 last-write-wins：属正常探索，最后一次最接近意图。
 */
export interface CityAttestation {
  city: string;
  district?: string | null;
  evidence: string;
  source: 'geocode_unique' | 'location_share';
}

/**
 * 一次地理解析事件（坐标 + 可选城市确权）；recordGeoResolution 的入参。
 * city 为空时只登记 anchor，不产生 attestation——这条不变式由组合方法统一维护。
 */
export interface GeoResolutionRecord extends GeocodeResolvedAnchor {
  district?: string | null;
  /** attestation 的证据文本；city 非空时必填。 */
  evidence?: string;
  source: CityAttestation['source'];
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
  /** 本轮 precheck 已收到提交前复述确认的岗位；booking 只消费这一回合凭据。 */
  collectionReadyJobId?: number;
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
  /**
   * 一次地理解析事件的唯一登记入口：内部完成 anchor 追加 + city 非空时的 attestation 写入。
   *
   * anchor（坐标+精度，轮内工作集）与 cityAttestation（城市+证据，轮末落档）是同一事件对
   * 两个消费域的投影，字段集几乎不重叠、生命周期相反——分开存是对的，但"先 anchor 后
   * attestation""坐标有效但 city 为空只记 anchor"两条不变式此前由每个调用点各自维护，
   * 新增解析入口时容易漏记一半（议题 4-1）。
   */
  recordGeoResolution(input: GeoResolutionRecord): void;
  /** @internal 细粒度出口；生产代码一律走 recordGeoResolution，仅供组合方法与测试使用。 */
  recordGeocodeAnchor(anchor: GeocodeResolvedAnchor): void;
  /** @internal 同上。写入按 CityAttestation 注释的证据强度优先级裁决。 */
  recordCityAttestation(attestation: CityAttestation): void;
  recordFetchedJobs(jobs: TurnFetchedJob[]): void;
  recordJobListQuery(query: { signature: string }): void;
  markJobInvalidated(jobId: number): void;
  drain(): TurnLedgerSnapshot;
}
