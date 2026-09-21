import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { backend } from "@/lib/backend";

// Desktop-specific: Disable text selection and context menu.
// `backend.isDesktop()` also works when `withGlobalTauri` is off (no `window.__TAURI__`).
if (backend.isDesktop()) {
  // Prevent right-click context menu
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  
  // Disable text selection globally
  document.documentElement.style.userSelect = "none";
  document.documentElement.style.webkitUserSelect = "none";
  
  // Add a global style for selectable areas (logs, code blocks)
  const style = document.createElement("style");
  style.textContent = `
    .selectable,
    .selectable *,
    pre,
    code,
    [class*="log-"],
    [class*="code-"],
    input,
    textarea {
      user-select: text !important;
      -webkit-user-select: text !important;
    }
  `;
  document.head.appendChild(style);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Backend self-test: development builds only, and only on request (`?selftest=1`).
// `import.meta.env.DEV` is a constant `false` in production, so the bundler drops this branch and the module.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("selftest") === "1") {
  import("./dev/selftest")
    .then((m) => m.runSelfTest())
    .catch((e) => console.log("SELFTEST_REPORT " + JSON.stringify({ ok: false, steps: [], failures: [`The self-test did not start: ${e}`] })));
}
