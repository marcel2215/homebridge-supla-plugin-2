import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { mapFunctionToServiceKind, SUPLA_FUNCTION } from './constants.js';
import { SuplaApiClient, type SuplaApiClientOptions } from './suplaApiClient.js';
import { SuplaNativeClient, type SuplaNativeClientStatus } from './suplaNativeClient.js';
import { SuplaChannelAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import {
  getChannelDisplayName,
  getChannelFunctionId,
  type SuplaAccessoryContext,
  type SuplaChannel,
  type SuplaChannelState,
} from './types.js';
import { asBoolean, asNumber } from './utils.js';

interface SuplaPlatformConfig extends PlatformConfig {
  email?: string;
  password?: string;
  server?: string;
  transport?: 'native' | 'rest';
  apiPrefix?: string;
  pollIntervalSeconds?: number;
  requestTimeoutMs?: number;
  includeHidden?: boolean;
  nativeHelperPath?: string;
  nativeSsl?: boolean;
  nativePort?: number;
  nativeProtocolVersion?: number;
  nativeConnectTimeoutMs?: number;
  nativeReconnectDelayMs?: number;
  nativeActionTimeoutMs?: number;
  nativeClientName?: string;
  nativeClientSoftVersion?: string;
  nativeGuid?: string;
  nativeAuthKey?: string;
}

interface SyncSummary {
  total: number;
  visible: number;
  mapped: number;
  unsupported: number;
  failed: number;
  added: number;
  updated: number;
  removed: number;
}

const DEFAULT_POLL_INTERVAL_SECONDS = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_NATIVE_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_NATIVE_RECONNECT_DELAY_MS = 2_000;
const DEFAULT_NATIVE_ACTION_TIMEOUT_MS = 12_000;
const INITIALIZATION_RETRY_DELAYS_SECONDS = [5, 10, 20, 40, 60, 120];
const REFRESH_FAILURES_BEFORE_RECOVERY = 3;
const CHANNEL_SYNC_DEBOUNCE_MS = 80;
const NATIVE_IDENTITY_DIRECTORY = 'homebridge-supla-plugin-2';

export class SuplaHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory<SuplaAccessoryContext>> = new Map();

  private readonly cachedChannelsById: Map<number, SuplaChannel> = new Map();
  private readonly channelHandlers: Map<string, SuplaChannelAccessory> = new Map();
  private readonly unsupportedFunctionsLogged: Set<number> = new Set();
  private readonly missingLinkedSensorLogged: Set<string> = new Set();
  private readonly postActionRefreshTimers: Set<NodeJS.Timeout> = new Set();

  private pollTimer: NodeJS.Timeout | undefined;
  private startupRetryTimer: NodeJS.Timeout | undefined;
  private immediateRefreshTimer: NodeJS.Timeout | undefined;
  private realtimeSyncTimer: NodeJS.Timeout | undefined;
  private pollInFlight = false;
  private queuedRefreshAfterCurrent = false;
  private shuttingDown = false;
  private recoveryInFlight = false;
  private startupRetryAttempt = 0;
  private refreshFailureStreak = 0;
  private supportsChannelStatesEndpoint: boolean | undefined;
  private transportMode: 'native' | 'rest' = 'native';
  private latestRealtimeSnapshot: SuplaChannel[] | undefined;

  private apiClient: SuplaApiClient | undefined;
  private nativeClient: SuplaNativeClient | undefined;

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
    if (this.transportMode === 'native') {
      if (!this.nativeClient) {
        throw new Error('SUPLA native client is not initialized.');
      }

      await this.nativeClient.executeChannelAction(channelId, payload);
      return;
    }

    if (!this.apiClient) {
      throw new Error('SUPLA API client is not initialized.');
    }

    try {
      await this.apiClient.executeChannelAction(channelId, payload);
      this.schedulePostActionRefresh(channelId);
    } catch (error) {
      this.log.warn(
        `SUPLA action failed on channel ${channelId}; scheduling immediate state refresh: ${this.errorMessage(error)}`,
      );
      this.requestImmediateRefresh(`failed action on channel ${channelId}`, 0);
      throw error;
    }
  }

  private async start(): Promise<void> {
    this.shuttingDown = false;
    const pluginConfig = this.getTypedConfig();

    if (!pluginConfig.email || !pluginConfig.password) {
      this.log.error('SUPLA plugin requires both email and password in config.');
      return;
    }

    this.transportMode = this.getTransportMode(pluginConfig);

    const pollIntervalSeconds = this.getPollIntervalSeconds(pluginConfig);
    const requestTimeoutMs = this.getRequestTimeoutMs(pluginConfig);
    this.log.info(
      `Starting SUPLA platform for ${this.maskEmail(pluginConfig.email)} `
      + `(transport=${this.transportMode}, poll=${pollIntervalSeconds}s, timeout=${requestTimeoutMs}ms).`,
    );

    if (this.transportMode === 'native') {
      const initialized = await this.initializeNativeClient(pluginConfig);
      if (!initialized) {
        return;
      }

      return;
    }

    const initialized = await this.initializeRestClient(pluginConfig);
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

    if (this.immediateRefreshTimer) {
      clearTimeout(this.immediateRefreshTimer);
      this.immediateRefreshTimer = undefined;
    }

    if (this.realtimeSyncTimer) {
      clearTimeout(this.realtimeSyncTimer);
      this.realtimeSyncTimer = undefined;
    }

    for (const timer of this.postActionRefreshTimers) {
      clearTimeout(timer);
    }
    this.postActionRefreshTimers.clear();

    const nativeClientToStop = this.nativeClient;
    this.nativeClient = undefined;
    if (nativeClientToStop) {
      void nativeClientToStop.stop().catch((error) => {
        this.log.warn(`SUPLA native helper stop failed: ${this.errorMessage(error)}`);
      });
    }

    for (const handler of this.channelHandlers.values()) {
      handler.dispose();
    }

    this.channelHandlers.clear();
    this.cachedChannelsById.clear();
    this.supportsChannelStatesEndpoint = undefined;
    this.latestRealtimeSnapshot = undefined;
    this.apiClient = undefined;
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

  private async initializeRestClient(config: SuplaPlatformConfig): Promise<boolean> {
    this.apiClient = new SuplaApiClient(this.buildClientOptions(config), {
      debug: (message: string) => this.log.debug(message),
      warn: (message: string) => this.log.warn(message),
      error: (message: string) => this.log.error(message),
    });
    this.nativeClient = undefined;
    this.supportsChannelStatesEndpoint = undefined;
    this.cachedChannelsById.clear();

    try {
      await this.apiClient.initialize();
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

  private async initializeNativeClient(config: SuplaPlatformConfig): Promise<boolean> {
    let identity: { guidHex: string; authKeyHex: string } | undefined;
    try {
      identity = await this.resolveNativeIdentity(config);
    } catch (error) {
      this.log.error(`SUPLA native identity initialization failed: ${this.errorMessage(error)}`);
      this.markAllAccessoriesReachability(false);
      this.scheduleStartupRetry();
      return false;
    }

    if (!identity) {
      this.markAllAccessoriesReachability(false);
      this.scheduleStartupRetry();
      return false;
    }

    if (this.nativeClient) {
      try {
        await this.nativeClient.stop();
      } catch (error) {
        this.log.warn(`Failed to stop previous SUPLA native client: ${this.errorMessage(error)}`);
      }
    }

    this.nativeClient = new SuplaNativeClient(
      {
        email: config.email!,
        password: config.password!,
        server: config.server,
        helperPath: config.nativeHelperPath,
        ssl: typeof config.nativeSsl === 'boolean' ? config.nativeSsl : undefined,
        port: asNumber(config.nativePort),
        protocolVersion: asNumber(config.nativeProtocolVersion),
        connectTimeoutMs: this.getNativeConnectTimeoutMs(config),
        reconnectDelayMs: this.getNativeReconnectDelayMs(config),
        actionTimeoutMs: this.getNativeActionTimeoutMs(config),
        requestTimeoutMs: this.getRequestTimeoutMs(config),
        guidHex: identity.guidHex,
        authKeyHex: identity.authKeyHex,
        clientName: config.nativeClientName ?? 'Homebridge SUPLA',
        clientSoftVersion: config.nativeClientSoftVersion ?? `${PLUGIN_NAME}/${this.safePluginVersion()}`,
      },
      {
        info: (message: string) => this.log.info(message),
        debug: (message: string) => this.log.debug(message),
        warn: (message: string) => this.log.warn(message),
        error: (message: string) => this.log.error(message),
      },
      {
        onChannelsChanged: (channels: SuplaChannel[]) => {
          this.onRealtimeChannelsChanged(channels);
        },
        onStatusChange: (status: SuplaNativeClientStatus, detail?: string) => {
          this.onNativeStatus(status, detail);
        },
        onTerminated: (unexpected: boolean) => {
          this.onNativeTerminated(unexpected);
        },
      },
    );

    this.apiClient = undefined;
    this.supportsChannelStatesEndpoint = undefined;
    this.cachedChannelsById.clear();

    try {
      await this.nativeClient.start();
      this.startupRetryAttempt = 0;
      this.clearStartupRetryTimer();
      this.log.info('SUPLA native protocol connection established.');
      return true;
    } catch (error) {
      const failedClient = this.nativeClient;
      this.nativeClient = undefined;
      if (failedClient) {
        try {
          await failedClient.stop();
        } catch (stopError) {
          this.log.warn(
            `SUPLA native cleanup after failed start did not complete cleanly: ${this.errorMessage(stopError)}`,
          );
        }
      }

      this.log.error(`SUPLA native initialization failed: ${this.errorMessage(error)}`);
      this.markAllAccessoriesReachability(false);
      this.latestRealtimeSnapshot = undefined;
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
    if (this.transportMode === 'native') {
      await this.initializeNativeClient(config);
      return;
    }

    const initialized = await this.initializeRestClient(config);
    if (!initialized) {
      return;
    }

    await this.refreshChannels();
    this.startPolling(this.getPollIntervalSeconds(config));
  }

  private async refreshChannels(preferStateRefresh = false): Promise<void> {
    if (this.transportMode !== 'rest') {
      return;
    }

    if (this.pollInFlight || !this.apiClient || this.shuttingDown) {
      if (this.pollInFlight && !this.shuttingDown) {
        this.queuedRefreshAfterCurrent = true;
      }
      return;
    }

    this.pollInFlight = true;
    const startedAt = Date.now();
    let shouldRecover = false;

    try {
      let refreshedChannelsCount = 0;
      let refreshType: 'full' | 'state' = 'full';

      if (preferStateRefresh) {
        const stateRefreshed = await this.tryRefreshChannelsFromStates();
        if (stateRefreshed) {
          refreshType = 'state';
          refreshedChannelsCount = this.cachedChannelsById.size;
        }
      }

      if (refreshType === 'full') {
        const channels = await this.apiClient.listChannels();
        refreshedChannelsCount = channels.length;
        this.replaceCachedChannels(channels);
        this.syncAccessories(channels);
      }

      const durationMs = Date.now() - startedAt;

      if (this.refreshFailureStreak > 0) {
        this.log.warn(`SUPLA refresh recovered after ${this.refreshFailureStreak} consecutive failures.`);
      }

      this.refreshFailureStreak = 0;
      this.log.debug(`SUPLA refresh success (${refreshType}, channels=${refreshedChannelsCount}, duration=${durationMs}ms).`);
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

    if (this.queuedRefreshAfterCurrent && !this.shuttingDown) {
      this.queuedRefreshAfterCurrent = false;
      this.log.debug('SUPLA queued refresh triggered after in-flight refresh completion.');
      void this.refreshChannels();
    }

    if (shouldRecover) {
      void this.recoverClient();
    }
  }

  private schedulePostActionRefresh(channelId: number): void {
    this.requestImmediateRefresh(`action on channel ${channelId}`, 300);

    const followupTimer = setTimeout(() => {
      this.postActionRefreshTimers.delete(followupTimer);
      this.requestImmediateRefresh(`follow-up refresh for channel ${channelId}`, 0);
    }, 1800);
    followupTimer.unref();
    this.postActionRefreshTimers.add(followupTimer);
  }

  private requestImmediateRefresh(reason: string, delayMs: number): void {
    if (this.shuttingDown) {
      return;
    }

    if (this.immediateRefreshTimer) {
      this.log.debug(`SUPLA immediate refresh already scheduled, keeping existing timer (reason=${reason}).`);
      return;
    }

    const normalizedDelayMs = Math.max(0, Math.round(delayMs));
    this.log.debug(`SUPLA scheduling immediate refresh in ${normalizedDelayMs}ms (${reason}).`);
    this.immediateRefreshTimer = setTimeout(() => {
      this.immediateRefreshTimer = undefined;
      if (this.shuttingDown) {
        return;
      }

      void this.refreshChannels(true);
    }, normalizedDelayMs);
    this.immediateRefreshTimer.unref();
  }

  private replaceCachedChannels(channels: SuplaChannel[]): void {
    this.cachedChannelsById.clear();
    for (const channel of channels) {
      this.cachedChannelsById.set(channel.id, channel);
    }
  }

  private async tryRefreshChannelsFromStates(): Promise<boolean> {
    if (!this.apiClient) {
      return false;
    }

    if (this.supportsChannelStatesEndpoint === false) {
      return false;
    }

    if (this.cachedChannelsById.size === 0) {
      return false;
    }

    try {
      const snapshots = await this.apiClient.listChannelStates();
      let mergedCount = 0;

      for (const snapshot of snapshots) {
        const previous = this.cachedChannelsById.get(snapshot.id);
        if (!previous) {
          continue;
        }

        let mergedState = previous.state;
        if (snapshot.state) {
          mergedState = {
            ...(previous.state ?? {}),
            ...snapshot.state,
          };
        }

        if (snapshot.connected !== undefined) {
          mergedState = {
            ...(mergedState ?? {}),
            connected: snapshot.connected,
          };
        }

        this.cachedChannelsById.set(snapshot.id, {
          ...previous,
          connected: snapshot.connected ?? previous.connected,
          state: mergedState,
        });
        mergedCount += 1;
      }

      if (mergedCount === 0) {
        this.log.debug('SUPLA state-only refresh returned no matching cached channels.');
        return false;
      }

      this.supportsChannelStatesEndpoint = true;
      this.syncAccessories(Array.from(this.cachedChannelsById.values()));
      this.log.debug(`SUPLA state-only refresh applied for ${mergedCount} channels.`);
      return true;
    } catch (error) {
      const message = this.errorMessage(error);
      if (this.isUnsupportedChannelStatesError(message)) {
        this.log.warn(`SUPLA /channels/states endpoint unavailable, falling back to full refreshes: ${message}`);
        this.supportsChannelStatesEndpoint = false;
      } else {
        this.log.warn(`SUPLA state-only refresh failed, falling back to full refresh: ${message}`);
      }
      return false;
    }
  }

  private isUnsupportedChannelStatesError(message: string): boolean {
    const text = message.toLowerCase();
    if (!text.includes('/channels/states')) {
      return false;
    }

    return text.includes('404')
      || text.includes('405')
      || text.includes('not found')
      || text.includes('method not allowed');
  }

  private async recoverClient(): Promise<void> {
    if (this.transportMode !== 'rest') {
      return;
    }

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
      const initialized = await this.initializeRestClient(config);
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
    const channelById = new Map<number, SuplaChannel>();
    for (const channel of channels) {
      channelById.set(channel.id, channel);
    }

    const visibleChannels = channels.filter((channel) => this.shouldExposeChannel(channel));
    const activeUuids = new Set<string>();
    const summary: SyncSummary = {
      total: channels.length,
      visible: visibleChannels.length,
      mapped: 0,
      unsupported: 0,
      failed: 0,
      added: 0,
      updated: 0,
      removed: 0,
    };

    for (const rawChannel of visibleChannels) {
      try {
        const channel = this.enrichChannelWithLinkedSensors(rawChannel, channelById);
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
      } catch (error) {
        summary.failed += 1;
        const channelId = rawChannel.id;
        if (typeof channelId === 'number') {
          const fallbackUuid = this.api.hap.uuid.generate(`supla-channel-${Math.trunc(channelId)}`);
          activeUuids.add(fallbackUuid);
        }

        this.log.error(
          `SUPLA channel ${String(channelId)} sync failed: ${this.errorMessage(error)}`,
        );
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
      `failed=${summary.failed}`,
    ].join(', ');

    if (
      summary.added > 0
      || summary.updated > 0
      || summary.removed > 0
      || summary.unsupported > 0
      || summary.failed > 0
    ) {
      this.log.info(text);
      return;
    }

    this.log.debug(text);
  }

  private onRealtimeChannelsChanged(channels: SuplaChannel[]): void {
    if (this.shuttingDown || this.transportMode !== 'native') {
      return;
    }

    this.latestRealtimeSnapshot = channels;

    if (this.realtimeSyncTimer) {
      return;
    }

    this.realtimeSyncTimer = setTimeout(() => {
      this.realtimeSyncTimer = undefined;
      void this.syncRealtimeSnapshot();
    }, CHANNEL_SYNC_DEBOUNCE_MS);
    this.realtimeSyncTimer.unref();
  }

  private async syncRealtimeSnapshot(): Promise<void> {
    if (this.shuttingDown || this.transportMode !== 'native') {
      return;
    }

    const snapshot = this.latestRealtimeSnapshot;
    if (!snapshot) {
      return;
    }

    try {
      this.replaceCachedChannels(snapshot);
      this.syncAccessories(snapshot);
      this.refreshFailureStreak = 0;
    } catch (error) {
      this.log.error(`SUPLA realtime sync failed: ${this.errorMessage(error)}`);
    }
  }

  private onNativeStatus(status: SuplaNativeClientStatus, detail?: string): void {
    if (this.transportMode !== 'native') {
      return;
    }

    const detailSuffix = detail ? ` detail=${detail}` : '';
    this.log.debug(`SUPLA native status=${status}${detailSuffix}`);

    if (status === 'registered') {
      this.markAllAccessoriesReachability(true);
      return;
    }

    if (
      status === 'disconnected'
      || status === 'connecting'
      || status === 'registering'
      || status === 'initialized'
      || status === 'stopping'
      || status === 'stopped'
    ) {
      this.markAllAccessoriesReachability(false);
      return;
    }
  }

  private onNativeTerminated(unexpected: boolean): void {
    if (this.shuttingDown || this.transportMode !== 'native') {
      return;
    }

    this.markAllAccessoriesReachability(false);
    this.latestRealtimeSnapshot = undefined;
    this.nativeClient = undefined;

    if (!unexpected) {
      return;
    }

    this.log.warn('SUPLA native helper terminated unexpectedly; scheduling restart.');
    this.scheduleStartupRetry();
  }

  private async resolveNativeIdentity(
    config: SuplaPlatformConfig,
  ): Promise<{ guidHex: string; authKeyHex: string } | undefined> {
    const configuredGuid = this.validateFixedHex(config.nativeGuid, 16);
    const configuredAuthKey = this.validateFixedHex(config.nativeAuthKey, 16);
    if (configuredGuid && configuredAuthKey) {
      return { guidHex: configuredGuid, authKeyHex: configuredAuthKey };
    }

    const storagePath = this.api.user.storagePath();
    const email = (config.email ?? '').trim().toLowerCase();
    if (!storagePath || !email) {
      this.log.error('SUPLA native identity setup failed: missing Homebridge storage path or email.');
      return undefined;
    }

    const safeEmail = email.replace(/[^a-z0-9]+/gi, '_');
    const identityDir = path.join(storagePath, NATIVE_IDENTITY_DIRECTORY);
    const identityPath = path.join(identityDir, `${safeEmail}.json`);

    await mkdir(identityDir, { recursive: true });

    try {
      const raw = await readFile(identityPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const guidHex = this.validateFixedHex(parsed.guidHex, 16);
      const authKeyHex = this.validateFixedHex(parsed.authKeyHex, 16);
      if (guidHex && authKeyHex) {
        return { guidHex, authKeyHex };
      }
    } catch {
      // Ignore read/parse errors and create a new identity below.
    }

    const nextIdentity = {
      guidHex: configuredGuid ?? randomBytes(16).toString('hex'),
      authKeyHex: configuredAuthKey ?? randomBytes(16).toString('hex'),
    };

    await writeFile(identityPath, `${JSON.stringify(nextIdentity, null, 2)}\n`, 'utf8');
    this.log.info(`SUPLA native identity initialized at ${identityPath}.`);
    return nextIdentity;
  }

  private enrichChannelWithLinkedSensors(
    channel: SuplaChannel,
    channelById: Map<number, SuplaChannel>,
  ): SuplaChannel {
    const functionId = getChannelFunctionId(channel);
    const openingSensorSupported = this.isOpeningSensorLinkSupportedFunction(functionId);
    const partialSensorSupported = this.isPartialOpeningSensorLinkSupportedFunction(functionId);
    if (!openingSensorSupported && !partialSensorSupported) {
      return channel;
    }

    const configRoot = this.asRecord(channel.config);
    const nestedConfig = this.asRecord(configRoot?.controllingTheGate)
      ?? this.asRecord(configRoot?.controlling_the_gate)
      ?? this.asRecord(configRoot?.controllingTheGarageDoor)
      ?? this.asRecord(configRoot?.controlling_the_garage_door);
    const openingSensorId = openingSensorSupported
      ? this.readLinkedSensorId(
        channel.param2,
        configRoot,
        nestedConfig,
        'openingSensorChannelId',
        'opening_sensor_channel_id',
      )
      : undefined;
    const partialSensorId = partialSensorSupported
      ? this.readLinkedSensorId(
        channel.param3,
        configRoot,
        nestedConfig,
        'openingSensorSecondaryChannelId',
        'opening_sensor_secondary_channel_id',
      )
      : undefined;

    if (openingSensorId === undefined && partialSensorId === undefined) {
      return channel;
    }

    let openingClosed: boolean | undefined;
    if (openingSensorId !== undefined) {
      const openingSensor = channelById.get(openingSensorId);
      if (!openingSensor) {
        this.logMissingLinkedSensor(channel.id, openingSensorId, 'opening');
      } else {
        openingClosed = this.readLinkedSensorClosed(openingSensor);
      }
    }

    let partialClosed: boolean | undefined;
    if (partialSensorId !== undefined) {
      const partialSensor = channelById.get(partialSensorId);
      if (!partialSensor) {
        this.logMissingLinkedSensor(channel.id, partialSensorId, 'partial');
      } else {
        partialClosed = this.readLinkedSensorClosed(partialSensor);
      }
    }

    if (openingClosed === undefined && partialClosed === undefined) {
      return channel;
    }

    if (openingClosed === undefined && partialClosed !== true) {
      return channel;
    }

    const mergedState: SuplaChannelState = { ...(channel.state ?? {}) };
    if (openingClosed !== undefined) {
      mergedState.hi = openingClosed;
      mergedState.closed = openingClosed;
    }

    if (partialClosed !== undefined) {
      mergedState.partial_hi = partialClosed;
      mergedState.partialHi = partialClosed;
    }

    const mergedSubValue = this.buildMergedSubValue(openingClosed, partialClosed);
    if (mergedSubValue !== undefined) {
      mergedState.subValueHi = mergedSubValue;
      mergedState.sub_value_hi = mergedSubValue;
    }

    this.log.debug(
      `SUPLA channel ${channel.id}: merged linked sensors opening=${String(openingSensorId)}(${String(openingClosed)}), `
      + `partial=${String(partialSensorId)}(${String(partialClosed)}), subValueHi=${String(mergedSubValue)}`,
    );

    return {
      ...channel,
      state: mergedState,
    };
  }

  private isOpeningSensorLinkSupportedFunction(functionId: number): boolean {
    return functionId === SUPLA_FUNCTION.CONTROLLING_THE_ROLLER_SHUTTER
      || functionId === SUPLA_FUNCTION.CONTROLLING_THE_ROOF_WINDOW
      || functionId === SUPLA_FUNCTION.CONTROLLING_THE_DOOR_LOCK
      || functionId === SUPLA_FUNCTION.CONTROLLING_THE_GARAGE_DOOR
      || functionId === SUPLA_FUNCTION.CONTROLLING_THE_GATEWAY_LOCK
      || functionId === SUPLA_FUNCTION.CONTROLLING_THE_GATE;
  }

  private isPartialOpeningSensorLinkSupportedFunction(functionId: number): boolean {
    return functionId === SUPLA_FUNCTION.CONTROLLING_THE_GATE
      || functionId === SUPLA_FUNCTION.CONTROLLING_THE_GARAGE_DOOR;
  }

  private readLinkedSensorId(
    directValue: unknown,
    configRoot: Record<string, unknown> | undefined,
    nestedConfig: Record<string, unknown> | undefined,
    camelCaseName: string,
    snakeCaseName: string,
  ): number | undefined {
    const value = asNumber(directValue)
      ?? asNumber(configRoot?.[camelCaseName])
      ?? asNumber(configRoot?.[snakeCaseName])
      ?? asNumber(nestedConfig?.[camelCaseName])
      ?? asNumber(nestedConfig?.[snakeCaseName]);

    if (value === undefined || value <= 0) {
      return undefined;
    }

    return Math.trunc(value);
  }

  private buildMergedSubValue(
    openingClosed: boolean | undefined,
    partialClosed: boolean | undefined,
  ): number | undefined {
    if (openingClosed === undefined && partialClosed !== true) {
      return undefined;
    }

    return (openingClosed ? 1 : 0) | (partialClosed ? 2 : 0);
  }

  private readLinkedSensorClosed(sensorChannel: SuplaChannel): boolean | undefined {
    const sensorConnected = asBoolean(sensorChannel.state?.connected)
      ?? asBoolean(sensorChannel.connected)
      ?? true;
    if (!sensorConnected) {
      return undefined;
    }

    const sensorState = sensorChannel.state;
    if (!sensorState) {
      return undefined;
    }

    const closed = this.readBinaryBoolean(sensorState.closed);
    if (closed !== undefined) {
      return closed;
    }

    return this.readBinaryBoolean(sensorState.hi);
  }

  private readBinaryBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') {
        return true;
      }
      if (normalized === 'false' || normalized === '0') {
        return false;
      }
      return undefined;
    }

    const numeric = asNumber(value);
    if (numeric === undefined) {
      return undefined;
    }

    if (numeric === 1) {
      return true;
    }
    if (numeric === 0) {
      return false;
    }

    return undefined;
  }

  private logMissingLinkedSensor(parentId: number, sensorId: number, role: 'opening' | 'partial'): void {
    const key = `${parentId}:${sensorId}:${role}`;
    if (this.missingLinkedSensorLogged.has(key)) {
      return;
    }

    this.missingLinkedSensorLogged.add(key);
    this.log.warn(
      `SUPLA channel ${parentId}: configured ${role} sensor channel ${sensorId} was not found in API response.`,
    );
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, unknown>;
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

  private getTransportMode(config: SuplaPlatformConfig): 'native' | 'rest' {
    const normalized = String(config.transport ?? 'native').trim().toLowerCase();
    return normalized === 'rest' ? 'rest' : 'native';
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

  private getNativeConnectTimeoutMs(config: SuplaPlatformConfig): number {
    const configured = asNumber(config.nativeConnectTimeoutMs) ?? DEFAULT_NATIVE_CONNECT_TIMEOUT_MS;
    return Math.max(1_000, Math.min(60_000, Math.round(configured)));
  }

  private getNativeReconnectDelayMs(config: SuplaPlatformConfig): number {
    const configured = asNumber(config.nativeReconnectDelayMs) ?? DEFAULT_NATIVE_RECONNECT_DELAY_MS;
    return Math.max(500, Math.min(60_000, Math.round(configured)));
  }

  private getNativeActionTimeoutMs(config: SuplaPlatformConfig): number {
    const configured = asNumber(config.nativeActionTimeoutMs) ?? DEFAULT_NATIVE_ACTION_TIMEOUT_MS;
    return Math.max(2_000, Math.min(60_000, Math.round(configured)));
  }

  private validateFixedHex(value: unknown, byteLength: number): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (!new RegExp(`^[a-f0-9]{${byteLength * 2}}$`).test(normalized)) {
      return undefined;
    }

    return normalized;
  }

  private safePluginVersion(): string {
    const fromEnv = process.env.npm_package_version;
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
      return fromEnv.trim();
    }

    return 'dev';
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
