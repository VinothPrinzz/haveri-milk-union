import React, { useMemo } from "react";
import { useAuthStore } from "../store/auth";
import { useWindowStatus } from "../hooks/useWindow";
import IndentCart from "../components/IndentCart";

/**
 * CartScreen — thin wrapper that hosts the IndentCart component.
 *
 * Why a separate file:
 *   - App.tsx routes to "cart" as a top-level screen state, not as a tab
 *   - IndentCart needs the dealer's location label + a derived window subtitle
 *     ("Window closes in 1h 23m") that this screen computes from useWindowStatus
 *   - Keeps IndentCart purely presentational so it can be used in tests + Storybook
 *
 * Prop signature matches what App.tsx already passes (no changes needed there).
 */

interface CartScreenProps {
  onBack: () => void;
  onOrderPlaced: (orderId: string) => void;
}

export default function CartScreen({ onBack, onOrderPlaced }: CartScreenProps) {
  const dealer = useAuthStore((s) => s.dealer);
  // Time-windows are route-based — the endpoint is keyed by routeId, not
  // zoneId. Passing zoneId queried the wrong key and yielded no window.
  const windowQuery = useWindowStatus(dealer?.routeId);

  // Build a friendly subtitle from the window remaining time.
  const windowSubtitle = useMemo(() => {
    const win = windowQuery.data;
    if (!win) return undefined;
    if (win.state === "closed") return "Window closed";

    const totalSec = win.remainingSeconds;
    if (totalSec <= 0) return "Window closing";

    const hours = Math.floor(totalSec / 3600);
    const mins  = Math.floor((totalSec % 3600) / 60);

    if (hours > 0) {
      return `Window closes in ${hours}h ${mins}m`;
    }
    return `Window closes in ${mins}m`;
  }, [windowQuery.data]);

  // Location label: mirror the profile screen — show the dealer's route
  // first (that's their assigned delivery route), then fall back to zone
  // or a free-text location label. Previously this showed the old zone.
  const locationLabel = useMemo(() => {
    if (!dealer) return "Your Location";
    return (
      dealer.routeName ||
      dealer.zoneName ||
      dealer.locationLabel ||
      "Your Location"
    );
  }, [dealer]);

  return (
    <IndentCart
    windowSubtitle={windowSubtitle}
    locationLabel={locationLabel}
    creditLimit={dealer?.creditLimit ?? 0}
    creditAvailable={Math.max(0, dealer?.creditAvailable ?? 0)}
    onBack={onBack}
    onChangeLocation={() => {}}
    onOrderPlaced={onOrderPlaced}
  />
  );
}