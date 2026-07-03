export const CHANNEL_DELIVERY_PORT = Symbol('CHANNEL_DELIVERY_PORT');

export interface ChannelDeliveryPort<TOutcome = unknown, TResult = unknown> {
  deliver(outcome: TOutcome, options?: { idempotencyKey?: string }): Promise<TResult>;
}
