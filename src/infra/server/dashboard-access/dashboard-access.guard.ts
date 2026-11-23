import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { CenterRoute } from './center-routes';

/** The center service checks the target organization after the route is admitted. */
export function authorizeCenterRequest(request: Request, route: CenterRoute | undefined): void {
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
