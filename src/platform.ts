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

const DEFAULT_POLL_INTERVAL_SECONDS = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class SuplaHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory<SuplaAccessoryContext>> = new Map();

  private readonly channelHandlers: Map<string, SuplaChannelAccessory> = new Map();
  private readonly unsupportedFunctionsLogged: Set<number> = new Set();

  private pollTimer: NodeJS.Timeout | undefined;
  private pollInFlight = false;

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
    const pluginConfig = this.getTypedConfig();

    if (!pluginConfig.email || !pluginConfig.password) {
      this.log.error('SUPLA plugin requires both email and password in config.');
      return;
    }

    const clientOptions: SuplaApiClientOptions = {
      email: pluginConfig.email,
      password: pluginConfig.password,
      server: pluginConfig.server,
      apiPrefix: pluginConfig.apiPrefix,
      requestTimeoutMs: this.getRequestTimeoutMs(pluginConfig),
    };

    this.client = new SuplaApiClient(clientOptions, {
      debug: (message: string) => this.log.debug(message),
      warn: (message: string) => this.log.warn(message),
      error: (message: string) => this.log.error(message),
    });

    try {
      await this.client.initialize();
    } catch (error) {
      this.log.error(`SUPLA initialization failed: ${this.errorMessage(error)}`);
      return;
    }

    await this.refreshChannels();
    this.startPolling(this.getPollIntervalSeconds(pluginConfig));
  }

  private stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    for (const handler of this.channelHandlers.values()) {
      handler.dispose();
    }

    this.channelHandlers.clear();
  }

  private startPolling(intervalSeconds: number): void {
    this.pollTimer = setInterval(() => {
      void this.refreshChannels();
    }, intervalSeconds * 1000);

    this.pollTimer.unref();
  }

  private async refreshChannels(): Promise<void> {
    if (this.pollInFlight || !this.client) {
      return;
    }

    this.pollInFlight = true;
    try {
      const channels = await this.client.listChannels();
      this.syncAccessories(channels);
    } catch (error) {
      this.log.error(`SUPLA refresh failed: ${this.errorMessage(error)}`);
    } finally {
      this.pollInFlight = false;
    }
  }

  private syncAccessories(channels: SuplaChannel[]): void {
    const visibleChannels = channels.filter((channel) => this.shouldExposeChannel(channel));
    const activeUuids = new Set<string>();

    for (const channel of visibleChannels) {
      const functionId = getChannelFunctionId(channel);
      const serviceKind = mapFunctionToServiceKind(functionId);

      if (!serviceKind) {
        this.logUnsupportedFunction(functionId, channel.id);
        continue;
      }

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
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } else if (needsAccessoryUpdate) {
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    this.removeStaleAccessories(activeUuids);
  }

  private removeStaleAccessories(activeUuids: Set<string>): void {
    for (const [uuid, accessory] of this.accessories) {
      if (activeUuids.has(uuid)) {
        continue;
      }

      this.channelHandlers.get(uuid)?.dispose();
      this.channelHandlers.delete(uuid);
      this.accessories.delete(uuid);

      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
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
