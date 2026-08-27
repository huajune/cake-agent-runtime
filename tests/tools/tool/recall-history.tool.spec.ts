import { buildRecallHistoryTool } from '@tools/recall-history.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { createToolContext } from '../../helpers/tool-context.fixture';

describe('buildRecallHistoryTool', () => {
  const mockMemoryService = {
    getSessionSummaries: jest.fn(),
  };

  const mockContext: ToolBuildContext = createToolContext({
    session: {
      userId: 'user-123',
      corpId: 'corp-456',
      sessionId: 'sess-789',
      botUserId: 'wecom-user-1',
    },
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
    expect(mockMemoryService.getSessionSummaries).toHaveBeenCalledWith(
      'corp-456',
      'user-123',
      'wecom-user-1',
    );
  });

  it('should return formatted summaries when available', async () => {
    mockMemoryService.getSessionSummaries.mockResolvedValue([
      {
        summary: '找上海兼职',
        sessionId: 's1',
        startTime: '2026-03-15',
        endTime: '2026-03-15',
        coverageNote: '仅覆盖末 120 条（共 121 条）',
      },
    ]);

    const builder = buildRecallHistoryTool(mockMemoryService as never);
    const builtTool = builder(mockContext);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({});

    expect(result.found).toBe(true);
    expect(result.summaryCount).toBe(1);
    expect(result.content).toContain('[历史摘要]');
    expect(result.content).toContain('### 历次求职记录');
    expect(result.content).toContain('仅覆盖末 120 条（共 121 条）');
  });

  it('按时间顺序全量渲染摘要数组，不再返回 archive 分区', async () => {
    mockMemoryService.getSessionSummaries.mockResolvedValue([
      {
        summary: '第一段历史',
        sessionId: '',
        startTime: '',
        endTime: '',
      },
      {
        summary: '第二段历史',
        sessionId: 's2',
        startTime: '2026-08-20T00:00:00.000Z',
        endTime: '2026-08-20T01:00:00.000Z',
      },
    ]);

    const builder = buildRecallHistoryTool(mockMemoryService as never);
    const builtTool = builder(mockContext);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({});

    expect(result.summaryCount).toBe(2);
    expect(result).not.toHaveProperty('hasArchive');
    expect(result.content).toContain('[历史] 第一段历史');
    expect(result.content).toContain('[2026-08-20] 第二段历史');
    expect(result.content).not.toContain('归档段');
  });
});
