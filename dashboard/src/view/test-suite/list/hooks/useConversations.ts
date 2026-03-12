import { useState, useCallback } from 'react';
import {
  getConversationSnapshots,
  executeConversation,
  type ConversationSnapshot,
} from '@/api/services/agent-test.service';

interface UseConversationsResult {
  conversations: ConversationSnapshot[];
  selectedConversation: ConversationSnapshot | null;
  loading: boolean;
  executing: string | null;
  total: number;
  page: number;
  pageSize: number;
  setSelectedConversation: (conversation: ConversationSnapshot | null) => void;
  loadConversations: (batchId: string) => Promise<void>;
  executeConversationTest: (conversationId: string, forceRerun?: boolean) => Promise<void>;
  refreshConversation: (conversationId: string) => Promise<void>;
}

/**
 * 回归验证列表管理 Hook
 * 管理对话源列表的加载、选择和执行
 */
export function useConversations(): UseConversationsResult {
  const [conversations, setConversations] = useState<ConversationSnapshot[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<ConversationSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [page] = useState(1); // Page state reserved for future pagination
  const pageSize = 20;

  /**
   * 加载对话列表
   */
  const loadConversations = useCallback(async (batchId: string) => {
    try {
      setLoading(true);
      const result = await getConversationSnapshots({
        batchId,
        page,
        pageSize,
      });
      setConversations(result.sources);
      setTotal(result.total);
    } catch (error) {
      console.error('加载对话列表失败:', error);
      setConversations([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  /**
   * 执行单个回归验证
   */
  const executeConversationTest = useCallback(
    async (conversationId: string, forceRerun = false) => {
      try {
        setExecuting(conversationId);

        // 更新对话状态为 running
        setConversations((prev) =>
          prev.map((conv) =>
            conv.id === conversationId ? { ...conv, status: 'running' as const } : conv,
          ),
        );

        // 执行测试
        const result = await executeConversation({
          sourceId: conversationId,
          forceRerun,
        });

        // 更新对话状态为 completed 并更新相似度分数和轮次数
        setConversations((prev) =>
          prev.map((conv) =>
            conv.id === conversationId
              ? {
                  ...conv,
                  status: 'completed' as const,
                  totalTurns: result.totalTurns,
                  avgSimilarityScore: result.avgSimilarityScore,
                  minSimilarityScore: result.minSimilarityScore,
                }
              : conv,
          ),
        );

        // 如果当前选中的是这个对话，也更新选中的对话
        if (selectedConversation?.id === conversationId) {
          setSelectedConversation((prev) =>
            prev
              ? {
                  ...prev,
                  status: 'completed' as const,
                  totalTurns: result.totalTurns,
                  avgSimilarityScore: result.avgSimilarityScore,
                  minSimilarityScore: result.minSimilarityScore,
                }
              : null,
          );
        }
      } catch (error) {
        console.error('执行回归验证失败:', error);
        // 更新状态为 failed
        setConversations((prev) =>
          prev.map((conv) =>
            conv.id === conversationId ? { ...conv, status: 'failed' as const } : conv,
          ),
        );
      } finally {
        setExecuting(null);
      }
    },
    [selectedConversation],
  );

  /**
   * 刷新单个对话的数据
   */
  const refreshConversation = useCallback(
    async (conversationId: string) => {
      const conversation = conversations.find((c) => c.id === conversationId);
      if (conversation) {
        await loadConversations(conversation.batchId);
      }
    },
    [conversations, loadConversations],
  );

  return {
    conversations,
    selectedConversation,
    loading,
    executing,
    total,
    page,
    pageSize,
    setSelectedConversation,
    loadConversations,
    executeConversationTest,
    refreshConversation,
  };
}
