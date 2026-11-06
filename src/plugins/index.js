// Plug-ins bundled with WOSATE. Third-party plug-ins are loaded at runtime
// from an ES module URL (Plug-ins dialog) and use the same API.

import agree from "./agree/plugin.js";
import instanceView from "./instance-view.js";
import flowLatency from "./flow-latency.js";
import resourceBudgets from "./resource-budgets.js";
import modelExport from "./model-export.js";
import emv2 from "./emv2/plugin.js";
import behavior from "./behavior/plugin.js";
import resolute from "./resolute/plugin.js";
import schedulability from "./schedulability.js";
import codegen from "./codegen/plugin.js";

export const BUILTIN_PLUGINS = [instanceView, agree, emv2, behavior, resolute, flowLatency, resourceBudgets, schedulability, codegen, modelExport];
