export const SPONGE_TOKEN_CONFIG_KEY = 'sponge_token_config';

export type SpongeTokenValue =
  | string
  | {
      token?: string;
      tokenEnv?: string;
    };

export interface SpongeTokenAccountConfig {
  name?: string;
  groupId?: string;
  groupName?: string;
  botImId?: string;
  botUserId?: string;
  token?: string;
  tokenEnv?: string;
  enabled?: boolean;
}

export interface SpongeTokenConfig {
  accounts?: SpongeTokenAccountConfig[];
  byBotImId?: Record<string, SpongeTokenValue>;
  byBotUserId?: Record<string, SpongeTokenValue>;
  byGroupId?: Record<string, SpongeTokenValue>;
  defaultToken?: string;
  defaultTokenEnv?: string;
}

export interface SpongeTokenResolveContext {
  botImId?: string | null;
  botUserId?: string | null;
  groupId?: string | null;
}
