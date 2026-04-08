const PERF_QUERY_KEY = 'perf';
const PERF_STORAGE_KEY = 'cake:web:perf';

const pendingMeasures = new Map<string, string>();

function getPerfApi(): Performance | null {
  return typeof performance === 'undefined' ? null : performance;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function isPerfDebugEnabled(): boolean {
  if (!isBrowser()) return false;

  const search = new URLSearchParams(window.location.search);
  return search.get(PERF_QUERY_KEY) === '1' || window.localStorage.getItem(PERF_STORAGE_KEY) === '1';
}

function buildMarkName(scope: string, phase: string, label: string): string {
  return `${scope}:${phase}:${label}:${Date.now()}`;
}

function startMeasure(scope: string, label: string): void {
  if (!isPerfDebugEnabled()) return;

  const perfApi = getPerfApi();
  if (!perfApi) return;

  const key = `${scope}:${label}`;
  const startMark = buildMarkName(scope, 'start', label);
  pendingMeasures.set(key, startMark);
  perfApi.mark(startMark);
}

function endMeasure(scope: string, label: string, outcome = 'done'): void {
  if (!isPerfDebugEnabled()) return;

  const perfApi = getPerfApi();
  if (!perfApi) return;

  const key = `${scope}:${label}`;
  const startMark = pendingMeasures.get(key);
  const endMark = buildMarkName(scope, outcome, label);
  perfApi.mark(endMark);

  if (!startMark) return;

  try {
    perfApi.measure(`${scope}:${label}:${outcome}`, startMark, endMark);
  } catch {
    // Ignore missing marks and allow future retries.
  } finally {
    pendingMeasures.delete(key);
  }
}

export function markRouteNavigationStart(path: string): void {
  startMeasure('route-navigation', path);
}

export function markRouteNavigationComplete(path: string): void {
  endMeasure('route-navigation', path, 'ready');
}

export function markAgentTestStreamStart(): void {
  startMeasure('agent-test-stream', 'chat');
}

export function markAgentTestStreamEnd(outcome: 'finish' | 'error' | 'cancel'): void {
  endMeasure('agent-test-stream', 'chat', outcome);
}
