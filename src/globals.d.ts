// Build-time constant substituted by webpack DefinePlugin.
// - Development builds (`npm run dev` / `--mode=development`): `true`
// - Production builds (`npm run build` / `--mode=production`):   `false`
//
// Call sites of the probe module use `if (!__DEBUG__) return;` at the
// top of each exported function, and webpack's Terser step strips
// unreachable function bodies + pure_funcs call sites from the prod
// bundle so the probe ships zero bytes to store users.
//
// Jest sets this to `true` via jest.config.js `globals` so unit tests
// of the probe module see the live code path.
declare const __DEBUG__: boolean;
