import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isIP } from 'net';
import type { Request } from 'express';

export interface DashboardAccess {
  centerId: string | null;
  name: string;
}

function normalizeIp(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  if (ip.includes('%')) return ''; // 不接受本机接口作用域地址。
  // IPv6 的压缩、大小写写法必须识别为同一地址。
  const canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  if (!canonical.startsWith('::ffff:')) return canonical;
  const words = canonical
    .slice(7)
    .split(':')
    .map((word) => parseInt(word, 16));
  if (words.length !== 2) return canonical;
  return [words[0] >> 8, words[0] & 255, words[1] >> 8, words[1] & 255].join('.');
}

/** 运营后台网络准入及中心范围；未列入总部/中心名单的来源默认拒绝。 */
@Injectable()
export class DashboardAccessService {
  private readonly headquartersIps: Set<string>;
  private readonly centerIps: Set<string>;
  private readonly proxyIps: Set<string>;

  constructor(config: ConfigService) {
    const list = (key: string) =>
      config
        .get<string>(key, '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    this.headquartersIps = new Set(list('HEADQUARTERS_DASHBOARD_IPS').map(normalizeIp));
    this.centerIps = new Set(list('HENAN_DASHBOARD_IPS').map(normalizeIp));
    this.proxyIps = new Set(list('DASHBOARD_TRUSTED_PROXY_IPS').map(normalizeIp));
    for (const ip of [...this.headquartersIps, ...this.centerIps, ...this.proxyIps]) {
      if (!isIP(ip))
        throw new Error('Dashboard IP 配置必须为单个 IPv4/IPv6 地址，不接受任意代理或网段');
    }
    if (this.centerIps.size && !this.proxyIps.size) {
      throw new Error('启用河南后台隔离必须配置可信入口代理地址');
    }
  }

  resolve(request: Pick<Request, 'socket' | 'headers'>): DashboardAccess {
    const peer = normalizeIp(request.socket.remoteAddress || '');
    const forwarded = request.headers['x-real-ip'];
    // Nginx 必须覆盖 X-Real-IP；绝不信任客户端的 X-Forwarded-For。
    const source = this.proxyIps.has(peer)
      ? typeof forwarded === 'string' && isIP(normalizeIp(forwarded))
        ? normalizeIp(forwarded)
        : null
      : peer;
    // 可信入口缺少合法来源时不能退回总部权限。
    if (!source || !isIP(source)) return { centerId: 'denied', name: '无法识别访问来源' };
    // 即使配置误重叠，也优先保留中心的较小权限范围。
    if (this.centerIps.has(source)) return { centerId: 'henan', name: '河南自招中心' };
    if (this.headquartersIps.has(source)) return { centerId: null, name: '总部' };
    return { centerId: 'denied', name: '无访问权限' };
  }
}
