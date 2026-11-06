import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { Collaboration } from "../src/ui/collab.js";

const live = [];
afterEach(() => live.splice(0).forEach((c) => c.destroy()));

/** Two in-memory peers whose documents exchange updates directly. */
function pair() {
  const peers = [];
  const make = (name) => {
    const received = [];
    const c = new Collaboration({
      room: "test",
      user: name,
      onFiles: (files) => received.push(files),
      createProvider: (doc) => {
        doc.on("update", (update, origin) => {
          if (origin === "remote") return;
          for (const p of peers) if (p.doc !== doc) Y.applyUpdate(p.doc, update, "remote");
        });
        const awareness = new Awareness(doc);
        return { awareness, destroy: () => awareness.destroy() };
      },
    });
    c.received = received;
    peers.push(c);
    live.push(c);
    return c;
  };
  return [make("alice"), make("bob")];
}

test("the first peer seeds the room; the second adopts its files", async () => {
  const [a, b] = pair();
  assert.equal(await a.start([{ name: "A.aadl", text: "package A\nend A;\n" }], { waitMs: 10 }), "hosting");
  assert.equal(await b.start([{ name: "mine.aadl", text: "local only" }], { waitMs: 10 }), "joined");
  assert.deepEqual(b.received.at(-1), [{ name: "A.aadl", text: "package A\nend A;\n" }]);
});

test("edits, additions and deletions propagate as minimal changes", async () => {
  const [a, b] = pair();
  await a.start([{ name: "A.aadl", text: "package A\npublic\nend A;\n" }], { waitMs: 10 });
  await b.start([], { waitMs: 10 });
  let ops = 0;
  b.ytext("A.aadl").observe((e) => (ops += e.changes.delta.length));
  a.push([{ name: "A.aadl", text: "package A\npublic\n  system S\n  end S;\nend A;\n" }, { name: "B.aadl", text: "package B\nend B;\n" }]);
  assert.equal(b.ytext("A.aadl").toString(), "package A\npublic\n  system S\n  end S;\nend A;\n");
  assert.ok(ops <= 2, "expected a single retain+insert");
  assert.deepEqual(b.received.at(-1).map((f) => f.name), ["A.aadl", "B.aadl"]);
  b.push([{ name: "A.aadl", text: b.ytext("A.aadl").toString() }]);
  assert.equal(a.ytext("B.aadl"), null);
  assert.deepEqual(a.received.at(-1).map((f) => f.name), ["A.aadl"]);
});

test("concurrent edits to one file merge", async () => {
  const [a, b] = pair();
  await a.start([{ name: "A.aadl", text: "abc" }], { waitMs: 10 });
  await b.start([], { waitMs: 10 });
  a.ytext("A.aadl").insert(0, "X");
  b.ytext("A.aadl").insert(3, "Y");
  assert.equal(a.ytext("A.aadl").toString(), b.ytext("A.aadl").toString());
  assert.equal(a.ytext("A.aadl").toString(), "XabYc");
});
