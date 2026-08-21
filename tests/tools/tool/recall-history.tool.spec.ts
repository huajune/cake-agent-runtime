import { buildRecallHistoryTool } from '@tools/recall-history.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { createToolContext } from '../../helpers/tool-context.fixture';

describe('buildRecallHistoryTool', () => {
  const mockMemoryService = {
    getSessionSummaries: jest.fn(),
  };

  const mockContext: ToolBuildContext = createToolContext({
    session: { userId: 'user-123', corpId: 'corp-456', sessionId: 'sess-789' },
  });

  beforeEach(() => jest.clearAllMocks());

  it('should build a valid tool', () => {
    const builder = buildRecallHistoryTool(mockMemoryService as never);
    const builtTool = builder(mockContext);
    expect(builtTool).toBeDefined();
  });

  it('should return not found when no summaries', async () => {
    mockMemoryService.getSessionSummaries.mockResolvedValue(null);

    const builder = buildRecallHistoryTool(mockMemoryService as never);
    const builtTool = builder(mockContext);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({});

    expect(result).toEqual({ found: false, message: '该用户无历史求职记录' });
  });

  it('should return formatted summaries when available', async () => {
    mockMemoryService.getSessionSummaries.mockResolvedValue({
      recent: [
        { summary: '找上海兼职', sessionId: 's1', startTime: '2026-03-15', endTime: '2026-03-15' },
      ],
      archive: null,
    });

    const builder = buildRecallHistoryTool(mockMemoryService as never);
    const builtTool = builder(mockContext);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({});

    expect(result.found).toBe(true);
    expect(result.recentCount).toBe(1);
    expect(result.content).toContain('[历史摘要]');
  });
});
