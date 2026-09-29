// apps/web/src/pages/sales-reports/ProductTalukaReport.tsx
// ════════════════════════════════════════════════════════════════════
// Product Wise Taluka Sales
//
// Products down the side, talukas across the top, for a date range.
// Filterable by category, product and taluka. Pages:
//   • one quantity grid per unit (Ltr, Kg, then Nos for products with no
//     pack size), so volumes of different units are never summed together
//   • a value grid (₹, GST inclusive)
//   • a summary: total qty, average per day and total value per product
// Taluka columns are paged (TALUKAS_PER_PAGE) so the grid fits a landscape
// sheet; the row total only prints on the last column page.
// ════════════════════════════════════════════════════════════════════
import { type ReactNode, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { toCsv } from "@/lib/exporters";
import { ColumnPagedTable, paginateColumns, type ColumnDef } from "@/lib/reportColumnPaging";
import { fetchProductCategories, fetchProducts, fetchZones } from "@/services/api";
import {
  fetchProductTaluka,
  UNASSIGNED_TALUKA_ID,
  type ProductTalukaResponse,
  type ProductTalukaRow,
} from "@/services/report";
import { todayIST } from "@/lib/istDate";

// dd-mm-yyyy, the on-paper date format the union uses across sales reports.
const fmtDMY = (iso: string) => {
  const [y, m, d] = (iso ?? "").split("-");
  return y && m && d ? `${d}-${m}-${y}` : (iso ?? "");
};
const fmtPeriod = (from: string, to: string) => `${fmtDMY(from)} to ${fmtDMY(to)}`;

// Blank for 0 keeps the wide grids readable.
const fmtInt = (n: number) => (n ? Number(n).toLocaleString("en-IN") : "");
const fmtVol = (n: number) =>
  n ? Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "";
const fmtAmt = (n: number) =>
  n ? Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";

// Products with no pack size can't be converted to volume: they are
// reported in packets ("Nos").
const NOS = "Nos";
const volUnit = (unit?: string) => {
  const u = (unit ?? "").trim().toLowerCase();
  if (u === "l" || u === "ltr" || u === "litre" || u === "liter" || u === "ml") return "Ltr";
  if (u === "kg" || u === "g" || u === "gm" || u === "gram" || u === "grams") return "Kg";
  return NOS;
};
const rowUnit = (r: ProductTalukaRow) => (r.packSize > 0 ? volUnit(r.unit) : NOS);

const TALUKAS_PER_PAGE = 10;
const UNIT_ORDER = ["Ltr", "Kg", NOS];

type TalukaCol = { id: string; reportAlias: string };

export default function ProductTalukaReport() {
  const today = todayIST();
  const monthStart = today.substring(0, 8) + "01";
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [categoryId, setCategoryId] = useState("");
  const [productId, setProductId] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [generated, setGenerated] = useState(false);

  const { data: categories = [] } = useQuery({ queryKey: ["product-categories"], queryFn: fetchProductCategories });
  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });
  const { data: zones = [] } = useQuery({ queryKey: ["zones"], queryFn: fetchZones });

  const categoryOptions: F9Option[] = useMemo(
    () =>
      [...categories]
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name))
        .map(c => ({ value: c.id, label: c.name })),
    [categories],
  );
  // Product list narrows to the chosen category.
  const productOptions: F9Option[] = useMemo(
    () =>
      products
        .filter(p => !categoryId || p.categoryId === categoryId)
        .map(p => ({ value: p.id, label: p.name, sublabel: p.code, searchText: `${p.code} ${p.reportAlias}` })),
    [products, categoryId],
  );
  const zoneOptions: F9Option[] = useMemo(
    () => [...zones].sort((a, b) => a.name.localeCompare(b.name)).map(z => ({ value: z.id, label: z.name })),
    [zones],
  );

  const categoryLabel = categoryOptions.find(o => o.value === categoryId)?.label ?? "All categories";
  const productLabel = productOptions.find(o => o.value === productId)?.label ?? "All products";
  const zoneLabel = zoneOptions.find(o => o.value === zoneId)?.label ?? "All talukas";

  // Changing category drops a chosen product that isn't in it.
  const onCategoryChange = (v: string | null) => {
    const next = v ?? "";
    setCategoryId(next);
    if (productId && !products.some(p => p.id === productId && (!next || p.categoryId === next))) {
      setProductId("");
    }
  };

  const { data, isLoading, refetch } = useQuery<ProductTalukaResponse>({
    queryKey: ["product-taluka-sales", from, to, categoryId, productId, zoneId],
    queryFn: () =>
      fetchProductTaluka({
        from,
        to,
        categoryId: categoryId || undefined,
        productId: productId || undefined,
        zoneId: zoneId || undefined,
      }),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  const pages: ReactNode[] = [];
  const labels: string[] = [];

  // Rows grouped by unit, in UNIT_ORDER, skipping empty units.
  const unitGroups = UNIT_ORDER
    .map(unit => ({ unit, rows: (data?.rows ?? []).filter(r => rowUnit(r) === unit) }))
    .filter(g => g.rows.length > 0);

  const cellQty = (unit: string, r: ProductTalukaRow, talukaId: string) =>
    unit === NOS ? (r.qty[talukaId] ?? 0) : (r.vol[talukaId] ?? 0);
  const rowTotal = (unit: string, r: ProductTalukaRow) => (unit === NOS ? r.totalQty : r.totalVol);
  const rowAvg = (unit: string, r: ProductTalukaRow) => (unit === NOS ? r.avgQty : r.avgVol);

  if (generated && data && data.rows.length > 0) {
    const talukaCols: TalukaCol[] = data.talukas.map(t => ({ id: t.id, reportAlias: t.name }));
    const chunks = paginateColumns(talukaCols, TALUKAS_PER_PAGE);
    const fixedHead: ColumnDef<ProductTalukaRow>[] = [
      { label: "Code", accessor: r => r.code, width: "72px" },
      { label: "Product", accessor: r => r.reportAlias, width: "190px" },
    ];

    const pushGrid = (
      key: string,
      title: string,
      rows: ProductTalukaRow[],
      cell: (r: ProductTalukaRow, talukaId: string) => ReactNode,
      colTotal: (talukaId: string) => ReactNode,
      trailing: { label: string; value: (r: ProductTalukaRow) => ReactNode; total: ReactNode },
    ) => {
      chunks.forEach((cols, i) => {
        const last = i === chunks.length - 1;
        pages.push(
          <ColumnPagedTable<ProductTalukaRow, TalukaCol>
            key={`${key}-${i}`}
            title={`${title}${chunks.length > 1 ? ` (Talukas ${i + 1}/${chunks.length})` : ""}`}
            fixedLayout
            productColWidth="86px"
            fixedHead={fixedHead}
            productCols={cols}
            productCellRender={(r, t) => cell(r, t.id)}
            trailingHead={last ? [{ label: trailing.label, accessor: trailing.value, num: true, width: "100px" }] : undefined}
            rows={rows}
            rowKey={r => r.productId}
            totalRow={{
              fixedCells: ["", "TOTAL"],
              productCell: t => colTotal(t.id),
              trailingCells: last ? [trailing.total] : undefined,
            }}
          />,
        );
        labels.push(title);
      });
    };

    for (const g of unitGroups) {
      const title = g.unit === NOS ? "Quantity (Nos)" : `Quantity (${g.unit})`;
      const fmt = g.unit === NOS ? fmtInt : fmtVol;
      const colSum = (talukaId: string) => g.rows.reduce((s, r) => s + cellQty(g.unit, r, talukaId), 0);
      const grand = g.rows.reduce((s, r) => s + rowTotal(g.unit, r), 0);
      pushGrid(
        `qty-${g.unit}`,
        title,
        g.rows,
        (r, t) => fmt(cellQty(g.unit, r, t)),
        t => fmt(colSum(t)),
        { label: `Total ${g.unit}`, value: r => fmt(rowTotal(g.unit, r)), total: fmt(grand) },
      );
    }

    pushGrid(
      "amt",
      "Value (Rs.)",
      data.rows,
      (r, t) => fmtAmt(r.amount[t] ?? 0),
      t => fmtAmt(data.totals.amount[t] ?? 0),
      { label: "Total Value", value: r => fmtAmt(r.totalAmount), total: fmtAmt(data.totals.totalAmount) },
    );

    pages.push(
      <ColumnPagedTable<ProductTalukaRow, TalukaCol>
        key="summary"
        title={`Summary (${data.numDays} day${data.numDays === 1 ? "" : "s"})`}
        fixedHead={[
          { label: "Code", accessor: r => r.code, width: "72px" },
          { label: "Product", accessor: r => r.reportAlias, width: "200px" },
          { label: "Category", accessor: r => r.categoryName, width: "120px" },
        ]}
        productCols={[]}
        productCellRender={() => null}
        trailingHead={[
          { label: "Unit", accessor: r => rowUnit(r), width: "60px" },
          {
            label: "Total Qty",
            accessor: r => (rowUnit(r) === NOS ? fmtInt(r.totalQty) : fmtVol(r.totalVol)),
            num: true,
            width: "95px",
          },
          { label: "Avg Qty / Day", accessor: r => fmtVol(rowAvg(rowUnit(r), r)), num: true, width: "100px" },
          { label: "Total Value", accessor: r => fmtAmt(r.totalAmount), num: true, width: "105px" },
        ]}
        rows={data.rows}
        rowKey={r => r.productId}
        totalRow={{
          fixedCells: ["", "TOTAL", ""],
          productCell: () => null,
          trailingCells: ["", "", "", fmtAmt(data.totals.totalAmount)],
        }}
      />,
    );
    labels.push("Summary");
  }

  const pageLabel = (i: number) => labels[i] ?? "";

  const exporters: Exporter[] =
    data && data.rows.length > 0
      ? [
          {
            label: "CSV",
            filename: `product-taluka-sales_${from}_${to}.csv`,
            mimeType: "text/csv",
            build: () => {
              const out: (string | number)[][] = [];
              out.push([`Product Wise Taluka Sales (${fmtPeriod(from, to)})`]);
              out.push([`Category: ${categoryLabel}`, `Product: ${productLabel}`, `Taluka: ${zoneLabel}`]);
              out.push([]);
              const talukaNames = data.talukas.map(t => t.name);
              const section = (
                title: string,
                rows: ProductTalukaRow[],
                cell: (r: ProductTalukaRow, talukaId: string) => number,
                total: (r: ProductTalukaRow) => number,
              ) => {
                out.push([title]);
                out.push(["Code", "Product", ...talukaNames, "Total"]);
                for (const r of rows) {
                  out.push([r.code, r.reportAlias, ...data.talukas.map(t => cell(r, t.id)), total(r)]);
                }
                out.push([
                  "",
                  "TOTAL",
                  ...data.talukas.map(t => rows.reduce((s, r) => s + cell(r, t.id), 0)),
                  rows.reduce((s, r) => s + total(r), 0),
                ]);
                out.push([]);
              };
              for (const g of unitGroups) {
                section(
                  g.unit === NOS ? "Quantity (Nos)" : `Quantity (${g.unit})`,
                  g.rows,
                  (r, t) => cellQty(g.unit, r, t),
                  r => rowTotal(g.unit, r),
                );
              }
              section("Value (Rs.)", data.rows, (r, t) => r.amount[t] ?? 0, r => r.totalAmount);
              out.push([`Summary (${data.numDays} day${data.numDays === 1 ? "" : "s"})`]);
              out.push(["Code", "Product", "Category", "Unit", "Total Qty", "Avg Qty / Day", "Total Value"]);
              for (const r of data.rows) {
                const u = rowUnit(r);
                out.push([
                  r.code,
                  r.reportAlias,
                  r.categoryName,
                  u,
                  u === NOS ? r.totalQty : r.totalVol,
                  rowAvg(u, r),
                  r.totalAmount,
                ]);
              }
              out.push(["", "TOTAL", "", "", "", "", data.totals.totalAmount]);
              return toCsv(out);
            },
          },
        ]
      : [];

  const hasUnassigned = data?.talukas.some(t => t.id === UNASSIGNED_TALUKA_ID) ?? false;

  return (
    <ReportShell
      title="Product Wise Taluka Sales"
      subtitle="Product wise sales across talukas in Ltr / Kg and value, filtered by category, product and taluka"
      printOrientation="landscape"
      filters={
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
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Category</label>
            <div className="w-52">
              <F9SearchSelect
                value={categoryId}
                onChange={onCategoryChange}
                options={categoryOptions}
                allowAll
                allLabel="All categories"
                placeholder="All categories"
                modalTitle="Select category"
              />
            </div>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Product</label>
            <div className="w-60">
              <F9SearchSelect
                value={productId}
                onChange={v => setProductId(v ?? "")}
                options={productOptions}
                allowAll
                allLabel="All products"
                placeholder="All products"
                modalTitle="Select product"
              />
            </div>
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
                modalTitle="Select taluka"
              />
            </div>
          </div>
        </>
      }
      onGenerate={handleGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta
          title="Product Wise Taluka Sales"
          rows={[
            { label: "Period", value: fmtPeriod(from, to) },
            { label: "Category", value: categoryLabel },
            { label: "Product", value: productLabel },
            { label: "Taluka", value: zoneLabel },
          ]}
        />
      }
      printFooter={
        hasUnassigned ? (
          <p className="text-[10px] text-muted-foreground">
            UNASSIGNED holds sales to dealers with no taluka set in the dealer master.
          </p>
        ) : undefined
      }
      state={{
        generated,
        loading: isLoading,
        pages,
        pageLabel,
        emptyMessage: "No sales for this period and filter",
      }}
    />
  );
}
