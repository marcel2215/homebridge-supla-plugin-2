export const SUPLA_FUNCTION = {
  NONE: 0,
  CONTROLLING_THE_GATEWAY_LOCK: 10,
  CONTROLLING_THE_GATE: 20,
  CONTROLLING_THE_GARAGE_DOOR: 30,
  THERMOMETER: 40,
  HUMIDITY: 42,
  HUMIDITY_AND_TEMPERATURE: 45,
  OPENING_SENSOR_GATEWAY: 50,
  OPENING_SENSOR_GATE: 60,
  OPENING_SENSOR_GARAGE_DOOR: 70,
  NO_LIQUID_SENSOR: 80,
  CONTROLLING_THE_DOOR_LOCK: 90,
  OPENING_SENSOR_DOOR: 100,
  CONTROLLING_THE_ROLLER_SHUTTER: 110,
  CONTROLLING_THE_ROOF_WINDOW: 115,
  OPENING_SENSOR_ROLLER_SHUTTER: 120,
  OPENING_SENSOR_ROOF_WINDOW: 125,
  POWER_SWITCH: 130,
  LIGHT_SWITCH: 140,
  DIMMER: 180,
  DIMMER_CCT: 185,
  RGB_LIGHTING: 190,
  DIMMER_AND_RGB_LIGHTING: 200,
  DIMMER_CCT_AND_RGB: 205,
  DEPTH_SENSOR: 210,
  DISTANCE_SENSOR: 220,
  OPENING_SENSOR_WINDOW: 230,
  HOTEL_CARD_SENSOR: 235,
  ALARM_ARMAMENT_SENSOR: 236,
  MAIL_SENSOR: 240,
  WIND_SENSOR: 250,
  PRESSURE_SENSOR: 260,
  RAIN_SENSOR: 270,
  WEIGHT_SENSOR: 280,
  WEATHER_STATION: 290,
  STAIRCASE_TIMER: 300,
  ELECTRICITY_METER: 310,
  IC_ELECTRICITY_METER: 315,
  IC_GAS_METER: 320,
  IC_WATER_METER: 330,
  IC_HEAT_METER: 340,
  THERMOSTAT: 400,
  THERMOSTAT_HEATPOL_HOMEPLUS: 410,
  HVAC_THERMOSTAT: 420,
  HVAC_THERMOSTAT_HEAT_COOL: 422,
  HVAC_DRYER: 423,
  HVAC_FAN: 424,
  HVAC_THERMOSTAT_DIFFERENTIAL: 425,
  HVAC_DOMESTIC_HOT_WATER: 426,
  VALVE_OPEN_CLOSE: 500,
  VALVE_PERCENTAGE: 510,
  GENERAL_PURPOSE_MEASUREMENT: 520,
  GENERAL_PURPOSE_METER: 530,
  DIGIGLASS_HORIZONTAL: 800,
  DIGIGLASS_VERTICAL: 810,
  CONTROLLING_THE_FACADE_BLIND: 900,
  TERRACE_AWNING: 910,
  PROJECTOR_SCREEN: 920,
  CURTAIN: 930,
  VERTICAL_BLIND: 940,
  ROLLER_GARAGE_DOOR: 950,
  PUMP_SWITCH: 960,
  HEAT_OR_COLD_SOURCE_SWITCH: 970,
  CONTAINER: 980,
  SEPTIC_TANK: 981,
  WATER_TANK: 982,
  CONTAINER_LEVEL_SENSOR: 990,
  FLOOD_SENSOR: 1000,
  MOTION_SENSOR: 1010,
  BINARY_SENSOR: 1020,
} as const;

export const SUPLA_ACTION = {
  OPEN: 'OPEN',
  CLOSE: 'CLOSE',
  SHUT: 'SHUT',
  REVEAL: 'REVEAL',
  REVEAL_PARTIALLY: 'REVEAL_PARTIALLY',
  SHUT_PARTIALLY: 'SHUT_PARTIALLY',
  TURN_ON: 'TURN_ON',
  TURN_OFF: 'TURN_OFF',
  SET: 'SET',
  SET_RGBW_PARAMETERS: 'SET_RGBW_PARAMETERS',
  OPEN_CLOSE: 'OPEN_CLOSE',
  STOP: 'STOP',
  HVAC_SET_PARAMETERS: 'HVAC_SET_PARAMETERS',
  HVAC_SET_TEMPERATURE: 'HVAC_SET_TEMPERATURE',
  HVAC_SET_TEMPERATURES: 'HVAC_SET_TEMPERATURES',
  OPEN_PARTIALLY: 'OPEN_PARTIALLY',
} as const;

export type SuplaAction = (typeof SUPLA_ACTION)[keyof typeof SUPLA_ACTION];

export type ServiceKind =
  | 'outlet'
  | 'switch'
  | 'fan'
  | 'light'
  | 'window'
  | 'windowCovering'
  | 'garageDoor'
  | 'lock'
  | 'temperature'
  | 'humidity'
  | 'temperatureHumidity'
  | 'contact'
  | 'occupancy'
  | 'leak'
  | 'motion'
  | 'thermostat'
  | 'humidifierDehumidifier'
  | 'heaterCooler'
  | 'valve';

const LIGHT_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.DIMMER,
  SUPLA_FUNCTION.DIMMER_CCT,
  SUPLA_FUNCTION.RGB_LIGHTING,
  SUPLA_FUNCTION.DIMMER_AND_RGB_LIGHTING,
  SUPLA_FUNCTION.DIMMER_CCT_AND_RGB,
]);

const SWITCH_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.LIGHT_SWITCH,
  SUPLA_FUNCTION.STAIRCASE_TIMER,
  SUPLA_FUNCTION.PUMP_SWITCH,
  SUPLA_FUNCTION.HEAT_OR_COLD_SOURCE_SWITCH,
]);

const FAN_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.HVAC_FAN,
]);

const OUTLET_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.POWER_SWITCH,
]);

const WINDOW_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.CONTROLLING_THE_ROOF_WINDOW,
]);

const WINDOW_COVERING_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.CONTROLLING_THE_ROLLER_SHUTTER,
  SUPLA_FUNCTION.CONTROLLING_THE_FACADE_BLIND,
  SUPLA_FUNCTION.TERRACE_AWNING,
  SUPLA_FUNCTION.PROJECTOR_SCREEN,
  SUPLA_FUNCTION.CURTAIN,
  SUPLA_FUNCTION.VERTICAL_BLIND,
  SUPLA_FUNCTION.DIGIGLASS_HORIZONTAL,
  SUPLA_FUNCTION.DIGIGLASS_VERTICAL,
]);

const TILTABLE_WINDOW_COVERING_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.CONTROLLING_THE_FACADE_BLIND,
  SUPLA_FUNCTION.VERTICAL_BLIND,
]);

const GARAGE_DOOR_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.CONTROLLING_THE_GATE,
  SUPLA_FUNCTION.CONTROLLING_THE_GARAGE_DOOR,
  SUPLA_FUNCTION.ROLLER_GARAGE_DOOR,
]);

const LOCK_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.CONTROLLING_THE_GATEWAY_LOCK,
  SUPLA_FUNCTION.CONTROLLING_THE_DOOR_LOCK,
]);

const CONTACT_FUNCTIONS = new Set<number>([
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
]);

const OCCUPANCY_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.BINARY_SENSOR,
]);

const LEAK_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.NO_LIQUID_SENSOR,
  SUPLA_FUNCTION.RAIN_SENSOR,
  SUPLA_FUNCTION.FLOOD_SENSOR,
  SUPLA_FUNCTION.CONTAINER,
  SUPLA_FUNCTION.SEPTIC_TANK,
  SUPLA_FUNCTION.WATER_TANK,
]);

const THERMOSTAT_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.THERMOSTAT,
  SUPLA_FUNCTION.THERMOSTAT_HEATPOL_HOMEPLUS,
  SUPLA_FUNCTION.HVAC_THERMOSTAT,
  SUPLA_FUNCTION.HVAC_THERMOSTAT_HEAT_COOL,
  SUPLA_FUNCTION.HVAC_THERMOSTAT_DIFFERENTIAL,
]);

const VALVE_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.VALVE_OPEN_CLOSE,
  SUPLA_FUNCTION.VALVE_PERCENTAGE,
]);

const HUMIDIFIER_DEHUMIDIFIER_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.HVAC_DRYER,
]);

const HEATER_COOLER_FUNCTIONS = new Set<number>([
  SUPLA_FUNCTION.HVAC_DOMESTIC_HOT_WATER,
]);

export function isLightFunction(functionId: number): boolean {
  return LIGHT_FUNCTIONS.has(functionId);
}

export function isRgbFunction(functionId: number): boolean {
  return functionId === SUPLA_FUNCTION.RGB_LIGHTING
    || functionId === SUPLA_FUNCTION.DIMMER_AND_RGB_LIGHTING
    || functionId === SUPLA_FUNCTION.DIMMER_CCT_AND_RGB;
}

export function isDimmerFunction(functionId: number): boolean {
  return functionId === SUPLA_FUNCTION.DIMMER
    || functionId === SUPLA_FUNCTION.DIMMER_CCT
    || functionId === SUPLA_FUNCTION.DIMMER_AND_RGB_LIGHTING
    || functionId === SUPLA_FUNCTION.DIMMER_CCT_AND_RGB;
}

export function isSwitchFunction(functionId: number): boolean {
  return SWITCH_FUNCTIONS.has(functionId);
}

export function isFanFunction(functionId: number): boolean {
  return FAN_FUNCTIONS.has(functionId);
}

export function isOutletFunction(functionId: number): boolean {
  return OUTLET_FUNCTIONS.has(functionId);
}

export function isWindowFunction(functionId: number): boolean {
  return WINDOW_FUNCTIONS.has(functionId);
}

export function isWindowCoveringFunction(functionId: number): boolean {
  return WINDOW_COVERING_FUNCTIONS.has(functionId);
}

export function isTiltableWindowCoveringFunction(functionId: number): boolean {
  return TILTABLE_WINDOW_COVERING_FUNCTIONS.has(functionId);
}

export function isVerticalBlindFunction(functionId: number): boolean {
  return functionId === SUPLA_FUNCTION.VERTICAL_BLIND;
}

export function isGarageDoorFunction(functionId: number): boolean {
  return GARAGE_DOOR_FUNCTIONS.has(functionId);
}

export function isLockFunction(functionId: number): boolean {
  return LOCK_FUNCTIONS.has(functionId);
}

export function isContactFunction(functionId: number): boolean {
  return CONTACT_FUNCTIONS.has(functionId);
}

export function isOccupancyFunction(functionId: number): boolean {
  return OCCUPANCY_FUNCTIONS.has(functionId);
}

export function isLeakFunction(functionId: number): boolean {
  return LEAK_FUNCTIONS.has(functionId);
}

export function isThermostatFunction(functionId: number): boolean {
  return THERMOSTAT_FUNCTIONS.has(functionId);
}

export function isValveFunction(functionId: number): boolean {
  return VALVE_FUNCTIONS.has(functionId);
}

export function isHumidifierDehumidifierFunction(functionId: number): boolean {
  return HUMIDIFIER_DEHUMIDIFIER_FUNCTIONS.has(functionId);
}

export function isHeaterCoolerFunction(functionId: number): boolean {
  return HEATER_COOLER_FUNCTIONS.has(functionId);
}

export function isDigiglassFunction(functionId: number): boolean {
  return functionId === SUPLA_FUNCTION.DIGIGLASS_HORIZONTAL
    || functionId === SUPLA_FUNCTION.DIGIGLASS_VERTICAL;
}

export function isReversedShadingSystemFunction(functionId: number): boolean {
  return functionId === SUPLA_FUNCTION.TERRACE_AWNING
    || functionId === SUPLA_FUNCTION.PROJECTOR_SCREEN;
}

export function mapFunctionToServiceKind(functionId: number): ServiceKind | undefined {
  if (isLightFunction(functionId)) {
    return 'light';
  }

  if (isSwitchFunction(functionId)) {
    return 'switch';
  }

  if (isOutletFunction(functionId)) {
    return 'outlet';
  }

  if (isFanFunction(functionId)) {
    return 'fan';
  }

  if (isWindowFunction(functionId)) {
    return 'window';
  }

  if (isWindowCoveringFunction(functionId)) {
    return 'windowCovering';
  }

  if (isGarageDoorFunction(functionId)) {
    return 'garageDoor';
  }

  if (isLockFunction(functionId)) {
    return 'lock';
  }

  if (functionId === SUPLA_FUNCTION.THERMOMETER) {
    return 'temperature';
  }

  if (functionId === SUPLA_FUNCTION.HUMIDITY) {
    return 'humidity';
  }

  if (functionId === SUPLA_FUNCTION.HUMIDITY_AND_TEMPERATURE) {
    return 'temperatureHumidity';
  }

  if (isContactFunction(functionId)) {
    return 'contact';
  }

  if (isOccupancyFunction(functionId)) {
    return 'occupancy';
  }

  if (isLeakFunction(functionId)) {
    return 'leak';
  }

  if (functionId === SUPLA_FUNCTION.MOTION_SENSOR) {
    return 'motion';
  }

  if (isThermostatFunction(functionId)) {
    return 'thermostat';
  }

  if (isHumidifierDehumidifierFunction(functionId)) {
    return 'humidifierDehumidifier';
  }

  if (isHeaterCoolerFunction(functionId)) {
    return 'heaterCooler';
  }

  if (isValveFunction(functionId)) {
    return 'valve';
  }

  return undefined;
}
