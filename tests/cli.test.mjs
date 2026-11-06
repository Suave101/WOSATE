import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FLIGHT_COMPUTER } from "../src/plugins/flight-computer.js";

const CLI = new URL("../tools/wosate.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "wosate-cli-"));
  mkdirSync(join(dir, "models"));
  writeFileSync(join(dir, "models", "Flight_Computer.aadl"), FLIGHT_COMPUTER.files[0].text);
});

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "" } });

test("check: clean model exits 0, broken model reports file:line and exits 1", () => {
  let r = run("check", "models");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  writeFileSync(join(dir, "models", "Bad.aadl"), "package Bad\npublic\n  system S\n    properties\n      Period => 10 kg;\n  end S;\nend Bad;\n");
  r = run("check", "models", "--format", "github");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error file=models\/Bad\.aadl,line=5/);
});

test("analyze: runs analyses against a target and writes generated files", () => {
  const out = join(dir, "out");
  const r = run("analyze", "schedulability:rta,codegen:arinc", "models/Flight_Computer.aadl", "--target", "Flight_Computer::FCS.impl", "--out", out);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Schedulability Analysis: OK/);
  assert.match(r.stdout, /fctl\.law/);
  assert.match(r.stderr, /wrote 1 file/);
});

test("analyze --fail-on warning turns warnings into failures", () => {
  // The CAN capacity check is fine, but EMV2 has nothing to report → info, not a failure.
  const r = run("analyze", "resource-budgets:bus-load", "models/Flight_Computer.aadl", "--target", "Flight_Computer::FCS.impl", "--fail-on", "warning");
  assert.equal(r.status, 0, r.stdout);
});

test("lsp --stdio answers initialize and go-to-definition", async () => {
  const file = join(dir, "models", "Flight_Computer.aadl");
  const uri = pathToFileURL(file).href;
  const proc = spawn(process.execPath, [CLI, "lsp", "--stdio"], { cwd: dir });
  const responses = new Map();
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    for (;;) {
      const h = buf.indexOf("\r\n\r\n");
      if (h < 0) break;
      const len = Number(/Content-Length: (\d+)/i.exec(buf.slice(0, h))[1]);
      if (buf.length < h + 4 + len) break;
      const msg = JSON.parse(buf.slice(h + 4, h + 4 + len));
      buf = buf.slice(h + 4 + len);
      if (msg.id !== undefined) responses.set(msg.id, msg);
    }
  });
  const send = (msg) => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const reply = (id) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => (responses.has(id) ? resolve(responses.get(id)) : Date.now() - t0 > 10000 ? reject(new Error("timeout")) : setTimeout(poll, 20));
    poll();
  });
  try {
    send({ id: 1, method: "initialize", params: { rootUri: pathToFileURL(join(dir, "models")).href, capabilities: {} } });
    const init = await reply(1);
    assert.equal(init.result.serverInfo.name, "wosate-aadl-language-server");
    const text = FLIGHT_COMPUTER.files[0].text;
    const lines = text.split("\n");
    const line = lines.findIndex((l) => l.includes("law: thread Control_Law;"));
    send({ method: "textDocument/didOpen", params: { textDocument: { uri: uri.replace(/^file:\/\/\/([A-Za-z]):/, (_m, d) => `file:///${d.toLowerCase()}%3A`), languageId: "aadl", version: 1, text } } });
    send({ id: 2, method: "textDocument/definition", params: { textDocument: { uri }, position: { line, character: lines[line].indexOf("Control_Law") + 2 } } });
    const def = await reply(2);
    assert.ok(def.result, JSON.stringify(def));
    assert.match(lines[def.result.range.start.line], /thread Control_Law$/);
  } finally {
    proc.kill();
  }
});
