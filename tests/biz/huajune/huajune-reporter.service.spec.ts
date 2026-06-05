import { HuajuneReporterService } from '@biz/huajune/huajune-reporter.service';

function buildService(overrides: Record<string, string>) {
  const configService = {
    get: jest.fn((key: string, def?: string) => overrides[key] ?? def),
  };
  return new HuajuneReporterService(configService as never);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('HuajuneReporterService', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { results: [{ status: 'created' }] } }),
    });
  });

  it('skips reporting silently when HUAJUNE_API_TOKEN is absent', async () => {
    const service = buildService({});
    service.reportInterviewBooked({
      agentId: 'gaoyaqi-cake-1',
      candidateName: '张三',
      idempotencyKey: '12345',
      interviewTime: '2026-06-02 14:00:00',
    });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts interview_booked with required details.interviewTime + duliday platform', async () => {
    const service = buildService({ HUAJUNE_API_TOKEN: 'tok-1' });
    service.reportInterviewBooked({
      agentId: 'gaoyaqi-cake-1',
      candidateName: '张三',
      idempotencyKey: '12345',
      interviewTime: '2026-06-02 14:00:00',
      candidatePhone: '13800000000',
      job: { jobId: 527349, jobName: '店员' },
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://huajune.duliday.com/api/v1/recruitment-events');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    const body = JSON.parse(init.body);
    const event = body.events[0];
    expect(event.eventType).toBe('interview_booked');
    expect(event.agentId).toBe('gaoyaqi-cake-1');
    expect(event.sourcePlatform).toBe('duliday');
    expect(event.idempotencyKey).toBe('12345');
    expect(event.candidate.name).toBe('张三');
    expect(event.details.interviewTime).toBe('2026-06-02 14:00:00');
    expect(event.details.candidatePhone).toBe('13800000000');
    expect(event.job).toEqual({ jobId: 527349, jobName: '店员' });
  });

  it('message_sent carries required details.content', async () => {
    const service = buildService({ HUAJUNE_API_TOKEN: 'tok-1' });
    service.reportMessageSent({
      agentId: 'gaoyaqi-cake-1',
      candidateName: '张三',
      content: '你好，可以聊聊岗位吗',
    });
    await flush();

    const event = JSON.parse(fetchMock.mock.calls[0][1].body).events[0];
    expect(event.eventType).toBe('message_sent');
    expect(event.details.content).toBe('你好，可以聊聊岗位吗');
  });

  it('skips when agentId is missing (no candidate attribution)', async () => {
    const service = buildService({ HUAJUNE_API_TOKEN: 'tok-1' });
    service.reportCandidateContacted({ agentId: '', candidateName: '张三' });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
