import { ScenarioType } from '@enums/agent.enum';
import type { MessageProcessingRecordInput } from '@biz/message/types/message.types';
import type { AgentInvocationRecord, MessageProcessingRecord } from '@shared-types/tracking.types';
import type { TimeRange } from '../../types/analytics.types';

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
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const currentStart = todayStart.getTime();
      const previousStartDate = new Date(todayStart);
      previousStartDate.setDate(previousStartDate.getDate() - 1);
      const previousStart = previousStartDate.getTime();

      return {
        currentStart,
        currentEnd: now,
        previousStart,
        previousEnd: previousStart + (now - currentStart),
      };
    }

    case 'week': {
      const weekStart = new Date(nowDate);
      const daysSinceMonday = (weekStart.getDay() + 6) % 7;
      weekStart.setDate(weekStart.getDate() - daysSinceMonday);
      weekStart.setHours(0, 0, 0, 0);
      const currentStart = weekStart.getTime();
      const previousWeekStart = new Date(weekStart);
      previousWeekStart.setDate(previousWeekStart.getDate() - 7);
      const previousStart = previousWeekStart.getTime();

      return {
        currentStart,
        currentEnd: now,
        previousStart,
        previousEnd: previousStart + (now - currentStart),
      };
    }

    case 'month': {
      const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1);
      const currentStart = monthStart.getTime();
      const previousMonthStart = new Date(nowDate.getFullYear(), nowDate.getMonth() - 1, 1);
      const previousStart = previousMonthStart.getTime();

      return {
        currentStart,
        currentEnd: now,
        previousStart,
        previousEnd: Math.min(previousStart + (now - currentStart), currentStart),
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
