import { generateVAPIDKeys, sendNotification } from "web-push";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appConfig, memberships, pushSubscriptions } from "../db/schema.js";
import type { AlertEvent, LiveState } from "./liveState.js";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * Push endpoints want a contact in the VAPID JWT. There is nothing to reach
 * on a self-hosted box, so a constant placeholder is fine.
 */
const VAPID_SUBJECT = "mailto:admin@helio.local";

let cachedKeys: VapidKeys | null = null;

/**
 * The instance's VAPID key pair. Generated once and stored in app_config so
 * subscriptions survive redeploys (a new key pair would orphan them all).
 * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars override for people who
 * bring their own.
 */
export async function getVapidKeys(db: Db): Promise<VapidKeys> {
  if (cachedKeys) return cachedKeys;
  const envPub = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;
  if (envPub && envPriv) {
    cachedKeys = { publicKey: envPub, privateKey: envPriv };
    return cachedKeys;
  }
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, "vapid"));
  if (row) {
    cachedKeys = row.value as VapidKeys;
    return cachedKeys;
  }
  const generated = generateVAPIDKeys();
  await db
    .insert(appConfig)
    .values({ key: "vapid", value: generated })
    .onConflictDoNothing();
  // Re-read in case a parallel boot won the insert race.
  const [winner] = await db.select().from(appConfig).where(eq(appConfig.key, "vapid"));
  cachedKeys = (winner?.value as VapidKeys | undefined) ?? generated;
  return cachedKeys;
}

/** Test hook: forget the cached key pair. */
export function resetVapidCache(): void {
  cachedKeys = null;
}

/**
 * Sends warning/critical alerts of one environment to the push subscriptions
 * of all its members. Listens to the same LiveState "alert" event the
 * WebSocket layer uses, so every alert channel stays in sync.
 */
export class PushDispatcher {
  private listener: ((alert: AlertEvent) => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly environmentId: string,
    private readonly liveState: LiveState,
    private readonly log: { warn: (...a: unknown[]) => void },
  ) {}

  start(): void {
    this.listener = (alert: AlertEvent) => {
      if (alert.severity === "info") return;
      void this.dispatch(alert).catch((err) =>
        this.log.warn(`[env ${this.environmentId}] push dispatch failed: ${(err as Error).message}`),
      );
    };
    this.liveState.on("alert", this.listener);
  }

  stop(): void {
    if (this.listener) this.liveState.off("alert", this.listener);
    this.listener = null;
  }

  private async dispatch(alert: AlertEvent): Promise<void> {
    const subs = await this.db
      .select({
        id: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .innerJoin(memberships, eq(memberships.userId, pushSubscriptions.userId))
      .where(eq(memberships.environmentId, this.environmentId));
    if (subs.length === 0) return;

    const keys = await getVapidKeys(this.db);
    const payload = JSON.stringify({
      title: alert.title,
      body: alert.body,
      severity: alert.severity,
      envId: this.environmentId,
      url: `/environment/${this.environmentId}/alerts`,
    });

    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            {
              TTL: 3600,
              vapidDetails: { subject: VAPID_SUBJECT, ...keys },
            },
          );
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // The browser dropped the subscription — forget it.
          if (status === 404 || status === 410) {
            await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
          } else {
            this.log.warn(
              `[env ${this.environmentId}] push to ${sub.endpoint.slice(0, 48)}… failed: ${(err as Error).message}`,
            );
          }
        }
      }),
    );
  }
}
