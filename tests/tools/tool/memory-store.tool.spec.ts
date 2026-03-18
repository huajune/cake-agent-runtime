import { buildMemoryStoreTool } from '@tools/memory-store.tool';
import { ToolBuildContext } from '@shared-types/tool.types';

describe('buildMemoryStoreTool', () => {
  const mockMemoryService = {
    store: jest.fn().mockResolvedValue(undefined),
  };

  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    messages: [],
  };

  beforeEach(() => jest.clearAllMocks());

  it('should return a ToolBuilder that produces a tool', () => {
    const builder = buildMemoryStoreTool(mockMemoryService as never);
    const builtTool = builder(mockContext);
    expect(builtTool).toBeDefined();
  });

  it('should store facts via MemoryService', async () => {
    const builder = buildMemoryStoreTool(mockMemoryService as never);
    const builtTool = builder(mockContext);

    const result = await (
      builtTool as { execute: (args: { facts: Record<string, unknown> }) => Promise<unknown> }
    ).execute({
      facts: { name: '张三', age: '22' },
    });

    expect(mockMemoryService.store).toHaveBeenCalledWith('wework_session:corp-1:user-1:sess-1', {
      name: '张三',
      age: '22',
    });
    expect(result).toEqual({ success: true, stored: 2 });
  });
});
