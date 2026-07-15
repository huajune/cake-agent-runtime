import { useQuery } from '@tanstack/react-query';
import { getConversionKpis } from '@/api/services/conversion-analytics.service';
import type { ConversionMetricMode, ConversionQuery } from '@/api/types/conversion-analytics.types';

export function conversionRefetchInterval(range: ConversionQuery['range']) {
  return range === 'today' ? 15000 : 60000;
}

export function conversionQueryKey(query: ConversionQuery) {
  return [query.range, query.groups ?? [], query.maturityDays ?? 0] as const;
}

export function useConversionKpis(
  query: ConversionQuery,
  mode: ConversionMetricMode,
  autoRefresh = true,
) {
  return useQuery({
    queryKey: ['conversion-kpis', mode, ...conversionQueryKey(query)],
    queryFn: () => getConversionKpis(query, mode),
    refetchInterval: autoRefresh ? conversionRefetchInterval(query.range) : false,
    staleTime: autoRefresh ? 10000 : 60000,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === mode ? previousData : undefined,
    refetchOnWindowFocus: false,
  });
}
