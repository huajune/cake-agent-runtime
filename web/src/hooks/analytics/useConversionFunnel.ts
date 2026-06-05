import { useQuery } from '@tanstack/react-query';
import { getConversionFunnel } from '@/api/services/conversion-analytics.service';
import type {
  ConversionCohort,
  ConversionMetricMode,
  ConversionQuery,
} from '@/api/types/conversion-analytics.types';
import { conversionQueryKey, conversionRefetchInterval } from './useConversionKpis';

export function useConversionFunnel(
  query: ConversionQuery,
  cohort: ConversionCohort,
  mode: ConversionMetricMode,
  autoRefresh = true,
) {
  return useQuery({
    queryKey: ['conversion-funnel', mode, cohort, ...conversionQueryKey(query)],
    queryFn: () => getConversionFunnel(query, cohort, mode),
    refetchInterval: autoRefresh ? conversionRefetchInterval(query.range) : false,
    staleTime: autoRefresh ? 10000 : 60000,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === mode && previousQuery?.queryKey[2] === cohort
        ? previousData
        : undefined,
    refetchOnWindowFocus: false,
  });
}
