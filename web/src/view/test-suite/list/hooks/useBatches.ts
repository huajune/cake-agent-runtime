import { useState, useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import {
  getBatches,
  getBatchExecutions,
  getBatchStats,
  quickCreateBatch,
  TestBatch,
  TestExecution,
  BatchStats,
  TestType,
} from '@/api/services/agent-test.service';

const PAGE_SIZE = 20;

interface UseBatchesOptions {
  testType?: TestType;
}

/**
 * 批次数据管理 Hook
 *
 * @param options.testType 测试类型过滤
 */
export function useBatches(options: UseBatchesOptions = {}) {
  const { testType } = options;
  // 批次列表
  const [batches, setBatches] = useState<TestBatch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<TestBatch | null>(null);
  const [batchStats, setBatchStats] = useState<BatchStats | null>(null);

  // 分页状态
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);

  // 执行记录
  const [executions, setExecutions] = useState<TestExecution[]>([]);

  // 加载状态
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [quickCreating, setQuickCreating] = useState(false);

  const normalizeBatchList = (value: unknown): TestBatch[] =>
    Array.isArray(value) ? (value as TestBatch[]) : [];

  const normalizeExecutionList = (value: unknown): TestExecution[] =>
    Array.isArray(value) ? (value as TestExecution[]) : [];

  // 加载批次列表（首次加载/刷新）
  const loadBatches = useCallback(async () => {
    try {
      setLoading(true);
      offsetRef.current = 0;
      // 切换类型时清空所有状态，确保显示 loading
      setBatches([]);
      setSelectedBatch(null);
      setBatchStats(null);
      setExecutions([]);
      const result = await getBatches(PAGE_SIZE, 0, testType);
      const batchList = normalizeBatchList(result.data);
      setBatches(batchList);
      setTotal(result.total);
      setHasMore(batchList.length < result.total);
      offsetRef.current = batchList.length;
    } catch (err: unknown) {
      const error = err as { message?: string };
      toast.error(error.message || '加载批次失败');
    } finally {
      setLoading(false);
    }
  }, [testType]);

  // 加载更多批次（无限滚动）
  const loadMoreBatches = useCallback(async () => {
    if (loadingMore || !hasMore) return;

    try {
      setLoadingMore(true);
      const result = await getBatches(PAGE_SIZE, offsetRef.current, testType);
      const batchList = normalizeBatchList(result.data);
      setBatches((prev) => [...prev, ...batchList]);
      setTotal(result.total);
      offsetRef.current += batchList.length;
      setHasMore(offsetRef.current < result.total);
    } catch (err: unknown) {
      const error = err as { message?: string };
      toast.error(error.message || '加载更多失败');
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, testType]);

  // 加载批次详情
  const loadBatchData = useCallback(async (batch: TestBatch) => {
    try {
      setDetailLoading(true);
      const [stats, execs] = await Promise.all([
        getBatchStats(batch.id),
        getBatchExecutions(batch.id),
      ]);
      setBatchStats(stats);
      setExecutions(normalizeExecutionList(execs));
    } catch (err: unknown) {
      const error = err as { message?: string };
      toast.error(error.message || '加载数据失败');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // 刷新批次统计
  const refreshBatchStats = useCallback(async () => {
    if (!selectedBatch) return;
    try {
      const stats = await getBatchStats(selectedBatch.id);
      setBatchStats(stats);
    } catch (err: unknown) {
      console.warn('刷新统计失败:', err);
    }
  }, [selectedBatch]);

  // 一键创建批量测试
  const handleQuickCreate = useCallback(async () => {
    try {
      setQuickCreating(true);
      const result = await quickCreateBatch({ testType });
      toast.success(`成功导入 ${result.totalImported} 条测试用例`);
      await loadBatches();
    } catch (err: unknown) {
      console.error('Quick create error:', err);
      const error = err as { response?: { data?: { error?: any; message?: any } }; message?: string };
      let errMsg = error.response?.data?.error || error.response?.data?.message || error.message || '创建失败';
      if (typeof errMsg !== 'string') {
        try {
          errMsg = JSON.stringify(errMsg);
        } catch {
          errMsg = '创建失败（未知错误）';
        }
      }
      toast.error(errMsg);
    } finally {
      setQuickCreating(false);
    }
  }, [loadBatches, testType]);

  // 初始加载
  useEffect(() => {
    loadBatches();
  }, [loadBatches]);

  // 选中批次时加载详情
  useEffect(() => {
    if (selectedBatch) {
      loadBatchData(selectedBatch);
    }
  }, [selectedBatch, loadBatchData]);

  return {
    // 状态
    batches,
    selectedBatch,
    batchStats,
    executions,
    loading,
    loadingMore,
    detailLoading,
    quickCreating,
    total,
    hasMore,

    // 操作
    setSelectedBatch,
    setExecutions,
    loadBatches,
    loadMoreBatches,
    loadBatchData,
    refreshBatchStats,
    handleQuickCreate,
  };
}
