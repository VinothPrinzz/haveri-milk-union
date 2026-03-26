import { ErpShell } from "@/components/layout/erp-shell";

export default function SectionLayout({ children }: { children: React.ReactNode }) {
  return <ErpShell>{children}</ErpShell>;
}
