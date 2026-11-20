export const STRIDE_PRIMARY_CONNECTION = 'stride-primary';

/** A symbol keeps this server-verified route outside the public callback JSON. */
export const VERIFIED_HOSTING_ROUTE = Symbol('verifiedHostingRoute');

export interface HostingRoute {
  connectionId: string;
  groupId?: string;
  /** Live verification can withhold a mismatched route but cannot date an old event. */
  observedGroupId?: string;
}
