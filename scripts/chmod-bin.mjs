// Mark the compiled CLI entry executable so `npx aithon-mcp-server` works from a local build.
import { chmodSync } from 'node:fs';

chmodSync(new URL('../dist/index.js', import.meta.url), 0o755);
