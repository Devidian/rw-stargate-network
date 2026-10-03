import { isIP } from 'node:net';

function publicIpv4(value: string | undefined): boolean {
  if (!value || isIP(value) !== 4) return false;
  const [first, second] = value.split('.').map(Number);
  return first > 0 && first < 224 && first !== 10 && first !== 127
    && !(first === 100 && second >= 64 && second <= 127)
    && !(first === 169 && second === 254)
    && !(first === 172 && second >= 16 && second <= 31)
    && !(first === 192 && second === 168);
}

/** The proxy overwrites X-Real-IP; shared Docker game clients need one host-level fallback. */
export function observedGameHost(realIp: string | undefined, localHost: string | undefined): string | null {
  if (realIp && publicIpv4(realIp)) return realIp;
  if (realIp?.startsWith('172.20.') && localHost && publicIpv4(localHost)) return localHost;
  return null;
}
