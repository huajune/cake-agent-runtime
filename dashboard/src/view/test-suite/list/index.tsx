import { useState, useEffect } from 'react';
import { RefreshCw, Rocket, Sparkles, Play } from 'lucide-react';
import { useBatches, useReview, useConversations, useTurns } from './hooks';
import { BatchList } from './components/BatchList';
import { StatsRow } from './components/StatsRow';
import { CaseList } from './components/CaseList';
import { ReviewModal } from './components/ReviewModal';
import { SkeletonLoader } from './components/SkeletonLoader';
import { TabSwitch } from './components/TabSwitch';
import { ConversationList } from './components/ConversationList';
import { TurnCompareView } from './components/TurnCompareView';
import type { TestType } from './types';
import styles from './styles/index.module.scss';

/**
 * 飞书测试集页面
 * 支持场景测试和对话验证两种模式
 */
export default function TestSuite() {
  // Tab 状态
  const [activeTab, setActiveTab] = useState<TestType>('scenario');

  // 批次数据管理
  const {
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
    setSelectedBatch,
    setExecutions,
    loadBatches,
    loadMoreBatches,
    refreshBatchStats,
    handleQuickCreate,
  } = useBatches();

  // 场景测试评审功能
  const {
    reviewMode,
    currentReviewIndex,
    currentExecution,
    pendingCount,
    showFailureOptions,
    reviewLoading,
    detailLoading: executionDetailLoading,
    setShowFailureOptions,
    startReview,
    closeReview,
    openExecution,
    goToPrevious,
    goToNext,
    handleReview,
  } = useReview({
    executions,
    onExecutionsChange: setExecutions,
    onReviewComplete: () => {
      refreshBatchStats();
      loadBatches();
    },
  });

  // 对话验证功能
  const {
    conversations,
    selectedConversation,
    loading: conversationsLoading,
    executing,
    setSelectedConversation,
    loadConversations,
    executeConversationTest,
  } = useConversations();

  // 轮次对比功能
  const {
    turns,
    conversationInfo,
    currentTurnIndex,
    loading: turnsLoading,
    setCurrentTurnIndex,
    loadTurns,
  } = useTurns();

  // 当选中批次变化时,加载对应类型的数据
  useEffect(() => {
    if (selectedBatch && activeTab === 'conversation') {
      loadConversations(selectedBatch.id);
    }
  }, [selectedBatch, activeTab, loadConversations]);

  // 当选中对话变化时,加载轮次数据
  useEffect(() => {
    if (selectedConversation) {
      loadTurns(selectedConversation.id);
    }
  }, [selectedConversation, loadTurns]);

  return (
    <div className={styles.page}>
      {/* 页面标题 */}
      <div className={styles.pageHeader}>
        <div className={styles.headerLeft}>
          <h1>飞书测试集</h1>
          <p className={styles.subtitle}>从飞书多维表格导入测试用例,执行自动化测试并进行评审</p>
        </div>
        <div className={styles.headerActions}>
          <button
            className={styles.primaryBtn}
            onClick={handleQuickCreate}
            disabled={quickCreating}
          >
            <Rocket size={16} />
            {quickCreating ? '创建中...' : '一键测试'}
          </button>
          <button className={styles.iconBtn} onClick={loadBatches} disabled={loading}>
            <RefreshCw size={16} className={loading ? styles.spinning : ''} />
          </button>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className={styles.tabContainer}>
        <TabSwitch
          activeTab={activeTab}
          onTabChange={setActiveTab}
          scenarioCount={batches.filter((b) => !b.feishu_table_id?.includes('conversation')).length}
          conversationCount={batches.filter((b) => b.feishu_table_id?.includes('conversation'))
            .length}
        />
      </div>

      {/* 主内容区 */}
      <div className={styles.mainContent}>
        {/* 左侧：批次列表 */}
        <BatchList
          batches={batches}
          selectedBatch={selectedBatch}
          loading={loading}
          loadingMore={loadingMore}
          hasMore={hasMore}
          total={total}
          onSelect={setSelectedBatch}
          onLoadMore={loadMoreBatches}
        />

        {/* 右侧：详情面板 */}
        <div className={styles.detailPanel}>
          {detailLoading ? (
            <SkeletonLoader />
          ) : selectedBatch ? (
            <>
              {/* 统计卡片 */}
              {batchStats && <StatsRow stats={batchStats} />}

              {/* 场景测试视图 */}
              {activeTab === 'scenario' && (
                <>
                  {/* 评审按钮 */}
                  {pendingCount > 0 && !reviewMode && (
                    <button className={styles.reviewBtn} onClick={startReview}>
                      <Play size={16} />
                      开始评审 ({pendingCount} 条待评审)
                    </button>
                  )}

                  {/* 用例列表 */}
                  <CaseList
                    executions={executions}
                    currentReviewIndex={currentReviewIndex}
                    reviewMode={reviewMode}
                    onSelect={openExecution}
                  />
                </>
              )}

              {/* 对话验证视图 */}
              {activeTab === 'conversation' && (
                <div className={styles.conversationView}>
                  {/* 左侧：对话列表 */}
                  <div className={styles.conversationListPanel}>
                    <ConversationList
                      conversations={conversations}
                      selectedConversation={selectedConversation}
                      loading={conversationsLoading}
                      executing={executing}
                      onSelect={setSelectedConversation}
                      onExecute={executeConversationTest}
                    />
                  </div>

                  {/* 右侧：轮次对比 */}
                  <div className={styles.turnComparePanel}>
                    {selectedConversation ? (
                      <TurnCompareView
                        turns={turns}
                        conversationInfo={conversationInfo}
                        currentTurnIndex={currentTurnIndex}
                        loading={turnsLoading}
                        onTurnChange={setCurrentTurnIndex}
                      />
                    ) : (
                      <div className={styles.noSelection}>
                        <Sparkles size={48} strokeWidth={1} />
                        <p>选择左侧对话查看轮次详情</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className={styles.noSelection}>
              <Sparkles size={48} strokeWidth={1} />
              <p>选择左侧批次查看详情</p>
              <p className={styles.hint}>或创建新的测试批次</p>
            </div>
          )}
        </div>
      </div>

      {/* 评审弹窗（仅场景测试） */}
      {reviewMode && currentExecution && (
        <ReviewModal
          execution={currentExecution}
          currentIndex={currentReviewIndex}
          totalCount={executions.length}
          showFailureOptions={showFailureOptions}
          loading={reviewLoading}
          detailLoading={executionDetailLoading}
          onClose={closeReview}
          onPrevious={goToPrevious}
          onNext={goToNext}
          onPass={() => handleReview('passed')}
          onFail={(reason) => handleReview('failed', reason)}
          onShowFailureOptions={setShowFailureOptions}
        />
      )}
    </div>
  );
}
