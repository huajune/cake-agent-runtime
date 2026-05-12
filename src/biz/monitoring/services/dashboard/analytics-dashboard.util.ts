import { ScenarioType } from '@enums/agent.enum';
import { addLocalDays, getLocalDayStart } from '@infra/utils/date.util';
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

    case 'week': {
      const currentStartDate = addLocalDays(getLocalDayStart(nowDate), -6);
      const currentStart = currentStartDate.getTime();
      const previousStartDate = addLocalDays(currentStartDate, -7);
      const previousStart = previousStartDate.getTime();

      return {
        currentStart,
        currentEnd: now,
        previousStart,
        previousEnd: previousStart + (now - currentStart),
      };
    }

    case 'month': {
      const currentStartDate = addLocalDays(getLocalDayStart(nowDate), -29);
      const currentStart = currentStartDate.getTime();
      const previousStartDate = addLocalDays(currentStartDate, -30);
      const previousStart = previousStartDate.getTime();

      return {
        currentStart,
        currentEnd: now,
        previousStart,
        previousEnd: previousStart + (now - currentStart),
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
