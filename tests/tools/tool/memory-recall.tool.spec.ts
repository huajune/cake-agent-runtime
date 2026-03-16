import { Test, TestingModule } from '@nestjs/testing';
import { MemoryRecallToolService } from '@tools/memory-recall.tool';
import { MemoryService } from '@memory/memory.service';
import { ToolBuildContext } from '@tools/tool.types';

describe('MemoryRecallToolService', () => {
  let service: MemoryRecallToolService;
  let memoryService: MemoryService;

  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    messages: [],
    channelType: 'private',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryRecallToolService,
        {
          provide: MemoryService,
          useValue: { recall: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<MemoryRecallToolService>(MemoryRecallToolService);
    memoryService = module.get<MemoryService>(MemoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
    expect(service.toolName).toBe('memory_recall');
  });

  it('should return found=false when no memory exists', async () => {
    (memoryService.recall as jest.Mock).mockResolvedValue(null);

    const builtTool = service.buildTool(mockContext);
    const result = await (
      builtTool as { execute: (args: Record<string, never>) => Promise<unknown> }
    ).execute({});

    expect(memoryService.recall).toHaveBeenCalledWith('wework_session:corp-1:user-1');
    expect(result).toEqual({ found: false, message: '无历史记忆' });
  });

  it('should return found=true with facts when memory exists', async () => {
    const mockEntry = {
      key: 'wework_session:corp-1:user-1',
      content: { name: '张三', age: '22' },
      updatedAt: '2026-03-16T00:00:00.000Z',
    };
    (memoryService.recall as jest.Mock).mockResolvedValue(mockEntry);

    const builtTool = service.buildTool(mockContext);
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
