import { Test, TestingModule } from '@nestjs/testing';
import { MessageOpsController } from '@wecom/message/ingress/message-ops.controller';
import { MessageProcessor } from '@wecom/message/runtime/message.processor';

describe('MessageOpsController', () => {
  let controller: MessageOpsController;

  const mockMessageProcessor = {
    getWorkerStatus: jest.fn().mockReturnValue({
      concurrency: 2,
      activeJobs: 1,
      minConcurrency: 1,
      maxConcurrency: 20,
    }),
    setConcurrency: jest.fn().mockResolvedValue({
      success: true,
      concurrency: 4,
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessageOpsController],
      providers: [{ provide: MessageProcessor, useValue: mockMessageProcessor }],
    }).compile();

    controller = module.get<MessageOpsController>(MessageOpsController);
    jest.clearAllMocks();
  });

  it('should expose worker status', () => {
    expect(controller.getWorkerStatus()).toEqual({
      concurrency: 2,
      activeJobs: 1,
      minConcurrency: 1,
      maxConcurrency: 20,
    });
    expect(mockMessageProcessor.getWorkerStatus).toHaveBeenCalled();
  });

  it('should delegate worker concurrency updates', async () => {
    const result = await controller.setWorkerConcurrency({ concurrency: 4 });

    expect(mockMessageProcessor.setConcurrency).toHaveBeenCalledWith(4);
    expect(result).toEqual({
      success: true,
      concurrency: 4,
    });
  });
});
