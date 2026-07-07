/**
 * 二次触发追溯相关 Hooks
 *
 * 包含触达记录列表、详情、分组统计查询
 */

import { useQuery } from '@tanstack/react-query';
import * as reengagementService from '@/api/services/reengagement.service';

// ==================== Query Hooks ====================

/**
 * 获取二次触发触达记录列表（支持分页和筛选）
 */
export function useReengagementRecords(options?: {
  startDate?: string;
  endDate?: string;
  status?: string;
  scenarioCode?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ['reengagement-records', options],
    queryFn: () => reengagementService.getReengagementRecords(options),
    enabled: options?.enabled ?? true,
    staleTime: 10000,
  });
}

/**
 * 获取单条触达记录详情（含 generated_text 与 events 全轨迹）
 */
export function useReengagementRecordDetail(touchKey: string | null) {
  return useQuery({
    queryKey: ['reengagement-record-detail', touchKey],
    queryFn: () => reengagementService.getReengagementRecordDetail(touchKey!),
    enabled: !!touchKey,
    staleTime: 60000,
  });
}

/**
 * 获取复聊场景注册表（只读展示；仅随发版变化，长缓存）
 */
export function useReengagementScenarios() {
  return useQuery({
    queryKey: ['reengagement-scenarios'],
    queryFn: () => reengagementService.getReengagementScenarios(),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * 获取候选人视角聚合（一行一个候选人，各场景当前态 + 下一次待发任务）
 */
export function useReengagementCandidates(options?: {
  startDate?: string;
  endDate?: string;
  scenarioCode?: string;
  sessionId?: string;
  pendingOnly?: boolean;
  limit?: number;
  offset?: number;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ['reengagement-candidates', options],
    queryFn: () => reengagementService.getReengagementCandidates(options),
    enabled: options?.enabled ?? true,
    staleTime: 10000,
  });
}

/**
 * 获取二次触发分组统计（status x scenario_code 计数）
 */
export function useReengagementStats(options?: { startDate?: string; endDate?: string }) {
  return useQuery({
    queryKey: ['reengagement-stats', options],
    queryFn: () => reengagementService.getReengagementStats(options),
    staleTime: 10000,
  });
}
