export type Logger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type Factor = 'BRI' | 'BRIEXT' | 'TMP';

/**
 * What a sensor measures. Known ones: TMP (°C), HUM (%), SMOKE (0 or 1),
 * BATTERY_LEVEL (0-1). Flexom has many more (switch presses, power...).
 */
export type SensorFactor =
  'TMP' | 'HUM' | 'SMOKE' | 'BATTERY_LEVEL' | (string & {});

export const MASTER_ZONE_ID = 'MyHemis';

export type FactorSettings = {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: '%';
  actuatorCount?: number;
};

export type ZoneSettings = Partial<Record<Factor, FactorSettings>>;

export type Zone = {
  id: string;
  name: string;
  parentId?: string | null;
  surface?: string;
  type?: string | null;
};

export type UbiantUser = {
  id: string;
  email: string;
  token: string;
};

export type Building = {
  buildingId: string;
  authorizationToken: string;
  hemis_base_url: string;
  hemis_stomp_url: string;
  kernel_slot: string;
};

export type HemisUser = {
  token: string;
};

/** Health of a device, as tracked by Flexom (KO: stopped reporting) */
export type ThingState =
  | 'OK'
  | 'PAIRED'
  | 'UNKNOWN'
  | 'KO'
  | 'UNREACHABLE'
  | 'MUTE'
  | 'NOT_NEEDED'
  | (string & {});

/** A device (intelligent thing) */
export type Thing = {
  id: string;
  name?: string;
  state?: ThingState | null;
};

/** A sensor channel of a device (intelligent thing), with its last reading */
export type Sensor = {
  /** Channel id, e.g. "81000e9d#4_C4" */
  id: string;
  /** Device owning the sensor */
  itId: string;
  state?: {
    id: SensorFactor;
    /** Flexom reports readings as strings, e.g. "23.0" */
    value: string | number | null;
    timestamp?: number;
  } | null;
  activated?: boolean;
};

export type EventType =
  | 'ACTUATOR_TARGET_STATE'
  | 'ACTUATOR_HARDWARE_STATE'
  | 'ACTUATOR_CURRENT_STATE'
  | 'SENSOR_STATE'
  | 'IT_STATE'
  | 'FACTOR_TARGET_STATE'
  | 'FACTOR_CURRENT_STATE'
  | 'OBJECTIVE_STATE'
  | 'DATA_PROVIDER'
  | 'ENTITY_MANAGEMENT';

export type ActuatorHardwareStateEvent = {
  type: 'ACTUATOR_HARDWARE_STATE';
  timestamp: number;
  zoneId?: string;
  /** Intelligent thing (device) owning the actuator */
  itId?: string;
  factorId: Factor;
  value: { value: number; actuatorId?: string };
};

/** What an actuator moves, e.g. a venetian blind has a roller and slats */
export type ActuationRepresentation =
  'VERTICAL_ROLLER' | 'HORIZONTAL_SLATS' | (string & {});

export type Actuator = {
  itId: string;
  actuatorId: string;
  actionningRepresentation?: ActuationRepresentation;
  /** Factors the actuator acts on, e.g. BRI for a light */
  factors?: Factor[];
  /** Actual state reported by the device */
  hardwareState?: { value: number | null } | null;
};

/** New reading of a sensor channel */
export type SensorStateEvent = {
  type: 'SENSOR_STATE';
  timestamp: number;
  zoneId?: string;
  itId?: string;
  sensorId?: string;
  factorId?: SensorFactor;
  /** A number, or a string like "0" depending on the factor */
  value?: unknown;
};

export type HemisEvent =
  | ActuatorHardwareStateEvent
  | SensorStateEvent
  | {
      type: Exclude<EventType, 'ACTUATOR_HARDWARE_STATE' | 'SENSOR_STATE'>;
      timestamp: number;
      zoneId?: string;
      itId?: string;
      factorId?: string;
      value?: unknown;
    };

export type EventListener = {
  id: string;
  events?: EventType[];
  zoneId?: string;
  listener: (event: HemisEvent) => void;
  /** Called after the WebSocket reconnects, as events may have been missed */
  onReconnect?: () => void;
};
