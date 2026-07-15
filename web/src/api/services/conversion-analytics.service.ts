import { api, unwrapResponse } from '../client';
import {
  DEMO_BOTS,
  DEMO_HANDOFF,
  DEMO_KPIS,
  buildDemoFunnel,
  buildDemoTrends,
  isDemoMode,
} from './conversion-analytics.demo';
import type {
  ConversionBotsResponse,
  ConversionCohort,
  ConversionFunnelResponse,
  ConversionHandoffResponse,
  ConversionKpisResponse,
  ConversionMetricMode,
  ConversionQuery,
  ConversionTrendResponse,
} from '../types/conversion-analytics.types';

function toParams(query: ConversionQuery, extra?: Record<string, string>) {
  const params = new URLSearchParams({ range: query.range, ...(extra ?? {}) });
  for (const group of query.groups ?? []) {
    params.append('groups', group);
  }
  if (extra?.mode === 'cohort') {
    params.set('maturityDays', String(query.maturityDays ?? 7));
  }
  // 渠道（source_channel）暂无埋点，写入侧恒为 'unknown'，前端不再传 channel（§7）。
  return params.toString();
}

export async function getConversionKpis(query: ConversionQuery, mode: ConversionMetricMode) {
  if (isDemoMode()) return DEMO_KPIS;
  const { data } = await api.get(`/analytics/conversion/kpis?${toParams(query, { mode })}`);
  return unwrapResponse<ConversionKpisResponse>(data);
}

export async function getConversionFunnel(
  query: ConversionQuery,
  cohort: ConversionCohort,
  mode: ConversionMetricMode,
) {
  if (isDemoMode()) return buildDemoFunnel(mode);
  const { data } = await api.get(
    `/analytics/conversion/funnel?${toParams(query, { cohort, mode })}`,
  );
  return unwrapResponse<ConversionFunnelResponse>(data);
}

export async function getConversionBots(query: ConversionQuery, mode: ConversionMetricMode) {
  if (isDemoMode()) return DEMO_BOTS;
  const { data } = await api.get(`/analytics/conversion/bots?${toParams(query, { mode })}`);
  return unwrapResponse<ConversionBotsResponse>(data);
}

export async function getConversionTrends(query: ConversionQuery, mode: ConversionMetricMode) {
  if (isDemoMode()) return buildDemoTrends(mode);
  const { data } = await api.get(`/analytics/conversion/trends?${toParams(query, { mode })}`);
  return unwrapResponse<ConversionTrendResponse>(data);
}

export async function getConversionHandoff(query: ConversionQuery) {
  if (isDemoMode()) return DEMO_HANDOFF;
  const { data } = await api.get(
    `/analytics/conversion/handoff?${toParams({ range: query.range, groups: query.groups })}`,
  );
  return unwrapResponse<ConversionHandoffResponse>(data);
}
