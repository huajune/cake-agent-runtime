/**
 * 记忆管理系统集成测试
 *
 * 向真实 Supabase (TEST 库) 和 Upstash Redis 写入测试数据，
 * 然后跑真实的 memory 管道，验证各层记忆是否正常工作。
 *
 * 用法：
 *   pnpm ts-node -r tsconfig-paths/register -P scripts/tsconfig.json scripts/test-memory-integration.ts
 *
 * 测试完成后会自动清理所有写入的测试数据。
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });

import { Redis } from '@upstash/redis';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStore } from '@memory/stores/supabase.store';
import { RedisStore } from '@memory/stores/redis.store';
import { LongTermService } from '@memory/services/long-term.service';
import { SettlementService } from '@memory/services/settlement.service';
import { ShortTermService } from '@memory/services/short-term.service';
import { SessionService } from '@memory/services/session.service';
import { FALLBACK_EXTRACTION } from '@memory/types/session-facts.types';

// ============================================================
// 环境 & 客户端初始化
// ============================================================

const ENV_PREFIX = `${process.env.RUNTIME_ENV ?? 'local'}:`;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const supabase: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ============================================================
// 测试命名空间（隔离，方便清理）
// ============================================================

const TEST_CORP = 'test-corp-memory-int';
const TEST_USER = `test-user-mem-${Date.now()}`;
// 实际系统中 chatId === sessionId（WeChat 会话 ID 即 chat_id）
const TEST_CHAT = `test-chat-mem-${Date.now()}`;
const TEST_SESSION = TEST_CHAT;

// ============================================================
// 最小 Shim（绕过 NestJS DI，直接接入真实 SDK）
// ============================================================

/** 模拟 SupabaseService */
const supabaseServiceShim = {
  getSupabaseClient: () => supabase,
  isClientInitialized: () => true,
};

/** 模拟 RedisService — 与生产代码一致，统一加 ENV_PREFIX */
const redisServiceShim = {
  async get<T>(key: string): Promise<T | null> {
    return redis.get<T>(ENV_PREFIX + key);
  },
  async set(key: string, value: unknown): Promise<void> {
    await redis.set(ENV_PREFIX + key, value);
  },
  async setex(key: string, seconds: number, value: unknown): Promise<void> {
    await redis.setex(ENV_PREFIX + key, seconds, value);
  },
  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return redis.del(...keys.map((k) => ENV_PREFIX + k));
  },
  async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
    return redis.lrange<T>(ENV_PREFIX + key, start, stop);
  },
  async rpush(key: string, ...values: unknown[]): Promise<number> {
    return redis.rpush(ENV_PREFIX + key, ...(values as string[]));
  },
  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await redis.ltrim(ENV_PREFIX + key, start, stop);
  },
  async expire(key: string, seconds: number): Promise<number> {
    return redis.expire(ENV_PREFIX + key, seconds);
  },
};

/** 模拟 MemoryConfig */
const memoryConfigShim = {
  sessionTtl: 86400,           // 1 天
  historyWindowSeconds: 7 * 86400,
  sessionWindowMaxMessages: 60,
  sessionWindowMaxChars: 8000,
  sessionExtractionIncrementalMessages: 10,
  longTermCacheTtl: 7200,
  get sessionTtlDays() { return 1; },
};

/** 模拟 ChatSessionService — 直接查 Supabase */
const chatSessionShim = {
  async getChatHistory(
    chatId: string,
    limit: number,
    options?: { startTimeInclusive?: number; endTimeInclusive?: number },
  ) {
    let query = supabase
      .from('chat_messages')
      .select('message_id,role,content,timestamp')
      .eq('chat_id', chatId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (options?.startTimeInclusive) {
      query = query.gte('timestamp', new Date(options.startTimeInclusive).toISOString());
    }
    if (options?.endTimeInclusive) {
      query = query.lte('timestamp', new Date(options.endTimeInclusive).toISOString());
    }

    const { data, error } = await query;
    if (error || !data) return [];

    return (data as Array<{ message_id: string; role: string; content: string; timestamp: string }>)
      .reverse()
      .map((m) => ({
        messageId: m.message_id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: new Date(m.timestamp).getTime(),
      }));
  },

  async getChatHistoryInRange(
    chatId: string,
    options: { startTimeExclusive?: number; endTimeInclusive?: number },
  ) {
    let query = supabase
      .from('chat_messages')
      .select('role,content,timestamp')
      .eq('chat_id', chatId)
      .order('timestamp');

    if (options.startTimeExclusive != null) {
      query = query.gt('timestamp', new Date(options.startTimeExclusive).toISOString());
    }
    if (options.endTimeInclusive != null) {
      query = query.lte('timestamp', new Date(options.endTimeInclusive).toISOString());
    }

    const { data, error } = await query;
    if (error || !data) return [];

    return (data as Array<{ role: string; content: string; timestamp: string }>).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      timestamp: new Date(m.timestamp).getTime(),
    }));
  },
};

/** 模拟 LlmExecutorService — 固定摘要，不消耗 token（验证数据流即可） */
const llmShim = {
  async generate(_opts: unknown) {
    return {
      text: '[测试摘要] 候选人询问餐饮兼职，Agent 推荐上海杨浦区海底捞服务员岗位，时薪22元，候选人表示感兴趣并留下联系方式。',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  },
  async generateStructured() {
    return { output: null };
  },
};

/** 模拟 SpongeService（SessionService 用到） */
const spongeShim = {
  async fetchBrandList() { return []; },
};

// ============================================================
// 实例化真实的 memory 服务
// ============================================================

const supabaseStore = new SupabaseStore(
  supabaseServiceShim as never,
  redisServiceShim as never,
  memoryConfigShim as never,
);

const redisStore = new RedisStore(redisServiceShim as never);

const longTermService = new LongTermService(supabaseStore);

const settlementService = new SettlementService(
  memoryConfigShim as never,
  longTermService,
  chatSessionShim as never,
  llmShim as never,
);

const shortTermService = new ShortTermService(
  chatSessionShim as never,
  memoryConfigShim as never,
  redisServiceShim as never,
);

const sessionService = new SessionService(
  redisStore,
  memoryConfigShim as never,
  llmShim as never,
  spongeShim as never,
);

// ============================================================
// 工具函数
// ============================================================

let passCount = 0;
let failCount = 0;
const failedTests: string[] = [];

function pass(label: string, detail?: string) {
  passCount++;
  console.log(`  ✅ ${label}${detail ? `  (${detail})` : ''}`);
}

function fail(label: string, detail?: string) {
  failCount++;
  failedTests.push(label);
  console.log(`  ❌ ${label}${detail ? `  (${detail})` : ''}`);
}

function check(label: string, condition: boolean, detail?: string) {
  condition ? pass(label, detail) : fail(label, detail);
}

function section(title: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(60)}`);
}

/** 向 chat_messages 写入一条记录 */
async function seedMessage(
  role: 'user' | 'assistant',
  content: string,
  timestampMs: number,
): Promise<string> {
  const messageId = `test-msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { error } = await supabase.from('chat_messages').insert({
    chat_id: TEST_CHAT,
    message_id: messageId,
    role,
    content,
    timestamp: new Date(timestampMs).toISOString(),
    org_id: TEST_CORP,
    bot_id: 'test-bot',
    is_room: false,
    message_type: 'TEXT',
    source: 'API_SEND',
    is_self: false,
  });
  if (error) throw new Error(`seedMessage 失败: ${error.message}`);
  return messageId;
}

/** 向 agent_memories 写入沉淀边界（lastSettledMessageAt） */
async function seedAgentMemoryBaseline(lastSettledMessageAt: string): Promise<void> {
  const existing = await supabase
    .from('agent_memories')
    .select('id')
    .eq('corp_id', TEST_CORP)
    .eq('user_id', TEST_USER)
    .maybeSingle();

  const summaryData = { recent: [], archive: null, lastSettledMessageAt };

  if (existing.data) {
    const { error } = await supabase
      .from('agent_memories')
      .update({ summary_data: summaryData, updated_at: new Date().toISOString() })
      .eq('id', existing.data.id);
    if (error) throw new Error(`更新 agent_memories 失败: ${error.message}`);
  } else {
    const { error } = await supabase.from('agent_memories').insert({
      corp_id: TEST_CORP,
      user_id: TEST_USER,
      summary_data: summaryData,
    });
    if (error) throw new Error(`插入 agent_memories 失败: ${error.message}`);
  }
}

/** 清理所有测试数据 */
async function cleanup(): Promise<void> {
  console.log('\n🧹 清理测试数据...');

  // 1. Supabase: chat_messages
  const { error: e1 } = await supabase
    .from('chat_messages')
    .delete()
    .eq('chat_id', TEST_CHAT);
  if (e1) console.warn('  ⚠️  清理 chat_messages 失败:', e1.message);
  else console.log('  ✓ chat_messages 已清理');

  // 2. Supabase: agent_memories
  const { error: e2 } = await supabase
    .from('agent_memories')
    .delete()
    .eq('corp_id', TEST_CORP)
    .eq('user_id', TEST_USER);
  if (e2) console.warn('  ⚠️  清理 agent_memories 失败:', e2.message);
  else console.log('  ✓ agent_memories 已清理');

  // 3. Redis: session facts
  const factsKey = `facts:${TEST_CORP}:${TEST_USER}:${TEST_SESSION}`;
  const profileCacheKey = `profile:${TEST_CORP}:${TEST_USER}`;
  const shortTermKey = `memory:short_term:chat:${TEST_CHAT}`;
  await redis.del(
    ENV_PREFIX + factsKey,
    ENV_PREFIX + profileCacheKey,
    ENV_PREFIX + shortTermKey,
  );
  console.log('  ✓ Redis 键已清理');
}

// ============================================================
// Scenario 1: Cold Start — 空用户首次读取
// ============================================================

async function scenario1_coldStart() {
  section('Scenario 1 — Cold Start（首次读取，无任何数据）');

  const profile = await longTermService.getProfile(TEST_CORP, TEST_USER);
  check('getProfile 返回 null（无画像）', profile === null);

  const messages = await shortTermService.getMessages(TEST_CHAT);
  check('getMessages 返回空数组（无历史）', messages.length === 0, `len=${messages.length}`);

  const state = await sessionService.getSessionState(TEST_CORP, TEST_USER, TEST_SESSION);
  check('getSessionState 返回空态', state.facts === null && state.presentedJobs === null);

  const summaryData = await longTermService.getSummaryData(TEST_CORP, TEST_USER);
  check('getSummaryData 返回 null（无摘要）', summaryData === null);
}

// ============================================================
// Scenario 2: Short-term Recall — 从 Supabase 回查历史
// ============================================================

async function scenario2_shortTermRecall() {
  section('Scenario 2 — Short-term Recall（Supabase 历史回查）');

  const now = Date.now();
  const msgs = [
    { role: 'user' as const, content: '你好，我想找餐饮兼职', ts: now - 5 * 60 * 1000 },
    { role: 'assistant' as const, content: '你好！我来帮你推荐合适的岗位。请问你在哪个城市？', ts: now - 4 * 60 * 1000 },
    { role: 'user' as const, content: '上海杨浦区', ts: now - 3 * 60 * 1000 },
    { role: 'assistant' as const, content: '好的，上海杨浦区有几个不错的选择，我来为你推荐…', ts: now - 2 * 60 * 1000 },
    { role: 'user' as const, content: '海底捞那个可以，怎么报名？', ts: now - 1 * 60 * 1000 },
  ];

  for (const m of msgs) {
    await seedMessage(m.role, m.content, m.ts);
  }
  console.log(`  📝 写入 ${msgs.length} 条测试消息`);

  // 清空 Redis 缓存，强制走 Supabase 路径
  await redis.del(ENV_PREFIX + `memory:short_term:chat:${TEST_CHAT}`);

  const result = await shortTermService.getMessages(TEST_CHAT);

  check(
    '返回正确消息数量',
    result.length === msgs.length,
    `got ${result.length}, want ${msgs.length}`,
  );
  check(
    '消息内容正确（第一条）',
    result[0]?.content?.includes('你好，我想找餐饮兼职') ?? false,
  );
  check(
    '时间上下文已注入',
    result[0]?.content?.includes('[消息发送时间') ?? false,
  );
  check(
    '消息按时间升序',
    (result[0]?.content ?? '').includes('你好') && (result[result.length - 1]?.content ?? '').includes('海底捞'),
  );
}

// ============================================================
// Scenario 3: Session Facts in Redis — 会话事实读取
// ============================================================

async function scenario3_sessionFacts() {
  section('Scenario 3 — Session Facts（Redis 会话事实读取）');

  // 直接写入 Redis，模拟前一个回合写入的 facts
  const factsKey = `facts:${TEST_CORP}:${TEST_USER}:${TEST_SESSION}`;
  const sessionEntry = {
    key: factsKey,
    content: {
      facts: {
        ...FALLBACK_EXTRACTION,
        interview_info: {
          ...FALLBACK_EXTRACTION.interview_info,
          name: '王小明',
          phone: '13800138000',
        },
        preferences: {
          ...FALLBACK_EXTRACTION.preferences,
          city: { value: '上海', confidence: 'high', evidence: 'municipality_compact' },
        },
      },
      lastCandidatePool: null,
      presentedJobs: null,
      currentFocusJob: null,
      invitedGroups: null,
    },
    updatedAt: new Date().toISOString(),
  };

  await redis.setex(ENV_PREFIX + factsKey, 86400, JSON.stringify(sessionEntry));
  console.log('  📝 写入 Redis session facts');

  const state = await sessionService.getSessionState(TEST_CORP, TEST_USER, TEST_SESSION);

  check(
    'facts 被正确读取',
    state.facts?.interview_info?.name === '王小明',
    `name=${state.facts?.interview_info?.name}`,
  );
  check(
    'phone 被正确读取',
    state.facts?.interview_info?.phone === '13800138000',
    `phone=${state.facts?.interview_info?.phone}`,
  );
  check(
    'city 被正确读取',
    state.facts?.preferences?.city?.value === '上海',
    `city=${state.facts?.preferences?.city?.value}`,
  );
}

// ============================================================
// Scenario 4: Booking Write — 报名路径写入画像
// ============================================================

async function scenario4_bookingWrite() {
  section('Scenario 4 — Booking Write（Path A 报名写入画像）');

  await longTermService.writeFromBooking(TEST_CORP, TEST_USER, {
    name: '李小花',
    phone: '13900139000',
    age: 20,
    gender: '女',
  });
  console.log('  📝 writeFromBooking 调用完成');

  // 读取 Supabase 验证
  const { data, error } = await supabase
    .from('agent_memories')
    .select('name,phone,age,gender,profile_fields_meta')
    .eq('corp_id', TEST_CORP)
    .eq('user_id', TEST_USER)
    .maybeSingle();

  if (error || !data) {
    fail('agent_memories 记录存在', `error: ${error?.message ?? 'not found'}`);
    return;
  }

  check('name 写入正确', data.name === '李小花', `got ${data.name}`);
  check('phone 写入正确', data.phone === '13900139000', `got ${data.phone}`);
  check('age 写入正确（string）', data.age === '20', `got ${data.age}`);
  check('gender 写入正确', data.gender === '女', `got ${data.gender}`);

  // 验证 profile_fields_meta
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = data.profile_fields_meta as any;
  check('profile_fields_meta 存在', meta != null);
  check('name meta.source = booking', meta?.name?.source === 'booking', `got ${meta?.name?.source}`);
  check('phone meta.confidence = high', meta?.phone?.confidence === 'high', `got ${meta?.phone?.confidence}`);
  check('age meta.writtenAt 有值', typeof meta?.age?.writtenAt === 'string');
  check('gender meta 存在', meta?.gender?.source === 'booking');

  // 通过 LongTermService 读取验证 Redis 失效 + Supabase 回查
  await redis.del(ENV_PREFIX + `profile:${TEST_CORP}:${TEST_USER}`); // 清 Redis 缓存
  const profile = await longTermService.getProfile(TEST_CORP, TEST_USER);

  check(
    'getProfile 返回正确名字',
    profile?.name === '李小花',
    `got ${profile?.name}`,
  );
  check(
    'getProfile 返回正确电话',
    profile?.phone === '13900139000',
    `got ${profile?.phone}`,
  );
}

// ============================================================
// Scenario 5: Settlement — detectAndSettle 跨会话沉淀
// ============================================================

async function scenario5_settlement() {
  section('Scenario 5 — Settlement（detectAndSettle 跨会话沉淀）');

  const now = Date.now();
  const SESSION_GAP_MS = memoryConfigShim.sessionTtl * 1000; // 1 天

  // 旧会话：3 天前（2 条消息）
  const oldT1 = now - 3 * 86400 * 1000;
  const oldT2 = oldT1 + 5 * 60 * 1000;
  // 新会话：昨天（1 条消息，与旧会话间隔 > 1 天）
  const newT1 = now - 1 * 86400 * 1000;

  await seedMessage('user', '我想找上海的餐厅兼职', oldT1);
  await seedMessage('assistant', '好的，我帮你查询上海的兼职岗位', oldT2);
  await seedMessage('user', '你好，我回来了，之前聊的那个海底捞还在招吗？', newT1);

  console.log(`  📝 写入 3 条跨会话消息（旧：${new Date(oldT1).toLocaleDateString()}，新：${new Date(newT1).toLocaleDateString()}）`);
  console.log(`  📝 间隔 ${((newT1 - oldT2) / 86400 / 1000).toFixed(1)} 天，sessionTtl = 1 天`);

  // 设置 lastSettledMessageAt = 旧会话开始之前（3.5 天前）
  const baseline = new Date(now - 3.5 * 86400 * 1000).toISOString();
  await seedAgentMemoryBaseline(baseline);
  console.log(`  📝 baseline lastSettledMessageAt = ${baseline}`);

  // 清 Redis 缓存避免 Supabase Store 读到旧数据
  await redis.del(ENV_PREFIX + `profile:${TEST_CORP}:${TEST_USER}`);

  const result = await settlementService.detectAndSettle(
    TEST_CORP,
    TEST_USER,
    TEST_SESSION,
    null,
  );

  check('detectAndSettle 返回 true（触发了沉淀）', result === true, `got ${result}`);

  // 验证 Supabase agent_memories 的 summary_data 已更新
  const { data } = await supabase
    .from('agent_memories')
    .select('summary_data')
    .eq('corp_id', TEST_CORP)
    .eq('user_id', TEST_USER)
    .maybeSingle();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summaryData = data?.summary_data as any;
  check('summary_data.recent 有新增摘要', (summaryData?.recent?.length ?? 0) >= 1);
  check(
    '摘要内容非空',
    typeof summaryData?.recent?.[0]?.summary === 'string' && summaryData.recent[0].summary.length > 0,
    `summary="${summaryData?.recent?.[0]?.summary?.slice(0, 30)}..."`,
  );
  check(
    'lastSettledMessageAt 已更新（比 baseline 更新）',
    summaryData?.lastSettledMessageAt > baseline,
    `old=${baseline.slice(0, 19)}, new=${summaryData?.lastSettledMessageAt?.slice(0, 19)}`,
  );

  // 验证沉淀边界：endTime 应该是旧会话的最后一条消息
  const endTime = summaryData?.recent?.[0]?.endTime;
  check(
    'endTime 指向旧会话末尾',
    endTime != null && new Date(endTime).getTime() <= oldT2 + 1000, // 允许 1s 误差
    `endTime=${endTime?.slice(0, 19)}`,
  );

  console.log(`\n  📋 生成的摘要: "${summaryData?.recent?.[0]?.summary}"`);
  console.log(`  📋 沉淀边界: ${summaryData?.lastSettledMessageAt?.slice(0, 19)}`);

  // 验证二次调用不触发（没有新的内部 gap）
  const secondResult = await settlementService.detectAndSettle(
    TEST_CORP,
    TEST_USER,
    TEST_SESSION,
    null,
  );
  check(
    '二次 detectAndSettle 不重复触发',
    secondResult === false,
    `got ${secondResult}（无新间隔，应跳过）`,
  );
}

// ============================================================
// Scenario 6: 逆向验证 — 沉淀后画像保留 booking 数据
// ============================================================

async function scenario6_profileRetainedAfterSettlement() {
  section('Scenario 6 — Profile Retention（沉淀不覆盖 booking 画像）');

  // 刚才 Scenario 4 已经写入了 booking profile，Scenario 5 做了 settlement
  // 验证 profile 字段没有被 settlement 覆盖
  await redis.del(ENV_PREFIX + `profile:${TEST_CORP}:${TEST_USER}`);
  const profile = await longTermService.getProfile(TEST_CORP, TEST_USER);

  check('booking 写入的 name 仍然存在', profile?.name === '李小花', `got ${profile?.name}`);
  check('booking 写入的 phone 仍然存在', profile?.phone === '13900139000', `got ${profile?.phone}`);

  // 验证 profile_fields_meta 也保留
  const { data } = await supabase
    .from('agent_memories')
    .select('profile_fields_meta')
    .eq('corp_id', TEST_CORP)
    .eq('user_id', TEST_USER)
    .maybeSingle();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = data?.profile_fields_meta as any;
  check(
    'profile_fields_meta.name.source = booking（沉淀后未被清除）',
    meta?.name?.source === 'booking',
    `got ${meta?.name?.source}`,
  );
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log('═'.repeat(60));
  console.log('  记忆管理系统集成测试');
  console.log(`  Supabase: ${process.env.NEXT_PUBLIC_SUPABASE_URL?.replace('https://', '')}`);
  console.log(`  Redis 前缀: "${ENV_PREFIX}"`);
  console.log(`  Test corp: ${TEST_CORP}`);
  console.log(`  Test user: ${TEST_USER}`);
  console.log('═'.repeat(60));

  // 连通性检查
  const ping = await redis.ping();
  console.log(`\n✓ Redis ping: ${ping}`);

  const { error: sbErr } = await supabase.from('agent_memories').select('id').limit(1);
  if (sbErr) {
    console.error('✗ Supabase 连接失败:', sbErr.message);
    process.exit(1);
  }
  console.log('✓ Supabase 连接正常');

  try {
    await scenario1_coldStart();
    await scenario2_shortTermRecall();
    await scenario3_sessionFacts();
    await scenario4_bookingWrite();
    await scenario5_settlement();
    await scenario6_profileRetainedAfterSettlement();
  } finally {
    await cleanup();
  }

  // ── 汇总报告
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  测试结果汇总`);
  console.log('═'.repeat(60));
  console.log(`  ✅ 通过: ${passCount}`);
  console.log(`  ❌ 失败: ${failCount}`);
  if (failedTests.length > 0) {
    console.log('\n  失败项目:');
    for (const t of failedTests) {
      console.log(`    - ${t}`);
    }
  }
  console.log('═'.repeat(60));

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 测试脚本异常退出:', err);
  process.exit(1);
});
