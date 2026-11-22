// A standalone, offline bundle of the actual editor diagram renderer.
// esbuild is already supplied by Vite; no additional runtime dependency.
import { build } from "esbuild";
import { mkdir, readdir, copyFile } from "node:fs/promises";
await mkdir("dist/assets/font-licenses", { recursive: true });
for (const file of await readdir("src/assets/fonts")) {
  if (file.endsWith(".txt") || file === "SOURCES.json") {
    await copyFile(`src/assets/fonts/${file}`, `dist/assets/font-licenses/${file}`);
  }
}
await build({
  entryPoints: ["src/features/diagram/capture.tsx"],
  outfile: "dist/capture.js",
  bundle: true,
  format: "iife",
  minify: true,
  loader: { ".ttf": "dataurl" },
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
