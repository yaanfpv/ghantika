/**
 * Package entry point. Starts the ghantika MCP server over stdio when run
 * directly (`node dist/index.js`), but does nothing on import - so a test
 * that imports `./server.js` or `./registry.js` directly to exercise them
 * in-process never accidentally boots a real server as a side effect of
 * loading this file.
 *
 * `src/index.ts` is the package's public entry point (declared in
 * `package.json`'s `"main"`/`"types"`), not one of the frozen internal
 * modules (`server.ts`/`registry.ts`/`jobStore.ts`/
 * `process.ts`/`tools/*.ts`) - it is deliberately just a thin
 * main-guarded wrapper around `runServer`.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runServer } from "./server.js";

export const GHANTIKA_VERSION = "0.1.0";

/**
 * True when this module was invoked directly rather than imported. A
 * local copy of the same technique as `scripts/lib/is-main.mjs` (percent-
 * encoding and symlink-safe, via node:path/node:url/node:fs rather than a
 * raw string compare) - not imported from there because `scripts/` sits
 * outside `tsconfig.json`'s `rootDir: "src"`, so a cross-boundary import
 * would break the build.
 */
function isMainModule(moduleUrl: string): boolean {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(moduleUrl);
  const invokedPath = path.resolve(process.argv[1]);
  try {
    return modulePath === realpathSync(invokedPath);
  } catch {
    return modulePath === invokedPath;
  }
}

if (isMainModule(import.meta.url)) {
  runServer().catch((error: unknown) => {
    console.error("[ghantika] fatal error while starting the server:", error);
    process.exitCode = 1;
  });
}
