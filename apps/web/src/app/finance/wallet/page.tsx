"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency, cn } from "@/lib/utils";
import { PageHeader, TableCard, Th, Td, Button } from "@/components/ui";
import { Download } from "lucide-react";
import { exportCSV } from "@/lib/export";
export default function WalletLedgerPage() {
  const { data: dealersData } = useQuery({ queryKey: ["dealers-wallet"], queryFn: () => api.get("/api/v1/dealers", { page: 1, limit: 50 }) });
  const dealers = dealersData?.data ?? []; const [selectedId, setSelectedId] = useState<string|null>(null);
  const sel = selectedId || dealers[0]?.id;
  const { data: ledgerData } = useQuery({ queryKey: ["wallet-ledger", sel], queryFn: () => sel ? api.get(`/api/v1/dealers/${sel}/ledger`, { page: 1, limit: 50 }) : null, enabled: !!sel });
  const entries = ledgerData?.data ?? [];
  const selectedDealer = dealers.find((d: any) => d.id === sel);
  const totalBalance = dealers.reduce((a: number, d: any) => a + parseFloat(d.wallet_balance || "0"), 0);
  const totalCredits = entries.filter((e: any)=>e.type==="credit").reduce((a: number,e: any)=>a+parseFloat(e.amount),0);
  const totalDebits = entries.filter((e: any)=>e.type==="debit").reduce((a: number,e: any)=>a+parseFloat(e.amount),0);

  const handleExport = () => exportCSV(entries.map((e: any) => ({ Date: new Date(e.createdAt).toLocaleDateString("en-IN"), Type: e.type, Amount: e.amount, Ref: e.reference_type, Description: e.description||"", Balance: e.balance_after })), `wallet_${selectedDealer?.name||"all"}`);

  return (
    <>
      <PageHeader icon="👛" title="Wallet / Ledger" subtitle="Dealer wallet balances and transaction history"
        actions={<Button variant="outline" size="sm" onClick={handleExport}><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center"><div className="font-display text-[22px] font-black text-fg">{formatCurrency(totalBalance)}</div><div className="text-[11px] font-semibold text-muted-fg">Total Wallet Balance</div></div>
        <div className="bg-card rounded-[10px] border-2 border-success/20 shadow-card p-4 text-center" style={{background:"rgba(22,163,74,.05)"}}><div className="font-display text-[22px] font-black text-success">{formatCurrency(totalCredits)}</div><div className="text-[11px] font-semibold text-muted-fg">Credits</div></div>
        <div className="bg-card rounded-[10px] border-2 border-danger/20 shadow-card p-4 text-center" style={{background:"rgba(220,38,38,.05)"}}><div className="font-display text-[22px] font-black text-danger">{formatCurrency(totalDebits)}</div><div className="text-[11px] font-semibold text-muted-fg">Debits</div></div>
      </div>
      <div className="flex gap-2 mb-5 flex-wrap">{dealers.map((d: any) => (<button key={d.id} onClick={() => setSelectedId(d.id)} className={cn("px-3 py-1.5 rounded-full text-[10px] font-bold border transition-colors", d.id===sel?"bg-brand border-brand text-white":"bg-card border-border text-muted-fg")}>{d.name}</button>))}</div>
      <TableCard>
        <thead><tr><Th>Date</Th><Th>Ref</Th><Th>Description</Th><Th className="text-right">Debit</Th><Th className="text-right">Credit</Th><Th className="text-right">Balance</Th></tr></thead>
        <tbody>{entries.map((e: any) => (<tr key={e.id} className="hover:bg-muted/50"><Td className="text-muted-fg">{new Date(e.createdAt).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"})}</Td><Td className="font-mono text-[10px]">{e.reference_type}</Td><Td>{e.description||"—"}</Td>
          <Td className="text-right">{e.type==="debit"?<span className="text-danger font-bold">↓ {formatCurrency(e.amount)}</span>:"—"}</Td><Td className="text-right">{e.type==="credit"?<span className="text-success font-bold">↑ {formatCurrency(e.amount)}</span>:"—"}</Td><Td className="text-right font-bold">{formatCurrency(e.balance_after)}</Td>
        </tr>))}{entries.length===0&&<tr><Td colSpan={6} className="text-center py-8 text-muted-fg">No transactions</Td></tr>}</tbody>
      </TableCard>
    </>
  );
}
