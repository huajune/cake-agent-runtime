import { buildAdvanceStageTool } from '@tools/advance-stage.tool';
import { ToolBuildContext } from '@shared-types/tool.types';

describe('buildAdvanceStageTool', () => {
  const mockProceduralService = {
    set: jest.fn().mockResolvedValue(undefined),
  };

  const mockContext: ToolBuildContext = {
    userId: 'user-123',
    corpId: 'corp-456',
    sessionId: 'sess-789',
    messages: [],
  };

  beforeEach(() => jest.clearAllMocks());

  it('should build a valid tool', () => {
    const builder = buildAdvanceStageTool(mockProceduralService as never);
    const builtTool = builder(mockContext);
    expect(builtTool).toBeDefined();
  });

  it('should store stage in memory when executed', async () => {
    const builder = buildAdvanceStageTool(mockProceduralService as never);
    const builtTool = builder(mockContext);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({
      nextStage: 'job_consultation',
      reason: '候选人开始询问岗位信息',
    });

    expect(result).toEqual({ success: true, newStage: 'job_consultation' });
    expect(mockProceduralService.set).toHaveBeenCalledWith(
      'corp-456',
      'user-123',
      'sess-789',
      expect.objectContaining({
        currentStage: 'job_consultation',
        reason: '候选人开始询问岗位信息',
        advancedAt: expect.any(String),
      }),
    );
  });

  it('should use correct context params', async () => {
    const customContext: ToolBuildContext = {
      userId: 'custom-user',
      corpId: 'custom-corp',
      sessionId: 'custom-sess',
      messages: [],
    };

    const builder = buildAdvanceStageTool(mockProceduralService as never);
    const builtTool = builder(customContext);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (builtTool as any).execute({
      nextStage: 'interview_scheduling',
      reason: '候选人确认意向',
    });

    expect(mockProceduralService.set).toHaveBeenCalledWith(
      'custom-corp',
      'custom-user',
      'custom-sess',
      expect.any(Object),
    );
  });
});
