/**
 * `base` is configurable through ALPINE_BASE, and defaults to '/'.
 *
 * Why it is not just hard-coded to the Pages subpath: a GitHub Pages project site
 * is served from `/<repo>/`, but EVERY measurement and capture tool in `tools/`
 * boots this same config through `vite.createServer()` and then navigates to
 * `http://127.0.0.1:<port>/`. Baking a subpath in would 404 all of them at once,
 * and the failure would look like the harness never appearing rather than like a
 * routing change. So the subpath is opt-in, set only by `pnpm build:pages`.
 *
 * `world/branding.js` already resolves its two brand PNGs against
 * `import.meta.env.BASE_URL`, so it follows this automatically.
 */
export default {
  base: process.env.ALPINE_BASE || '/',
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
  build: { target: 'esnext' },
};
