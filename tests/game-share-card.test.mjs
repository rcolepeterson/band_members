// Game share cards: renderer + validator tests.
//
// Exercises renderGameCard against a fixture chain (no database, no deploy)
// and the chain validator's accept/reject edges. Run from the repo root so the
// vendored Lato font resolves via the relative candidate path.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderGameCard, validChain } from '../netlify/functions/game_share.mjs';

const CHAIN = [
  { name: 'Nirvana', kind: 'band' },
  { name: 'Dave Grohl', kind: 'member' },
  { name: 'Queens of the Stone Age', kind: 'band' },
  { name: 'Dean Fertita', kind: 'member' },
  { name: 'The Dead Weather', kind: 'band' },
  { name: 'Jack White', kind: 'member' },
  { name: 'The White Stripes', kind: 'band' },
];

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('renderGameCard', () => {
  it('renders a non-empty PNG for a fixture chain', async () => {
    const png = await renderGameCard({ chain: CHAIN, hops: 3, host: 'sixdegreesofrock.com' });
    assert.ok(Buffer.isBuffer(png), 'expected a Buffer');
    assert.ok(png.length > 10000, `expected a real card, got ${png.length} bytes`);
    assert.ok(png.subarray(0, 8).equals(PNG_SIG), 'expected a PNG signature');
  });

  it('renders a minimal 2-node chain', async () => {
    const png = await renderGameCard({
      chain: [
        { name: 'Nirvana', kind: 'band' },
        { name: 'Dave Grohl', kind: 'member' },
      ],
      hops: 1,
    });
    assert.ok(png && png.length > 10000);
    assert.ok(png.subarray(0, 8).equals(PNG_SIG));
  });

  it('returns null for an invalid chain instead of throwing', async () => {
    const png = await renderGameCard({ chain: [{ name: 'Nirvana' }], hops: 3 });
    assert.equal(png, null);
  });
});

describe('validChain', () => {
  it('accepts a well-formed chain', () => {
    assert.deepEqual(validChain(CHAIN), CHAIN);
  });

  it('rejects chains that are too short, too long, or malformed', () => {
    assert.equal(validChain([]), null);
    assert.equal(validChain([{ name: 'Nirvana', kind: 'band' }]), null);
    assert.equal(validChain(Array.from({ length: 13 }, () => ({ name: 'X', kind: 'band' }))), null);
    assert.equal(validChain([{ name: 'Nirvana', kind: 'band' }, { name: '', kind: 'member' }]), null);
    assert.equal(validChain([{ name: 'Nirvana', kind: 'band' }, { name: 'Dave Grohl', kind: 'alien' }]), null);
    assert.equal(validChain('Nirvana → Dave Grohl'), null);
    assert.equal(validChain(null), null);
  });

  it('strips control characters and caps name length', () => {
    const nodes = validChain([
      { name: 'Nirvana\u0000', kind: 'band' },
      { name: 'x'.repeat(200), kind: 'member' },
    ]);
    assert.equal(nodes[0].name, 'Nirvana');
    assert.ok(nodes[1].name.length <= 80);
  });
});
