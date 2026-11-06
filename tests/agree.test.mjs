import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build, errors, makeHost, z3Solver, shutdownZ3 } from "./helpers.mjs";
import { AGREE_EXAMPLES } from "../src/plugins/agree/examples.js";
import { translateImplementation } from "../src/plugins/agree/translate.js";
import { checkProgram } from "../src/plugins/agree/kinduction.js";
import { toLustre } from "../src/plugins/agree/lustre.js";

after(() => shutdownZ3());

const example = (id) => AGREE_EXAMPLES.find((e) => e.id === id);

async function verifyExample(id, edit = (t) => t) {
  const ex = example(id);
  const model = build(ex.files.map((f) => ({ ...f, text: edit(f.text) })));
  assert.deepEqual(errors(model), []);
  const impl = model.findByQualifiedName(ex.target);
  const { program, errors: trErrors } = translateImplementation(model, impl);
  assert.deepEqual(trErrors, []);
  const solver = await z3Solver();
  try {
    return { program, result: await checkProgram(program, solver, { maxK: 8 }) };
  } finally {
    solver.close();
  }
}

const byDesc = (result) => Object.fromEntries(result.props.map((p) => [p.desc, p]));

test("toy example: every obligation is valid", async () => {
  const { result } = await verifyExample("agree-toy");
  assert.equal(result.consistency.status, "consistent");
  for (const p of result.props) assert.equal(p.status, "valid", p.name);
  assert.equal(result.props.filter((p) => !p.hidden).length, 4); // A guarantee, lemma, B assume, C assume
});

test("toy example: a too-strong guarantee yields a counterexample", async () => {
  const { result } = await verifyExample("agree-toy", (t) => t.replace("Output < 50", "Output < 40"));
  const g = byDesc(result)["A output range"];
  assert.equal(g.status, "invalid");
  assert.equal(g.cex.steps, 1);
  const out = g.cex.rows.find((r) => r.name === "Output");
  assert.ok(Number(out.values[0]) >= 40, `Output was ${out.values[0]}`);
});

test("counter example: induction proofs, library node/const, and an invalid lemma", async () => {
  const { result } = await verifyExample("agree-counter");
  const p = byDesc(result);
  assert.equal(p["display stays within 0..MAX"].status, "valid");
  assert.equal(p["reset shows 0 on the next step"].status, "valid");
  assert.equal(p["value is never negative"].status, "valid");
  const lemma = p["counter never reaches MAX"];
  assert.equal(lemma.status, "invalid");
  assert.equal(lemma.cex.steps, 6);
  const count = lemma.cex.rows.find((r) => r.name === "ctr.count");
  assert.deepEqual(count.values, ["0", "1", "2", "3", "4", "5"]);
});

test("inconsistent assumptions are reported", async () => {
  const { result } = await verifyExample("agree-toy", (t) => t.replace('assume "A input range" : Input < 20;', 'assume "A input range" : Input < 20 and Input > 30;'));
  assert.equal(result.consistency.status, "inconsistent");
});

test("type errors and unsupported constructs are rejected, not ignored", () => {
  const model = build([{
    name: "Bad.aadl",
    text: `package Bad
public
  with Base_Types;
  system S
    features
      x: in data port Base_Types::Integer;
      r: in data port Base_Types::Float;
    annex agree {**
      guarantee "mixed" : x + r > 0;
      initially : x = 0;
    **};
  end S;
  system implementation S.impl
  end S.impl;
end Bad;`,
  }]);
  const agreeErrors = errors(model).filter((d) => d.source === "agree");
  assert.equal(agreeErrors.length, 1);
  assert.match(agreeErrors[0].message, /initially/);
  const { errors: trErrors } = translateImplementation(model, model.findByQualifiedName("Bad::S.impl"));
  assert.equal(trErrors.length, 1);
  assert.match(trErrors[0].message, /different types/);
});

test("Lustre export declares inputs, locals and properties", () => {
  const ex = example("agree-counter");
  const model = build(ex.files);
  const { program } = translateImplementation(model, model.findByQualifiedName(ex.target));
  const lus = toLustre(program);
  assert.match(lus, /node main\(/);
  assert.match(lus, /reset : bool/);
  assert.match(lus, /ctr__count : int/);
  assert.match(lus, /--%PROPERTY __prop_0;/);
  assert.match(lus, /pre\(ctr__count\)/);
});

test("the plug-in analysis runs end to end with an injected solver", async () => {
  const host = makeHost();
  const ex = example("agree-toy");
  const model = build(ex.files, host);
  const analysis = host.analyses.find((a) => a.key === "agree:verify-all");
  const res = await analysis.run({ model, impl: model.findByQualifiedName(ex.target), services: { createSmtSolver: z3Solver } });
  assert.equal(res.status, "ok", res.summary);
  assert.ok(res.files[0].name.endsWith(".lus"));
});
