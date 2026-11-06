// Model export plug-in: EMF-style JSON of the declarative model, and the
// instance model as JSON and OSATE-compatible .aaxl2 XMI.

import { modelToJson, instanceToJson, instanceToXmi } from "../core/serialize.js";

export default {
  id: "model-export",
  name: "Model Export (EMF JSON / XMI)",
  version: "0.1.0",
  description: "Serialize the declarative model as EMF-style JSON (aadl2 metamodel names) and the instance model as JSON or .aaxl2 XMI.",
  analyses: [
    {
      id: "declarative-json",
      label: "Export Declarative Model (aadl2 JSON)",
      description: "Every workspace package as EMF-style JSON.",
      scope: "model",
      run({ model, libraryFiles }) {
        const json = modelToJson(model, { libraryFiles: libraryFiles || new Set() });
        const text = JSON.stringify(json, null, 2);
        return {
          status: "ok",
          summary: `Serialized ${json.packages?.length || 0} package${json.packages?.length === 1 ? "" : "s"} (${(text.length / 1024).toFixed(1)} KB)`,
          sections: [{ title: "aadl2 JSON (preview)", code: text.length > 20000 ? `${text.slice(0, 20000)}\n…` : text }],
          files: [{ name: "model.aadl2.json", text, mime: "application/json" }],
        };
      },
    },
    {
      id: "instance-export",
      label: "Export Instance Model (.aaxl2 + JSON)",
      description: "The instantiated system as OSATE-style XMI and JSON.",
      scope: "instance",
      run({ model, instance }) {
        const xmi = instanceToXmi(model, instance);
        const json = JSON.stringify(instanceToJson(model, instance), null, 2);
        return {
          status: "ok",
          summary: `Serialized instance ${instance.name}`,
          sections: [{ title: `${instance.name}.aaxl2`, code: xmi.length > 20000 ? `${xmi.slice(0, 20000)}\n…` : xmi }],
          files: [
            { name: `${instance.name}.aaxl2`, text: xmi, mime: "application/xml" },
            { name: `${instance.name}.aaxl2.json`, text: json, mime: "application/json" },
          ],
        };
      },
    },
  ],
};
