// Behavior Annex and BLESS plug-in: parsing, type checking and state-machine
// analysis (reachability, deadlocks, diagrams).

import { parseBehavior, BEHAVIOR_KEYWORDS } from "./parser.js";
import { validateBehavior, behaviorSubclauses, stateMachine, stateDiagramSvg, guardText } from "./checker.js";

const EXAMPLE = `package Traffic_Light
public
  with Base_Types;

  thread Controller
    features
      tick: in event port;
      pedestrian: in event port;
      lamp: out data port Base_Types::Integer;
      walk: out event port;
    properties
      Dispatch_Protocol => Sporadic;
      Period => 100 ms;
    annex behavior_specification {**
      variables
        timer : Base_Types::Integer;
        requested : Base_Types::Boolean;
      states
        green : initial complete state;
        yellow : complete state;
        red : complete state;
        decide : state;
      transitions
        t_req : green -[ on dispatch pedestrian ]-> green { requested := true };
        t_tick : green -[ on dispatch tick ]-> decide { timer := timer + 1 };
        t_go : decide -[ requested and timer >= 3 ]-> yellow { lamp := 1; timer := 0 };
        t_stay : decide -[ otherwise ]-> green;
        t_red : yellow -[ on dispatch tick ]-> red { lamp := 2; walk! };
        t_back : red -[ on dispatch tick ]-> green { lamp := 0; requested := false };
    **};
  end Controller;

  thread Monitor
    features
      level: in data port Base_Types::Float;
      alarm: out event port;
    properties
      Dispatch_Protocol => Periodic;
      Period => 50 ms;
    annex BLESS {**
      invariant << level >= 0.0 >>
      variables
        high : Base_Types::Float := 80.0;
      states
        watch : initial complete state << level < high >>;
        alarmed : complete state;
      transitions
        w1 : watch -[ on dispatch ]-> watch;
        w2 : watch -[ on dispatch ]-> alarmed { alarm! };
        w3 : alarmed -[ on dispatch ]-> watch;
    **};
  end Monitor;

  process Junction
  end Junction;

  process implementation Junction.impl
    subcomponents
      ctrl: thread Controller;
      mon: thread Monitor;
  end Junction.impl;
end Traffic_Light;
`;

function stateMachineAnalysis({ model, instance }) {
  const sections = [];
  let problems = 0, machines = 0;
  for (const inst of instance.walk()) {
    if (!inst.classifier) continue;
    for (const { annex } of behaviorSubclauses(model, inst.classifier)) {
      machines++;
      const ba = annex.parsed;
      const a = stateMachine(ba);
      problems += a.unreachable.length + a.deadlocks.length;
      const notes = [
        ...a.unreachable.map((s) => `Unreachable state '${s.name}' (no path from the initial state)`),
        ...a.deadlocks.map((s) => `State '${s.name}' has no outgoing transition and is not final`),
      ];
      if (ba.invariant) notes.push(`Invariant: << ${ba.invariant.text} >>`);
      sections.push({
        title: `${inst.qualifiedPath} (${inst.classifier.name}) — ${annex.name}: ${ba.states.length} states, ${ba.transitions.length} transitions`,
        svg: stateDiagramSvg(ba, a),
      });
      sections.push({
        title: `${inst.qualifiedPath}: transitions`,
        table: {
          columns: ["Transition", "From", "Guard", "To", "Actions"],
          rows: ba.transitions.map((t) => ({ cells: [t.name || "—", t.sources.join(", "), guardText(t.guard), t.dst, String(t.actions?.length || 0)], loc: t.loc })),
        },
        notes,
      });
    }
  }
  if (!machines) return { status: "info", summary: "No Behavior Annex or BLESS subclauses in the instance model", sections: [] };
  return { status: problems ? "warning" : "ok", summary: `${machines} state machine${machines > 1 ? "s" : ""}${problems ? `, ${problems} structural issue${problems > 1 ? "s" : ""}` : ", all states reachable"}`, sections };
}

export default {
  id: "behavior",
  name: "Behavior Annex & BLESS",
  version: "0.1.0",
  description: "Behavior Annex (behavior_specification) and BLESS state machines: parsing, type checking of guards and actions, reachability and diagrams.",
  annexes: {
    behavior_specification: { parse: (text, ctx) => parseBehavior(text, ctx) },
    bless: { parse: (text, ctx) => parseBehavior(text, ctx, { bless: true }) },
  },
  validate: validateBehavior,
  editorKeywords: BEHAVIOR_KEYWORDS,
  analyses: [
    { id: "state-machines", label: "Behavior: State Machines", description: "Diagrams, reachability and deadlock checks for every behavior subclause.", scope: "instance", run: stateMachineAnalysis },
  ],
  examples: [{
    id: "behavior-traffic",
    name: "Behavior Annex & BLESS: Traffic light",
    description: "Sporadic thread state machine with guards and actions, plus a BLESS monitor with assertions.",
    files: [{ name: "Traffic_Light.aadl", text: EXAMPLE }],
    target: "Traffic_Light::Junction.impl",
  }],
};
