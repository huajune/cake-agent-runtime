import { useQuery } from '@tanstack/react-query';
import { getConversionBots } from '@/api/services/conversion-analytics.service';
import type { ConversionMetricMode, ConversionQuery } from '@/api/types/conversion-analytics.types';
import { conversionQueryKey, conversionRefetchInterval } from './useConversionKpis';

export function useConversionBots(
  query: ConversionQuery,
  mode: ConversionMetricMode,
  autoRefresh = true,
) {
  return useQuery({
    queryKey: ['conversion-bots', mode, ...conversionQueryKey(query)],
    queryFn: () => getConversionBots(query, mode),
    refetchInterval: autoRefresh ? conversionRefetchInterval(query.range) : false,
    staleTime: autoRefresh ? 10000 : 60000,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === mode ? previousData : undefined,
    refetchOnWindowFocus: false,
  });
}
