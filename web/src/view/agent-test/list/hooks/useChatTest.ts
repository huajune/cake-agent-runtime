import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { TestChatResponse, SimpleMessage, TokenUsage } from '@/api/services/agent-test.service';
import { CHAT_API_ENDPOINT, DEFAULT_SCENARIO } from '../constants';
import { generateUUID } from '@/utils/uuid';

export interface UseChatTestOptions {
  onTestComplete?: (result: TestChatResponse) => void;
}

export interface UseChatTestReturn {
  // 状态
  historyText: string;
  historyStatus: 'valid' | 'invalid' | 'empty';
  currentInput: string;
  localError: string | null;
  result: TestChatResponse | null;
  metrics: { durationMs: number; tokenUsage: TokenUsage } | null;
  elapsedMs: number;
  isLoading: boolean;
  isStreaming: boolean;
  latestAssistantMessage: UIMessage | undefined;

  // 操作
  setHistoryText: (text: string) => void;
  setCurrentInput: (text: string) => void;
  setLocalError: (error: string | null) => void;
  handleTest: () => Promise<void>;
  handleCancel: () => void;
  handleClear: () => void;

  // Refs
  messageInputRef: React.RefObject<HTMLTextAreaElement>;
  replyContentRef: React.RefObject<HTMLDivElement>;
}

// ==================== localStorage 草稿缓存 ====================

const DRAFT_CACHE_KEY = 'agent-test-draft';

function loadDraftCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DRAFT_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveDraftCache(patch: Record<string, string>): void {
  try {
    const prev = loadDraftCache();
    localStorage.setItem(DRAFT_CACHE_KEY, JSON.stringify({ ...prev, ...patch }));
  } catch { /* noop */ }
}

function clearDraftCache(): void {
  try { localStorage.removeItem(DRAFT_CACHE_KEY); } catch { /* noop */ }
}

/**
 * 聊天测试核心逻辑 Hook
 */
export function useChatTest({ onTestComplete }: UseChatTestOptions = {}): UseChatTestReturn {
  const cached = useRef(loadDraftCache()).current;

  // 历史记录
  const [historyText, setHistoryTextState] = useState(cached.historyText ?? '');
  const [historyStatus, setHistoryStatus] = useState<'valid' | 'invalid' | 'empty'>('empty');

  // 当前输入
  const [currentInput, setCurrentInputState] = useState(cached.currentInput ?? '');
  const setCurrentInput = useCallback((text: string) => {
    setCurrentInputState(text);
    saveDraftCache({ currentInput: text });
  }, []);

  // 状态
  const [localError, setLocalError] = useState<string | null>(null);
  const [result, setResult] = useState<TestChatResponse | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);

  // 指标
  const [metrics, setMetrics] = useState<{ durationMs: number; tokenUsage: TokenUsage } | null>(
    null,
  );
  const startTimeRef = useRef<number>(0);

  // 会话 ID + 用户 ID：同一对话保持一致，清空聊天时重新生成（确保 Agent API 服务端记忆完全隔离）
  const [sessionId, setSessionId] = useState(() => {
    const id = cached.sessionId || generateUUID();
    if (!cached.sessionId) saveDraftCache({ sessionId: id });
    return id;
  });
  const [userId, setUserId] = useState(() => {
    const id = cached.userId || `dashboard-test-${generateUUID().slice(0, 8)}`;
    if (!cached.userId) saveDraftCache({ userId: id });
    return id;
  });

  // Refs
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const replyContentRef = useRef<HTMLDivElement>(null);
  const currentInputRef = useRef<string>('');
  const tokenUsageRef = useRef<TokenUsage | null>(null);

  // Transport（sessionId 变化时重建，确保新对话用新 sessionId）
  const transport = useMemo(() => {
    const headers: Record<string, string> = {};
    const apiGuardToken = import.meta.env.VITE_API_GUARD_TOKEN as string | undefined;
    if (apiGuardToken) headers['Authorization'] = `Bearer ${apiGuardToken}`;

    return new DefaultChatTransport({
      api: CHAT_API_ENDPOINT,
      headers,
      body: {
        scenario: DEFAULT_SCENARIO,
        saveExecution: false,
        sessionId,
        userId,
        thinking: { type: 'enabled', budgetTokens: 10000 },
      },
    });
  }, [sessionId, userId]);

  // useChat hook
  const { messages, sendMessage, status, stop, setMessages, error: chatError } = useChat({
    id: sessionId,
    transport,
    onData: (dataPart: unknown) => {
      const part = dataPart as { type?: string; data?: TokenUsage };
      if (part?.type === 'data-tokenUsage' && part.data) {
        tokenUsageRef.current = part.data;
      }
    },
    onError: (err: Error) => {
      let displayError = err.message || '流式测试执行失败';
      if (displayError.includes('500') || displayError.includes('Internal Server Error')) {
        displayError = '服务暂时不可用 (500)。请确认后端服务已启动';
      } else if (displayError.includes('Network Error') || displayError.includes('Failed to fetch')) {
        displayError = '网络请求失败。请检查网络连接或服务地址。';
      }
      setLocalError(displayError);
      setIsRequesting(false);
    },
    onFinish: ({ message }: { message: UIMessage }) => {
      const durationMs = Date.now() - startTimeRef.current;

      const toolCalls = message.parts
        .filter((p) => p.type.startsWith('tool-'))
        .map((p) => {
          const toolPart = p as unknown as { toolName: string; args: unknown; result?: unknown };
          return { toolName: toolPart.toolName || 'unknown', input: toolPart.args, output: toolPart.result };
        });

      const textContent = message.parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');

      const finalTokenUsage: TokenUsage = tokenUsageRef.current || {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };

      setMetrics({ durationMs, tokenUsage: finalTokenUsage });
      tokenUsageRef.current = null;

      const finalResult: TestChatResponse = {
        actualOutput: textContent,
        status: 'success',
        request: { url: CHAT_API_ENDPOINT, method: 'POST', body: { message: currentInputRef.current, scenario: DEFAULT_SCENARIO } },
        response: { statusCode: 200, body: { content: textContent }, toolCalls },
        metrics: { durationMs, tokenUsage: finalTokenUsage },
      };

      setResult(finalResult);
      onTestComplete?.(finalResult);

      // 回写历史记录
      const now = new Date();
      const timeStr = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const userLine = `[${timeStr} 候选人] ${currentInputRef.current}`;
      const aiLine = `[${timeStr} 招募经理] ${textContent}`;

      setHistoryTextState((prev) => {
        const newHistory = prev.trim() ? `${prev}\n\n${userLine}\n\n${aiLine}` : `${userLine}\n\n${aiLine}`;
        setTimeout(() => validateHistory(newHistory), 0);
        saveDraftCache({ historyText: newHistory, currentInput: '' });
        return newHistory;
      });

      setCurrentInput('');
      setIsRequesting(false);
    },
  });

  const isStreaming = status === 'streaming';
  const isLoading = isRequesting || status === 'submitted' || isStreaming;

  // 自动滚动
  useEffect(() => {
    if (isStreaming && replyContentRef.current) {
      replyContentRef.current.scrollTop = replyContentRef.current.scrollHeight;
    }
  }, [messages, isStreaming]);

  // 同步 chatError
  useEffect(() => {
    if (chatError) setLocalError(chatError.message);
  }, [chatError]);

  // 流式实时耗时
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!isStreaming) {
      setElapsedMs(0);
      return;
    }
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current);
    }, 100);
    return () => clearInterval(interval);
  }, [isStreaming]);

  // 流式开始时清空 result
  useEffect(() => {
    if (isStreaming) setResult(null);
  }, [isStreaming]);

  // 解析历史记录
  // 格式: [MM/DD HH:mm 用户名] 消息内容
  // 用户名可以是任意字符（候选人、招募经理、或真实姓名如 "自由人"、"LiHanTing"）
  const parseHistory = useCallback((text: string): SimpleMessage[] => {
    if (!text.trim()) return [];
    const lines = text.split('\n').filter((l) => l.trim());
    const parsedMessages: SimpleMessage[] = [];

    // 记录第一个用户名作为"候选人"的标识（奇数位置通常是候选人）
    let firstUserName: string | null = null;

    for (const line of lines) {
      // 匹配格式: [日期时间 用户名] 消息内容
      // 例如: [12/19 11:28 自由人] 我是自由人
      const bracketMatch = line.match(/^\[[\d/]+ [\d:]+ ([^\]]+)\]\s*(.*)$/);
      if (bracketMatch) {
        const userName = bracketMatch[1].trim();
        const content = bracketMatch[2];

        // 如果用户名是标准名称，直接判断
        if (userName === '候选人') {
          parsedMessages.push({ role: 'user', content });
          if (!firstUserName) firstUserName = userName;
        } else if (userName === '招募经理' || userName === '经理') {
          parsedMessages.push({ role: 'assistant', content });
        } else {
          // 非标准名称：第一个出现的名字视为候选人（user），其他视为招募经理（assistant）
          if (!firstUserName) {
            firstUserName = userName;
          }
          const role = userName === firstUserName ? 'user' : 'assistant';
          parsedMessages.push({ role, content });
        }
      } else if (parsedMessages.length > 0) {
        // 续行内容
        parsedMessages[parsedMessages.length - 1].content += '\n' + line;
      }
    }
    return parsedMessages;
  }, []);

  // 校验历史记录
  const validateHistory = useCallback(
    (text: string) => {
      if (!text.trim()) {
        setHistoryStatus('empty');
        return;
      }
      const parsed = parseHistory(text);
      setHistoryStatus(parsed.length > 0 ? 'valid' : 'invalid');
    },
    [parseHistory],
  );

  // 初始化时校验已缓存的历史记录
  useEffect(() => {
    if (cached.historyText) validateHistory(cached.historyText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 设置历史记录（带校验 + 缓存）
  const setHistoryText = useCallback(
    (text: string) => {
      setHistoryTextState(text);
      validateHistory(text);
      saveDraftCache({ historyText: text });
    },
    [validateHistory],
  );

  // 执行测试
  const handleTest = useCallback(async () => {
    if (!currentInput.trim()) return;

    currentInputRef.current = currentInput.trim();
    setIsRequesting(true);
    setLocalError(null);
    setMetrics(null);
    setResult(null); // 在发起新请求时，立即重置测试结果
    startTimeRef.current = Date.now();

    const history = parseHistory(historyText);
    const historyMessages: UIMessage[] = history.map((msg, idx) => ({
      id: `history-${idx}`,
      role: msg.role,
      parts: [{ type: 'text' as const, text: msg.content }],
    }));

    setMessages(historyMessages);
    requestAnimationFrame(() => {
      sendMessage({ text: currentInput.trim() });
    });
  }, [currentInput, historyText, parseHistory, setMessages, sendMessage]);

  // 取消
  const handleCancel = useCallback(() => stop(), [stop]);

  // 清空（重新生成 sessionId，开启新会话，清除缓存）
  const handleClear = useCallback(() => {
    setHistoryTextState('');
    setHistoryStatus('empty');
    setCurrentInputState('');
    setMessages([]);
    setResult(null);
    setLocalError(null);
    setMetrics(null);
    setIsRequesting(false);
    setSessionId(generateUUID());
    setUserId(`dashboard-test-${generateUUID().slice(0, 8)}`);
    clearDraftCache();
    messageInputRef.current?.focus();
  }, [setMessages]);

  const latestAssistantMessage = messages
    .filter((m: UIMessage) => m.role === 'assistant' && !m.id.startsWith('history-'))
    .pop();

  return {
    historyText,
    historyStatus,
    currentInput,
    localError,
    result,
    metrics,
    elapsedMs,
    isLoading,
    isStreaming,
    latestAssistantMessage,
    setHistoryText,
    setCurrentInput,
    setLocalError,
    handleTest,
    handleCancel,
    handleClear,
    messageInputRef,
    replyContentRef,
  };
}
