import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import {
  SUPLA_ACTION,
  SUPLA_FUNCTION,
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
  hsvToRgb,
  parseHexColor,
  rgbToHsv,
} from './utils.js';

const WINDOW_POSITION_TOLERANCE = 2;
const TILT_ANGLE_TOLERANCE = 2;

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
  private lastConnectionState: boolean | undefined;

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
    this.platform.log.debug(
      `SUPLA channel ${channel.id} state update: service=${this.serviceKind}, connected=${connected}, `
      + `on=${String(state.on)}, hi=${String(state.hi)}, shut=${String(state.shut)}`,
    );

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
      service.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.handleLightOnSet.bind(this));

      service.getCharacteristic(this.platform.Characteristic.Brightness)
        .onSet(this.handleLightBrightnessSet.bind(this));

      if (isRgbFunction(getChannelFunctionId(this.channel))) {
        service.getCharacteristic(this.platform.Characteristic.Hue)
          .onSet(this.handleLightHueSet.bind(this));

        service.getCharacteristic(this.platform.Characteristic.Saturation)
          .onSet(this.handleLightSaturationSet.bind(this));
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

      service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
        .onSet(this.handleThermostatTargetTemperatureSet.bind(this))
        .setProps({
          minValue: 5,
          maxValue: 35,
          minStep: 0.5,
        });

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
      service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
        .onSet(this.handleHeaterCoolerTargetTemperatureSet.bind(this))
        .setProps({
          minValue: 5,
          maxValue: 60,
          minStep: 0.5,
        });
      return { main: service };
    }
    case 'valve': {
      const service = this.accessory.addService(this.platform.Service.Valve, displayName);
      service.getCharacteristic(this.platform.Characteristic.Active)
        .onSet(this.handleValveActiveSet.bind(this));
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
      this.updateIfPresent(
        service,
        this.platform.Characteristic.StatusFault,
        connected
          ? this.platform.Characteristic.StatusFault.NO_FAULT
          : this.platform.Characteristic.StatusFault.GENERAL_FAULT,
      );
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

    if (isDimmerFunction(functionId)) {
      const brightness = clampNumber(asNumber(state.brightness) ?? this.cachedBrightness, 0, 100);
      this.cachedBrightness = brightness;
      this.mainService.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
    }

    if (isRgbFunction(functionId)) {
      const colorBrightness = clampNumber(asNumber(state.color_brightness) ?? this.cachedColorBrightness, 0, 100);
      this.cachedColorBrightness = colorBrightness;

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
    const currentDoorState = this.readGarageCurrentDoorState(state);
    const targetDoorState = this.readGarageTargetDoorState(state);

    this.targetDoorState = targetDoorState;

    this.mainService.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, currentDoorState);
    this.mainService.updateCharacteristic(this.platform.Characteristic.TargetDoorState, targetDoorState);

    const obstruction = asBoolean(state.motorProblem) ?? false;
    this.mainService.updateCharacteristic(this.platform.Characteristic.ObstructionDetected, obstruction);
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
    const currentTemperature = asNumber(state.temperatureMain)
      ?? asNumber(state.temperature)
      ?? 20;

    const targetTemperature = asNumber(state.temperatureHeat)
      ?? asNumber(state.temperatureCool)
      ?? currentTemperature;

    const currentMode = this.readCurrentThermostatMode(state);
    const targetMode = this.readTargetThermostatMode(state);

    this.targetThermostatMode = targetMode;

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      clampNumber(currentTemperature, -100, 100),
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.TargetTemperature,
      clampNumber(targetTemperature, 5, 35),
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState,
      currentMode,
    );

    this.mainService.updateCharacteristic(
      this.platform.Characteristic.TargetHeatingCoolingState,
      targetMode,
    );
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
    const currentTemperature = asNumber(state.temperatureMain)
      ?? asNumber(state.temperature)
      ?? 20;
    const targetTemperature = asNumber(state.temperatureHeat)
      ?? asNumber(state.temperatureCool)
      ?? currentTemperature;

    const currentState = this.readCurrentHeaterCoolerState(state, active);
    const targetState = this.readTargetHeaterCoolerState(state);
    this.targetHeaterCoolerState = targetState;

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
      clampNumber(targetTemperature, 5, 60),
    );
  }

  private updateValveState(state: SuplaChannelState): void {
    const active = this.readValveActiveState(state);

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

    await this.executeAction({
      action: SUPLA_ACTION.SHUT_PARTIALLY,
      tilt: Math.round(this.tiltPercentFromAngle(angle)),
    });
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
      await this.executeAction({
        action: openRequested ? SUPLA_ACTION.REVEAL : SUPLA_ACTION.SHUT,
      });
      return;
    }

    if (
      functionId === SUPLA_FUNCTION.CONTROLLING_THE_GATE
      || functionId === SUPLA_FUNCTION.CONTROLLING_THE_GARAGE_DOOR
    ) {
      const currentDoorState = this.readGarageCurrentDoorState(state);
      const alreadyInRequestedState = openRequested
        ? currentDoorState === this.platform.Characteristic.CurrentDoorState.OPEN
        : currentDoorState === this.platform.Characteristic.CurrentDoorState.CLOSED;
      if (alreadyInRequestedState) {
        this.platform.log.debug(
          `SUPLA channel ${this.channel.id}: gate/garage already ${
            openRequested ? 'open' : 'closed'
          }, skipping OPEN_CLOSE toggle.`,
        );
        return;
      }

      await this.executeAction({
        action: SUPLA_ACTION.OPEN_CLOSE,
      });
      return;
    }

    if (isGarageDoorFunction(functionId)) {
      await this.executeAction({ action: openRequested ? SUPLA_ACTION.OPEN : SUPLA_ACTION.CLOSE });
    }
  }

  private async handleLockTargetStateSet(value: CharacteristicValue): Promise<void> {
    const unlockRequested = Number(value) === this.platform.Characteristic.LockTargetState.UNSECURED;

    await this.executeAction({
      action: unlockRequested ? SUPLA_ACTION.OPEN : SUPLA_ACTION.CLOSE,
    });
  }

  private async handleThermostatModeSet(value: CharacteristicValue): Promise<void> {
    const mode = Number(value);
    this.targetThermostatMode = mode;

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

    await this.executeAction({ action: SUPLA_ACTION.TURN_ON });
  }

  private async handleThermostatTargetTemperatureSet(value: CharacteristicValue): Promise<void> {
    const temperature = clampNumber(Number(value), 5, 35);
    const functionId = getChannelFunctionId(this.channel);
    const targetMode = this.targetThermostatMode
      ?? this.platform.Characteristic.TargetHeatingCoolingState.HEAT;

    if (functionId === SUPLA_FUNCTION.HVAC_THERMOSTAT_HEAT_COOL) {
      if (targetMode === this.platform.Characteristic.TargetHeatingCoolingState.COOL) {
        await this.executeAction({
          action: SUPLA_ACTION.HVAC_SET_TEMPERATURES,
          temperatureCool: Number(temperature.toFixed(1)),
        });
        return;
      }

      if (targetMode === this.platform.Characteristic.TargetHeatingCoolingState.AUTO) {
        await this.executeAction({
          action: SUPLA_ACTION.HVAC_SET_TEMPERATURES,
          temperatureHeat: Number(temperature.toFixed(1)),
          temperatureCool: Number((temperature + 1).toFixed(1)),
        });
        return;
      }

      await this.executeAction({
        action: SUPLA_ACTION.HVAC_SET_TEMPERATURES,
        temperatureHeat: Number(temperature.toFixed(1)),
      });
      return;
    }

    await this.executeAction({
      action: SUPLA_ACTION.HVAC_SET_TEMPERATURE,
      temperature: Number(temperature.toFixed(1)),
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
    const targetState = Number(value);
    this.targetHeaterCoolerState = targetState;

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

    await this.executeAction({ action: SUPLA_ACTION.TURN_ON });
  }

  private async handleHeaterCoolerTargetTemperatureSet(value: CharacteristicValue): Promise<void> {
    const temperature = clampNumber(Number(value), 5, 60);
    await this.executeAction({
      action: SUPLA_ACTION.HVAC_SET_TEMPERATURE,
      temperature: Number(temperature.toFixed(1)),
    });
  }

  private async handleValveActiveSet(value: CharacteristicValue): Promise<void> {
    const active = Number(value) === this.platform.Characteristic.Active.ACTIVE;

    await this.executeAction({
      action: active ? SUPLA_ACTION.OPEN : SUPLA_ACTION.CLOSE,
    });
  }

  private async executeAction(payload: Record<string, unknown>): Promise<void> {
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

  private readOnState(state: SuplaChannelState): boolean {
    const explicit = asBoolean(state.on);
    if (explicit !== undefined) {
      return explicit;
    }

    const brightness = asNumber(state.brightness);
    if (brightness !== undefined) {
      return brightness > 0;
    }

    const colorBrightness = asNumber(state.color_brightness);
    if (colorBrightness !== undefined) {
      return colorBrightness > 0;
    }

    return asBoolean(state.hi) ?? false;
  }

  private readHsv(state: SuplaChannelState, fallbackBrightness: number): { hue: number; saturation: number } | undefined {
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
      const adjustedRgb = hsvToRgb(
        rgbToHsv(parsedColor.red, parsedColor.green, parsedColor.blue).hue,
        rgbToHsv(parsedColor.red, parsedColor.green, parsedColor.blue).saturation,
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

    if (!isTiltableWindowCoveringFunction(functionId)) {
      return;
    }

    const tiltPercent = this.readTiltPercent(state);
    if (tiltPercent === undefined) {
      return;
    }

    const currentTiltAngle = this.tiltAngleFromPercent(tiltPercent);
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

    return Math.max(...allSections) + 1;
  }

  private readDigiglassTransparentSections(state: SuplaChannelState): number[] {
    if (!Array.isArray(state.transparent)) {
      return [];
    }

    return state.transparent
      .map((value) => asNumber(value))
      .filter((value): value is number => value !== undefined && value >= 0)
      .map((value) => Math.floor(value));
  }

  private readDigiglassOpaqueSections(state: SuplaChannelState): number[] {
    if (!Array.isArray(state.opaque)) {
      return [];
    }

    return state.opaque
      .map((value) => asNumber(value))
      .filter((value): value is number => value !== undefined && value >= 0)
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
      return clampNumber((tiltAngle * 100) / 180, 0, 100);
    }

    return undefined;
  }

  private tiltAngleFromPercent(tiltPercent: number): number {
    return clampNumber(Math.round((tiltPercent * 180) / 100 - 90), -90, 90);
  }

  private tiltPercentFromAngle(angle: number): number {
    return clampNumber(((angle + 90) * 100) / 180, 0, 100);
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

  private readGarageCurrentDoorState(state: SuplaChannelState): number {
    const openPercent = this.openPercentFromState(state);
    if (openPercent !== undefined) {
      if (openPercent <= 5) {
        return this.platform.Characteristic.CurrentDoorState.CLOSED;
      }

      if (openPercent >= 95) {
        return this.platform.Characteristic.CurrentDoorState.OPEN;
      }

      return this.platform.Characteristic.CurrentDoorState.STOPPED;
    }

    const gateLikeState = this.readGateLikeState(state);
    if (gateLikeState === 'open') {
      return this.platform.Characteristic.CurrentDoorState.OPEN;
    }
    if (gateLikeState === 'closed') {
      return this.platform.Characteristic.CurrentDoorState.CLOSED;
    }

    return this.platform.Characteristic.CurrentDoorState.STOPPED;
  }

  private readGarageTargetDoorState(state: SuplaChannelState): number {
    const openPercent = this.openPercentFromState(state);
    if (openPercent !== undefined) {
      return openPercent >= 50
        ? this.platform.Characteristic.TargetDoorState.OPEN
        : this.platform.Characteristic.TargetDoorState.CLOSED;
    }

    const gateLikeState = this.readGateLikeState(state);
    if (gateLikeState === 'open') {
      return this.platform.Characteristic.TargetDoorState.OPEN;
    }
    if (gateLikeState === 'closed') {
      return this.platform.Characteristic.TargetDoorState.CLOSED;
    }

    return this.targetDoorState ?? this.platform.Characteristic.TargetDoorState.CLOSED;
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
    const closed = asBoolean(state.closed);
    if (closed !== undefined) {
      return closed;
    }

    const hi = asBoolean(state.hi);
    if (hi !== undefined) {
      return hi;
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

    const hi = asBoolean(state.hi);
    const partialHi = asBoolean(state.partial_hi) ?? false;

    if (partialHi && hi === false) {
      return 'partial';
    }

    if (hi !== undefined) {
      return hi ? 'closed' : 'open';
    }

    const closed = asBoolean(state.closed);
    if (closed !== undefined) {
      return closed ? 'closed' : 'open';
    }

    return undefined;
  }

  private serializeForLog(payload: Record<string, unknown>): string {
    try {
      const serialized = JSON.stringify(payload);
      return serialized.length > 500 ? `${serialized.slice(0, 500)}...` : serialized;
    } catch {
      return '[unserializable-payload]';
    }
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
