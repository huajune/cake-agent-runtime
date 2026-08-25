import { createTurnLedger } from '@agent/generator/working-memory/turn-ledger';
import type {
  ToolArchiveContext,
  ToolBuildContext,
  ToolRuntimeContext,
  ToolSessionContext,
  ToolTurnInputContext,
} from '@shared-types/tool.types';
import type { TurnLedger } from '@shared-types/turn.types';

export interface TurnLedgerOverrides {
  visual?: Partial<TurnLedger['visual']>;
  geo?: Partial<TurnLedger['geo']>;
  jobs?: Partial<TurnLedger['jobs']>;
  facts?: Partial<TurnLedger['facts']>;
  recordVisualFacts?: TurnLedger['recordVisualFacts'];
  recordImageBrands?: TurnLedger['recordImageBrands'];
  recordGeocodeAnchor?: TurnLedger['recordGeocodeAnchor'];
  recordCityAttestation?: TurnLedger['recordCityAttestation'];
  recordFetchedJobs?: TurnLedger['recordFetchedJobs'];
  recordJobListQuery?: TurnLedger['recordJobListQuery'];
  markJobInvalidated?: TurnLedger['markJobInvalidated'];
}

export interface ToolContextOverrides {
  session?: Partial<ToolSessionContext>;
  archive?: Partial<ToolArchiveContext>;
  turnInput?: Partial<ToolTurnInputContext>;
  ledger?: TurnLedgerOverrides;
  runtime?: Partial<ToolRuntimeContext>;
}

/** 测试专用五组化上下文；默认值只负责消除与用例无关的装配噪声。 */
export function createToolContext(overrides: ToolContextOverrides = {}): ToolBuildContext {
  const ledger = createTurnLedger({
    turnHints: overrides.ledger?.facts?.turnHints ?? null,
    laborFormIntent: overrides.ledger?.facts?.laborFormIntent,
    collectedFields: overrides.ledger?.facts?.collectedFields,
    geoSignalCities: overrides.ledger?.geo?.signalCities,
    currentFocusJob: overrides.ledger?.jobs?.currentFocusJob,
  });
  applyLedgerOverrides(ledger, overrides.ledger);
  return {
    session: {
      userId: 'test-user',
      corpId: 'test-corp',
      sessionId: 'test-session',
      ...overrides.session,
    },
    archive: { ...overrides.archive },
    turnInput: { messages: [], ...overrides.turnInput },
    ledger,
    runtime: { ...overrides.runtime },
  };
}

/** 基于已有上下文覆盖一组或多组；ledger 未显式覆盖时沿用同一实例。 */
export function mergeToolContext(
  base: ToolBuildContext,
  overrides: ToolContextOverrides = {},
): ToolBuildContext {
  let ledger = base.ledger;
  if (overrides.ledger) {
    ledger = createTurnLedger({
      turnHints: overrides.ledger.facts?.turnHints ?? base.ledger.facts.turnHints,
      laborFormIntent: overrides.ledger.facts?.laborFormIntent ?? base.ledger.facts.laborFormIntent,
      collectedFields: overrides.ledger.facts?.collectedFields ?? base.ledger.facts.collectedFields,
      geoSignalCities: overrides.ledger.geo?.signalCities ?? base.ledger.geo.signalCities,
      currentFocusJob:
        overrides.ledger.jobs?.currentFocusJob === undefined
          ? base.ledger.jobs.currentFocusJob
          : overrides.ledger.jobs.currentFocusJob,
    });
    ledger.jobs.bookingSucceeded = base.ledger.jobs.bookingSucceeded;
    ledger.jobs.jobListExecuted = base.ledger.jobs.jobListExecuted;
    ledger.jobs.resolvedWorkOrderId = base.ledger.jobs.resolvedWorkOrderId;
    applyLedgerOverrides(ledger, overrides.ledger);
  }
  return {
    session: { ...base.session, ...overrides.session },
    archive: { ...base.archive, ...overrides.archive },
    turnInput: { ...base.turnInput, ...overrides.turnInput },
    ledger,
    runtime: { ...base.runtime, ...overrides.runtime },
  };
}

function applyLedgerOverrides(ledger: TurnLedger, overrides?: TurnLedgerOverrides): void {
  if (!overrides) return;
  for (const entry of overrides.visual?.factSheets ?? []) {
    ledger.recordVisualFacts(entry.sheet, { messageId: entry.messageId });
  }
  for (const entry of overrides.visual?.brandResolutions ?? []) {
    ledger.recordImageBrands(entry.resolutions, { messageId: entry.messageId });
  }
  for (const anchor of overrides.geo?.anchors ?? []) ledger.recordGeocodeAnchor(anchor);
  if (overrides.geo?.cityAttestation) {
    ledger.recordCityAttestation(overrides.geo.cityAttestation);
  }
  if (overrides.jobs?.fetchedJobs) ledger.recordFetchedJobs([...overrides.jobs.fetchedJobs]);
  if (overrides.jobs?.querySignature !== undefined) {
    ledger.recordJobListQuery({ signature: overrides.jobs.querySignature });
  }
  for (const jobId of overrides.jobs?.invalidatedJobIds ?? []) ledger.markJobInvalidated(jobId);
  if (overrides.jobs && 'bookingSucceeded' in overrides.jobs) {
    ledger.jobs.bookingSucceeded = overrides.jobs.bookingSucceeded;
  }
  if (overrides.jobs?.jobListExecuted !== undefined) {
    ledger.jobs.jobListExecuted = overrides.jobs.jobListExecuted;
  }
  if (overrides.jobs?.resolvedWorkOrderId !== undefined) {
    ledger.jobs.resolvedWorkOrderId = overrides.jobs.resolvedWorkOrderId;
  }
  if (overrides.recordVisualFacts) ledger.recordVisualFacts = overrides.recordVisualFacts;
  if (overrides.recordImageBrands) ledger.recordImageBrands = overrides.recordImageBrands;
  if (overrides.recordGeocodeAnchor) ledger.recordGeocodeAnchor = overrides.recordGeocodeAnchor;
  if (overrides.recordCityAttestation) {
    ledger.recordCityAttestation = overrides.recordCityAttestation;
  }
  if (overrides.recordFetchedJobs) ledger.recordFetchedJobs = overrides.recordFetchedJobs;
  if (overrides.recordJobListQuery) ledger.recordJobListQuery = overrides.recordJobListQuery;
  if (overrides.markJobInvalidated) ledger.markJobInvalidated = overrides.markJobInvalidated;
}
