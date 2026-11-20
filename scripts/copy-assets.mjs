// Copies non-TypeScript runtime assets (Lua scripts, console static files) next to the compiled JS.
import { cpSync } from 'node:fs';

cpSync('src/infra/lua', 'dist/infra/lua', { recursive: true });
cpSync('src/console', 'dist/console', { recursive: true });
