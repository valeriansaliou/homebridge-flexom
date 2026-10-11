export type Logger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type Factor = 'BRI' | 'BRIEXT' | 'TMP';

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
  /** Actual state reported by the device */
  hardwareState?: { value: number | null } | null;
};

export type HemisEvent =
  | ActuatorHardwareStateEvent
  | {
      type: Exclude<EventType, 'ACTUATOR_HARDWARE_STATE'>;
      timestamp: number;
      zoneId?: string;
      factorId?: Factor;
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
