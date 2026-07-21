import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { ApiError, NetworkError } from '@/api/client';
import { submitFeedback, FeedbackType } from '@/api/services/agent-test.service';
import type { FeedbackSource, FeedbackSourceTrace } from '@/api/types/agent-test.types';

export const MAX_FEEDBACK_SCREENSHOTS = 5;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export const MAX_FEEDBACK_SCREENSHOT_TOTAL_BYTES = 10 * 1024 * 1024;

export interface UseFeedbackOptions {
  /** 反馈来源渠道，决定飞书表「来源」列取值；缺省 agent_test */
  source?: FeedbackSource;
  onError?: (error: string) => void;
}

export interface UseFeedbackReturn {
  // Modal 状态
  isOpen: boolean;
  feedbackType: FeedbackType | null;
  scenarioType: string;
  remark: string;
  screenshots: string[];
  isSubmitting: boolean;
  successType: FeedbackType | null;
  submitError: string | null;

  // 操作
  openModal: (type: FeedbackType) => void;
  closeModal: () => void;
  setScenarioType: (type: string) => void;
  setRemark: (remark: string) => void;
  addScreenshots: (files: Iterable<File>) => void;
  removeScreenshot: (index: number) => void;
  submit: (payload: {
    chatHistory: string;
    userMessage?: string;
    chatId?: string;
    messageId?: string;
    traceId?: string;
    batchId?: string;
    sourceTrace?: FeedbackSourceTrace;
    candidateName?: string;
    managerName?: string;
  }) => Promise<boolean>;
  clearSuccess: () => void;
}

function getFeedbackErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.details as { validationErrors?: string[] } | undefined;
    const validationErrors = details?.validationErrors;
    if (Array.isArray(validationErrors) && validationErrors.length > 0) {
      return validationErrors.join('；');
    }

    return error.message || '提交反馈失败，请重试';
  }

  if (error instanceof NetworkError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message || '提交反馈失败，请重试';
  }

  return '提交反馈失败，请重试';
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function estimateDataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.floor(base64.length * 0.75);
}

/**
 * 反馈功能 Hook
 */
export function useFeedback({ source, onError }: UseFeedbackOptions = {}): UseFeedbackReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [feedbackType, setFeedbackType] = useState<FeedbackType | null>(null);
  const [scenarioType, setScenarioType] = useState('');
  const [remark, setRemark] = useState('');
  const [screenshots, setScreenshots] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successType, setSuccessType] = useState<FeedbackType | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const openModal = useCallback((type: FeedbackType) => {
    setFeedbackType(type);
    setScenarioType('');
    setRemark('');
    setScreenshots([]);
    setSubmitError(null);
    setIsOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setIsOpen(false);
    setFeedbackType(null);
    setScenarioType('');
    setRemark('');
    setScreenshots([]);
    setSubmitError(null);
  }, []);

  const addScreenshots = useCallback((files: Iterable<File>) => {
    void (async () => {
      const images = Array.from(files).filter((file) => file.type.startsWith('image/'));
      if (images.length === 0) return;

      const oversized = images.filter((file) => file.size > MAX_SCREENSHOT_BYTES);
      if (oversized.length > 0) {
        toast.error('单张截图不能超过 5MB');
      }

      const accepted = images.filter((file) => file.size <= MAX_SCREENSHOT_BYTES);
      if (accepted.length === 0) return;

      try {
        const dataUrls = await Promise.all(accepted.map(readFileAsDataUrl));
        setScreenshots((prev) => {
          const merged = [...prev];
          let totalBytes = prev.reduce((sum, dataUrl) => sum + estimateDataUrlBytes(dataUrl), 0);
          let exceededCount = false;
          let exceededTotalSize = false;

          for (const dataUrl of dataUrls) {
            if (merged.length >= MAX_FEEDBACK_SCREENSHOTS) {
              exceededCount = true;
              continue;
            }
            const bytes = estimateDataUrlBytes(dataUrl);
            if (totalBytes + bytes > MAX_FEEDBACK_SCREENSHOT_TOTAL_BYTES) {
              exceededTotalSize = true;
              continue;
            }
            merged.push(dataUrl);
            totalBytes += bytes;
          }

          if (exceededCount) {
            toast.error(`最多上传 ${MAX_FEEDBACK_SCREENSHOTS} 张截图`);
          }
          if (exceededTotalSize) {
            toast.error('截图合计不能超过 10MB');
          }
          return merged;
        });
      } catch {
        toast.error('读取截图失败，请重试');
      }
    })();
  }, []);

  const removeScreenshot = useCallback((index: number) => {
    setScreenshots((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const submit = useCallback(
    async ({
      chatHistory,
      userMessage,
      chatId,
      messageId,
      traceId,
      batchId,
      sourceTrace,
      candidateName,
      managerName,
    }: {
      chatHistory: string;
      userMessage?: string;
      chatId?: string;
      messageId?: string;
      traceId?: string;
      batchId?: string;
      sourceTrace?: FeedbackSourceTrace;
      candidateName?: string;
      managerName?: string;
    }): Promise<boolean> => {
      if (!feedbackType || !chatHistory.trim()) return false;

      const submittedType = feedbackType;
      setIsSubmitting(true);
      setSubmitError(null);
      try {
        const result = await submitFeedback({
          type: submittedType,
          chatHistory: chatHistory.trim(),
          userMessage: userMessage?.trim() || undefined,
          errorType: scenarioType || undefined, // 后端历史字段名，实际承载 BadCase「分类」
          remark: remark || undefined,
          chatId,
          messageId,
          traceId,
          batchId,
          sourceTrace,
          candidateName: candidateName?.trim() || undefined,
          managerName: managerName?.trim() || undefined,
          source,
          screenshots: screenshots.length > 0 ? screenshots : undefined,
        });
        setSuccessType(submittedType);
        closeModal();
        toast.success(
          result.message ||
            `${submittedType === 'goodcase' ? 'GoodCase' : 'BadCase'} 已成功写入飞书表格`,
          { duration: 3500 },
        );
        // 3 秒后清除成功状态
        setTimeout(() => setSuccessType(null), 3000);
        return true;
      } catch (err) {
        console.error('提交反馈失败:', err);
        const message = getFeedbackErrorMessage(err);
        setSubmitError(message);
        toast.error(message, { duration: 4500 });
        onError?.(message);
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [feedbackType, scenarioType, remark, screenshots, source, closeModal, onError],
  );

  const clearSuccess = useCallback(() => {
    setSuccessType(null);
  }, []);

  return {
    isOpen,
    feedbackType,
    scenarioType,
    remark,
    screenshots,
    isSubmitting,
    successType,
    submitError,
    openModal,
    closeModal,
    setScenarioType,
    setRemark,
    addScreenshots,
    removeScreenshot,
    submit,
    clearSuccess,
  };
}
