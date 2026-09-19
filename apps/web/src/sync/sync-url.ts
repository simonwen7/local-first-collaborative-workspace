export const DEFAULT_DEV_SYNC_URL = 'ws://127.0.0.1:3001/sync';

export class InvalidSyncUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSyncUrlError';
  }
}

export interface BrowserLocation {
  readonly protocol: string;
  readonly host: string;
}

export interface ResolveSyncUrlOptions {
  readonly configured?: string;
  readonly isDev?: boolean;
  readonly location?: BrowserLocation;
}

export function resolveSyncUrl(options: ResolveSyncUrlOptions = {}): string {
  const configured = options.configured ?? import.meta.env.VITE_SYNC_URL;
  const isDev = options.isDev ?? import.meta.env.DEV;

  if (typeof configured === 'string' && configured.trim().length > 0) {
    return validateConfiguredSyncUrl(configured.trim());
  }

  if (isDev) {
    return DEFAULT_DEV_SYNC_URL;
  }

  const location = options.location ?? getWindowLocation();

  if (location === undefined) {
    throw new InvalidSyncUrlError(
      'A production sync URL requires VITE_SYNC_URL or a same-origin browser location.',
    );
  }

  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/sync`;
}

function validateConfiguredSyncUrl(url: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidSyncUrlError(
      `VITE_SYNC_URL must be a valid ws: or wss: URL, received "${url}".`,
    );
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new InvalidSyncUrlError(
      `VITE_SYNC_URL must use ws: or wss:, received "${parsed.protocol}".`,
    );
  }

  return url;
}

function getWindowLocation(): BrowserLocation | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return {
    protocol: window.location.protocol,
    host: window.location.host,
  };
}
