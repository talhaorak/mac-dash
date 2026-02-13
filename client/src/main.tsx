import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Desktop-specific: Disable text selection and context menu
if (typeof window !== "undefined" && (window as any).__TAURI__) {
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
