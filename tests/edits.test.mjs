import { test } from "node:test";
import assert from "node:assert/strict";
import { build, errors } from "./helpers.mjs";
import { addSubcomponent, addConnection, removeSubcomponent, removeMembers, connectionKind } from "../src/core/edits.js";

const TEXT = `package P
public
  with Base_Types;

  device Sensor
    features
      out1: out data port Base_Types::Integer;
  end Sensor;

  process Ctrl
    features
      in1: in data port Base_Types::Integer;
  end Ctrl;

  system S
  end S;

  system implementation S.impl
    subcomponents
      s1: device Sensor;
      c: process Ctrl;
    connections
      k1: port s1.out1 -> c.in1;
  end S.impl;

  system implementation S.bare
  end S.bare;
end P;
`;

const OTHER = `package Lib
public
  device Camera
  end Camera;
end Lib;
`;

function model(text, extra = []) {
  return build([{ name: "p.aadl", text }, ...extra]);
}

test("add a subcomponent and a connection to existing sections", () => {
  let m = model(TEXT);
  const pkg = m.findPackage("P");
  let impl = m.findByQualifiedName("P::S.impl");
  let text = addSubcomponent(TEXT, pkg, impl, { name: "s2", classifier: m.findByQualifiedName("P::Sensor") });
  assert.match(text, /      c: process Ctrl;\n      s2: device Sensor;\n    connections/);
  m = model(text);
  impl = m.findByQualifiedName("P::S.impl");
  const kind = connectionKind(m.findFeature(m.findByQualifiedName("P::Sensor"), "out1"), m.findFeature(m.findByQualifiedName("P::Ctrl"), "in1"));
  text = addConnection(text, impl, { name: "k2", kind, src: { context: "s2", feature: "out1" }, dst: { context: "c", feature: "in1" } });
  assert.match(text, /      k1: port s1\.out1 -> c\.in1;\n      k2: port s2\.out1 -> c\.in1;\n  end S\.impl;/);
  assert.deepEqual(errors(model(text)), []);
});

test("create missing sections and with clauses", () => {
  const m = model(TEXT, [{ name: "lib.aadl", text: OTHER }]);
  const impl = m.findByQualifiedName("P::S.bare");
  const text = addSubcomponent(TEXT, m.findPackage("P"), impl, { name: "cam", classifier: m.findByQualifiedName("Lib::Camera") });
  assert.match(text, /with Base_Types, Lib;/);
  assert.match(text, /system implementation S\.bare\n    subcomponents\n      cam: device Lib::Camera;\n  end S\.bare;/);
  assert.deepEqual(errors(model(text, [{ name: "lib.aadl", text: OTHER }])), []);
});

test("remove a subcomponent together with its connections", () => {
  const m = model(TEXT);
  const impl = m.findByQualifiedName("P::S.impl");
  const text = removeSubcomponent(TEXT, impl, "s1");
  assert.doesNotMatch(text, /s1/);
  assert.match(text, /    subcomponents\n      c: process Ctrl;\n    connections\n  end S\.impl;/);
  const t2 = removeMembers(TEXT, [impl.connections[0]]);
  assert.doesNotMatch(t2, /k1/);
});
