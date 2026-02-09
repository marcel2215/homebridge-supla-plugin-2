import { asNumber } from './utils.js';
import type {
  SuplaAutodiscoverResponse,
  SuplaChannel,
  SuplaChannelState,
  SuplaTokenResponse,
} from './types.js';

export interface SuplaApiClientLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SuplaApiClientOptions {
  email: string;
  password: string;
  server?: string;
  requestTimeoutMs: number;
  apiPrefix?: string;
}

type QueryParams = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  retryOnUnauthorized?: boolean;
  includeAuth?: boolean;
  retryOnTransient?: boolean;
  maxRetries?: number;
}

export interface SuplaChannelStateSnapshot {
  id: number;
  connected?: boolean;
  state?: SuplaChannelState;
}

const DEFAULT_API_PREFIX_CANDIDATES = ['/api/3', '/api/v3', '/api'];
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_TRANSIENT_RETRY_COUNT = 2;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 15_000;
const ERROR_TEXT_MAX_LENGTH = 500;

export class SuplaApiClient {
  private baseUrl = '';
  private apiPrefix = '/api/3';

  private accessToken = '';
  private refreshToken = '';
  private accessTokenExpiresAt = 0;

  private authInFlight: Promise<void> | undefined;

  constructor(
    private readonly options: SuplaApiClientOptions,
    private readonly logger: SuplaApiClientLogger,
  ) {
    if (options.apiPrefix) {
      this.apiPrefix = this.normalizeApiPrefix(options.apiPrefix);
    }
  }

  async initialize(): Promise<void> {
    this.baseUrl = await this.resolveBaseUrl();
    await this.ensureAuthenticated(true);

    if (!this.options.apiPrefix) {
      this.apiPrefix = await this.resolveApiPrefix();
    }

    this.logger.debug(`SUPLA API connected via ${this.baseUrl}${this.apiPrefix}`);
  }

  async listChannels(): Promise<SuplaChannel[]> {
    let payload: unknown;
    try {
      payload = await this.requestUnknown('GET', `${this.apiPrefix}/channels`, {
        query: {
          include: 'state,connected,location,iodevice,supportedFunctions,possibleActions,config',
        },
        retryOnUnauthorized: true,
        includeAuth: true,
        retryOnTransient: true,
        maxRetries: 3,
      });
    } catch (error) {
      this.logger.warn(
        `SUPLA channels request with extended include failed, retrying without config include: ${this.errorMessage(error)}`,
      );
      try {
        payload = await this.requestUnknown('GET', `${this.apiPrefix}/channels`, {
          query: {
            include: 'state,connected,location,iodevice,supportedFunctions,possibleActions',
          },
          retryOnUnauthorized: true,
          includeAuth: true,
          retryOnTransient: true,
          maxRetries: 3,
        });
      } catch (fallbackError) {
        this.logger.warn(
          `SUPLA channels request with possibleActions include failed, retrying with minimal include: ${this.errorMessage(fallbackError)}`,
        );
        payload = await this.requestUnknown('GET', `${this.apiPrefix}/channels`, {
          query: {
            include: 'state,connected,location,iodevice,supportedFunctions',
          },
          retryOnUnauthorized: true,
          includeAuth: true,
          retryOnTransient: true,
          maxRetries: 3,
        });
      }
    }

    if (!Array.isArray(payload)) {
      throw new Error('Unexpected channels response from SUPLA cloud.');
    }

    const channels: SuplaChannel[] = [];

    for (const item of payload) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const rawId = asNumber((item as Record<string, unknown>).id);
      if (rawId === undefined) {
        continue;
      }

      const id = Math.trunc(rawId);
      channels.push({
        ...(item as SuplaChannel),
        id,
      });
    }

    return channels;
  }

  async listChannelStates(): Promise<SuplaChannelStateSnapshot[]> {
    const payload = await this.requestUnknown('GET', `${this.apiPrefix}/channels/states`, {
      retryOnUnauthorized: true,
      includeAuth: true,
      retryOnTransient: true,
      maxRetries: 3,
    });

    if (!Array.isArray(payload)) {
      throw new Error('Unexpected channel states response from SUPLA cloud.');
    }

    const snapshots: SuplaChannelStateSnapshot[] = [];
    for (const item of payload) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const record = item as Record<string, unknown>;
      const rawId = asNumber(record.id);
      if (rawId === undefined) {
        continue;
      }

      const id = Math.trunc(rawId);
      const state = record.state && typeof record.state === 'object'
        ? (record.state as SuplaChannelState)
        : undefined;

      snapshots.push({
        id,
        connected: typeof record.connected === 'boolean' ? record.connected : undefined,
        state,
      });
    }

    return snapshots;
  }

  async executeChannelAction(channelId: number, payload: Record<string, unknown>): Promise<void> {
    await this.requestUnknown('PATCH', `${this.apiPrefix}/channels/${channelId}`, {
      body: payload,
      retryOnUnauthorized: true,
      includeAuth: true,
      retryOnTransient: false,
      maxRetries: 0,
    });
  }

  private normalizeApiPrefix(prefix: string): string {
    const trimmed = prefix.trim();
    if (!trimmed) {
      return '/api/3';
    }

    const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    if (withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')) {
      return withLeadingSlash.slice(0, -1);
    }

    return withLeadingSlash;
  }

  private async resolveBaseUrl(): Promise<string> {
    if (this.options.server) {
      return this.normalizeServer(this.options.server);
    }

    const encodedEmail = encodeURIComponent(this.options.email);
    const url = `https://autodiscover.supla.org/users/${encodedEmail}`;

    const payload = await this.requestUnknown('GET', url, {
      retryOnUnauthorized: false,
      includeAuth: false,
      retryOnTransient: true,
      maxRetries: 3,
    });

    if (!payload || typeof payload !== 'object') {
      throw new Error('Autodiscover returned an invalid payload.');
    }

    const server = (payload as SuplaAutodiscoverResponse).server?.trim();
    if (!server) {
      throw new Error('Autodiscover did not return a server address.');
    }

    return this.normalizeServer(server);
  }

  private normalizeServer(server: string): string {
    const withProtocol = /^https?:\/\//i.test(server) ? server : `https://${server}`;
    const parsed = new URL(withProtocol);
    return parsed.origin;
  }

  private async resolveApiPrefix(): Promise<string> {
    const prefixes = [...DEFAULT_API_PREFIX_CANDIDATES];
    if (!prefixes.includes(this.apiPrefix)) {
      prefixes.unshift(this.apiPrefix);
    }

    let lastError: unknown = undefined;

    for (const prefix of prefixes) {
      try {
        const payload = await this.requestUnknown('GET', `${prefix}/channels`, {
          query: { include: 'state', io: 'output' },
          retryOnUnauthorized: true,
          includeAuth: true,
          retryOnTransient: true,
          maxRetries: 2,
        });

        if (Array.isArray(payload)) {
          return prefix;
        }

        lastError = new Error(`Unexpected payload for API prefix ${prefix}.`);
      } catch (error) {
        lastError = error;
      }
    }

    const message = lastError instanceof Error ? lastError.message : 'Unknown error';
    throw new Error(`Could not find a working SUPLA API version path: ${message}`);
  }

  private async ensureAuthenticated(force: boolean): Promise<void> {
    if (!force && this.isAccessTokenAlive()) {
      return;
    }

    if (!this.authInFlight) {
      this.authInFlight = this.authenticate(force)
        .finally(() => {
          this.authInFlight = undefined;
        });
    }

    await this.authInFlight;
  }

  private isAccessTokenAlive(): boolean {
    if (!this.accessToken) {
      return false;
    }

    return Date.now() + 30_000 < this.accessTokenExpiresAt;
  }

  private async authenticate(forcePasswordGrant: boolean): Promise<void> {
    if (!forcePasswordGrant && this.refreshToken) {
      try {
        await this.requestToken({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
        });

        return;
      } catch (error) {
        this.logger.warn(`SUPLA token refresh failed, falling back to password grant: ${this.errorMessage(error)}`);
      }
    }

    await this.requestToken({
      grant_type: 'password',
      username: this.options.email,
      password: this.options.password,
    });
  }

  private async requestToken(params: Record<string, string>): Promise<void> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      body.set(key, value);
    }

    const tokenPayload = await this.requestUnknown('POST', '/api/webapp-tokens', {
      body,
      includeAuth: false,
      retryOnUnauthorized: false,
      retryOnTransient: true,
      maxRetries: 2,
    });

    if (!tokenPayload || typeof tokenPayload !== 'object') {
      throw new Error('SUPLA cloud returned an invalid token payload.');
    }

    const token = tokenPayload as SuplaTokenResponse;
    if (!token.access_token) {
      const errorMessage = token.error_description || token.error || 'No access token returned.';
      throw new Error(`SUPLA token request failed: ${errorMessage}`);
    }

    this.accessToken = token.access_token;
    this.refreshToken = token.refresh_token || this.refreshToken;

    const expiresInSeconds = asNumber(token.expires_in) ?? 3600;
    this.accessTokenExpiresAt = Date.now() + Math.max(30, expiresInSeconds) * 1000;
  }

  private async requestUnknown(method: string, rawPath: string, options: RequestOptions): Promise<unknown> {
    if (options.includeAuth) {
      await this.ensureAuthenticated(false);
    }

    const url = this.buildUrl(rawPath, options.query);
    const response = await this.performRequestWithRetry(method, url, options);

    if (response.status === 401 && options.includeAuth && options.retryOnUnauthorized) {
      this.logger.warn(`SUPLA HTTP 401 for ${method} ${this.redactUrlForLog(url)}; forcing token refresh.`);
      await this.ensureAuthenticated(true);
      const retryResponse = await this.performRequestWithRetry(method, url, {
        ...options,
        retryOnUnauthorized: false,
        retryOnTransient: false,
        maxRetries: 0,
      });
      return this.deserializeResponse(retryResponse, rawPath);
    }

    return this.deserializeResponse(response, rawPath);
  }

  private async performRequestWithRetry(
    method: string,
    url: string,
    options: RequestOptions,
  ): Promise<Response> {
    const retries = Math.max(0, options.maxRetries ?? DEFAULT_TRANSIENT_RETRY_COUNT);
    const maxAttempts = options.retryOnTransient ? 1 + retries : 1;
    const redactedUrl = this.redactUrlForLog(url);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();
      try {
        const response = await this.performRequest(method, url, options);
        const durationMs = Date.now() - startedAt;
        this.logger.debug(
          `SUPLA HTTP ${method} ${redactedUrl} -> ${response.status} in ${durationMs}ms (attempt ${attempt}/${maxAttempts})`,
        );

        if (
          attempt < maxAttempts
          && this.shouldRetryStatus(response.status)
        ) {
          const delayMs = this.getRetryDelayMs(attempt, response);
          this.logger.warn(
            `SUPLA transient HTTP ${response.status} on ${method} ${redactedUrl}; retrying in ${delayMs}ms.`,
          );
          await this.delay(delayMs);
          continue;
        }

        return response;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const errorText = this.errorMessage(error);
        this.logger.warn(
          `SUPLA HTTP ${method} ${redactedUrl} failed in ${durationMs}ms (attempt ${attempt}/${maxAttempts}): ${errorText}`,
        );

        if (attempt < maxAttempts && this.shouldRetryError(error)) {
          const delayMs = this.getRetryDelayMs(attempt);
          await this.delay(delayMs);
          continue;
        }

        throw new Error(`SUPLA request failed on ${redactedUrl}: ${errorText}`);
      }
    }

    throw new Error(`SUPLA request failed on ${redactedUrl}: exhausted retries.`);
  }

  private async performRequest(method: string, url: string, options: RequestOptions): Promise<Response> {
    const headers = new Headers();
    if (options.includeAuth) {
      headers.set('Authorization', `Bearer ${this.accessToken}`);
    }

    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      if (options.body instanceof URLSearchParams) {
        headers.set('Content-Type', 'application/x-www-form-urlencoded');
        body = options.body;
      } else {
        headers.set('Content-Type', 'application/json');
        body = JSON.stringify(options.body);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.options.requestTimeoutMs);

    try {
      return await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(rawPath: string, query: QueryParams | undefined): string {
    const path = rawPath.startsWith('http://') || rawPath.startsWith('https://')
      ? rawPath
      : `${this.baseUrl}${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`;

    const url = new URL(path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) {
          continue;
        }

        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  private shouldRetryStatus(status: number): boolean {
    return TRANSIENT_HTTP_STATUSES.has(status);
  }

  private shouldRetryError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return true;
    }

    if (error instanceof TypeError) {
      return true;
    }

    const message = this.errorMessage(error).toLowerCase();
    return message.includes('network')
      || message.includes('timeout')
      || message.includes('abort');
  }

  private getRetryDelayMs(attempt: number, response?: Response): number {
    const retryAfterMs = this.getRetryAfterMs(response);
    if (retryAfterMs !== undefined) {
      return retryAfterMs;
    }

    const exponentialDelay = BASE_RETRY_DELAY_MS * (2 ** Math.max(0, attempt - 1));
    return Math.min(exponentialDelay, MAX_RETRY_DELAY_MS);
  }

  private getRetryAfterMs(response: Response | undefined): number | undefined {
    if (!response) {
      return undefined;
    }

    const header = response.headers.get('retry-after');
    if (!header) {
      return undefined;
    }

    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }

    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_DELAY_MS);
    }

    return undefined;
  }

  private redactUrlForLog(rawUrl: string): string {
    try {
      const parsed = new URL(rawUrl);
      const pathParts = parsed.pathname.split('/');
      const usersIndex = pathParts.findIndex((part) => part === 'users');
      if (usersIndex >= 0 && usersIndex + 1 < pathParts.length) {
        pathParts[usersIndex + 1] = '***';
      }
      parsed.pathname = pathParts.join('/');
      parsed.search = '';
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
    });
  }

  private async deserializeResponse(response: Response, path: string): Promise<unknown> {
    if (!response.ok) {
      const bodyText = await this.safeReadResponse(response);
      const message = `SUPLA request failed (${response.status}) on ${path}${bodyText ? `: ${bodyText}` : ''}`;
      throw new Error(message);
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`SUPLA returned non-JSON payload on ${path}.`);
    }
  }

  private async safeReadResponse(response: Response): Promise<string> {
    try {
      const text = (await response.text()).trim().replace(/\s+/g, ' ');
      if (!text) {
        return '';
      }

      if (text.length > ERROR_TEXT_MAX_LENGTH) {
        return `${text.slice(0, ERROR_TEXT_MAX_LENGTH)}...`;
      }

      return text;
    } catch {
      return '';
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
