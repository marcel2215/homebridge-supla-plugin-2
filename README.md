# homebridge-supla-plugin-2

Homebridge dynamic platform plugin for SUPLA cloud.

This plugin authenticates with SUPLA using the same email/password account credentials used in the mobile app, autodiscovers the target cloud server, reads channels/states from SUPLA Cloud API, and executes channel actions through the cloud action endpoint.

## Features

- Email/password authentication (`/api/webapp-tokens`) with retry and refresh fallback.
- SUPLA autodiscovery (`https://autodiscover.supla.org/users/{email}`).
- Cloud API path fallback (`/api/3`, `/api/v3`, `/api`).
- Dynamic accessory discovery and cache reconciliation.
- Action execution via `PATCH /channels/{id}`.
- Robust polling/retry behavior and offline state propagation.

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
      "pollIntervalSeconds": 10,
      "requestTimeoutMs": 10000,
      "includeHidden": false
    }
  ]
}
```

Optional fields:

- `server`: force a specific SUPLA cloud host/URL (skip autodiscover).
- `apiPrefix`: force API prefix (for example `/api/3`).

## Development

```bash
npm install
npm run lint
npm run build
```
