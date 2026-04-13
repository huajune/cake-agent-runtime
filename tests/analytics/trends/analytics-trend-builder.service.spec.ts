import { AnalyticsTrendBuilderService } from '@analytics/trends/analytics-trend-builder.service';
import { MessageProcessingRecord, MonitoringErrorLog } from '@shared-types/tracking.types';

describe('AnalyticsTrendBuilderService', () => {
  let service: AnalyticsTrendBuilderService;

  beforeEach(() => {
    service = new AnalyticsTrendBuilderService();
  });

  it('should build response trend buckets for today', () => {
    const records: MessageProcessingRecord[] = [
      {
        messageId: '1',
        chatId: 'chat-1',
        receivedAt: new Date('2026-04-13T10:00:10+08:00').getTime(),
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
        minute: '2026-04-13 10:00',
        avgDuration: 2000,
        messageCount: 2,
        successRate: 50,
      },
    ]);
  });

  it('should build alert trend sorted by time bucket', () => {
    const logs: MonitoringErrorLog[] = [
      { messageId: '2', timestamp: new Date('2026-04-12T08:00:00+08:00').getTime(), error: 'b' },
      { messageId: '1', timestamp: new Date('2026-04-10T08:00:00+08:00').getTime(), error: 'a' },
    ];

    expect(service.buildAlertTrend(logs, 'week')).toEqual([
      { minute: '2026-04-10', count: 1 },
      { minute: '2026-04-12', count: 1 },
    ]);
  });

  it('should build business trend from toolCalls and dynamic-tool outputs', () => {
    const records: MessageProcessingRecord[] = [
      {
        messageId: '1',
        chatId: 'chat-1',
        userId: 'user-1',
        receivedAt: new Date('2026-04-13T10:00:10+08:00').getTime(),
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
        minute: '2026-04-13 10:00',
        consultations: 2,
        bookingAttempts: 2,
        successfulBookings: 1,
        conversionRate: 100,
        bookingSuccessRate: 50,
      },
    ]);
  });
});
