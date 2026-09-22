import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const model = readFileSync(join(root, "src/model.ts"), "utf8");
const app = readFileSync(join(root, "src/App.tsx"), "utf8")
  .replace(/^import \{[\s\S]*?\} from "\.\/model";\n\n/m, "")
  .replace(/^import \{ useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent \} from "react";\n/m, "");
const css = readFileSync(join(root, "src/styles.css"), "utf8")
  .replace(/^html,[\s\S]*?#root \{[\s\S]*?\}\n\n/, "")
  .replaceAll("\\", "\\\\")
  .replaceAll("`", "\\`")
  .replaceAll("${", "\\${");

const page = `import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

${model}

${app}

const CSS = \`${css}\`;

export default function HorasPage() {
  useEffect(() => {
    document.title = "Horas";
    document.documentElement.lang = "es";
    const fonts = document.createElement("link");
    fonts.rel = "stylesheet";
    fonts.href =
      "https://fonts.googleapis.com/css2?family=Red+Hat+Mono:wght@500;600;700&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap";
    document.head.appendChild(fonts);
    return () => {
      fonts.remove();
    };
  }, []);
  return (
    <>
      <style>{CSS}</style>
      <App />
    </>
  );
}
`;

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/zo-horas-page.tsx"), page);
console.log(`wrote dist/zo-horas-page.tsx (${page.length} chars)`);
