import { buildAdvanceStageTool } from '@tools/advance-stage.tool';
import { ToolBuildContext } from '@shared-types/tool.types';

describe('buildAdvanceStageTool', () => {
  const mockMemoryService = {
    setStage: jest.fn().mockResolvedValue(undefined),
  };

  const mockContext: ToolBuildContext = {
    userId: 'user-123',
    corpId: 'corp-456',
    sessionId: 'sess-789',
    messages: [],
    currentStage: 'trust_building',
    availableStages: ['trust_building', 'job_consultation', 'interview_scheduling'],
    stageGoals: {
      trust_building: {
        stage: 'trust_building',
        label: '建联',
        description: '初次接触并建立基本信任',
        primaryGoal: '建立信任',
        successCriteria: ['已明确用户求职方向'],
        ctaStrategy: ['了解求职方向'],
        disallowedActions: ['不要直接约面'],
      },
      job_consultation: {
        stage: 'job_consultation',
        label: '岗位咨询',
        description: '围绕岗位信息答疑并推进意向确认',
        primaryGoal: '回答岗位问题并推动意向',
        successCriteria: ['已回答核心岗位问题'],
        ctaStrategy: ['引导确认意向岗位'],
        disallowedActions: ['不要编造岗位信息'],
      },
      interview_scheduling: {
        stage: 'interview_scheduling',
        label: '约面',
        description: '确认岗位后推进面试预约',
        primaryGoal: '完成预约',
        successCriteria: ['已确认预约信息'],
        ctaStrategy: ['收集预约资料'],
        disallowedActions: ['不要未预约先确认成功'],
      },
    },
  };

  beforeEach(() => jest.clearAllMocks());

  it('should build a valid tool', () => {
    const builder = buildAdvanceStageTool(mockMemoryService as never);
    const builtTool = builder(mockContext);
    expect(builtTool).toBeDefined();
  });

  it('should store stage in memory when executed', async () => {
    const builder = buildAdvanceStageTool(mockMemoryService as never);
    const builtTool = builder(mockContext);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({
      nextStage: 'job_consultation',
      reason: '候选人开始询问岗位信息',
    });

    expect(result).toEqual({
      success: true,
      fromStage: 'trust_building',
      newStage: 'job_consultation',
      effectiveStageStrategy: {
        stage: 'job_consultation',
        label: '岗位咨询',
        description: '围绕岗位信息答疑并推进意向确认',
        primaryGoal: '回答岗位问题并推动意向',
        successCriteria: ['已回答核心岗位问题'],
        ctaStrategy: ['引导确认意向岗位'],
        disallowedActions: ['不要编造岗位信息'],
      },
    });
    expect(mockMemoryService.setStage).toHaveBeenCalledWith(
      'corp-456',
      'user-123',
      'sess-789',
      expect.objectContaining({
        currentStage: 'job_consultation',
        fromStage: 'trust_building',
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
      currentStage: 'job_consultation',
      availableStages: ['trust_building', 'job_consultation', 'interview_scheduling'],
      stageGoals: mockContext.stageGoals,
    };

    const builder = buildAdvanceStageTool(mockMemoryService as never);
    const builtTool = builder(customContext);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (builtTool as any).execute({
      nextStage: 'interview_scheduling',
      reason: '候选人确认意向',
    });

    expect(mockMemoryService.setStage).toHaveBeenCalledWith(
      'custom-corp',
      'custom-user',
      'custom-sess',
      expect.any(Object),
    );
  });

  it('should reject invalid stage names', async () => {
    const builder = buildAdvanceStageTool(mockMemoryService as never);
    const builtTool = builder(mockContext);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({
      nextStage: 'unknown_stage',
      reason: '测试非法阶段',
    });

    expect(result).toEqual({
      success: false,
      errorCode: 'invalid_stage',
      error: '非法阶段: unknown_stage',
      currentStage: 'trust_building',
      allowedStages: ['trust_building', 'job_consultation', 'interview_scheduling'],
    });
    expect(mockMemoryService.setStage).not.toHaveBeenCalled();
  });

  it('should reject advancing to the same stage', async () => {
    const builder = buildAdvanceStageTool(mockMemoryService as never);
    const builtTool = builder(mockContext);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (builtTool as any).execute({
      nextStage: 'trust_building',
      reason: '测试重复推进',
    });

    expect(result).toEqual({
      success: false,
      errorCode: 'same_stage',
      error: '当前已处于阶段: trust_building',
      currentStage: 'trust_building',
    });
    expect(mockMemoryService.setStage).not.toHaveBeenCalled();
  });
});
