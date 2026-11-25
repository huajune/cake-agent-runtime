import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { AgentRunnerService } from '@agent/runner/agent-runner.service';
import { TurnOutcomeInterventionService } from '@agent/runner/turn-outcome-intervention.service';
import { FollowUpSchedulerService } from '@agent/reengagement/follow-up-scheduler.service';
import { ReengagementAnchorService } from '@agent/reengagement/anchor.service';
import { OobReconcileService } from '@agent/reengagement/oob-reconcile.service';
import { ActionExecutorService } from '@biz/action-execution/action-executor.service';
import { ActionRecordsRepository } from '@biz/action-execution/action-records.repository';
import { ActionRecoveryService } from '@biz/action-execution/action-recovery.service';
import { ActionRecoveryRegistry } from '@biz/action-execution/action-recovery.registry';
import { ActionLocalSyncService } from '@biz/action-execution/action-local-sync.service';
import {
  ACTION_REPAIR_QUEUE,
  ActionRepairQueue,
  ActionRepairProcessor,
} from '@biz/action-execution/action-repair.queue';
import type { ActionRecord, ActionCompletion } from '@biz/action-execution/action-execution.types';
import { ActionPermitService } from '@biz/action-permit/services/action-permit.service';
import { ReplyTurnsService } from '@biz/reply-execution/reply-turns.service';
import { ReplyTurnsRepository } from '@biz/reply-execution/reply-turns.repository';
import { ReplyRecoveryLeaseService } from '@biz/reply-execution/reply-recovery-lease.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { RedisLeaseService } from '@infra/queue/redis-lease.service';
import { CronRunnerService } from '@infra/queue/cron-runner.service';
import { HttpService } from '@infra/client-http/http.service';
import { ApiConfigService } from '@infra/config/api-config.service';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { SessionStateService } from '@memory/short-term/session-state.service';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import { BotService } from '@channels/wecom/bot/bot.service';
import { MessageSenderService } from '@channels/wecom/message-sender/message-sender.service';
import { GroupRouteCredentialsService } from '@channels/wecom/message/credentials/group-route-credentials.service';
import { MessageService } from '@channels/wecom/message/message.service';
import { MessageIngressController } from '@channels/wecom/message/ingress/message-ingress.controller';
import { MessageCallbackAdapterService } from '@channels/wecom/message/ingress/callback-adapter.service';
import { MessagePipelineService } from '@channels/wecom/message/application/pipeline.service';
import { ReplyWorkflowService } from '@channels/wecom/message/application/reply-workflow.service';
import { MessageProcessingFailureService } from '@channels/wecom/message/application/message-processing-failure.service';
import { ImageDescriptionService } from '@channels/wecom/message/application/image-description.service';
import { ImageBrandBackfillService } from '@channels/wecom/message/application/image-brand-backfill.service';
import { MessageDeduplicationService } from '@channels/wecom/message/runtime/deduplication.service';
import { SimpleMergeService } from '@channels/wecom/message/runtime/simple-merge.service';
import { MessageRuntimeConfigService } from '@channels/wecom/message/runtime/message-runtime-config.service';
import { WecomMessageObservabilityService } from '@channels/wecom/message/telemetry/wecom-message-observability.service';
import { MessageDeliveryService } from '@channels/wecom/message/delivery/delivery.service';
import { DurableReplyDeliveryService } from '@channels/wecom/message/delivery/durable-reply-delivery.service';
import { ReplyRecoveryService } from '@channels/wecom/message/delivery/reply-recovery.service';
import { TypingPolicyService } from '@channels/wecom/message/delivery/typing-policy.service';
import type { EnterpriseMessageCallbackDto } from '@channels/wecom/message/ingress/message-callback.dto';
import { ContactType, MessageSource, MessageType } from '@enums/message-callback.enum';
import { RuntimePostgresClientFixture } from '../../../../helpers/runtime-postgres-client.fixture';

/**
 * Opt-in, local-only acceptance: actual Nest workflow, sender, ingress, recovery
 * and repository SQL. Provider HTTP, trusted directory, Redis lease/pending,
 * action-repair queue transport and model boundaries are simulated. API success
 * completes an ordinary reply; it does not claim message delivery or read status.
 *
 * Use a disposable database cloned from verify-runtime-postgres.py's schema:
 * CAKE_REPLY_TEST_CONTAINER=cake-runtime-pg-... CAKE_REPLY_TEST_DATABASE=cake_projection_reply_chain_app_...
 * pnpm exec jest --runInBand --watchman=false --runTestsByPath <this file>
 */
const container = process.env.CAKE_REPLY_TEST_CONTAINER;
const database = process.env.CAKE_REPLY_TEST_DATABASE;
const isolated = container && database ? describe : describe.skip;
const fixtureOrigin = 'https://runtime-fixture.invalid';
const enterpriseToken = 'fixture-enterprise-credential';
const accountId = 'fixture-account';
const groupId = 'fixture-group';
const botId = 'fixture-bot-id';
const chatId = 'fixture-chat';
const inboundId = 'fixture-input';
const newerInputId = 'fixture-later-input';
const parts = ['第一段验收文字', '第二段验收文字'];
type Route = 'enterprise' | 'group';
type SendCall = { url: string; body: Record<string, unknown> };

isolated('reply chain with actual PostgreSQL (simulated provider)', () => {
  let client: RuntimePostgresClientFixture;
  let module: TestingModule | undefined;
  let groupToken: string;
  let directoryGroupId: string;
  let sendCalls: SendCall[];
  let pending: Set<string>;
  let processCalls: Promise<void>[];
  let runInboundTurn: jest.Mock;
  let ackPendingMessageIds: jest.Mock;
  let markMessageAsProcessedAsync: jest.Mock;
  let repairJobs: Array<{ record: ActionRecord; completion: ActionCompletion<unknown> }>;
  let onSend: ((index: number) => Promise<void>) | undefined;

  beforeAll(() => {
    if (!database?.startsWith('cake_projection_reply_chain_app_'))
      throw new Error('Use a disposable reply_chain_app database, not the shared SQL fixture');
    client = new RuntimePostgresClientFixture(container!, database);
  });

  beforeEach(() => {
    // This database is explicitly disposable and separate from the SQL drill database.
    client.query('TRUNCATE public.agent_action_records, public.agent_reply_turns CASCADE;');
    groupToken = 'fixture-group-credential-v1';
    directoryGroupId = groupId;
    sendCalls = [];
    processCalls = [];
    pending = new Set([inboundId, newerInputId]);
    repairJobs = [];
    onSend = undefined;
    runInboundTurn = jest.fn().mockResolvedValue({
      kind: 'reply',
      reply: { text: parts.join('\n\n') },
      toolCalls: [],
    });
    ackPendingMessageIds = jest.fn(async (_chat: string, ids: string[]) => {
      ids.forEach((id) => pending.delete(id));
      return ids.length;
    });
    markMessageAsProcessedAsync = jest.fn().mockResolvedValue(true);
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe(fixtureOrigin);
      expect(url.pathname).toBe('/group-bots');
      expect(url.searchParams.get('token')).toBe(enterpriseToken);
      return new Response(
        JSON.stringify({
          errcode: 0,
          groups: [
            {
              id: directoryGroupId,
              token: groupToken,
              bots: [{ id: botId, wxid: accountId, corpId: 'fixture-corp' }],
            },
          ],
        }),
        { status: 200 },
      );
    });
  });

  afterEach(async () => {
    await module?.close();
    module = undefined;
    jest.restoreAllMocks();
  });

  async function start(mode: 'execute' | 'observe' = 'execute') {
    const config = {
      get: (key: string, fallback?: unknown) =>
        ({
          ACTION_EXECUTION_MODE: mode,
          ACTION_EXECUTION_CUTOVER_AT: new Date(Date.now() - 3600_000).toISOString(),
          STRIDE_ENTERPRISE_TOKEN: enterpriseToken,
        })[key] ?? fallback,
    };
    const observability = Object.fromEntries(
      [
        'hasTrace',
        'startRequestTrace',
        'mergePrepTimingsFromSources',
        'updateDispatch',
        'markWorkerStart',
        'markAiStart',
        'recordAgentRequest',
        'recordAgentResult',
        'updateRequestMessages',
        'markAiEnd',
        'markReplySkipped',
        'buildSuccessMetadata',
        'markDeliveryStart',
        'markDeliveryEnd',
        'markFirstSegmentSent',
      ].map((name) => [name, jest.fn().mockResolvedValue(undefined)]),
    );
    observability.buildMergedRequestContent = jest.fn().mockReturnValue('两条候选人消息');
    module = await Test.createTestingModule({
      controllers: [MessageIngressController],
      providers: [
        ActionExecutorService,
        ActionRecordsRepository,
        ActionRecoveryService,
        ActionRecoveryRegistry,
        ActionLocalSyncService,
        ActionRepairQueue,
        ActionRepairProcessor,
        ReplyTurnsService,
        ReplyTurnsRepository,
        ReplyRecoveryLeaseService,
        DurableReplyDeliveryService,
        MessageDeliveryService,
        MessageSenderService,
        ReplyRecoveryService,
        ReplyWorkflowService,
        MessageService,
        MessageCallbackAdapterService,
        GroupRouteCredentialsService,
        { provide: ConfigService, useValue: config },
        {
          provide: getQueueToken(ACTION_REPAIR_QUEUE),
          useValue: {
            add: jest.fn(async (_name: string, data: (typeof repairJobs)[number]) => {
              repairJobs.push(structuredClone(data));
              return { id: `repair-${repairJobs.length}` };
            }),
          },
        },
        { provide: SupabaseService, useValue: { getSupabaseClient: () => client } },
        {
          provide: ApiConfigService,
          useValue: {
            endpoints: {
              bot: { groupBots: () => `${fixtureOrigin}/group-bots` },
              message: {
                send: () => `${fixtureOrigin}/enterprise-send`,
                sendGroup: () => `${fixtureOrigin}/group-send`,
              },
            },
          },
        },
        {
          provide: HttpService,
          useValue: {
            post: jest.fn(async (url: string, body: Record<string, unknown>) => {
              expect(new URL(url).origin).toBe(fixtureOrigin);
              sendCalls.push({ url, body: structuredClone(body) });
              await onSend?.(sendCalls.length - 1);
              return { errcode: 0 };
            }),
          },
        },
        {
          provide: ActionPermitService,
          useValue: { evaluate: jest.fn().mockResolvedValue({ allowed: true }) },
        },
        { provide: AgentRunnerService, useValue: { runInboundTurn } },
        { provide: CronRunnerService, useValue: { runBatches: jest.fn() } },
        {
          provide: IncidentReporterService,
          useValue: { notifyAsync: jest.fn(), notify: jest.fn().mockResolvedValue(true) },
        },
        {
          provide: RedisLeaseService,
          useValue: {
            acquire: jest.fn().mockResolvedValue({ key: 'fixture-lease', token: 'fixture-owner' }),
            renew: jest.fn().mockResolvedValue(true),
            release: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: MessageDeduplicationService, useValue: { markMessageAsProcessedAsync } },
        { provide: SimpleMergeService, useValue: { addMessage: jest.fn(), ackPendingMessageIds } },
        {
          provide: MessagePipelineService,
          useValue: {
            execute: jest.fn(async (message: EnterpriseMessageCallbackDto) => ({
              shouldDispatch: !message.isSelf,
            })),
            processSingleMessage: (message: EnterpriseMessageCallbackDto) => {
              const call = workflow.processSingleMessage(message);
              processCalls.push(call);
              return call;
            },
          },
        },
        { provide: WecomMessageObservabilityService, useValue: observability },
        {
          provide: MessageTrackingService,
          useValue: { recordSuccess: jest.fn(), recordFailure: jest.fn() },
        },
        {
          provide: MessageRuntimeConfigService,
          useValue: {
            isAiReplyEnabled: () => true,
            isMessageMergeEnabled: () => false,
            getMergeDelayMs: () => 0,
            syncSnapshot: jest.fn().mockResolvedValue(undefined),
            resolveWecomChatModelSelection: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: TypingPolicyService,
          useValue: {
            shouldSplit: () => true,
            getSnapshot: () => ({ splitSend: true }),
            calculateDelay: () => 0,
          },
        },
        {
          provide: MessageProcessingFailureService,
          useValue: {
            inferErrorType: () => 'fixture-unexpected',
            handleProcessingError: jest.fn(),
            sendFallbackAlert: jest.fn(),
          },
        },
        { provide: ImageDescriptionService, useValue: {} },
        {
          provide: ImageBrandBackfillService,
          useValue: { detectMissingImages: () => [], scheduleBackfill: jest.fn() },
        },
        {
          provide: LlmExecutorService,
          useValue: { supportsVisionInput: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: BotService,
          useValue: { resolveBotUserIdByImBotId: jest.fn().mockResolvedValue('fixture-bot-user') },
        },
        {
          provide: OobReconcileService,
          useValue: { reconcileAfterTurn: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SessionStateService,
          useValue: { recordCandidateMessagesProcessed: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: AlertNotifierService, useValue: { sendSimpleAlert: jest.fn() } },
        {
          provide: TurnOutcomeInterventionService,
          useValue: { commit: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: OpsEventsRecorderService,
          useValue: {
            recordOpeningDurably: jest.fn().mockResolvedValue(true),
            recordEventDurably: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: FollowUpSchedulerService,
          useValue: { scheduleFollowUp: jest.fn().mockResolvedValue({ scheduled: true }) },
        },
        {
          provide: ReengagementAnchorService,
          useValue: {
            handleToolAnchors: jest.fn().mockResolvedValue(undefined),
            handleDeliveredReplyAnchors: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    const workflow = module.get(ReplyWorkflowService);
    await module.init();
    jest.spyOn(module.get(ActionRecoveryService), 'recoverDue');
    jest.spyOn(module.get(ReplyRecoveryService), 'recoverDue');
    return module;
  }

  function incoming(route: Route, overrides: Record<string, unknown> = {}) {
    const common = {
      token: route === 'group' ? groupToken : enterpriseToken,
      botId,
      chatId,
      messageId: inboundId,
      contactType: ContactType.PERSONAL_WECHAT,
      isSelf: false,
      timestamp: Date.now(),
      contactName: '隔离测试',
      payload: { text: '开始验收' },
    };
    return route === 'group'
      ? {
          data: {
            ...common,
            botWxid: accountId,
            contactId: 'fixture-contact',
            type: MessageType.TEXT,
            ...overrides,
          },
        }
      : {
          ...common,
          orgId: 'fixture-corp',
          imBotId: accountId,
          imContactId: 'fixture-contact',
          messageType: MessageType.TEXT,
          source: MessageSource.MOBILE_PUSH,
          ...overrides,
        };
  }

  function databaseState() {
    return client.query<{
      turn: {
        status: string;
        delivery_policy: string;
        projection_status: string;
        review_required: boolean;
        next_check_at: string | null;
        delivery_result: { outcome: string; accepted: number; total: number };
        recovery: Record<string, unknown>;
      };
      actions: Array<{
        status: string;
        local_sync: string;
        dispatch_attempt_id: string;
        request_id: string;
        result: unknown;
        evidence: ActionRecord['evidence'];
      }>;
      callbackEvidenceCount: number;
    }>(`SELECT json_build_object(
      'turn',(SELECT row_to_json(t) FROM (SELECT status,recovery,delivery_policy,delivery_result,projection_status,review_required,next_check_at FROM agent_reply_turns LIMIT 1) t),
      'actions',(SELECT coalesce(json_agg(a ORDER BY a.created_at),'[]'::json) FROM (SELECT status,local_sync,dispatch_attempt_id,request_id,result,evidence,created_at FROM agent_action_records) a),
      'callbackEvidenceCount',(SELECT count(*) FROM agent_action_evidence WHERE completion->'result'->>'stage'='delivery_callback'));`);
  }

  async function submitInput(route: Route) {
    const expected = processCalls.length + 1;
    await module!.get(MessageIngressController).receiveMessage(incoming(route));
    for (let tries = 0; tries < 10 && processCalls.length < expected; tries++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(processCalls).toHaveLength(expected);
    await processCalls[expected - 1];
  }

  async function restart(mode: 'execute' | 'observe') {
    await module!.close();
    module = undefined;
    await start(mode);
  }

  async function recoverStoredTurn() {
    // Make the isolated fixture immediately due rather than waiting for cron.
    client.query(
      "UPDATE agent_action_records SET next_check_at=now()-interval '1 second' WHERE mode='execute' AND (status IN ('executing','unknown') OR (status='succeeded' AND local_sync='pending')); UPDATE agent_reply_turns SET next_check_at=now()-interval '1 second' WHERE status IN ('planned','settled') AND next_check_at IS NOT NULL;",
    );
    await module!.get(ActionRecoveryService).recoverDue();
    await module!.get(ReplyRecoveryService).recoverDue();
  }

  function expireOwner() {
    client.query(
      "UPDATE agent_reply_turns SET generation_until=now()-interval '1 second',next_check_at=now()-interval '1 second' WHERE status IN ('preparing','planned');",
    );
  }

  // Stop the live workflow at a durable boundary. The restarted Nest module only
  // receives database state, current credentials and the original Redis input IDs.
  function interruptDelivery(attempted: number) {
    jest
      .spyOn(module!.get(MessageDeliveryService), 'deliverReply')
      .mockImplementationOnce(async (_reply, context) => {
        const turn = context.replyTurn!;
        if (attempted) {
          const sending = await module!.get(ReplyTurnsService).startDelivery(turn);
          for (let i = 0; i < attempted; i++) {
            await module!
              .get(DurableReplyDeliveryService)
              .sendOrdinarySegment(sending, context, turn.recovery.replySegments![i], i);
          }
        }
        throw new Error('fixture process stopped before recording a terminal delivery');
      });
  }

  function assertAcceptedTurn() {
    const state = databaseState();
    expect(state.turn.status).toBe('acked');
    expect(state.actions).toHaveLength(2);
    expect(state.actions.map((action) => [action.status, action.local_sync])).toEqual([
      ['succeeded', 'complete'],
      ['succeeded', 'complete'],
    ]);
    for (const action of state.actions) {
      expect(action.result).toEqual({ stage: 'accepted' });
      expect(action.evidence).toEqual({
        kind: 'accepted',
        requestTerminated: true,
        detail: 'send_api_accepted; not_delivery_or_read_receipt',
      });
    }
    expect(state.callbackEvidenceCount).toBe(0);
    expect(sendCalls.map((call) => call.body.externalRequestId)).toEqual(
      state.actions.map((action) => action.request_id),
    );
    expect(ackPendingMessageIds).toHaveBeenCalledWith(chatId, [inboundId]);
    expect(markMessageAsProcessedAsync).toHaveBeenCalledWith(inboundId);
    expect(markMessageAsProcessedAsync).not.toHaveBeenCalledWith(newerInputId);
    expect(pending).toEqual(new Set([newerInputId]));
    expect(runInboundTurn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state.turn)).not.toContain(enterpriseToken);
    expect(JSON.stringify(state.turn)).not.toContain(groupToken);
  }

  function interruptBeforeSecondAction() {
    const records = module!.get(ActionRecordsRepository);
    const prepare = records.prepare.bind(records);
    return jest.spyOn(records, 'prepare').mockImplementation(async (intent, mode) => {
      if (intent.parameters.index === 1) throw new Error('fixture database unavailable');
      return prepare(intent, mode);
    });
  }

  it.each<Route>(['enterprise', 'group'])(
    'completes both %s segments and ACKs after successful API responses without any callback',
    async (route) => {
      await start();
      await submitInput(route);
      expect(sendCalls).toHaveLength(2);
      expect(sendCalls.map((call) => (call.body.payload as { text: string }).text)).toEqual(parts);
      assertAcceptedTurn();
      expect(databaseState().turn).toMatchObject({
        delivery_policy: 'single_pass',
        delivery_result: { outcome: 'complete', accepted: 2, total: 2 },
      });
      expect(module!.get(ActionRecoveryService).recoverDue).not.toHaveBeenCalled();
      expect(module!.get(ReplyRecoveryService).recoverDue).not.toHaveBeenCalled();
      expect(repairJobs).toHaveLength(0);

      // Replay of the same durable input after rollback cannot repeat accepted sends.
      await restart('observe');
      await submitInput(route);
      expect(sendCalls).toHaveLength(2);
      assertAcceptedTurn();
    },
    30000,
  );

  it('retries an unconfirmed manual notification after restart without redispatching an unknown send', async () => {
    await start();
    onSend = async () => {
      throw new Error('simulated transport timeout');
    };
    await submitInput('enterprise');
    client.query(
      "UPDATE agent_action_records SET attempts=7,recovery_deadline=now()-interval '1 second',next_check_at=now()-interval '1 second';",
    );
    jest.spyOn(module!.get(IncidentReporterService), 'notify').mockResolvedValue(false);
    await module!.get(ActionRecoveryService).recoverDue();
    expect(
      client.query(
        "SELECT to_json(bool_and(status='unknown' AND next_check_at>now())) FROM agent_action_records;",
      ),
    ).toBe(true);
    expect(sendCalls).toHaveLength(1);
    await restart('observe');
    client.query("UPDATE agent_action_records SET next_check_at=now()-interval '1 second';");
    await module!.get(ActionRecoveryService).recoverDue();
    expect(
      client.query(
        "SELECT to_json(bool_and(status='unknown' AND review_required AND next_check_at IS NULL)) FROM agent_action_records;",
      ),
    ).toBe(true);
    expect(module!.get(IncidentReporterService).notify).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveLength(1);
    expect(ackPendingMessageIds).toHaveBeenCalledWith(chatId, [inboundId]);
  }, 30000);

  it('repairs an accepted API result after database write failures without sending either segment again', async () => {
    await start();
    jest
      .spyOn(module!.get(ActionRecordsRepository), 'settle')
      .mockRejectedValueOnce(new Error('fixture settlement write unavailable'))
      .mockRejectedValueOnce(new Error('fixture settlement write unavailable'));
    await submitInput('enterprise');
    expect(sendCalls).toHaveLength(2);
    expect(repairJobs).toHaveLength(1);
    expect(repairJobs[0].completion).toMatchObject({
      status: 'succeeded',
      result: { stage: 'accepted' },
      evidence: { kind: 'accepted', requestTerminated: true },
    });
    expect(databaseState().turn.status).toBe('acked');
    expect(ackPendingMessageIds).toHaveBeenCalledWith(chatId, [inboundId]);
    const attempt = databaseState().actions[0].dispatch_attempt_id;

    await restart('observe');
    await recoverStoredTurn();
    expect(sendCalls).toHaveLength(2);
    expect(ackPendingMessageIds).toHaveBeenCalledWith(chatId, [inboundId]);
    // Existing local-repair queue transport is simulated; its real processor writes
    // the accepted result even after the action's original ownership fence changed.
    await module!.get(ActionRepairProcessor).settle({ data: repairJobs[0] } as never);
    await recoverStoredTurn();
    expect(sendCalls).toHaveLength(2);
    expect(databaseState().actions[0].dispatch_attempt_id).toBe(attempt);
    assertAcceptedTurn();
  }, 30000);

  it('closes an unknown ordinary send, preserves evidence and admits the next user input', async () => {
    await start();
    onSend = async () => {
      throw new Error('simulated timeout');
    };
    await submitInput('enterprise');
    expect(sendCalls).toHaveLength(1);
    expect(databaseState().turn).toMatchObject({
      status: 'acked',
      delivery_result: { outcome: 'unknown' },
    });
    expect(databaseState().actions[0].status).toBe('unknown');
    onSend = undefined;
    await restart('observe');
    await recoverStoredTurn();
    await submitInput('enterprise');
    expect(sendCalls).toHaveLength(1);
    expect(runInboundTurn).toHaveBeenCalledTimes(1);
    await restart('execute');
    const next = await module!
      .get(ReplyTurnsService)
      .open(
        { corpId: 'fixture-corp', accountId, chatId },
        [newerInputId],
        new Date().toISOString(),
        { primary: { orgId: 'fixture-corp', imBotId: accountId, chatId } },
      );
    expect(next?.inputIds).toEqual([newerInputId]);
    expect(next?.logicalTurnId).not.toBeUndefined();
  }, 30000);

  it.each(['callback-first', 'acceptance-first'])(
    'retains both receipts and ACKs each accepted segment once with %s',
    async (ordering) => {
      await start();
      const callback = () =>
        module!.get(MessageIngressController).receiveMessage(
          incoming('enterprise', {
            isSelf: true,
            source: MessageSource.API_SEND,
            messageId: 'fixture-interleaved-callback',
            externalRequestId: sendCalls[0].body.externalRequestId,
            payload: { text: parts[0] },
          }),
        );
      if (ordering === 'callback-first') {
        onSend = async (index) => {
          if (index === 0) await callback();
        };
      }
      await submitInput('enterprise');
      if (ordering === 'acceptance-first') await callback();
      await callback();
      await restart('observe');
      await recoverStoredTurn();
      const state = databaseState();
      expect(state.turn).toMatchObject({
        status: 'acked',
        delivery_result: { accepted: 2, total: 2 },
      });
      expect(state.actions).toHaveLength(2);
      for (const action of state.actions) {
        expect(action).toMatchObject({
          status: 'succeeded',
          local_sync: 'complete',
          result: { stage: 'accepted' },
        });
      }
      expect(state.callbackEvidenceCount).toBe(1);
      expect(sendCalls).toHaveLength(2);
      expect(pending).toEqual(new Set([newerInputId]));
    },
    30000,
  );

  it('settles a manually parked unknown through an authenticated late callback without resending', async () => {
    await start();
    onSend = async () => {
      throw new Error('simulated timeout');
    };
    await submitInput('enterprise');
    const original = databaseState().actions[0];
    expect(original.status).toBe('unknown');
    expect(databaseState().turn.status).toBe('acked');
    client.query('UPDATE agent_action_records SET review_required=true,next_check_at=null;');
    await restart('observe');
    const callback = {
      isSelf: true,
      source: MessageSource.API_SEND,
      messageId: 'fixture-late-callback',
      externalRequestId: original.request_id,
      payload: { text: parts[0] },
    };
    await module!
      .get(MessageIngressController)
      .receiveMessage(incoming('enterprise', { ...callback, token: 'forged' }));
    expect(databaseState().callbackEvidenceCount).toBe(0);
    await module!.get(MessageIngressController).receiveMessage(incoming('enterprise', callback));
    await module!.get(MessageIngressController).receiveMessage(incoming('enterprise', callback));
    expect(databaseState().callbackEvidenceCount).toBe(1);
    expect(
      client.query(
        "SELECT to_json(attempt_id) FROM agent_action_evidence WHERE completion->'result'->>'stage'='delivery_callback' LIMIT 1;",
      ),
    ).toBe(original.dispatch_attempt_id);
    await module!.get(ActionRecoveryService).recoverDue();
    expect(databaseState().actions[0]).toMatchObject({
      status: 'succeeded',
      local_sync: 'complete',
      dispatch_attempt_id: original.dispatch_attempt_id,
    });
    expect(databaseState().turn.status).toBe('acked');
    expect(sendCalls).toHaveLength(1);
    expect(runInboundTurn).toHaveBeenCalledTimes(1);
    expect(pending).toEqual(new Set([newerInputId]));
  }, 30000);

  it('resumes the unsent suffix when the action store was unavailable before dispatch', async () => {
    await start();
    const failure = interruptBeforeSecondAction();
    await submitInput('enterprise');
    failure.mockRestore();
    expect(sendCalls).toHaveLength(1);
    expect(databaseState().turn).toMatchObject({
      status: 'planned',
      recovery: { replySegments: parts },
    });
    await restart('observe');
    expireOwner();
    await recoverStoredTurn();
    await submitInput('enterprise');
    expect(sendCalls).toHaveLength(2);
    assertAcceptedTurn();
  }, 30000);

  it.each([
    ['enterprise', 0],
    ['group', 1],
    ['enterprise', 2],
  ] as const)(
    'recovers %s after %i accepted segments with one provider request per original segment',
    async (route, accepted) => {
      await start();
      interruptDelivery(accepted);
      await submitInput(route);
      expect(sendCalls).toHaveLength(accepted);
      const firstRequests = sendCalls.map((call) => call.body.externalRequestId);
      expect(databaseState().turn.recovery.replySegments).toEqual(parts);
      expect(ackPendingMessageIds).not.toHaveBeenCalled();
      await restart('observe');
      groupToken = 'fixture-rotated-credential';
      expireOwner();
      await recoverStoredTurn();
      await recoverStoredTurn();
      await submitInput(route);
      expect(sendCalls.map((call) => (call.body.payload as { text: string }).text)).toEqual(parts);
      expect(sendCalls.slice(0, accepted).map((call) => call.body.externalRequestId)).toEqual(
        firstRequests,
      );
      expect(new Set(sendCalls.map((call) => call.body.externalRequestId)).size).toBe(parts.length);
      if (route === 'group')
        expect(sendCalls[1]).toMatchObject({
          url: fixtureOrigin + '/group-send',
          body: { token: groupToken },
        });
      assertAcceptedTurn();
      expect(databaseState().turn.recovery).not.toHaveProperty('replySegments');
    },
    30000,
  );

  it.each(['unknown', 'executing'])(
    'holds the suffix behind an %s request until its authenticated callback, then sends only the second segment',
    async (status) => {
      await start();
      interruptDelivery(1);
      if (status === 'unknown') {
        onSend = async () => {
          throw new Error('simulated missing provider response');
        };
      } else {
        // Stop after the provider accepted the request but before its local receipt was committed.
        jest
          .spyOn(module!.get(ActionRecordsRepository), 'settle')
          .mockRejectedValue(new Error('fixture process lost before receipt commit'));
      }
      await submitInput('enterprise');
      const requestId = sendCalls[0].body.externalRequestId;
      expect(databaseState().actions[0].status).toBe(status);
      onSend = undefined;
      await restart('execute');
      expireOwner();
      await recoverStoredTurn();
      expect(sendCalls).toHaveLength(1);
      expect(pending.has(inboundId)).toBe(true);
      expect(databaseState().turn.recovery.replySegments).toEqual(parts);
      await module!.get(MessageIngressController).receiveMessage(
        incoming('enterprise', {
          isSelf: true,
          source: MessageSource.API_SEND,
          messageId: 'fixture-recovered-callback',
          externalRequestId: requestId,
          payload: { text: parts[0] },
        }),
      );
      expireOwner();
      await recoverStoredTurn();
      expect(sendCalls.map((call) => (call.body.payload as { text: string }).text)).toEqual(parts);
      expect(sendCalls.filter((call) => call.body.externalRequestId === requestId)).toHaveLength(1);
      expect(databaseState().turn).toMatchObject({
        status: 'acked',
        delivery_result: { outcome: 'complete', accepted: 2, total: 2 },
      });
      expect(databaseState().callbackEvidenceCount).toBe(1);
      expect(runInboundTurn).toHaveBeenCalledTimes(1);
      expect(pending).toEqual(new Set([newerInputId]));
    },
    30000,
  );

  it('honors a hosting pause made during downtime before dispatching the suffix', async () => {
    await start();
    interruptDelivery(1);
    await submitInput('enterprise');
    await restart('execute');
    (module!.get(ActionPermitService).evaluate as jest.Mock).mockResolvedValue({
      allowed: false,
      reason: 'user_paused',
    });
    expireOwner();
    await recoverStoredTurn();
    expect(sendCalls).toHaveLength(1);
    expect(databaseState().turn).toMatchObject({
      status: 'acked',
      delivery_result: { outcome: 'skipped', accepted: 1, total: 2 },
    });
    expect(runInboundTurn).toHaveBeenCalledTimes(1);
  }, 30000);

  it('continues one merged reply and ACKs exactly the two original inputs after restarting', async () => {
    await start();
    const second = 'fixture-second-input';
    pending.add(second);
    interruptDelivery(1);
    const adapter = module!.get(MessageCallbackAdapterService);
    const batch = [inboundId, second].map((messageId) =>
      adapter.normalizeCallback(incoming('enterprise', { messageId })),
    );
    await module!.get(ReplyWorkflowService).processMergedMessages(batch, 'fixture-batch');
    expect(sendCalls).toHaveLength(1);
    await restart('execute');
    expireOwner();
    await recoverStoredTurn();
    await module!
      .get(MessageIngressController)
      .receiveMessage(incoming('enterprise', { messageId: second }));
    await Promise.all(processCalls);
    expect(sendCalls.map((call) => (call.body.payload as { text: string }).text)).toEqual(parts);
    expect(ackPendingMessageIds).toHaveBeenCalledWith(chatId, [inboundId, second]);
    expect(pending).toEqual(new Set([newerInputId]));
    expect(runInboundTurn).toHaveBeenCalledTimes(1);
  }, 30000);

  it('resumes through the original group only after credentials resolve for the original bot', async () => {
    await start();
    interruptDelivery(1);
    await submitInput('group');
    await restart('execute');
    directoryGroupId = 'different-group';
    expireOwner();
    await recoverStoredTurn();
    expect(sendCalls).toHaveLength(1);
    expect(pending.has(inboundId)).toBe(true);
    directoryGroupId = groupId;
    expireOwner();
    await recoverStoredTurn();
    assertAcceptedTurn();
  }, 30000);

  it('closes an accepted group reply even if the bot left its original group after both segments', async () => {
    await start();
    interruptDelivery(2);
    await submitInput('group');
    await restart('execute');
    directoryGroupId = 'different-group';
    expireOwner();
    await recoverStoredTurn();
    expect(sendCalls).toHaveLength(2);
    assertAcceptedTurn();
  }, 30000);

  it('completes the original promised handoff after recovery and retries its local commit without resending', async () => {
    await start();
    const intent = {
      kind: 'general_handoff',
      source: 'agent_tool',
      origin: 'promise_reconciliation',
      idempotencyKey: 'fixture-promise',
      reasonCode: 'other',
      reason: '已承诺人工跟进',
      alertLabel: '人工跟进',
      workOrderId: 123,
    };
    runInboundTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '会有同事跟进' },
      toolCalls: [],
      sideEffects: [{ ...intent, recentMessages: [{ content: 'fixture-private-history' }] }],
    });
    interruptDelivery(0);
    await submitInput('enterprise');
    expect(JSON.stringify(databaseState().turn.recovery)).not.toContain('fixture-private-history');
    await restart('execute');
    const commit = module!.get(TurnOutcomeInterventionService).commit as jest.Mock;
    commit.mockRejectedValueOnce(new Error('fixture intervention service unavailable'));
    expireOwner();
    await recoverStoredTurn();
    expect(databaseState().turn.status).toBe('settled');
    expect(sendCalls).toHaveLength(1);
    await recoverStoredTurn();
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reply', sideEffects: [expect.objectContaining(intent)] }),
      expect.objectContaining({ corpId: 'fixture-corp', chatId, userId: 'fixture-contact' }),
    );
    expect(databaseState().turn.status).toBe('acked');
    expect(databaseState().turn.recovery.effects).not.toHaveProperty('afterReply');
    expect(sendCalls).toHaveLength(1);
    expect(runInboundTurn).toHaveBeenCalledTimes(1);
  }, 30000);

  it('repairs only the original input ACK after a restart', async () => {
    await start();
    ackPendingMessageIds.mockRejectedValue(new Error('Redis ACK unavailable'));
    await submitInput('enterprise');
    expect(databaseState().turn).toMatchObject({ status: 'settled' });
    expect(sendCalls).toHaveLength(2);
    ackPendingMessageIds.mockImplementation(async (_chat: string, ids: string[]) => {
      ids.forEach((id) => pending.delete(id));
      return ids.length;
    });
    await restart('observe');
    await recoverStoredTurn();
    assertAcceptedTurn();
  }, 30000);

  it('closes a legacy live send with no persisted text after restart', async () => {
    await start();
    const turns = module!.get(ReplyTurnsService);
    const turn = await turns.open(
      { corpId: 'fixture-corp', accountId, chatId },
      [inboundId],
      new Date().toISOString(),
      {
        primary: {
          orgId: 'fixture-corp',
          imBotId: accountId,
          chatId,
          imContactId: 'fixture-contact',
          imRoomId: '',
        },
      },
    );
    // 真实工作流会在取得发送权前确认最小业务结局（空集合也须明确）。
    const checkpoint = await turns.saveEffects(turn!, {
      toolCalls: [],
      context: {
        traceId: turn!.logicalTurnId,
        logicalTurnId: turn!.logicalTurnId,
        inputOccurredAt: turn!.inputOccurredAt,
        corpId: 'fixture-corp',
        userId: 'fixture-contact',
        chatId,
        isGroupChat: false,
      },
    });
    await turns.completeProjection(checkpoint);
    const sending = await turns.startDelivery(checkpoint);
    await module!.get(DurableReplyDeliveryService).sendOrdinarySegment(
      sending,
      {
        replyTurn: sending,
        token: enterpriseToken,
        imBotId: accountId,
        imContactId: 'fixture-contact',
        imRoomId: '',
        chatId,
        messageId: inboundId,
        contactName: '隔离测试',
      },
      parts[0],
      0,
    );
    expect(databaseState().turn).not.toHaveProperty('plan');
    // Stop after one accepted API call, before any finish/ACK, as a killed worker would.
    await restart('observe');
    client.query("UPDATE agent_reply_turns SET generation_until=now()-interval '1 second';");
    await recoverStoredTurn();
    expect(sendCalls).toHaveLength(1);
    expect(runInboundTurn).not.toHaveBeenCalled();
    expect(databaseState().turn).toMatchObject({
      status: 'acked',
      delivery_result: { outcome: 'interrupted' },
    });
    expect(pending).toEqual(new Set([newerInputId]));
    await expect(
      module!.get(DurableReplyDeliveryService).sendOrdinarySegment(
        sending,
        {
          token: enterpriseToken,
          imBotId: accountId,
          imContactId: 'fixture-contact',
          imRoomId: '',
          chatId,
          messageId: inboundId,
          contactName: '隔离测试',
        },
        parts[1],
        1,
      ),
    ).rejects.toThrow();
    expect(sendCalls).toHaveLength(1);
  }, 30000);
  it('repairs booking follow-up admission after restart without repeating the model or booking', async () => {
    await start();
    runInboundTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '报名已提交' },
      toolCalls: [
        {
          toolName: 'duliday_interview_booking',
          args: { name: 'not-retained', phone: 'not-retained' },
          result: { success: true, workOrderId: 12345 },
        },
      ],
    });
    const anchors = module!.get(ReengagementAnchorService).handleToolAnchors as jest.Mock;
    anchors.mockRejectedValue(new Error('Redis admission unavailable'));
    await submitInput('enterprise');
    expect(sendCalls).toHaveLength(0);
    expect(databaseState().turn).toMatchObject({ status: 'preparing' });
    expect(JSON.stringify(databaseState().turn.recovery)).not.toContain('not-retained');
    expect(databaseState().turn.recovery.replySegments).toEqual(['报名已提交']);
    await restart('observe');
    expireOwner();
    await recoverStoredTurn();
    expect(module!.get(ReengagementAnchorService).handleToolAnchors).toHaveBeenCalledWith(
      {
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {},
            result: { success: true, workOrderId: 12345 },
          },
        ],
      },
      expect.objectContaining({
        logicalTurnId: expect.any(String),
        assertOwned: expect.any(Function),
      }),
    );
    expect(databaseState().turn.status).toBe('acked');
    expect(runInboundTurn).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveLength(1);
  }, 30000);

  it.each(['once', 'persistent'] as const)(
    'preserves successful booking effects when saving them fails %s',
    async (failure) => {
      await start();
      runInboundTurn.mockResolvedValue({
        kind: 'reply',
        reply: { text: '报名已提交' },
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {},
            result: { success: true, workOrderId: 12345 },
          },
        ],
      });
      const repository = module!.get(ReplyTurnsRepository);
      const transition = repository.transition.bind(repository);
      let failures = 0;
      jest.spyOn(repository, 'transition').mockImplementation(async (operation, input) => {
        if (operation === 'save_reply' && (failure === 'persistent' || failures++ === 0))
          throw new Error('RPC failed before commit');
        return transition(operation, input);
      });
      await submitInput('enterprise');
      expect(sendCalls).toHaveLength(0);
      if (failure === 'once') {
        expect(databaseState().turn.recovery.replySegments).toEqual(['报名已提交']);
        await restart('observe');
        expireOwner();
        await recoverStoredTurn();
        expect(databaseState().turn).toMatchObject({
          status: 'acked',
          projection_status: 'complete',
        });
        expect(module!.get(ReengagementAnchorService).handleToolAnchors).toHaveBeenCalledWith(
          {
            toolCalls: [
              {
                toolName: 'duliday_interview_booking',
                args: {},
                result: { success: true, workOrderId: 12345 },
              },
            ],
          },
          expect.objectContaining({ logicalTurnId: expect.any(String) }),
        );
      } else {
        expect(databaseState().turn).toMatchObject({
          status: 'preparing',
          projection_status: 'none',
        });
        expect(ackPendingMessageIds).not.toHaveBeenCalled();
        await restart('observe');
        client.query(
          "UPDATE agent_reply_turns SET generation_until=now()-interval '1 second',next_check_at=now()-interval '1 second';",
        );
        await recoverStoredTurn();
        expect(module!.get(IncidentReporterService).notify).toHaveBeenCalledWith(
          expect.objectContaining({
            code: 'reply.manual_review_required',
            error: expect.stringContaining('business_effects_unconfirmed'),
          }),
        );
        // 入站重试也不能把尚未确认的业务义务吞掉。
        await submitInput('enterprise');
        expect(databaseState().turn.status).not.toBe('acked');
        expect(pending.has(inboundId)).toBe(false);
        expect(pending.has(newerInputId)).toBe(true);
        expect(databaseState().turn).toMatchObject({
          status: 'settled',
          review_required: true,
          projection_status: 'none',
          next_check_at: null,
        });
        await recoverStoredTurn();
        expect(module!.get(IncidentReporterService).notify).toHaveBeenCalledTimes(1);
      }
      expect(runInboundTurn).toHaveBeenCalledTimes(1);
      expect(sendCalls).toHaveLength(failure === 'once' ? 1 : 0);
    },
    30000,
  );

  it('keeps an authenticated late booking result for projection without sending or re-running the turn', async () => {
    await start();
    runInboundTurn.mockImplementationOnce(async () => {
      client.query("UPDATE agent_reply_turns SET generation_until=now()-interval '1 second';");
      return {
        kind: 'reply',
        reply: { text: '报名已提交' },
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {},
            result: { success: true, workOrderId: 9876 },
          },
        ],
      };
    });
    await submitInput('enterprise');
    expect(databaseState().turn).toMatchObject({
      status: 'settled',
      projection_status: 'pending',
      delivery_result: { outcome: 'interrupted' },
    });
    await restart('observe');
    await recoverStoredTurn();
    expect(databaseState().turn).toMatchObject({
      status: 'acked',
      projection_status: 'complete',
      next_check_at: null,
    });
    expect(module!.get(ReengagementAnchorService).handleToolAnchors).toHaveBeenCalledWith(
      {
        toolCalls: [
          expect.objectContaining({
            toolName: 'duliday_interview_booking',
            result: { success: true, workOrderId: 9876 },
          }),
        ],
      },
      expect.any(Object),
    );
    expect(runInboundTurn).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveLength(0);
  }, 30000);

  it.each([false, true])(
    'classifies a provider outage using the live tool execution counter (toolStarted=%s)',
    async (toolStarted) => {
      await start();
      runInboundTurn.mockImplementationOnce(async (req) => {
        if (toolStarted) req.context.toolCallCounts.set('duliday_interview_booking', 1);
        throw Object.assign(new Error('model service unavailable'), {
          agentMeta: {
            providerOutage: true,
            modelsAttempted: ['qwen/qwen4-max', 'deepseek/deepseek-flash'],
          },
        });
      });
      await submitInput('enterprise');
      if (toolStarted) {
        expect(databaseState().turn).toMatchObject({
          status: 'preparing',
          projection_status: 'none',
        });
        expect(ackPendingMessageIds).not.toHaveBeenCalled();
      } else {
        expect(databaseState().turn).toMatchObject({
          status: 'acked',
          projection_status: 'complete',
          review_required: true,
          delivery_result: { accepted: 0, total: 0 },
        });
        await module!.get(ReplyRecoveryService).recoverDue();
        expect(module!.get(IncidentReporterService).notify).toHaveBeenCalledWith(
          expect.objectContaining({
            error: expect.stringContaining('model_unavailable_before_tools'),
          }),
        );
        expect(databaseState().turn.next_check_at).toBeNull();
      }
      expect(sendCalls).toHaveLength(0);
      expect(runInboundTurn).toHaveBeenCalledTimes(1);
    },
    30000,
  );

  it('retains an interrupted model turn for business review without retrying tools', async () => {
    await start();
    runInboundTurn.mockRejectedValue(new Error('model failed after a possible business tool'));
    await submitInput('enterprise');
    expect(databaseState().turn.status).toBe('preparing');
    expect(ackPendingMessageIds).not.toHaveBeenCalled();
    expect(sendCalls).toHaveLength(0);
    await restart('observe');
    client.query(
      "UPDATE agent_reply_turns SET generation_until=now()-interval '1 second',next_check_at=now()-interval '1 second';",
    );
    await recoverStoredTurn();
    expect(module!.get(IncidentReporterService).notify).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'reply.manual_review_required' }),
    );
    expect(runInboundTurn).toHaveBeenCalledTimes(1);
    expect(pending.has(inboundId)).toBe(true);
  }, 30000);

  it('retains accepted ordinary results through failed action writes and repairs them without resending', async () => {
    await start();
    jest
      .spyOn(module!.get(ActionRecordsRepository), 'settle')
      .mockRejectedValueOnce(new Error('database settlement unavailable'))
      .mockRejectedValueOnce(new Error('database settlement unavailable'));
    await submitInput('enterprise');
    expect(sendCalls).toHaveLength(2);
    expect(databaseState().turn.status).toBe('acked');
    expect(repairJobs).toHaveLength(1);
    await restart('observe');
    await module!.get(ActionRepairProcessor).settle({ data: repairJobs[0] } as never);
    await recoverStoredTurn();
    assertAcceptedTurn();
  }, 30000);
});
