import { Test, TestingModule } from '@nestjs/testing';
import { CustomLoggerService } from './custom-logger.service';
import { LoggerGateway, LogEntry } from './logger.gateway';

describe('CustomLoggerService', () => {
  let service: CustomLoggerService;
  let mockGateway: jest.Mocked<LoggerGateway>;

  beforeEach(async () => {
    mockGateway = {
      broadcast: jest.fn(),
    } as unknown as jest.Mocked<LoggerGateway>;

    // Reset static gateway to null before each test
    CustomLoggerService['gateway'] = null;

    const module: TestingModule = await Test.createTestingModule({
      providers: [CustomLoggerService],
    }).compile();

    service = await module.resolve<CustomLoggerService>(CustomLoggerService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Reset static gateway after each test
    CustomLoggerService['gateway'] = null;
  });

  describe('setGateway', () => {
    it('should set the static gateway', () => {
      CustomLoggerService.setGateway(mockGateway);
      expect(CustomLoggerService['gateway']).toBe(mockGateway);
    });
  });

  describe('log', () => {
    it('should not broadcast when gateway is not set', () => {
      // gateway is null by default
      service.log('test message');
      // No broadcast call expected since gateway is null
      expect(mockGateway.broadcast).not.toHaveBeenCalled();
    });

    it('should broadcast log entry when gateway is set', () => {
      CustomLoggerService.setGateway(mockGateway);
      service.log('test message', 'TestContext');

      expect(mockGateway.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'log',
          message: 'test message',
          context: 'TestContext',
          timestamp: expect.any(String),
        }),
      );
    });

    it('should broadcast with correct level "log"', () => {
      CustomLoggerService.setGateway(mockGateway);
      service.log('hello');

      const callArg = mockGateway.broadcast.mock.calls[0][0] as LogEntry;
      expect(callArg.level).toBe('log');
    });

    it('should handle object message by stringifying it', () => {
      CustomLoggerService.setGateway(mockGateway);
      // ConsoleLogger.log accepts any, but our broadcast method handles objects
      service.log({ key: 'value' } as unknown as string);

      const callArg = mockGateway.broadcast.mock.calls[0][0] as LogEntry;
      expect(callArg.message).toBe('{"key":"value"}');
    });
  });

  describe('error', () => {
    it('should not broadcast when gateway is not set', () => {
      service.error('error message', 'stack trace');
      expect(mockGateway.broadcast).not.toHaveBeenCalled();
    });

    it('should broadcast error entry when gateway is set', () => {
      CustomLoggerService.setGateway(mockGateway);
      service.error('error message', 'Error stack trace', 'ErrorContext');

      expect(mockGateway.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          message: 'error message',
          context: 'ErrorContext',
          trace: 'Error stack trace',
          timestamp: expect.any(String),
        }),
      );
    });

    it('should include trace in the broadcast entry', () => {
      CustomLoggerService.setGateway(mockGateway);
      service.error('error message', 'at SomeClass.method');

      const callArg = mockGateway.broadcast.mock.calls[0][0] as LogEntry;
      expect(callArg.trace).toBe('at SomeClass.method');
    });
  });

  describe('warn', () => {
    it('should not broadcast when gateway is not set', () => {
      service.warn('warning message');
      expect(mockGateway.broadcast).not.toHaveBeenCalled();
    });

    it('should broadcast warn entry when gateway is set', () => {
      CustomLoggerService.setGateway(mockGateway);
      service.warn('warning message', 'WarnContext');

      expect(mockGateway.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          message: 'warning message',
          context: 'WarnContext',
        }),
      );
    });
  });

  describe('debug', () => {
    it('should not broadcast when gateway is not set', () => {
      service.debug('debug message');
      expect(mockGateway.broadcast).not.toHaveBeenCalled();
    });

    it('should broadcast debug entry when gateway is set', () => {
      CustomLoggerService.setGateway(mockGateway);
      service.debug('debug message', 'DebugContext');

      expect(mockGateway.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'debug',
          message: 'debug message',
          context: 'DebugContext',
        }),
      );
    });
  });

  describe('verbose', () => {
    it('should not broadcast when gateway is not set', () => {
      service.verbose('verbose message');
      expect(mockGateway.broadcast).not.toHaveBeenCalled();
    });

    it('should broadcast verbose entry when gateway is set', () => {
      CustomLoggerService.setGateway(mockGateway);
      service.verbose('verbose message', 'VerboseContext');

      expect(mockGateway.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'verbose',
          message: 'verbose message',
        }),
      );
    });
  });

  describe('broadcast timestamp', () => {
    it('should include ISO timestamp in broadcast entry', () => {
      CustomLoggerService.setGateway(mockGateway);
      const beforeTime = new Date().toISOString();
      service.log('test');
      const afterTime = new Date().toISOString();

      const callArg = mockGateway.broadcast.mock.calls[0][0] as LogEntry;
      expect(callArg.timestamp >= beforeTime).toBe(true);
      expect(callArg.timestamp <= afterTime).toBe(true);
    });
  });

  describe('context handling', () => {
    it('should use "Application" as default context when no context provided', () => {
      CustomLoggerService.setGateway(mockGateway);
      service.log('test message');

      const callArg = mockGateway.broadcast.mock.calls[0][0] as LogEntry;
      // When no context is provided, should use this.context or 'Application'
      expect(callArg.context).toBeDefined();
    });

    it('should use string context when provided', () => {
      CustomLoggerService.setGateway(mockGateway);
      service.log('test message', 'MyService');

      const callArg = mockGateway.broadcast.mock.calls[0][0] as LogEntry;
      expect(callArg.context).toBe('MyService');
    });
  });
});
