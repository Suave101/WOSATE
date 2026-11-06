import { PluginHost } from "../src/core/plugin-host.js";
import { buildModel } from "../src/core/model.js";
import { CORE_LIBRARIES } from "../src/core/library.js";
import { BUILTIN_PLUGINS } from "../src/plugins/index.js";

export function makeHost() {
  const host = new PluginHost();
  for (const p of BUILTIN_PLUGINS) host.register(p);
  return host;
}

export function build(files, host = makeHost()) {
  const all = [...CORE_LIBRARIES, ...host.libraries, ...files];
  return buildModel(all, host);
}

export function errors(model) {
  return model.diagnostics.filter((d) => d.severity === "error");
}

let z3 = null;
export async function z3Solver() {
  if (!z3) {
    const { init } = await import("z3-solver");
    z3 = await init();
  }
  const { sessionFromLowLevel } = await import("../src/plugins/agree/z3-backend.js");
  return sessionFromLowLevel(z3.Z3);
}

export function shutdownZ3() {
  z3?.em.PThread.terminateAllThreads();
}
