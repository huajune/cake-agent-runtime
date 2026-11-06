import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ReengagementDeliveryService } from '@agent/reengagement/follow-up.processor';
import { MessageDeliveryService } from '@wecom/message/delivery/delivery.service';
import { DurableReplyDeliveryService } from '@wecom/message/delivery/durable-reply-delivery.service';
import { TypingPolicyService } from '@wecom/message/delivery/typing-policy.service';
import { MessageSenderService } from '@wecom/message-sender/message-sender.service';
import { WecomMessageObservabilityService } from '@wecom/message/telemetry/wecom-message-observability.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { ActionPermitService } from '@biz/action-permit/services/action-permit.service';
import { ActionExecutorService } from '@biz/action-execution/action-executor.service';
import { ActionRecoveryRegistry } from '@biz/action-execution/action-recovery.registry';
import { ReplyTurnsRepository } from '@biz/reply-execution/reply-turns.repository';
import { ReplyTurnsService } from '@biz/reply-execution/reply-turns.service';

describe.each(['off', 'observe', 'execute'])(
  'independent proactive delivery with inbound mode %s',
  (mode) => {
    const context = {
      token: 'fixture-only',
      imBotId: 'bot',
      imContactId: 'candidate',
      imRoomId: '',
      chatId: 'chat',
      contactName: 'fixture',
      messageId: 'original-touch',
      externalRequestId: 'original-touch',
      // Old queue metadata must not become a new main-chat input or fail its cutover check.
      corpId: 'corp',
      logicalTurnId: 'old-anchor',
      inputOccurredAt: '2026-10-01T00:00:00Z',
    };

    async function fixture() {
      const sender = { sendMessage: jest.fn().mockResolvedValue({ errcode: 0 }) };
      const actions = {
        execute: jest.fn().mockRejectedValue(new Error('main action store unavailable')),
      };
      const turns = {
        transition: jest.fn().mockRejectedValue(new Error('main reply store unavailable')),
      };
      const permit = { evaluate: jest.fn().mockResolvedValue({ allowed: true }) };
      const module = await Test.createTestingModule({
        providers: [
          ReengagementDeliveryService,
          MessageDeliveryService,
          DurableReplyDeliveryService,
          ReplyTurnsService,
          ActionRecoveryRegistry,
          {
            provide: ConfigService,
            useValue: {
              get: (key: string) =>
                key === 'ACTION_EXECUTION_MODE'
                  ? mode
                  : key === 'ACTION_EXECUTION_CUTOVER_AT'
                    ? '2026-11-06T00:00:00Z'
                    : undefined,
            },
          },
          { provide: MessageSenderService, useValue: sender },
          { provide: ActionExecutorService, useValue: actions },
          { provide: ReplyTurnsRepository, useValue: turns },
          { provide: ActionPermitService, useValue: permit },
          { provide: MessageTrackingService, useValue: { recordReplySkipped: jest.fn() } },
          {
            provide: WecomMessageObservabilityService,
            useValue: { markFirstSegmentSent: jest.fn() },
          },
          {
            provide: TypingPolicyService,
            useValue: { shouldSplit: () => true, calculateDelay: () => 0 },
          },
        ],
      }).compile();
      return {
        module,
        service: module.get(ReengagementDeliveryService),
        sender,
        actions,
        turns,
        permit,
      };
    }

    it('sends both accepted segments without main-chat records or callbacks', async () => {
      const f = await fixture();
      try {
        const result = await f.service.deliver(
          { kind: 'reply', reply: { text: 'first\n\nsecond' }, toolCalls: [] },
          { context },
        );
        expect(result).toMatchObject({ success: true, deliveredSegments: 2 });
        expect(f.sender.sendMessage.mock.calls.map(([call]) => call.externalRequestId)).toEqual([
          'original-touch:segment:1',
          'original-touch:segment:2',
        ]);
        expect(f.actions.execute).not.toHaveBeenCalled();
        expect(f.turns.transition).not.toHaveBeenCalled();
      } finally {
        await f.module.close();
      }
    });

    it('stops on an ambiguous request without falling through to the main runtime', async () => {
      const f = await fixture();
      f.sender.sendMessage.mockRejectedValueOnce(new Error('provider timeout'));
      try {
        await expect(
          f.service.deliver(
            { kind: 'reply', reply: { text: 'first\n\nsecond' }, toolCalls: [] },
            { context },
          ),
        ).rejects.toThrow();
        expect(f.sender.sendMessage).toHaveBeenCalledTimes(1);
        expect(f.actions.execute).not.toHaveBeenCalled();
        expect(f.turns.transition).not.toHaveBeenCalled();
      } finally {
        await f.module.close();
      }
    });

    it('still obeys its current proactive permission', async () => {
      const f = await fixture();
      f.permit.evaluate.mockResolvedValue({ allowed: false });
      try {
        const result = await f.service.deliver(
          { kind: 'reply', reply: { text: 'reminder' }, toolCalls: [] },
          { context },
        );
        expect(result.skipped).toBe(true);
        expect(f.sender.sendMessage).not.toHaveBeenCalled();
        expect(f.turns.transition).not.toHaveBeenCalled();
      } finally {
        await f.module.close();
      }
    });
  },
);
