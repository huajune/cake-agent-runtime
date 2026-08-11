import { createTurnLedger } from '@agent/generator/preparation-utils/turn-ledger';
import type {
  ToolArchiveContext,
  ToolBuildContext,
  ToolRuntimeContext,
  ToolSessionContext,
  ToolTurnInputContext,
} from '@shared-types/tool.types';
import type { TurnLedger } from '@shared-types/turn.types';

export interface ToolContextOverrides {
  session?: Partial<ToolSessionContext>;
  archive?: Partial<ToolArchiveContext>;
  turnInput?: Partial<ToolTurnInputContext>;
  ledger?: Partial<TurnLedger>;
  runtime?: Partial<ToolRuntimeContext>;
}

/** 测试专用五组化上下文；默认值只负责消除与用例无关的装配噪声。 */
export function createToolContext(overrides: ToolContextOverrides = {}): ToolBuildContext {
  const ledger = createTurnLedger({
    ruleFacts: overrides.ledger?.ruleFacts ?? null,
    collectedFields: overrides.ledger?.collectedFields,
    geoSignalCities: overrides.ledger?.geoSignalCities,
    currentFocusJob: overrides.ledger?.currentFocusJob,
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
      ruleFacts: overrides.ledger.ruleFacts ?? base.ledger.ruleFacts,
      collectedFields: overrides.ledger.collectedFields ?? base.ledger.collectedFields,
      geoSignalCities: overrides.ledger.geoSignalCities ?? base.ledger.geoSignalCities,
      currentFocusJob:
        overrides.ledger.currentFocusJob === undefined
          ? base.ledger.currentFocusJob
          : overrides.ledger.currentFocusJob,
    });
    ledger.bookingSucceeded = base.ledger.bookingSucceeded;
    ledger.jobListExecuted = base.ledger.jobListExecuted;
    ledger.resolvedWorkOrderId = base.ledger.resolvedWorkOrderId;
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

function applyLedgerOverrides(ledger: TurnLedger, overrides?: Partial<TurnLedger>): void {
  if (!overrides) return;
  for (const entry of overrides.visualFactSheets ?? []) {
    ledger.recordVisualFacts(entry.sheet, { messageId: entry.messageId });
  }
  for (const entry of overrides.imageBrandResolutions ?? []) {
    ledger.recordImageBrands(entry.resolutions, { messageId: entry.messageId });
  }
  for (const anchor of overrides.geocodeAnchors ?? []) ledger.recordGeocodeAnchor(anchor);
  if (overrides.cityAttestation) ledger.recordCityAttestation(overrides.cityAttestation);
  if (overrides.fetchedJobs) ledger.recordFetchedJobs([...overrides.fetchedJobs]);
  if (overrides.jobListQuery) ledger.recordJobListQuery(overrides.jobListQuery);
  for (const jobId of overrides.invalidatedJobIds ?? []) ledger.markJobInvalidated(jobId);

  const assignable = { ...overrides } as Record<string, unknown>;
  for (const key of [
    'visualFactSheets',
    'imageBrandResolutions',
    'geocodeAnchors',
    'cityAttestation',
    'fetchedJobs',
    'currentFocusJob',
    'jobListQuery',
    'invalidatedJobIds',
  ]) {
    delete assignable[key];
  }
  Object.assign(ledger, assignable);
}
