import { ErpShell } from "@/components/layout/erp-shell";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ErpShell>{children}</ErpShell>;
}
