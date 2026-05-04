import { syncTriggerCycle } from "@/adapters";
import { useEffect, useRef } from "react";
import { syncStorage } from "../storage/keyring";

const ACTIVE_APP_SYNC_THROTTLE_MS = 30_000;
const VISIBLE_SYNC_INTERVAL_MS = 60_000;

interface UseActiveAppSyncTriggerOptions {
  enabled: boolean;
  requireWindowFocusForInterval?: boolean;
}

type ActiveAppSyncReason = "focus" | "online" | "visible";

export function useActiveAppSyncTrigger({
  enabled,
  requireWindowFocusForInterval = false,
}: UseActiveAppSyncTriggerOptions) {
  // The backend starts the background sync loop on app startup; seed the
  // throttle so startup focus/online events do not queue a duplicate cycle.
  const lastAttemptAtRef = useRef(Date.now());
  const lastOnlineRecoveryAttemptAtRef = useRef(Number.NEGATIVE_INFINITY);
  const lastAttemptFailedRef = useRef(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const triggerSync = (reason: ActiveAppSyncReason) => {
      const now = Date.now();
      const shouldBypassThrottle =
        reason === "online" &&
        lastAttemptFailedRef.current &&
        now - lastOnlineRecoveryAttemptAtRef.current >= ACTIVE_APP_SYNC_THROTTLE_MS;
      if (inFlightRef.current) {
        return;
      }
      if (!shouldBypassThrottle && now - lastAttemptAtRef.current < ACTIVE_APP_SYNC_THROTTLE_MS) {
        return;
      }

      lastAttemptAtRef.current = now;
      if (shouldBypassThrottle) {
        lastOnlineRecoveryAttemptAtRef.current = now;
      }
      inFlightRef.current = true;
      void (async () => {
        const deviceId = await syncStorage.getDeviceId();
        if (!deviceId) {
          lastAttemptFailedRef.current = false;
          return;
        }

        const rootKey = await syncStorage.getRootKey();
        if (!rootKey) {
          lastAttemptFailedRef.current = false;
          return;
        }

        await syncTriggerCycle();
        lastAttemptFailedRef.current = false;
      })()
        .catch(() => {
          lastAttemptFailedRef.current = true;
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    };

    const isActiveForInterval = () =>
      document.visibilityState === "visible" &&
      (!requireWindowFocusForInterval || document.hasFocus());

    const handleVisibilityChange = () => {
      if (isActiveForInterval()) {
        triggerSync("visible");
      }
    };
    const handleFocus = () => {
      if (document.visibilityState === "visible") {
        triggerSync("focus");
      }
    };
    const handleOnline = () => triggerSync("online");
    const visibleIntervalId = window.setInterval(() => {
      if (isActiveForInterval()) {
        triggerSync("visible");
      }
    }, VISIBLE_SYNC_INTERVAL_MS);

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
      window.clearInterval(visibleIntervalId);
    };
  }, [enabled, requireWindowFocusForInterval]);
}
