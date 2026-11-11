import { connect, type MqttClient } from "mqtt";
import type { LiveSnapshot, LiveState } from "./liveState.js";
import type { AppSettings } from "./settings.js";

interface Logger {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
}

/** Live snapshots are published at most this often (the poller is faster). */
const PUBLISH_INTERVAL_MS = 10_000;

export interface MqttStatus {
  enabled: boolean;
  connected: boolean;
  topicPrefix: string | null;
  lastPublishAt: string | null;
  lastError: string | null;
}

/** Home Assistant discovery metadata for the sensors we expose. */
const HA_SENSORS: {
  key: keyof LiveSnapshot;
  name: string;
  unit: string;
  deviceClass: string;
  stateClass: string;
}[] = [
  { key: "pvW", name: "Solar power", unit: "W", deviceClass: "power", stateClass: "measurement" },
  { key: "loadW", name: "Home load", unit: "W", deviceClass: "power", stateClass: "measurement" },
  { key: "gridW", name: "Grid power", unit: "W", deviceClass: "power", stateClass: "measurement" },
  { key: "battW", name: "Battery power", unit: "W", deviceClass: "power", stateClass: "measurement" },
  { key: "soc", name: "Battery SOC", unit: "%", deviceClass: "battery", stateClass: "measurement" },
  { key: "dailyPvKwh", name: "Solar today", unit: "kWh", deviceClass: "energy", stateClass: "total_increasing" },
  { key: "dailyLoadKwh", name: "Consumption today", unit: "kWh", deviceClass: "energy", stateClass: "total_increasing" },
];

/**
 * Publishes the live snapshot to an MQTT broker (optionally announcing the
 * sensors via Home Assistant discovery). One instance per environment; call
 * `apply()` with the current settings to (re)connect and `stop()` to tear down.
 */
export class MqttPublisher {
  private client: MqttClient | null = null;
  private prefix = "";
  private lastPublish = 0;
  private lastPublishAt: string | null = null;
  private lastError: string | null = null;
  private enabled = false;

  constructor(
    private readonly envId: string,
    private readonly envName: string,
    private readonly liveState: LiveState,
    private readonly log: Logger,
  ) {}

  get status(): MqttStatus {
    return {
      enabled: this.enabled,
      connected: this.client?.connected ?? false,
      topicPrefix: this.enabled ? this.prefix : null,
      lastPublishAt: this.lastPublishAt,
      lastError: this.lastError,
    };
  }

  /** Reconnects with the given settings; disconnects when export is off. */
  apply(settings: AppSettings): void {
    this.stop();
    this.enabled = Boolean(settings.mqttEnabled && settings.mqttUrl);
    if (!this.enabled) return;

    this.prefix = settings.mqttTopicPrefix.trim() || `helio/${this.envId}`;
    try {
      this.client = connect(settings.mqttUrl, {
        username: settings.mqttUsername || undefined,
        password: settings.mqttPassword || undefined,
        connectTimeout: 10_000,
        reconnectPeriod: 15_000,
        will: { topic: `${this.prefix}/availability`, payload: "offline", qos: 0, retain: true },
      });
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log.warn(`[env ${this.envId}] mqtt connect failed: ${this.lastError}`);
      this.client = null;
      return;
    }

    this.client.on("connect", () => {
      this.lastError = null;
      this.client?.publish(`${this.prefix}/availability`, "online", { retain: true });
      if (settings.mqttHaDiscovery) this.publishDiscovery();
      this.log.info(`[env ${this.envId}] mqtt connected (${this.prefix})`);
    });
    this.client.on("error", (err) => {
      this.lastError = err.message;
    });
    this.liveState.on("live", this.onLive);
  }

  stop(): void {
    this.liveState.off("live", this.onLive);
    if (this.client) {
      try {
        this.client.publish(`${this.prefix}/availability`, "offline", { retain: true });
      } catch {
        /* already disconnected */
      }
      this.client.end(true);
      this.client = null;
    }
    this.enabled = false;
    this.lastPublish = 0;
  }

  private onLive = (snap: LiveSnapshot): void => {
    if (!this.client?.connected) return;
    const now = Date.now();
    if (now - this.lastPublish < PUBLISH_INTERVAL_MS) return;
    this.lastPublish = now;
    this.client.publish(`${this.prefix}/state`, JSON.stringify(snap), { retain: true });
    this.lastPublishAt = new Date().toISOString();
  };

  /** Retained HA discovery configs so the sensors appear automatically. */
  private publishDiscovery(): void {
    if (!this.client) return;
    const device = {
      identifiers: [`helio_${this.envId}`],
      name: `Helio ${this.envName}`,
      manufacturer: "Helio",
      model: "Deye inverter",
    };
    for (const s of HA_SENSORS) {
      const uid = `helio_${this.envId}_${s.key}`;
      const config = {
        name: s.name,
        unique_id: uid,
        state_topic: `${this.prefix}/state`,
        value_template: `{{ value_json.${s.key} }}`,
        unit_of_measurement: s.unit,
        device_class: s.deviceClass,
        state_class: s.stateClass,
        availability_topic: `${this.prefix}/availability`,
        device,
      };
      this.client.publish(`homeassistant/sensor/${uid}/config`, JSON.stringify(config), {
        retain: true,
      });
    }
  }
}
