import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { SUPLA_ACTION, SUPLA_FUNCTION } from './constants.js';
import type { SuplaChannel, SuplaChannelConfig, SuplaChannelState } from './types.js';
import { asBoolean, asNumber, clampNumber, hsvToRgb } from './utils.js';

const DEFAULT_SSL_PORT = 2016;
const DEFAULT_TCP_PORT = 2015;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_RECONNECT_DELAY_MS = 2_000;
const DEFAULT_ACTION_TIMEOUT_MS = 12_000;
const START_TIMEOUT_MS = 45_000;
const AUTODISCOVER_MAX_RETRIES = 2;
const AUTODISCOVER_BASE_RETRY_DELAY_MS = 500;
const AUTODISCOVER_MAX_RETRY_DELAY_MS = 4_000;
const CHANNEL_RELATION_TYPE_OPENING_SENSOR = 1;
const CHANNEL_RELATION_TYPE_PARTIAL_OPENING_SENSOR = 2;
const CHANNEL_RELATION_TYPE_MAIN_THERMOMETER = 4;
const CHANNEL_RELATION_TYPE_AUX_THERMOMETER_FLOOR = 5;
const CHANNEL_RELATION_TYPE_AUX_THERMOMETER_WATER = 6;
const CHANNEL_RELATION_TYPE_AUX_THERMOMETER_GENERIC_HEATER = 7;
const CHANNEL_RELATION_TYPE_AUX_THERMOMETER_GENERIC_COOLER = 8;
const SUPLA_RELAY_FLAG_OVERCURRENT_RELAY_OFF = 0x1;
const RS_VALUE_FLAG_CALIBRATION_FAILED = 0x2;
const RS_VALUE_FLAG_CALIBRATION_LOST = 0x4;
const RS_VALUE_FLAG_MOTOR_PROBLEM = 0x8;
const RS_VALUE_FLAG_CALIBRATION_IN_PROGRESS = 0x10;
const SUPLA_HVAC_VALUE_FLAG_HEATING = 1 << 2;
const SUPLA_HVAC_VALUE_FLAG_COOLING = 1 << 3;
const SUPLA_HVAC_VALUE_FLAG_WEEKLY_SCHEDULE = 1 << 4;
const SUPLA_HVAC_VALUE_FLAG_COUNTDOWN_TIMER = 1 << 5;
const SUPLA_HVAC_VALUE_FLAG_THERMOMETER_ERROR = 1 << 7;
const SUPLA_HVAC_VALUE_FLAG_CLOCK_ERROR = 1 << 8;
const SUPLA_HVAC_VALUE_FLAG_FORCED_OFF_BY_SENSOR = 1 << 9;
const SUPLA_HVAC_VALUE_FLAG_COOL = 1 << 10;
const SUPLA_HVAC_VALUE_FLAG_WEEKLY_SCHEDULE_TEMPORAL_OVERRIDE = 1 << 11;
const SUPLA_HVAC_VALUE_FLAG_BATTERY_COVER_OPEN = 1 << 12;
const SUPLA_HVAC_VALUE_FLAG_CALIBRATION_ERROR = 1 << 13;
const SUPLA_THERMOSTAT_VALUE_FLAG_AUTO_MODE = 0x0002;
const SUPLA_THERMOSTAT_VALUE_FLAG_COOL_MODE = 0x0004;
const SUPLA_THERMOSTAT_VALUE_FLAG_HEAT_MODE = 0x0008;
const SUPLA_VALVE_FLAG_FLOODING = 0x1;
const SUPLA_VALVE_FLAG_MANUALLY_CLOSED = 0x2;
const SUPLA_VALVE_FLAG_MOTOR_PROBLEM = 0x4;

type JsonRecord = Record<string, unknown>;

interface NativeChannelRecord {
  id: number;
  functionId: number;
  channelType: number;
  caption: string;
  locationId: number;
  deviceId: number;
  online: number;
  flags: number;
  protocolVersion: number;
  value: Buffer;
  subValue: Buffer;
  subValueType: number;
  extendedValue: Buffer | undefined;
  extendedValueType: number | undefined;
}

interface PendingAction {
  channelId: number;
  action: string;
  timeout: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ResolvedEndpoint {
  host: string;
  port: number;
  ssl: boolean;
}

export interface SuplaNativeClientLogger {
  info(message: string): void;
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type SuplaNativeClientStatus =
  | 'initialized'
  | 'connecting'
  | 'connected'
  | 'registering'
  | 'registered'
  | 'disconnected'
  | 'stopping'
  | 'stopped';

export interface SuplaNativeClientEvents {
  onChannelsChanged?(channels: SuplaChannel[]): void;
  onStatusChange?(status: SuplaNativeClientStatus, detail?: string): void;
  onTerminated?(unexpected: boolean, code: number | null, signal: NodeJS.Signals | null): void;
}

export interface SuplaNativeClientOptions {
  email: string;
  password: string;
  server?: string;
  helperPath?: string;
  ssl?: boolean;
  port?: number;
  protocolVersion?: number;
  connectTimeoutMs?: number;
  reconnectDelayMs?: number;
  actionTimeoutMs?: number;
  requestTimeoutMs?: number;
  guidHex: string;
  authKeyHex: string;
  clientName?: string;
  clientSoftVersion?: string;
}

export class SuplaNativeClient {
  private helperProcess: ChildProcessWithoutNullStreams | undefined;
  private helperStdout: Interface | undefined;
  private helperStderr: Interface | undefined;
  private readonly channelsById = new Map<number, NativeChannelRecord>();
  private readonly relationsByKey = new Map<string, { childId: number; parentId: number; relationType: number }>();
  private readonly pendingActions = new Map<string, PendingAction>();
  private startPromise: Promise<void> | undefined;
  private startResolve: (() => void) | undefined;
  private startReject: ((error: Error) => void) | undefined;
  private startTimer: NodeJS.Timeout | undefined;
  private channelsEolSeen = false;
  private registeredSeen = false;
  private shuttingDown = false;
  private actionSequence = 0;
  private emitTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: SuplaNativeClientOptions,
    private readonly logger: SuplaNativeClientLogger,
    private readonly events: SuplaNativeClientEvents,
  ) {}

  async start(): Promise<void> {
    if (this.helperProcess) {
      if (this.startPromise) {
        await this.startPromise;
      }
      return;
    }

    this.shuttingDown = false;
    this.channelsEolSeen = false;
    this.registeredSeen = false;

    const helperPath = await this.resolveHelperPath();
    const endpoint = await this.resolveEndpoint();
    const args = this.buildHelperArgs(endpoint);

    this.logger.info(
      `SUPLA native client starting helper (${path.basename(helperPath)}) `
      + `for ${this.maskEmail(this.options.email)} via ${endpoint.host}:${endpoint.port} ssl=${endpoint.ssl}.`,
    );

    const child = spawn(helperPath, args, {
      cwd: path.dirname(helperPath),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.helperProcess = child;
    child.stdin.setDefaultEncoding('utf8');

    this.helperStdout = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    this.helperStdout.on('line', (line) => {
      this.handleHelperLine(line);
    });

    this.helperStderr = createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY });
    this.helperStderr.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        this.logger.warn(`SUPLA native helper stderr: ${trimmed}`);
      }
    });

    child.on('error', (error) => {
      this.logger.error(`SUPLA native helper process error: ${error.message}`);
      this.cleanupHelperProcess();
      this.rejectPendingActions(`SUPLA native helper process error: ${error.message}`);
      this.rejectStartIfPending(new Error(`SUPLA native helper process error: ${error.message}`));
      if (!this.shuttingDown) {
        this.events.onStatusChange?.('disconnected', 'helper-error');
      }
      this.events.onTerminated?.(!this.shuttingDown, null, null);
    });

    child.on('exit', (code, signal) => {
      const unexpected = !this.shuttingDown;
      if (unexpected) {
        this.logger.warn(
          `SUPLA native helper exited (code=${String(code)}, signal=${String(signal)}, unexpected=${unexpected}).`,
        );
      } else {
        this.logger.info(`SUPLA native helper exited cleanly (code=${String(code)}, signal=${String(signal)}).`);
      }
      this.cleanupHelperProcess();
      const exitMessage = unexpected
        ? `SUPLA native helper exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`
        : 'SUPLA native helper stopped.';
      this.rejectPendingActions(exitMessage);
      this.rejectStartIfPending(new Error('SUPLA native helper exited before completing startup.'));

      if (!this.shuttingDown) {
        this.events.onStatusChange?.('disconnected', 'helper-exit');
      }
      this.events.onTerminated?.(unexpected, code, signal);
    });

    this.startPromise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });

    this.startTimer = setTimeout(() => {
      this.rejectStartIfPending(
        new Error(
          `SUPLA native startup timed out after ${START_TIMEOUT_MS}ms (registered=${this.registeredSeen}, channelsEol=${this.channelsEolSeen}).`,
        ),
      );
    }, START_TIMEOUT_MS);
    this.startTimer.unref();

    await this.startPromise;
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    this.events.onStatusChange?.('stopping');

    this.clearStartTimer();
    this.rejectStartIfPending(new Error('SUPLA native client stopped before startup completed.'));

    const processToStop = this.helperProcess;
    if (!processToStop) {
      this.events.onStatusChange?.('stopped');
      return;
    }

    try {
      this.sendCommand('SHUTDOWN');
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.logger.warn(`SUPLA native helper shutdown command failed: ${text}`);
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const onExit = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      processToStop.once('exit', onExit);
      if (processToStop.exitCode !== null || processToStop.killed) {
        onExit();
        return;
      }

      const hardStopTimer = setTimeout(() => {
        if (settled) {
          return;
        }

        try {
          processToStop.kill('SIGTERM');
        } catch {
          // ignore
        }

        const killTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          try {
            processToStop.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 2_000);
        killTimer.unref();
      }, 2_000);

      hardStopTimer.unref();
    });

    this.cleanupHelperProcess();
    this.rejectPendingActions('SUPLA native client stopped.');
    this.events.onStatusChange?.('stopped');
  }

  getChannelsSnapshot(): SuplaChannel[] {
    return this.buildChannelsSnapshot();
  }

  async executeChannelAction(channelId: number, payload: Record<string, unknown>): Promise<void> {
    if (!this.helperProcess) {
      throw new Error('SUPLA native helper is not running.');
    }

    const { action, params } = this.mapActionPayload(payload);
    const requestId = `${Date.now()}-${++this.actionSequence}`;
    const paramEntries = Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`);

    const command = [
      'ACTION',
      requestId,
      String(Math.trunc(channelId)),
      action,
      ...paramEntries,
    ].join('\t');

    await new Promise<void>((resolve, reject) => {
      const timeoutMs = this.resolveActionTimeoutMs();
      const timeout = setTimeout(() => {
        this.pendingActions.delete(requestId);
        reject(new Error(`SUPLA action timeout (${action} on channel ${channelId}, ${timeoutMs}ms).`));
      }, timeoutMs);
      timeout.unref();

      this.pendingActions.set(requestId, {
        channelId,
        action,
        timeout,
        resolve,
        reject,
      });

      try {
        this.sendCommand(command);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingActions.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async resolveHelperPath(): Promise<string> {
    const configured = this.options.helperPath?.trim();
    const fallback = fileURLToPath(new URL('../native/bin/supla-native-bridge', import.meta.url));
    const helperPath = configured && configured.length > 0
      ? path.resolve(configured)
      : path.resolve(fallback);

    await access(helperPath, fsConstants.F_OK);
    await access(helperPath, fsConstants.X_OK);

    return helperPath;
  }

  private async resolveEndpoint(): Promise<ResolvedEndpoint> {
    const configuredServer = this.options.server?.trim();
    if (configuredServer && configuredServer.length > 0) {
      return this.parseServer(configuredServer, this.options.ssl, this.options.port);
    }

    const discoveredServer = await this.autodiscoverServer();
    return this.parseServer(discoveredServer, this.options.ssl, this.options.port);
  }

  private async autodiscoverServer(): Promise<string> {
    const url = `https://autodiscover.supla.org/users/${encodeURIComponent(this.options.email)}`;
    const timeoutMs = this.resolveConnectTimeoutMs();
    let lastError: unknown;

    for (let attempt = 0; attempt <= AUTODISCOVER_MAX_RETRIES; attempt += 1) {
      const abortController = new AbortController();
      const timeout = setTimeout(() => {
        abortController.abort();
      }, timeoutMs);
      timeout.unref();

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error(`SUPLA autodiscover failed with HTTP ${response.status}.`);
        }

        const payload = (await response.json()) as JsonRecord;
        const server = typeof payload.server === 'string' ? payload.server.trim() : '';
        if (!server) {
          throw new Error('SUPLA autodiscover did not return a server host.');
        }

        if (attempt > 0) {
          this.logger.info(`SUPLA autodiscover recovered after ${attempt} retry attempt(s).`);
        }

        return server;
      } catch (error) {
        lastError = error;
        if (attempt >= AUTODISCOVER_MAX_RETRIES) {
          break;
        }

        const retryDelayMs = Math.min(
          AUTODISCOVER_MAX_RETRY_DELAY_MS,
          AUTODISCOVER_BASE_RETRY_DELAY_MS * (2 ** attempt),
        );
        this.logger.warn(
          `SUPLA autodiscover attempt ${attempt + 1} failed: ${this.errorMessage(error)}. `
          + `Retrying in ${retryDelayMs}ms.`,
        );

        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryDelayMs);
          timer.unref();
        });
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error(`SUPLA autodiscover failed: ${this.errorMessage(lastError)}`);
  }

  private parseServer(server: string, sslOverride: boolean | undefined, portOverride: number | undefined): ResolvedEndpoint {
    const withScheme = /^https?:\/\//i.test(server)
      ? server
      : `https://${server}`;

    const url = new URL(withScheme);
    const ssl = sslOverride ?? (url.protocol !== 'http:');

    let port = portOverride;
    if (!Number.isFinite(port)) {
      const urlPort = Number.parseInt(url.port, 10);
      port = Number.isFinite(urlPort) && urlPort > 0
        ? urlPort
        : undefined;
    }

    if (!port || port <= 0) {
      port = ssl ? DEFAULT_SSL_PORT : DEFAULT_TCP_PORT;
    }

    return {
      host: url.hostname,
      port: Math.trunc(port),
      ssl,
    };
  }

  private buildHelperArgs(endpoint: ResolvedEndpoint): string[] {
    const args = [
      '--host', endpoint.host,
      '--port', String(endpoint.port),
      '--ssl', endpoint.ssl ? 'true' : 'false',
      '--email', this.options.email,
      '--password', this.options.password,
      '--guid', this.options.guidHex,
      '--auth-key', this.options.authKeyHex,
      '--connect-timeout-ms', String(this.resolveConnectTimeoutMs()),
      '--reconnect-delay-ms', String(this.resolveReconnectDelayMs()),
    ];

    if (Number.isFinite(this.options.protocolVersion) && (this.options.protocolVersion ?? 0) > 0) {
      args.push('--protocol-version', String(Math.trunc(this.options.protocolVersion!)));
    }

    const clientName = this.options.clientName?.trim();
    if (clientName) {
      args.push('--name', clientName);
    }

    const clientSoftVersion = this.options.clientSoftVersion?.trim();
    if (clientSoftVersion) {
      args.push('--soft-ver', clientSoftVersion);
    }

    return args;
  }

  private resolveConnectTimeoutMs(): number {
    const configured = this.options.connectTimeoutMs;
    if (!Number.isFinite(configured)) {
      return DEFAULT_CONNECT_TIMEOUT_MS;
    }

    return Math.max(1_000, Math.min(60_000, Math.round(configured!)));
  }

  private resolveReconnectDelayMs(): number {
    const configured = this.options.reconnectDelayMs;
    if (!Number.isFinite(configured)) {
      return DEFAULT_RECONNECT_DELAY_MS;
    }

    return Math.max(500, Math.min(60_000, Math.round(configured!)));
  }

  private resolveActionTimeoutMs(): number {
    const configured = this.options.actionTimeoutMs ?? this.options.requestTimeoutMs;
    if (!Number.isFinite(configured)) {
      return DEFAULT_ACTION_TIMEOUT_MS;
    }

    return Math.max(2_000, Math.min(60_000, Math.round(configured!)));
  }

  private sendCommand(command: string): void {
    if (!this.helperProcess || this.helperProcess.killed || this.helperProcess.exitCode !== null) {
      throw new Error('SUPLA native helper process is not available.');
    }

    this.helperProcess.stdin.write(`${command}\n`);
  }

  private handleHelperLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let event: JsonRecord;
    try {
      event = JSON.parse(trimmed) as JsonRecord;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.logger.warn(`SUPLA native helper emitted invalid JSON (${text}): ${trimmed}`);
      return;
    }

    const type = typeof event.type === 'string' ? event.type : '';
    switch (type) {
    case 'status':
      this.handleStatusEvent(event);
      break;
    case 'registered':
      // Start a fresh inventory snapshot on each registration cycle so removed channels/relations
      // do not survive reconnects.
      this.channelsById.clear();
      this.relationsByKey.clear();
      this.registeredSeen = true;
      this.events.onStatusChange?.('registered');
      this.logger.info('SUPLA native registration succeeded.');
      this.tryResolveStart();
      break;
    case 'channels_eol':
      this.channelsEolSeen = true;
      this.scheduleChannelsEmit('channels-eol');
      this.tryResolveStart();
      break;
    case 'channel_update':
      this.handleChannelUpdateEvent(event);
      this.scheduleChannelsEmit('channel-update');
      break;
    case 'channel_value_update':
      this.handleChannelValueEvent(event);
      this.scheduleChannelsEmit('channel-value-update');
      break;
    case 'channel_extended_value_update':
      this.handleChannelExtendedValueEvent(event);
      this.scheduleChannelsEmit('channel-extended-value-update');
      break;
    case 'channel_relation_update':
      this.handleChannelRelationEvent(event);
      this.scheduleChannelsEmit('channel-relation-update');
      break;
    case 'channel_values_eol':
    case 'channel_relations_eol':
      this.scheduleChannelsEmit(type);
      break;
    case 'action_result':
      this.handleActionResultEvent(event);
      break;
    case 'action_execution_result':
      this.handleActionExecutionResultEvent(event);
      break;
    case 'log':
      this.handleHelperLogEvent(event);
      break;
    case 'error':
      this.handleHelperErrorEvent(event);
      break;
    case 'version_error':
      this.logger.error(`SUPLA protocol version error: ${JSON.stringify(event)}`);
      break;
    default:
      this.logger.debug(`SUPLA native helper event: ${trimmed}`);
      break;
    }
  }

  private handleStatusEvent(event: JsonRecord): void {
    const status = String(event.status ?? '').toLowerCase();
    const normalized = this.normalizeStatus(status);

    this.events.onStatusChange?.(normalized, status);
    this.logger.debug(`SUPLA native status: ${status}`);
  }

  private normalizeStatus(status: string): SuplaNativeClientStatus {
    switch (status) {
    case 'initialized':
      return 'initialized';
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'registering':
      return 'registering';
    case 'registered':
      return 'registered';
    case 'disconnected':
      return 'disconnected';
    case 'stopping':
      return 'stopping';
    case 'stopped':
      return 'stopped';
    default:
      return 'connecting';
    }
  }

  private handleChannelUpdateEvent(event: JsonRecord): void {
    const channelId = asNumber(event.id);
    if (channelId === undefined) {
      return;
    }

    const record = this.getOrCreateChannelRecord(Math.trunc(channelId));
    record.id = Math.trunc(channelId);
    record.functionId = Math.trunc(asNumber(event.functionId) ?? record.functionId);
    record.channelType = Math.trunc(asNumber(event.channelType) ?? record.channelType);
    record.locationId = Math.trunc(asNumber(event.locationId) ?? record.locationId);
    record.deviceId = Math.trunc(asNumber(event.deviceId) ?? record.deviceId);
    record.flags = asNumber(event.flags) ?? record.flags;
    record.protocolVersion = Math.trunc(asNumber(event.protocolVersion) ?? record.protocolVersion);
    record.online = Math.trunc(asNumber(event.online) ?? record.online);

    const caption = typeof event.caption === 'string' ? event.caption.trim() : '';
    if (caption.length > 0) {
      record.caption = caption;
    }

    const value = this.decodeFixedSizeBase64(event.value, 8);
    if (value) {
      record.value = value;
    }

    const subValue = this.decodeFixedSizeBase64(event.subValue, 8);
    if (subValue) {
      record.subValue = subValue;
    }

    const subValueType = asNumber(event.subValueType);
    if (subValueType !== undefined) {
      record.subValueType = Math.trunc(subValueType);
    }
  }

  private handleChannelValueEvent(event: JsonRecord): void {
    const channelId = asNumber(event.id);
    if (channelId === undefined) {
      return;
    }

    const record = this.getOrCreateChannelRecord(Math.trunc(channelId));
    record.online = Math.trunc(asNumber(event.online) ?? record.online);

    const value = this.decodeFixedSizeBase64(event.value, 8);
    if (value) {
      record.value = value;
    }

    const subValue = this.decodeFixedSizeBase64(event.subValue, 8);
    if (subValue) {
      record.subValue = subValue;
    }

    const subValueType = asNumber(event.subValueType);
    if (subValueType !== undefined) {
      record.subValueType = Math.trunc(subValueType);
    }
  }

  private handleChannelExtendedValueEvent(event: JsonRecord): void {
    const channelId = asNumber(event.id);
    if (channelId === undefined) {
      return;
    }

    const record = this.getOrCreateChannelRecord(Math.trunc(channelId));
    const decoded = this.decodeBase64(event.value);
    if (decoded) {
      record.extendedValue = decoded;
      const extendedType = asNumber(event.extendedType);
      if (extendedType !== undefined) {
        record.extendedValueType = Math.trunc(extendedType);
      }
    }
  }

  private handleChannelRelationEvent(event: JsonRecord): void {
    const childId = asNumber(event.childId);
    const parentId = asNumber(event.parentId);
    const relationType = asNumber(event.relationType);
    if (childId === undefined || parentId === undefined || relationType === undefined) {
      return;
    }

    const key = `${Math.trunc(childId)}:${Math.trunc(relationType)}`;
    const normalizedParentId = Math.trunc(parentId);
    if (normalizedParentId <= 0) {
      this.relationsByKey.delete(key);
      return;
    }

    this.relationsByKey.set(key, {
      childId: Math.trunc(childId),
      parentId: normalizedParentId,
      relationType: Math.trunc(relationType),
    });
  }

  private handleActionResultEvent(event: JsonRecord): void {
    const requestId = String(event.requestId ?? '');
    const pending = this.pendingActions.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingActions.delete(requestId);

    const ok = asBoolean(event.ok) ?? false;
    if (ok) {
      pending.resolve();
      return;
    }

    const message = typeof event.message === 'string' && event.message.trim().length > 0
      ? event.message.trim()
      : 'Action rejected by SUPLA native helper.';
    pending.reject(new Error(`SUPLA action failed (${pending.action} on channel ${pending.channelId}): ${message}`));
  }

  private handleActionExecutionResultEvent(event: JsonRecord): void {
    const resultCode = asNumber(event.resultCode);
    const actionId = asNumber(event.actionId);
    const subjectId = asNumber(event.subjectId);

    const message = `SUPLA action execution result: actionId=${String(actionId)}, subjectId=${String(subjectId)}, resultCode=${String(resultCode)}`;
    if (resultCode !== undefined && resultCode !== 0 && resultCode !== 1) {
      this.logger.warn(message);
      return;
    }

    this.logger.debug(message);
  }

  private handleHelperLogEvent(event: JsonRecord): void {
    const level = String(event.level ?? '').toLowerCase();
    const message = typeof event.message === 'string' ? event.message : JSON.stringify(event);

    if (level === 'error') {
      this.logger.error(`SUPLA native: ${message}`);
      return;
    }

    if (level === 'warn' || level === 'warning') {
      this.logger.warn(`SUPLA native: ${message}`);
      return;
    }

    if (level === 'info' || level === 'notice') {
      this.logger.debug(`SUPLA native: ${message}`);
      return;
    }

    this.logger.debug(`SUPLA native: ${message}`);
  }

  private handleHelperErrorEvent(event: JsonRecord): void {
    const code = typeof event.code === 'string' ? event.code : 'unknown';
    const message = typeof event.message === 'string' ? event.message : JSON.stringify(event);
    this.logger.warn(`SUPLA native helper error (${code}): ${message}`);
  }

  private scheduleChannelsEmit(reason: string): void {
    if (this.emitTimer) {
      return;
    }

    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      const snapshot = this.buildChannelsSnapshot();
      this.logger.debug(`SUPLA native snapshot emit (${reason}, channels=${snapshot.length}).`);
      this.events.onChannelsChanged?.(snapshot);
    }, 40);
    this.emitTimer.unref();
  }

  private buildChannelsSnapshot(): SuplaChannel[] {
    const channels = Array.from(this.channelsById.values())
      .sort((a, b) => a.id - b.id)
      .map((record) => this.buildChannel(record));

    const channelsById = new Map<number, SuplaChannel>();
    for (const channel of channels) {
      channelsById.set(channel.id, channel);
    }

    const relationsByParent = this.groupRelationsByParent();

    for (const channel of channels) {
      const relationMap = relationsByParent.get(channel.id);
      if (!relationMap) {
        continue;
      }

      const openingSensorId = this.getFirstRelationChild(relationMap, CHANNEL_RELATION_TYPE_OPENING_SENSOR);
      const partialOpeningSensorId = this.getFirstRelationChild(relationMap, CHANNEL_RELATION_TYPE_PARTIAL_OPENING_SENSOR);
      if (openingSensorId !== undefined || partialOpeningSensorId !== undefined) {
        const baseConfig = this.ensureConfig(channel.config);
        if (openingSensorId !== undefined) {
          baseConfig.openingSensorChannelId = openingSensorId;
          baseConfig.opening_sensor_channel_id = openingSensorId;
        }
        if (partialOpeningSensorId !== undefined) {
          baseConfig.openingSensorSecondaryChannelId = partialOpeningSensorId;
          baseConfig.opening_sensor_secondary_channel_id = partialOpeningSensorId;
        }
        channel.config = baseConfig;
      }

      const state = this.ensureState(channel.state);

      const mainThermometer = this.getFirstRelationChild(relationMap, CHANNEL_RELATION_TYPE_MAIN_THERMOMETER);
      if (mainThermometer !== undefined) {
        const related = channelsById.get(mainThermometer);
        const relatedTemperature = this.readTemperatureFromState(related?.state);
        const relatedHumidity = this.readHumidityFromState(related?.state);
        if (relatedTemperature !== undefined) {
          state.temperatureMain = relatedTemperature;
          state.temperature = relatedTemperature;
        }
        if (relatedHumidity !== undefined) {
          state.humidityMain = relatedHumidity;
          state.humidity = relatedHumidity;
        }
      }

      const auxFloorThermometer = this.getFirstRelationChild(relationMap, CHANNEL_RELATION_TYPE_AUX_THERMOMETER_FLOOR);
      const auxWaterThermometer = this.getFirstRelationChild(relationMap, CHANNEL_RELATION_TYPE_AUX_THERMOMETER_WATER);
      const auxHeaterThermometer = this.getFirstRelationChild(relationMap, CHANNEL_RELATION_TYPE_AUX_THERMOMETER_GENERIC_HEATER);
      const auxCoolerThermometer = this.getFirstRelationChild(relationMap, CHANNEL_RELATION_TYPE_AUX_THERMOMETER_GENERIC_COOLER);

      this.mergeAuxThermometer(state, 'temperatureAuxFloor', channelsById.get(auxFloorThermometer ?? -1)?.state);
      this.mergeAuxThermometer(state, 'temperatureAuxWater', channelsById.get(auxWaterThermometer ?? -1)?.state);
      this.mergeAuxThermometer(state, 'temperatureAuxHeater', channelsById.get(auxHeaterThermometer ?? -1)?.state);
      this.mergeAuxThermometer(state, 'temperatureAuxCooler', channelsById.get(auxCoolerThermometer ?? -1)?.state);

      channel.state = state;
    }

    return channels;
  }

  private groupRelationsByParent(): Map<number, Map<number, number[]>> {
    const grouped = new Map<number, Map<number, number[]>>();

    for (const relation of this.relationsByKey.values()) {
      let relationTypes = grouped.get(relation.parentId);
      if (!relationTypes) {
        relationTypes = new Map<number, number[]>();
        grouped.set(relation.parentId, relationTypes);
      }

      let childIds = relationTypes.get(relation.relationType);
      if (!childIds) {
        childIds = [];
        relationTypes.set(relation.relationType, childIds);
      }

      if (!childIds.includes(relation.childId)) {
        childIds.push(relation.childId);
      }
    }

    return grouped;
  }

  private getFirstRelationChild(relationMap: Map<number, number[]>, relationType: number): number | undefined {
    const childIds = relationMap.get(relationType);
    if (!childIds || childIds.length === 0) {
      return undefined;
    }

    return childIds[0];
  }

  private mergeAuxThermometer(state: SuplaChannelState, key: string, relatedState: SuplaChannelState | undefined): void {
    const value = this.readTemperatureFromState(relatedState);
    if (value !== undefined) {
      state[key] = value;
    }
  }

  private readTemperatureFromState(state: SuplaChannelState | undefined): number | undefined {
    if (!state) {
      return undefined;
    }

    const temperature = asNumber(state.temperatureMain)
      ?? asNumber(state.temperature)
      ?? asNumber(state.value);

    if (temperature === undefined || !Number.isFinite(temperature)) {
      return undefined;
    }

    return temperature;
  }

  private readHumidityFromState(state: SuplaChannelState | undefined): number | undefined {
    if (!state) {
      return undefined;
    }

    const humidity = asNumber(state.humidityMain)
      ?? asNumber(state.humidity);

    if (humidity === undefined || !Number.isFinite(humidity)) {
      return undefined;
    }

    return humidity;
  }

  private ensureConfig(config: SuplaChannelConfig | undefined): SuplaChannelConfig {
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      return { ...config };
    }

    return {};
  }

  private ensureState(state: SuplaChannelState | undefined): SuplaChannelState {
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      return { ...state };
    }

    return {};
  }

  private buildChannel(record: NativeChannelRecord): SuplaChannel {
    const state = this.decodeState(record);

    return {
      id: record.id,
      caption: record.caption,
      functionId: record.functionId,
      function: { id: record.functionId },
      connected: this.isOnline(record.online),
      state,
      config: {},
      iodevice: record.deviceId > 0
        ? { id: record.deviceId }
        : undefined,
      location: record.locationId > 0
        ? { id: record.locationId }
        : undefined,
    };
  }

  private decodeState(record: NativeChannelRecord): SuplaChannelState {
    const state: SuplaChannelState = {
      connected: this.isOnline(record.online),
      connectedCode: this.onlineCode(record.online),
    };

    const value = record.value;
    const subValue = record.subValue;

    const hi = this.byteToBoolean(value[0]);
    if (hi !== undefined) {
      state.hi = hi;
      state.on = hi;
    }

    const subValueHi = this.computeSubValueHi(subValue);
    state.subValueHi = subValueHi;
    state.sub_value_hi = subValueHi;

    switch (record.functionId) {
    case SUPLA_FUNCTION.CONTROLLING_THE_GATEWAY_LOCK:
    case SUPLA_FUNCTION.CONTROLLING_THE_GATE:
    case SUPLA_FUNCTION.CONTROLLING_THE_GARAGE_DOOR:
    case SUPLA_FUNCTION.CONTROLLING_THE_DOOR_LOCK:
      this.applyOpenCloseSubValueState(state, subValueHi);
      break;
    case SUPLA_FUNCTION.CONTROLLING_THE_ROLLER_SHUTTER:
    case SUPLA_FUNCTION.CONTROLLING_THE_ROOF_WINDOW:
    case SUPLA_FUNCTION.TERRACE_AWNING:
    case SUPLA_FUNCTION.PROJECTOR_SCREEN:
    case SUPLA_FUNCTION.CURTAIN:
    case SUPLA_FUNCTION.ROLLER_GARAGE_DOOR:
      this.applyRollerShutterState(state, value);
      break;
    case SUPLA_FUNCTION.CONTROLLING_THE_FACADE_BLIND:
    case SUPLA_FUNCTION.VERTICAL_BLIND:
      this.applyFacadeBlindState(state, value);
      break;
    case SUPLA_FUNCTION.DIGIGLASS_HORIZONTAL:
    case SUPLA_FUNCTION.DIGIGLASS_VERTICAL:
      this.applyDigiglassState(state, value);
      break;
    case SUPLA_FUNCTION.DIMMER:
    case SUPLA_FUNCTION.DIMMER_CCT:
    case SUPLA_FUNCTION.RGB_LIGHTING:
    case SUPLA_FUNCTION.DIMMER_AND_RGB_LIGHTING:
    case SUPLA_FUNCTION.DIMMER_CCT_AND_RGB:
      this.applyRgbwState(state, value);
      break;
    case SUPLA_FUNCTION.THERMOMETER:
      this.applyThermometerState(state, value);
      break;
    case SUPLA_FUNCTION.HUMIDITY:
      this.applyHumidityState(state, value);
      break;
    case SUPLA_FUNCTION.HUMIDITY_AND_TEMPERATURE:
      this.applyHumidityAndTemperatureState(state, value);
      break;
    case SUPLA_FUNCTION.THERMOSTAT:
    case SUPLA_FUNCTION.THERMOSTAT_HEATPOL_HOMEPLUS:
      this.applyHeatpolThermostatState(state, value);
      break;
    case SUPLA_FUNCTION.HVAC_THERMOSTAT:
    case SUPLA_FUNCTION.HVAC_THERMOSTAT_HEAT_COOL:
    case SUPLA_FUNCTION.HVAC_DRYER:
    case SUPLA_FUNCTION.HVAC_FAN:
    case SUPLA_FUNCTION.HVAC_THERMOSTAT_DIFFERENTIAL:
    case SUPLA_FUNCTION.HVAC_DOMESTIC_HOT_WATER:
      this.applyHvacState(state, value);
      break;
    case SUPLA_FUNCTION.VALVE_OPEN_CLOSE:
    case SUPLA_FUNCTION.VALVE_PERCENTAGE:
      this.applyValveState(state, value);
      break;
    case SUPLA_FUNCTION.CONTAINER:
    case SUPLA_FUNCTION.SEPTIC_TANK:
    case SUPLA_FUNCTION.WATER_TANK:
      this.applyContainerState(state, value);
      break;
    case SUPLA_FUNCTION.RAIN_SENSOR:
      this.applyMeasurementState(state, value);
      break;
    default:
      break;
    }

    this.applyRelayFlagsIfPresent(state, record.channelType, value);
    this.applyBinaryClosedStateDefaults(state, record.functionId);

    return state;
  }

  private applyBinaryClosedStateDefaults(state: SuplaChannelState, functionId: number): void {
    const binaryFunctions = new Set<number>([
      SUPLA_FUNCTION.OPENING_SENSOR_GATEWAY,
      SUPLA_FUNCTION.OPENING_SENSOR_GATE,
      SUPLA_FUNCTION.OPENING_SENSOR_GARAGE_DOOR,
      SUPLA_FUNCTION.OPENING_SENSOR_DOOR,
      SUPLA_FUNCTION.OPENING_SENSOR_ROLLER_SHUTTER,
      SUPLA_FUNCTION.OPENING_SENSOR_ROOF_WINDOW,
      SUPLA_FUNCTION.OPENING_SENSOR_WINDOW,
      SUPLA_FUNCTION.HOTEL_CARD_SENSOR,
      SUPLA_FUNCTION.ALARM_ARMAMENT_SENSOR,
      SUPLA_FUNCTION.MAIL_SENSOR,
      SUPLA_FUNCTION.CONTAINER_LEVEL_SENSOR,
      SUPLA_FUNCTION.BINARY_SENSOR,
      SUPLA_FUNCTION.FLOOD_SENSOR,
      SUPLA_FUNCTION.MOTION_SENSOR,
      SUPLA_FUNCTION.NO_LIQUID_SENSOR,
      SUPLA_FUNCTION.LIGHT_SWITCH,
      SUPLA_FUNCTION.POWER_SWITCH,
      SUPLA_FUNCTION.STAIRCASE_TIMER,
      SUPLA_FUNCTION.PUMP_SWITCH,
      SUPLA_FUNCTION.HEAT_OR_COLD_SOURCE_SWITCH,
      SUPLA_FUNCTION.CONTROLLING_THE_GATEWAY_LOCK,
      SUPLA_FUNCTION.CONTROLLING_THE_DOOR_LOCK,
      SUPLA_FUNCTION.CONTROLLING_THE_GATE,
      SUPLA_FUNCTION.CONTROLLING_THE_GARAGE_DOOR,
    ]);

    if (!binaryFunctions.has(functionId)) {
      return;
    }

    const hi = asBoolean(state.hi);
    if (hi === undefined) {
      return;
    }

    if (state.closed === undefined) {
      state.closed = hi;
    }

    if (state.on === undefined) {
      state.on = hi;
    }
  }

  private applyRelayFlagsIfPresent(state: SuplaChannelState, channelType: number, value: Buffer): void {
    if (channelType !== 2900 || value.length < 3) {
      return;
    }

    const flags = this.readUInt16LE(value, 1);
    if ((flags & SUPLA_RELAY_FLAG_OVERCURRENT_RELAY_OFF) !== 0) {
      state.currentOverload = true;
    }
  }

  private applyOpenCloseSubValueState(state: SuplaChannelState, subValueHi: number): void {
    const closed = (subValueHi & 0x1) === 0x1;
    const partialClosed = (subValueHi & 0x2) === 0x2;

    state.hi = closed;
    state.closed = closed;
    state.partial_hi = partialClosed;
    state.partialHi = partialClosed;
  }

  private applyRollerShutterState(state: SuplaChannelState, value: Buffer): void {
    if (value.length < 5) {
      return;
    }

    const position = this.readInt8(value, 0);
    const flags = this.readUInt16LE(value, 3);

    if (position >= 0 && position <= 100) {
      state.shut = position;
    }

    state.isCalibrating = position < 0 || (flags & RS_VALUE_FLAG_CALIBRATION_IN_PROGRESS) !== 0;
    state.calibrationError = (flags & RS_VALUE_FLAG_CALIBRATION_FAILED) !== 0;
    state.notCalibrated = (flags & RS_VALUE_FLAG_CALIBRATION_LOST) !== 0;
    state.motorProblem = (flags & RS_VALUE_FLAG_MOTOR_PROBLEM) !== 0;
  }

  private applyFacadeBlindState(state: SuplaChannelState, value: Buffer): void {
    if (value.length < 5) {
      return;
    }

    const position = this.readInt8(value, 0);
    const tilt = this.readInt8(value, 1);
    const flags = this.readUInt16LE(value, 3);

    if (position >= 0 && position <= 100) {
      state.shut = position;
    }

    if (tilt >= 0 && tilt <= 100) {
      state.tiltPercent = tilt;
    }

    state.isCalibrating = position < 0 || (flags & RS_VALUE_FLAG_CALIBRATION_IN_PROGRESS) !== 0;
    state.calibrationError = (flags & RS_VALUE_FLAG_CALIBRATION_FAILED) !== 0;
    state.notCalibrated = (flags & RS_VALUE_FLAG_CALIBRATION_LOST) !== 0;
    state.motorProblem = (flags & RS_VALUE_FLAG_MOTOR_PROBLEM) !== 0;
  }

  private applyDigiglassState(state: SuplaChannelState, value: Buffer): void {
    if (value.length < 4) {
      return;
    }

    const sectionCount = clampNumber(this.readUInt8(value, 1), 1, 16);
    const mask = this.readUInt16LE(value, 2);

    const transparent: number[] = [];
    const opaque: number[] = [];

    for (let index = 0; index < sectionCount; index++) {
      const bitSet = (mask & (1 << index)) !== 0;
      if (bitSet) {
        transparent.push(index + 1);
      } else {
        opaque.push(index + 1);
      }
    }

    state.mask = mask;
    state.transparent = transparent;
    state.opaque = opaque;
  }

  private applyRgbwState(state: SuplaChannelState, value: Buffer): void {
    if (value.length < 8) {
      return;
    }

    const brightness = clampNumber(this.readInt8(value, 0), 0, 100);
    const colorBrightness = clampNumber(this.readInt8(value, 1), 0, 100);
    const blue = clampNumber(this.readUInt8(value, 2), 0, 255);
    const green = clampNumber(this.readUInt8(value, 3), 0, 255);
    const red = clampNumber(this.readUInt8(value, 4), 0, 255);
    const dimmerCct = clampNumber(this.readInt8(value, 7), 0, 100);

    state.brightness = brightness;
    state.color_brightness = colorBrightness;
    state.colorBrightness = colorBrightness;
    state.rgb = { red, green, blue };
    state.color = this.rgbToHex(red, green, blue);

    const hsv = this.rgbToHsv(red, green, blue);
    state.hue = hsv.hue;
    state.hsv = {
      hue: hsv.hue,
      saturation: hsv.saturation,
      value: colorBrightness,
    };

    if (dimmerCct >= 0 && dimmerCct <= 100) {
      const kelvin = 2000 + (dimmerCct / 100) * (6500 - 2000);
      const colorTemperatureMired = Math.round(1_000_000 / kelvin);
      state.colorTemperature = colorTemperatureMired;
      state.color_temperature = colorTemperatureMired;
    }

    state.on = brightness > 0 || colorBrightness > 0;
    state.hi = state.on;
  }

  private applyThermometerState(state: SuplaChannelState, value: Buffer): void {
    const temperature = this.readDoubleLE(value, 0);
    if (temperature !== undefined) {
      state.temperature = temperature;
      state.temperatureMain = temperature;
      state.value = temperature;
    }
  }

  private applyHumidityState(state: SuplaChannelState, value: Buffer): void {
    const humidity = this.readInt32LE(value, 4);
    if (humidity !== undefined) {
      const normalized = humidity / 1000;
      state.humidity = normalized;
      state.humidityMain = normalized;
      state.value = normalized;
    }
  }

  private applyHumidityAndTemperatureState(state: SuplaChannelState, value: Buffer): void {
    const temperature = this.readInt32LE(value, 0);
    const humidity = this.readInt32LE(value, 4);

    if (temperature !== undefined) {
      const normalizedTemperature = temperature / 1000;
      state.temperature = normalizedTemperature;
      state.temperatureMain = normalizedTemperature;
    }

    if (humidity !== undefined) {
      const normalizedHumidity = humidity / 1000;
      state.humidity = normalizedHumidity;
      state.humidityMain = normalizedHumidity;
    }
  }

  private applyHeatpolThermostatState(state: SuplaChannelState, value: Buffer): void {
    if (value.length < 6) {
      return;
    }

    const isOn = this.readUInt8(value, 0) > 0;
    const flags = this.readUInt8(value, 1);
    const measuredTemperature = this.readInt16LE(value, 2);
    const presetTemperature = this.readInt16LE(value, 4);

    state.on = isOn;
    state.temperatureMain = measuredTemperature / 100;
    state.temperature = measuredTemperature / 100;

    const mode = this.heatpolModeFromFlags(flags, isOn);
    state.mode = mode;
    state.heating = mode === 'HEAT' && isOn;
    state.cooling = mode === 'COOL' && isOn;

    const targetTemperature = presetTemperature / 100;
    state.temperatureHeat = targetTemperature;
    state.temperatureCool = targetTemperature;
  }

  private applyHvacState(state: SuplaChannelState, value: Buffer): void {
    if (value.length < 8) {
      return;
    }

    const isOnRaw = this.readUInt8(value, 0);
    const modeRaw = this.readUInt8(value, 1);
    const setpointHeatRaw = this.readInt16LE(value, 2);
    const setpointCoolRaw = this.readInt16LE(value, 4);
    const flags = this.readUInt16LE(value, 6);

    const isOn = isOnRaw > 0;
    state.on = isOn;
    state.mode = this.hvacModeName(modeRaw);

    state.temperatureHeat = setpointHeatRaw / 100;
    state.temperatureCool = setpointCoolRaw / 100;

    state.heating = (flags & SUPLA_HVAC_VALUE_FLAG_HEATING) !== 0;
    state.cooling = (flags & SUPLA_HVAC_VALUE_FLAG_COOLING) !== 0;
    state.countdownTimer = (flags & SUPLA_HVAC_VALUE_FLAG_COUNTDOWN_TIMER) !== 0;
    state.thermometerError = (flags & SUPLA_HVAC_VALUE_FLAG_THERMOMETER_ERROR) !== 0;
    state.clockError = (flags & SUPLA_HVAC_VALUE_FLAG_CLOCK_ERROR) !== 0;
    state.forcedOffBySensor = (flags & SUPLA_HVAC_VALUE_FLAG_FORCED_OFF_BY_SENSOR) !== 0;
    state.weeklyScheduleTemporalOverride = (flags & SUPLA_HVAC_VALUE_FLAG_WEEKLY_SCHEDULE_TEMPORAL_OVERRIDE) !== 0;
    state.batteryCoverOpen = (flags & SUPLA_HVAC_VALUE_FLAG_BATTERY_COVER_OPEN) !== 0;
    state.calibrationError = (flags & SUPLA_HVAC_VALUE_FLAG_CALIBRATION_ERROR) !== 0;

    if ((flags & SUPLA_HVAC_VALUE_FLAG_WEEKLY_SCHEDULE) !== 0) {
      state.manual = false;
    } else {
      state.manual = true;
    }

    if ((flags & SUPLA_HVAC_VALUE_FLAG_COOL) !== 0 && state.mode === 'HEAT') {
      state.mode = 'COOL';
    }
  }

  private applyValveState(state: SuplaChannelState, value: Buffer): void {
    if (value.length < 2) {
      return;
    }

    const closed = this.readUInt8(value, 0) > 0;
    const flags = this.readUInt8(value, 1);

    state.closed = closed;
    state.hi = closed;
    state.on = !closed;
    state.flooding = (flags & SUPLA_VALVE_FLAG_FLOODING) !== 0;
    state.manuallyClosed = (flags & SUPLA_VALVE_FLAG_MANUALLY_CLOSED) !== 0;
    state.motorProblem = (flags & SUPLA_VALVE_FLAG_MOTOR_PROBLEM) !== 0;
  }

  private applyContainerState(state: SuplaChannelState, value: Buffer): void {
    if (value.length < 3) {
      return;
    }

    const levelRaw = this.readUInt8(value, 0);
    const flags = this.readUInt16LE(value, 1);

    let level = 0;
    if (levelRaw > 0) {
      level = clampNumber(levelRaw - 1, 0, 100);
    }

    state.fillLevel = level;
    state.value = level;
    state.warningLevel = (flags & 0x1) !== 0;
    state.alarmLevel = (flags & 0x2) !== 0;
  }

  private applyMeasurementState(state: SuplaChannelState, value: Buffer): void {
    const asDouble = this.readDoubleLE(value, 0);
    if (asDouble !== undefined) {
      state.value = asDouble;
      return;
    }

    const asInt = this.readInt32LE(value, 0);
    if (asInt !== undefined) {
      state.value = asInt;
    }
  }

  private hvacModeName(rawMode: number): string {
    switch (rawMode) {
    case 1:
      return 'OFF';
    case 2:
      return 'HEAT';
    case 3:
      return 'COOL';
    case 4:
      return 'HEAT_COOL';
    case 6:
      return 'FAN_ONLY';
    case 7:
      return 'DRY';
    default:
      return 'HEAT';
    }
  }

  private heatpolModeFromFlags(flags: number, isOn: boolean): string {
    if (!isOn) {
      return 'OFF';
    }

    if ((flags & SUPLA_THERMOSTAT_VALUE_FLAG_AUTO_MODE) !== 0) {
      return 'HEAT_COOL';
    }

    if ((flags & SUPLA_THERMOSTAT_VALUE_FLAG_COOL_MODE) !== 0) {
      return 'COOL';
    }

    if ((flags & SUPLA_THERMOSTAT_VALUE_FLAG_HEAT_MODE) !== 0) {
      return 'HEAT';
    }

    return 'HEAT';
  }

  private getOrCreateChannelRecord(channelId: number): NativeChannelRecord {
    let record = this.channelsById.get(channelId);
    if (record) {
      return record;
    }

    record = {
      id: channelId,
      functionId: 0,
      channelType: 0,
      caption: `Supla ${channelId}`,
      locationId: 0,
      deviceId: 0,
      online: 0,
      flags: 0,
      protocolVersion: 0,
      value: Buffer.alloc(8),
      subValue: Buffer.alloc(8),
      subValueType: 0,
      extendedValue: undefined,
      extendedValueType: undefined,
    };

    this.channelsById.set(channelId, record);
    return record;
  }

  private tryResolveStart(): void {
    if (!this.registeredSeen || !this.channelsEolSeen) {
      return;
    }

    this.resolveStartIfPending();
  }

  private resolveStartIfPending(): void {
    if (!this.startResolve) {
      return;
    }

    this.clearStartTimer();
    const resolve = this.startResolve;
    this.startResolve = undefined;
    this.startReject = undefined;
    this.startPromise = undefined;
    resolve();
  }

  private rejectStartIfPending(error: Error): void {
    if (!this.startReject) {
      return;
    }

    this.clearStartTimer();
    const reject = this.startReject;
    this.startResolve = undefined;
    this.startReject = undefined;
    this.startPromise = undefined;
    reject(error);
  }

  private clearStartTimer(): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = undefined;
    }
  }

  private cleanupHelperProcess(): void {
    this.helperStdout?.removeAllListeners();
    this.helperStdout?.close();
    this.helperStdout = undefined;

    this.helperStderr?.removeAllListeners();
    this.helperStderr?.close();
    this.helperStderr = undefined;

    this.helperProcess?.removeAllListeners();
    this.helperProcess = undefined;

    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
    }
  }

  private rejectPendingActions(message: string): void {
    for (const [requestId, pending] of this.pendingActions) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pendingActions.delete(requestId);
    }
  }

  private mapActionPayload(payload: Record<string, unknown>): { action: string; params: Record<string, string> } {
    const actionRaw = typeof payload.action === 'string' ? payload.action.trim().toUpperCase() : '';
    if (!actionRaw) {
      throw new Error('SUPLA action payload is missing the action field.');
    }

    const action = actionRaw === SUPLA_ACTION.OPEN_PARTIALLY
      ? SUPLA_ACTION.REVEAL_PARTIALLY
      : actionRaw;

    const params: Record<string, string> = {};

    switch (action) {
    case SUPLA_ACTION.SHUT_PARTIALLY:
    case SUPLA_ACTION.REVEAL_PARTIALLY: {
      const percentage = asNumber(payload.percentage);
      if (percentage !== undefined) {
        params.percentage = String(Math.round(clampNumber(percentage, -1, 100)));
      }

      const tilt = asNumber(payload.tilt);
      if (tilt !== undefined) {
        params.tilt = String(Math.round(clampNumber(tilt, -1, 100)));
      }
      break;
    }
    case SUPLA_ACTION.SET_RGBW_PARAMETERS: {
      const brightness = asNumber(payload.brightness);
      if (brightness !== undefined) {
        params.brightness = String(Math.round(clampNumber(brightness, 0, 100)));
      }

      const colorBrightness = asNumber(payload.color_brightness)
        ?? asNumber(payload.colorBrightness);
      if (colorBrightness !== undefined) {
        params.colorBrightness = String(Math.round(clampNumber(colorBrightness, 0, 100)));
      }

      const turnOnOff = asBoolean(payload.turnOnOff);
      if (turnOnOff !== undefined) {
        params.turnOnOff = turnOnOff ? 'true' : 'false';
      }

      const colorRandom = asBoolean(payload.colorRandom);
      if (colorRandom !== undefined) {
        params.colorRandom = colorRandom ? 'true' : 'false';
      }

      const hsvRecord = this.asRecord(payload.hsv);
      const hsvHue = asNumber(hsvRecord?.hue);
      const hsvSaturation = asNumber(hsvRecord?.saturation);
      const hsvValue = asNumber(hsvRecord?.value);

      if (hsvHue !== undefined && hsvSaturation !== undefined) {
        const normalizedHue = clampNumber(hsvHue, 0, 360);
        const normalizedSaturation = clampNumber(hsvSaturation, 0, 100);
        const normalizedValue = clampNumber(hsvValue ?? 100, 0, 100);
        const rgb = hsvToRgb(normalizedHue, normalizedSaturation, normalizedValue);
        const color = (rgb.red << 16) | (rgb.green << 8) | rgb.blue;
        params.color = String(color);

        if (params.colorBrightness === undefined) {
          params.colorBrightness = String(Math.round(normalizedValue));
        }
      }

      if (params.color === undefined) {
        const parsedColor = this.parseColor(payload.color);
        if (parsedColor !== undefined) {
          params.color = String(parsedColor);
        }
      }

      const hue = asNumber(payload.hue);
      if (hue !== undefined) {
        const normalizedHue = clampNumber(hue, 0, 360);
        const dimmerCct = this.hueToDimmerCct(normalizedHue);
        params.dimmerCct = String(dimmerCct);

        if (params.color === undefined) {
          const rgb = hsvToRgb(normalizedHue, 100, 100);
          params.color = String((rgb.red << 16) | (rgb.green << 8) | rgb.blue);
        }
      }

      const dimmerCct = asNumber(payload.dimmerCct);
      if (dimmerCct !== undefined) {
        params.dimmerCct = String(Math.round(clampNumber(dimmerCct, 0, 100)));
      }

      break;
    }
    case SUPLA_ACTION.HVAC_SET_PARAMETERS:
    case SUPLA_ACTION.HVAC_SET_TEMPERATURE:
    case SUPLA_ACTION.HVAC_SET_TEMPERATURES: {
      const mode = typeof payload.mode === 'string' ? payload.mode.trim().toUpperCase() : '';
      if (mode.length > 0) {
        params.mode = mode;
      }

      let temperatureHeat = asNumber(payload.temperatureHeat);
      let temperatureCool = asNumber(payload.temperatureCool);
      const sharedTemperature = asNumber(payload.temperature);
      if (sharedTemperature !== undefined) {
        temperatureHeat ??= sharedTemperature;
        temperatureCool ??= sharedTemperature;
      }

      if (temperatureHeat !== undefined) {
        params.temperatureHeat = temperatureHeat.toFixed(2);
      }

      if (temperatureCool !== undefined) {
        params.temperatureCool = temperatureCool.toFixed(2);
      }

      const durationSec = asNumber(payload.durationSec);
      if (durationSec !== undefined) {
        params.durationSec = String(Math.round(Math.max(0, durationSec)));
      }

      break;
    }
    case SUPLA_ACTION.SET: {
      const mask = asNumber(payload.mask);
      if (mask === undefined) {
        throw new Error('SET action requires numeric mask parameter.');
      }

      params.mask = String(Math.round(mask));
      const activeBits = asNumber(payload.activeBits);
      if (activeBits !== undefined) {
        params.activeBits = String(Math.round(activeBits));
      }
      break;
    }
    default:
      break;
    }

    return { action, params };
  }

  private hueToDimmerCct(hue: number): number {
    const kelvin = 6500 - (clampNumber(hue, 0, 359) / 359) * (6500 - 2000);
    const normalized = ((kelvin - 2000) / (6500 - 2000)) * 100;
    return Math.round(clampNumber(normalized, 0, 100));
  }

  private parseColor(value: unknown): number | undefined {
    const numeric = asNumber(value);
    if (numeric !== undefined) {
      return Math.round(clampNumber(numeric, 0, 0xFFFFFF));
    }

    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim().replace(/^0x/i, '').replace(/^#/i, '');
    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
      return undefined;
    }

    return Number.parseInt(normalized, 16);
  }

  private decodeBase64(value: unknown): Buffer | undefined {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return undefined;
    }

    try {
      return Buffer.from(value, 'base64');
    } catch {
      return undefined;
    }
  }

  private decodeFixedSizeBase64(value: unknown, expectedSize: number): Buffer | undefined {
    const decoded = this.decodeBase64(value);
    if (!decoded) {
      return undefined;
    }

    if (decoded.length === expectedSize) {
      return decoded;
    }

    if (decoded.length > expectedSize) {
      return decoded.subarray(0, expectedSize);
    }

    const padded = Buffer.alloc(expectedSize);
    decoded.copy(padded, 0, 0, decoded.length);
    return padded;
  }

  private isOnline(onlineCode: number): boolean {
    return onlineCode === 1 || onlineCode === 2;
  }

  private onlineCode(code: number): string {
    switch (code) {
    case 1:
      return 'ONLINE';
    case 2:
      return 'ONLINE_BUT_NOT_AVAILABLE';
    case 3:
      return 'OFFLINE_REMOTE_WAKEUP_NOT_SUPPORTED';
    case 4:
      return 'FIRMWARE_UPDATE_ONGOING';
    case 0:
    default:
      return 'OFFLINE';
    }
  }

  private computeSubValueHi(subValue: Buffer): number {
    const bit0 = subValue.length > 0 && subValue[0] > 0 ? 0x1 : 0;
    const bit1 = subValue.length > 1 && subValue[1] > 0 ? 0x2 : 0;
    return bit0 | bit1;
  }

  private byteToBoolean(value: number | undefined): boolean | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (value === 0) {
      return false;
    }

    if (value > 0) {
      return true;
    }

    return undefined;
  }

  private readUInt8(buffer: Buffer, offset: number): number {
    if (offset < 0 || offset >= buffer.length) {
      return 0;
    }

    return buffer.readUInt8(offset);
  }

  private readInt8(buffer: Buffer, offset: number): number {
    if (offset < 0 || offset >= buffer.length) {
      return 0;
    }

    return buffer.readInt8(offset);
  }

  private readUInt16LE(buffer: Buffer, offset: number): number {
    if (offset < 0 || offset + 2 > buffer.length) {
      return 0;
    }

    return buffer.readUInt16LE(offset);
  }

  private readInt16LE(buffer: Buffer, offset: number): number {
    if (offset < 0 || offset + 2 > buffer.length) {
      return 0;
    }

    return buffer.readInt16LE(offset);
  }

  private readInt32LE(buffer: Buffer, offset: number): number | undefined {
    if (offset < 0 || offset + 4 > buffer.length) {
      return undefined;
    }

    return buffer.readInt32LE(offset);
  }

  private readDoubleLE(buffer: Buffer, offset: number): number | undefined {
    if (offset < 0 || offset + 8 > buffer.length) {
      return undefined;
    }

    const value = buffer.readDoubleLE(offset);
    if (!Number.isFinite(value)) {
      return undefined;
    }

    return value;
  }

  private rgbToHex(red: number, green: number, blue: number): string {
    const r = clampNumber(Math.round(red), 0, 255).toString(16).padStart(2, '0');
    const g = clampNumber(Math.round(green), 0, 255).toString(16).padStart(2, '0');
    const b = clampNumber(Math.round(blue), 0, 255).toString(16).padStart(2, '0');
    return `0x${r}${g}${b}`.toUpperCase();
  }

  private rgbToHsv(red: number, green: number, blue: number): { hue: number; saturation: number; value: number } {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let hue = 0;
    if (delta !== 0) {
      if (max === r) {
        hue = 60 * (((g - b) / delta) % 6);
      } else if (max === g) {
        hue = 60 * ((b - r) / delta + 2);
      } else {
        hue = 60 * ((r - g) / delta + 4);
      }
    }

    if (hue < 0) {
      hue += 360;
    }

    const saturation = max === 0 ? 0 : (delta / max) * 100;
    const value = max * 100;

    return {
      hue: Math.round(clampNumber(hue, 0, 360)),
      saturation: Math.round(clampNumber(saturation, 0, 100)),
      value: Math.round(clampNumber(value, 0, 100)),
    };
  }

  private asRecord(value: unknown): JsonRecord | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value as JsonRecord;
  }

  private maskEmail(email: string): string {
    const at = email.indexOf('@');
    if (at <= 1) {
      return '***';
    }

    return `${email.slice(0, 2)}***${email.slice(at)}`;
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
