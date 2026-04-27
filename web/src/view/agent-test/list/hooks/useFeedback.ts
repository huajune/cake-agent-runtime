import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { ApiError, NetworkError } from '@/api/client';
import { submitFeedback, FeedbackType } from '@/api/services/agent-test.service';

export interface UseFeedbackOptions {
  onError?: (error: string) => void;
}

export interface UseFeedbackReturn {
  // Modal 状态
  isOpen: boolean;
  feedbackType: FeedbackType | null;
  scenarioType: string;
  remark: string;
  isSubmitting: boolean;
  successType: FeedbackType | null;
  submitError: string | null;

  // 操作
  openModal: (type: FeedbackType) => void;
  closeModal: () => void;
  setScenarioType: (type: string) => void;
  setRemark: (remark: string) => void;
  submit: (payload: {
    chatHistory: string;
    userMessage?: string;
    chatId?: string;
    batchId?: string;
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

/**
 * 反馈功能 Hook
 */
export function useFeedback({ onError }: UseFeedbackOptions = {}): UseFeedbackReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [feedbackType, setFeedbackType] = useState<FeedbackType | null>(null);
  const [scenarioType, setScenarioType] = useState('');
  const [remark, setRemark] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successType, setSuccessType] = useState<FeedbackType | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const openModal = useCallback((type: FeedbackType) => {
    setFeedbackType(type);
    setScenarioType('');
    setRemark('');
    setSubmitError(null);
    setIsOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setIsOpen(false);
    setFeedbackType(null);
    setScenarioType('');
    setRemark('');
    setSubmitError(null);
  }, []);

  const submit = useCallback(
    async ({
      chatHistory,
      userMessage,
      chatId,
      batchId,
      candidateName,
      managerName,
    }: {
      chatHistory: string;
      userMessage?: string;
      chatId?: string;
      batchId?: string;
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
          errorType: scenarioType || undefined, // 场景分类提交到 errorType 字段
          remark: remark || undefined,
          chatId,
          batchId,
          candidateName: candidateName?.trim() || undefined,
          managerName: managerName?.trim() || undefined,
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
    [feedbackType, scenarioType, remark, closeModal, onError],
  );

  const clearSuccess = useCallback(() => {
    setSuccessType(null);
  }, []);

  return {
    isOpen,
    feedbackType,
    scenarioType,
    remark,
    isSubmitting,
    successType,
    submitError,
    openModal,
    closeModal,
    setScenarioType,
    setRemark,
    submit,
    clearSuccess,
  };
}
