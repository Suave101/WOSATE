// Workspace state (files, open tabs, target, plug-in preferences) as a reducer,
// persisted to localStorage.

import { useEffect, useReducer } from "react";

const STORE_KEY = "wosate:workspace:v1";
const LEGACY_KEY = "wowate:workspace:v1";

const EMPTY = {
  files: [],
  open: [],
  active: null,
  target: null,
  disabledPlugins: [],
  externalPlugins: [],
  settings: { agreeMaxK: 8 },
};

function loadSaved() {
  try {
    // Fall back to the key used before the project was renamed from WOWATE.
    const raw = localStorage.getItem(STORE_KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return { ...EMPTY, ...s, settings: { ...EMPTY.settings, ...(s.settings || {}) }, fresh: false };
    }
  } catch {
    /* storage unavailable: start fresh */
  }
  return { ...EMPTY, fresh: true };
}

export function uniqueName(files, base) {
  let name = base;
  let n = 2;
  while (files.some((f) => f.name === name)) name = base.replace(/(\.\w+)?$/, `_${n++}$1`);
  return name;
}

function addFiles(files, incoming, replace) {
  const out = [...files];
  for (const f of incoming) {
    const i = out.findIndex((x) => x.name === f.name);
    if (i >= 0 && replace) out[i] = { name: f.name, text: f.text };
    else out.push({ name: i >= 0 ? uniqueName(out, f.name) : f.name, text: f.text });
  }
  return out;
}

function reducer(state, action) {
  switch (action.type) {
    case "edit":
      return { ...state, files: state.files.map((f) => (f.name === action.name ? { ...f, text: action.text } : f)) };
    case "open":
      return { ...state, active: action.name, open: state.open.includes(action.name) ? state.open : [...state.open, action.name] };
    case "close": {
      const open = state.open.filter((n) => n !== action.name);
      return { ...state, open, active: state.active === action.name ? open.at(-1) ?? null : state.active };
    }
    case "add": {
      const files = addFiles(state.files, action.files, action.replace);
      const last = action.open ?? files.at(-1)?.name ?? null;
      return {
        ...state,
        files,
        target: action.target ?? state.target,
        active: last,
        open: last && !state.open.includes(last) ? [...state.open, last] : state.open,
      };
    }
    case "rename": {
      const swap = (n) => (n === action.from ? action.to : n);
      return {
        ...state,
        files: state.files.map((f) => (f.name === action.from ? { ...f, name: action.to } : f)),
        open: state.open.map(swap),
        active: swap(state.active),
      };
    }
    case "delete": {
      const open = state.open.filter((n) => n !== action.name);
      return {
        ...state,
        files: state.files.filter((f) => f.name !== action.name),
        open,
        active: state.active === action.name ? open.at(-1) ?? null : state.active,
      };
    }
    case "clear":
      return { ...state, files: [], open: [], active: null };
    case "replace": {
      // Files arriving from a live session: keep tabs whose files still exist.
      const names = new Set(action.files.map((f) => f.name));
      const keep = (n) => names.has(n) || n?.startsWith("diagram:");
      const open = state.open.filter(keep);
      const same = action.files.length === state.files.length && action.files.every((f) => state.files.some((x) => x.name === f.name && x.text === f.text));
      if (same) return state;
      return { ...state, files: action.files, open, active: keep(state.active) ? state.active : open[0] ?? action.files[0]?.name ?? null };
    }
    case "target":
      return { ...state, target: action.target };
    case "plugins":
      return { ...state, disabledPlugins: action.disabled ?? state.disabledPlugins, externalPlugins: action.external ?? state.externalPlugins };
    case "settings":
      return { ...state, settings: { ...state.settings, ...action.settings } };
    default:
      throw new Error(`Unknown workspace action ${action.type}`);
  }
}

export function useWorkspace() {
  const [state, dispatch] = useReducer(reducer, null, loadSaved);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
      } catch {
        /* quota or private mode: keep working in memory */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [state]);
  return [state, dispatch];
}
