import { AnalyticsTrendBuilderService } from '@analytics/trends/analytics-trend-builder.service';
import { formatLocalDate, formatLocalMinute } from '@infra/utils/date.util';
import { MessageProcessingRecord, MonitoringErrorLog } from '@shared-types/tracking.types';

/** 从时间戳生成本地 minute key，与 service 内部逻辑一致 */
function toMinuteKey(timestamp: number): string {
  return formatLocalMinute(new Date(timestamp));
}

function toDayKey(timestamp: number): string {
  return formatLocalDate(new Date(timestamp));
}

describe('AnalyticsTrendBuilderService', () => {
  let service: AnalyticsTrendBuilderService;

  beforeEach(() => {
    service = new AnalyticsTrendBuilderService();
  });

  it('should build response trend buckets for today', () => {
    const ts = new Date('2026-04-13T10:00:10+08:00').getTime();
    const records: MessageProcessingRecord[] = [
      {
        messageId: '1',
        chatId: 'chat-1',
        receivedAt: ts,
        status: 'success',
        totalDuration: 1000,
      },
      {
        messageId: '2',
        chatId: 'chat-1',
        receivedAt: new Date('2026-04-13T10:00:40+08:00').getTime(),
        status: 'failure',
        totalDuration: 3000,
      },
      {
        messageId: '3',
        chatId: 'chat-1',
        receivedAt: new Date('2026-04-13T10:00:50+08:00').getTime(),
        status: 'processing',
      },
    ];

    expect(service.buildResponseTrend(records, 'today')).toEqual([
      {
        minute: toMinuteKey(ts),
        avgDuration: 2000,
        messageCount: 2,
        successRate: 50,
      },
    ]);
  });

  it('should bucket trend labels in Asia/Shanghai instead of server timezone', () => {
    const ts = new Date('2026-04-28T10:11:30Z').getTime();

    expect(
      service.buildResponseTrend(
        [
          {
            messageId: '1',
            chatId: 'chat-1',
            receivedAt: ts,
            status: 'success',
            totalDuration: 1000,
          },
        ],
        'today',
      ),
    ).toEqual([
      {
        minute: '2026-04-28 18:11',
        avgDuration: 1000,
        messageCount: 1,
        successRate: 100,
      },
    ]);
  });

  it('should build alert trend sorted by time bucket', () => {
    const ts1 = new Date('2026-04-10T08:00:00+08:00').getTime();
    const ts2 = new Date('2026-04-12T08:00:00+08:00').getTime();
    const logs: MonitoringErrorLog[] = [
      { messageId: '2', timestamp: ts2, error: 'b' },
      { messageId: '1', timestamp: ts1, error: 'a' },
    ];

    expect(service.buildAlertTrend(logs, 'week')).toEqual([
      { minute: toDayKey(ts1), count: 1 },
      { minute: toDayKey(ts2), count: 1 },
    ]);
  });

  it('should build business trend from toolCalls and dynamic-tool outputs', () => {
    const ts = new Date('2026-04-13T10:00:10+08:00').getTime();
    const records: MessageProcessingRecord[] = [
      {
        messageId: '1',
        chatId: 'chat-1',
        userId: 'user-1',
        receivedAt: ts,
        status: 'success',
        agentInvocation: {
          request: {},
          response: {
            toolCalls: [
              {
                toolName: 'duliday_interview_booking',
                result: { success: true },
              },
            ],
          },
          isFallback: false,
        },
      },
      {
        messageId: '2',
        chatId: 'chat-1',
        userId: 'user-2',
        receivedAt: new Date('2026-04-13T10:00:20+08:00').getTime(),
        status: 'success',
        agentInvocation: {
          request: {},
          response: {
            messages: [
              {
                parts: [
                  {
                    type: 'dynamic-tool',
                    toolName: 'duliday_interview_booking',
                    state: 'output-available',
                    output: {
                      type: 'object',
                      object: { success: false },
                    },
                  },
                ],
              },
            ],
          },
          isFallback: false,
        },
      },
    ];

    expect(service.buildBusinessTrend(records, 'today')).toEqual([
      {
        minute: toMinuteKey(ts),
        consultations: 2,
        bookingAttempts: 2,
        successfulBookings: 1,
        conversionRate: 100,
        bookingSuccessRate: 50,
      },
    ]);
  });

  it('should prefer top-level toolCalls when building booking trend', () => {
    const ts = new Date('2026-04-13T10:00:10+08:00').getTime();
    const records: MessageProcessingRecord[] = [
      {
        messageId: '1',
        chatId: 'chat-1',
        userId: 'user-1',
        receivedAt: ts,
        status: 'success',
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {},
            result: { success: true },
          },
        ],
        agentInvocation: {
          request: {},
          response: {
            toolCalls: [
              {
                toolName: 'duliday_interview_booking',
                result: { success: true },
              },
            ],
          },
          isFallback: false,
        },
      },
    ];

    expect(service.buildBusinessTrend(records, 'today')).toEqual([
      {
        minute: toMinuteKey(ts),
        consultations: 1,
        bookingAttempts: 1,
        successfulBookings: 1,
        conversionRate: 100,
        bookingSuccessRate: 100,
      },
    ]);
  });
});
