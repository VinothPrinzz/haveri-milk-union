// apps/web/src/pages/sales-reports/VillageAgencyReports.tsx
// ════════════════════════════════════════════════════════════════════
// Two customer-master driven reports:
//
//   • City / Village Wise Sales — agent sales grouped by the customer's
//     City / Village inside its taluka: a summary page (one line per
//     village) and a detail page (each village's agents + subtotal).
//
//   • Agency Report — when each agency started and how many started in
//     the period: a summary page (counts per taluka + the last 12 months),
//     the agencies that started in the period, and the full register.
// ════════════════════════════════════════════════════════════════════
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { fmtINR } from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { toCsv } from "@/lib/exporters";
import { todayIST } from "@/lib/istDate";
import { fetchZones } from "@/services/api";
import {
  fetchVillageWise, fetchAgencyReport,
  type VillageWiseResponse, type AgencyReportResponse, type AgencyRow,
} from "@/services/report";

// dd-mm-yyyy — the on-paper date format.
const fmtDMY = (iso: string) => {
  const [y, m, d] = String(iso ?? "").slice(0, 10).split("-");
  return y && m && d ? `${d}-${m}-${y}` : (iso ?? "");
};
const fmtPeriod = (from: string, to: string) => `${fmtDMY(from)} to ${fmtDMY(to)}`;
// Ltr / Kg: blank for 0, else up to 2 decimals.
const fmtVol = (n: number) =>
  n ? Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtMonth = (ym: string) => {
  const [y, m] = ym.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
};

// How long ago a start date was, as "2 yr 3 mo" / "5 mo" / "12 days".
function since(startIso: string, asOfIso: string): string {
  const [sy, sm, sd] = startIso.split("-").map(Number);
  const [ay, am, ad] = asOfIso.split("-").map(Number);
  if (!sy || !ay) return "";
  let months = (ay - sy) * 12 + (am - sm);
  if (ad < sd) months -= 1;
  if (months < 1) {
    const days = Math.round(
      (Date.UTC(ay, am - 1, ad) - Date.UTC(sy, sm - 1, sd)) / 86_400_000,
    );
    return days <= 0 ? "New" : `${days} day${days === 1 ? "" : "s"}`;
  }
  const yr = Math.floor(months / 12);
  const mo = months % 12;
  return [yr ? `${yr} yr` : "", mo ? `${mo} mo` : ""].filter(Boolean).join(" ");
}

const th = "border border-border py-1 px-1.5 font-bold";
const td = "border border-border py-0.5 px-1.5";

// ── Shared filter state: From / To / Taluka ─────────────────────────
function usePeriodTalukaFilters() {
  const today = todayIST();
  const [from, setFrom] = useState(today.substring(0, 8) + "01");
  const [to, setTo] = useState(today);
  const [zoneId, setZoneId] = useState("");
  const { data: zones = [] } = useQuery({ queryKey: ["zones"], queryFn: fetchZones });
  const zoneOptions: F9Option[] = useMemo(
    () => zones.map(z => ({ value: z.id, label: z.name })),
    [zones],
  );
  const zoneName = zoneOptions.find(o => o.value === zoneId)?.label ?? "All talukas";

  const filters = (
    <>
      <div>
        <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">From</label>
        <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="erp-input w-40" />
      </div>
      <div>
        <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">To</label>
        <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="erp-input w-40" />
      </div>
      <div>
        <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Taluka</label>
        <div className="w-52">
          <F9SearchSelect
            value={zoneId}
            onChange={v => setZoneId(v ?? "")}
            options={zoneOptions}
            allowAll
            allLabel="All talukas"
            placeholder="All talukas"
          />
        </div>
      </div>
    </>
  );
  return { from, to, zoneId: zoneId || undefined, zoneName, filters };
}

// ════════════════════════════════════════════════════════════════════
// City / Village Wise Sales
// ════════════════════════════════════════════════════════════════════
export function VillageWiseSalesReport() {
  const { from, to, zoneId, zoneName, filters } = usePeriodTalukaFilters();
  const [generated, setGenerated] = useState(false);

  const { data, isLoading, refetch } = useQuery<VillageWiseResponse>({
    queryKey: ["village-wise", from, to, zoneId],
    queryFn: () => fetchVillageWise({ from, to, zoneId }),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  const pages: ReactNode[] = generated && data && data.villages.length > 0
    ? [
        // ── Page 1: one line per village ──
        <div key="summary">
          <p className="report-page-note">Summary: one line per City / Village (Milk in Ltr, Curd in Kg)</p>
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/50">
                <th className={`${th} text-right w-10`}>Sl</th>
                <th className={`${th} text-left`}>Taluka</th>
                <th className={`${th} text-left`}>City / Village</th>
                <th className={`${th} text-right num w-16`}>Agents</th>
                <th className={`${th} text-right num w-24`}>Milk (Ltr)</th>
                <th className={`${th} text-right num w-24`}>Curd (Kg)</th>
                <th className={`${th} text-right num w-32`}>Total Amt ₹</th>
              </tr>
            </thead>
            <tbody>
              {data.villages.map((v, i) => (
                <tr key={`${v.taluka}|${v.village}`}>
                  <td className={`${td} text-right num`}>{i + 1}</td>
                  <td className={td}>{v.taluka}</td>
                  <td className={`${td} ${v.villageSet ? "font-medium" : "italic text-muted-foreground"}`}>{v.village}</td>
                  <td className={`${td} text-right num`}>{v.totals.customers}</td>
                  <td className={`${td} text-right num`}>{fmtVol(v.totals.milk)}</td>
                  <td className={`${td} text-right num`}>{fmtVol(v.totals.curd)}</td>
                  <td className={`${td} text-right num`}>{fmtINR(v.totals.amount)}</td>
                </tr>
              ))}
              <tr className="font-bold bg-muted/40">
                <td colSpan={3} className={`${td} text-right`}>TOTAL</td>
                <td className={`${td} text-right num`}>{data.totals.customers}</td>
                <td className={`${td} text-right num`}>{fmtVol(data.totals.milk)}</td>
                <td className={`${td} text-right num`}>{fmtVol(data.totals.curd)}</td>
                <td className={`${td} text-right num`}>{fmtINR(data.totals.amount)}</td>
              </tr>
            </tbody>
          </table>
        </div>,

        // ── Page 2: each village's agents ──
        <div key="detail">
          <p className="report-page-note">Agents in each City / Village (Milk in Ltr, Curd in Kg)</p>
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/50">
                <th className={`${th} text-right w-10`}>Sl</th>
                <th className={`${th} text-left w-16`}>Code</th>
                <th className={`${th} text-left`}>Customer Name</th>
                <th className={`${th} text-right num w-24`}>Milk (Ltr)</th>
                <th className={`${th} text-right num w-24`}>Curd (Kg)</th>
                <th className={`${th} text-right num w-32`}>Total Amt ₹</th>
              </tr>
            </thead>
            <tbody>
              {data.villages.map(v => (
                <Fragment key={`${v.taluka}|${v.village}`}>
                  <tr className="bg-muted/30">
                    <td colSpan={6} className={`${td} font-bold`}>
                      {v.village} <span className="font-normal text-muted-foreground">· {v.taluka}</span>
                    </td>
                  </tr>
                  {v.customers.map((c, i) => (
                    <tr key={c.id}>
                      <td className={`${td} text-right num`}>{i + 1}</td>
                      <td className={`${td} font-mono`}>{c.code}</td>
                      <td className={td}>{c.name}</td>
                      <td className={`${td} text-right num`}>{fmtVol(c.milk)}</td>
                      <td className={`${td} text-right num`}>{fmtVol(c.curd)}</td>
                      <td className={`${td} text-right num`}>{fmtINR(c.amount)}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td colSpan={3} className={`${td} text-right`}>{v.village} TOTAL</td>
                    <td className={`${td} text-right num`}>{fmtVol(v.totals.milk)}</td>
                    <td className={`${td} text-right num`}>{fmtVol(v.totals.curd)}</td>
                    <td className={`${td} text-right num`}>{fmtINR(v.totals.amount)}</td>
                  </tr>
                </Fragment>
              ))}
              <tr className="font-bold bg-muted/40">
                <td colSpan={3} className={`${td} text-right`}>GRAND TOTAL</td>
                <td className={`${td} text-right num`}>{fmtVol(data.totals.milk)}</td>
                <td className={`${td} text-right num`}>{fmtVol(data.totals.curd)}</td>
                <td className={`${td} text-right num`}>{fmtINR(data.totals.amount)}</td>
              </tr>
            </tbody>
          </table>
        </div>,
      ]
    : [];

  const exporters: Exporter[] = data ? [{
    label: "CSV",
    filename: `city-village-sales_${from}_${to}.csv`,
    mimeType: "text/csv",
    build: () => {
      const out: (string | number)[][] = [
        [`City / Village Wise Sales, ${fmtPeriod(from, to)}`, zoneName],
        ["Taluka", "City / Village", "Code", "Customer Name", "Milk (Ltr)", "Curd (Kg)", "Total Amt"],
      ];
      for (const v of data.villages) {
        for (const c of v.customers) {
          out.push([v.taluka, v.village, c.code, c.name, c.milk, c.curd, c.amount]);
        }
        out.push([v.taluka, `${v.village} TOTAL`, "", `${v.totals.customers} agents`, v.totals.milk, v.totals.curd, v.totals.amount]);
      }
      out.push(["", "GRAND TOTAL", "", `${data.totals.customers} agents`, data.totals.milk, data.totals.curd, data.totals.amount]);
      return toCsv(out);
    },
  }] : [];

  return (
    <ReportShell
      title="City / Village Wise Sales"
      subtitle="Agent sales by the customer's City / Village, inside each taluka"
      printOrientation="portrait"
      filters={filters}
      onGenerate={handleGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta
          title="City / Village Wise Sales"
          rows={[
            { label: "Period", value: fmtPeriod(from, to) },
            { label: "Taluka", value: zoneName },
          ]}
        />
      }
      state={{
        generated,
        loading: isLoading,
        pages,
        pageLabel: i => (i === 0 ? "Summary" : "Agents"),
        emptyMessage: "No agent sales in this period",
      }}
    />
  );
}

// ════════════════════════════════════════════════════════════════════
// Agency Report
// ════════════════════════════════════════════════════════════════════
function AgencyTable({ rows, asOf }: { rows: AgencyRow[]; asOf: string }) {
  return (
    <table className="w-full text-[11px] border-collapse">
      <thead>
        <tr className="bg-muted/50">
          <th className={`${th} text-right w-10`}>Sl</th>
          <th className={`${th} text-left w-14`}>Code</th>
          <th className={`${th} text-left`}>Agency Name</th>
          <th className={`${th} text-left`}>Taluka</th>
          <th className={`${th} text-left`}>City / Village</th>
          <th className={`${th} text-left w-14`}>Route</th>
          <th className={`${th} text-left w-24`}>Started On</th>
          <th className={`${th} text-left w-20`}>Since</th>
          <th className={`${th} text-left w-16`}>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={9} className={`${td} py-3 text-center text-muted-foreground`}>None</td>
          </tr>
        ) : rows.map((r, i) => (
          <tr key={r.id}>
            <td className={`${td} text-right num`}>{i + 1}</td>
            <td className={`${td} font-mono`}>{r.code}</td>
            <td className={td}>{r.name}</td>
            <td className={td}>{r.taluka}</td>
            <td className={td}>{r.village}</td>
            <td className={`${td} font-mono`}>{r.routeCode}</td>
            <td className={`${td} num`}>{fmtDMY(r.startDate)}</td>
            <td className={td}>{since(r.startDate, asOf)}</td>
            <td className={`${td} ${r.active ? "" : "text-muted-foreground"}`}>{r.active ? "Active" : "Inactive"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AgencyReport() {
  const { from, to, zoneId, zoneName, filters } = usePeriodTalukaFilters();
  const [generated, setGenerated] = useState(false);

  const { data, isLoading, refetch } = useQuery<AgencyReportResponse>({
    queryKey: ["agency-report", from, to, zoneId],
    queryFn: () => fetchAgencyReport({ from, to, zoneId }),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  const pages: ReactNode[] = generated && data
    ? [
        // ── Page 1: counts ──
        <div key="summary" className="space-y-4">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="border border-border py-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Started in period</div>
              <div className="text-[20px] font-bold num">{data.summary.startedInPeriod}</div>
            </div>
            <div className="border border-border py-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Agencies as of {fmtDMY(data.to)}</div>
              <div className="text-[20px] font-bold num">{data.summary.total}</div>
            </div>
            <div className="border border-border py-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Active today</div>
              <div className="text-[20px] font-bold num">{data.summary.active}</div>
            </div>
          </div>

          <div>
            <p className="report-page-note">Agencies per taluka</p>
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="bg-muted/50">
                  <th className={`${th} text-right w-10`}>Sl</th>
                  <th className={`${th} text-left`}>Taluka</th>
                  <th className={`${th} text-right num w-32`}>Started in Period</th>
                  <th className={`${th} text-right num w-28`}>Total Agencies</th>
                  <th className={`${th} text-right num w-24`}>Active</th>
                </tr>
              </thead>
              <tbody>
                {data.summary.talukas.map((t, i) => (
                  <tr key={t.taluka}>
                    <td className={`${td} text-right num`}>{i + 1}</td>
                    <td className={td}>{t.taluka}</td>
                    <td className={`${td} text-right num font-semibold`}>{t.started || ""}</td>
                    <td className={`${td} text-right num`}>{t.total}</td>
                    <td className={`${td} text-right num`}>{t.active}</td>
                  </tr>
                ))}
                <tr className="font-bold bg-muted/40">
                  <td colSpan={2} className={`${td} text-right`}>TOTAL</td>
                  <td className={`${td} text-right num`}>{data.summary.startedInPeriod}</td>
                  <td className={`${td} text-right num`}>{data.summary.total}</td>
                  <td className={`${td} text-right num`}>{data.summary.active}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <p className="report-page-note">Agencies started each month (last 12 months)</p>
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="bg-muted/50">
                  {data.months.map(m => (
                    <th key={m.month} className={`${th} text-center`}>{fmtMonth(m.month)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {data.months.map(m => (
                    <td key={m.month} className={`${td} text-center num`}>{m.started}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>,

        // ── Page 2: agencies that started in the period ──
        <div key="new">
          <p className="report-page-note">
            Agencies started {fmtPeriod(data.from, data.to)}: {data.newAgencies.length}
          </p>
          <AgencyTable rows={data.newAgencies} asOf={data.to} />
        </div>,

        // ── Page 3: register of every agency ──
        <div key="register">
          <p className="report-page-note">Agency register: every agency and when it started (oldest first)</p>
          <AgencyTable rows={data.register} asOf={data.to} />
        </div>,
      ]
    : [];

  const exporters: Exporter[] = data ? [{
    label: "CSV",
    filename: `agency-report_${from}_${to}.csv`,
    mimeType: "text/csv",
    build: () => {
      const head = ["Code", "Agency Name", "Phone", "Type", "Taluka", "City / Village", "Route", "Started On", "Since", "Status"];
      const line = (r: AgencyRow) => [
        r.code, r.name, r.phone, r.customerType, r.taluka, r.village, r.routeCode,
        fmtDMY(r.startDate), since(r.startDate, data.to), r.active ? "Active" : "Inactive",
      ];
      const out: (string | number)[][] = [
        [`Agency Report, ${fmtPeriod(from, to)}`, zoneName],
        [],
        ["Taluka", "Started in Period", "Total Agencies", "Active"],
        ...data.summary.talukas.map(t => [t.taluka, t.started, t.total, t.active]),
        ["TOTAL", data.summary.startedInPeriod, data.summary.total, data.summary.active],
        [],
        ["Month", "Agencies Started"],
        ...data.months.map(m => [fmtMonth(m.month), m.started]),
        [],
        [`Agencies started in period (${data.newAgencies.length})`],
        head,
        ...data.newAgencies.map(line),
        [],
        ["Agency register"],
        head,
        ...data.register.map(line),
      ];
      return toCsv(out);
    },
  }] : [];

  return (
    <ReportShell
      title="Agency Report"
      subtitle="When each agency started, and how many agencies started in the period"
      printOrientation="portrait"
      filters={filters}
      onGenerate={handleGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta
          title="Agency Report"
          rows={[
            { label: "Period", value: fmtPeriod(from, to) },
            { label: "Taluka", value: zoneName },
          ]}
        />
      }
      state={{
        generated,
        loading: isLoading,
        pages,
        pageLabel: i => ["Summary", "Started in period", "Register"][i] ?? "",
        emptyMessage: "No agencies found",
      }}
    />
  );
}
