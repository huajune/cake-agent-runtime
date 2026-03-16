import { Test, TestingModule } from '@nestjs/testing';
import { ConversationParserService } from '@biz/test-suite/services/conversation/conversation-parser.service';
import type { AgentResult } from '@agent';

describe('ConversationParserService', () => {
  let service: ConversationParserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ConversationParserService],
    }).compile();

    service = module.get<ConversationParserService>(ConversationParserService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========== parseConversation ==========

  describe('parseConversation', () => {
    it('should parse a simple conversation with one user and one assistant turn', () => {
      const rawText = [
        '[12/04 17:20 候选人] 这还招人吗',
        '[12/04 17:21 招募经理] 是的，目前还在招聘中',
      ].join('\n');

      const result = service.parseConversation(rawText);

      expect(result.success).toBe(true);
      expect(result.messages).toHaveLength(2);
      expect(result.totalTurns).toBe(1);
      expect(result.messages[0]).toEqual({
        role: 'user',
        content: '这还招人吗',
        timestamp: '12/04 17:20',
      });
      expect(result.messages[1]).toEqual({
        role: 'assistant',
        content: '是的，目前还在招聘中',
        timestamp: '12/04 17:21',
      });
    });

    it('should parse a multi-turn conversation', () => {
      const rawText = [
        '[12/04 17:20 候选人] 这还招人吗',
        '[12/04 17:21 招募经理] 是的，还在招',
        '[12/04 17:22 候选人] 薪资是多少',
        '[12/04 17:23 招募经理] 月薪5000-8000',
      ].join('\n');

      const result = service.parseConversation(rawText);

      expect(result.success).toBe(true);
      expect(result.messages).toHaveLength(4);
      expect(result.totalTurns).toBe(2);
    });

    it('should return error result for empty string', () => {
      const result = service.parseConversation('');

      expect(result.success).toBe(false);
      expect(result.messages).toHaveLength(0);
      expect(result.totalTurns).toBe(0);
      expect(result.error).toBe('对话内容为空');
    });

    it('should return error result for whitespace-only string', () => {
      const result = service.parseConversation('   \n  ');

      expect(result.success).toBe(false);
      expect(result.error).toBe('对话内容为空');
    });

    it('should merge consecutive same-role messages', () => {
      const rawText = [
        '[12/04 17:20 候选人] 你好',
        '[12/04 17:20 候选人] 请问还招人吗',
        '[12/04 17:21 招募经理] 是的，还在招',
      ].join('\n');

      const result = service.parseConversation(rawText);

      expect(result.success).toBe(true);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content).toBe('你好\n请问还招人吗');
      expect(result.messages[0].role).toBe('user');
    });

    it('should handle multi-line messages (continuation lines)', () => {
      const rawText = [
        '[12/04 17:20 候选人] 你好',
        '我想了解招聘信息',
        '[12/04 17:21 招募经理] 好的',
      ].join('\n');

      const result = service.parseConversation(rawText);

      expect(result.success).toBe(true);
      expect(result.messages[0].content).toBe('你好\n我想了解招聘信息');
    });

    it('should map 候选人 to user role', () => {
      const rawText = '[12/04 17:20 候选人] 你好';
      const result = service.parseConversation(rawText);

      expect(result.messages[0].role).toBe('user');
    });

    it('should map 招募经理 to assistant role', () => {
      const rawText = '[12/04 17:21 招募经理] 你好，有什么可以帮助您的？';
      const result = service.parseConversation(rawText);

      expect(result.messages[0].role).toBe('assistant');
    });

    it('should count totalTurns as number of user messages', () => {
      const rawText = [
        '[12/04 17:20 候选人] 消息1',
        '[12/04 17:21 招募经理] 回复1',
        '[12/04 17:22 候选人] 消息2',
        '[12/04 17:23 招募经理] 回复2',
        '[12/04 17:24 候选人] 消息3',
      ].join('\n');

      const result = service.parseConversation(rawText);

      expect(result.totalTurns).toBe(3);
    });

    it('should handle text that does not match conversation pattern', () => {
      const rawText = 'This is just plain text without any timestamps';
      const result = service.parseConversation(rawText);

      // The text won't match the pattern, so messages will be empty
      expect(result.success).toBe(true);
      expect(result.messages).toHaveLength(0);
      expect(result.totalTurns).toBe(0);
    });
  });

  // ========== splitIntoTurns ==========

  describe('splitIntoTurns', () => {
    it('should split messages into turns correctly', () => {
      const messages = [
        { role: 'user' as const, content: '你好', timestamp: '17:20' },
        { role: 'assistant' as const, content: '有什么可以帮您？', timestamp: '17:21' },
        { role: 'user' as const, content: '薪资多少', timestamp: '17:22' },
        { role: 'assistant' as const, content: '5000-8000', timestamp: '17:23' },
      ];

      const turns = service.splitIntoTurns(messages);

      expect(turns).toHaveLength(2);
      expect(turns[0].turnNumber).toBe(1);
      expect(turns[0].userMessage).toBe('你好');
      expect(turns[0].expectedOutput).toBe('有什么可以帮您？');
      expect(turns[0].history).toHaveLength(0);

      expect(turns[1].turnNumber).toBe(2);
      expect(turns[1].userMessage).toBe('薪资多少');
      expect(turns[1].expectedOutput).toBe('5000-8000');
      expect(turns[1].history).toHaveLength(2);
    });

    it('should return empty array for empty messages', () => {
      const turns = service.splitIntoTurns([]);
      expect(turns).toHaveLength(0);
    });

    it('should include previous messages in history for each turn', () => {
      const messages = [
        { role: 'user' as const, content: 'msg1', timestamp: '17:20' },
        { role: 'assistant' as const, content: 'reply1', timestamp: '17:21' },
        { role: 'user' as const, content: 'msg2', timestamp: '17:22' },
        { role: 'assistant' as const, content: 'reply2', timestamp: '17:23' },
        { role: 'user' as const, content: 'msg3', timestamp: '17:24' },
      ];

      const turns = service.splitIntoTurns(messages);

      expect(turns[0].history).toHaveLength(0);
      expect(turns[1].history).toHaveLength(2);
      expect(turns[2].history).toHaveLength(4);
    });

    it('should set empty expectedOutput when no assistant reply follows', () => {
      const messages = [{ role: 'user' as const, content: '你好', timestamp: '17:20' }];

      const turns = service.splitIntoTurns(messages);

      expect(turns[0].expectedOutput).toBe('');
    });

    it('should set empty expectedOutput when next message is another user message', () => {
      const messages = [
        { role: 'user' as const, content: '消息1', timestamp: '17:20' },
        { role: 'user' as const, content: '消息2', timestamp: '17:21' },
      ];

      const turns = service.splitIntoTurns(messages);

      expect(turns[0].expectedOutput).toBe('');
    });

    it('should not create turns for assistant-only messages', () => {
      const messages = [{ role: 'assistant' as const, content: '欢迎咨询', timestamp: '17:20' }];

      const turns = service.splitIntoTurns(messages);
      expect(turns).toHaveLength(0);
    });
  });

  // ========== extractResponseText ==========

  describe('extractResponseText', () => {
    it('should extract text from agent result messages', () => {
      const result = {
        status: 'success' as const,
        data: {
          messages: [
            {
              parts: [{ text: 'Hello ' }, { text: 'World' }],
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      } as unknown as AgentResult;

      const text = service.extractResponseText(result);
      expect(text).toBe('Hello World');
    });

    it('should join multiple messages with double newline', () => {
      const result = {
        status: 'success' as const,
        data: {
          messages: [{ parts: [{ text: 'First' }] }, { parts: [{ text: 'Second' }] }],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      } as unknown as AgentResult;

      const text = service.extractResponseText(result);
      expect(text).toBe('First\n\nSecond');
    });

    it('should return empty string when no messages', () => {
      const result = {
        status: 'error' as const,
        error: { code: 'ERR', message: 'failed' },
      } as unknown as AgentResult;

      const text = service.extractResponseText(result);
      expect(text).toBe('');
    });

    it('should use fallback if data is absent', () => {
      const result = {
        status: 'fallback' as const,
        fallback: {
          messages: [{ parts: [{ text: 'Fallback response' }] }],
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        },
      } as unknown as AgentResult;

      const text = service.extractResponseText(result);
      expect(text).toBe('Fallback response');
    });

    it('should handle messages without parts gracefully', () => {
      const result = {
        status: 'success' as const,
        data: {
          messages: [{ parts: undefined }],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      } as unknown as AgentResult;

      const text = service.extractResponseText(result);
      expect(text).toBe('');
    });
  });

  // ========== extractToolCalls ==========

  describe('extractToolCalls', () => {
    it('should extract and pair tool_call with tool_result', () => {
      const result = {
        status: 'success' as const,
        data: {
          messages: [
            {
              parts: [
                {
                  type: 'tool_call',
                  toolCallId: 'call-1',
                  toolName: 'search',
                  input: { query: 'jobs' },
                },
              ],
            },
            {
              parts: [
                {
                  type: 'tool_result',
                  toolCallId: 'call-1',
                  result: { results: ['job1'] },
                },
              ],
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      } as unknown as AgentResult;

      const toolCalls = service.extractToolCalls(result);

      expect(toolCalls).toHaveLength(1);
      expect((toolCalls[0] as { toolName: string }).toolName).toBe('search');
      expect((toolCalls[0] as { input: unknown }).input).toEqual({ query: 'jobs' });
      expect((toolCalls[0] as { output: unknown }).output).toEqual({ results: ['job1'] });
    });

    it('should handle tool_use type (alternative to tool_call)', () => {
      const result = {
        status: 'success' as const,
        data: {
          messages: [
            {
              parts: [
                {
                  type: 'tool_use',
                  id: 'call-2',
                  name: 'calculator',
                  args: { expression: '1+1' },
                },
              ],
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      } as unknown as AgentResult;

      const toolCalls = service.extractToolCalls(result);

      expect(toolCalls).toHaveLength(1);
      expect((toolCalls[0] as { toolName: string }).toolName).toBe('calculator');
    });

    it('should return empty array when no messages', () => {
      const result = {
        status: 'error' as const,
        error: { code: 'ERR', message: 'failed' },
      } as unknown as AgentResult;

      const toolCalls = service.extractToolCalls(result);
      expect(toolCalls).toHaveLength(0);
    });

    it('should return empty array when messages have no tool parts', () => {
      const result = {
        status: 'success' as const,
        data: {
          messages: [{ parts: [{ text: 'Regular message', type: 'text' }] }],
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        },
      } as unknown as AgentResult;

      const toolCalls = service.extractToolCalls(result);
      expect(toolCalls).toHaveLength(0);
    });

    it('should handle multiple tool calls', () => {
      const result = {
        status: 'success' as const,
        data: {
          messages: [
            {
              parts: [
                {
                  type: 'tool_call',
                  toolCallId: 'call-1',
                  toolName: 'search',
                  input: { query: 'jobs' },
                },
                {
                  type: 'tool_call',
                  toolCallId: 'call-2',
                  toolName: 'calculate',
                  input: { expr: '2+2' },
                },
              ],
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      } as unknown as AgentResult;

      const toolCalls = service.extractToolCalls(result);
      expect(toolCalls).toHaveLength(2);
    });

    it('should leave output undefined for unpaired tool calls', () => {
      const result = {
        status: 'success' as const,
        data: {
          messages: [
            {
              parts: [
                {
                  type: 'tool_call',
                  toolCallId: 'call-no-result',
                  toolName: 'search',
                  input: { query: 'test' },
                },
              ],
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      } as unknown as AgentResult;

      const toolCalls = service.extractToolCalls(result);
      expect(toolCalls).toHaveLength(1);
      expect((toolCalls[0] as { output?: unknown }).output).toBeUndefined();
    });
  });
});
