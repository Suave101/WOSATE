// Analysis worker: runs built-in analyses (flow latency, budgets,
// schedulability, EMV2, Resolute, ...) off the main thread. Each request
// carries the workspace files; the worker builds its own model and instance,
// runs the analysis and posts back the plain-data result.

import { PluginHost } from "../core/plugin-host.js";
import { buildModel } from "../core/model.js";
import { instantiate } from "../core/instance.js";
import { CORE_LIBRARIES } from "../core/library.js";
import { BUILTIN_PLUGINS } from "../plugins/index.js";

const host = new PluginHost();
for (const p of BUILTIN_PLUGINS) host.register(p);

self.onmessage = async ({ data }) => {
  const { id, key, files, libraries, target, settings, disabledPlugins = [] } = data;
  const progress = (text) => self.postMessage({ id, progress: text });
  try {
    for (const { plugin } of host.plugins) host.setEnabled(plugin.id, !disabledPlugins.includes(plugin.id));
    const analysis = host.analyses.find((a) => a.key === key);
    if (!analysis) throw new Error(`Analysis '${key}' is not available in the worker`);
    const model = buildModel([...(libraries || [...CORE_LIBRARIES, ...host.libraries]), ...files], host);
    const impl = target ? model.findByQualifiedName(target) : null;
    const ctx = { model, impl, settings, libraryFiles: new Set((libraries || CORE_LIBRARIES).map((l) => l.name)), progress, services: {} };
    if (analysis.scope !== "model") {
      if (!impl) throw new Error(`Implementation '${target}' not found`);
      const { root, problems } = instantiate(model, impl);
      ctx.instance = root;
      ctx.instanceProblems = problems;
    }
    const started = performance.now();
    const result = await analysis.run(ctx);
    self.postMessage({ id, result, elapsed: performance.now() - started });
  } catch (e) {
    self.postMessage({ id, error: e.message, stack: e.stack });
  }
};
