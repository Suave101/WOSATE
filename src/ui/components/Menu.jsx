import { useEffect, useRef, useState } from "react";

/**
 * Drop-down menu. `items` entries are { label, description?, onSelect } or
 * { separator: true } or { group: "Heading" }.
 */
export function Menu({ label, items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="menu-button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{label}</button>
      {open ? (
        <div className="menu-list" role="menu">
          {items.map((item, i) => {
            if (item.separator) return <hr key={i} />;
            if (item.group) return <div key={i} className="menu-group">{item.group}</div>;
            return (
              <button key={i} type="button" role="menuitem" onClick={() => { setOpen(false); item.onSelect(); }}>
                {item.label}
                {item.description ? <small>{item.description}</small> : null}
              </button>
            );
          })}
          {!items.length ? <div className="menu-group">Nothing here</div> : null}
        </div>
      ) : null}
    </div>
  );
}
