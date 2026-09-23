import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

function mount() {
  const el = document.getElementById("horas-app");
  if (!el || el.dataset.mounted === "1") return;
  el.dataset.mounted = "1";
  createRoot(el).render(<App />);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
