import { test } from "node:test";
import assert from "node:assert/strict";
import { build, makeHost } from "./helpers.mjs";
import { instantiate } from "../src/core/instance.js";
import { semanticConnections } from "../src/plugins/codegen/common.js";
import { xmiToJson } from "../src/core/serialize.js";
import { zip, crc32 } from "../src/core/zip.js";

const host = makeHost();
const ex = host.examples.find((e) => e.id === "flight-computer");
const setup = () => {
  const model = build(ex.files, host);
  const impl = model.findByQualifiedName(ex.target);
  return { model, impl, instance: instantiate(model, impl).root };
};
const run = (key, ctx) => host.analyses.find((a) => a.key === key).run(ctx);

test("semantic connections follow ports through processes to threads", () => {
  const { instance } = setup();
  const sc = semanticConnections(instance).map((c) => `${c.src.qualifiedPath}.${c.srcFeature.name}->${c.dst.qualifiedPath}.${c.dstFeature.name}`);
  assert.deepEqual(sc.sort(), [
    "fctl.law.cmd_out->servo.cmd",
    "imu.att->nav.estimator.att_in",
    "nav.estimator.att_out->fctl.law.att_in",
    "nav.estimator.att_out->nav.logger.att_in",
  ]);
});

test("C generation: types, one buffer per sender, RM priorities", async () => {
  const res = await run("codegen:c", setup());
  const file = (n) => res.files.find((f) => f.name === n).text;
  assert.match(file("c/include/aadl_types.h"), /typedef struct \{ uint8_t bytes\[24\]; \} Flight_Computer_Attitude;/);
  assert.equal((file("c/include/aadl_ports.h").match(/extern Flight_Computer_Attitude nav_estimator_att_out;/g) || []).length, 1);
  assert.match(file("c/src/fctl_law.c"), /void control_law_step\(void\)/);
  // 10 ms control law gets the highest rate-monotonic priority.
  const main = file("c/src/main.c");
  const prio = (name) => Number(new RegExp(`"${name.replace(".", "\\.")}", \\w+, \\d+L, (\\d+)`).exec(main)[1]);
  assert.ok(prio("fctl.law") > prio("nav.estimator") && prio("nav.estimator") > prio("nav.logger"));
});

test("ARINC 653 configuration: partitions, schedule windows and channels", async () => {
  const res = await run("codegen:arinc", setup());
  const doc = xmiToJson(res.files[0].text);
  assert.equal(doc.eClass, "ARINC_653_Module");
  assert.deepEqual(doc.Partition.map((p) => [p.PartitionName, p.Criticality]), [["NAV", "LEVEL_B"], ["FCTL", "LEVEL_A"]]);
  const windows = doc.Module_Schedule[0].Partition_Schedule.map((p) => [p.PartitionName, p.Window_Schedule[0].WindowStartSeconds, p.Window_Schedule[0].WindowDurationSeconds]);
  assert.deepEqual(windows, [["NAV", "0.008", "0.012"], ["FCTL", "0", "0.008"]]);
  assert.equal(doc.Connection_Table[0].Channel.length, 3);
  const navIn = doc.Partition[0].Sampling_Port.find((p) => p.Name === "nav_att_in");
  assert.equal(navIn.RefreshRateSeconds, "0.01"); // IMU period
});

test("design document and zip bundle", async () => {
  const res = await run("codegen:all", setup());
  const html = res.files.find((f) => f.name.endsWith("_design.html")).text;
  assert.match(html, /<svg/);
  assert.match(html, /ARINC 653 module/);
  const bytes = zip(res.files);
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});
