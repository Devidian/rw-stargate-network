import { createHash } from 'node:crypto';

export const VERSION = 1;
export const MAX_PAYLOAD = 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;
export const RESERVATION_MS = 60_000;
export const TRANSFER_WINDOW_MS = 60_000;

export type Message = { v: number; type: string; requestId: string; networkCode?: string; payload: Record<string, unknown> };
export type WorldProfile = { [key: string]: string };
export const WORLD_KEYS = [
  'World_GameMode', 'World_OreAmount', 'Settings_BlueprintsRequireResources',
  'Settings_GameMode', 'Settings_OreSmeltingDurationFactor'
] as const;

export function stringValue(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('invalid_field');
  return value.trim();
}

export function parseMessage(raw: string): Message {
  if (Buffer.byteLength(raw) > MAX_PAYLOAD) throw new Error('payload_too_large');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_envelope');
  const input = value as Record<string, unknown>;
  if (input.v !== VERSION) throw new Error('unsupported_version');
  const type = stringValue(input.type, 40);
  const requestId = stringValue(input.requestId, 80);
  if (!/^[a-zA-Z0-9._:-]+$/.test(requestId)) throw new Error('invalid_request_id');
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new Error('invalid_payload');
  if (input.networkCode !== undefined) stringValue(input.networkCode, 128);
  return { v: VERSION, type, requestId, networkCode: input.networkCode as string | undefined,
    payload: input.payload as Record<string, unknown> };
}

export function canonicalCode(world: WorldProfile, plugins: string[], forbiddenActions: Record<string, boolean> = {}): string {
  const normalized: Record<string, string> = {};
  for (const key of WORLD_KEYS) normalized[key] = stringValue(world[key], 256);
  const sortedPlugins = plugins.map(value => stringValue(value, 256)).sort();
  const sortedActions: Record<string, boolean> = {};
  for (const key of Object.keys(forbiddenActions).sort()) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || typeof forbiddenActions[key] !== 'boolean') {
      throw new Error('invalid_forbidden_action');
    }
    sortedActions[key] = forbiddenActions[key];
  }
  return createHash('sha256').update(JSON.stringify({ world: normalized, plugins: sortedPlugins,
    forbiddenActions: sortedActions })).digest('hex').slice(0, 24);
}
