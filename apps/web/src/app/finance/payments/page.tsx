"use client";
import { PageHeader, StatCard, TableCard, Th, Td, Badge, Button } from "@/components/ui";
import { formatCurrency } from "@/lib/utils";
import { Download } from "lucide-react";

const PAYMENTS = [
  { dealer: "Raju Agencies", method: "wallet", amount: 933, date: "23 Jan 2025", status: "paid" },
  { dealer: "Krishna Stores", method: "upi", amount: 1272, date: "22 Jan 2025", status: "paid" },
  { dealer: "Laxmi Traders", method: "wallet", amount: 682, date: "21 Jan 2025", status: "paid" },
  { dealer: "Ganesh Dairy", method: "credit", amount: 1038, date: "20 Jan 2025", status: "pending" },
  { dealer: "Mahalakshmi Agency", method: "wallet", amount: 450, date: "19 Jan 2025", status: "paid" },
];

export default function PaymentOverviewPage() {
  return (
    <>
      <PageHeader icon="💰" title="Payment Overview" subtitle="Payment collections and wallet balances"
        actions={<Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard icon="₹" iconBg="bg-success/10 text-success" value="₹4.8L" label="Total Collected" />
        <StatCard icon="💳" iconBg="bg-brand-light text-brand" value="₹1.2L" label="Wallet Balance (All)" />
        <StatCard icon="⚠️" iconBg="bg-warning/10 text-warning" value="₹32K" label="Outstanding Dues" />
        <StatCard icon="📈" iconBg="bg-success/10 text-success" value="₹84K" label="Today's Collection" />
      </div>
      <TableCard>
        <thead><tr><Th>Dealer</Th><Th>Method</Th><Th className="text-right">Amount</Th><Th>Date</Th><Th>Status</Th></tr></thead>
        <tbody>{PAYMENTS.map((p, i) => (
          <tr key={i} className="hover:bg-muted/50"><Td className="font-semibold">{p.dealer}</Td><Td><Badge variant={p.method === "wallet" ? "active" : p.method === "upi" ? "badge-brand" : "pending"}>{p.method}</Badge></Td><Td className="text-right font-bold">{formatCurrency(p.amount)}</Td><Td className="text-muted-fg">{p.date}</Td><Td><Badge variant={p.status}>{p.status}</Badge></Td></tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
