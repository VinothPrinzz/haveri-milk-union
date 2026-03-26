"use client";
import { PageHeader, TableCard, Th, Td, Badge, Button } from "@/components/ui";
import { formatCurrency } from "@/lib/utils";
import { Download } from "lucide-react";
import { useState } from "react";
const DATA = [
  { name: "Raju Agencies", loc: "Haveri", orders: 28, revenue: 72000, avg: 2571, wallet: 12500, trend: "up" },
  { name: "Krishna Stores", loc: "Ranebennur", orders: 24, revenue: 58000, avg: 2417, wallet: 8200, trend: "up" },
  { name: "Laxmi Traders", loc: "Savanur", orders: 20, revenue: 45000, avg: 2250, wallet: 5600, trend: "down" },
  { name: "Ganesh Dairy", loc: "Byadgi", orders: 18, revenue: 42000, avg: 2333, wallet: 9800, trend: "up" },
  { name: "Mahalakshmi Agency", loc: "Hirekerur", orders: 15, revenue: 35000, avg: 2333, wallet: 3200, trend: "down" },
  { name: "Srinivas Distributors", loc: "Hangal", orders: 12, revenue: 28000, avg: 2333, wallet: 7500, trend: "up" },
];
export default function DealerReportPage() {
  const [dateFrom, setDateFrom] = useState(""); const [dateTo, setDateTo] = useState("");
  return (
    <>
      <PageHeader icon="👥" title="Dealer-wise Report" subtitle="Individual dealer performance and order history"
        actions={<Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="flex items-center gap-2 mb-6"><span className="text-[11px] font-semibold text-muted-fg">Period:</span><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /><span className="text-[10px] text-muted-fg">to</span><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /></div>
      <TableCard>
        <thead><tr><Th>Dealer</Th><Th>Location</Th><Th className="text-right">Orders</Th><Th className="text-right">Revenue</Th><Th className="text-right">Avg Order</Th><Th className="text-right">Wallet</Th><Th>Trend</Th></tr></thead>
        <tbody>{DATA.map(d => (
          <tr key={d.name} className="hover:bg-muted/50"><Td className="font-semibold">{d.name}</Td><Td>{d.loc}</Td><Td className="text-right">{d.orders}</Td><Td className="text-right font-bold">₹{(d.revenue/1000).toFixed(0)}K</Td><Td className="text-right text-muted-fg">{formatCurrency(d.avg)}</Td><Td className="text-right">{formatCurrency(d.wallet)}</Td><Td><Badge variant={d.trend==="up"?"active":"cancelled"}>{d.trend==="up"?"↗ Up":"↘ Down"}</Badge></Td></tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
