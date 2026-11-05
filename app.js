const sampleModel = `package wowate_demo
public
  system DemoSystem
  annex agree {**
    assume "input_range": x >= 0 and x <= 10;
    guarantee "output_safe": y >= x;
  **};
end DemoSystem;
end wowate_demo;`;

const editor = document.getElementById("editor");
const diagnostics = document.getElementById("diagnostics");
const loadSampleButton = document.getElementById("load-sample");
const analyzeButton = document.getElementById("analyze");

function addDiagnostic(text, level = "ok") {
  const item = document.createElement("li");
  item.className = level;
  item.textContent = text;
  diagnostics.appendChild(item);
}

function getPackageName(source) {
  const match = source.match(/^\s*package\s+([A-Za-z0-9_]+)\b/im);
  return match ? match[1] : null;
}

function getEndPackageName(source) {
  const matches = [...source.matchAll(/\bend\s+([A-Za-z0-9_]+)\s*;/gi)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

function analyzeSource(source) {
  diagnostics.innerHTML = "";

  if (!source.trim()) {
    addDiagnostic("Editor is empty. Paste an AADL model with AGREE annex content.", "warning");
    return;
  }

  const packageName = getPackageName(source);
  const endPackageName = getEndPackageName(source);

  if (!packageName) {
    addDiagnostic("Missing `package <name>` declaration.", "error");
  }

  if (!endPackageName) {
    addDiagnostic("Missing closing `end <name>;` declaration.", "error");
  }

  if (packageName && endPackageName && packageName !== endPackageName) {
    addDiagnostic(
      `Package name mismatch: package is '${packageName}' but closing end is '${endPackageName}'.`,
      "error"
    );
  }

  const agreeBlocks = [...source.matchAll(/annex\s+agree\s*\{\*\*([\s\S]*?)\*\*\}\s*;/gi)];

  if (!agreeBlocks.length) {
    addDiagnostic("No AGREE annex found. Add `annex agree {** ... **};`.", "error");
    return;
  }

  let hasContract = false;
  for (const block of agreeBlocks) {
    const body = block[1];
    if (/\b(assume|guarantee)\b/i.test(body)) {
      hasContract = true;
    }

    const lines = body.split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("--")) {
        return;
      }
      if (/\b(assume|guarantee)\b/i.test(trimmed) && !trimmed.endsWith(";")) {
        addDiagnostic(
          `AGREE contract line ${index + 1} in an annex block should end with ';'.`,
          "warning"
        );
      }
    });
  }

  if (!hasContract) {
    addDiagnostic("AGREE annex found, but no assume/guarantee contract statements were detected.", "warning");
  }

  if (!diagnostics.children.length) {
    addDiagnostic("Basic AADL and AGREE checks passed.", "ok");
  }
}

loadSampleButton.addEventListener("click", () => {
  editor.value = sampleModel;
  analyzeSource(editor.value);
});

analyzeButton.addEventListener("click", () => analyzeSource(editor.value));

editor.value = sampleModel;
analyzeSource(editor.value);
