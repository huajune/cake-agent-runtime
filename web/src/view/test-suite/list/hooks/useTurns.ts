import { useState, useCallback } from 'react';
import {
  getConversationTurns,
  updateTurnReview,
  type ConversationTurnExecution,
  type TurnListResponse,
} from '@/api/services/agent-test.service';

interface UseTurnsResult {
  turns: ConversationTurnExecution[];
  conversationInfo: TurnListResponse['conversationInfo'] | null;
  currentTurnIndex: number;
  loading: boolean;
  reviewLoading: boolean;
  setCurrentTurnIndex: (index: number) => void;
  loadTurns: (sourceId: string) => Promise<void>;
  goToNextTurn: () => void;
  goToPreviousTurn: () => void;
  reviewTurn: (
    executionId: string,
    status: 'passed' | 'failed' | 'skipped',
    comment?: string,
  ) => Promise<void>;
}

/**
 * 对话轮次管理 Hook
 * 管理轮次列表的加载、导航和评审
 */
export function useTurns(): UseTurnsResult {
  const [turns, setTurns] = useState<ConversationTurnExecution[]>([]);
  const [conversationInfo, setConversationInfo] = useState<
    TurnListResponse['conversationInfo'] | null
  >(null);
  const [currentTurnIndex, setCurrentTurnIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);

  /**
   * 加载轮次列表
   */
  const loadTurns = useCallback(async (sourceId: string) => {
    try {
      setLoading(true);
      const result = await getConversationTurns(sourceId);
      setTurns(Array.isArray(result.turns) ? result.turns : []);
      setConversationInfo(result.conversationInfo ?? null);
      setCurrentTurnIndex(0);
    } catch (error) {
      console.error('加载轮次列表失败:', error);
      setTurns([]);
      setConversationInfo(null);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * 下一轮
   */
  const goToNextTurn = useCallback(() => {
    setCurrentTurnIndex((prev) => {
      if (prev < turns.length - 1) {
        return prev + 1;
      }
      return prev;
    });
  }, [turns.length]);

  /**
   * 上一轮
   */
  const goToPreviousTurn = useCallback(() => {
    setCurrentTurnIndex((prev) => {
      if (prev > 0) {
        return prev - 1;
      }
      return prev;
    });
  }, []);

  /**
   * 评审轮次
   */
  const reviewTurn = useCallback(
    async (executionId: string, status: 'passed' | 'failed' | 'skipped', comment?: string) => {
      try {
        setReviewLoading(true);
        const updatedTurn = await updateTurnReview({
          executionId,
          reviewStatus: status,
          reviewComment: comment,
        });

        // 更新本地数据
        setTurns((prev) =>
          prev.map((turn) => (turn.id === executionId ? { ...turn, ...updatedTurn } : turn)),
        );
      } catch (error) {
        console.error('评审轮次失败:', error);
        throw error;
      } finally {
        setReviewLoading(false);
      }
    },
    [],
  );

  return {
    turns,
    conversationInfo,
    currentTurnIndex,
    loading,
    reviewLoading,
    setCurrentTurnIndex,
    loadTurns,
    goToNextTurn,
    goToPreviousTurn,
    reviewTurn,
  };
}
