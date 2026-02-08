import { asNumber } from './utils.js';
import type {
  SuplaAutodiscoverResponse,
  SuplaChannel,
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
}

const DEFAULT_API_PREFIX_CANDIDATES = ['/api/3', '/api/v3', '/api'];

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
    const payload = await this.requestUnknown('GET', `${this.apiPrefix}/channels`, {
      query: {
        include: 'state,connected,location,iodevice,supportedFunctions',
      },
      retryOnUnauthorized: true,
      includeAuth: true,
    });

    if (!Array.isArray(payload)) {
      throw new Error('Unexpected channels response from SUPLA cloud.');
    }

    const channels: SuplaChannel[] = [];

    for (const item of payload) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const rawId = asNumber((item as Record<string, unknown>).id);
      if (!rawId) {
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

  async executeChannelAction(channelId: number, payload: Record<string, unknown>): Promise<void> {
    await this.requestUnknown('PATCH', `${this.apiPrefix}/channels/${channelId}`, {
      body: payload,
      retryOnUnauthorized: true,
      includeAuth: true,
    });
  }

  private normalizeApiPrefix(prefix: string): string {
    if (!prefix.startsWith('/')) {
      return `/${prefix}`;
    }

    return prefix;
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

    const response = await this.performRequest(method, rawPath, options);

    if (response.status === 401 && options.includeAuth && options.retryOnUnauthorized) {
      await this.ensureAuthenticated(true);
      const retryResponse = await this.performRequest(method, rawPath, {
        ...options,
        retryOnUnauthorized: false,
      });
      return this.deserializeResponse(retryResponse, rawPath);
    }

    return this.deserializeResponse(response, rawPath);
  }

  private async performRequest(method: string, rawPath: string, options: RequestOptions): Promise<Response> {
    const url = this.buildUrl(rawPath, options.query);

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
      const text = await response.text();
      return text.trim();
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
