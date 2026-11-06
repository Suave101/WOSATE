// Model serialization in the shapes OSATE's EMF models use: the declarative
// model as EMF-style JSON (eClass names from the aadl2 metamodel), the system
// instance as JSON or as an OSATE-compatible `.aaxl2` XMI document, and a
// small XMI reader that turns `.aadl2` / `.aaxl2` files back into JSON.

import { formatValue } from "./properties.js";
import { instanceProperty } from "./instance.js";

const AADL2_NS = "http://aadl.info/AADL/2.0";
const INSTANCE_NS = "http://aadl.info/AADL/2.0/instance";

const cap = (s) => s.split(" ").map((w) => w[0].toUpperCase() + w.slice(1)).join("");

const FEATURE_ECLASS = {
  "data port": "DataPort", "event port": "EventPort", "event data port": "EventDataPort", "feature group": "FeatureGroup",
  parameter: "Parameter", feature: "AbstractFeature", "data access": "DataAccess", "bus access": "BusAccess",
  "subprogram access": "SubprogramAccess", "subprogram group access": "SubprogramGroupAccess", "virtual bus access": "BusAccess",
};
const CONNECTION_ECLASS = {
  port: "PortConnection", feature: "FeatureConnection", "feature group": "FeatureGroupConnection", parameter: "ParameterConnection",
  "bus access": "AccessConnection", "data access": "AccessConnection", "subprogram access": "AccessConnection", access: "AccessConnection",
};

function propertyJson(pa) {
  return {
    eClass: "aadl2:PropertyAssociation",
    property: pa.name,
    append: pa.append || undefined,
    constant: pa.constant || undefined,
    appliesTo: pa.appliesTo.length ? pa.appliesTo : undefined,
    ownedValue: { eClass: "aadl2:ModalPropertyValue", ownedValue: valueJson(pa.value) },
    text: formatValue(pa.value),
  };
}

function valueJson(v) {
  if (!v) return null;
  switch (v.type) {
    case "number": return { eClass: v.isReal ? "aadl2:RealLiteral" : "aadl2:IntegerLiteral", value: v.value, unit: v.unit || undefined };
    case "range": return { eClass: "aadl2:RangeValue", minimum: valueJson(v.min), maximum: valueJson(v.max), delta: v.delta ? valueJson(v.delta) : undefined };
    case "string": return { eClass: "aadl2:StringLiteral", value: v.value };
    case "bool": return { eClass: "aadl2:BooleanLiteral", value: v.value };
    case "name": return { eClass: "aadl2:NamedValue", namedValue: v.name };
    case "list": return { eClass: "aadl2:ListValue", ownedListElement: v.items.map(valueJson) };
    case "record": return { eClass: "aadl2:RecordValue", ownedFieldValue: Object.entries(v.fields).map(([k, f]) => ({ eClass: "aadl2:BasicPropertyAssociation", property: k, ownedValue: valueJson(f) })) };
    case "reference": return { eClass: "aadl2:ReferenceValue", path: v.path };
    case "classifier": return { eClass: "aadl2:ClassifierValue", classifier: v.name };
    case "computed": return { eClass: "aadl2:ComputedValue", function: v.function };
    default: return null;
  }
}

function classifierJson(c) {
  const base = {
    eClass: `aadl2:${cap(c.category)}${c.kind === "componentImpl" ? "Implementation" : "Type"}`,
    name: c.name,
    extended: c.extends?.name,
    ownedPropertyAssociation: c.properties.map(propertyJson),
    ownedAnnexSubclause: c.annexes.map((a) => ({ eClass: "aadl2:DefaultAnnexSubclause", name: a.name, sourceText: `{**${a.text}**}` })),
    ownedMode: (c.modes || []).map((m) => ({ eClass: "aadl2:Mode", name: m.name, initial: m.initial || undefined })),
    ownedModeTransition: (c.modeTransitions || []).map((t) => ({ eClass: "aadl2:ModeTransition", name: t.name, source: t.src, destination: t.dst, triggers: t.triggers })),
  };
  if (c.kind === "componentType") {
    return {
      ...base,
      ownedFeature: c.features.map((f) => ({
        eClass: `aadl2:${FEATURE_ECLASS[f.featureKind] || "AbstractFeature"}`, name: f.name, direction: f.direction || undefined,
        kind: f.access || undefined, classifier: f.classifier?.name, ownedPropertyAssociation: f.properties.map(propertyJson),
      })),
      ownedFlowSpecification: c.flows.map((fs) => ({ eClass: "aadl2:FlowSpecification", name: fs.name, kind: fs.flowKind, inEnd: fs.in || undefined, outEnd: fs.out || undefined, ownedPropertyAssociation: fs.properties.map(propertyJson) })),
    };
  }
  return {
    ...base,
    type: c.typeName,
    ownedSubcomponent: c.subcomponents.map((s) => ({ eClass: `aadl2:${cap(s.category)}Subcomponent`, name: s.name, classifier: s.classifier?.name, ownedPropertyAssociation: s.properties.map(propertyJson) })),
    ownedConnection: c.connections.map((k) => ({
      eClass: `aadl2:${CONNECTION_ECLASS[k.connectionKind] || "FeatureConnection"}`, name: k.name, bidirectional: k.bidirectional || undefined,
      source: { context: k.src.context || undefined, connectionEnd: k.src.feature }, destination: { context: k.dst.context || undefined, connectionEnd: k.dst.feature },
      ownedPropertyAssociation: k.properties.map(propertyJson),
    })),
    ownedFlowImplementation: c.flows.filter((f) => f.flowKind !== "end to end").map((f) => ({ eClass: "aadl2:FlowImplementation", name: f.name, kind: f.flowKind, segments: f.segments })),
    ownedEndToEndFlow: c.flows.filter((f) => f.flowKind === "end to end").map((f) => ({ eClass: "aadl2:EndToEndFlow", name: f.name, segments: f.segments, ownedPropertyAssociation: f.properties.map(propertyJson) })),
    ownedSubprogramCallSequence: (c.callSequences || []).map((s) => ({ eClass: "aadl2:SubprogramCallSequence", name: s.name, ownedSubprogramCall: s.calls.map((call) => ({ eClass: "aadl2:SubprogramCall", name: call.name, calledSubprogram: call.classifier?.name })) })),
  };
}

const prune = (o) => JSON.parse(JSON.stringify(o, (k, v) => (Array.isArray(v) && v.length === 0 ? undefined : v)));

/** EMF-style JSON for every user package (libraries excluded unless asked). */
export function modelToJson(model, { includeLibraries = false, libraryFiles = new Set() } = {}) {
  const packages = [...model.packages.values()].filter((p) => includeLibraries || !libraryFiles.has(p.file));
  return prune({
    format: "wosate-aadl2-json",
    version: 1,
    nsURI: AADL2_NS,
    packages: packages.map((p) => ({
      eClass: "aadl2:AadlPackage",
      name: p.name,
      file: p.file,
      ownedPublicSection: {
        eClass: "aadl2:PublicPackageSection",
        importedUnit: p.withs.map((w) => w.name),
        ownedClassifier: p.classifiers.filter((c) => c.visibility !== "private").map(classifierJson),
        ownedAnnexLibrary: p.annexLibraries.map((a) => ({ eClass: "aadl2:DefaultAnnexLibrary", name: a.name, sourceText: `{**${a.text}**}` })),
      },
      ownedPrivateSection: p.classifiers.some((c) => c.visibility === "private")
        ? { eClass: "aadl2:PrivatePackageSection", ownedClassifier: p.classifiers.filter((c) => c.visibility === "private").map(classifierJson) }
        : undefined,
    })),
  });
}

const CATEGORY_LITERAL = (c) => c.replace(/\s+/g, "");

/** Instance model as JSON mirroring OSATE's instance metamodel. */
export function instanceToJson(model, root) {
  const comp = (inst) => ({
    eClass: inst.parent ? "instance:ComponentInstance" : "instance:SystemInstance",
    name: inst.name,
    category: CATEGORY_LITERAL(inst.category),
    classifier: inst.classifier ? `${inst.classifier.pkg}::${inst.classifier.name}` : undefined,
    featureInstance: inst.features.map((f) => ({ eClass: "instance:FeatureInstance", name: f.name, direction: f.direction || undefined, category: f.kind?.replace(/\s+/g, "") })),
    componentInstance: inst.children.map(comp),
    connectionInstance: inst.connections.map((c) => ({ eClass: "instance:ConnectionInstance", name: `${c.src.name} -> ${c.dst.name}`, kind: c.kind, declaration: c.name, source: c.src.name, destination: c.dst.name })),
    modeInstance: (inst.modes || []).map((m) => ({ eClass: "instance:ModeInstance", name: m.name, initial: m.initial || undefined })),
    ownedPropertyAssociation: ["Period", "Dispatch_Protocol", "Compute_Execution_Time", "Deadline", "Priority", "Actual_Processor_Binding"]
      .map((n) => ({ n, v: instanceProperty(model, inst, n) })).filter((x) => x.v).map((x) => ({ property: x.n, value: formatValue(x.v) })),
  });
  return prune({ format: "wosate-aaxl2-json", version: 1, nsURI: INSTANCE_NS, ...comp(root) });
}

const xmlEscape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** OSATE-style `.aaxl2` XMI for an instance model (structure only: components, features, connections, modes). */
export function instanceToXmi(model, root) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const paths = new Map();
  const assign = (inst, path) => {
    paths.set(inst, path);
    inst.children.forEach((c, i) => assign(c, `${path}/@componentInstance.${i}`));
  };
  assign(root, "/");
  const featurePath = (end) => {
    const p = paths.get(end.component);
    const i = end.component?.features.indexOf(end.feature);
    return p !== undefined && i >= 0 ? `#${p === "/" ? "/" : p}/@featureInstance.${i}`.replace("#//", "#/") : "";
  };
  const write = (inst, indent, tag) => {
    const pad = "  ".repeat(indent);
    const cls = inst.classifier ? ` classifier="${xmlEscape(`${inst.classifier.pkg}::${inst.classifier.name}`)}"` : "";
    const ns = tag === "instance:SystemInstance" ? ` xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:instance="${INSTANCE_NS}"` : "";
    lines.push(`${pad}<${tag}${ns} name="${xmlEscape(inst.name)}" category="${CATEGORY_LITERAL(inst.category)}"${cls}>`);
    for (const f of inst.features) {
      lines.push(`${pad}  <featureInstance name="${xmlEscape(f.name)}"${f.direction ? ` direction="${f.direction.replace(" ", "")}"` : ""} category="${(f.kind || "abstractFeature").replace(/\s+(\w)/g, (_, c) => c.toUpperCase())}"/>`);
    }
    for (const c of inst.children) write(c, indent + 1, "componentInstance");
    for (const m of inst.modes || []) lines.push(`${pad}  <modeInstance name="${xmlEscape(m.name)}"${m.initial ? ' initial="true"' : ""}/>`);
    for (const c of inst.connections) {
      lines.push(`${pad}  <connectionInstance name="${xmlEscape(`${c.src.name} -> ${c.dst.name}`)}" kind="${c.kind === "port" ? "portConnection" : c.kind.includes("access") ? "accessConnection" : "featureConnection"}" source="${featurePath(c.src)}" destination="${featurePath(c.dst)}"${c.bidirectional ? ' bidirectional="true"' : ""}/>`);
    }
    lines.push(`${pad}</${tag}>`);
  };
  write(root, 0, "instance:SystemInstance");
  return lines.join("\n") + "\n";
}

/**
 * Minimal XMI/XML reader: elements become { eClass, ...attributes, children... }.
 * Child elements are grouped by tag name into arrays (EMF containment features).
 */
export function xmiToJson(xml) {
  let i = 0;
  const skipMisc = () => {
    for (;;) {
      while (/\s/.test(xml[i] || "")) i++;
      if (xml.startsWith("<?", i)) i = xml.indexOf("?>", i) + 2;
      else if (xml.startsWith("<!--", i)) i = xml.indexOf("-->", i) + 3;
      else return;
    }
  };
  const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const element = () => {
    if (xml[i] !== "<") throw new Error(`Expected '<' at ${i}`);
    i++;
    const tag = /^[\w:.-]+/.exec(xml.slice(i))[0];
    i += tag.length;
    const node = { eClass: tag, __tag: tag };
    for (;;) {
      while (/\s/.test(xml[i])) i++;
      if (xml.startsWith("/>", i)) {
        i += 2;
        return node;
      }
      if (xml[i] === ">") {
        i++;
        break;
      }
      const m = /^([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(xml.slice(i));
      if (!m) throw new Error(`Malformed attribute at ${i}`);
      const key = m[1];
      if (key === "xsi:type" || key === "xmi:type") node.eClass = m[3] ?? m[4];
      else if (!key.startsWith("xmlns")) node[key.replace(/^xmi:/, "")] = decode(m[3] ?? m[4]);
      i += m[0].length;
    }
    for (;;) {
      skipMisc();
      if (xml.startsWith("</", i)) {
        i = xml.indexOf(">", i) + 1;
        return node;
      }
      if (xml[i] === "<") {
        const child = element();
        // Group by element name (the containment feature); keep eClass only when typed.
        const tag = child.__tag;
        delete child.__tag;
        if (child.eClass === tag && !tag.includes(":")) delete child.eClass;
        (node[tag] ||= []).push(child);
      } else {
        const end = xml.indexOf("<", i);
        const text = xml.slice(i, end).trim();
        if (text) node.text = decode(text);
        i = end;
      }
    }
  };
  skipMisc();
  const root = element();
  delete root.__tag;
  return prune(root);
}
