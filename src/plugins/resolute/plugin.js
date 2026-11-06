// Resolute plug-in: assurance cases as claim trees evaluated over the
// instance model.

import { parseResolute, RESOLUTE_KEYWORDS } from "./parser.js";
import { Resolute } from "./evaluator.js";

const EXAMPLE = `package Assurance_Demo
public
  with Base_Types;

  annex resolute {**
    max_latency : real = 20 ms

    all_threads_ok(s : component) <= ** "All threads in " s " are schedulable and documented" **
      forall (t : thread) . contained(t, s) => (has_period(t) and has_wcet(t) and utilization_ok(t))

    has_period(t : thread) <= ** "Thread " t " has a period" **
      has_property(t, Timing_Properties::Period)

    has_wcet(t : thread) <= ** "Thread " t " has an execution time bound" **
      has_property(t, Timing_Properties::Compute_Execution_Time)

    utilization_ok(t : thread) <= ** "Thread " t " uses under half of its period" **
      upper_bound(property(t, Timing_Properties::Compute_Execution_Time)) <= property(t, Timing_Properties::Period) / 2

    all_bound(s : component) <= ** "Every thread in " s " is bound to a processor" **
      forall (t : thread) . contained(t, s) => bound_to_processor(t)

    bound_to_processor(t : thread) <= ** "Thread " t " has a processor binding" **
      has_property(t, Deployment_Properties::Actual_Processor_Binding)

    connections_typed(s : component) <= ** "All port connections in " s " carry typed data" **
      forall (c : connections_in(s)) . has_type(source_feature(c))

    connections_in(s : component) : {connection} = { c for (c : connection) | contained(source(c), s) }
  **};

  thread Sampler
    features
      raw: out data port Base_Types::Float;
    properties
      Period => 10 ms;
      Compute_Execution_Time => 1 ms .. 2 ms;
  end Sampler;

  thread Planner
    features
      raw: in data port Base_Types::Float;
      plan: out event data port;
    properties
      Period => 20 ms;
      Compute_Execution_Time => 5 ms .. 12 ms;
  end Planner;

  process App
  end App;

  process implementation App.impl
    subcomponents
      sampler: thread Sampler;
      planner: thread Planner;
    connections
      c1: port sampler.raw -> planner.raw;
  end App.impl;

  processor CPU
  end CPU;

  system Robot
    annex resolute {**
      prove (all_threads_ok(this))
      prove (all_bound(this))
      prove (connections_typed(this))
    **};
  end Robot;

  system implementation Robot.impl
    subcomponents
      app: process App.impl;
      cpu: processor CPU;
    properties
      Actual_Processor_Binding => (reference (cpu)) applies to app.sampler;
  end Robot.impl;
end Assurance_Demo;
`;

function rows(node, depth = 0, out = []) {
  out.push({
    cells: [`${"  ".repeat(depth)}${node.result ? "✔" : "✘"} ${node.text}`, node.claim, node.error || ""],
    status: node.result ? "ok" : "error",
    indent: depth,
    loc: node.loc,
  });
  for (const c of node.children) rows(c, depth + 1, out);
  return out;
}

const strip = (n) => ({ claim: n.claim, text: n.text, result: n.result, error: n.error, children: n.children.map(strip) });

function run({ model, instance }) {
  const r = new Resolute(model, instance);
  const results = r.proveAll();
  if (!results.length) return { status: "info", summary: "No Resolute prove statements in the instance model", sections: [] };
  const failed = results.filter((x) => !x.result).length;
  return {
    status: failed ? "error" : "ok",
    summary: `Resolute: ${results.length - failed} of ${results.length} top-level claim${results.length > 1 ? "s" : ""} hold`,
    sections: results.map((top) => ({
      title: `${top.result ? "✔" : "✘"} ${top.text}${top.inst?.parent ? ` (${top.inst.qualifiedPath})` : ""}`,
      table: { columns: ["Claim", "Function", "Error"], rows: rows(top) },
    })),
    files: [{ name: `${instance.name}_assurance.json`, text: JSON.stringify(results.map(strip), null, 2), mime: "application/json" }],
  };
}

export default {
  id: "resolute",
  name: "Resolute",
  version: "0.1.0",
  description: "Resolute assurance cases: claim functions and prove statements evaluated over the instance model, shown as claim trees.",
  annexes: { resolute: { parse: (text, ctx) => parseResolute(text, ctx) } },
  editorKeywords: RESOLUTE_KEYWORDS,
  analyses: [{ id: "prove", label: "Resolute: Evaluate Assurance Case", description: "Evaluate every prove statement and show the claim tree.", scope: "instance", run }],
  examples: [{
    id: "resolute-robot",
    name: "Resolute: Robot assurance case",
    description: "Claims about periods, execution times, utilization, bindings and typed connections.",
    files: [{ name: "Assurance_Demo.aadl", text: EXAMPLE }],
    target: "Assurance_Demo::Robot.impl",
  }],
};
