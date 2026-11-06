export function download(name, text, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function tableToCsv(table) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  return [table.columns.map(q).join(","), ...table.rows.map((r) => r.cells.map(q).join(","))].join("\n");
}
