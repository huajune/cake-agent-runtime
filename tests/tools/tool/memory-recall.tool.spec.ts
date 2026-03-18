import { buildMemoryRecallTool } from '@tools/memory-recall.tool';
import { ToolBuildContext } from '@shared-types/tool.types';

describe('buildMemoryRecallTool', () => {
  const mockMemoryService = {
    recall: jest.fn(),
  };

  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    messages: [],
  };

  beforeEach(() => jest.clearAllMocks());

  it('should return found=false when no memory exists', async () => {
    mockMemoryService.recall.mockResolvedValue(null);

    const builder = buildMemoryRecallTool(mockMemoryService as never);
    const builtTool = builder(mockContext);
    const result = await (
      builtTool as { execute: (args: Record<string, never>) => Promise<unknown> }
    ).execute({});

    expect(mockMemoryService.recall).toHaveBeenCalledWith('wework_session:corp-1:user-1:sess-1');
    expect(result).toEqual({ found: false, message: '无历史记忆' });
  });

  it('should return found=true with facts when memory exists', async () => {
    const mockEntry = {
      key: 'wework_session:corp-1:user-1:sess-1',
      content: { name: '张三', age: '22' },
      updatedAt: '2026-03-16T00:00:00.000Z',
    };
    mockMemoryService.recall.mockResolvedValue(mockEntry);

    const builder = buildMemoryRecallTool(mockMemoryService as never);
    const builtTool = builder(mockContext);
    const result = await (
      builtTool as { execute: (args: Record<string, never>) => Promise<unknown> }
    ).execute({});

    expect(result).toEqual({
      found: true,
      facts: { name: '张三', age: '22' },
      updatedAt: '2026-03-16T00:00:00.000Z',
    });
  });
});
