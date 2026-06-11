/**
 * 提取质量对账 Hook
 *
 * 真值 = 报名提交字段；提取值 = 报名前最近一轮记忆快照。逐字段算覆盖率/准确率。
 */

import { useQuery } from '@tanstack/react-query';
import { getExtractionAccuracy } from '@/api/services/monitoring.service';

export function useExtractionAccuracy(days: number, autoRefresh = true) {
  return useQuery({
    queryKey: ['extraction-accuracy', days],
    queryFn: () => getExtractionAccuracy(days),
    refetchInterval: autoRefresh ? 60000 : false,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
}
