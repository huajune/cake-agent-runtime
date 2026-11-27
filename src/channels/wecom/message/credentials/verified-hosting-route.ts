import { timingSafeEqual } from 'node:crypto';
import { WECOM_API_TYPE } from '@shared-types/wecom-api.types';
import type { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import type { GroupRouteCredentialsService } from './group-route-credentials.service';

export function hasEnterpriseCallbackCredential(
  message: EnterpriseMessageCallbackDto,
  expected?: string,
): boolean {
  if (
    message._apiType === WECOM_API_TYPE.GROUP ||
    !expected ||
    typeof message.token !== 'string' ||
    !message.token
  )
    return false;
  const secret = Buffer.from(expected);
  const supplied = Buffer.from(message.token);
  return secret.length === supplied.length && timingSafeEqual(secret, supplied);
}

export function verifyGroupCallback(
  message: EnterpriseMessageCallbackDto,
  credentials?: GroupRouteCredentialsService,
) {
  return credentials?.verifyCallback({
    token: message.token,
    accountId: message.imBotId,
    corpId: message.orgId,
    groupId: message.groupId,
    botId: message.botId,
  });
}
