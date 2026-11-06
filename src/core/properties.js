// Property value helpers: unit conversion for the AADL_Project / SEI unit types.

const UNIT_TABLES = {
  time: { ps: 1e-12, ns: 1e-9, us: 1e-6, ms: 1e-3, sec: 1, s: 1, min: 60, hr: 3600 },
  mass: { g: 1e-3, kg: 1, t: 1000 },
  // Power units are case-sensitive (mW vs MW); the others are matched case-insensitively.
  power: { uW: 1e-6, mW: 1e-3, W: 1, kW: 1e3, MW: 1e6, w: 1, kw: 1e3 },
  // Decimal multiples, as declared in AADL_Project::Size_Units.
  size: { bits: 1 / 8, bytes: 1, kbyte: 1e3, mbyte: 1e6, gbyte: 1e9, tbyte: 1e12 },
  dataRate: { bitsps: 1 / 8, bytesps: 1, kbytesps: 1e3, mbytesps: 1e6, gbytesps: 1e9 },
  frequency: { hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9 },
  mips: { kips: 1e-3, mips: 1, gips: 1e3 },
};

export const UNIT_KINDS = Object.keys(UNIT_TABLES);

/** Convert a number value with a unit into the base unit of `kind` (sec, kg, W, Bytes, Bytesps, Hz). */
export function toBase(value, kind) {
  if (!value) return null;
  if (value.type === "number") {
    if (!value.unit) return value.value;
    const table = UNIT_TABLES[kind] || {};
    const factor = table[value.unit] ?? table[value.unit.toLowerCase()];
    return factor === undefined ? null : value.value * factor;
  }
  return null;
}

/** Return [min, max] in base units for a number or range value. */
export function rangeToBase(value, kind) {
  if (!value) return null;
  if (value.type === "range") {
    const min = toBase(value.min, kind);
    const max = toBase(value.max, kind);
    return min === null || max === null ? null : [min, max];
  }
  const v = toBase(value, kind);
  return v === null ? null : [v, v];
}

export function formatValue(v) {
  if (!v) return "";
  switch (v.type) {
    case "number":
      return `${v.value}${v.unit ? " " + v.unit : ""}`;
    case "range":
      return `${formatValue(v.min)} .. ${formatValue(v.max)}${v.delta ? " delta " + formatValue(v.delta) : ""}`;
    case "string":
      return JSON.stringify(v.value);
    case "bool":
      return String(v.value);
    case "name":
      return (v.negated ? "-" : "") + v.name;
    case "list":
      return `(${v.items.map(formatValue).join(", ")})`;
    case "record":
      return `[${Object.entries(v.fields).map(([k, f]) => `${k} => ${formatValue(f)};`).join(" ")}]`;
    case "reference":
      return `reference (${v.path})`;
    case "classifier":
      return `classifier (${v.name})`;
    case "computed":
      return `compute (${v.function})`;
    default:
      return "?";
  }
}

const FORMAT_UNITS = {
  time: [[1, "s"], [1e-3, "ms"], [1e-6, "us"], [1e-9, "ns"]],
  mass: [[1, "kg"], [1e-3, "g"]],
  power: [[1e3, "kW"], [1, "W"], [1e-3, "mW"]],
  size: [[1e9, "GByte"], [1e6, "MByte"], [1e3, "KByte"], [1, "Bytes"]],
  mips: [[1e3, "GIPS"], [1, "MIPS"], [1e-3, "KIPS"]],
  dataRate: [[1e9, "GBytesps"], [1e6, "MBytesps"], [1e3, "KBytesps"], [1, "Bytesps"]],
};

/** Format a base-unit number using the most readable unit of its kind. */
export function formatBase(n, kind) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const units = FORMAT_UNITS[kind];
  if (!units) return String(n);
  const abs = Math.abs(n);
  const [factor, unit] = units.find(([f]) => abs >= f) || units[units.length - 1];
  const scaled = n / factor;
  return `${Number(scaled.toPrecision(6))} ${unit}`;
}
