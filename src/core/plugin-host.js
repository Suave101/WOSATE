// Plug-in host. A plug-in is a plain object (usually the default export of an
// ES module) that can contribute any of:
//
//   id, name, version, description         metadata (id is required)
//   annexes: { <annexName>: { parse(text, ctx) -> { ast, diagnostics } } }
//   validate(model, report)                extra legality checks after resolution
//   analyses: [{ id, label, description, scope: 'instance' | 'model', run(ctx) -> result,
//                mainThread?: true }]          built-in analyses run in a Web Worker unless
//                                               mainThread is set (e.g. they need the DOM)
//   libraries: [{ name, text }]            read-only AADL files (packages / property sets)
//   examples: [{ id, name, description, files: [{ name, text }] }]
//   editorKeywords: [string]               extra words to highlight inside annexes
//
// An analysis result is plain data so it can be rendered in the browser or
// inspected in tests:
//   { status: 'ok' | 'warning' | 'error' | 'info', summary,
//     sections: [{ title, text?, table?: { columns, rows: [{ cells, status?, details? }] } }],
//     files?: [{ name, text, mime? }], diagnostics?: [...] }

export const PLUGIN_API_VERSION = 1;

export class PluginHost {
  constructor() {
    this.plugins = [];
    this.disabled = new Set();
  }

  register(plugin, { source = "built-in" } = {}) {
    if (!plugin || typeof plugin !== "object" || !plugin.id) throw new Error("A plug-in must be an object with an 'id'");
    if (plugin.apiVersion && plugin.apiVersion > PLUGIN_API_VERSION) {
      throw new Error(`Plug-in '${plugin.id}' needs plug-in API v${plugin.apiVersion}; this host provides v${PLUGIN_API_VERSION}`);
    }
    this.plugins = this.plugins.filter((p) => p.plugin.id !== plugin.id);
    this.plugins.push({ plugin, source });
    return plugin;
  }

  unregister(id) {
    this.plugins = this.plugins.filter((p) => p.plugin.id !== id);
  }

  setEnabled(id, enabled) {
    if (enabled) this.disabled.delete(id);
    else this.disabled.add(id);
  }

  isEnabled(id) {
    return !this.disabled.has(id);
  }

  get active() {
    return this.plugins.filter((p) => this.isEnabled(p.plugin.id)).map((p) => p.plugin);
  }

  annexHandler(annexName) {
    const name = annexName.toLowerCase();
    for (const p of this.active) {
      for (const [k, h] of Object.entries(p.annexes || {})) if (k.toLowerCase() === name) return h;
    }
    return null;
  }

  validate(model) {
    for (const p of this.active) {
      if (!p.validate) continue;
      try {
        p.validate(model, (severity, message, where) => model.report(severity, message, where, p.id));
      } catch (e) {
        model.report("error", `Plug-in '${p.id}' validation failed: ${e.message}`, null, p.id);
      }
    }
  }

  get analyses() {
    return this.active.flatMap((p) => (p.analyses || []).map((a) => ({ ...a, plugin: p, key: `${p.id}:${a.id}` })));
  }

  get libraries() {
    return this.active.flatMap((p) => (p.libraries || []).map((l) => ({ ...l, plugin: p.id, readOnly: true })));
  }

  get examples() {
    return this.active.flatMap((p) => (p.examples || []).map((e) => ({ ...e, plugin: p.id })));
  }

  get editorKeywords() {
    return this.active.flatMap((p) => p.editorKeywords || []);
  }

  /** Load a third-party plug-in from an ES module URL (its default export, or `plugin` export). */
  async loadFromUrl(url) {
    const mod = await import(/* @vite-ignore */ url);
    const plugin = mod.default || mod.plugin;
    if (!plugin) throw new Error(`Module ${url} has no default export`);
    return this.register(plugin, { source: url });
  }
}
