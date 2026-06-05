import { useQuery } from '@tanstack/react-query';
import { getConversionHandoff } from '@/api/services/conversion-analytics.service';
import type { ConversionQuery } from '@/api/types/conversion-analytics.types';
import { conversionRefetchInterval } from './useConversionKpis';

export function useHandoffReasons(query: ConversionQuery, autoRefresh = true) {
  return useQuery({
    queryKey: ['conversion-handoff', query.range, query.groups ?? []],
    queryFn: () => getConversionHandoff(query),
    refetchInterval: autoRefresh ? conversionRefetchInterval(query.range) : false,
    staleTime: autoRefresh ? 10000 : 60000,
    placeholderData: (previousData) => previousData,
    refetchOnWindowFocus: false,
  });
}

export const useConversionHandoff = useHandoffReasons;
