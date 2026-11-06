// Z3 (WebAssembly) solver backend for the browser. The files under
// public/vendor/z3 are produced by `npm run build:vendor` (see
// tools/build-vendor.mjs) and served as-is, outside the Vite bundle.
// Z3's WebAssembly build uses threads, so the page must be cross-origin
// isolated; on GitHub Pages coi-serviceworker.js arranges that.

let z3Promise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

export function z3Available() {
  return typeof window !== "undefined" && window.crossOriginIsolated === true;
}

async function loadZ3(baseUrl) {
  if (!z3Available()) {
    throw new Error(
      "Z3 needs a cross-origin isolated page (SharedArrayBuffer). Reload the page so coi-serviceworker can enable it, " +
      "or serve the site with COOP/COEP headers (npm run dev). You can still export the Lustre program and run JKind locally.",
    );
  }
  if (!window.initZ3) await loadScript(new URL("vendor/z3/z3-built.js", baseUrl).href);
  const { init } = await import(/* @vite-ignore */ new URL("vendor/z3/z3-lowlevel.js", baseUrl).href);
  return init(window.initZ3);
}

/** Create a fresh solver session: `{ eval(script) -> Promise<string>, close() }`. */
export async function createZ3Session(baseUrl = document.baseURI) {
  z3Promise ||= loadZ3(baseUrl).catch((e) => {
    z3Promise = null;
    throw e;
  });
  const { Z3 } = await z3Promise;
  return sessionFromLowLevel(Z3);
}

export function sessionFromLowLevel(Z3) {
  const cfg = Z3.mk_config();
  const ctx = Z3.mk_context_rc(cfg);
  Z3.del_config(cfg);
  return {
    eval: (script) => Z3.eval_smtlib2_string(ctx, script),
    close: () => Z3.del_context(ctx),
  };
}
