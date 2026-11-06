// Example third-party WOSATE plug-in. Load it from the Plug-ins dialog with
// the URL `plugins/naming-conventions.js` (relative to the site), or host your
// own module anywhere that serves JavaScript with CORS enabled.
//
// A plug-in is a plain object; see src/core/plugin-host.js for every hook.

export default {
  id: "naming-conventions",
  name: "Naming Conventions (example)",
  version: "1.0.0",
  apiVersion: 1,
  description: "Example plug-in: warns about classifiers that are not Upper_Snake_Case and ports that are not lower_case.",

  // Runs after the core legality checks every time the model is rebuilt.
  validate(model, report) {
    for (const pkg of model.packages.values()) {
      if (pkg.name === "Base_Types") continue;
      for (const c of pkg.classifiers) {
        const typeName = c.kind === "componentImpl" ? c.typeName : c.name;
        if (!/^[A-Z][A-Za-z0-9]*(_[A-Za-z0-9]+)*$/.test(typeName)) {
          report("warning", `Classifier '${c.name}' should start with an upper-case letter`, c.loc);
        }
        for (const f of c.features || []) {
          if (/[A-Z]/.test(f.name[0])) report("info", `Feature '${f.name}' of '${c.name}' could be lower-case`, f.loc);
        }
      }
    }
  },

  analyses: [
    {
      id: "summary",
      label: "Naming: Classifier Summary",
      description: "Count classifiers per category in the workspace.",
      scope: "model",
      run({ model }) {
        const counts = new Map();
        for (const c of model.classifiers) {
          const key = `${c.category} ${c.kind === "componentImpl" ? "implementation" : "type"}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        return {
          status: "info",
          summary: `${model.classifiers.length} classifiers in ${model.packages.size} packages`,
          sections: [{
            title: "Classifiers by category",
            table: { columns: ["Kind", "Count"], rows: [...counts].sort().map(([k, n]) => ({ cells: [k, String(n)] })) },
          }],
        };
      },
    },
  ],
};
