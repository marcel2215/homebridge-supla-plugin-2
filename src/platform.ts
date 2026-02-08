import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { mapFunctionToServiceKind } from './constants.js';
import { SuplaApiClient, type SuplaApiClientOptions } from './suplaApiClient.js';
import { SuplaChannelAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import {
  getChannelDisplayName,
  getChannelFunctionId,
  type SuplaAccessoryContext,
  type SuplaChannel,
} from './types.js';

interface SuplaPlatformConfig extends PlatformConfig {
  email?: string;
  password?: string;
  server?: string;
  apiPrefix?: string;
  pollIntervalSeconds?: number;
  requestTimeoutMs?: number;
  includeHidden?: boolean;
}

interface SyncSummary {
  total: number;
  visible: number;
  mapped: number;
  unsupported: number;
  added: number;
  updated: number;
  removed: number;
}

const DEFAULT_POLL_INTERVAL_SECONDS = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const INITIALIZATION_RETRY_DELAYS_SECONDS = [5, 10, 20, 40, 60, 120];
const REFRESH_FAILURES_BEFORE_RECOVERY = 3;

export class SuplaHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory<SuplaAccessoryContext>> = new Map();

  private readonly channelHandlers: Map<string, SuplaChannelAccessory> = new Map();
  private readonly unsupportedFunctionsLogged: Set<number> = new Set();

  private pollTimer: NodeJS.Timeout | undefined;
  private startupRetryTimer: NodeJS.Timeout | undefined;
  private pollInFlight = false;
  private shuttingDown = false;
  private recoveryInFlight = false;
  private startupRetryAttempt = 0;
  private refreshFailureStreak = 0;

  private client: SuplaApiClient | undefined;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.api.on('didFinishLaunching', () => {
      void this.start();
    });

    this.api.on('shutdown', () => {
      this.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory as PlatformAccessory<SuplaAccessoryContext>);
  }

  async executeChannelAction(channelId: number, payload: Record<string, unknown>): Promise<void> {
    if (!this.client) {
      throw new Error('SUPLA client is not initialized.');
    }

    await this.client.executeChannelAction(channelId, payload);
  }

  private async start(): Promise<void> {
    this.shuttingDown = false;
    const pluginConfig = this.getTypedConfig();

    if (!pluginConfig.email || !pluginConfig.password) {
      this.log.error('SUPLA plugin requires both email and password in config.');
      return;
    }

    const pollIntervalSeconds = this.getPollIntervalSeconds(pluginConfig);
    const requestTimeoutMs = this.getRequestTimeoutMs(pluginConfig);
    this.log.info(
      `Starting SUPLA platform for ${this.maskEmail(pluginConfig.email)} (poll=${pollIntervalSeconds}s, timeout=${requestTimeoutMs}ms).`,
    );

    const initialized = await this.initializeClient(pluginConfig);
    if (!initialized) {
      return;
    }

    await this.refreshChannels();
    this.startPolling(pollIntervalSeconds);
  }

  private stop(): void {
    this.shuttingDown = true;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.startupRetryTimer) {
      clearTimeout(this.startupRetryTimer);
      this.startupRetryTimer = undefined;
    }

    for (const handler of this.channelHandlers.values()) {
      handler.dispose();
    }

    this.channelHandlers.clear();
    this.log.info('SUPLA platform stopped.');
  }

  private startPolling(intervalSeconds: number): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(() => {
      void this.refreshChannels();
    }, intervalSeconds * 1000);

    this.pollTimer.unref();
    this.log.info(`SUPLA polling started (every ${intervalSeconds}s).`);
  }

  private async initializeClient(config: SuplaPlatformConfig): Promise<boolean> {
    this.client = new SuplaApiClient(this.buildClientOptions(config), {
      debug: (message: string) => this.log.debug(message),
      warn: (message: string) => this.log.warn(message),
      error: (message: string) => this.log.error(message),
    });

    try {
      await this.client.initialize();
      this.startupRetryAttempt = 0;
      this.clearStartupRetryTimer();
      this.log.info('SUPLA cloud connection established.');
      return true;
    } catch (error) {
      this.log.error(`SUPLA initialization failed: ${this.errorMessage(error)}`);
      this.markAllAccessoriesReachability(false);
      this.scheduleStartupRetry();
      return false;
    }
  }

  private buildClientOptions(config: SuplaPlatformConfig): SuplaApiClientOptions {
    return {
      email: config.email!,
      password: config.password!,
      server: config.server,
      apiPrefix: config.apiPrefix,
      requestTimeoutMs: this.getRequestTimeoutMs(config),
    };
  }

  private scheduleStartupRetry(): void {
    if (this.shuttingDown || this.startupRetryTimer) {
      return;
    }

    const delaySeconds = INITIALIZATION_RETRY_DELAYS_SECONDS[
      Math.min(this.startupRetryAttempt, INITIALIZATION_RETRY_DELAYS_SECONDS.length - 1)
    ];
    this.startupRetryAttempt += 1;

    this.log.warn(`Scheduling SUPLA reconnection in ${delaySeconds}s (attempt ${this.startupRetryAttempt}).`);
    this.startupRetryTimer = setTimeout(() => {
      this.startupRetryTimer = undefined;
      if (this.shuttingDown) {
        return;
      }

      void this.retryStartup();
    }, delaySeconds * 1000);
    this.startupRetryTimer.unref();
  }

  private clearStartupRetryTimer(): void {
    if (this.startupRetryTimer) {
      clearTimeout(this.startupRetryTimer);
      this.startupRetryTimer = undefined;
    }
  }

  private async retryStartup(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    const config = this.getTypedConfig();
    const initialized = await this.initializeClient(config);
    if (!initialized) {
      return;
    }

    await this.refreshChannels();
    this.startPolling(this.getPollIntervalSeconds(config));
  }

  private async refreshChannels(): Promise<void> {
    if (this.pollInFlight || !this.client || this.shuttingDown) {
      return;
    }

    this.pollInFlight = true;
    const startedAt = Date.now();
    let shouldRecover = false;

    try {
      const channels = await this.client.listChannels();
      const durationMs = Date.now() - startedAt;

      if (this.refreshFailureStreak > 0) {
        this.log.warn(`SUPLA refresh recovered after ${this.refreshFailureStreak} consecutive failures.`);
      }

      this.refreshFailureStreak = 0;
      this.syncAccessories(channels);
      this.log.debug(`SUPLA refresh success (${channels.length} channels in ${durationMs}ms).`);
    } catch (error) {
      this.refreshFailureStreak += 1;
      shouldRecover = this.refreshFailureStreak >= REFRESH_FAILURES_BEFORE_RECOVERY;
      this.markAllAccessoriesReachability(false);
      this.log.error(
        `SUPLA refresh failed (consecutive=${this.refreshFailureStreak}): ${this.errorMessage(error)}`,
      );
    } finally {
      this.pollInFlight = false;
    }

    if (shouldRecover) {
      void this.recoverClient();
    }
  }

  private async recoverClient(): Promise<void> {
    if (this.recoveryInFlight || this.shuttingDown) {
      return;
    }

    if (this.startupRetryTimer) {
      this.log.debug('SUPLA recovery skipped because a reconnect attempt is already scheduled.');
      return;
    }

    this.recoveryInFlight = true;
    this.log.warn(
      `Attempting SUPLA client recovery after ${this.refreshFailureStreak} consecutive refresh failures.`,
    );

    try {
      const config = this.getTypedConfig();
      const initialized = await this.initializeClient(config);
      if (!initialized) {
        return;
      }

      await this.refreshChannels();
    } finally {
      this.recoveryInFlight = false;
    }
  }

  private markAllAccessoriesReachability(reachable: boolean): void {
    for (const handler of this.channelHandlers.values()) {
      handler.setCloudReachability(reachable);
    }
  }

  private syncAccessories(channels: SuplaChannel[]): void {
    const visibleChannels = channels.filter((channel) => this.shouldExposeChannel(channel));
    const activeUuids = new Set<string>();
    const summary: SyncSummary = {
      total: channels.length,
      visible: visibleChannels.length,
      mapped: 0,
      unsupported: 0,
      added: 0,
      updated: 0,
      removed: 0,
    };

    for (const channel of visibleChannels) {
      const functionId = getChannelFunctionId(channel);
      const serviceKind = mapFunctionToServiceKind(functionId);

      if (!serviceKind) {
        summary.unsupported += 1;
        this.logUnsupportedFunction(functionId, channel.id);
        continue;
      }
      summary.mapped += 1;

      const uniqueId = `supla-channel-${channel.id}`;
      const uuid = this.api.hap.uuid.generate(uniqueId);
      activeUuids.add(uuid);

      const displayName = getChannelDisplayName(channel);
      let accessory = this.accessories.get(uuid);
      const isNewAccessory = !accessory;

      if (!accessory) {
        accessory = new this.api.platformAccessory<SuplaAccessoryContext>(displayName, uuid);
      }

      const context: SuplaAccessoryContext = {
        channelId: channel.id,
        functionId,
        serviceKind,
        uniqueId,
      };
      let needsAccessoryUpdate = false;
      const previousContext = accessory.context;
      if (
        previousContext?.channelId !== context.channelId
        || previousContext?.functionId !== context.functionId
        || previousContext?.serviceKind !== context.serviceKind
        || previousContext?.uniqueId !== context.uniqueId
      ) {
        needsAccessoryUpdate = true;
      }
      accessory.context = context;

      if (accessory.displayName !== displayName) {
        accessory.displayName = displayName;
        needsAccessoryUpdate = true;
      }

      const currentHandler = this.channelHandlers.get(uuid);
      if (!currentHandler || currentHandler.serviceKind !== serviceKind) {
        currentHandler?.dispose();
        const nextHandler = new SuplaChannelAccessory(this, accessory, channel, serviceKind);
        this.channelHandlers.set(uuid, nextHandler);
        needsAccessoryUpdate = true;
      } else {
        currentHandler.updateFromChannel(channel);
      }

      this.accessories.set(uuid, accessory);

      if (isNewAccessory) {
        summary.added += 1;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } else if (needsAccessoryUpdate) {
        summary.updated += 1;
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    summary.removed = this.removeStaleAccessories(activeUuids);
    this.logSyncSummary(summary);
  }

  private removeStaleAccessories(activeUuids: Set<string>): number {
    let removed = 0;

    for (const [uuid, accessory] of this.accessories) {
      if (activeUuids.has(uuid)) {
        continue;
      }

      this.channelHandlers.get(uuid)?.dispose();
      this.channelHandlers.delete(uuid);
      this.accessories.delete(uuid);
      removed += 1;

      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    return removed;
  }

  private logSyncSummary(summary: SyncSummary): void {
    const text = [
      `SUPLA sync total=${summary.total}`,
      `visible=${summary.visible}`,
      `mapped=${summary.mapped}`,
      `added=${summary.added}`,
      `updated=${summary.updated}`,
      `removed=${summary.removed}`,
      `unsupported=${summary.unsupported}`,
    ].join(', ');

    if (
      summary.added > 0
      || summary.updated > 0
      || summary.removed > 0
      || summary.unsupported > 0
    ) {
      this.log.info(text);
      return;
    }

    this.log.debug(text);
  }

  private shouldExposeChannel(channel: SuplaChannel): boolean {
    const includeHidden = this.getTypedConfig().includeHidden ?? false;
    if (!includeHidden && channel.hidden) {
      return false;
    }

    return true;
  }

  private logUnsupportedFunction(functionId: number, channelId: number): void {
    if (this.unsupportedFunctionsLogged.has(functionId)) {
      return;
    }

    this.unsupportedFunctionsLogged.add(functionId);
    this.log.warn(`Skipping unsupported SUPLA function ${functionId} (first seen on channel ${channelId}).`);
  }

  private maskEmail(email: string): string {
    if (typeof email !== 'string') {
      return '***';
    }

    const atIndex = email.indexOf('@');
    if (atIndex <= 1) {
      return '***';
    }

    return `${email.slice(0, 2)}***${email.slice(atIndex)}`;
  }

  private getTypedConfig(): SuplaPlatformConfig {
    return this.config as SuplaPlatformConfig;
  }

  private getPollIntervalSeconds(config: SuplaPlatformConfig): number {
    const configured = config.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
    if (!Number.isFinite(configured)) {
      return DEFAULT_POLL_INTERVAL_SECONDS;
    }

    return Math.max(2, Math.min(120, Math.round(configured)));
  }

  private getRequestTimeoutMs(config: SuplaPlatformConfig): number {
    const configured = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(configured)) {
      return DEFAULT_REQUEST_TIMEOUT_MS;
    }

    return Math.max(2_000, Math.min(60_000, Math.round(configured)));
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
