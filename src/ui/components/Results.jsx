// Renders plug-in analysis results (plain data, see core/plugin-host.js).

import { Fragment, useState } from "react";
import { download, tableToCsv } from "../download.js";
import { Icon } from "./Icon.jsx";
import { zip } from "../../core/zip.js";

const PILL = { ok: "pass", error: "fail", warning: "warn", info: "info" };
const PILL_ICON = { ok: "pass", error: "error", warning: "warning", info: "info" };

function DataTable({ table, onLocation }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (i) => setExpanded((s) => {
    const next = new Set(s);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  });
  return (
    <table className="grid">
      <thead>
        <tr>{table.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
      </thead>
      <tbody>
        {table.rows.map((row, i) => {
          const open = expanded.has(i);
          const clickable = row.loc || row.details;
          const onClick = clickable ? () => {
            if (row.details) toggle(i);
            if (row.loc && (!row.details || !open)) onLocation?.(row.loc);
          } : undefined;
          return (
            <Fragment key={i}>
              <tr className={[clickable ? "clickable" : "", row.emphasis ? "emphasis" : ""].join(" ").trim() || undefined} onClick={onClick}>
                {row.cells.map((cell, j) => (
                  <td key={j} className={j === 0 && row.status ? `st-${row.status}` : undefined} style={j === 0 && row.indent ? { paddingLeft: 10 + row.indent * 16 } : undefined}>
                    {j === 0 && row.details ? <span className="toggle">{open ? "▾" : "▸"}</span> : null}
                    {j === 0 && row.indent ? String(cell).trimStart() : String(cell)}
                  </td>
                ))}
              </tr>
              {row.details && open ? (
                <tr className="details-row">
                  <td colSpan={table.columns.length}><Section section={row.details} onLocation={onLocation} /></td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

export function Section({ section, onLocation }) {
  const csv = section.table && section.csv;
  return (
    <div className="section">
      {section.title ? (
        <h4>
          {section.title}{" "}
          {csv ? (
            <button type="button" className="icon-btn" title="Download CSV" aria-label="Download CSV" onClick={() => download(`${section.title.replace(/\W+/g, "_")}.csv`, tableToCsv(section.table), "text/csv")}><Icon name="cloud-download" /></button>
          ) : null}
        </h4>
      ) : null}
      {section.text ? <pre>{section.text}</pre> : null}
      {section.code ? <pre className="mono">{section.code}</pre> : null}
      {/* SVG produced by a plug-in; plug-ins already run with page privileges. */}
      {section.svg ? <div className="svg-wrap" dangerouslySetInnerHTML={{ __html: section.svg }} /> : null}
      {section.table ? <DataTable table={section.table} onLocation={onLocation} /> : null}
      {section.notes?.length ? <ul className="notes">{section.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
    </div>
  );
}

function ResultCard({ entry, open, onToggle, onLocation }) {
  const { result, analysis, target, time, elapsed } = entry;
  const status = result.status || "info";
  return (
    <details className="result" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary>
        <span className={`pill ${status}`}><Icon name={PILL_ICON[status] || "info"} />{PILL[status] || status}</span>
        <strong>{analysis.label}</strong>
        <span className="summary">{result.summary || ""}</span>
        <span className="when">
          {target ? `${target} · ` : ""}{time.toLocaleTimeString()}{elapsed ? ` · ${(elapsed / 1000).toFixed(1)} s` : ""}
        </span>
      </summary>
      <div className="result-body">
        {result.files?.length ? (
          <div className="result-files">
            {result.files.length > 1 ? (
              <button type="button" onClick={() => download(`${(analysis.label || "results").replace(/\W+/g, "_")}.zip`, zip(result.files), "application/zip")}>
                <Icon name="file-zip" />Download all (.zip)
              </button>
            ) : null}
            {result.files.map((f) => <button key={f.name} type="button" onClick={() => download(f.name.split("/").pop(), f.text, f.mime)}><Icon name="cloud-download" />{f.name}</button>)}
          </div>
        ) : null}
        {(result.sections || []).map((s, i) => <Section key={i} section={s} onLocation={onLocation} />)}
      </div>
    </details>
  );
}

export function ResultsView({ entries, onLocation }) {
  // Only the newest result starts expanded; the user can open older ones.
  const [openState, setOpenState] = useState(() => new Map());
  if (!entries.length) return <p className="empty">No results yet. Run an analysis from the Analyses view or the Command Palette (Ctrl+Shift+P), or press ▷ in the editor title bar to verify AGREE contracts.</p>;
  const newest = entries[0].id;
  return entries.map((e) => (
    <ResultCard
      key={e.id}
      entry={e}
      open={openState.get(e.id) ?? e.id === newest}
      onToggle={(isOpen) => setOpenState((m) => new Map(m).set(e.id, isOpen))}
      onLocation={onLocation}
    />
  ));
}

const RANK = { error: 0, warning: 1, info: 2 };
const SEV_ICON = { error: "error", warning: "warning", info: "info" };

function ProblemFile({ file, items, onLocation }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <div className="problem-file row" role="button" tabIndex={0} onClick={() => setOpen((o) => !o)} onKeyDown={(e) => e.key === "Enter" && setOpen((o) => !o)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} />
        <Icon name="file-code" className="ico-file" />
        <span>{file || "(model)"}</span>
        <span className="count-badge">{items.length}</span>
      </div>
      {open ? items.map((d, i) => (
        <div key={i} className="problem" role="button" tabIndex={0} title={d.message} onClick={() => onLocation(d)} onKeyDown={(e) => e.key === "Enter" && onLocation(d)}>
          <Icon name={SEV_ICON[d.severity]} className={`sev-${d.severity}`} />
          <span className="msg">{d.message}</span>
          <span className="src">{d.source || ""}</span>
          <span className="where">[Ln {d.line}, Col {d.col || 1}]</span>
        </div>
      )) : null}
    </div>
  );
}

export function ProblemsView({ diagnostics, onLocation }) {
  if (!diagnostics.length) return <p className="empty">No problems have been detected in the workspace.</p>;
  const sorted = [...diagnostics].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.line - b.line);
  const byFile = Map.groupBy(sorted, (d) => d.file || "");
  return [...byFile].sort(([a], [b]) => a.localeCompare(b)).map(([file, items]) => (
    <ProblemFile key={file} file={file} items={items} onLocation={onLocation} />
  ));
}
