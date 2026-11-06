// VS Code-style quick pick, used for the Command Palette, Go to File and
// choosing the target implementation.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon.jsx";

/**
 * @param {{ items: { id: string, label: string, detail?: string, kind?: string, icon?: string, run: () => void }[],
 *   placeholder: string, onClose: () => void }} props
 */
export function QuickPick({ items, placeholder, onClose }) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef(null);
  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((it) => {
      const hay = `${it.kind || ""} ${it.label} ${it.detail || ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [items, query]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (it) => {
    if (!it) return;
    onClose();
    it.run();
  };
  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(filtered[sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <>
      <div className="quickpick-backdrop" onMouseDown={onClose} />
      <div className="quickpick" role="dialog" aria-label={placeholder}>
        <input
          type="text"
          autoFocus
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-controls="quickpick-list"
          aria-activedescendant={filtered[sel] ? `qp-${sel}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul id="quickpick-list" role="listbox" ref={listRef}>
          {filtered.map((it, i) => (
            <li
              key={it.id}
              id={`qp-${i}`}
              role="option"
              aria-selected={i === sel}
              className={i === sel ? "sel" : undefined}
              onMouseMove={() => setSel(i)}
              onClick={() => choose(it)}
            >
              {it.icon ? <Icon name={it.icon} /> : null}
              <span>{it.label}</span>
              {it.detail ? <span className="detail">{it.detail}</span> : null}
              {it.kind ? <span className="kind">{it.kind}</span> : null}
            </li>
          ))}
          {!filtered.length ? <li className="none">No matching results</li> : null}
        </ul>
      </div>
    </>
  );
}
