// Copies non-TypeScript runtime assets (Lua scripts) next to the compiled JS.
import { cpSync } from 'node:fs';

cpSync('src/infra/lua', 'dist/infra/lua', { recursive: true });
