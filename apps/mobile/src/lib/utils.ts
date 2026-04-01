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
