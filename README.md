# homebridge-supla-plugin-2

Homebridge dynamic platform plugin for SUPLA cloud.

This plugin authenticates with SUPLA using the same email/password account credentials used in the iOS app.  
By default it uses native SUPLA client protocol (same protocol family as the mobile app), receives realtime events from SUPLA cloud, and executes actions through the native protocol helper.

## Features

- Native SUPLA protocol transport (`SuplaClient` C library helper) with event-driven updates (no polling in native mode).
- Email/password authentication with SUPLA autodiscovery (`https://autodiscover.supla.org/users/{email}`).
- Persistent native GUID/AuthKey identity per account (stored in Homebridge storage path).
- Dynamic accessory discovery and cache reconciliation.
- Robust reconnect/retry behavior and offline state propagation.
- Optional REST fallback transport for environments where native helper is unavailable.

## Supported HomeKit mappings

- `Switch`: power/light/staircase/pump/heat-cold source switches.
- `Outlet`: power switch channels.
- `Lightbulb`: dimmer, RGB, dimmer+RGB variants.
- `Fan`: HVAC fan channels.
- `Window`: controllable roof window channels.
- `WindowCovering`: roller/facade blinds, awning, curtain, projector screen, digiglass (with slat tilt for facade/vertical blinds).
- `GarageDoorOpener`: gate, garage door, roller garage door.
- `LockMechanism`: gateway lock, door lock.
- `Thermostat`: thermostat/HVAC families.
- `HumidifierDehumidifier`: HVAC dryer channels.
- `HeaterCooler`: domestic hot water HVAC channels.
- `Valve`: valve open/close and valve percentage channels.
- `TemperatureSensor`, `HumiditySensor`, combined temperature+humidity.
- `ContactSensor`, `OccupancySensor`, `LeakSensor` (including rain/no-liquid/flood/container alarms), `MotionSensor` for compatible sensor channels.

Channels/functions without a direct HomeKit equivalent are intentionally not exposed.

## Configuration

Add this platform section to Homebridge:

```json
{
  "platforms": [
    {
      "platform": "SuplaPlatform",
      "name": "SUPLA",
      "email": "user@example.com",
      "password": "your-password",
      "transport": "native",
      "nativeConnectTimeoutMs": 5000,
      "nativeReconnectDelayMs": 2000,
      "includeHidden": false
    }
  ]
}
```

Optional fields:

- `server`: force a specific SUPLA cloud host/URL (skip autodiscover).
- `nativeHelperPath`: absolute path to `supla-native-bridge`.
- `nativePort`, `nativeSsl`, `nativeProtocolVersion`: native transport overrides.
- `nativeGuid`, `nativeAuthKey`: fixed hex credentials (32 hex chars each). If omitted, plugin persists generated values automatically.
- `transport: "rest"`: use REST fallback transport.
- `apiPrefix`, `pollIntervalSeconds`: REST-only options.

## Development

```bash
npm install
npm run lint
npm run build
```

Native helper binary is built automatically on `postinstall` (best-effort/optional).  
To rebuild manually:

```bash
npm run build:native
```
