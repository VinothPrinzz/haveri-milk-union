// apps/web/src/lib/reportColumnPaging.tsx
// ════════════════════════════════════════════════════════════════════
// Helper for the 9 sales-report pages where the number of product
// columns can blow past the printed A4 width. Splits product columns
// into chunks and renders each chunk as its own page; leading "fixed"
// columns (e.g. Date, Dealer Name, Code) repeat on every chunk page.
//
// Usage in a sales-report page (e.g. SalesRegister):
//
//   const productPages = paginateColumns(d.products, COLUMNS_PER_PAGE);
//   return productPages.map((cols, i) => (
//     <ColumnPagedTable
//       key={i}
//       title={`Sales Register · Cols ${i + 1}/${productPages.length}`}
//       fixedHead={[
//         { label: "Code",    accessor: r => r.code },
//         { label: "Dealer",  accessor: r => r.name },
//       ]}
//       productCols={cols}
//       productCellRender={(row, prod) => fmtNum(row.qty[prod.id] ?? 0)}
//       trailingHead={[
//         { label: "Total ₹", accessor: r => fmtINR(r.total), num: true },
//       ]}
//       rows={d.rows}
//       totalRow={ /* optional */ }
//     />
//   ));
//
// The component prints the same canvas/page-break behaviour
// ReportShell already wires up.
// ════════════════════════════════════════════════════════════════════
import type { ReactNode } from "react";

export function paginateColumns<T>(items: T[], perPage: number): T[][] {
  if (perPage <= 0 || items.length <= perPage) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += perPage) {
    out.push(items.slice(i, i + perPage));
  }
  return out;
}

export interface ColumnDef<TRow> {
  label: string;
  accessor: (row: TRow) => ReactNode;
  width?: string;
  num?: boolean;
  className?: string;
}

export interface ProductCol {
  id: string;
  reportAlias: string;
}

export function ColumnPagedTable<TRow, TProd extends ProductCol>({
  title,
  fixedHead,
  productCols,
  productCellRender,
  trailingHead,
  rows,
  totalRow,
  rowKey,
  pageInfo,
  fixedLayout = false,
  productColWidth = "60px",
}: {
  title?: string;
  fixedHead: ColumnDef<TRow>[];
  productCols: TProd[];
  productCellRender: (row: TRow, prod: TProd) => ReactNode;
  trailingHead?: ColumnDef<TRow>[];
  rows: TRow[];
  totalRow?: {
    fixedCells:    ReactNode[];                  // length = fixedHead.length
    productCell:   (prod: TProd) => ReactNode;
    trailingCells?: ReactNode[];                 // length = trailingHead.length (if any)
  };
  rowKey?: (row: TRow, idx: number) => string | number;
  pageInfo?: { current: number; total: number };
  // Opt-in: enforce colgroup widths (table-layout: fixed) and let the
  // product headers wrap inside the narrow product columns. Needed when
  // long report aliases would otherwise force the columns past the page
  // width in print (Daily Sales Statement).
  fixedLayout?: boolean;
  productColWidth?: string;
}) {
  // Product header: when fixedLayout, wrap inside the column instead of the
  // default `.num` nowrap (which expands the column to the full alias width).
  // Product cells are centered (not right-aligned) under fixedLayout.
  const prodHeadCls = fixedLayout ? "prod-col" : "num";
  const prodCellCls = fixedLayout ? "prod-col" : "num";
  return (
    <div className="rs-page">
      {(title || pageInfo) && (
        <div className="col-paged-strip">
          <span>{title}</span>
          {pageInfo && (
            <span>Columns {pageInfo.current} of {pageInfo.total}</span>
          )}
        </div>
      )}
      <table className={`report-ledger compact${fixedLayout ? " col-paged-fixed" : ""}`}>
        <colgroup>
          {fixedHead.map((c, i) => (
            <col key={`f-${i}`} style={c.width ? { width: c.width } : undefined} />
          ))}
          {productCols.map(p => (
            <col key={p.id} style={{ width: productColWidth }} />
          ))}
          {trailingHead?.map((c, i) => (
            <col key={`t-${i}`} style={c.width ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {fixedHead.map((c, i) => (
              <th key={`f-${i}`} className={c.num ? "num" : c.className}>
                {c.label}
              </th>
            ))}
            {productCols.map(p => (
              <th key={p.id} className={prodHeadCls}>{p.reportAlias}</th>
            ))}
            {trailingHead?.map((c, i) => (
              <th key={`t-${i}`} className={c.num ? "num" : c.className}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={rowKey ? rowKey(row, idx) : idx}>
              {fixedHead.map((c, i) => (
                <td key={`f-${i}`} className={c.num ? "num" : c.className}>
                  {c.accessor(row)}
                </td>
              ))}
              {productCols.map(p => (
                <td key={p.id} className={prodCellCls}>
                  {productCellRender(row, p)}
                </td>
              ))}
              {trailingHead?.map((c, i) => (
                <td key={`t-${i}`} className={c.num ? "num" : c.className}>
                  {c.accessor(row)}
                </td>
              ))}
            </tr>
          ))}

          {totalRow && (
            <tr className="total-row">
              {totalRow.fixedCells.map((cell, i) => (
                <td key={`f-${i}`} className={i === 0 ? "num" : ""}>
                  {cell}
                </td>
              ))}
              {productCols.map(p => (
                <td key={p.id} className={prodCellCls}>{totalRow.productCell(p)}</td>
              ))}
              {totalRow.trailingCells?.map((cell, i) => (
                <td key={`t-${i}`} className="num">{cell}</td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}