import type { AgentEvent } from '../observer.interface';

export type AgentExecutionEvent = AgentEvent;

export interface AgentEventPersister {
  persist(event: AgentExecutionEvent): Promise<void>;
}

export const AGENT_EVENT_PERSISTER = Symbol('AGENT_EVENT_PERSISTER');
