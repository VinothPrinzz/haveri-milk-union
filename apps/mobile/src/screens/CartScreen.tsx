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
  const windowQuery = useWindowStatus(dealer?.zoneId);

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

  // Location label: prefer locationLabel field, fall back to zoneName
  const locationLabel = useMemo(() => {
    if (!dealer) return "Your Location";
    const parts = [dealer.locationLabel, dealer.zoneName]
      .filter(Boolean) as string[];
    return parts.length > 0 ? parts.join(" - ") : "Your Location";
  }, [dealer]);

  return (
    <IndentCart
    windowSubtitle={windowSubtitle}
    locationLabel={locationLabel}
    walletBalance={dealer?.walletBalance ?? 0}
    creditLimit={dealer?.creditLimit ?? 0}
    creditAvailable={Math.max(0, (dealer?.creditLimit ?? 0) - (dealer?.creditOutstanding ?? 0))}
    onBack={onBack}
    onChangeLocation={() => {}}
    onOrderPlaced={onOrderPlaced}
  />
  );
}