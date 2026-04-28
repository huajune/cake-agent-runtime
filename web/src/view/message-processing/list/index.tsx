import { useState, useMemo, useCallback, useEffect } from 'react';
import InfiniteScroll from 'react-infinite-scroll-component';
import {
  useMessageProcessingRecords,
  useMessageStats,
  useSlowestMessages,
} from '@/hooks/chat/useMessageProcessingRecords';
import { useRealtimeMessageProcessing } from '@/hooks/chat/useRealtimeMessageProcessing';
import { useConfiguredBots } from '@/hooks/bot/useBots';
import ControlPanel from './components/ControlPanel';
import MessageProcessingTable from './components/MessageProcessingTable';
import MessageProcessingDetailDrawer from './components/MessageProcessingDetailDrawer';
import type { MessageRecord } from '@/api/types/chat.types';
import type { BotAccount } from '@/api/types/bot.types';

const ALL_BOTS = '__all_bots__';

interface BotOption {
  value: string;
  label: string;
  aliases: string[];
  filterValues: string[];
}

function toTimestamp(value: string | number): number {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value?: string) {
  return (value || '').trim().toLowerCase();
}

function compareText(a?: string, b?: string) {
  return (a || '').localeCompare(b || '', 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

function uniqueValues(values: Array<string | undefined>) {
  return Array.from(
    new Set(
      values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)),
    ),
  );
}

function getBotFilterValues(bot: BotAccount) {
  return uniqueValues([bot.wecomUserId, bot.weixin, bot.nickName, bot.name, bot.wxid, bot.id]);
}

function getBotOptionValue(bot: BotAccount, index: number) {
  return bot.wxid || bot.id || bot.wecomUserId || bot.weixin || bot.nickName || `bot-${index}`;
}

function getBotDisplayName(bot: BotAccount) {
  const name = bot.nickName || bot.name;
  const userId = bot.wecomUserId || bot.weixin;
  const primary = name || userId || bot.wxid || bot.id || '未命名账号';
  if (name && userId && normalizeText(name) !== normalizeText(userId)) {
    return `${name} / ${userId}`;
  }
  return primary;
}

function getRecordBotAliases(record: Pick<MessageRecord, 'managerName'>) {
  return uniqueValues([record.managerName]).map(normalizeText);
}

function matchesBotOption(
  record: Pick<MessageRecord, 'managerName'>,
  option: Pick<BotOption, 'aliases'>,
) {
  const recordAliases = getRecordBotAliases(record);
  return recordAliases.some((alias) => option.aliases.includes(alias));
}

export default function MessageProcessingPage() {
  // 订阅 Supabase Realtime，自动刷新数据
  useRealtimeMessageProcessing();

  const [timeRange, setTimeRange] = useState<'today' | 'week' | 'month'>('today');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'realtime' | 'slowest'>('realtime');
  const [searchUserName, setSearchUserName] = useState<string>('');
  const [botFilter, setBotFilter] = useState<string>(ALL_BOTS);
  const { data: configuredBots = [], isLoading: isBotsLoading } = useConfiguredBots();

  // 分页状态（仅用于实时列表）
  const [page, setPage] = useState(1);
  // tailMessages：page >= 2 拉取并累加的"尾部"数据；第 1 页由独立 head 查询实时驱动
  const [tailMessages, setTailMessages] = useState<MessageRecord[]>([]);
  const PAGE_SIZE = 50;

  // 计算时间范围
  const dateRange = useMemo(() => {
    const now = new Date();
    const endDate = now.toISOString().split('T')[0];
    let startDate: string;

    if (timeRange === 'today') {
      startDate = endDate;
    } else if (timeRange === 'week') {
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      startDate = weekAgo.toISOString().split('T')[0];
    } else {
      const monthAgo = new Date(now);
      monthAgo.setDate(monthAgo.getDate() - 30);
      startDate = monthAgo.toISOString().split('T')[0];
    }

    return { startDate, endDate };
  }, [timeRange]);

  const botOptions = useMemo(() => {
    const optionsByValue = new Map<string, BotOption>();

    configuredBots.forEach((bot, index) => {
      const filterValues = getBotFilterValues(bot);
      if (filterValues.length === 0) return;

      const value = getBotOptionValue(bot, index);
      const existing = optionsByValue.get(value);
      const aliases = filterValues.map(normalizeText);

      optionsByValue.set(value, {
        value,
        label: existing?.label || getBotDisplayName(bot),
        aliases: uniqueValues([...(existing?.aliases || []), ...aliases]),
        filterValues: uniqueValues([...(existing?.filterValues || []), ...filterValues]),
      });
    });

    return Array.from(optionsByValue.values()).sort((a, b) => compareText(a.label, b.label));
  }, [configuredBots]);

  const activeBotOption = botOptions.find((option) => option.value === botFilter);
  const activeBotFilter = activeBotOption ? botFilter : ALL_BOTS;
  const activeManagerNames = activeBotOption?.filterValues;
  const activeUserName = searchUserName || undefined;

  // 时间范围变化时重置分页和累加数据
  const handleTimeRangeChange = useCallback((newRange: 'today' | 'week' | 'month') => {
    setTimeRange(newRange);
    setPage(1);
    setTailMessages([]);
  }, []);

  // 用户搜索变化时重置分页和累加数据
  const handleSearchUserNameChange = useCallback((userName: string) => {
    setSearchUserName(userName);
    setPage(1);
    setTailMessages([]);
  }, []);

  // 托管 BOT 筛选变化时重置分页和累加数据
  const handleBotFilterChange = useCallback((value: string) => {
    setBotFilter(value);
    setPage(1);
    setTailMessages([]);
  }, []);

  const resolveBotLabel = useCallback(
    (record: Pick<MessageRecord, 'managerName'>) => {
      const matchedOption = botOptions.find((option) => matchesBotOption(record, option));
      return matchedOption?.label || record.managerName || '-';
    },
    [botOptions],
  );

  // 统计数据：使用轻量级聚合查询接口
  const { data: statsData } = useMessageStats({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    userName: activeUserName,
    managerNames: activeManagerNames,
  });

  const stats = statsData || { total: 0, success: 0, failed: 0, avgDuration: 0, avgTtft: 0 };

  // 第 1 页"真相源"：固定 offset=0，Realtime invalidate 时会自动热刷新，
  // 因此 UPDATE（例如 processing → success）能即时反映到列表头部。
  const { data: headMessages, isLoading: headLoading } = useMessageProcessingRecords({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    userName: activeUserName,
    managerNames: activeManagerNames,
    limit: PAGE_SIZE,
    offset: 0,
    enabled: activeTab === 'realtime',
  });

  // 尾部分页（page >= 2）：只有向下滚动加载更多时才开启
  const { data: tailPageMessages, isLoading: tailLoading } = useMessageProcessingRecords({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    userName: activeUserName,
    managerNames: activeManagerNames,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    enabled: activeTab === 'realtime' && page > 1,
  });

  // 累加尾部分页：用 Map 按 messageId 覆盖，既能追加新记录，也能让 UPDATE 后的新 status 替换旧行
  useEffect(() => {
    if (!tailPageMessages || tailPageMessages.length === 0) return;
    setTailMessages((prev) => {
      const map = new Map<string, MessageRecord>();
      for (const m of prev) if (m.messageId) map.set(m.messageId, m);
      for (const m of tailPageMessages) if (m.messageId) map.set(m.messageId, m);
      return Array.from(map.values());
    });
  }, [tailPageMessages]);

  // 最慢 Top10：使用专用接口（后端按 ai_duration 排序）
  const { data: slowestMessages, isLoading: slowestLoading } = useSlowestMessages({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    userName: activeUserName,
    managerNames: activeManagerNames,
    limit: 10,
    enabled: activeTab === 'slowest',
  });

  // 合并 head + tail：head 优先覆盖 tail（同一条 messageId 以 head 的最新状态为准），
  // 再按 receivedAt 倒序渲染。
  const realtimeMessages = useMemo(() => {
    const map = new Map<string, MessageRecord>();
    for (const m of tailMessages) if (m.messageId) map.set(m.messageId, m);
    for (const m of headMessages || []) if (m.messageId) map.set(m.messageId, m);
    return Array.from(map.values()).sort(
      (a, b) => toTimestamp(b.receivedAt) - toTimestamp(a.receivedAt),
    );
  }, [headMessages, tailMessages]);

  // 根据 Tab 切换数据源
  const messages = activeTab === 'realtime' ? realtimeMessages : slowestMessages || [];
  const isLoading =
    activeTab === 'realtime' ? headLoading && realtimeMessages.length === 0 : slowestLoading;
  const isLoadingMore = activeTab === 'realtime' && tailLoading && page > 1;

  // 是否还有更多数据（仅用于实时列表）
  const hasMore =
    activeTab === 'realtime' &&
    realtimeMessages.length > 0 &&
    realtimeMessages.length < stats.total;

  // 加载更多
  const handleLoadMore = useCallback(() => {
    if (!tailLoading && !headLoading) {
      setPage((prev) => prev + 1);
    }
  }, [tailLoading, headLoading]);

  // Tab 数据量
  const realtimeCount = stats.total; // 使用统计数据的总数
  const slowestCount = slowestMessages?.length || 0;

  return (
    <div id="page-message-processing" className="page-section active">
      <ControlPanel
        stats={stats}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        realtimeCount={realtimeCount}
        slowestCount={slowestCount}
        timeRange={timeRange}
        onTimeRangeChange={handleTimeRangeChange}
        searchUserName={searchUserName}
        onSearchUserNameChange={handleSearchUserNameChange}
        botFilter={activeBotFilter}
        botOptions={botOptions}
        isBotsLoading={isBotsLoading}
        allBotsValue={ALL_BOTS}
        onBotFilterChange={handleBotFilterChange}
      />

      {/* 最慢Top10不需要无限滚动 */}
      {activeTab === 'slowest' ? (
        <MessageProcessingTable
          data={messages}
          loading={isLoading}
          onRowClick={(message: MessageRecord) => setSelectedMessageId(message.messageId || null)}
          variant={activeTab}
          resolveBotLabel={resolveBotLabel}
        />
      ) : (
        /* 实时列表使用无限滚动 */
        <InfiniteScroll
          dataLength={realtimeMessages.length}
          next={handleLoadMore}
          hasMore={hasMore}
          loader={
            isLoadingMore ? (
              <div
                style={{
                  padding: '24px 20px',
                  textAlign: 'center',
                  color: '#94a3b8',
                  fontSize: '13px',
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                }}
              >
                <span
                  style={{
                    display: 'inline-block',
                    width: '16px',
                    height: '16px',
                    border: '2px solid rgba(99, 102, 241, 0.15)',
                    borderTopColor: '#6366f1',
                    borderRadius: '50%',
                    animation: 'spin 0.6s linear infinite',
                  }}
                />
                加载更多...
              </div>
            ) : null
          }
          endMessage={
            realtimeMessages.length > 0 ? (
              <div
                style={{
                  padding: '24px 20px',
                  textAlign: 'center',
                  color: '#94a3b8',
                  fontSize: '13px',
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                }}
              >
                <span style={{ color: '#c7d2fe' }}>—</span>
                已加载全部 {stats.total} 条请求
                <span style={{ color: '#c7d2fe' }}>—</span>
              </div>
            ) : null
          }
        >
          <MessageProcessingTable
            data={messages}
            loading={isLoading}
            onRowClick={(message: MessageRecord) => setSelectedMessageId(message.messageId || null)}
            variant={activeTab}
            resolveBotLabel={resolveBotLabel}
          />
        </InfiniteScroll>
      )}

      {selectedMessageId && (
        <MessageProcessingDetailDrawer
          messageId={selectedMessageId}
          onClose={() => setSelectedMessageId(null)}
        />
      )}
    </div>
  );
}
