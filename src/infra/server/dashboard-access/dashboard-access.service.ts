import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlockList, isIP } from 'net';
import type { Request } from 'express';

export interface DashboardAccess {
  centerId: string | null;
  name: string;
}

function contains(addresses: BlockList, ip: string): boolean {
  const family = isIP(ip);
  return Boolean(family) && addresses.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** 总部与河南使用明确的来源白名单；未知来源不授予总部权限。 */
@Injectable()
export class DashboardAccessService {
  private readonly centerIps = new BlockList();
  private readonly headquartersIps = new BlockList();
  private readonly proxyIps = new BlockList();
  private readonly enabled: boolean;

  constructor(config: ConfigService) {
    const list = (key: string) =>
      config
        .get<string>(key, '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    const centers = list('HENAN_DASHBOARD_IPS');
    const headquarters = list('HEADQUARTERS_DASHBOARD_IPS');
    const proxies = list('DASHBOARD_TRUSTED_PROXY_IPS');
    this.enabled =
      config.get<string>('NODE_ENV') === 'production' || centers.length + headquarters.length > 0;
    for (const [ips, addresses] of [
      [centers, this.centerIps],
      [headquarters, this.headquartersIps],
      [proxies, this.proxyIps],
    ] as const) {
      for (const ip of ips) {
        const family = isIP(ip);
        if (!family)
          throw new Error('Dashboard IP 配置必须为单个 IPv4/IPv6 地址，不接受任意代理或网段');
        addresses.addAddress(ip, family === 4 ? 'ipv4' : 'ipv6');
      }
    }
    if (this.enabled && (!headquarters.length || !proxies.length)) {
      throw new Error('启用后台 IP 白名单必须配置总部 IP 和可信入口代理地址');
    }
  }

  resolve(request: Pick<Request, 'socket' | 'headers'>): DashboardAccess {
    if (!this.enabled) return { centerId: null, name: '总部' };
    const peer = request.socket.remoteAddress || '';
    const forwarded = request.headers['x-real-ip'];
    // Nginx 必须覆盖 X-Real-IP；绝不信任客户端的 X-Forwarded-For。
    const source = contains(this.proxyIps, peer)
      ? typeof forwarded === 'string' && isIP(forwarded)
        ? forwarded
        : null
      : peer;
    // 可信入口缺少合法来源时不能退回总部权限。
    if (source === null) return { centerId: 'denied', name: '无法识别访问来源' };
    if (contains(this.centerIps, source)) return { centerId: 'henan', name: '河南自招中心' };
    if (contains(this.headquartersIps, source)) return { centerId: null, name: '总部' };
    return { centerId: 'denied', name: '当前 IP 未获准访问运营后台' };
  }
}
