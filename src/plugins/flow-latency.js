// Flow latency analysis: sums the latency contributions along each end-to-end
// flow (flow specifications, connections, and sampling by periodic receivers)
// and compares the worst case against the flow's Latency requirement.

import { instanceProperty, connectionProperty } from "../core/instance.js";
import { rangeToBase, toBase, formatBase } from "../core/properties.js";

const lc = (s) => (s || "").toLowerCase();
const fmt = (r) => (r ? `${formatBase(r[0], "time")} .. ${formatBase(r[1], "time")}` : "—");

function isPeriodic(model, inst) {
  const dp = instanceProperty(model, inst, "Dispatch_Protocol");
  return dp?.type === "name" && lc(dp.name) === "periodic";
}

export function analyzeFlow(model, owner, flow) {
  const rows = [];
  const total = [0, 0];
  const notes = [];
  let prevInst = null;
  for (const seg of flow.segments) {
    const [head, member] = seg.split(".");
    const sub = owner.child(head);
    if (sub && member) {
      let r = rangeToBase(instanceProperty(model, sub, "Latency", member), "time");
      let source = "Latency";
      if (!r && /thread|device/.test(sub.category)) {
        r = rangeToBase(instanceProperty(model, sub, "Compute_Execution_Time"), "time");
        source = "Compute_Execution_Time";
      }
      if (!r) {
        notes.push(`No Latency for ${seg}; counted as 0`);
        r = [0, 0];
        source = "none";
      }
      // A periodic receiver samples its input: worst case one period of waiting.
      if (prevInst && isPeriodic(model, sub)) {
        const period = toBase(instanceProperty(model, sub, "Period"), "time");
        if (period) {
          rows.push({ cells: [`${seg} (sampling)`, "Period", fmt([0, period])] });
          total[1] += period;
        }
      }
      rows.push({ cells: [seg, source, fmt(r)] });
      total[0] += r[0];
      total[1] += r[1];
      prevInst = sub;
      continue;
    }
    const conn = owner.connections.find((c) => lc(c.name) === lc(seg));
    if (conn) {
      const r = rangeToBase(connectionProperty(model, owner, conn, "Latency"), "time") || [0, 0];
      rows.push({ cells: [`${seg} (connection)`, "Latency", fmt(r)] });
      total[0] += r[0];
      total[1] += r[1];
      continue;
    }
    notes.push(`Segment '${seg}' is not a subcomponent flow or connection of ${owner.qualifiedPath}`);
  }
  const reqValue = flow.properties.find((p) => /(^|::)latency$/i.test(p.name))?.value ||
    model.classifierProperties(owner.classifier).find((p) => /(^|::)latency$/i.test(p.name) && p.appliesTo.some((a) => lc(a) === lc(flow.name)))?.value;
  const req = rangeToBase(reqValue, "time");
  let status = "info";
  if (req) status = total[1] <= req[1] ? "ok" : "error";
  return { rows, total, req, status, notes };
}

function run(ctx) {
  const { model, instance } = ctx;
  const sections = [];
  let worst = "ok";
  let count = 0;
  for (const inst of instance.walk()) {
    for (const flow of inst.flows.filter((f) => f.flowKind === "end to end")) {
      count++;
      const r = analyzeFlow(model, inst, flow);
      if (r.status === "error") worst = "error";
      const verdict = r.req ? (r.status === "ok" ? "meets" : "exceeds") + ` requirement ${fmt(r.req)}` : "no Latency requirement";
      sections.push({
        title: `${inst.qualifiedPath}: ${flow.name}`,
        table: {
          columns: ["Contributor", "Source", "Latency"],
          rows: [...r.rows, { cells: ["Total", "", fmt(r.total)], status: r.status, emphasis: true }],
        },
        notes: [`Worst case ${formatBase(r.total[1], "time")} ${verdict}.`, ...r.notes],
        status: r.status,
      });
    }
  }
  if (!count) return { status: "info", summary: `No end-to-end flows in ${instance.name}`, sections: [] };
  return { status: worst, summary: `Flow latency: ${count} end-to-end flow${count > 1 ? "s" : ""} analysed`, sections };
}

const EXAMPLE = `package Sensor_Pipeline
public
  with Base_Types, SEI;

  device Sensor
    features
      reading: out data port Base_Types::Float;
    flows
      src: flow source reading { Latency => 1 ms .. 2 ms; };
    properties
      SEI::GrossWeight => 0.2 kg;
      SEI::PowerBudget => 1.5 W;
  end Sensor;

  thread Filter
    features
      input: in data port Base_Types::Float;
      output: out data port Base_Types::Float;
    flows
      path1: flow path input -> output { Latency => 2 ms .. 4 ms; };
    properties
      Dispatch_Protocol => Periodic;
      Period => 10 ms;
  end Filter;

  process Control
    features
      input: in data port Base_Types::Float;
      output: out data port Base_Types::Float;
    flows
      path1: flow path input -> output;
  end Control;

  process implementation Control.impl
    subcomponents
      filt: thread Filter;
    connections
      c1: port input -> filt.input;
      c2: port filt.output -> output;
    flows
      path1: flow path input -> c1 -> filt.path1 -> c2 -> output;
  end Control.impl;

  device Actuator
    features
      cmd: in data port Base_Types::Float;
    flows
      snk: flow sink cmd { Latency => 3 ms .. 5 ms; };
    properties
      SEI::GrossWeight => 1.1 kg;
      SEI::PowerBudget => 12 W;
  end Actuator;

  processor CPU
    properties
      SEI::GrossWeight => 0.4 kg;
      SEI::PowerBudget => 8 W;
  end CPU;

  device Battery
    properties
      SEI::GrossWeight => 2 kg;
      SEI::PowerCapacity => 20 W;
  end Battery;

  system Vehicle
    properties
      SEI::WeightLimit => 5 kg;
  end Vehicle;

  system implementation Vehicle.impl
    subcomponents
      sensor: device Sensor;
      ctrl: process Control.impl;
      act: device Actuator;
      cpu: processor CPU;
      battery: device Battery;
    connections
      s2c: port sensor.reading -> ctrl.input { Latency => 0.5 ms .. 1 ms; };
      c2a: port ctrl.output -> act.cmd { Latency => 0.5 ms .. 1 ms; };
    flows
      sense_to_act: end to end flow sensor.src -> s2c -> ctrl.path1 -> c2a -> act.snk { Latency => 0 ms .. 15 ms; };
    properties
      Actual_Processor_Binding => (reference (cpu)) applies to ctrl;
      Latency => 2 ms .. 3 ms applies to ctrl.path1;
  end Vehicle.impl;
end Sensor_Pipeline;
`;

export default {
  id: "flow-latency",
  name: "Flow Latency",
  version: "0.1.0",
  description: "End-to-end flow latency: sums flow specification, connection and sampling latencies and checks them against the flow's Latency requirement.",
  analyses: [
    {
      id: "flow-latency",
      label: "Flow Latency Analysis",
      description: "Analyse every end-to-end flow in the instance model.",
      scope: "instance",
      run,
    },
  ],
  examples: [
    {
      id: "sensor-pipeline",
      name: "Sensor pipeline (latency, weight, power)",
      description: "End-to-end flow with a latency requirement, plus SEI weight and power budgets.",
      files: [{ name: "Sensor_Pipeline.aadl", text: EXAMPLE }],
      target: "Sensor_Pipeline::Vehicle.impl",
    },
  ],
};
