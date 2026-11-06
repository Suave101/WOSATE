import { test } from "node:test";
import assert from "node:assert/strict";
import { build, errors, makeHost } from "./helpers.mjs";
import { instantiate } from "../src/core/instance.js";

const host = makeHost();
const example = (id) => host.examples.find((e) => e.id === id);
const run = async (key, ex, files = ex.files) => {
  const model = build(files, host);
  const impl = model.findByQualifiedName(ex.target);
  return { model, result: await host.analyses.find((a) => a.key === key).run({ model, impl, instance: instantiate(model, impl).root }) };
};

test("Behavior Annex and BLESS example type-checks; state machines are fully reachable", async () => {
  const ex = example("behavior-traffic");
  const { model, result } = await run("behavior:state-machines", ex);
  assert.deepEqual(errors(model), []);
  assert.equal(result.status, "ok");
  assert.match(result.sections[0].svg, /<svg/);
  assert.match(result.sections[2].title, /BLESS/);
});

test("Behavior Annex type and structure errors are reported", () => {
  const text = example("behavior-traffic").files[0].text
    .replace("timer := timer + 1", "timer := requested")
    .replace("t_go : decide -[ requested and timer >= 3 ]", "t_go : decide -[ timer + 3 ]")
    .replace("t_red : yellow -[ on dispatch tick ]-> red { lamp := 2; walk! };", "t_red : yellow -[ on dispatch lamp ]-> purple { tick! };");
  const msgs = errors(build([{ name: "t.aadl", text }], host)).map((d) => d.message);
  for (const re of [/cannot assign bool to 'timer'/, /guard must be boolean/, /unknown state 'purple'/, /dispatch trigger 'lamp'/, /'tick!' needs an output port/]) {
    assert.ok(msgs.some((m) => re.test(m)), `${re} missing from:\n${msgs.join("\n")}`);
  }
});

test("Behavior Annex reachability finds unreachable and dead states", async () => {
  const ex = example("behavior-traffic");
  const text = ex.files[0].text.replace("decide : state;", "decide : state;\n        orphan : state;").replace("t_stay : decide -[ otherwise ]-> green;", "");
  const { result } = await run("behavior:state-machines", ex, [{ name: ex.files[0].name, text }]);
  assert.equal(result.status, "warning");
  const notes = result.sections[1].notes.join("\n");
  assert.match(notes, /Unreachable state 'orphan'/);
});

test("Resolute assurance case: claim tree results", async () => {
  const ex = example("resolute-robot");
  const { model, result } = await run("resolute:prove", ex);
  assert.deepEqual(errors(model), []);
  assert.match(result.summary, /1 of 3 top-level claims hold/);
  const rows = result.sections.flatMap((s) => s.table.rows.map((r) => [r.status, r.cells[0].trim()]));
  assert.ok(rows.some(([s, t]) => s === "error" && /planner uses under half/.test(t)));
  assert.ok(rows.some(([s, t]) => s === "ok" && /sampler has a processor binding/.test(t)));
  assert.ok(rows.some(([s, t]) => s === "ok" && /carry typed data/.test(t)));
});
