export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }

    if (normalized === 'false' || normalized === '0') {
      return false;
    }
  }

  return undefined;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseHexColor(value: unknown): { red: number; green: number; blue: number } | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 0xFFFFFF) {
    return {
      red: (value >> 16) & 0xFF,
      green: (value >> 8) & 0xFF,
      blue: value & 0xFF,
    };
  }

  if (typeof value === 'string') {
    const normalized = value.trim().replace(/^0x/i, '').replace(/^#/i, '');
    if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
      const parsed = Number.parseInt(normalized, 16);
      return {
        red: (parsed >> 16) & 0xFF,
        green: (parsed >> 8) & 0xFF,
        blue: parsed & 0xFF,
      };
    }
  }

  return undefined;
}

export function rgbToHsv(red: number, green: number, blue: number): { hue: number; saturation: number; value: number } {
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
    hue: Math.round(hue),
    saturation: Math.round(saturation),
    value: Math.round(value),
  };
}

export function hsvToRgb(hue: number, saturation: number, value: number): { red: number; green: number; blue: number } {
  const h = ((hue % 360) + 360) % 360;
  const s = clampNumber(saturation, 0, 100) / 100;
  const v = clampNumber(value, 0, 100) / 100;

  const chroma = v * s;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = v - chroma;

  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) {
    r = chroma;
    g = x;
  } else if (h < 120) {
    r = x;
    g = chroma;
  } else if (h < 180) {
    g = chroma;
    b = x;
  } else if (h < 240) {
    g = x;
    b = chroma;
  } else if (h < 300) {
    r = x;
    b = chroma;
  } else {
    r = chroma;
    b = x;
  }

  return {
    red: Math.round((r + m) * 255),
    green: Math.round((g + m) * 255),
    blue: Math.round((b + m) * 255),
  };
}

export function rgbToHexString(red: number, green: number, blue: number): string {
  const r = clampNumber(Math.round(red), 0, 255).toString(16).padStart(2, '0');
  const g = clampNumber(Math.round(green), 0, 255).toString(16).padStart(2, '0');
  const b = clampNumber(Math.round(blue), 0, 255).toString(16).padStart(2, '0');
  return `0x${r}${g}${b}`.toUpperCase();
}

const MIN_COLOR_TEMPERATURE_KELVIN = 1500;
const MAX_COLOR_TEMPERATURE_KELVIN = 9000;
const KELVIN_SEARCH_STEP = 25;

export function miredToKelvin(mired: number): number {
  const safeMired = Math.max(1, mired);
  return Math.round(1_000_000 / safeMired);
}

export function kelvinToMired(kelvin: number): number {
  const safeKelvin = Math.max(1, kelvin);
  return Math.round(1_000_000 / safeKelvin);
}

export function kelvinToRgb(kelvin: number): { red: number; green: number; blue: number } {
  const safeKelvin = clampNumber(kelvin, MIN_COLOR_TEMPERATURE_KELVIN, MAX_COLOR_TEMPERATURE_KELVIN);
  const temperature = safeKelvin / 100;

  let red = 0;
  let green = 0;
  let blue = 0;

  if (temperature <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temperature) - 161.1195681661;
    blue = temperature <= 19
      ? 0
      : 138.5177312231 * Math.log(temperature - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * (temperature - 60) ** -0.1332047592;
    green = 288.1221695283 * (temperature - 60) ** -0.0755148492;
    blue = 255;
  }

  return {
    red: clampNumber(Math.round(red), 0, 255),
    green: clampNumber(Math.round(green), 0, 255),
    blue: clampNumber(Math.round(blue), 0, 255),
  };
}

export function estimateColorTemperatureKelvin(red: number, green: number, blue: number): number {
  const sourceMax = Math.max(Math.abs(red), Math.abs(green), Math.abs(blue), 1);
  const normalizedSource = {
    red: clampNumber((red / sourceMax) * 255, 0, 255),
    green: clampNumber((green / sourceMax) * 255, 0, 255),
    blue: clampNumber((blue / sourceMax) * 255, 0, 255),
  };

  let bestKelvin = 4000;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let kelvin = MIN_COLOR_TEMPERATURE_KELVIN; kelvin <= MAX_COLOR_TEMPERATURE_KELVIN; kelvin += KELVIN_SEARCH_STEP) {
    const candidate = kelvinToRgb(kelvin);
    const candidateMax = Math.max(candidate.red, candidate.green, candidate.blue, 1);
    const normalizedCandidate = {
      red: (candidate.red / candidateMax) * 255,
      green: (candidate.green / candidateMax) * 255,
      blue: (candidate.blue / candidateMax) * 255,
    };

    const distance = (normalizedSource.red - normalizedCandidate.red) ** 2
      + (normalizedSource.green - normalizedCandidate.green) ** 2
      + (normalizedSource.blue - normalizedCandidate.blue) ** 2;

    if (distance < bestDistance) {
      bestDistance = distance;
      bestKelvin = kelvin;
    }
  }

  return bestKelvin;
}
