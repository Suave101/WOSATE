import { useEffect, useId, useRef, useState } from "react";

/**
 * Drop-down menu (WAI-ARIA menu button). `items` entries are { label, description?, onSelect }
 * or { separator: true } or { group: "Heading" }. Opening moves focus to the first item;
 * arrow keys, Home and End move between items; Escape closes and returns focus to the button.
 */
export function Menu({ label, items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const button = useRef(null);
  const list = useRef(null);
  const focusFirst = useRef("first");
  const id = useId();

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const entries = [...(list.current?.querySelectorAll('[role="menuitem"]') || [])];
    (focusFirst.current === "last" ? entries.at(-1) : entries[0])?.focus();
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onButtonKey = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focusFirst.current = e.key === "ArrowUp" ? "last" : "first";
      setOpen(true);
    }
  };

  const onListKey = (e) => {
    const entries = [...list.current.querySelectorAll('[role="menuitem"]')];
    const i = entries.indexOf(document.activeElement);
    const go = (n) => entries[(n + entries.length) % entries.length]?.focus();
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(entries.length - 1);
    else if (e.key === "Escape") close();
    else if (e.key === "Tab") return close(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="menu" ref={ref}>
      <button
        ref={button}
        type="button"
        className="menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          focusFirst.current = "first";
          setOpen((o) => !o);
        }}
        onKeyDown={onButtonKey}
      >
        {label}
      </button>
      {open ? (
        <div className="menu-list" role="menu" id={id} aria-label={label} ref={list} onKeyDown={onListKey}>
          {items.map((item, i) => {
            if (item.separator) return <hr key={i} role="separator" />;
            if (item.group) return <div key={i} className="menu-group" role="presentation">{item.group}</div>;
            return (
              <button key={i} type="button" role="menuitem" tabIndex={-1} onClick={() => { close(); item.onSelect(); }}>
                {item.label}
                {item.description ? <small>{item.description}</small> : null}
              </button>
            );
          })}
          {!items.length ? <div className="menu-group" role="presentation">Nothing here</div> : null}
        </div>
      ) : null}
    </div>
  );
}
