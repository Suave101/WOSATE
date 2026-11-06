# WOSATE
Web Open Source AADL Tool Environment

WOSATE is an OSATE-style AADL workbench that runs entirely in the browser and deploys to GitHub Pages as a static site. It needs no backend, Java or Eclipse. It parses and checks textual AADL with a real language server, draws editable architecture diagrams, and runs analysis plug-ins: AGREE proofs on Z3 (WebAssembly), EMV2 safety analysis, the Behavior Annex, BLESS, Resolute, latency, budgets and schedulability. It also generates code and ARINC 653 configurations. The same engine runs headless in CI.

## Features

### Editing

- **AADL language server.** It speaks real LSP JSON-RPC and runs in a Web Worker:
  - completion for property names filtered by category, enumeration values, units, classifiers, connection ends and annex keywords
  - go to definition (F12 or Ctrl+click) across files and into the standard libraries
  - find all references (Shift+F12)
  - rename (F2) across the workspace
  - hover, document symbols, folding ranges and live diagnostics

  The same server runs over stdio for desktop editors: `node tools/wosate.mjs lsp --stdio`.
- **Editor.** CodeMirror 6 with AADL and annex highlighting, folding, auto-indentation (sections and `end` re-indent as you type) and inline diagnostics.
- **Files on disk.** **File → Open Folder** edits the `.aadl` files of a folder on your machine (including subfolders). It uses the browser's File System Access API, in Chrome or Edge. Edits, new files, renames and deletions are written back to disk. Changes made by other tools (an editor, `git pull`) are picked up within a couple of seconds, and the folder reopens after a reload. Without a folder open, the workspace lives in browser storage.
- **VS Code-style workbench.** Activity bar, Explorer, Analyses and Extensions views, a Command Palette (Ctrl+Shift+P), Go to File (Ctrl+P), a Problems panel and a status bar.

### Graphical canvas

- **Diagrams.** Each implementation opens as a diagram tab (React Flow). Subcomponents appear as nodes with port and access handles, connections as edges, and call sequences inside their nodes. Double-click a node to open its own implementation.
- **Two-way sync.** The diagram is rebuilt from the model on every text change. Canvas edits are written back into the `.aadl` text at positions taken from the AST:
  - drag between ports to add a connection
  - drop a classifier from the palette to add a subcomponent
  - delete nodes or edges
  - rename (updates every reference)

### Annexes

| Annex | Support |
| --- | --- |
| AGREE | `assume`, `guarantee`, `lemma`, `assert`, `eq`, `const`, `property`, `node`, `fun`, `pre`, `prev`, `->`, library constants and nodes. Verification runs one layer at a time or across all layers: BMC plus k-induction on Z3 (WASM), a consistency check and counterexample traces. It also exports Lustre for JKind or Kind 2. |
| EMV2 | Error types and type sets (with the standard ErrorLibrary), propagations, error sources, sinks and paths, error behavior state machines, component and composite error behavior, and EMV2 properties. Legality checks cover types, points, states and subcomponents. |
| Behavior Annex and BLESS | Variables, states (initial, complete, final), transitions with dispatch, timeout and boolean guards, and actions (assignment, send and receive, if/while/for, computation). Guards and actions are type-checked against features and Base_Types. BLESS `<< … >>` assertions and invariants are kept. |
| Resolute | Claim and computation functions, constants and `prove` statements. Evaluation covers quantifiers over the instance model, set comprehensions, `let`, and built-ins such as `has_property`, `property`, `subcomponents`, `connections`, `contained`, `is_bound_to`, `upper_bound` and `sum`. |

### Analyses

Built-in analyses run in a worker thread (AGREE stays on the main thread with Z3).

- **Instance model and diagrams**, plus EMF-style JSON of the declarative model, the instance as `.aaxl2` XMI or JSON, and an XMI-to-JSON converter (File menu).
- **Flow latency** for end-to-end flows against their `Latency` requirement.
- **Resource budgets:**
  - weight and power
  - processor load (`SEI::MIPSBudget` against `MIPSCapacity`)
  - RAM and ROM
  - bus bandwidth (budgets, or Data_Size and the sender's period)

  Loads follow processor, memory and connection bindings, including through ARINC 653 partitions.
- **Schedulability** in the style of Cheddar: utilization, the Liu and Layland bound, exact response-time analysis (RM, DM or explicit priorities) and the EDF test, per physical processor.
- **EMV2 safety:**
  - fault propagation paths
  - FMEA table (CSV)
  - fault trees with minimal cut sets and top-event probability, exported as Open-PSA MEF XML and JSON
  - hazard log from `EMV2::Hazards` (CSV)
- **Behavior:** state-machine diagrams, plus reachability and deadlock checks.
- **Resolute:** assurance-case claim trees, exported as JSON.

### Generators

These are in the spirit of Ocarina and TASTE, but run in the browser. "Generate Everything" downloads a `.zip`.

- **C (POSIX threads):** data types, one buffer per sending port, thread step functions, a periodic runner with rate-monotonic priorities, and a Makefile.
- **Ada:** record types and periodic tasks using `delay until`.
- **ARINC 653 module XML:** partitions, sampling and queuing ports, the module schedule and windows, and the channel table.
- **System design document (HTML):** hierarchy, diagrams, interfaces, connections, timing, deployment and properties. Print it to save a PDF.

### Libraries

These are pre-loaded and read-only:
- AADL_Project
- Timing, Thread, Deployment, Communication, Memory, Programming and Modeling properties
- SEI
- ARINC653
- Data_Model
- EMV2, ARP4761 and MIL-STD-882
- Base_Types
- the EMV2 ErrorLibrary

They are used for validation (names, enumeration literals, units) and for completion.

### Live Share (real-time co-editing)

The workspace files live in a Yjs document shared peer-to-peer over WebRTC, so no application server is needed. To use it, run **Live Share** from the status bar or Command Palette. It copies a `#room=…` link (you can set an optional password). Peers who open the link edit the same files, with remote cursors in the editor.

Tabs in the same browser sync directly. Peers on other machines find each other through a WebRTC signaling server. The public default servers are often unreachable, so run your own (`npx y-webrtc-signaling`) and set it under **Extensions → Settings**.

### CI (headless)

A static site can't receive webhooks, so CI runs the same engine as a CLI or as a GitHub Action:

```bash
node tools/wosate.mjs check models                                  # parse and validate, exit 1 on errors
node tools/wosate.mjs analyze schedulability:rta,codegen:arinc models --target Pkg::Sys.impl --out out
node tools/wosate.mjs list                                          # available analyses
node tools/wosate.mjs lsp --stdio                                   # language server for desktop editors
```

On GitHub the CLI writes `::error` annotations and a job summary. To use it from another repository:

```yaml
- uses: Suave101/WOSATE@main
  with:
    paths: models
    target: Pkg::System.impl
    analyses: schedulability:rta,resource-budgets:bus-load,flow-latency:flow-latency
```

See [docs/aadl-check.example.yml](docs/aadl-check.example.yml). Set `agree: true` to install Z3 for AGREE analyses.

## Plug-in API

A plug-in is an ES module whose default export is a plain object:

```js
export default {
  id: "my-plugin", name: "My Plug-in", version: "1.0.0", apiVersion: 1,
  annexes: { myannex: { parse(text, ctx) { return { ast, diagnostics: [] }; } } },
  validate(model, report) { /* report("warning", "message", loc) */ },
  editorKeywords: ["my", "keywords"],
  analyses: [{
    id: "check", label: "My Check", scope: "instance", // or "model"
    run({ model, impl, instance, settings, progress }) {
      return { status: "ok", summary: "…", sections: [{ title: "…", table: { columns: [...], rows: [{ cells: [...] }] } }], files: [] };
    },
  }],
  libraries: [{ name: "My_Props.aadl", text: "property set My_Props is … end My_Props;" }],
  examples: [{ id: "demo", name: "Demo", files: [{ name: "Demo.aadl", text: "…" }], target: "Demo::S.impl" }],
};
```

To install one at runtime, go to **Extensions → Install from URL**. Try `plugins/naming-conventions.js`, which is included. The hooks are documented in [`src/core/plugin-host.js`](src/core/plugin-host.js). Results are plain data, so analyses can be unit-tested in Node (see `tests/`).

## Development

```bash
npm install
npm test            # parser, model, LSP, annexes, analyses, generators, Live Share, CLI and AGREE proofs on real Z3
npm run dev         # vendors Z3, then starts Vite on http://127.0.0.1:8080 with COOP/COEP headers
npm run build       # vendors Z3, then builds the static site into dist/
npm run preview     # serves dist/ locally with COOP/COEP headers
```

The UI is React 19 with Vite. The core (`src/core/`), language service (`src/lsp/`) and plug-ins (`src/plugins/`) are plain ES modules with no React dependency, so they run unchanged in the browser, in workers, in Node tests and in the CLI.

Z3's WebAssembly build uses threads, which need a cross-origin isolated page. GitHub Pages can't send the required headers, so the site includes [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker), which reloads the page once to turn isolation on.

## Deploying to GitHub Pages

`.github/workflows/pages.yml` runs the tests, builds `dist/` (including the ~32 MB Z3 WASM file, which is downloaded only when you verify) and deploys it. To turn it on, go to **Settings → Pages → Source** and choose **GitHub Actions**.

## Layout

```
index.html, vite.config.js  Vite entry and config (relative base for github.io)
action.yml                  GitHub Action (CI checks and analyses)
src/core/                   lexer, AADL parser, model, instance model, standard libraries, edits, serialization, zip, plug-in host
src/lsp/                    language service + LSP server (Web Worker)
src/analysis/worker.js      analysis worker
src/plugins/                agree/, emv2/, behavior/, resolute/, codegen/, instance-view, flow-latency,
                            resource-budgets, schedulability, model-export
src/ui/                     React app: App.jsx, components/, editor/ (CodeMirror 6 + LSP client), diagram/ (React Flow), collab.js (Yjs)
public/plugins/             example third-party plug-in
tools/                      wosate.mjs CLI, lsp-stdio.mjs, vendor build
tests/                      node:test suites
docs/                       example CI workflow
```
