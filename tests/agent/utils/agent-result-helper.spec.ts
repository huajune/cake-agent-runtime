import {
  AgentResultHelper,
  createSuccessResult,
  createFallbackResult,
  createErrorResult,
} from '@agent/utils/agent-result-helper';
import { AgentResultStatus } from '@agent/utils/agent-enums';
import { ChatResponse, AgentError, AgentFallbackInfo } from '@agent/utils/agent-types';

describe('agent-result-helper', () => {
  const buildChatResponse = (text = 'hello'): ChatResponse => ({
    messages: [
      {
        role: 'assistant' as any,
        parts: [{ type: 'text', text }],
      },
    ],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    tools: { used: [], skipped: [] },
  });

  const buildFallbackInfo = (): AgentFallbackInfo => ({
    reason: 'API timeout',
    message: 'Service temporarily unavailable',
    suggestion: 'Please try again later',
    retryAfter: 30,
  });

  const buildAgentError = (): AgentError => ({
    code: 'API_ERROR',
    message: 'Connection failed',
    details: { status: 503 },
    retryable: true,
    retryAfter: 60,
  });

  describe('createSuccessResult', () => {
    it('should create a success result with data', () => {
      const data = buildChatResponse();
      const result = createSuccessResult(data);

      expect(result.status).toBe(AgentResultStatus.SUCCESS);
      expect(result.data).toBe(data);
      expect(result.fromCache).toBe(false);
      expect(result.correlationId).toBeUndefined();
    });

    it('should include correlationId when provided', () => {
      const data = buildChatResponse();
      const result = createSuccessResult(data, 'corr-001');

      expect(result.correlationId).toBe('corr-001');
    });

    it('should set fromCache to true when specified', () => {
      const data = buildChatResponse();
      const result = createSuccessResult(data, undefined, true);

      expect(result.fromCache).toBe(true);
    });

    it('should not include fallback or error fields', () => {
      const data = buildChatResponse();
      const result = createSuccessResult(data);

      expect(result.fallback).toBeUndefined();
      expect(result.error).toBeUndefined();
      expect(result.fallbackInfo).toBeUndefined();
    });
  });

  describe('createFallbackResult', () => {
    it('should create a fallback result', () => {
      const fallback = buildChatResponse('Sorry, service unavailable');
      const fallbackInfo = buildFallbackInfo();
      const result = createFallbackResult(fallback, fallbackInfo);

      expect(result.status).toBe(AgentResultStatus.FALLBACK);
      expect(result.fallback).toBe(fallback);
      expect(result.fallbackInfo).toBe(fallbackInfo);
      expect(result.data).toBeUndefined();
    });

    it('should include correlationId when provided', () => {
      const fallback = buildChatResponse();
      const fallbackInfo = buildFallbackInfo();
      const result = createFallbackResult(fallback, fallbackInfo, 'corr-002');

      expect(result.correlationId).toBe('corr-002');
    });
  });

  describe('createErrorResult', () => {
    it('should create an error result', () => {
      const error = buildAgentError();
      const result = createErrorResult(error);

      expect(result.status).toBe(AgentResultStatus.ERROR);
      expect(result.error).toBe(error);
      expect(result.data).toBeUndefined();
      expect(result.fallback).toBeUndefined();
    });

    it('should include correlationId when provided', () => {
      const error = buildAgentError();
      const result = createErrorResult(error, 'corr-003');

      expect(result.correlationId).toBe('corr-003');
    });
  });

  describe('AgentResultHelper.getResponse', () => {
    it('should return data when data is present', () => {
      const data = buildChatResponse();
      const result = createSuccessResult(data);

      expect(AgentResultHelper.getResponse(result)).toBe(data);
    });

    it('should return fallback when data is not present', () => {
      const fallback = buildChatResponse('fallback message');
      const result = createFallbackResult(fallback, buildFallbackInfo());

      expect(AgentResultHelper.getResponse(result)).toBe(fallback);
    });

    it('should return undefined when neither data nor fallback is present', () => {
      const result = createErrorResult(buildAgentError());

      expect(AgentResultHelper.getResponse(result)).toBeUndefined();
    });

    it('should prefer data over fallback when both are present', () => {
      const data = buildChatResponse('data response');
      const fallback = buildChatResponse('fallback response');
      const result = {
        data,
        fallback,
        status: AgentResultStatus.SUCCESS,
      };

      expect(AgentResultHelper.getResponse(result)).toBe(data);
    });
  });

  describe('AgentResultHelper.getResponseText', () => {
    it('should return text from successful response', () => {
      const result = createSuccessResult(buildChatResponse('Hello world'));
      expect(AgentResultHelper.getResponseText(result)).toBe('Hello world');
    });

    it('should return text from fallback response', () => {
      const result = createFallbackResult(buildChatResponse('Fallback text'), buildFallbackInfo());
      expect(AgentResultHelper.getResponseText(result)).toBe('Fallback text');
    });

    it('should return empty string when no response', () => {
      const result = createErrorResult(buildAgentError());
      expect(AgentResultHelper.getResponseText(result)).toBe('');
    });

    it('should return empty string when messages array is empty', () => {
      const emptyResponse: ChatResponse = {
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        tools: { used: [], skipped: [] },
      };
      const result = createSuccessResult(emptyResponse);
      expect(AgentResultHelper.getResponseText(result)).toBe('');
    });

    it('should return empty string when parts array is empty', () => {
      const emptyPartsResponse: ChatResponse = {
        messages: [{ role: 'assistant' as any, parts: [] }],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        tools: { used: [], skipped: [] },
      };
      const result = createSuccessResult(emptyPartsResponse);
      expect(AgentResultHelper.getResponseText(result)).toBe('');
    });

    it('should return empty string when text is empty in first part', () => {
      const emptyTextResponse: ChatResponse = {
        messages: [{ role: 'assistant' as any, parts: [{ type: 'text', text: '' }] }],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        tools: { used: [], skipped: [] },
      };
      const result = createSuccessResult(emptyTextResponse);
      expect(AgentResultHelper.getResponseText(result)).toBe('');
    });
  });

  describe('AgentResultHelper.extractResponse', () => {
    it('should return data when present', () => {
      const data = buildChatResponse();
      const result = createSuccessResult(data);
      expect(AgentResultHelper.extractResponse(result)).toBe(data);
    });

    it('should return fallback when data is absent', () => {
      const fallback = buildChatResponse();
      const result = createFallbackResult(fallback, buildFallbackInfo());
      expect(AgentResultHelper.extractResponse(result)).toBe(fallback);
    });

    it('should throw an error when neither data nor fallback exists', () => {
      const result = createErrorResult(buildAgentError());
      expect(() => AgentResultHelper.extractResponse(result)).toThrow(
        'AgentResult 中既没有 data 也没有 fallback',
      );
    });
  });

  describe('AgentResultHelper.isFallback', () => {
    it('should return true for fallback status', () => {
      const result = createFallbackResult(buildChatResponse(), buildFallbackInfo());
      expect(AgentResultHelper.isFallback(result)).toBe(true);
    });

    it('should return false for success status', () => {
      const result = createSuccessResult(buildChatResponse());
      expect(AgentResultHelper.isFallback(result)).toBe(false);
    });

    it('should return false for error status', () => {
      const result = createErrorResult(buildAgentError());
      expect(AgentResultHelper.isFallback(result)).toBe(false);
    });
  });

  describe('AgentResultHelper.isError', () => {
    it('should return true for error status', () => {
      const result = createErrorResult(buildAgentError());
      expect(AgentResultHelper.isError(result)).toBe(true);
    });

    it('should return false for success status', () => {
      const result = createSuccessResult(buildChatResponse());
      expect(AgentResultHelper.isError(result)).toBe(false);
    });

    it('should return false for fallback status', () => {
      const result = createFallbackResult(buildChatResponse(), buildFallbackInfo());
      expect(AgentResultHelper.isError(result)).toBe(false);
    });
  });

  describe('AgentResultHelper.isSuccess', () => {
    it('should return true for success status', () => {
      const result = createSuccessResult(buildChatResponse());
      expect(AgentResultHelper.isSuccess(result)).toBe(true);
    });

    it('should return false for fallback status', () => {
      const result = createFallbackResult(buildChatResponse(), buildFallbackInfo());
      expect(AgentResultHelper.isSuccess(result)).toBe(false);
    });

    it('should return false for error status', () => {
      const result = createErrorResult(buildAgentError());
      expect(AgentResultHelper.isSuccess(result)).toBe(false);
    });
  });

  describe('AgentResultHelper.isSuccessOrFallback', () => {
    it('should return true for success status', () => {
      const result = createSuccessResult(buildChatResponse());
      expect(AgentResultHelper.isSuccessOrFallback(result)).toBe(true);
    });

    it('should return true for fallback status', () => {
      const result = createFallbackResult(buildChatResponse(), buildFallbackInfo());
      expect(AgentResultHelper.isSuccessOrFallback(result)).toBe(true);
    });

    it('should return false for error status', () => {
      const result = createErrorResult(buildAgentError());
      expect(AgentResultHelper.isSuccessOrFallback(result)).toBe(false);
    });
  });

  describe('AgentResultHelper.isFromCache', () => {
    it('should return true when fromCache is true', () => {
      const result = createSuccessResult(buildChatResponse(), undefined, true);
      expect(AgentResultHelper.isFromCache(result)).toBe(true);
    });

    it('should return false when fromCache is false', () => {
      const result = createSuccessResult(buildChatResponse(), undefined, false);
      expect(AgentResultHelper.isFromCache(result)).toBe(false);
    });

    it('should return false when fromCache is undefined', () => {
      const result = createFallbackResult(buildChatResponse(), buildFallbackInfo());
      expect(AgentResultHelper.isFromCache(result)).toBe(false);
    });
  });
});
