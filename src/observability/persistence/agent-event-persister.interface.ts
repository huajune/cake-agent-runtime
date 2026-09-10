import type { AgentEvent } from '../observer.interface';

export interface AgentEventPersister {
  persist(event: AgentEvent): Promise<void>;
}

export const AGENT_EVENT_PERSISTER = Symbol('AGENT_EVENT_PERSISTER');
