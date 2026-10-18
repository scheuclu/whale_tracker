// Test-runner resolve hook: Next resolves `./db` to `db.ts` for the app, but
// Node's ESM loader does not, so the query modules cannot be imported by
// `node --test` without it. Registered via `--import` in the npm test script.
import { register } from "node:module";
register(new URL("./resolve-ts-hook.mjs", import.meta.url));
