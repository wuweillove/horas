import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const model = readFileSync(join(root, "src/model.ts"), "utf8");
const persist = readFileSync(join(root, "src/persist.ts"), "utf8").replace(/^import \{[\s\S]*?\} from "\.\/model";\n\n/m, "");
const app = readFileSync(join(root, "src/App.tsx"), "utf8")
  .replace(/^import \{[\s\S]*?\} from "\.\/model";\n/m, "")
  .replace(/^import \{[\s\S]*?\} from "\.\/persist";\n\n/m, "")
  .replace(/^import \{ useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent \} from "react";\n/m, "");
const css = readFileSync(join(root, "src/styles.css"), "utf8");
const fontsHref =
  "https://fonts.googleapis.com/css2?family=Commissioner:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap";

const slim = `import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

${model}

${persist}

${app}

export default function HorasPage() {
  useEffect(() => {
    document.title = "Horas";
    document.documentElement.lang = "es";
    const fonts = document.createElement("link");
    fonts.rel = "stylesheet";
    fonts.href = ${JSON.stringify(fontsHref)};
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/horas.css?v=vault1";
    document.head.appendChild(fonts);
    document.head.appendChild(css);
    return () => {
      fonts.remove();
      css.remove();
    };
  }, []);
  return <App />;
}
`;

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/horas.css"), css);
writeFileSync(join(root, "dist/zo-horas-page-slim.tsx"), slim);
console.log(`wrote dist/horas.css (${css.length} chars)`);
console.log(`wrote dist/zo-horas-page-slim.tsx (${slim.length} chars)`);
