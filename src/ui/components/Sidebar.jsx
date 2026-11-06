// Side bar views: Explorer (files, plug-in libraries, outline), Analyses, and
// Extensions (plug-in manager), laid out like VS Code's side bar.

import { useState } from "react";
import { Icon } from "./Icon.jsx";

const CATEGORY_ICON = {
  system: "server-environment", process: "server-process", thread: "pulse", "thread group": "layers", processor: "chip",
  "virtual processor": "chip", memory: "database", bus: "plug", "virtual bus": "plug", device: "device-desktop",
  data: "symbol-variable", subprogram: "symbol-method", "subprogram group": "symbol-namespace", abstract: "symbol-misc",
};

function SideSection({ title, defaultOpen = true, grow = false, actions, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`side-section${open ? " open" : ""}${grow ? " grow" : ""}`}>
      <div
        className="side-section-header"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen((o) => !o))}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} />
        <span className="title">{title}</span>
        {actions ? <span className="actions" onClick={(e) => e.stopPropagation()}>{actions}</span> : null}
      </div>
      {open ? <div className="side-section-body">{children}</div> : null}
    </div>
  );
}

export function IconButton({ icon, title, onClick, className = "" }) {
  return (
    <button type="button" className={`icon-btn ${className}`.trim()} title={title} aria-label={title} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

function Row({ depth = 0, icon, iconClass, label, desc, active, title, onActivate, children }) {
  return (
    <div
      className={`row${active ? " active" : ""}`}
      role="treeitem"
      aria-selected={!!active}
      tabIndex={0}
      title={title}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={onActivate}
      onKeyDown={(e) => e.key === "Enter" && onActivate?.()}
    >
      {icon ? <Icon name={icon} className={iconClass} /> : null}
      <span className="label">{label}</span>
      {desc ? <span className="desc">{desc}</span> : null}
      {children}
    </div>
  );
}

function problemCounts(diagnostics, file) {
  let errors = 0, warnings = 0;
  for (const d of diagnostics) {
    if (d.file !== file) continue;
    if (d.severity === "error") errors++;
    else if (d.severity === "warning") warnings++;
  }
  return { errors, warnings };
}

// ---- Explorer ----------------------------------------------------------------------------

function members(c) {
  return [
    ...(c.features || []).map((m) => ({ m, icon: m.direction === "in" ? "arrow-right" : m.direction === "out" ? "arrow-left" : "arrow-swap", desc: m.featureKind })),
    ...(c.subcomponents || []).map((m) => ({ m, icon: CATEGORY_ICON[m.category] || "symbol-misc", desc: m.classifier?.name })),
    ...(c.connections || []).map((m) => ({ m, icon: "arrow-small-right", desc: `${m.src.context ? m.src.context + "." : ""}${m.src.feature} → ${m.dst.context ? m.dst.context + "." : ""}${m.dst.feature}`, cls: "ico-conn" })),
    ...(c.annexes || []).map((m) => ({ m: { ...m, name: `annex ${m.name}` }, icon: "symbol-event", cls: "ico-annex" })),
  ];
}

export function ExplorerView({ files, libraries, active, diagnostics, model, folderName, onOpen, onNew, onImport, onOpenFolder, onRename, onDelete, onLocation }) {
  const packages = model && active ? [...model.packages.values()].filter((p) => p.file === active) : [];
  const sets = model && active ? [...model.propertySets.values()].filter((p) => p.file === active) : [];
  return (
    <>
      <SideSection
        title={folderName || "Workspace (browser storage)"}
        actions={<>
          <IconButton icon="new-file" title="New AADL File…" onClick={onNew} />
          <IconButton icon="folder-opened" title="Open Folder…" onClick={onOpenFolder} />
          <IconButton icon="cloud-upload" title="Import Files…" onClick={onImport} />
        </>}
      >
        <div role="tree" aria-label="Workspace files">
          {files.map((f) => {
            const { errors, warnings } = problemCounts(diagnostics, f.name);
            return (
              <Row key={f.name} depth={1} icon="file-code" iconClass="ico-file" label={f.name} active={f.name === active} onActivate={() => onOpen(f.name)}>
                <span className="actions">
                  <IconButton icon="edit" title={`Rename ${f.name}`} onClick={(e) => { e.stopPropagation(); onRename(f.name); }} />
                  <IconButton icon="trash" title={`Delete ${f.name}`} onClick={(e) => { e.stopPropagation(); onDelete(f.name); }} />
                </span>
                {errors ? <span className="problem-dot error">{errors}</span> : warnings ? <span className="problem-dot warning">{warnings}</span> : null}
              </Row>
            );
          })}
          {!files.length ? <p className="empty">The workspace is empty. Create a file, import one, or open an example from the Examples menu.</p> : null}
        </div>
      </SideSection>
      <SideSection title="Plug-in Contributions" defaultOpen={false}>
        <div role="tree" aria-label="Plug-in libraries">
          {libraries.map((f) => (
            <Row key={f.name} depth={1} icon="library" iconClass="ico-lib" label={f.name} desc="read-only" active={f.name === active} onActivate={() => onOpen(f.name)} />
          ))}
        </div>
      </SideSection>
      <SideSection title="Outline" grow>
        <div role="tree" aria-label="Outline">
          {packages.map((pkg) => (
            <div key={pkg.name}>
              <Row depth={1} icon="package" iconClass="ico-pkg" label={pkg.name} onActivate={() => onLocation(pkg.loc)} />
              {pkg.classifiers.map((c, i) => (
                <div key={`${c.name}-${i}`}>
                  <Row
                    depth={2}
                    icon={c.kind === "componentImpl" ? "symbol-class" : CATEGORY_ICON[c.category] || "symbol-misc"}
                    iconClass={c.kind === "componentImpl" ? "ico-impl" : "ico-type"}
                    label={c.name}
                    desc={c.kind === "componentImpl" ? `${c.category} implementation` : c.category}
                    onActivate={() => onLocation(c.loc)}
                  />
                  {members(c).map(({ m, icon, desc, cls }, j) => (
                    <Row key={j} depth={3} icon={icon} iconClass={cls || "ico-member"} label={m.name} desc={desc} onActivate={() => onLocation(m.loc)} />
                  ))}
                </div>
              ))}
            </div>
          ))}
          {sets.map((ps) => <Row key={ps.name} depth={1} icon="settings" iconClass="ico-pkg" label={ps.name} desc="property set" onActivate={() => onLocation(ps.loc)} />)}
          {!packages.length && !sets.length ? <p className="empty">{active ? "No symbols in this file." : "Open a file to see its outline."}</p> : null}
        </div>
      </SideSection>
    </>
  );
}

// ---- Analyses ------------------------------------------------------------------------------

export function AnalysesView({ analyses, impls, target, onTarget, onRun, examples, onExample, busy }) {
  const byPlugin = Map.groupBy(analyses, (a) => a.plugin.name);
  return (
    <>
      <SideSection title="Target">
        <div className="field">
          <label htmlFor="target-select">Component implementation</label>
          <select id="target-select" value={target ?? ""} onChange={(e) => onTarget(e.target.value)}>
            {impls.map((i) => <option key={i.name} value={i.name}>{`${i.name} (${i.category})`}</option>)}
            {!impls.length ? <option value="">No implementations</option> : null}
          </select>
          <span className="hint">Instance analyses instantiate this implementation first.</span>
        </div>
      </SideSection>
      <SideSection title="Analyses" grow>
        {[...byPlugin].map(([plugin, list]) => (
          <div key={plugin}>
            <Row depth={0} icon="extensions" label={plugin} />
            {list.map((a) => (
              <Row key={a.key} depth={1} icon={busy ? "loading" : "play"} iconClass={busy ? "spin" : "sev-ok"} label={a.label} title={a.description} onActivate={() => onRun(a)} />
            ))}
          </div>
        ))}
        {!analyses.length ? <p className="empty">No analyses. Enable a plug-in in the Extensions view.</p> : null}
      </SideSection>
      <SideSection title="Examples" defaultOpen={false}>
        {examples.map((ex) => (
          <Row key={ex.id} depth={1} icon="book" label={ex.name} title={ex.description} onActivate={() => onExample(ex)} />
        ))}
      </SideSection>
    </>
  );
}

// ---- Extensions ------------------------------------------------------------------------------

const EXT_COLORS = ["#007acc", "#16825d", "#a074c4", "#c27d1a", "#c74e39", "#3c8fa8"];

function initials(name) {
  return name.split(/[\s&:-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

export function ExtensionsView({ host, settings, onToggle, onRemove, onLoad, onSettings }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    try {
      await onLoad(url.trim());
      setUrl("");
    } catch (e) {
      alert(`Could not load plug-in: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SideSection title="Installed" grow>
        {host.plugins.map(({ plugin, source }, i) => {
          const enabled = host.isEnabled(plugin.id);
          const external = source !== "built-in";
          const name = plugin.name || plugin.id;
          return (
            <div key={plugin.id} className={`ext${enabled ? "" : " disabled"}`} title={plugin.description}>
              <div className="ext-icon" style={{ background: EXT_COLORS[i % EXT_COLORS.length] }}>{initials(name)}</div>
              <div className="ext-main">
                <div className="ext-name">{name} {plugin.version ? <span className="ver">v{plugin.version}</span> : null}</div>
                <div className="ext-desc">{plugin.description || ""}</div>
                <div className="ext-foot">
                  <span className="source">{external ? source : "Built-in"}</span>
                  <span className="btn-row">
                    <button type="button" className={`btn${enabled ? " secondary" : ""}`} onClick={() => onToggle(plugin.id, !enabled)}>{enabled ? "Disable" : "Enable"}</button>
                    {external ? <button type="button" className="btn secondary" onClick={() => onRemove(plugin.id, source)}>Uninstall</button> : null}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </SideSection>
      <SideSection title="Install from URL">
        <div className="field">
          <input
            type="url"
            value={url}
            placeholder="plugins/naming-conventions.js"
            aria-label="Plug-in module URL"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
          />
          <button type="button" className="btn" onClick={load} disabled={busy}>{busy ? "Installing…" : "Install"}</button>
          <span className="hint">
            The module's default export is an object with an <code>id</code> and any of <code>annexes</code>, <code>validate</code>, <code>analyses</code>,{" "}
            <code>libraries</code>, <code>examples</code>. Plug-ins run with full page access; only install code you trust.
          </span>
        </div>
      </SideSection>
      <SideSection title="Settings">
        <div className="field">
          <label htmlFor="setting-maxk">AGREE: maximum induction depth (k)</label>
          <input id="setting-maxk" type="number" min={0} max={50} value={settings.agreeMaxK} onChange={(e) => onSettings({ agreeMaxK: Math.max(0, Math.min(50, Number(e.target.value) || 0)) })} />
        </div>
        <div className="field">
          <label htmlFor="setting-name">Live Share: display name</label>
          <input id="setting-name" type="text" value={settings.collabName || ""} placeholder="Engineer" onChange={(e) => onSettings({ collabName: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="setting-signaling">Live Share: WebRTC signaling servers</label>
          <input id="setting-signaling" type="text" value={settings.collabSignaling || ""} placeholder="wss://your-signaling.example (comma-separated)" onChange={(e) => onSettings({ collabSignaling: e.target.value })} />
          <span className="hint">Peers find each other through a signaling server; edits then flow peer-to-peer. Leave empty for the y-webrtc defaults, or run your own (npx y-webrtc-signaling). Tabs in the same browser sync without one.</span>
        </div>
      </SideSection>
    </>
  );
}
