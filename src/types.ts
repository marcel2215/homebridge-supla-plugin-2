import type { ServiceKind } from './constants.js';

export interface SuplaAutodiscoverResponse {
  server?: string;
}

export interface SuplaTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface SuplaChannelFunction {
  id?: number;
  name?: string;
}

export interface SuplaChannelFunctionAction {
  id?: number;
  name?: string;
  caption?: string;
}

export interface SuplaChannelHsv {
  hue?: number;
  saturation?: number;
  value?: number;
}

export interface SuplaChannelRgb {
  red?: number;
  green?: number;
  blue?: number;
}

export interface SuplaChannelState {
  connected?: boolean;
  connectedCode?: string;
  on?: boolean;
  hi?: boolean;
  partial_hi?: boolean;
  partialHi?: boolean;
  brightness?: number;
  color_brightness?: number;
  colorBrightness?: number;
  color?: string;
  hue?: number;
  hsv?: SuplaChannelHsv;
  rgb?: SuplaChannelRgb;
  temperature?: number;
  humidity?: number;
  temperatureMain?: number;
  humidityMain?: number;
  temperatureHeat?: number;
  temperatureCool?: number;
  shut?: number;
  isCalibrating?: boolean;
  closed?: boolean | number;
  manuallyClosed?: boolean;
  flooding?: boolean;
  motorProblem?: boolean;
  value?: number;
  fillLevel?: number;
  warningLevel?: boolean;
  alarmLevel?: boolean;
  manual?: boolean;
  countdownTimer?: boolean;
  thermometerError?: boolean;
  clockError?: boolean;
  forcedOffBySensor?: boolean;
  weeklyScheduleTemporalOverride?: boolean;
  batteryCoverOpen?: boolean;
  calibrationError?: boolean;
  currentOverload?: boolean;
  notCalibrated?: boolean;
  executing?: boolean;
  millisecondsFromStart?: number;
  millisecondsToEnd?: number;
  mode?: string;
  heating?: boolean;
  cooling?: boolean;
  tiltPercent?: number;
  tiltAngle?: number;
  mask?: number;
  transparent?: number[];
  opaque?: number[];
  [key: string]: unknown;
}

export interface SuplaChannelConfigHvacTemperatureConstraints {
  roomMin?: number;
  roomMax?: number;
  auxMin?: number;
  auxMax?: number;
  histeresisMin?: number;
  histeresisMax?: number;
  autoOffsetMin?: number;
  autoOffsetMax?: number;
  [key: string]: unknown;
}

export interface SuplaChannelConfigHvacTemperatures {
  auxMinSetpoint?: number;
  auxMaxSetpoint?: number;
  roomMin?: number;
  roomMax?: number;
  auxMin?: number;
  auxMax?: number;
  [key: string]: unknown;
}

export interface SuplaChannelConfig {
  openingSensorChannelId?: number;
  openingSensorSecondaryChannelId?: number;
  relayTimeMs?: number;
  stateVerificationMethodActive?: boolean;

  subfunction?: string;
  temperatureControlType?: string;
  heatingModeAvailable?: boolean;
  coolingModeAvailable?: boolean;
  binarySensorChannelId?: number;
  temperatureConstraints?: SuplaChannelConfigHvacTemperatureConstraints;
  temperatures?: SuplaChannelConfigHvacTemperatures;

  tiltControlType?: string;
  tilt0Angle?: number;
  tilt100Angle?: number;
  [key: string]: unknown;
}

export interface SuplaChannel {
  id: number;
  caption?: string;
  hidden?: boolean;
  channelNumber?: number;
  param1?: number;
  param2?: number;
  param3?: number;
  functionId?: number;
  function?: SuplaChannelFunction;
  possibleActions?: SuplaChannelFunctionAction[];
  connected?: boolean;
  state?: SuplaChannelState;
  config?: SuplaChannelConfig;
  iodevice?: {
    id?: number;
    name?: string;
  };
  location?: {
    id?: number;
    caption?: string;
  };
}

export interface SuplaAccessoryContext {
  channelId: number;
  functionId: number;
  serviceKind: ServiceKind;
  uniqueId: string;
}

export function getChannelFunctionId(channel: SuplaChannel): number {
  if (typeof channel.functionId === 'number') {
    return channel.functionId;
  }

  if (typeof channel.function?.id === 'number') {
    return channel.function.id;
  }

  return 0;
}

export function getChannelDisplayName(channel: SuplaChannel): string {
  const caption = channel.caption?.trim();
  if (caption) {
    return caption;
  }

  const fallback = channel.iodevice?.name?.trim();
  if (fallback) {
    return `${fallback} ${channel.id}`;
  }

  return `Supla ${channel.id}`;
}
