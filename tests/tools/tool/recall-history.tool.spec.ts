import { buildRecallHistoryTool } from '@tools/recall-history.tool';
import { ToolBuildContext } from '@shared-types/tool.types';

describe('buildRecallHistoryTool', () => {
  const mockLongTermService = {
    getSummaryData: jest.fn(),
    formatSummaryForPrompt: jest.fn(),
  };

  const mockContext: ToolBuildContext = {
    userId: 'user-123',
    corpId: 'corp-456',
    sessionId: 'sess-789',
    messages: [],
  };

  beforeEach(() => jest.clearAllMocks());

  it('should build a valid tool', () => {
    const builder = buildRecallHistoryTool(mockLongTermService as never);
    const builtTool = builder(mockContext);
    expect(builtTool).toBeDefined();
  });

  it('should return not found when no summaries', async () => {
    mockLongTermService.getSummaryData.mockResolvedValue(null);

    const builder = buildRecallHistoryTool(mockLongTermService as never);
    const builtTool = builder(mockContext);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({});

    expect(result).toEqual({ found: false, message: '该用户无历史求职记录' });
  });

  it('should return formatted summaries when available', async () => {
    mockLongTermService.getSummaryData.mockResolvedValue({
      recent: [{ summary: '找上海兼职', sessionId: 's1', startTime: '2026-03-15', endTime: '2026-03-15' }],
      archive: null,
    });
    mockLongTermService.formatSummaryForPrompt.mockReturnValue('[历史摘要]\n...');

    const builder = buildRecallHistoryTool(mockLongTermService as never);
    const builtTool = builder(mockContext);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({});

    expect(result.found).toBe(true);
    expect(result.recentCount).toBe(1);
    expect(result.content).toContain('[历史摘要]');
  });
});
