import { Test, TestingModule } from '@nestjs/testing';
import { WeworkPlanTurnToolService } from '@ai/tool/wework-plan-turn.tool';
import { AgentRunnerService } from '@ai/runner/agent-runner.service';
import { ModelService } from '@ai/model/model.service';
import { ToolBuildContext } from '@ai/tool/tool.types';
import { type StageGoals, type TurnPlan } from '@ai/types/wework.types';

describe('WeworkPlanTurnToolService', () => {
  let service: WeworkPlanTurnToolService;
  let agentRunner: { generateObject: jest.Mock };

  beforeEach(async () => {
    agentRunner = { generateObject: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeworkPlanTurnToolService,
        { provide: AgentRunnerService, useValue: agentRunner },
        {
          provide: ModelService,
          useValue: { resolve: jest.fn().mockReturnValue({}) },
        },
      ],
    }).compile();

    service = module.get(WeworkPlanTurnToolService);
  });

  const makeContext = (messages: unknown[] = []): ToolBuildContext => ({
    messages,
    userId: 'user-1',
    corpId: 'corp-1',
    channelType: 'private',
    stageGoals: makeStageGoals(),
  });

  const makeStageGoals = (): StageGoals =>
    ({
      trust_building: {
        primaryGoal: '建立信任',
        successCriteria: ['候选人愿意沟通'],
        ctaStrategy: '用轻量提问引导',
      },
      job_consultation: {
        primaryGoal: '回答岗位问题',
        successCriteria: ['候选人满意'],
        ctaStrategy: '引导面试预约',
      },
    }) as StageGoals;

  const basePlan: TurnPlan = {
    stage: 'trust_building',
    subGoals: ['建立信任'],
    needs: ['none'],
    riskFlags: [],
    confidence: 0.8,
    extractedInfo: {
      mentionedBrand: null,
      city: null,
      mentionedLocations: null,
      mentionedDistricts: null,
      specificAge: null,
      hasUrgency: null,
      preferredSchedule: null,
    },
    reasoningText: '初次对话',
  };

  it('should be defined', () => {
    expect(service).toBeDefined();
    expect(service.toolName).toBe('wework_plan_turn');
  });

  it('should implement ToolFactory interface', () => {
    expect(service.toolName).toBeDefined();
    expect(service.toolDescription).toBeDefined();
    expect(typeof service.buildTool).toBe('function');
  });

  describe('buildTool', () => {
    it('should return a tool with correct description', () => {
      const builtTool = service.buildTool(makeContext());
      expect(builtTool).toBeDefined();
    });

    it('should call agentRunner.generateObject on execute', async () => {
      agentRunner.generateObject.mockResolvedValue({ object: basePlan });

      const context = makeContext([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好呀' },
        { role: 'user', content: '工资多少' },
      ]);

      const builtTool = service.buildTool(context);
      const result = (await builtTool.execute(
        {},
        { toolCallId: 'test', messages: [], abortSignal: undefined as never },
      )) as Record<string, unknown>;

      expect(agentRunner.generateObject).toHaveBeenCalled();
      expect(result.stage).toBe('trust_building');
    });

    it('should return stageGoal from config', async () => {
      const plan = { ...basePlan, stage: 'job_consultation' as const };
      agentRunner.generateObject.mockResolvedValue({ object: plan });

      const context = makeContext([{ role: 'user', content: '工资多少' }]);
      const builtTool = service.buildTool(context);
      const result = (await builtTool.execute(
        {},
        { toolCallId: 'test', messages: [], abortSignal: undefined as never },
      )) as Record<string, unknown>;

      expect((result.stageGoal as Record<string, string>).primaryGoal).toBe('回答岗位问题');
    });

    it('should return fallback stageGoal when stage not in config', async () => {
      const plan = { ...basePlan, stage: 'onboard_followup' as const };
      agentRunner.generateObject.mockResolvedValue({ object: plan });

      const context = makeContext([{ role: 'user', content: 'test' }]);
      const builtTool = service.buildTool(context);
      const result = (await builtTool.execute(
        {},
        { toolCallId: 'test', messages: [], abortSignal: undefined as never },
      )) as Record<string, unknown>;

      expect((result.stageGoal as Record<string, string>).primaryGoal).toBe('保持对话');
    });

    it('should handle LLM failure with rule-based fallback', async () => {
      agentRunner.generateObject.mockRejectedValue(new Error('LLM timeout'));

      const context = makeContext([{ role: 'user', content: '工资多少钱' }]);
      const builtTool = service.buildTool(context);
      const result = (await builtTool.execute(
        {},
        { toolCallId: 'test', messages: [], abortSignal: undefined as never },
      )) as Record<string, unknown>;

      expect(result.stage).toBe('trust_building');
      expect(result.confidence).toBe(0.35);
      expect(result.needs).toContain('salary');
    });
  });
});
