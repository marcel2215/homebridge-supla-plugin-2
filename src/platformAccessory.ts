import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import {
  SUPLA_ACTION,
  SUPLA_FUNCTION,
  isCctFunction,
  isDigiglassFunction,
  isDimmerFunction,
  isGarageDoorFunction,
  isReversedShadingSystemFunction,
  isRgbFunction,
  isTiltableWindowCoveringFunction,
  isVerticalBlindFunction,
  type ServiceKind,
} from './constants.js';
import type { SuplaHomebridgePlatform } from './platform.js';
import {
  getChannelFunctionId,
  getChannelDisplayName,
  type SuplaAccessoryContext,
  type SuplaChannel,
  type SuplaChannelState,
} from './types.js';
import {
  asBoolean,
  asNumber,
  clampNumber,
  estimateColorTemperatureKelvin,
  hsvToRgb,
  kelvinToMired,
  kelvinToRgb,
  miredToKelvin,
  parseHexColor,
  rgbToHsv,
} from './utils.js';

const WINDOW_POSITION_TOLERANCE = 2;
const TILT_ANGLE_TOLERANCE = 2;
const DEFAULT_COLOR_TEMPERATURE_MIREDS = 300;
const MIN_HOMEKIT_COLOR_TEMPERATURE_MIREDS = 140;
const MAX_HOMEKIT_COLOR_TEMPERATURE_MIREDS = 500;
const GATE_MOVEMENT_TIMEOUT_MS = 45_000;
const GATE_REVERSE_TOGGLE_DELAY_MS = 350;

interface PendingDoorMovement {
  expectedOpen: boolean;
  startedAt: number;
}

interface TiltCalibration {
  tilt0Angle: number;
  tilt100Angle: number;
  controlType: string;
}

export class SuplaChannelAccessory {
  public readonly serviceKind: ServiceKind;

  private mainService: Service;
  private auxiliaryService: Service | undefined;

  private channel: SuplaChannel;

  private targetPosition: number | undefined;
  private targetTiltAngle: number | undefined;
  private targetDoorState: number | undefined;
  private targetThermostatMode: number | undefined;
  private targetHeaterCoolerState: number | undefined;
  private cachedDigiglassSectionCount = 7;

  private cachedHue = 0;
  private cachedSaturation = 0;
  private cachedBrightness = 100;
  private cachedColorBrightness = 100;
  private cachedColorTemperatureMired = DEFAULT_COLOR_TEMPERATURE_MIREDS;
  private cachedThermostatHeatSetpoint = 21;
  private cachedThermostatCoolSetpoint = 24;
  private lastConnectionState: boolean | undefined;
  private pendingDoorMovement: PendingDoorMovement | undefined;
  private lastGaragePhysicalState: 'open' | 'closed' | 'partial' | 'unknown' | undefined;
  private hasDeviceFault = false;
  private lastIssueSignature = '';
  private toggleWithoutSensorsWarningLogged = false;

  constructor(
    private readonly platform: SuplaHomebridgePlatform,
    private readonly accessory: PlatformAccessory<SuplaAccessoryContext>,
    channel: SuplaChannel,
    serviceKind: ServiceKind,
  ) {
    this.serviceKind = serviceKind;
    this.channel = channel;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'SUPLA')
      .setCharacteristic(this.platform.Characteristic.Model, `Function-${getChannelFunctionId(channel)}`)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `channel-${channel.id}`);

    this.removeUserServices();

    const services = this.configureServices();
    this.mainService = services.main;
    this.auxiliaryService = services.auxiliary;

    this.updateFromChannel(channel);
  }

  updateFromChannel(channel: SuplaChannel): void {
    this.channel = channel;
    const state = channel.state ?? {};

    const connected = asBoolean(state.connected)
      ?? asBoolean(channel.connected)
      ?? true;
    this.applyConnectionState(connected);
    this.updateFaultDiagnostics(connected, state);
    this.platform.log.debug(
      `SUPLA channel ${channel.id} state update: service=${this.serviceKind}, connected=${connected}, `
      + `on=${String(state.on)}, hi=${String(state.hi)}, shut=${String(state.shut)}`,
    );
    try {
      switch (this.serviceKind) {
      case 'outlet':
        this.updateOutletState(state);
        break;
      case 'switch':
        this.updateSwitchState(state);
        break;
      case 'fan':
        this.updateFanState(state);
        break;
      case 'light':
        this.updateLightState(state);
        break;
      case 'window':
        this.updateWindowState(state);
        break;
      case 'windowCovering':
        this.updateWindowCoveringState(state);
        break;
      case 'garageDoor':
        this.updateGarageDoorState(state);
        break;
      case 'lock':
        this.updateLockState(state);
        break;
      case 'temperature':
        this.updateTemperatureState(this.mainService, state);
        break;
      case 'humidity':
        this.updateHumidityState(this.mainService, state);
        break;
      case 'temperatureHumidity':
        this.updateTemperatureHumidityState(state);
        break;
      case 'contact':
        this.updateContactState(state);
        break;
      case 'occupancy':
        this.updateOccupancyState(state);
        break;
      case 'leak':
        this.updateLeakState(state);
        break;
      case 'motion':
        this.updateMotionState(state);
        break;
      case 'thermostat':
        this.updateThermostatState(state);
        break;
      case 'humidifierDehumidifier':
        this.updateHumidifierDehumidifierState(state);
        break;
      case 'heaterCooler':
        this.updateHeaterCoolerState(state);
        break;
      case 'valve':
        this.updateValveState(state);
        break;
      default:
        break;
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.platform.log.error(
        `SUPLA channel ${channel.id}: failed to update HomeKit state for ${this.serviceKind}: ${errorText}`,
      );
    }
  }

  dispose(): void {
    // Reserved for timers/subscriptions in future revisions.
  }

  setCloudReachability(reachable: boolean): void {
    this.applyConnectionState(reachable);
  }

  private configureServices(): { main: Service; auxiliary?: Service } {
    const displayName = getChannelDisplayName(this.channel);

    switch (this.serviceKind) {
    case 'outlet': {
      const service = this.accessory.addService(this.platform.Service.Outlet, displayName);
      service.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.handleOutletSet.bind(this));
      return { main: service };
    }
    case 'switch': {
      const service = this.accessory.addService(this.platform.Service.Switch, displayName);
      service.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.handleSwitchSet.bind(this));
      return { main: service };
    }
    case 'fan': {
      const service = this.accessory.addService(this.platform.Service.Fan, displayName);
      service.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.handleFanSet.bind(this));
      return { main: service };
    }
    case 'light': {
      const service = this.accessory.addService(this.platform.Service.Lightbulb, displayName);
      const functionId = getChannelFunctionId(this.channel);
      const supportsRgb = isRgbFunction(functionId);
      const supportsCct = isCctFunction(functionId);

      service.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.handleLightOnSet.bind(this));

      service.getCharacteristic(this.platform.Characteristic.Brightness)
        .onSet(this.handleLightBrightnessSet.bind(this));

      if (supportsRgb) {
        service.getCharacteristic(this.platform.Characteristic.Hue)
          .onSet(this.handleLightHueSet.bind(this));

        service.getCharacteristic(this.platform.Characteristic.Saturation)
          .onSet(this.handleLightSaturationSet.bind(this));
      }

      if (supportsCct) {
        service.getCharacteristic(this.platform.Characteristic.ColorTemperature)
          .setProps({
            minValue: MIN_HOMEKIT_COLOR_TEMPERATURE_MIREDS,
            maxValue: MAX_HOMEKIT_COLOR_TEMPERATURE_MIREDS,
          })
          .onSet(this.handleLightColorTemperatureSet.bind(this));
      }

      return { main: service };
    }
    case 'window': {
      const service = this.accessory.addService(this.platform.Service.Window, displayName);
      service.getCharacteristic(this.platform.Characteristic.TargetPosition)
        .onSet(this.handleWindowTargetPositionSet.bind(this));
      return { main: service };
    }
    case 'windowCovering': {
      const service = this.accessory.addService(this.platform.Service.WindowCovering, displayName);
      const functionId = getChannelFunctionId(this.channel);
      service.getCharacteristic(this.platform.Characteristic.TargetPosition)
        .onSet(this.handleWindowTargetPositionSet.bind(this));

      if (isTiltableWindowCoveringFunction(functionId)) {
        const tiltTargetCharacteristic = isVerticalBlindFunction(functionId)
          ? this.platform.Characteristic.TargetVerticalTiltAngle
          : this.platform.Characteristic.TargetHorizontalTiltAngle;

        service.getCharacteristic(tiltTargetCharacteristic)
          .onSet(this.handleWindowTargetTiltSet.bind(this));
      }

      return { main: service };
    }
    case 'garageDoor': {
      const service = this.accessory.addService(this.platform.Service.GarageDoorOpener, displayName);
      service.getCharacteristic(this.platform.Characteristic.TargetDoorState)
        .onSet(this.handleGarageTargetDoorStateSet.bind(this));
      return { main: service };
    }
    case 'lock': {
      const service = this.accessory.addService(this.platform.Service.LockMechanism, displayName);
      service.getCharacteristic(this.platform.Characteristic.LockTargetState)
        .onSet(this.handleLockTargetStateSet.bind(this));
      return { main: service };
    }
    case 'temperature': {
      const service = this.accessory.addService(this.platform.Service.TemperatureSensor, displayName);
      return { main: service };
    }
    case 'humidity': {
      const service = this.accessory.addService(this.platform.Service.HumiditySensor, displayName);
      return { main: service };
    }
    case 'temperatureHumidity': {
      const tempService = this.accessory.addService(
        this.platform.Service.TemperatureSensor,
        `${displayName} Temperature`,
        'temperature',
      );
      const humidityService = this.accessory.addService(
        this.platform.Service.HumiditySensor,
        `${displayName} Humidity`,
        'humidity',
      );
      return { main: tempService, auxiliary: humidityService };
    }
    case 'contact': {
      const service = this.accessory.addService(this.platform.Service.ContactSensor, displayName);
      return { main: service };
    }
    case 'occupancy': {
      const service = this.accessory.addService(this.platform.Service.OccupancySensor, displayName);
      return { main: service };
    }
    case 'leak': {
      const service = this.accessory.addService(this.platform.Service.LeakSensor, displayName);
      return { main: service };
    }
    case 'motion': {
      const service = this.accessory.addService(this.platform.Service.MotionSensor, displayName);
      return { main: service };
    }
    case 'thermostat': {
      const service = this.accessory.addService(this.platform.Service.Thermostat, displayName);
      service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
        .onSet(this.handleThermostatModeSet.bind(this));

      const temperatureProps = this.readTemperatureRangeFromConfig(5, 35);
      service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
        .onSet(this.handleThermostatTargetTemperatureSet.bind(this))
        .setProps({
          minValue: temperatureProps.minValue,
          maxValue: temperatureProps.maxValue,
          minStep: 0.5,
        });

      service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
        .onSet(this.handleThermostatHeatingThresholdTemperatureSet.bind(this))
        .setProps({
          minValue: temperatureProps.minValue,
          maxValue: temperatureProps.maxValue,
          minStep: 0.5,
        });

      service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
        .onSet(this.handleThermostatCoolingThresholdTemperatureSet.bind(this))
        .setProps({
          minValue: temperatureProps.minValue,
          maxValue: temperatureProps.maxValue,
          minStep: 0.5,
        });

      service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
        .setProps({
          validValues: [this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS],
        })
        .updateValue(this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS);

      return { main: service };
    }
    case 'humidifierDehumidifier': {
      const service = this.accessory.addService(this.platform.Service.HumidifierDehumidifier, displayName);
      service.getCharacteristic(this.platform.Characteristic.Active)
        .onSet(this.handleHumidifierActiveSet.bind(this));
      service.getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
        .setProps({
          validValues: [this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER],
        });
      return { main: service };
    }
    case 'heaterCooler': {
      const service = this.accessory.addService(this.platform.Service.HeaterCooler, displayName);
      service.getCharacteristic(this.platform.Characteristic.Active)
        .onSet(this.handleHeaterCoolerActiveSet.bind(this));
      service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
        .setProps({
          validValues: [this.platform.Characteristic.TargetHeaterCoolerState.HEAT],
        })
        .onSet(this.handleHeaterCoolerTargetStateSet.bind(this));

      const temperatureProps = this.readTemperatureRangeFromConfig(5, 60);
      service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
        .onSet(this.handleHeaterCoolerTargetTemperatureSet.bind(this))
        .setProps({
          minValue: temperatureProps.minValue,
          maxValue: temperatureProps.maxValue,
          minStep: 0.5,
        });

      service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
        .onSet(this.handleHeaterCoolerCoolingThresholdTemperatureSet.bind(this))
        .setProps({
          minValue: temperatureProps.minValue,
          maxValue: temperatureProps.maxValue,
          minStep: 0.5,
        });

      service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
        .setProps({
          validValues: [this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS],
        })
        .updateValue(this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS);
      return { main: service };
    }
    case 'valve': {
      const service = this.accessory.addService(this.platform.Service.Valve, displayName);
      service.getCharacteristic(this.platform.Characteristic.Active)
        .onSet(this.handleValveActiveSet.bind(this));
      this.updateIfPresent(
        service,
        this.platform.Characteristic.ValveType,
        this.platform.Characteristic.ValveType.GENERIC_VALVE,
      );
      this.updateIfPresent(
        service,
        this.platform.Characteristic.IsConfigured,
        this.platform.Characteristic.IsConfigured.CONFIGURED,
      );
      return { main: service };
    }
    default: {
      const service = this.accessory.addService(this.platform.Service.Switch, displayName);
      return { main: service };
    }
    }
  }

  private removeUserServices(): void {
    for (const service of this.accessory.services) {
      if (service.UUID === this.platform.Service.AccessoryInformation.UUID) {
        continue;
      }

      this.accessory.removeService(service);
    }
  }

  private applyConnectionState(connected: boolean): void {
    if (this.lastConnectionState !== connected) {
      const displayName = getChannelDisplayName(this.channel);
      if (connected) {
        this.platform.log.info(`SUPLA channel ${this.channel.id} (${displayName}) is reachable.`);
      } else {
        this.platform.log.warn(`SUPLA channel ${this.channel.id} (${displayName}) is unreachable.`);
      }
      this.lastConnectionState = connected;
    }

    for (const service of this.accessory.services) {
      this.updateIfPresent(service, this.platform.Characteristic.StatusActive, connected);
    }

    this.applyStatusFaultState(connected);
  }

  private updateFaultDiagnostics(connected: boolean, state: SuplaChannelState): void {
    const diagnostics = this.readIssueDiagnostics(state);
    const signature = diagnostics.all.join('|');
    if (signature !== this.lastIssueSignature) {
      if (diagnostics.all.length > 0) {
        this.platform.log.warn(
          `SUPLA channel ${this.channel.id}: active issue flags detected: ${diagnostics.all.join(', ')}.`,
        );
      } else if (this.lastIssueSignature.length > 0) {
        this.platform.log.info(`SUPLA channel ${this.channel.id}: all issue flags cleared.`);
      }
      this.lastIssueSignature = signature;
    }

    this.hasDeviceFault = diagnostics.faults.length > 0;
    this.applyStatusFaultState(connected);
  }

  private readIssueDiagnostics(state: SuplaChannelState): { all: string[]; faults: string[] } {
    const all: string[] = [];
    const faults: string[] = [];
    this.includeIssueFlag(all, faults, 'motorProblem', state.motorProblem, true);
    this.includeIssueFlag(all, faults, 'notCalibrated', state.notCalibrated, true);
    this.includeIssueFlag(all, faults, 'calibrationError', state.calibrationError, true);
    this.includeIssueFlag(all, faults, 'currentOverload', state.currentOverload, true);
    this.includeIssueFlag(all, faults, 'flooding', state.flooding, true);
    this.includeIssueFlag(all, faults, 'manuallyClosed', state.manuallyClosed, true);
    this.includeIssueFlag(all, faults, 'forcedOffBySensor', state.forcedOffBySensor, true);
    this.includeIssueFlag(all, faults, 'thermometerError', state.thermometerError, true);
    this.includeIssueFlag(all, faults, 'clockError', state.clockError, true);
    this.includeIssueFlag(all, faults, 'batteryCoverOpen', state.batteryCoverOpen, false);
    this.includeIssueFlag(all, faults, 'warningLevel', state.warningLevel, false);
    this.includeIssueFlag(all, faults, 'alarmLevel', state.alarmLevel, false);

    const connectedCode = String(state.connectedCode ?? '').trim();
    if (connectedCode.length > 0 && connectedCode !== '0') {
      const normalizedCode = connectedCode.toUpperCase();
      const normalConnectedCodes = new Set([
        'CONNECTED',
        'OK',
        'ONLINE',
        'ONLINE_BUT_NOT_AVAILABLE',
        'OFFLINE',
        'OFFLINE_REMOTE_WAKEUP_NOT_SUPPORTED',
        'FIRMWARE_UPDATE_ONGOING',
      ]);
      if (!normalConnectedCodes.has(normalizedCode)) {
        all.push(`connectedCode=${connectedCode}`);
      }
    }

    return { all, faults };
  }

  private includeIssueFlag(
    all: string[],
    faults: string[],
    label: string,
    value: unknown,
    isFault: boolean,
  ): void {
    if (asBoolean(value) === true) {
      all.push(label);
      if (isFault) {
        faults.push(label);
      }
    }
  }

  private applyStatusFaultState(connected: boolean): void {
    const hasFault = !connected || this.hasDeviceFault;
    const statusFault = hasFault
      ? this.platform.Characteristic.StatusFault.GENERAL_FAULT
      : this.platform.Characteristic.StatusFault.NO_FAULT;

    for (const service of this.accessory.services) {
      this.updateIfPresent(service, this.platform.Characteristic.StatusFault, statusFault);
    }
  }

  private updateSwitchState(state: SuplaChannelState): void {
    const on = this.readOnState(state);
    this.mainService.updateCharacteristic(this.platform.Characteristic.On, on);
  }

  private updateOutletState(state: SuplaChannelState): void {
    const on = this.readOnState(state);
    this.mainService.updateCharacteristic(this.platform.Characteristic.On, on);
    this.mainService.updateCharacteristic(this.platform.Characteristic.OutletInUse, on);
  }

  private updateFanState(state: SuplaChannelState): void {
    const on = this.readOnState(state);
    this.mainService.updateCharacteristic(this.platform.Characteristic.On, on);
  }

  private updateLightState(state: SuplaChannelState): void {
    const functionId = getChannelFunctionId(this.channel);
    const supportsDimmer = isDimmerFunction(functionId);
    const supportsRgb = isRgbFunction(functionId);
    const supportsCct = isCctFunction(functionId);

    if (supportsDimmer) {
      const brightness = clampNumber(asNumber(state.brightness) ?? this.cachedBrightness, 0, 100);
      this.cachedBrightness = brightness;
      this.mainService.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
    }

    const colorBrightnessFromState = asNumber(state.color_brightness)
      ?? asNumber(state.colorBrightness);

    if (supportsRgb || supportsCct) {
      const colorBrightness = clampNumber(colorBrightnessFromState ?? this.cachedColorBrightness, 0, 100);
      this.cachedColorBrightness = colorBrightness;
    }

    if (supportsRgb) {
      const colorBrightness = this.cachedColorBrightness;
      const hsv = this.readHsv(state, colorBrightness);
      if (hsv) {
        this.cachedHue = hsv.hue;
        this.cachedSaturation = hsv.saturation;

        this.mainService.updateCharacteristic(this.platform.Characteristic.Hue, hsv.hue);
        this.mainService.updateCharacteristic(this.platform.Characteristic.Saturation, hsv.saturation);

        if (!isDimmerFunction(functionId)) {
          this.mainService.updateCharacteristic(this.platform.Characteristic.Brightness, colorBrightness);
        }
      }
    }

    if (supportsCct) {
      const colorTemperatureMired = this.readColorTemperatureMired(state);
      if (colorTemperatureMired !== undefined) {
        this.cachedColorTemperatureMired = colorTemperatureMired;
        this.mainService.updateCharacteristic(this.platform.Characteristic.ColorTemperature, colorTemperatureMired);
      }
    }

    const on = this.readOnState(state);
    this.mainService.updateCharacteristic(this.platform.Characteristic.On, on);
  }

  private updateWindowCoveringState(state: SuplaChannelState): void {
    this.updatePositionServiceState(this.mainService, state);
  }

  private updateWindowState(state: SuplaChannelState): void {
    this.updatePositionServiceState(this.mainService, state);
  }

  private updateGarageDoorState(state: SuplaChannelState): void {
    const physicalState = this.readGaragePhysicalState(state);
    this.inferGatePendingMovementFromPhysicalState(physicalState);
    const currentDoorState = this.readGarageCurrentDoorState(state, physicalState);
    const targetDoorState = this.readGarageTargetDoorState(state, physicalState);

    this.targetDoorState = targetDoorState;
    this.lastGaragePhysicalState = physicalState;

    this.mainService.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, currentDoorState);
    this.mainService.updateCharacteristic(this.platform.Characteristic.TargetDoorState, targetDoorState);

    const obstruction = this.readObstructionDetected(state);
    this.mainService.updateCharacteristic(this.platform.Characteristic.ObstructionDetected, obstruction);
    this.platform.log.debug(
      `SUPLA channel ${this.channel.id}: garage state physical=${physicalState}, current=${currentDoorState}, `
      + `target=${targetDoorState}, obstruction=${obstruction}.`,
    );
  }

  private updateLockState(state: SuplaChannelState): void {
    const unlocked = this.readUnlockedState(state);

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.LockCurrentState,
      unlocked
        ? this.platform.Characteristic.LockCurrentState.UNSECURED
        : this.platform.Characteristic.LockCurrentState.SECURED,
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.LockTargetState,
      unlocked
        ? this.platform.Characteristic.LockTargetState.UNSECURED
        : this.platform.Characteristic.LockTargetState.SECURED,
    );
  }

  private updateTemperatureState(service: Service, state: SuplaChannelState): void {
    const value = asNumber(state.temperature)
      ?? asNumber(state.temperatureMain)
      ?? asNumber(state.value)
      ?? 20;

    service.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      clampNumber(value, -100, 100),
    );
  }

  private updateHumidityState(service: Service, state: SuplaChannelState): void {
    const value = asNumber(state.humidity)
      ?? asNumber(state.humidityMain)
      ?? 0;

    service.updateCharacteristic(
      this.platform.Characteristic.CurrentRelativeHumidity,
      clampNumber(value, 0, 100),
    );
  }

  private updateTemperatureHumidityState(state: SuplaChannelState): void {
    this.updateTemperatureState(this.mainService, state);
    if (this.auxiliaryService) {
      this.updateHumidityState(this.auxiliaryService, state);
    }
  }

  private updateContactState(state: SuplaChannelState): void {
    const closed = this.readClosedState(state);
    const isOpen = closed === undefined ? false : !closed;

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.ContactSensorState,
      isOpen
        ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
  }

  private updateOccupancyState(state: SuplaChannelState): void {
    const detected = asBoolean(state.hi) ?? false;
    this.mainService.updateCharacteristic(
      this.platform.Characteristic.OccupancyDetected,
      detected
        ? this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );
  }

  private updateLeakState(state: SuplaChannelState): void {
    const functionId = getChannelFunctionId(this.channel);
    if (functionId === SUPLA_FUNCTION.RAIN_SENSOR) {
      const rainValue = asNumber(state.value);
      if (rainValue !== undefined) {
        this.mainService.updateCharacteristic(
          this.platform.Characteristic.LeakDetected,
          rainValue > 0
            ? this.platform.Characteristic.LeakDetected.LEAK_DETECTED
            : this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED,
        );
        return;
      }
    }

    const highLevelAlarm = (asBoolean(state.warningLevel) ?? false)
      || (asBoolean(state.alarmLevel) ?? false);

    const leakDetected = highLevelAlarm || (asBoolean(state.hi) ?? false);

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.LeakDetected,
      leakDetected
        ? this.platform.Characteristic.LeakDetected.LEAK_DETECTED
        : this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED,
    );
  }

  private updateMotionState(state: SuplaChannelState): void {
    const detected = asBoolean(state.hi) ?? false;
    this.mainService.updateCharacteristic(this.platform.Characteristic.MotionDetected, detected);
  }

  private updateThermostatState(state: SuplaChannelState): void {
    const temperatureRange = this.readTemperatureRangeFromConfig(5, 35);
    const currentTemperature = asNumber(state.temperatureMain)
      ?? asNumber(state.temperature)
      ?? 20;

    const heatSetpoint = asNumber(state.temperatureHeat);
    const coolSetpoint = asNumber(state.temperatureCool);
    if (heatSetpoint !== undefined) {
      this.cachedThermostatHeatSetpoint = clampNumber(heatSetpoint, temperatureRange.minValue, temperatureRange.maxValue);
    }
    if (coolSetpoint !== undefined) {
      this.cachedThermostatCoolSetpoint = clampNumber(coolSetpoint, temperatureRange.minValue, temperatureRange.maxValue);
    }

    const currentMode = this.readCurrentThermostatMode(state);
    const targetMode = this.normalizeThermostatTargetMode(this.readTargetThermostatMode(state));
    const targetTemperature = this.resolveThermostatTargetTemperature(targetMode, currentTemperature);
    const targetHumidity = asNumber(state.humidityMain)
      ?? asNumber(state.humidity);
    const heatingThreshold = clampNumber(
      heatSetpoint ?? this.cachedThermostatHeatSetpoint,
      temperatureRange.minValue,
      temperatureRange.maxValue,
    );
    const coolingThreshold = clampNumber(
      coolSetpoint ?? this.cachedThermostatCoolSetpoint,
      temperatureRange.minValue,
      temperatureRange.maxValue,
    );

    this.targetThermostatMode = targetMode;

    this.mainService.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: this.readAllowedThermostatTargetModes(),
      });

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      clampNumber(currentTemperature, -100, 100),
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.TargetTemperature,
      clampNumber(targetTemperature, temperatureRange.minValue, temperatureRange.maxValue),
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState,
      currentMode,
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.TargetHeatingCoolingState,
      targetMode,
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.HeatingThresholdTemperature,
      heatingThreshold,
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.CoolingThresholdTemperature,
      coolingThreshold,
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.TemperatureDisplayUnits,
      this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
    );

    if (targetHumidity !== undefined) {
      this.mainService.updateCharacteristic(
        this.platform.Characteristic.CurrentRelativeHumidity,
        clampNumber(targetHumidity, 0, 100),
      );
    }
  }

  private updateHumidifierDehumidifierState(state: SuplaChannelState): void {
    const active = this.readOnState(state);
    const humidity = asNumber(state.humidityMain)
      ?? asNumber(state.humidity)
      ?? 50;

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.Active,
      active
        ? this.platform.Characteristic.Active.ACTIVE
        : this.platform.Characteristic.Active.INACTIVE,
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.CurrentHumidifierDehumidifierState,
      active
        ? this.platform.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING
        : this.platform.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.TargetHumidifierDehumidifierState,
      this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.CurrentRelativeHumidity,
      clampNumber(humidity, 0, 100),
    );
  }

  private updateHeaterCoolerState(state: SuplaChannelState): void {
    const active = this.readOnState(state);
    const temperatureRange = this.readTemperatureRangeFromConfig(5, 60);
    const currentTemperature = asNumber(state.temperatureMain)
      ?? asNumber(state.temperature)
      ?? 20;
    const currentHumidity = asNumber(state.humidityMain)
      ?? asNumber(state.humidity);
    const stateHeatSetpoint = asNumber(state.temperatureHeat);
    const stateCoolSetpoint = asNumber(state.temperatureCool);
    if (stateHeatSetpoint !== undefined) {
      this.cachedThermostatHeatSetpoint = clampNumber(
        stateHeatSetpoint,
        temperatureRange.minValue,
        temperatureRange.maxValue,
      );
    }
    if (stateCoolSetpoint !== undefined) {
      this.cachedThermostatCoolSetpoint = clampNumber(
        stateCoolSetpoint,
        temperatureRange.minValue,
        temperatureRange.maxValue,
      );
    }

    const targetHeatTemperature = stateHeatSetpoint
      ?? this.cachedThermostatHeatSetpoint
      ?? currentTemperature;
    const targetCoolTemperature = stateCoolSetpoint
      ?? this.cachedThermostatCoolSetpoint
      ?? targetHeatTemperature;

    const currentState = this.readCurrentHeaterCoolerState(state, active);
    const targetState = this.normalizeHeaterCoolerTargetState(this.readTargetHeaterCoolerState(state));
    this.targetHeaterCoolerState = targetState;

    this.mainService.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: this.readAllowedHeaterCoolerTargetStates(),
      });

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.Active,
      active
        ? this.platform.Characteristic.Active.ACTIVE
        : this.platform.Characteristic.Active.INACTIVE,
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.CurrentHeaterCoolerState,
      currentState,
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.TargetHeaterCoolerState,
      targetState,
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      clampNumber(currentTemperature, -100, 100),
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.HeatingThresholdTemperature,
      clampNumber(targetHeatTemperature, temperatureRange.minValue, temperatureRange.maxValue),
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.CoolingThresholdTemperature,
      clampNumber(targetCoolTemperature, temperatureRange.minValue, temperatureRange.maxValue),
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.TemperatureDisplayUnits,
      this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
    );

    if (currentHumidity !== undefined) {
      this.updateIfPresent(
        this.mainService,
        this.platform.Characteristic.CurrentRelativeHumidity,
        clampNumber(currentHumidity, 0, 100),
      );
    }
  }

  private updateValveState(state: SuplaChannelState): void {
    const active = this.readValveActiveState(state);
    const remainingSeconds = asNumber(state.millisecondsToEnd);
    const elapsedSeconds = asNumber(state.millisecondsFromStart);

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.Active,
      active
        ? this.platform.Characteristic.Active.ACTIVE
        : this.platform.Characteristic.Active.INACTIVE,
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.InUse,
      active
        ? this.platform.Characteristic.InUse.IN_USE
        : this.platform.Characteristic.InUse.NOT_IN_USE,
    );

    if (remainingSeconds !== undefined && remainingSeconds >= 0) {
      this.updateIfPresent(
        this.mainService,
        this.platform.Characteristic.RemainingDuration,
        Math.round(remainingSeconds / 1000),
      );
    }

    if (
      remainingSeconds !== undefined
      && remainingSeconds >= 0
      && elapsedSeconds !== undefined
      && elapsedSeconds >= 0
    ) {
      this.updateIfPresent(
        this.mainService,
        this.platform.Characteristic.SetDuration,
        Math.round((remainingSeconds + elapsedSeconds) / 1000),
      );
    }
  }

  private async handleSwitchSet(value: CharacteristicValue): Promise<void> {
    const on = Boolean(value);
    await this.executeAction({ action: on ? SUPLA_ACTION.TURN_ON : SUPLA_ACTION.TURN_OFF });
  }

  private async handleOutletSet(value: CharacteristicValue): Promise<void> {
    const on = Boolean(value);
    await this.executeAction({ action: on ? SUPLA_ACTION.TURN_ON : SUPLA_ACTION.TURN_OFF });
  }

  private async handleFanSet(value: CharacteristicValue): Promise<void> {
    const on = Boolean(value);
    await this.executeAction({ action: on ? SUPLA_ACTION.TURN_ON : SUPLA_ACTION.TURN_OFF });
  }

  private async handleLightOnSet(value: CharacteristicValue): Promise<void> {
    const on = Boolean(value);
    const functionId = getChannelFunctionId(this.channel);

    if (isDimmerFunction(functionId) || isRgbFunction(functionId) || isCctFunction(functionId)) {
      await this.executeAction(this.buildLightPowerPayload(on, functionId));
      return;
    }

    await this.executeAction({ action: on ? SUPLA_ACTION.TURN_ON : SUPLA_ACTION.TURN_OFF });
  }

  private async handleLightBrightnessSet(value: CharacteristicValue): Promise<void> {
    const brightness = clampNumber(Number(value), 0, 100);
    const functionId = getChannelFunctionId(this.channel);

    this.cachedBrightness = brightness;
    const payload: Record<string, unknown> = { action: SUPLA_ACTION.SET_RGBW_PARAMETERS };

    if (isDimmerFunction(functionId)) {
      payload.brightness = Math.round(brightness);
    }

    if (isRgbFunction(functionId) && !isDimmerFunction(functionId)) {
      this.cachedColorBrightness = brightness;
      payload.hsv = {
        hue: Math.round(this.cachedHue),
        saturation: Math.round(this.cachedSaturation),
        value: Math.round(this.cachedColorBrightness),
      };
    }

    await this.executeAction(payload);
  }

  private async handleLightHueSet(value: CharacteristicValue): Promise<void> {
    this.cachedHue = clampNumber(Number(value), 0, 360);
    await this.sendRgbColorUpdate();
  }

  private async handleLightSaturationSet(value: CharacteristicValue): Promise<void> {
    this.cachedSaturation = clampNumber(Number(value), 0, 100);
    await this.sendRgbColorUpdate();
  }

  private async handleLightColorTemperatureSet(value: CharacteristicValue): Promise<void> {
    const functionId = getChannelFunctionId(this.channel);
    if (!isCctFunction(functionId)) {
      return;
    }

    const colorTemperatureMired = clampNumber(
      Number(value),
      MIN_HOMEKIT_COLOR_TEMPERATURE_MIREDS,
      MAX_HOMEKIT_COLOR_TEMPERATURE_MIREDS,
    );
    this.cachedColorTemperatureMired = colorTemperatureMired;

    const kelvin = miredToKelvin(colorTemperatureMired);
    const rgb = kelvinToRgb(kelvin);
    const hsv = rgbToHsv(rgb.red, rgb.green, rgb.blue);
    this.cachedHue = hsv.hue;
    this.cachedSaturation = hsv.saturation;
    if (isRgbFunction(functionId)) {
      this.mainService.updateCharacteristic(this.platform.Characteristic.Hue, hsv.hue);
      this.mainService.updateCharacteristic(this.platform.Characteristic.Saturation, hsv.saturation);
    }

    const colorBrightness = clampNumber(this.cachedColorBrightness, 0, 100);
    await this.executeAction({
      action: SUPLA_ACTION.SET_RGBW_PARAMETERS,
      hue: Math.round(hsv.hue),
      color_brightness: Math.round(colorBrightness),
      turnOnOff: true,
    });
  }

  private async sendRgbColorUpdate(): Promise<void> {
    const brightness = clampNumber(this.cachedColorBrightness, 0, 100);

    await this.executeAction({
      action: SUPLA_ACTION.SET_RGBW_PARAMETERS,
      hsv: {
        hue: Math.round(this.cachedHue),
        saturation: Math.round(this.cachedSaturation),
        value: Math.round(brightness),
      },
      turnOnOff: true,
    });
  }

  private buildLightPowerPayload(on: boolean, functionId: number): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      action: SUPLA_ACTION.SET_RGBW_PARAMETERS,
      turnOnOff: true,
    };

    if (isDimmerFunction(functionId)) {
      const brightness = on
        ? Math.max(1, Math.round(clampNumber(this.cachedBrightness, 0, 100)))
        : 0;
      payload.brightness = brightness;
    }

    if (isRgbFunction(functionId)) {
      const colorBrightness = on
        ? Math.max(1, Math.round(clampNumber(this.cachedColorBrightness, 0, 100)))
        : 0;
      payload.hsv = {
        hue: Math.round(clampNumber(this.cachedHue, 0, 360)),
        saturation: Math.round(clampNumber(this.cachedSaturation, 0, 100)),
        value: colorBrightness,
      };
      return payload;
    }

    if (isCctFunction(functionId) && on) {
      const rgb = kelvinToRgb(miredToKelvin(this.cachedColorTemperatureMired));
      const hsv = rgbToHsv(rgb.red, rgb.green, rgb.blue);
      this.cachedHue = hsv.hue;
      this.cachedSaturation = hsv.saturation;
    }

    if (isCctFunction(functionId)) {
      const colorBrightness = on
        ? Math.max(1, Math.round(clampNumber(this.cachedColorBrightness, 0, 100)))
        : 0;
      payload.hue = Math.round(clampNumber(this.cachedHue, 0, 360));
      payload.color_brightness = colorBrightness;
    }

    return payload;
  }

  private async handleWindowTargetPositionSet(value: CharacteristicValue): Promise<void> {
    const target = clampNumber(Number(value), 0, 100);
    this.targetPosition = target;
    const functionId = getChannelFunctionId(this.channel);

    if (isDigiglassFunction(functionId)) {
      await this.handleDigiglassTargetPositionSet(target);
      return;
    }

    if (target <= 0) {
      await this.executeAction({ action: SUPLA_ACTION.SHUT });
      return;
    }

    if (target >= 100) {
      await this.executeAction({ action: SUPLA_ACTION.REVEAL });
      return;
    }

    const closedPercent = this.closedPercentFromOpenPercent(target, functionId);
    await this.executeAction({
      action: SUPLA_ACTION.SHUT_PARTIALLY,
      percentage: Math.round(closedPercent),
    });
  }

  private async handleWindowTargetTiltSet(value: CharacteristicValue): Promise<void> {
    const functionId = getChannelFunctionId(this.channel);
    if (!isTiltableWindowCoveringFunction(functionId)) {
      return;
    }

    const angle = clampNumber(Number(value), -90, 90);
    this.targetTiltAngle = angle;
    const calibration = this.readTiltCalibration();
    const tiltPercent = Math.round(this.tiltPercentFromAngle(angle, calibration));
    const payload: Record<string, unknown> = {
      action: SUPLA_ACTION.SHUT_PARTIALLY,
      tilt: tiltPercent,
    };

    if (this.isTiltsOnlyWhenFullyClosed(calibration.controlType)) {
      payload.percentage = 100;
    }

    await this.executeAction(payload);
  }

  private async handleDigiglassTargetPositionSet(target: number): Promise<void> {
    const state = this.channel.state ?? {};
    const inferredCount = this.readDigiglassSectionCount(state);
    if (inferredCount !== undefined) {
      this.cachedDigiglassSectionCount = inferredCount;
    }

    const sectionCount = Math.max(1, this.cachedDigiglassSectionCount);
    const transparentCount = clampNumber(Math.round(sectionCount * target / 100), 0, sectionCount);

    let mask = 0;
    for (let i = 0; i < transparentCount; i++) {
      mask += 2 ** i;
    }

    await this.executeAction({
      action: SUPLA_ACTION.SET,
      mask,
    });
  }

  private async handleGarageTargetDoorStateSet(value: CharacteristicValue): Promise<void> {
    const target = Number(value);
    this.targetDoorState = target;

    const openRequested = target === this.platform.Characteristic.TargetDoorState.OPEN;
    const functionId = getChannelFunctionId(this.channel);
    const state = this.channel.state ?? {};

    if (functionId === SUPLA_FUNCTION.ROLLER_GARAGE_DOOR) {
      await this.performDoorMovement(openRequested, state, async () => {
        await this.executeAction({
          action: openRequested ? SUPLA_ACTION.REVEAL : SUPLA_ACTION.SHUT,
        });
      });
      return;
    }

    if (this.isGateToggleFunction(functionId)) {
      const hasSensors = this.hasGateSensorConfiguration();
      if (!hasSensors && !this.toggleWithoutSensorsWarningLogged) {
        this.toggleWithoutSensorsWarningLogged = true;
        this.platform.log.warn(
          `SUPLA channel ${this.channel.id}: gate controller has no opening sensor configured. `
          + 'Open/Close commands may toggle unexpectedly until sensor state is available.',
        );
      }

      const currentDoorState = this.readGarageCurrentDoorState(state);
      const alreadyInRequestedState = openRequested
        ? currentDoorState === this.platform.Characteristic.CurrentDoorState.OPEN
        : currentDoorState === this.platform.Characteristic.CurrentDoorState.CLOSED;
      if (alreadyInRequestedState) {
        this.clearPendingDoorMovement('already in requested state');
        this.platform.log.debug(
          `SUPLA channel ${this.channel.id}: gate/garage already ${
            openRequested ? 'open' : 'closed'
          }, skipping OPEN_CLOSE toggle.`,
        );
        return;
      }

      const directAction = openRequested ? SUPLA_ACTION.OPEN : SUPLA_ACTION.CLOSE;
      const hasAdvertisedActions = this.hasAdvertisedActions();
      const canUseDirectAction = hasAdvertisedActions && this.isActionAdvertised(directAction);
      const canUseToggleAction = hasAdvertisedActions
        ? this.isActionAdvertised(SUPLA_ACTION.OPEN_CLOSE)
        : true;
      const action = canUseToggleAction
        ? SUPLA_ACTION.OPEN_CLOSE
        : directAction;
      const reversingInProgress = action === SUPLA_ACTION.OPEN_CLOSE
        && (
          (currentDoorState === this.platform.Characteristic.CurrentDoorState.OPENING && !openRequested)
          || (currentDoorState === this.platform.Characteristic.CurrentDoorState.CLOSING && openRequested)
        );

      this.platform.log.debug(
        `SUPLA channel ${this.channel.id}: gate action strategy requested=${openRequested ? 'OPEN' : 'CLOSE'}, `
        + `selected=${action}, directAdvertised=${canUseDirectAction}, toggleAdvertised=${canUseToggleAction}, `
        + `hasAdvertisedActions=${hasAdvertisedActions}, hasSensors=${hasSensors}, `
        + `reversingInProgress=${reversingInProgress}.`,
      );
      await this.performDoorMovement(openRequested, state, async () => {
        if (action === SUPLA_ACTION.OPEN_CLOSE) {
          try {
            await this.executeGateToggle(reversingInProgress);
          } catch (error) {
            if (!canUseDirectAction || reversingInProgress) {
              throw error;
            }

            this.platform.log.warn(
              `SUPLA channel ${this.channel.id}: OPEN_CLOSE strategy failed, retrying with direct action ${directAction}.`,
            );
            await this.executeAction({ action: directAction });
          }
          return;
        }

        await this.executeAction({ action });
      });
      return;
    }

    if (isGarageDoorFunction(functionId)) {
      await this.performDoorMovement(openRequested, state, async () => {
        await this.executeAction({ action: openRequested ? SUPLA_ACTION.OPEN : SUPLA_ACTION.CLOSE });
      });
    }
  }

  private async performDoorMovement(
    expectedOpen: boolean,
    stateSnapshot: SuplaChannelState,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previousPending = this.pendingDoorMovement;
    this.setPendingDoorMovement(expectedOpen);
    try {
      await operation();
    } catch (error) {
      this.pendingDoorMovement = previousPending;
      this.updateGarageDoorState(stateSnapshot);
      this.platform.log.warn(
        `SUPLA channel ${this.channel.id}: reverting optimistic door movement state after action failure.`,
      );
      throw error;
    }
  }

  private async handleLockTargetStateSet(value: CharacteristicValue): Promise<void> {
    const unlockRequested = Number(value) === this.platform.Characteristic.LockTargetState.UNSECURED;

    await this.executeAction({
      action: unlockRequested ? SUPLA_ACTION.OPEN : SUPLA_ACTION.CLOSE,
    });
  }

  private async handleThermostatModeSet(value: CharacteristicValue): Promise<void> {
    const requestedMode = Number(value);
    const mode = this.normalizeThermostatTargetMode(requestedMode);
    this.targetThermostatMode = mode;

    if (mode !== requestedMode) {
      this.platform.log.warn(
        `SUPLA channel ${this.channel.id}: thermostat mode ${requestedMode} is not allowed, using ${mode}.`,
      );
    }

    if (mode === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
      await this.executeAction({ action: SUPLA_ACTION.TURN_OFF });
      return;
    }

    let modeName: string | undefined;
    if (mode === this.platform.Characteristic.TargetHeatingCoolingState.HEAT) {
      modeName = 'HEAT';
    } else if (mode === this.platform.Characteristic.TargetHeatingCoolingState.COOL) {
      modeName = 'COOL';
    } else if (mode === this.platform.Characteristic.TargetHeatingCoolingState.AUTO) {
      modeName = 'HEAT_COOL';
    }

    if (modeName) {
      await this.executeAction({
        action: SUPLA_ACTION.HVAC_SET_PARAMETERS,
        mode: modeName,
      });
    }

    if (this.isActionAdvertised(SUPLA_ACTION.TURN_ON)) {
      await this.executeAction({ action: SUPLA_ACTION.TURN_ON });
    } else {
      this.platform.log.debug(
        `SUPLA channel ${this.channel.id}: skipping TURN_ON after HVAC_SET_PARAMETERS because TURN_ON is not advertised.`,
      );
    }
  }

  private async handleThermostatTargetTemperatureSet(value: CharacteristicValue): Promise<void> {
    const temperatureRange = this.readTemperatureRangeFromConfig(5, 35);
    const temperature = clampNumber(Number(value), temperatureRange.minValue, temperatureRange.maxValue);
    const functionId = getChannelFunctionId(this.channel);
    const targetMode = this.normalizeThermostatTargetMode(
      this.targetThermostatMode ?? this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
    );

    if (functionId === SUPLA_FUNCTION.HVAC_THERMOSTAT_HEAT_COOL) {
      const offsetRange = this.readAutoOffsetRangeFromConfig();
      if (targetMode === this.platform.Characteristic.TargetHeatingCoolingState.COOL) {
        const normalized = this.normalizeHeatCoolSetpoints(
          this.cachedThermostatHeatSetpoint,
          temperature,
          temperatureRange,
          offsetRange.minGap,
          offsetRange.maxGap,
          'cool',
        );
        this.cachedThermostatHeatSetpoint = normalized.heat;
        this.cachedThermostatCoolSetpoint = normalized.cool;
        await this.executeAction({
          action: SUPLA_ACTION.HVAC_SET_TEMPERATURES,
          temperatureHeat: normalized.heat,
          temperatureCool: normalized.cool,
        });
        return;
      }

      if (targetMode === this.platform.Characteristic.TargetHeatingCoolingState.AUTO) {
        const currentGap = this.cachedThermostatCoolSetpoint - this.cachedThermostatHeatSetpoint;
        const preferredGapBase = currentGap > 0 ? currentGap : offsetRange.minGap;
        const preferredGap = offsetRange.maxGap !== undefined
          ? clampNumber(preferredGapBase, offsetRange.minGap, offsetRange.maxGap)
          : Math.max(offsetRange.minGap, preferredGapBase);
        const normalized = this.normalizeHeatCoolSetpoints(
          temperature - preferredGap / 2,
          temperature + preferredGap / 2,
          temperatureRange,
          offsetRange.minGap,
          offsetRange.maxGap,
          'center',
        );
        this.cachedThermostatHeatSetpoint = normalized.heat;
        this.cachedThermostatCoolSetpoint = normalized.cool;
        await this.executeAction({
          action: SUPLA_ACTION.HVAC_SET_TEMPERATURES,
          temperatureHeat: normalized.heat,
          temperatureCool: normalized.cool,
        });
        return;
      }

      const normalized = this.normalizeHeatCoolSetpoints(
        temperature,
        this.cachedThermostatCoolSetpoint,
        temperatureRange,
        offsetRange.minGap,
        offsetRange.maxGap,
        'heat',
      );
      this.cachedThermostatHeatSetpoint = normalized.heat;
      this.cachedThermostatCoolSetpoint = normalized.cool;
      await this.executeAction({
        action: SUPLA_ACTION.HVAC_SET_TEMPERATURES,
        temperatureHeat: normalized.heat,
        temperatureCool: normalized.cool,
      });
      return;
    }

    this.cachedThermostatHeatSetpoint = temperature;
    await this.executeAction({
      action: SUPLA_ACTION.HVAC_SET_TEMPERATURE,
      temperature: Number(temperature.toFixed(1)),
    });
  }

  private async handleThermostatHeatingThresholdTemperatureSet(value: CharacteristicValue): Promise<void> {
    const temperatureRange = this.readTemperatureRangeFromConfig(5, 35);
    const temperature = clampNumber(Number(value), temperatureRange.minValue, temperatureRange.maxValue);

    const functionId = getChannelFunctionId(this.channel);
    if (functionId === SUPLA_FUNCTION.HVAC_THERMOSTAT_HEAT_COOL) {
      const offsetRange = this.readAutoOffsetRangeFromConfig();
      const normalized = this.normalizeHeatCoolSetpoints(
        temperature,
        this.cachedThermostatCoolSetpoint,
        temperatureRange,
        offsetRange.minGap,
        offsetRange.maxGap,
        'heat',
      );
      this.cachedThermostatHeatSetpoint = normalized.heat;
      this.cachedThermostatCoolSetpoint = normalized.cool;
      await this.executeAction({
        action: SUPLA_ACTION.HVAC_SET_TEMPERATURES,
        temperatureHeat: normalized.heat,
        temperatureCool: normalized.cool,
      });
      return;
    }

    this.cachedThermostatHeatSetpoint = temperature;
    await this.executeAction({
      action: SUPLA_ACTION.HVAC_SET_TEMPERATURE,
      temperature: Number(temperature.toFixed(1)),
    });
  }

  private async handleThermostatCoolingThresholdTemperatureSet(value: CharacteristicValue): Promise<void> {
    const temperatureRange = this.readTemperatureRangeFromConfig(5, 35);
    const temperature = clampNumber(Number(value), temperatureRange.minValue, temperatureRange.maxValue);

    if (getChannelFunctionId(this.channel) !== SUPLA_FUNCTION.HVAC_THERMOSTAT_HEAT_COOL) {
      this.cachedThermostatCoolSetpoint = temperature;
      this.platform.log.debug(
        `SUPLA channel ${this.channel.id}: cooling threshold change ignored for non-heat-cool thermostat.`,
      );
      return;
    }

    const offsetRange = this.readAutoOffsetRangeFromConfig();
    const normalized = this.normalizeHeatCoolSetpoints(
      this.cachedThermostatHeatSetpoint,
      temperature,
      temperatureRange,
      offsetRange.minGap,
      offsetRange.maxGap,
      'cool',
    );
    this.cachedThermostatHeatSetpoint = normalized.heat;
    this.cachedThermostatCoolSetpoint = normalized.cool;
    await this.executeAction({
      action: SUPLA_ACTION.HVAC_SET_TEMPERATURES,
      temperatureHeat: normalized.heat,
      temperatureCool: normalized.cool,
    });
  }

  private async handleHumidifierActiveSet(value: CharacteristicValue): Promise<void> {
    const active = Number(value) === this.platform.Characteristic.Active.ACTIVE;
    await this.executeAction({ action: active ? SUPLA_ACTION.TURN_ON : SUPLA_ACTION.TURN_OFF });
  }

  private async handleHeaterCoolerActiveSet(value: CharacteristicValue): Promise<void> {
    const active = Number(value) === this.platform.Characteristic.Active.ACTIVE;
    await this.executeAction({ action: active ? SUPLA_ACTION.TURN_ON : SUPLA_ACTION.TURN_OFF });
  }

  private async handleHeaterCoolerTargetStateSet(value: CharacteristicValue): Promise<void> {
    const requestedState = Number(value);
    const targetState = this.normalizeHeaterCoolerTargetState(requestedState);
    this.targetHeaterCoolerState = targetState;

    if (targetState !== requestedState) {
      this.platform.log.warn(
        `SUPLA channel ${this.channel.id}: heater/cooler target state ${requestedState} is not allowed, using ${targetState}.`,
      );
    }

    let mode = 'HEAT';
    if (targetState === this.platform.Characteristic.TargetHeaterCoolerState.COOL) {
      mode = 'COOL';
    } else if (targetState === this.platform.Characteristic.TargetHeaterCoolerState.AUTO) {
      mode = 'HEAT_COOL';
    }

    await this.executeAction({
      action: SUPLA_ACTION.HVAC_SET_PARAMETERS,
      mode,
    });

    if (this.isActionAdvertised(SUPLA_ACTION.TURN_ON)) {
      await this.executeAction({ action: SUPLA_ACTION.TURN_ON });
    } else {
      this.platform.log.debug(
        `SUPLA channel ${this.channel.id}: skipping TURN_ON after HVAC_SET_PARAMETERS because TURN_ON is not advertised.`,
      );
    }
  }

  private async handleHeaterCoolerTargetTemperatureSet(value: CharacteristicValue): Promise<void> {
    const temperatureRange = this.readTemperatureRangeFromConfig(5, 60);
    const temperature = clampNumber(Number(value), temperatureRange.minValue, temperatureRange.maxValue);
    this.cachedThermostatHeatSetpoint = temperature;
    await this.executeAction({
      action: SUPLA_ACTION.HVAC_SET_TEMPERATURE,
      temperature: Number(temperature.toFixed(1)),
    });
  }

  private async handleHeaterCoolerCoolingThresholdTemperatureSet(value: CharacteristicValue): Promise<void> {
    const temperatureRange = this.readTemperatureRangeFromConfig(5, 60);
    const temperature = clampNumber(Number(value), temperatureRange.minValue, temperatureRange.maxValue);
    this.cachedThermostatCoolSetpoint = temperature;

    const functionId = getChannelFunctionId(this.channel);
    if (functionId === SUPLA_FUNCTION.HVAC_THERMOSTAT_HEAT_COOL) {
      await this.executeAction({
        action: SUPLA_ACTION.HVAC_SET_TEMPERATURES,
        temperatureCool: Number(temperature.toFixed(1)),
      });
      return;
    }

    this.platform.log.debug(
      `SUPLA channel ${this.channel.id}: cooling threshold change ignored for heater/cooler function ${functionId}.`,
    );
  }

  private async handleValveActiveSet(value: CharacteristicValue): Promise<void> {
    const active = Number(value) === this.platform.Characteristic.Active.ACTIVE;
    const warningFlags = active
      ? this.readValveOpenWarningFlags(this.channel.state ?? {})
      : this.readValveCloseWarningFlags(this.channel.state ?? {});
    if (warningFlags.length > 0) {
      this.platform.log.warn(
        `SUPLA channel ${this.channel.id}: ${active ? 'opening' : 'closing'} valve while warning flags are active: ${warningFlags.join(', ')}.`,
      );
    }

    await this.executeAction({
      action: active ? SUPLA_ACTION.OPEN : SUPLA_ACTION.CLOSE,
    });
  }

  private async executeAction(payload: Record<string, unknown>): Promise<void> {
    const requestedAction = typeof payload.action === 'string'
      ? payload.action.trim().toUpperCase()
      : undefined;
    if (requestedAction) {
      const possibleActions = (this.channel.possibleActions ?? [])
        .map((action) => String(action.name ?? action.caption ?? '').trim().toUpperCase())
        .filter((value) => value.length > 0);

      if (possibleActions.length > 0 && !possibleActions.includes(requestedAction)) {
        this.platform.log.warn(
          `SUPLA channel ${this.channel.id}: action ${requestedAction} not listed in possibleActions=[${possibleActions.join(', ')}]. Sending request anyway.`,
        );
      }
    }

    const payloadText = this.serializeForLog(payload);
    this.platform.log.debug(`SUPLA action request channel ${this.channel.id}: ${payloadText}`);

    try {
      await this.platform.executeChannelAction(this.channel.id, payload);
      this.platform.log.debug(`SUPLA action success channel ${this.channel.id}: ${payloadText}`);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.platform.log.error(`SUPLA action failed on channel ${this.channel.id}: ${payloadText}; error=${errorText}`);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  private isActionAdvertised(actionName: string): boolean {
    const possibleActions = (this.channel.possibleActions ?? [])
      .map((action) => String(action.name ?? action.caption ?? '').trim().toUpperCase())
      .filter((value) => value.length > 0);

    if (possibleActions.length === 0) {
      return true;
    }

    return possibleActions.includes(actionName.toUpperCase());
  }

  private hasAdvertisedActions(): boolean {
    return (this.channel.possibleActions ?? [])
      .some((action) => {
        const name = String(action.name ?? action.caption ?? '').trim();
        return name.length > 0;
      });
  }

  private readOnState(state: SuplaChannelState): boolean {
    const explicit = asBoolean(state.on);
    if (explicit !== undefined) {
      return explicit;
    }

    const brightness = asNumber(state.brightness);
    if (brightness !== undefined) {
      return brightness > 0;
    }

    const colorBrightness = asNumber(state.color_brightness)
      ?? asNumber(state.colorBrightness);
    if (colorBrightness !== undefined) {
      return colorBrightness > 0;
    }

    return asBoolean(state.hi) ?? false;
  }

  private readHsv(state: SuplaChannelState, fallbackBrightness: number): { hue: number; saturation: number } | undefined {
    const stateRecord = state as Record<string, unknown>;
    const directHue = asNumber(state.hue)
      ?? asNumber(stateRecord.hue);
    const directSaturation = asNumber(stateRecord.saturation);
    if (directHue !== undefined && directSaturation !== undefined) {
      return {
        hue: clampNumber(directHue, 0, 360),
        saturation: clampNumber(directSaturation, 0, 100),
      };
    }

    const hsv = state.hsv;
    const hueFromState = asNumber(hsv?.hue);
    const saturationFromState = asNumber(hsv?.saturation);
    if (hueFromState !== undefined && saturationFromState !== undefined) {
      return {
        hue: clampNumber(hueFromState, 0, 360),
        saturation: clampNumber(saturationFromState, 0, 100),
      };
    }

    const rgb = state.rgb;
    const rgbRed = asNumber(rgb?.red);
    const rgbGreen = asNumber(rgb?.green);
    const rgbBlue = asNumber(rgb?.blue);
    if (rgbRed !== undefined && rgbGreen !== undefined && rgbBlue !== undefined) {
      const converted = rgbToHsv(rgbRed, rgbGreen, rgbBlue);
      return {
        hue: converted.hue,
        saturation: converted.saturation,
      };
    }

    const parsedColor = parseHexColor(state.color);
    if (parsedColor) {
      const parsedHsv = rgbToHsv(parsedColor.red, parsedColor.green, parsedColor.blue);
      const adjustedRgb = hsvToRgb(
        parsedHsv.hue,
        parsedHsv.saturation,
        fallbackBrightness,
      );

      const converted = rgbToHsv(adjustedRgb.red, adjustedRgb.green, adjustedRgb.blue);
      return {
        hue: converted.hue,
        saturation: converted.saturation,
      };
    }

    return undefined;
  }

  private updatePositionServiceState(service: Service, state: SuplaChannelState): void {
    const functionId = getChannelFunctionId(this.channel);
    const position = isDigiglassFunction(functionId)
      ? this.readDigiglassOpenPercent(state)
      : this.openPercentFromState(state);
    if (position === undefined) {
      return;
    }

    if (
      this.targetPosition !== undefined
      && Math.abs(this.targetPosition - position) <= WINDOW_POSITION_TOLERANCE
    ) {
      this.targetPosition = undefined;
    }

    const target = this.targetPosition ?? position;
    let positionState = this.platform.Characteristic.PositionState.STOPPED;

    if (Math.abs(target - position) > WINDOW_POSITION_TOLERANCE) {
      positionState = target > position
        ? this.platform.Characteristic.PositionState.INCREASING
        : this.platform.Characteristic.PositionState.DECREASING;
    }

    service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, position);
    service.updateCharacteristic(this.platform.Characteristic.TargetPosition, target);
    service.updateCharacteristic(this.platform.Characteristic.PositionState, positionState);
    this.updateIfPresent(
      service,
      this.platform.Characteristic.ObstructionDetected,
      this.readObstructionDetected(state),
    );

    if (!isTiltableWindowCoveringFunction(functionId)) {
      return;
    }

    const tiltPercent = this.readTiltPercent(state);
    if (tiltPercent === undefined) {
      return;
    }

    const tiltCalibration = this.readTiltCalibration();
    const currentTiltAngle = this.tiltAngleFromPercent(tiltPercent, tiltCalibration);
    if (
      this.targetTiltAngle !== undefined
      && Math.abs(this.targetTiltAngle - currentTiltAngle) <= TILT_ANGLE_TOLERANCE
    ) {
      this.targetTiltAngle = undefined;
    }
    const targetTiltAngle = this.targetTiltAngle ?? currentTiltAngle;

    if (isVerticalBlindFunction(functionId)) {
      service.updateCharacteristic(this.platform.Characteristic.CurrentVerticalTiltAngle, currentTiltAngle);
      service.updateCharacteristic(this.platform.Characteristic.TargetVerticalTiltAngle, targetTiltAngle);
      return;
    }

    service.updateCharacteristic(this.platform.Characteristic.CurrentHorizontalTiltAngle, currentTiltAngle);
    service.updateCharacteristic(this.platform.Characteristic.TargetHorizontalTiltAngle, targetTiltAngle);
  }

  private readDigiglassOpenPercent(state: SuplaChannelState): number | undefined {
    const sectionCount = this.readDigiglassSectionCount(state);
    if (sectionCount !== undefined) {
      this.cachedDigiglassSectionCount = sectionCount;

      const transparent = this.readDigiglassTransparentSections(state).length;
      return clampNumber((transparent / sectionCount) * 100, 0, 100);
    }

    const mask = asNumber(state.mask);
    if (mask !== undefined && mask >= 0) {
      const normalizedMask = Math.floor(mask);
      const inferredSectionCount = Math.max(1, normalizedMask.toString(2).length);
      this.cachedDigiglassSectionCount = inferredSectionCount;

      const transparentSections = this.countSetBits(normalizedMask);
      return clampNumber((transparentSections / inferredSectionCount) * 100, 0, 100);
    }

    return undefined;
  }

  private readDigiglassSectionCount(state: SuplaChannelState): number | undefined {
    const transparent = this.readDigiglassTransparentSections(state);
    const opaque = this.readDigiglassOpaqueSections(state);
    const allSections = [...transparent, ...opaque];
    if (allSections.length === 0) {
      return undefined;
    }

    return Math.max(1, Math.max(...allSections));
  }

  private readDigiglassTransparentSections(state: SuplaChannelState): number[] {
    if (!Array.isArray(state.transparent)) {
      return [];
    }

    return state.transparent
      .map((value) => asNumber(value))
      .filter((value): value is number => value !== undefined && value > 0)
      .map((value) => Math.floor(value));
  }

  private readDigiglassOpaqueSections(state: SuplaChannelState): number[] {
    if (!Array.isArray(state.opaque)) {
      return [];
    }

    return state.opaque
      .map((value) => asNumber(value))
      .filter((value): value is number => value !== undefined && value > 0)
      .map((value) => Math.floor(value));
  }

  private countSetBits(value: number): number {
    let count = 0;
    let current = Math.floor(value);
    while (current > 0) {
      if ((current & 1) === 1) {
        count += 1;
      }
      current >>= 1;
    }
    return count;
  }

  private readTiltPercent(state: SuplaChannelState): number | undefined {
    const tiltCalibration = this.readTiltCalibration();
    const stateRecord = state as Record<string, unknown>;
    const tiltPercent = asNumber(state.tiltPercent)
      ?? asNumber(stateRecord.tilt_percent)
      ?? asNumber(stateRecord.tilt);
    if (tiltPercent !== undefined) {
      return clampNumber(tiltPercent, 0, 100);
    }

    const tiltAngle = asNumber(state.tiltAngle)
      ?? asNumber(stateRecord.tilt_angle);
    if (tiltAngle !== undefined) {
      const normalizedPercent = this.tiltPercentFromPhysicalAngle(tiltAngle, tiltCalibration);
      if (normalizedPercent !== undefined) {
        return normalizedPercent;
      }

      return clampNumber((tiltAngle * 100) / 180, 0, 100);
    }

    return undefined;
  }

  private tiltAngleFromPercent(tiltPercent: number, calibration: TiltCalibration): number {
    const physicalAngle = calibration.tilt0Angle
      + ((calibration.tilt100Angle - calibration.tilt0Angle) * tiltPercent / 100);
    return clampNumber(Math.round(physicalAngle - 90), -90, 90);
  }

  private tiltPercentFromAngle(angle: number, calibration: TiltCalibration): number {
    const physicalAngle = angle + 90;
    const mapped = this.tiltPercentFromPhysicalAngle(physicalAngle, calibration);
    if (mapped !== undefined) {
      return mapped;
    }

    return clampNumber(((angle + 90) * 100) / 180, 0, 100);
  }

  private tiltPercentFromPhysicalAngle(physicalAngle: number, calibration: TiltCalibration): number | undefined {
    const delta = calibration.tilt100Angle - calibration.tilt0Angle;
    if (Math.abs(delta) < 0.001) {
      return undefined;
    }

    return clampNumber(((physicalAngle - calibration.tilt0Angle) * 100) / delta, 0, 100);
  }

  private openPercentFromState(state: SuplaChannelState): number | undefined {
    const functionId = getChannelFunctionId(this.channel);
    const shut = asNumber(state.shut);
    if (shut !== undefined) {
      if (isReversedShadingSystemFunction(functionId)) {
        return clampNumber(shut, 0, 100);
      }

      return clampNumber(100 - shut, 0, 100);
    }

    const gateLikeState = this.readGateLikeState(state);
    if (gateLikeState === 'open') {
      return 100;
    }
    if (gateLikeState === 'closed') {
      return 0;
    }
    if (gateLikeState === 'partial') {
      return 50;
    }

    return undefined;
  }

  private closedPercentFromOpenPercent(openPercent: number, functionId: number): number {
    if (isReversedShadingSystemFunction(functionId)) {
      return clampNumber(openPercent, 0, 100);
    }

    return clampNumber(100 - openPercent, 0, 100);
  }

  private readGarageCurrentDoorState(
    state: SuplaChannelState,
    physicalState: 'open' | 'closed' | 'partial' | 'unknown' = this.readGaragePhysicalState(state),
  ): number {
    if (physicalState === 'open') {
      this.clearPendingDoorMovement('state indicates open');
      return this.platform.Characteristic.CurrentDoorState.OPEN;
    }
    if (physicalState === 'closed') {
      this.clearPendingDoorMovement('state indicates closed');
      return this.platform.Characteristic.CurrentDoorState.CLOSED;
    }

    const pending = this.getPendingDoorMovement();
    if (physicalState === 'partial') {
      if (pending) {
        return pending.expectedOpen
          ? this.platform.Characteristic.CurrentDoorState.OPENING
          : this.platform.Characteristic.CurrentDoorState.CLOSING;
      }

      if (this.shouldTreatPartialAsOpen()) {
        return this.platform.Characteristic.CurrentDoorState.OPEN;
      }

      return this.platform.Characteristic.CurrentDoorState.STOPPED;
    }

    if (pending) {
      return pending.expectedOpen
        ? this.platform.Characteristic.CurrentDoorState.OPENING
        : this.platform.Characteristic.CurrentDoorState.CLOSING;
    }

    return this.platform.Characteristic.CurrentDoorState.STOPPED;
  }

  private readGarageTargetDoorState(
    state: SuplaChannelState,
    physicalState: 'open' | 'closed' | 'partial' | 'unknown' = this.readGaragePhysicalState(state),
  ): number {
    const pending = this.getPendingDoorMovement();
    if (physicalState === 'open') {
      return this.platform.Characteristic.TargetDoorState.OPEN;
    }
    if (physicalState === 'closed') {
      return this.platform.Characteristic.TargetDoorState.CLOSED;
    }

    if (physicalState === 'partial' && this.shouldTreatPartialAsOpen()) {
      if (pending) {
        return pending.expectedOpen
          ? this.platform.Characteristic.TargetDoorState.OPEN
          : this.platform.Characteristic.TargetDoorState.CLOSED;
      }

      return this.platform.Characteristic.TargetDoorState.OPEN;
    }

    if (pending) {
      return pending.expectedOpen
        ? this.platform.Characteristic.TargetDoorState.OPEN
        : this.platform.Characteristic.TargetDoorState.CLOSED;
    }

    return this.targetDoorState ?? this.platform.Characteristic.TargetDoorState.CLOSED;
  }

  private inferGatePendingMovementFromPhysicalState(
    physicalState: 'open' | 'closed' | 'partial' | 'unknown',
  ): void {
    const functionId = getChannelFunctionId(this.channel);
    if (!this.isGateToggleFunction(functionId)) {
      return;
    }

    if (this.getPendingDoorMovement()) {
      return;
    }

    if (physicalState !== 'partial') {
      return;
    }

    if (this.lastGaragePhysicalState === 'closed') {
      this.platform.log.debug(
        `SUPLA channel ${this.channel.id}: inferred opening movement from closed->partial transition.`,
      );
      this.setPendingDoorMovement(true);
      return;
    }

    if (this.lastGaragePhysicalState === 'open') {
      this.platform.log.debug(
        `SUPLA channel ${this.channel.id}: inferred closing movement from open->partial transition.`,
      );
      this.setPendingDoorMovement(false);
    }
  }

  private readGaragePhysicalState(state: SuplaChannelState): 'open' | 'closed' | 'partial' | 'unknown' {
    const openPercent = this.openPercentFromState(state);
    if (openPercent !== undefined) {
      const functionId = getChannelFunctionId(this.channel);
      const closedThreshold = this.isGateToggleFunction(functionId) ? 0 : 5;
      const openThreshold = this.isGateToggleFunction(functionId) ? 100 : 95;

      if (openPercent <= closedThreshold) {
        return 'closed';
      }

      if (openPercent >= openThreshold) {
        return 'open';
      }

      return 'partial';
    }

    const gateLikeState = this.readGateLikeState(state);
    if (gateLikeState) {
      return gateLikeState;
    }

    return 'unknown';
  }

  private readUnlockedState(state: SuplaChannelState): boolean {
    const closed = this.readClosedState(state);
    if (closed !== undefined) {
      return !closed;
    }

    return asBoolean(state.on) ?? false;
  }

  private readCurrentThermostatMode(state: SuplaChannelState): number {
    if (asBoolean(state.heating)) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
    }

    if (asBoolean(state.cooling)) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
    }

    return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
  }

  private readCurrentHeaterCoolerState(state: SuplaChannelState, active: boolean): number {
    if (!active) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }

    if (asBoolean(state.cooling)) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
    }

    if (asBoolean(state.heating)) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
    }

    const mode = String(state.mode ?? '').toUpperCase();
    if (mode === 'COOL') {
      return this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
    }

    return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
  }

  private readTargetHeaterCoolerState(state: SuplaChannelState): number {
    const mode = String(state.mode ?? '').toUpperCase();
    if (mode === 'HEAT_COOL') {
      return this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
    }

    if (mode === 'COOL') {
      return this.platform.Characteristic.TargetHeaterCoolerState.COOL;
    }

    return this.platform.Characteristic.TargetHeaterCoolerState.HEAT;
  }

  private readTargetThermostatMode(state: SuplaChannelState): number {
    const mode = String(state.mode ?? '').toUpperCase();
    const isOn = asBoolean(state.on);

    if (mode === 'HEAT_COOL') {
      return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
    }

    if (mode === 'COOL') {
      return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
    }

    if (mode === 'HEAT') {
      return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
    }

    if (mode === 'OFF' || isOn === false) {
      return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }

    if (asBoolean(state.cooling)) {
      return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
    }

    return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
  }

  private readValveActiveState(state: SuplaChannelState): boolean {
    const closed = this.readClosedState(state);
    if (closed !== undefined) {
      return !closed;
    }

    const on = asBoolean(state.on);
    if (on !== undefined) {
      return on;
    }

    const value = asNumber(state.value);
    if (value !== undefined) {
      return value > 0;
    }

    return false;
  }

  private readClosedState(state: SuplaChannelState): boolean | undefined {
    const closed = this.readStrictBinaryState(state.closed);
    if (closed !== undefined) {
      return closed;
    }

    const hi = this.readStrictBinaryState(state.hi);
    if (hi !== undefined) {
      return hi;
    }

    return undefined;
  }

  private readStrictBinaryState(value: unknown): boolean | undefined {
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

  private readGateLikeState(state: SuplaChannelState): 'open' | 'closed' | 'partial' | undefined {
    const stateRecord = state as Record<string, unknown>;
    const rawValue = asNumber(stateRecord.subValueHi)
      ?? asNumber(stateRecord.sub_value_hi)
      ?? asNumber(stateRecord.valueHi)
      ?? asNumber(stateRecord.value_hi);

    if (rawValue !== undefined) {
      const normalizedValue = Math.trunc(rawValue);
      if ((normalizedValue & 0x2) === 0x2 && (normalizedValue & 0x1) === 0) {
        return 'partial';
      }

      if (normalizedValue > 0) {
        return 'closed';
      }

      return 'open';
    }

    const hi = this.readStrictBinaryState(state.hi);
    const partialHi = asBoolean(state.partial_hi)
      ?? asBoolean(state.partialHi)
      ?? false;

    if (partialHi && hi === false) {
      return 'partial';
    }

    if (hi !== undefined) {
      return hi ? 'closed' : 'open';
    }

    const closed = this.readStrictBinaryState(state.closed);
    if (closed !== undefined) {
      return closed ? 'closed' : 'open';
    }

    return undefined;
  }

  private readObstructionDetected(state: SuplaChannelState): boolean {
    return (asBoolean(state.motorProblem) ?? false)
      || (asBoolean(state.notCalibrated) ?? false)
      || (asBoolean(state.calibrationError) ?? false)
      || (asBoolean(state.currentOverload) ?? false);
  }

  private readValveOpenWarningFlags(state: SuplaChannelState): string[] {
    const warnings: string[] = [];
    if (asBoolean(state.flooding) === true) {
      warnings.push('flooding');
    }
    if (asBoolean(state.manuallyClosed) === true) {
      warnings.push('manuallyClosed');
    }
    if (asBoolean(state.motorProblem) === true) {
      warnings.push('motorProblem');
    }
    return warnings;
  }

  private readValveCloseWarningFlags(state: SuplaChannelState): string[] {
    const warnings: string[] = [];
    if (asBoolean(state.motorProblem) === true) {
      warnings.push('motorProblem');
    }
    return warnings;
  }

  private readColorTemperatureMired(state: SuplaChannelState): number | undefined {
    const stateRecord = state as Record<string, unknown>;
    const explicitColorTemperature = asNumber(stateRecord.colorTemperature)
      ?? asNumber(stateRecord.color_temperature)
      ?? asNumber(stateRecord.colorTemp)
      ?? asNumber(stateRecord.color_temp);
    if (explicitColorTemperature !== undefined) {
      if (explicitColorTemperature >= MIN_HOMEKIT_COLOR_TEMPERATURE_MIREDS && explicitColorTemperature <= MAX_HOMEKIT_COLOR_TEMPERATURE_MIREDS) {
        return clampNumber(
          Math.round(explicitColorTemperature),
          MIN_HOMEKIT_COLOR_TEMPERATURE_MIREDS,
          MAX_HOMEKIT_COLOR_TEMPERATURE_MIREDS,
        );
      }

      const asKelvin = explicitColorTemperature > 1000
        ? explicitColorTemperature
        : miredToKelvin(explicitColorTemperature);
      return clampNumber(
        kelvinToMired(asKelvin),
        MIN_HOMEKIT_COLOR_TEMPERATURE_MIREDS,
        MAX_HOMEKIT_COLOR_TEMPERATURE_MIREDS,
      );
    }

    const hue = asNumber(state.hue)
      ?? asNumber(state.hsv?.hue)
      ?? asNumber(stateRecord.hue);
    if (hue !== undefined) {
      const normalizedHue = clampNumber(hue, 0, 359);
      const coldKelvin = 6500;
      const warmKelvin = 2000;
      const kelvin = coldKelvin - (normalizedHue / 359) * (coldKelvin - warmKelvin);
      return clampNumber(
        kelvinToMired(kelvin),
        MIN_HOMEKIT_COLOR_TEMPERATURE_MIREDS,
        MAX_HOMEKIT_COLOR_TEMPERATURE_MIREDS,
      );
    }

    const parsedColor = parseHexColor(state.color);
    if (!parsedColor) {
      return undefined;
    }

    const estimatedKelvin = estimateColorTemperatureKelvin(parsedColor.red, parsedColor.green, parsedColor.blue);
    return clampNumber(
      kelvinToMired(estimatedKelvin),
      MIN_HOMEKIT_COLOR_TEMPERATURE_MIREDS,
      MAX_HOMEKIT_COLOR_TEMPERATURE_MIREDS,
    );
  }

  private readConfigRecord(): Record<string, unknown> {
    const config = this.channel.config;
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      return config as Record<string, unknown>;
    }

    return {};
  }

  private readTiltCalibration(): TiltCalibration {
    const config = this.readConfigRecord();
    const nestedConfig = this.asRecord(config.controllingTheFacadeBlind)
      ?? this.asRecord(config.controlling_the_facade_blind);

    const rawTilt0Angle = asNumber(config.tilt0Angle)
      ?? asNumber(config.tilt0_angle)
      ?? asNumber(nestedConfig?.tilt0Angle)
      ?? asNumber(nestedConfig?.tilt0_angle)
      ?? 0;
    const rawTilt100Angle = asNumber(config.tilt100Angle)
      ?? asNumber(config.tilt100_angle)
      ?? asNumber(nestedConfig?.tilt100Angle)
      ?? asNumber(nestedConfig?.tilt100_angle)
      ?? 180;
    const controlTypeValue = config.tiltControlType
      ?? config.tilt_control_type
      ?? nestedConfig?.tiltControlType
      ?? nestedConfig?.tilt_control_type;

    let tilt0Angle = clampNumber(rawTilt0Angle, 0, 360);
    let tilt100Angle = clampNumber(rawTilt100Angle, 0, 360);
    if (Math.abs(tilt100Angle - tilt0Angle) < 0.001) {
      tilt0Angle = 0;
      tilt100Angle = 180;
    }

    return {
      tilt0Angle,
      tilt100Angle,
      controlType: typeof controlTypeValue === 'string' ? controlTypeValue : String(controlTypeValue ?? ''),
    };
  }

  private isTiltsOnlyWhenFullyClosed(rawControlType: string): boolean {
    const normalized = rawControlType.trim().toLowerCase().replace(/[_\-\s]/g, '');
    return normalized === 'tiltsonlywhenfullyclosed' || normalized === '3';
  }

  private hasGateSensorConfiguration(): boolean {
    const config = this.readConfigRecord();
    const nestedConfig = this.asRecord(config.controllingTheGate)
      ?? this.asRecord(config.controlling_the_gate)
      ?? this.asRecord(config.controllingTheGarageDoor)
      ?? this.asRecord(config.controlling_the_garage_door);
    const openingSensorChannelId = asNumber(this.channel.param2)
      ?? asNumber(config.openingSensorChannelId)
      ?? asNumber(config.opening_sensor_channel_id)
      ?? asNumber(nestedConfig?.openingSensorChannelId)
      ?? asNumber(nestedConfig?.opening_sensor_channel_id);
    const partialSensorChannelId = asNumber(this.channel.param3)
      ?? asNumber(config.openingSensorSecondaryChannelId)
      ?? asNumber(config.opening_sensor_secondary_channel_id)
      ?? asNumber(nestedConfig?.openingSensorSecondaryChannelId)
      ?? asNumber(nestedConfig?.opening_sensor_secondary_channel_id);

    return (openingSensorChannelId ?? 0) > 0 || (partialSensorChannelId ?? 0) > 0;
  }

  private isGateToggleFunction(functionId: number): boolean {
    return functionId === SUPLA_FUNCTION.CONTROLLING_THE_GATE
      || functionId === SUPLA_FUNCTION.CONTROLLING_THE_GARAGE_DOOR;
  }

  private shouldTreatPartialAsOpen(): boolean {
    return this.isGateToggleFunction(getChannelFunctionId(this.channel));
  }

  private setPendingDoorMovement(expectedOpen: boolean): void {
    this.pendingDoorMovement = {
      expectedOpen,
      startedAt: Date.now(),
    };

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.CurrentDoorState,
      expectedOpen
        ? this.platform.Characteristic.CurrentDoorState.OPENING
        : this.platform.Characteristic.CurrentDoorState.CLOSING,
    );
    this.mainService.updateCharacteristic(
      this.platform.Characteristic.TargetDoorState,
      expectedOpen
        ? this.platform.Characteristic.TargetDoorState.OPEN
        : this.platform.Characteristic.TargetDoorState.CLOSED,
    );

    this.platform.log.debug(
      `SUPLA channel ${this.channel.id}: pending door movement set to ${expectedOpen ? 'open' : 'closed'}.`,
    );
  }

  private getPendingDoorMovement(): PendingDoorMovement | undefined {
    const pending = this.pendingDoorMovement;
    if (!pending) {
      return undefined;
    }

    if (Date.now() - pending.startedAt > GATE_MOVEMENT_TIMEOUT_MS) {
      this.platform.log.warn(
        `SUPLA channel ${this.channel.id}: pending door movement timed out after ${GATE_MOVEMENT_TIMEOUT_MS}ms.`,
      );
      this.pendingDoorMovement = undefined;
      return undefined;
    }

    return pending;
  }

  private clearPendingDoorMovement(reason: string): void {
    if (!this.pendingDoorMovement) {
      return;
    }

    this.platform.log.debug(
      `SUPLA channel ${this.channel.id}: clearing pending door movement (${reason}).`,
    );
    this.pendingDoorMovement = undefined;
  }

  private async executeGateToggle(reversingInProgress: boolean): Promise<void> {
    if (reversingInProgress) {
      this.platform.log.debug(
        `SUPLA channel ${this.channel.id}: reversing gate movement via OPEN_CLOSE double pulse.`,
      );
      await this.executeAction({ action: SUPLA_ACTION.OPEN_CLOSE });
      await this.delay(GATE_REVERSE_TOGGLE_DELAY_MS);
    }

    await this.executeAction({ action: SUPLA_ACTION.OPEN_CLOSE });
  }

  private readTemperatureRangeFromConfig(defaultMin: number, defaultMax: number): { minValue: number; maxValue: number } {
    const config = this.readConfigRecord();
    const hvacConfig = this.readHvacConfigRecord(config);
    const constraints = this.asRecord(config.temperatureConstraints)
      ?? this.asRecord(config.temperature_constraints)
      ?? this.asRecord(hvacConfig?.temperatureConstraints)
      ?? this.asRecord(hvacConfig?.temperature_constraints);
    const temperatures = this.asRecord(config.temperatures)
      ?? this.asRecord(hvacConfig?.temperatures);
    const controlType = config.temperatureControlType
      ?? config.temperature_control_type
      ?? hvacConfig?.temperatureControlType
      ?? hvacConfig?.temperature_control_type;
    const useAuxRange = this.isAuxTemperatureControlType(controlType);
    const sources = [constraints, temperatures];

    const minValue = useAuxRange
      ? this.readNumberFromRecords(
        sources,
        'auxMin',
        'aux_min',
        'auxMinSetpoint',
        'aux_min_setpoint',
        'roomMin',
        'room_min',
      )
      : this.readNumberFromRecords(
        sources,
        'roomMin',
        'room_min',
        'auxMin',
        'aux_min',
        'auxMinSetpoint',
        'aux_min_setpoint',
      );
    const maxValue = useAuxRange
      ? this.readNumberFromRecords(
        sources,
        'auxMax',
        'aux_max',
        'auxMaxSetpoint',
        'aux_max_setpoint',
        'roomMax',
        'room_max',
      )
      : this.readNumberFromRecords(
        sources,
        'roomMax',
        'room_max',
        'auxMax',
        'aux_max',
        'auxMaxSetpoint',
        'aux_max_setpoint',
      );
    const resolvedMin = minValue ?? defaultMin;
    const resolvedMax = maxValue ?? defaultMax;

    if (!Number.isFinite(resolvedMin) || !Number.isFinite(resolvedMax) || resolvedMin >= resolvedMax) {
      return { minValue: defaultMin, maxValue: defaultMax };
    }

    const normalizedMin = clampNumber(resolvedMin, -50, 100);
    const normalizedMax = clampNumber(resolvedMax, -50, 100);
    if (normalizedMin >= normalizedMax) {
      return { minValue: defaultMin, maxValue: defaultMax };
    }

    return {
      minValue: normalizedMin,
      maxValue: normalizedMax,
    };
  }

  private readAllowedThermostatTargetModes(): number[] {
    const config = this.readConfigRecord();
    const hvacConfig = this.readHvacConfigRecord(config);
    const functionId = getChannelFunctionId(this.channel);
    const modeHint = String(this.channel.state?.mode ?? '').toUpperCase();
    const subfunctionHint = this.readNormalizedHvacSubfunction(config, hvacConfig);
    const heatAvailable = this.readBooleanFromRecords(
      [config, hvacConfig],
      'heatingModeAvailable',
      'heating_mode_available',
    );
    const coolAvailable = this.readBooleanFromRecords(
      [config, hvacConfig],
      'coolingModeAvailable',
      'cooling_mode_available',
    );

    let heatSupported: boolean;
    let coolSupported: boolean;

    if (heatAvailable !== undefined || coolAvailable !== undefined) {
      heatSupported = heatAvailable ?? false;
      coolSupported = coolAvailable ?? false;
    } else if (functionId === SUPLA_FUNCTION.HVAC_THERMOSTAT_HEAT_COOL) {
      heatSupported = true;
      coolSupported = true;
    } else if (functionId === SUPLA_FUNCTION.HVAC_THERMOSTAT) {
      if (subfunctionHint === 'COOL') {
        heatSupported = false;
        coolSupported = true;
      } else if (subfunctionHint === 'HEAT') {
        heatSupported = true;
        coolSupported = false;
      } else {
        heatSupported = modeHint !== 'COOL';
        coolSupported = modeHint === 'COOL' || modeHint === 'HEAT_COOL';
      }
    } else if (functionId === SUPLA_FUNCTION.HVAC_DOMESTIC_HOT_WATER) {
      heatSupported = true;
      coolSupported = false;
    } else {
      heatSupported = true;
      coolSupported = modeHint === 'COOL'
        || modeHint === 'HEAT_COOL'
        || subfunctionHint === 'COOL'
        || subfunctionHint === 'HEAT_COOL';
    }

    if (modeHint === 'HEAT') {
      heatSupported = true;
    }
    if (modeHint === 'COOL') {
      coolSupported = true;
    }
    if (modeHint === 'HEAT_COOL' || subfunctionHint === 'HEAT_COOL') {
      heatSupported = true;
      coolSupported = true;
    }

    const allowed = [this.platform.Characteristic.TargetHeatingCoolingState.OFF];
    if (heatSupported) {
      allowed.push(this.platform.Characteristic.TargetHeatingCoolingState.HEAT);
    }
    if (coolSupported) {
      allowed.push(this.platform.Characteristic.TargetHeatingCoolingState.COOL);
    }
    if (heatSupported && coolSupported) {
      allowed.push(this.platform.Characteristic.TargetHeatingCoolingState.AUTO);
    }

    return Array.from(new Set(allowed));
  }

  private normalizeThermostatTargetMode(mode: number): number {
    const allowed = this.readAllowedThermostatTargetModes();
    if (allowed.includes(mode)) {
      return mode;
    }

    if (allowed.includes(this.platform.Characteristic.TargetHeatingCoolingState.HEAT)) {
      return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
    }
    if (allowed.includes(this.platform.Characteristic.TargetHeatingCoolingState.COOL)) {
      return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
    }

    return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
  }

  private resolveThermostatTargetTemperature(targetMode: number, currentTemperature: number): number {
    if (targetMode === this.platform.Characteristic.TargetHeatingCoolingState.COOL) {
      return this.cachedThermostatCoolSetpoint;
    }
    if (targetMode === this.platform.Characteristic.TargetHeatingCoolingState.AUTO) {
      return (this.cachedThermostatHeatSetpoint + this.cachedThermostatCoolSetpoint) / 2;
    }
    if (targetMode === this.platform.Characteristic.TargetHeatingCoolingState.HEAT) {
      return this.cachedThermostatHeatSetpoint;
    }

    return currentTemperature;
  }

  private readAllowedHeaterCoolerTargetStates(): number[] {
    const config = this.readConfigRecord();
    const hvacConfig = this.readHvacConfigRecord(config);
    const functionId = getChannelFunctionId(this.channel);
    const modeHint = String(this.channel.state?.mode ?? '').toUpperCase();
    const subfunctionHint = this.readNormalizedHvacSubfunction(config, hvacConfig);
    const heatAvailable = this.readBooleanFromRecords(
      [config, hvacConfig],
      'heatingModeAvailable',
      'heating_mode_available',
    );
    const coolAvailable = this.readBooleanFromRecords(
      [config, hvacConfig],
      'coolingModeAvailable',
      'cooling_mode_available',
    );

    let heatSupported: boolean;
    let coolSupported: boolean;
    if (heatAvailable !== undefined || coolAvailable !== undefined) {
      heatSupported = heatAvailable ?? false;
      coolSupported = coolAvailable ?? false;
    } else {
      heatSupported = true;
      coolSupported = functionId !== SUPLA_FUNCTION.HVAC_DOMESTIC_HOT_WATER
        && (
          modeHint === 'COOL'
          || modeHint === 'HEAT_COOL'
          || subfunctionHint === 'COOL'
          || subfunctionHint === 'HEAT_COOL'
        );
    }

    if (modeHint === 'HEAT') {
      heatSupported = true;
    }
    if (modeHint === 'COOL') {
      coolSupported = true;
    }
    if (modeHint === 'HEAT_COOL' || subfunctionHint === 'HEAT_COOL') {
      heatSupported = true;
      coolSupported = true;
    }

    const allowed: number[] = [];
    if (heatSupported) {
      allowed.push(this.platform.Characteristic.TargetHeaterCoolerState.HEAT);
    }
    if (coolSupported) {
      allowed.push(this.platform.Characteristic.TargetHeaterCoolerState.COOL);
    }
    if (heatSupported && coolSupported) {
      allowed.push(this.platform.Characteristic.TargetHeaterCoolerState.AUTO);
    }

    if (allowed.length === 0) {
      allowed.push(this.platform.Characteristic.TargetHeaterCoolerState.HEAT);
    }

    return Array.from(new Set(allowed));
  }

  private normalizeHeaterCoolerTargetState(state: number): number {
    const allowed = this.readAllowedHeaterCoolerTargetStates();
    if (allowed.includes(state)) {
      return state;
    }

    return allowed[0];
  }

  private readAutoOffsetRangeFromConfig(): { minGap: number; maxGap?: number } {
    const config = this.readConfigRecord();
    const hvacConfig = this.readHvacConfigRecord(config);
    const constraints = this.asRecord(config.temperatureConstraints)
      ?? this.asRecord(config.temperature_constraints)
      ?? this.asRecord(hvacConfig?.temperatureConstraints)
      ?? this.asRecord(hvacConfig?.temperature_constraints);
    const minGapRaw = this.readNumberFromRecords([constraints], 'autoOffsetMin', 'auto_offset_min');
    const maxGapRaw = this.readNumberFromRecords([constraints], 'autoOffsetMax', 'auto_offset_max');

    const minGap = clampNumber(minGapRaw ?? 0.5, 0.1, 50);
    const maxGap = maxGapRaw !== undefined
      ? clampNumber(maxGapRaw, minGap, 100)
      : undefined;

    return { minGap, maxGap };
  }

  private normalizeHeatCoolSetpoints(
    heat: number,
    cool: number,
    temperatureRange: { minValue: number; maxValue: number },
    minGap: number,
    maxGap: number | undefined,
    preferredAnchor: 'heat' | 'cool' | 'center',
  ): { heat: number; cool: number } {
    const rangeSpan = temperatureRange.maxValue - temperatureRange.minValue;
    const safeMinGap = clampNumber(minGap, 0.1, Math.max(rangeSpan, 0.1));
    const safeMaxGap = maxGap !== undefined
      ? clampNumber(maxGap, safeMinGap, Math.max(rangeSpan, safeMinGap))
      : undefined;

    let nextHeat = clampNumber(heat, temperatureRange.minValue, temperatureRange.maxValue);
    let nextCool = clampNumber(cool, temperatureRange.minValue, temperatureRange.maxValue);

    if (nextCool < nextHeat) {
      if (preferredAnchor === 'cool') {
        nextHeat = nextCool;
      } else {
        nextCool = nextHeat;
      }
    }

    const applyGap = (gap: number): void => {
      if (preferredAnchor === 'heat') {
        nextCool = nextHeat + gap;
      } else if (preferredAnchor === 'cool') {
        nextHeat = nextCool - gap;
      } else {
        const center = (nextHeat + nextCool) / 2;
        nextHeat = center - gap / 2;
        nextCool = center + gap / 2;
      }
    };

    let gap = nextCool - nextHeat;
    if (safeMaxGap !== undefined && gap > safeMaxGap) {
      applyGap(safeMaxGap);
    }

    gap = nextCool - nextHeat;
    if (gap < safeMinGap) {
      applyGap(safeMinGap);
    }

    nextHeat = clampNumber(nextHeat, temperatureRange.minValue, temperatureRange.maxValue);
    nextCool = clampNumber(nextCool, temperatureRange.minValue, temperatureRange.maxValue);

    gap = nextCool - nextHeat;
    if (gap < safeMinGap) {
      nextHeat = clampNumber(nextHeat, temperatureRange.minValue, temperatureRange.maxValue - safeMinGap);
      nextCool = clampNumber(nextHeat + safeMinGap, temperatureRange.minValue, temperatureRange.maxValue);
      if (nextCool - nextHeat < safeMinGap) {
        nextCool = temperatureRange.maxValue;
        nextHeat = clampNumber(nextCool - safeMinGap, temperatureRange.minValue, temperatureRange.maxValue);
      }
    }

    if (safeMaxGap !== undefined && nextCool - nextHeat > safeMaxGap) {
      nextCool = clampNumber(nextHeat + safeMaxGap, temperatureRange.minValue, temperatureRange.maxValue);
    }

    return {
      heat: Number(nextHeat.toFixed(1)),
      cool: Number(nextCool.toFixed(1)),
    };
  }

  private readHvacConfigRecord(configRoot: Record<string, unknown>): Record<string, unknown> | undefined {
    return this.asRecord(configRoot.hvacThermostat)
      ?? this.asRecord(configRoot.hvac_thermostat)
      ?? this.asRecord(configRoot.hvac);
  }

  private readNormalizedHvacSubfunction(
    configRoot: Record<string, unknown>,
    hvacConfig: Record<string, unknown> | undefined,
  ): string {
    const stateRecord = this.channel.state as Record<string, unknown> | undefined;
    const rawSubfunction = stateRecord?.subfunction
      ?? configRoot.subfunction
      ?? configRoot.sub_function
      ?? hvacConfig?.subfunction
      ?? hvacConfig?.sub_function;
    return String(rawSubfunction ?? '')
      .trim()
      .toUpperCase()
      .replace(/[\s-]/g, '_');
  }

  private isAuxTemperatureControlType(rawControlType: unknown): boolean {
    const normalized = String(rawControlType ?? '')
      .trim()
      .toUpperCase()
      .replace(/[\s-]/g, '_');
    return normalized === '2' || normalized === 'AUX_HEATER_COOLER_TEMPERATURE';
  }

  private readNumberFromRecords(
    records: Array<Record<string, unknown> | undefined>,
    ...keys: string[]
  ): number | undefined {
    for (const record of records) {
      if (!record) {
        continue;
      }

      for (const key of keys) {
        const value = asNumber(record[key]);
        if (value !== undefined) {
          return value;
        }
      }
    }

    return undefined;
  }

  private readBooleanFromRecords(
    records: Array<Record<string, unknown> | undefined>,
    ...keys: string[]
  ): boolean | undefined {
    for (const record of records) {
      if (!record) {
        continue;
      }

      for (const key of keys) {
        const value = asBoolean(record[key]);
        if (value !== undefined) {
          return value;
        }
      }
    }

    return undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, unknown>;
  }

  private serializeForLog(payload: Record<string, unknown>): string {
    try {
      const serialized = JSON.stringify(payload);
      return serialized.length > 500 ? `${serialized.slice(0, 500)}...` : serialized;
    } catch {
      return '[unserializable-payload]';
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

  private updateIfPresent(
    service: Service,
    characteristic: string | { UUID: string },
    value: CharacteristicValue,
  ): void {
    try {
      service.updateCharacteristic(characteristic as never, value);
    } catch {
      // Some HomeKit services do not expose Status* characteristics.
    }
  }

}
