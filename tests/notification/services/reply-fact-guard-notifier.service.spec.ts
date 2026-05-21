import { Logger } from '@nestjs/common';
import { ReplyFactGuardNotifierService } from '@notification/services/reply-fact-guard-notifier.service';
import type { FeishuBitableSyncService } from '@biz/feishu-sync/bitable-sync.service';

describe('ReplyFactGuardNotifierService', () => {
  const mockBitableSync = {
    writeAgentTestFeedback: jest.fn<
      Promise<{ success: boolean; recordId?: string; error?: string }>,
      [unknown]
    >(),
  } as unknown as jest.Mocked<FeishuBitableSyncService>;

  let service: ReplyFactGuardNotifierService;
  let errorSpy: jest.SpyInstance;

  const buildParams = (overrides: Record<string, unknown> = {}) => ({
    chatId: 'chat-1',
    userId: 'user-1',
    traceId: 'trace-1',
    contactName: '候选人A',
    botImId: 'bot-im-1',
    botUserName: 'mgr-bob',
    userMessage: '你好，能加群吗',
    replyPreview: '我拉你进咱们餐饮兼职群了',
    contradictions: [{ ruleId: 'group_promise_without_invite', label: '承诺拉群但未成功调 invite_to_group' }],
    toolNames: ['duliday_job_list'],
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockBitableSync.writeAgentTestFeedback.mockResolvedValue({ success: true, recordId: 'rec-001' });
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service = new ReplyFactGuardNotifierService(mockBitableSync);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns true and writes badcase with correct fields on success', async () => {
    const result = await service.notifyContradiction(buildParams());

    expect(result).toBe(true);
    expect(mockBitableSync.writeAgentTestFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'badcase',
        chatId: 'chat-1',
        traceId: 'trace-1',
        candidateName: '候选人A',
        managerName: 'mgr-bob',
        errorType: 'group_promise_without_invite',
      }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('includes userMessage and replyPreview in chatHistory', async () => {
    await service.notifyContradiction(buildParams());

    const call = mockBitableSync.writeAgentTestFeedback.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(String(call.chatHistory)).toContain('你好，能加群吗');
    expect(String(call.chatHistory)).toContain('我拉你进咱们餐饮兼职群了');
  });

  it('returns false and logs error when writeAgentTestFeedback fails', async () => {
    mockBitableSync.writeAgentTestFeedback.mockResolvedValue({ success: false, error: '表格配置缺失' });

    const result = await service.notifyContradiction(buildParams({ chatId: 'chat-fail' }));

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('chatId=chat-fail');
  });

  it('returns false and logs error when writeAgentTestFeedback throws', async () => {
    mockBitableSync.writeAgentTestFeedback.mockRejectedValue(new Error('network error'));

    const result = await service.notifyContradiction(buildParams());

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('network error');
  });

  it('handles missing userMessage gracefully (chatHistory has only reply part)', async () => {
    await service.notifyContradiction(buildParams({ userMessage: undefined }));

    const call = mockBitableSync.writeAgentTestFeedback.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(String(call.chatHistory)).not.toContain('[候选人]');
    expect(String(call.chatHistory)).toContain('[招募经理]');
  });

  it('concatenates multiple ruleIds in errorType field', async () => {
    await service.notifyContradiction(
      buildParams({
        contradictions: [
          { ruleId: 'group_promise_without_invite', label: 'label-a' },
          { ruleId: 'salary_fabrication', label: 'label-b' },
        ],
      }),
    );

    const call = mockBitableSync.writeAgentTestFeedback.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(String(call.errorType)).toContain('group_promise_without_invite');
    expect(String(call.errorType)).toContain('salary_fabrication');
  });
});
