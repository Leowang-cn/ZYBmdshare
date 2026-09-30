import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf('function shareUrl('), source.indexOf("action('upload',"));
const token = 'a'.repeat(64);
const origin = 'https://mdshare.example';
const expected = `${origin}/s/${token}`;

function harness(value, clipboard, copyResult = true) {
  const actions = {};
  const notifications = [];
  let copied;
  let removed = false;
  const document = {
    activeElement: null,
    createElement: () => ({
      style: {}, setAttribute() {},
      focus() { assert.equal(this.parent, dialog); document.activeElement = this; },
      select() { this.selectionStart = 0; this.selectionEnd = this.value.length; },
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
      remove() { removed = true; }
    }),
    execCommand(command) {
      assert.equal(command, 'copy');
      assert.equal(document.activeElement.parent, dialog);
      assert.equal(document.activeElement.selectionStart, 0);
      copied = document.activeElement.value;
      return copyResult;
    }
  };
  const input = { value, focus() {}, select() {} };
  const dialog = { append(node) { node.parent = this; } };
  runInNewContext(handlers, {
    URL, location: { origin }, document, navigator: { clipboard },
    action: (id, fn) => { actions[id] = fn; },
    element: id => ({ 'share-url': input, 'share-dialog': dialog })[id],
    notify: message => notifications.push(message)
  });
  return { actions, input, notifications, copied: () => copied, removed: () => removed };
}

test('share copy normalizes tokens, paths and full URLs before Clipboard API writes', async () => {
  for (const value of [token, `/s/${token}`, expected]) {
    let written;
    const app = harness(value, { writeText: async text => { written = text; } });
    await app.actions['copy-link']();
    assert.equal(written, expected);
    assert.equal(app.input.value, expected);
    assert.equal(app.notifications.at(-1), '链接已复制');
  }
});

test('share copy fallback stays inside modal when Clipboard API is absent or rejects', async () => {
  for (const clipboard of [undefined, { writeText: async () => { throw new Error('denied'); } }]) {
    const app = harness(expected, clipboard);
    await app.actions['copy-link']();
    assert.equal(app.copied(), expected);
    assert.equal(app.removed(), true);
    assert.equal(app.notifications.at(-1), '链接已复制');
  }
});

test('share copy does not report success when fallback fails', async () => {
  const app = harness(expected, undefined, false);
  await app.actions['copy-link']();
  assert.equal(app.removed(), true);
  assert.equal(app.notifications.at(-1), '复制失败，请手动复制');
});