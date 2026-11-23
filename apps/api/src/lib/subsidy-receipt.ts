/**
 * Marker written to payments.notes on the counter receipt a cash subsidy
 * indent books (routes/subsidy-indents.ts). It is how that route revises its
 * own receipt and how a cancellation finds it to remove (lib/cancel-order.ts).
 */
export function subsidyReceiptNote(orderId: string): string {
  return `Counter receipt for subsidy indent ${orderId}`;
}
