import { test } from "node:test";
import assert from "node:assert/strict";
import { build, errors } from "./helpers.mjs";
import { instantiate } from "../src/core/instance.js";
import { modelToJson, instanceToJson, instanceToXmi, xmiToJson } from "../src/core/serialize.js";
import flowLatency from "../src/plugins/flow-latency.js";

const pipeline = flowLatency.examples[0];

test("modes and subprogram calls are parsed, resolved and validated", () => {
  const model = build([{
    name: "m.aadl",
    text: `package M
public
  with Base_Types;
  subprogram Filter
  end Filter;
  thread T
    features
      fault: in event port;
    modes
      nominal: initial mode;
      degraded: mode;
      t1: nominal -[ fault ]-> degraded;
      t2: degraded -[ nope ]-> limbo;
  end T;
  thread implementation T.i
    calls
      main: {
        c1: subprogram Filter;
        c2: subprogram Missing;
      };
  end T.i;
end M;`,
  }]);
  const msgs = errors(model).map((d) => d.message);
  assert.ok(msgs.some((m) => /unknown mode 'limbo'/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /unknown trigger port 'nope'/.test(m)));
  assert.ok(msgs.some((m) => /Classifier 'Missing' not found/.test(m)));
  const t = model.findByQualifiedName("M::T");
  assert.deepEqual(t.modes.map((m) => [m.name, m.initial]), [["nominal", true], ["degraded", false]]);
  assert.equal(t.modeTransitions[0].triggers[0], "fault");
  const impl = model.findByQualifiedName("M::T.i");
  assert.equal(impl.callSequences[0].calls[0]._classifier.name, "Filter");
  const { root } = instantiate(model, impl);
  assert.equal(root.modes.length, 2);
  assert.equal(root.callSequences[0].calls.length, 2);
});

test("declarative model serializes to EMF-style JSON", () => {
  const model = build(pipeline.files);
  const json = modelToJson(model, { libraryFiles: new Set(["Base_Types.aadl"]) });
  const pkg = json.packages.find((p) => p.name === "Sensor_Pipeline");
  const vehicle = pkg.ownedPublicSection.ownedClassifier.find((c) => c.name === "Vehicle.impl");
  assert.equal(vehicle.eClass, "aadl2:SystemImplementation");
  assert.equal(vehicle.ownedSubcomponent[0].eClass, "aadl2:DeviceSubcomponent");
  assert.equal(vehicle.ownedConnection[0].eClass, "aadl2:PortConnection");
  assert.equal(vehicle.ownedEndToEndFlow[0].segments.length, 5);
  const sensor = pkg.ownedPublicSection.ownedClassifier.find((c) => c.name === "Sensor");
  assert.equal(sensor.ownedFeature[0].eClass, "aadl2:DataPort");
});

test("instance model round-trips through .aaxl2 XMI", () => {
  const model = build(pipeline.files);
  assert.deepEqual(errors(model), []);
  const { root } = instantiate(model, model.findByQualifiedName(pipeline.target));
  const xmi = instanceToXmi(model, root);
  assert.match(xmi, /^<\?xml/);
  const back = xmiToJson(xmi);
  assert.equal(back.eClass, "instance:SystemInstance");
  assert.equal(back.componentInstance.length, 5);
  assert.equal(back.connectionInstance.length, 2);
  assert.match(back.connectionInstance[0].source, /@componentInstance\.0\/@featureInstance\.0$/);
  const json = instanceToJson(model, root);
  assert.equal(json.componentInstance[1].componentInstance[0].name, "filt");
});
