/**
 * Builds the hosted page bundle into static/notibase.js.
 *
 * The output is COMMITTED. Deploy mounts packages/sdk-web/static straight
 * into Caddy from the checked-out tree (infra/docker-compose.yml), so a
 * bundle that only exists after a build step would never reach the CDN
 * path customers paste into their <head>.
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const out = join(root, "static", "notibase.js");

await build({
  entryPoints: [join(root, "src", "browser.ts")],
  bundle: true,
  format: "iife",
  target: ["es2019"],          // wide enough for every browser that has Push
  minify: true,
  legalComments: "none",
  outfile: out,
});

// A banner the minifier cannot eat, so a customer can tell us what they run.
const banner = `/*! Notibase web SDK v${version} — https://notibase.com */\n`;
writeFileSync(out, banner + readFileSync(out, "utf8"));

console.log(`sdk-web: static/notibase.js (${readFileSync(out).length} bytes)`);
