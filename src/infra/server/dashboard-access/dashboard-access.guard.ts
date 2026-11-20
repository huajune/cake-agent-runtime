import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { centerRoute } from './center-routes';

/** Regional staff use the same route policy. The center service checks their own organization's data. */
export function authorizeCenterRequest(request: Request): void {
  const route = centerRoute(request);
  if (route && request.method === 'GET') return;
  if (
    route === 'group-switch' &&
    request.is('application/json') &&
    request.headers['x-center-action'] === 'hosting'
  ) {
    try {
      const origin = new URL(request.headers.origin ?? '');
      if (['https:', 'http:'].includes(origin.protocol) && origin.host === request.headers.host)
        return;
    } catch {
      /* Unrecognized browser origin. */
    }
  }
  throw new ForbiddenException('当前组织无权访问此功能');
}
