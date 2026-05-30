/**
 * T3 — page_aliases engine round-trip (resolveAliases + setPageAliases).
 * Hermetic PGLite. Pins: write→read, collision (two slugs one alias),
 * source-scoping, replace-on-rewrite, empty-clears, empty-input.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('setPageAliases + resolveAliases', () => {
  test('write then read maps alias_norm → slug', async () => {
    await engine.setPageAliases('projects/mingtang', 'default', ['hall of light', '明堂']);
    const m = await engine.resolveAliases(['hall of light'], { sourceId: 'default' });
    expect(m.get('hall of light')).toEqual(['projects/mingtang']);
  });

  test('collision: two pages claim the same alias → both returned', async () => {
    await engine.setPageAliases('projects/mingtang', 'default', ['the hall']);
    await engine.setPageAliases('projects/other-hall', 'default', ['the hall']);
    const m = await engine.resolveAliases(['the hall'], { sourceId: 'default' });
    expect((m.get('the hall') ?? []).sort()).toEqual(['projects/mingtang', 'projects/other-hall']);
  });

  test('source-scoped: alias in source A not returned for source B', async () => {
    await engine.setPageAliases('a/page', 'src-a', ['shared name']);
    await engine.setPageAliases('b/page', 'src-b', ['shared name']);
    const aOnly = await engine.resolveAliases(['shared name'], { sourceId: 'src-a' });
    expect(aOnly.get('shared name')).toEqual(['a/page']);
    const both = await engine.resolveAliases(['shared name'], { sourceIds: ['src-a', 'src-b'] });
    expect((both.get('shared name') ?? []).sort()).toEqual(['a/page', 'b/page']);
  });

  test('rewrite replaces the prior alias set (delete + insert)', async () => {
    await engine.setPageAliases('p/x', 'default', ['old name']);
    await engine.setPageAliases('p/x', 'default', ['new name']);
    const oldM = await engine.resolveAliases(['old name'], { sourceId: 'default' });
    const newM = await engine.resolveAliases(['new name'], { sourceId: 'default' });
    expect(oldM.get('old name')).toBeUndefined();
    expect(newM.get('new name')).toEqual(['p/x']);
  });

  test('empty alias set clears the page', async () => {
    await engine.setPageAliases('p/x', 'default', ['temp']);
    await engine.setPageAliases('p/x', 'default', []);
    const m = await engine.resolveAliases(['temp'], { sourceId: 'default' });
    expect(m.size).toBe(0);
  });

  test('empty input → empty map, no query', async () => {
    const m = await engine.resolveAliases([], { sourceId: 'default' });
    expect(m.size).toBe(0);
  });

  test('idempotent re-write does not duplicate (unique triple)', async () => {
    await engine.setPageAliases('p/x', 'default', ['name', 'name']);
    const m = await engine.resolveAliases(['name'], { sourceId: 'default' });
    expect(m.get('name')).toEqual(['p/x']);
  });
});
