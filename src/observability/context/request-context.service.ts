import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentEventContext } from '../observer.interface';

export type RequestContext = Omit<AgentEventContext, 'timestamp'>;

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  run<T>(context: RequestContext, callback: () => T): T {
    const existing = this.get();
    return this.storage.run({ ...existing, ...this.compact(context) }, callback);
  }

  get(): RequestContext {
    return this.storage.getStore() ?? {};
  }

  private compact(context: RequestContext): RequestContext {
    return Object.fromEntries(
      Object.entries(context).filter(([, value]) => value !== undefined && value !== ''),
    ) as RequestContext;
  }
}
