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
