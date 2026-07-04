export function formatCurrency(amount: number | string): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return "₹0";
  return "₹" + num.toLocaleString("en-IN", { minimumFractionDigits: num % 1 !== 0 ? 2 : 0, maximumFractionDigits: 2 });
}

export function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatTime(date: string): string {
  return new Date(date).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

export function formatPrice(price: number | undefined | null): string {
  return (price ?? 0).toFixed(2);
}

/**
 * Random key for retry-safe order placement (PlaceOrderRequest.idempotencyKey).
 * The server enforces uniqueness per dealer, so this only needs to be unique
 * among one dealer's own submissions — Math.random is plenty, and
 * crypto.randomUUID isn't available in Hermes without a polyfill.
 */
export function newIdempotencyKey(): string {
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `idem_${Date.now().toString(36)}_${rand()}${rand()}`;
}