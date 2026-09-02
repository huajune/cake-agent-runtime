import { ScenarioType } from '@enums/agent.enum';
import { addLocalDays, getLocalDayStart } from '@infra/utils/date.util';
import { isRecord as isPlainObject } from '@infra/utils/object.util';
import type { MessageProcessingRecordInput } from '@biz/message/types/message.types';
import type { AgentInvocationRecord, MessageProcessingRecord } from '@shared-types/tracking.types';
import { ALL_RANGE_START_DATE, type TimeRange } from '../../types/analytics.types';

const RANGE_DAYS: Record<Exclude<TimeRange, 'today' | 'all'>, number> = {
  week: 7,
  month: 30,
  twoMonths: 60,
  threeMonths: 90,
};

export interface DashboardTimeRanges {
  currentStart: number;
  currentEnd: number;
  previousStart: number;
  previousEnd: number;
}

export function calculateDashboardTimeRanges(timeRange: TimeRange): DashboardTimeRanges {
  const nowDate = new Date();
  const now = nowDate.getTime();

  switch (timeRange) {
    case 'today': {
      const todayStart = getLocalDayStart(nowDate);
      const currentStart = todayStart.getTime();
      const previousStartDate = addLocalDays(todayStart, -1);
      const previousStart = previousStartDate.getTime();

      return {
        currentStart,
        currentEnd: now,
        previousStart,
        previousEnd: previousStart + (now - currentStart),
      };
    }

    case 'week':
    case 'month':
    case 'twoMonths':
    case 'threeMonths': {
      const days = RANGE_DAYS[timeRange];
      const currentStartDate = addLocalDays(getLocalDayStart(nowDate), -(days - 1));
      const currentStart = currentStartDate.getTime();
      const previousStartDate = addLocalDays(currentStartDate, -days);
      const previousStart = previousStartDate.getTime();

      return {
        currentStart,
        currentEnd: now,
        previousStart,
        previousEnd: previousStart + (now - currentStart),
      };
    }

    case 'all': {
      // 「全部」= 业务数据起点至今；观测卡只有 90 天，由 dataCoverage 如实标注覆盖起点。
      // 环比窗口取等长的前一段（必然无数据），前端按 previousPeriodCovered=false 隐藏环比。
      const currentStartDate = getLocalDayStart(new Date(`${ALL_RANGE_START_DATE}T00:00:00+08:00`));
      const currentStart = currentStartDate.getTime();
      const span = now - currentStart;
      return {
        currentStart,
        currentEnd: now,
        previousStart: currentStart - span,
        previousEnd: currentStart,
      };
    }

    default: {
      const currentStart = now - 24 * 60 * 60 * 1000;
      return {
        currentStart,
        currentEnd: now,
        previousStart: currentStart - 24 * 60 * 60 * 1000,
        previousEnd: currentStart,
      };
    }
  }
}

export function getDashboardTimeRangeCutoff(range: TimeRange): Date {
  return new Date(calculateDashboardTimeRanges(range).currentStart);
}

export function toMessageProcessingRecords(
  records: MessageProcessingRecordInput[],
): MessageProcessingRecord[] {
  return records.map(toMessageProcessingRecord);
}

export function toMessageProcessingRecord(
  record: MessageProcessingRecordInput,
): MessageProcessingRecord {
  const { scenario, agentInvocation, ...rest } = record;
  const result: MessageProcessingRecord = { ...rest };
  const normalizedScenario = toScenarioType(scenario);

  if (normalizedScenario) {
    result.scenario = normalizedScenario;
  }

  if (isAgentInvocationRecord(agentInvocation)) {
    result.agentInvocation = agentInvocation;
  }

  return result;
}

function toScenarioType(value: string | undefined): ScenarioType | undefined {
  if (!value) {
    return undefined;
  }

  return Object.values(ScenarioType).includes(value as ScenarioType)
    ? (value as ScenarioType)
    : undefined;
}

function isAgentInvocationRecord(value: unknown): value is AgentInvocationRecord {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    isPlainObject(value.request) &&
    isPlainObject(value.response) &&
    typeof value.isFallback === 'boolean'
  );
}
