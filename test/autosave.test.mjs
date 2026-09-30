import test from 'node:test';
import assert from 'node:assert/strict';
import { Autosave, mergeChanges } from '../web/autosave.js';

const note = { id: 'one', title: 'Title', markdown: 'Body', parentId: null, revision: 1 };
const conflict = () => Object.assign(new Error('Conflict'), { status: 409 });

test('merges different fields but reports competing edits', () => {
  assert.deepEqual(mergeChanges(note, { ...note, title: 'Mine' }, { ...note, markdown: 'Remote' }), {
    merged: { title: 'Mine', markdown: 'Remote', parentId: null }, conflicts: [],
  });
  assert.deepEqual(mergeChanges(note, { ...note, title: 'Mine' }, { ...note, title: 'Other' }).conflicts, ['title']);
});

test('serializes saves and keeps input made during a request', async () => {
  let release;
  const requests = [];
  const saver = new Autosave({ note, put: async (id, value) => {
    requests.push(value);
    if (requests.length === 1) await new Promise(resolve => { release = resolve; });
    return { id, ...value, revision: value.revision + 1 };
  } });
  saver.edit({ ...saver.local, title: 'First' });
  const pending = saver.flush();
  saver.edit({ ...saver.local, title: 'Second' });
  assert.equal(saver.flush(), pending);
  release();
  await pending;
  assert.deepEqual(requests.map(value => [value.title, value.revision]), [['First', 1], ['Second', 2]]);
  assert.equal(saver.dirty, false);
});

test('retries independent changes with the current server revision', async () => {
  let calls = 0;
  const saver = new Autosave({ note, get: async () => ({ ...note, markdown: 'Remote', revision: 2 }), put: async (id, value) => {
    if (++calls === 1) throw conflict();
    assert.equal(value.revision, 2);
    return { id, ...value, revision: 3 };
  } });
  saver.edit({ ...saver.local, title: 'Mine' });
  await saver.flush();
  assert.equal(saver.base.title, 'Mine');
  assert.equal(saver.base.markdown, 'Remote');
});

test('conflicts pause writes and allow either version without dropping unrelated edits', async () => {
  for (const choice of ['local', 'remote']) {
    let calls = 0;
    const saver = new Autosave({ note, get: async () => ({ ...note, title: 'Other', revision: 2 }), put: async (id, value) => {
      if (++calls === 1) throw conflict();
      return { id, ...value, revision: value.revision + 1 };
    } });
    saver.edit({ ...saver.local, title: 'Mine', markdown: 'New body' });
    await assert.rejects(saver.flush(), /存在冲突/);
    await assert.rejects(saver.flush(), /存在冲突/);
    assert.equal(calls, 1);
    saver.resolve(choice);
    await saver.flush();
    assert.equal(saver.base.title, choice === 'local' ? 'Mine' : 'Other');
    assert.equal(saver.base.markdown, 'New body');
  }
});

test('failed saves retain a restorable draft and its original revision', async () => {
  const saver = new Autosave({ note, put: async () => { throw new Error('Offline'); } });
  saver.edit({ ...saver.local, title: 'Unsaved' });
  await assert.rejects(saver.flush(), /Offline/);
  const restored = new Autosave({ note: { ...note, revision: 2 } });
  assert.equal(restored.restore(JSON.parse(JSON.stringify({ base: saver.base, local: saver.local }))), true);
  assert.equal(restored.base.revision, 1);
  assert.equal(restored.local.title, 'Unsaved');
  assert.equal(restored.dirty, true);
  assert.equal(restored.restore({ base: note, local: {} }), false);
});