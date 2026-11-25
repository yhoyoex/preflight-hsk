#!/usr/bin/env node
// Entry for MCP clients: loads the TypeScript sources through tsx (workspace packages ship .ts).
import { register } from "tsx/esm/api";

register();
await import("../src/main.ts");
