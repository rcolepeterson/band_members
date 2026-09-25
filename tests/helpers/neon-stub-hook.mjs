// node:module customization hook: redirect `@neondatabase/serverless` to
// the in-repo fake (tests/helpers/neon-stub.mjs) so handler tests run the
// real request path without a live Postgres.
//
// Usage (must run BEFORE the handler modules load — hence dynamic import):
//   import { register } from 'node:module';
//   register('./helpers/neon-stub-hook.mjs', import.meta.url);
//   const { default: bandsEdit } = await import('../netlify/functions/bands_edit.mjs');
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const stubUrl =
  'file://' + path.join(path.dirname(fileURLToPath(import.meta.url)), 'neon-stub.mjs');

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@neondatabase/serverless') {
    return { url: stubUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
