export type EvidenceProducer =
  | 'rule'
  | 'model'
  | 'confirmation_resolver'
  | 'human'
  | 'archive'
  | 'tool';

export type CollectedFieldProvenance =
  | 'user_text'
  | 'booking_writeback'
  | 'llm_extract'
  | 'model_arg';

/** 五套来源枚举的唯一互转表；unknown/system/memory 向 CollectedField 塌缩是显式有损。 */
export const SOURCE_INTEROP = {
  sessionToProducer: {
    candidate: 'rule',
    llm: 'model',
    rule: 'rule',
    system: 'tool',
    memory: 'archive',
    derived: 'rule',
    tool: 'tool',
  },
  producerToCollected: {
    rule: 'user_text',
    model: 'llm_extract',
    confirmation_resolver: 'user_text',
    human: 'booking_writeback',
    archive: 'llm_extract',
    tool: 'booking_writeback',
  },
} as const satisfies {
  sessionToProducer: Record<string, EvidenceProducer>;
  producerToCollected: Record<EvidenceProducer, CollectedFieldProvenance>;
};

export function toCollectedFieldProvenance(producer: EvidenceProducer): CollectedFieldProvenance {
  return SOURCE_INTEROP.producerToCollected[producer];
}
