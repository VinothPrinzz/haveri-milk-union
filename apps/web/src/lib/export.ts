/**
 * Export data as a CSV file download.
 * @param data - Array of objects to export
 * @param filename - Name of the downloaded file
 * @param columns - Optional column mapping { key: label }
 */
export function exportCSV(
  data: Record<string, any>[],
  filename: string,
  columns?: Record<string, string>
) {
  if (!data.length) return;

  const keys = columns ? Object.keys(columns) : Object.keys(data[0]!);
  const headers = columns ? Object.values(columns) : keys;

  const rows = data.map((row) =>
    keys.map((key) => {
      const val = row[key];
      if (val === null || val === undefined) return "";
      const str = String(val);
      // Escape quotes and wrap in quotes if contains comma/newline/quote
      if (str.includes(",") || str.includes("\n") || str.includes('"')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(",")
  );

  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}_${new Date().toISOString().split("T")[0]}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
