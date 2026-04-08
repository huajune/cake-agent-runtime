import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type FileUIPart, type UIMessage } from 'ai';
import { TestChatResponse, SimpleMessage, TokenUsage } from '@/api/services/agent-test.service';
import { CHAT_API_ENDPOINT, DEFAULT_SCENARIO } from '../constants';
import { generateUUID } from '@/utils/uuid';
import {
  markAgentTestStreamEnd,
  markAgentTestStreamStart,
} from '@/utils/perf';
import {
  clearHistoryImageCache,
  loadAgentTestDraftCache,
  loadHistoryImageCache,
  saveAgentTestDraftCache,
  saveHistoryImageCache,
  type HistoryImageCacheEntry,
} from '../utils/cache';

export interface UseChatTestOptions {
  onTestComplete?: (result: TestChatResponse) => void;
}

export interface ImagePreview {
  id: string;
  file: File;
  dataUrl: string;
}

export interface TestResultSummary {
  status: TestChatResponse['status'];
  metrics: TestChatResponse['metrics'];
}

export type AgentTestThinkingMode = 'fast' | 'deep';

export interface UseChatTestReturn {
  // 状态
  historyText: string;
  historyStatus: 'valid' | 'invalid' | 'empty';
  currentInput: string;
  localError: string | null;
  result: TestResultSummary | null;
  metrics: { durationMs: number; tokenUsage: TokenUsage } | null;
  elapsedMs: number;
  isLoading: boolean;
  isStreaming: boolean;
  latestAssistantMessage: UIMessage | undefined;
  entryStage: string | null;
  currentStage: string | null;

  // 图片
  imagePreviews: ImagePreview[];
  addImages: (files: FileList) => void;
  removeImage: (id: string) => void;
  thinkingMode: AgentTestThinkingMode;
  thinkingBudgetTokens: number;

  // 操作
  setHistoryText: (text: string) => void;
  setCurrentInput: (text: string) => void;
  setLocalError: (error: string | null) => void;
  setThinkingMode: (mode: AgentTestThinkingMode) => void;
  setThinkingBudgetTokens: (tokens: number) => void;
  handleTest: () => Promise<void>;
  handleCancel: () => void;
  handleClear: () => void;

  // Refs
  messageInputRef: React.RefObject<HTMLTextAreaElement>;
  replyContentRef: React.RefObject<HTMLDivElement>;
}

// ==================== IndexedDB 草稿缓存 ====================

const IMAGE_MARKER_REGEX = /^\[图片#([^\]]+)\]$/;
const STREAM_UPDATE_THROTTLE_MS = 100;
const ELAPSED_TIMER_INTERVAL_MS = 500;
const DRAFT_PERSIST_DEBOUNCE_MS = 400;
const DEFAULT_DEEP_THINKING_BUDGET_TOKENS = 4000;
const MIN_DEEP_THINKING_BUDGET_TOKENS = 500;
const MAX_DEEP_THINKING_BUDGET_TOKENS = 20000;
const DEFAULT_THINKING_MODE: AgentTestThinkingMode = 'fast';

function clampThinkingBudgetTokens(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DEEP_THINKING_BUDGET_TOKENS;

  return Math.min(
    MAX_DEEP_THINKING_BUDGET_TOKENS,
    Math.max(MIN_DEEP_THINKING_BUDGET_TOKENS, Math.round(value)),
  );
}

function inferMediaType(url: string): string {
  const match = url.match(/^data:([^;]+);/);
  return match?.[1] || 'image/*';
}

type ToolPartSnapshot = {
  type: string;
  toolName?: string;
  input?: unknown;
  args?: unknown;
  output?: unknown;
  result?: unknown;
};

function hasMessageContent(message: Pick<SimpleMessage, 'content' | 'imageUrls'>): boolean {
  return message.content.trim().length > 0 || (message.imageUrls?.length ?? 0) > 0;
}

function extractToolCalls(parts: UIMessage['parts']) {
  return parts
    .filter((part) => part.type.startsWith('tool-'))
    .map((part) => {
      const toolPart = part as unknown as ToolPartSnapshot;
      return {
        toolName: toolPart.toolName || part.type.replace(/^tool-/, ''),
        input: toolPart.input ?? toolPart.args,
        output: toolPart.output ?? toolPart.result,
      };
    });
}

function extractAdvancedStage(parts: UIMessage['parts']): string | null {
  const toolCalls = extractToolCalls(parts);

  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    const toolCall = toolCalls[i];
    if (toolCall.toolName !== 'advance_stage') continue;

    const output = toolCall.output;
    if (typeof output === 'object' && output !== null) {
      const newStage = (output as { newStage?: unknown }).newStage;
      if (typeof newStage === 'string' && newStage.trim()) {
        return newStage;
      }
    }

    const input = toolCall.input;
    if (typeof input === 'object' && input !== null) {
      const nextStage = (input as { nextStage?: unknown }).nextStage;
      if (typeof nextStage === 'string' && nextStage.trim()) {
        return nextStage;
      }
    }
  }

  return null;
}

/**
 * 聊天测试核心逻辑 Hook
 */
export function useChatTest({ onTestComplete }: UseChatTestOptions = {}): UseChatTestReturn {
  // 历史记录
  const [historyText, setHistoryTextState] = useState('');
  const [historyStatus, setHistoryStatus] = useState<'valid' | 'invalid' | 'empty'>('empty');

  // 当前输入
  const [currentInput, setCurrentInputState] = useState('');
  const setCurrentInput = useCallback((text: string) => {
    setCurrentInputState(text);
  }, []);
  const [thinkingMode, setThinkingMode] = useState<AgentTestThinkingMode>(DEFAULT_THINKING_MODE);
  const [thinkingBudgetTokens, setThinkingBudgetTokensState] = useState(
    DEFAULT_DEEP_THINKING_BUDGET_TOKENS,
  );
  const setThinkingBudgetTokens = useCallback((tokens: number) => {
    setThinkingBudgetTokensState(clampThinkingBudgetTokens(tokens));
  }, []);

  // 状态
  const [localError, setLocalError] = useState<string | null>(null);
  const [result, setResult] = useState<TestResultSummary | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);

  // 指标
  const [metrics, setMetrics] = useState<{ durationMs: number; tokenUsage: TokenUsage } | null>(
    null,
  );
  const startTimeRef = useRef<number>(0);
  const isCacheHydratedRef = useRef(false);

  // 会话 ID + 用户 ID：同一对话保持一致，清空聊天时重新生成（确保 Agent API 服务端记忆完全隔离）
  const [sessionId, setSessionId] = useState(() => generateUUID());
  const [userId, setUserId] = useState(() => `dashboard-test-${generateUUID().slice(0, 8)}`);

  // 图片上传
  const [imagePreviews, setImagePreviews] = useState<ImagePreview[]>([]);
  const historyImageCacheRef = useRef<Record<string, HistoryImageCacheEntry>>({});
  const submittedImagesRef = useRef<ImagePreview[]>([]);

  const addImages = useCallback((files: FileList) => {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setImagePreviews((prev) => [...prev, { id, file, dataUrl }]);
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const removeImage = useCallback((id: string) => {
    setImagePreviews((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // Refs
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const replyContentRef = useRef<HTMLDivElement>(null);
  const currentInputRef = useRef<string>('');
  const tokenUsageRef = useRef<TokenUsage | null>(null);
  const entryStageRef = useRef<string | null>(null);
  const [entryStage, setEntryStage] = useState<string | null>(null);
  const [currentStage, setCurrentStage] = useState<string | null>(null);

  const persistHistoryImages = useCallback((images: ImagePreview[]): string[] => {
    if (images.length === 0) return [];
    const nextCache = { ...historyImageCacheRef.current };
    const ids = images.map((image) => {
      nextCache[image.id] = {
        dataUrl: image.dataUrl,
        filename: image.file.name,
        mediaType: image.file.type || inferMediaType(image.dataUrl),
      };
      return image.id;
    });
    historyImageCacheRef.current = nextCache;
    void saveHistoryImageCache(nextCache);
    return ids;
  }, []);

  const buildFileParts = useCallback(
    (urls: string[], filenamePrefix: string): FileUIPart[] =>
      urls.map((url, index) => ({
        type: 'file',
        url,
        mediaType: inferMediaType(url),
        filename: `${filenamePrefix}-${index + 1}`,
      })),
    [],
  );

  const thinkingConfig = useMemo(
    () =>
      thinkingMode === 'deep'
        ? { type: 'enabled' as const, budgetTokens: thinkingBudgetTokens }
        : { type: 'disabled' as const, budgetTokens: 0 },
    [thinkingBudgetTokens, thinkingMode],
  );

  const requestBody = useMemo(
    () => ({
      scenario: DEFAULT_SCENARIO,
      saveExecution: false,
      sessionId,
      userId,
      thinking: thinkingConfig,
    }),
    [sessionId, thinkingConfig, userId],
  );

  // Transport 只保留静态配置，动态请求参数在 sendMessage 时传入
  const transport = useMemo(() => {
    const headers: Record<string, string> = {};
    const token = import.meta.env.API_GUARD_TOKEN;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return new DefaultChatTransport({
      api: CHAT_API_ENDPOINT,
      headers,
    });
  }, []);

  // useChat hook
  const { messages, sendMessage, status, stop, setMessages, error: chatError } = useChat({
    id: sessionId,
    transport,
    experimental_throttle: STREAM_UPDATE_THROTTLE_MS,
    onData: (dataPart: unknown) => {
      const part = dataPart as { type?: string; data?: unknown };
      if (part?.type === 'data-tokenUsage' && part.data) {
        tokenUsageRef.current = part.data as TokenUsage;
      }
      if (part?.type === 'data-entryStage' && typeof part.data === 'string') {
        entryStageRef.current = part.data;
        setEntryStage(part.data);
      }
    },
    onError: (err: Error) => {
      markAgentTestStreamEnd('error');
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
      markAgentTestStreamEnd('finish');
      const durationMs = Date.now() - startTimeRef.current;
      const submittedImages = submittedImagesRef.current;

      const toolCalls = extractToolCalls(message.parts);
      const advancedStage = extractAdvancedStage(message.parts);
      const finalStage = advancedStage ?? entryStageRef.current;

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
        request: {
          url: CHAT_API_ENDPOINT,
          method: 'POST',
          body: {
            ...requestBody,
            message: currentInputRef.current,
            imageUrls: submittedImages.map((image) => image.dataUrl),
          },
        },
        response: { statusCode: 200, body: { content: textContent }, toolCalls },
        metrics: { durationMs, tokenUsage: finalTokenUsage },
      };

      setResult({
        status: finalResult.status,
        metrics: finalResult.metrics,
      });
      onTestComplete?.(finalResult);
      setCurrentStage(finalStage);

      // 回写历史记录
      const now = new Date();
      const timeStr = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const userContent = currentInputRef.current || (submittedImages.length > 0 ? '[图片消息]' : '');
      const userLine = `[${timeStr} 候选人] ${userContent}`;
      const imageMarkerIds = persistHistoryImages(submittedImages);
      const imageMarkerLines = imageMarkerIds.map((id) => `[图片#${id}]`);
      const userBlock = [userLine, ...imageMarkerLines].join('\n');
      const aiLine = `[${timeStr} 招募经理] ${textContent}`;

      setHistoryTextState((prev) => {
        const newHistory = prev.trim()
          ? `${prev}\n\n${userBlock}\n\n${aiLine}`
          : `${userBlock}\n\n${aiLine}`;
        setTimeout(() => validateHistory(newHistory), 0);
        return newHistory;
      });

      setCurrentInput('');
      setImagePreviews([]);
      submittedImagesRef.current = [];
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
    }, ELAPSED_TIMER_INTERVAL_MS);
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
      const imageMarkerMatch = line.match(IMAGE_MARKER_REGEX);
      if (imageMarkerMatch && parsedMessages.length > 0) {
        const imageId = imageMarkerMatch[1].trim();
        const cachedImage = historyImageCacheRef.current[imageId];
        const lastMessage = parsedMessages[parsedMessages.length - 1];
        if (cachedImage && lastMessage.role === 'user') {
          lastMessage.imageUrls = [...(lastMessage.imageUrls || []), cachedImage.dataUrl];
        }
        continue;
      }

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
    return parsedMessages.filter(hasMessageContent);
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

  // 设置历史记录（带校验 + 缓存）
  const setHistoryText = useCallback(
    (text: string) => {
      setHistoryTextState(text);
      validateHistory(text);
    },
    [validateHistory],
  );

  const parsedHistory = useMemo(() => parseHistory(historyText), [historyText, parseHistory]);

  const historyMessages = useMemo<UIMessage[]>(
    () =>
      parsedHistory
        .map((msg, idx) => ({
          id: `history-${idx}`,
          role: msg.role,
          parts: [
            ...buildFileParts(msg.imageUrls || [], `history-image-${idx + 1}`),
            ...(msg.content.trim() ? [{ type: 'text' as const, text: msg.content }] : []),
          ],
        }))
        .filter((message) => message.parts.length > 0),
    [buildFileParts, parsedHistory],
  );

  useEffect(() => {
    let cancelled = false;

    const hydrateCache = async () => {
      try {
        const [draftCache, historyImageCache] = await Promise.all([
          loadAgentTestDraftCache(),
          loadHistoryImageCache(),
        ]);

        if (cancelled) return;

        historyImageCacheRef.current = historyImageCache;

        const nextHistoryText = draftCache.historyText ?? '';
        const nextCurrentInput = draftCache.currentInput ?? '';
        const nextSessionId = draftCache.sessionId || generateUUID();
        const nextUserId = draftCache.userId || `dashboard-test-${generateUUID().slice(0, 8)}`;
        const nextThinkingMode = draftCache.thinkingMode ?? DEFAULT_THINKING_MODE;
        const nextThinkingBudgetTokens = clampThinkingBudgetTokens(
          draftCache.thinkingBudgetTokens ?? DEFAULT_DEEP_THINKING_BUDGET_TOKENS,
        );

        setHistoryTextState(nextHistoryText);
        setCurrentInputState(nextCurrentInput);
        setSessionId(nextSessionId);
        setUserId(nextUserId);
        setThinkingMode(nextThinkingMode);
        setThinkingBudgetTokensState(nextThinkingBudgetTokens);
        validateHistory(nextHistoryText);
      } catch {
        if (cancelled) return;
      } finally {
        if (!cancelled) {
          isCacheHydratedRef.current = true;
        }
      }
    };

    void hydrateCache();

    return () => {
      cancelled = true;
    };
  }, [validateHistory]);

  useEffect(() => {
    if (!isCacheHydratedRef.current) return;

    const timer = window.setTimeout(() => {
      void saveAgentTestDraftCache({
        historyText,
        currentInput,
        sessionId,
        userId,
        thinkingMode,
        thinkingBudgetTokens,
      });
    }, DRAFT_PERSIST_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [currentInput, historyText, sessionId, thinkingBudgetTokens, thinkingMode, userId]);

  // 执行测试
  const handleTest = useCallback(async () => {
    const trimmedInput = currentInput.trim();
    if (!trimmedInput && imagePreviews.length === 0) return;

    currentInputRef.current = trimmedInput;
    submittedImagesRef.current = [...imagePreviews];
    entryStageRef.current = null;
    setEntryStage(null);
    setCurrentStage(null);
    setIsRequesting(true);
    setLocalError(null);
    setMetrics(null);
    setResult(null); // 在发起新请求时，立即重置测试结果
    startTimeRef.current = Date.now();
    markAgentTestStreamStart();

    setMessages(historyMessages);
    requestAnimationFrame(() => {
      const currentFiles = submittedImagesRef.current.map((image) => ({
        type: 'file' as const,
        url: image.dataUrl,
        mediaType: image.file.type || inferMediaType(image.dataUrl),
        filename: image.file.name,
      }));

      if (trimmedInput && currentFiles.length > 0) {
        sendMessage({ text: trimmedInput, files: currentFiles }, { body: requestBody });
        return;
      }
      if (trimmedInput) {
        sendMessage({ text: trimmedInput }, { body: requestBody });
        return;
      }
      sendMessage({ files: currentFiles }, { body: requestBody });
    });
  }, [currentInput, historyMessages, imagePreviews, requestBody, sendMessage, setMessages]);

  // 取消
  const handleCancel = useCallback(() => {
    markAgentTestStreamEnd('cancel');
    stop();
  }, [stop]);

  // 清空（重新生成 sessionId，开启新会话，清除缓存）
  const handleClear = useCallback(() => {
    const nextSessionId = generateUUID();
    const nextUserId = `dashboard-test-${generateUUID().slice(0, 8)}`;

    setHistoryTextState('');
    setHistoryStatus('empty');
    setCurrentInputState('');
    setMessages([]);
    setResult(null);
    setLocalError(null);
    setMetrics(null);
    setIsRequesting(false);
    setImagePreviews([]);
    entryStageRef.current = null;
    setEntryStage(null);
    setCurrentStage(null);
    submittedImagesRef.current = [];
    setSessionId(nextSessionId);
    setUserId(nextUserId);
    void saveAgentTestDraftCache({
      historyText: '',
      currentInput: '',
      sessionId: nextSessionId,
      userId: nextUserId,
      thinkingMode,
      thinkingBudgetTokens,
    });
    void clearHistoryImageCache();
    historyImageCacheRef.current = {};
    messageInputRef.current?.focus();
  }, [setMessages, thinkingBudgetTokens, thinkingMode]);

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
    entryStage,
    currentStage,
    imagePreviews,
    addImages,
    removeImage,
    thinkingMode,
    thinkingBudgetTokens,
    setHistoryText,
    setCurrentInput,
    setLocalError,
    setThinkingMode,
    setThinkingBudgetTokens,
    handleTest,
    handleCancel,
    handleClear,
    messageInputRef,
    replyContentRef,
  };
}
