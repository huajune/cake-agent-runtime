import { Test, TestingModule } from '@nestjs/testing';
import { WeworkAgentOrchestratorService } from '@agent/services/wework-agent-orchestrator.service';
import { AgentRunnerService } from '@ai/runner/agent-runner.service';
import { ModelService } from '@ai/model/model.service';
import { ToolRegistryService } from '@ai/tool/tool-registry.service';
import { ProfileLoaderService } from '@agent/services/agent-profile-loader.service';
import { StrategyConfigService } from '@agent/strategy/strategy-config.service';

describe('WeworkAgentOrchestratorService', () => {
  let service: WeworkAgentOrchestratorService;
  let agentRunner: { run: jest.Mock };
  let modelService: { resolve: jest.Mock };
  let profileLoader: { getProfile: jest.Mock };
  let strategyConfig: { composeSystemPromptAndStageGoals: jest.Mock };
  let toolRegistry: { buildAll: jest.Mock };

  beforeEach(async () => {
    agentRunner = {
      run: jest.fn().mockResolvedValue({
        text: '你好，有什么可以帮助你的？',
        steps: 1,
        usage: { totalTokens: 500 },
      }),
    };
    modelService = { resolve: jest.fn().mockReturnValue('chat-model') };
    profileLoader = {
      getProfile: jest.fn().mockReturnValue({ systemPrompt: '你是招聘助手' }),
    };
    strategyConfig = {
      composeSystemPromptAndStageGoals: jest.fn().mockResolvedValue({
        systemPrompt: '# 人格设定\n\n你是招聘助手',
        stageGoals: {
          trust_building: {
            description: '建立信任',
            primaryGoal: '建立信任',
            successCriteria: [],
            ctaStrategy: '',
          },
        },
      }),
    };
    toolRegistry = {
      buildAll: jest.fn().mockReturnValue({
        wework_plan_turn: { type: 'plan_turn' },
        duliday_job_list: { type: 'job_list' },
        duliday_interview_booking: { type: 'booking' },
        memory_store: { type: 'memory_store' },
        memory_recall: { type: 'memory_recall' },
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeworkAgentOrchestratorService,
        { provide: AgentRunnerService, useValue: agentRunner },
        { provide: ModelService, useValue: modelService },
        { provide: ProfileLoaderService, useValue: profileLoader },
        { provide: StrategyConfigService, useValue: strategyConfig },
        { provide: ToolRegistryService, useValue: toolRegistry },
      ],
    }).compile();

    service = module.get(WeworkAgentOrchestratorService);
  });

  const baseParams = {
    messages: [{ role: 'user' as const, content: '你好' }],
    userId: 'user-1',
    corpId: 'corp-1',
  };

  describe('run', () => {
    it('should execute full orchestration pipeline', async () => {
      const result = await service.run(baseParams);

      // 1. Load profile
      expect(profileLoader.getProfile).toHaveBeenCalledWith('candidate-consultation');

      // 2. Compose system prompt
      expect(strategyConfig.composeSystemPromptAndStageGoals).toHaveBeenCalledWith('你是招聘助手');

      // 3. Build all tools via registry
      expect(toolRegistry.buildAll).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          corpId: 'corp-1',
          channelType: 'private',
        }),
      );

      // 4. Run agent
      expect(agentRunner.run).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'chat-model',
          messages: baseParams.messages,
          maxSteps: 5,
        }),
      );

      expect(result.text).toBe('你好，有什么可以帮助你的？');
    });

    it('should use custom scenario', async () => {
      await service.run({ ...baseParams, scenario: 'custom-scenario' });
      expect(profileLoader.getProfile).toHaveBeenCalledWith('custom-scenario');
    });

    it('should use custom maxSteps', async () => {
      await service.run({ ...baseParams, maxSteps: 10 });
      expect(agentRunner.run).toHaveBeenCalledWith(expect.objectContaining({ maxSteps: 10 }));
    });

    it('should pass stageGoals in ToolBuildContext', async () => {
      await service.run(baseParams);

      const context = toolRegistry.buildAll.mock.calls[0][0];
      expect(context.stageGoals).toBeDefined();
      expect(context.stageGoals.trust_building).toBeDefined();
    });

    it('should pass channelType to ToolBuildContext', async () => {
      await service.run({ ...baseParams, channelType: 'public' });

      const context = toolRegistry.buildAll.mock.calls[0][0];
      expect(context.channelType).toBe('public');
    });

    it('should propagate agent runner errors', async () => {
      agentRunner.run.mockRejectedValue(new Error('Model API error'));
      await expect(service.run(baseParams)).rejects.toThrow('Model API error');
    });

    it('should handle null profile gracefully', async () => {
      profileLoader.getProfile.mockReturnValue(null);
      await service.run(baseParams);
      expect(strategyConfig.composeSystemPromptAndStageGoals).toHaveBeenCalledWith('');
    });

    it('should convert stageGoals ctaStrategy array to string', async () => {
      strategyConfig.composeSystemPromptAndStageGoals.mockResolvedValue({
        systemPrompt: 'prompt',
        stageGoals: {
          trust_building: {
            description: '建立信任',
            primaryGoal: '信任',
            successCriteria: ['沟通'],
            ctaStrategy: ['策略1', '策略2'],
            disallowedActions: [],
          },
        },
      });

      await service.run(baseParams);

      const context = toolRegistry.buildAll.mock.calls[0][0];
      expect(context.stageGoals.trust_building.ctaStrategy).toBe('策略1\n策略2');
    });
  });
});
