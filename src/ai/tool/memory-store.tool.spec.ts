import { Test, TestingModule } from '@nestjs/testing';
import { MemoryStoreToolService } from './memory-store.tool';
import { MemoryService } from '../memory/memory.service';
import { ToolBuildContext } from './tool.types';

describe('MemoryStoreToolService', () => {
  let service: MemoryStoreToolService;
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
        MemoryStoreToolService,
        {
          provide: MemoryService,
          useValue: { store: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<MemoryStoreToolService>(MemoryStoreToolService);
    memoryService = module.get<MemoryService>(MemoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
    expect(service.toolName).toBe('memory_store');
  });

  it('should implement ToolFactory interface', () => {
    expect(service.toolName).toBeDefined();
    expect(service.toolDescription).toBeDefined();
    expect(typeof service.buildTool).toBe('function');
  });

  it('should build a tool that stores facts', async () => {
    const builtTool = service.buildTool(mockContext);
    expect(builtTool).toBeDefined();

    // Execute the tool
    const result = await (
      builtTool as { execute: (args: { facts: Record<string, unknown> }) => Promise<unknown> }
    ).execute({
      facts: { name: '张三', age: '22' },
    });

    expect(memoryService.store).toHaveBeenCalledWith('wework_session:corp-1:user-1', {
      name: '张三',
      age: '22',
    });
    expect(result).toEqual({ success: true, stored: 2 });
  });
});
