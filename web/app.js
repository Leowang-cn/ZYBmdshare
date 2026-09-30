import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import { createIcons, Plus, Download, LogOut, FilePlus, Paperclip, Share2, Trash2, Save, NotebookPen, X, PanelLeft, Ellipsis, MessageCircle, ArrowUp, Square, Copy, Video } from 'lucide';
import { setupAI } from './ai.js';
import { setupVideo } from './video.js';
import 'katex/dist/katex.min.css';
import './minimal.css';

const element = id => document.getElementById(id);
const shareToken = /^\/s\/([a-f0-9]{64})$/.exec(location.pathname)?.[1];
let notes = [];
let selected = null;
let dirty = false;
let rendering = 0;
let timer;
let busy = false;
const icons = () => createIcons({ icons: { Plus, Download, LogOut, FilePlus, Paperclip, Share2, Trash2, Save, NotebookPen, X, PanelLeft, Ellipsis, MessageCircle, ArrowUp, Square, Copy, Video } });
icons();
function notify(message) { element('toast').textContent = message; element('toast').hidden = false; clearTimeout(timer); timer = setTimeout(() => { element('toast').hidden = true; }, 6000); }
async function api(route, method = 'GET', value) {
  const response = await fetch(route, { method, headers: value === undefined ? {} : { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) { element(shareToken ? 'pin-login' : 'login').hidden = false; element('workspace').hidden = true; } throw Object.assign(new Error(result.error || '请求失败'), { status: response.status }); }
  return result;
}
function action(id, callback) { element(id).addEventListener('click', async () => { try { await callback(); } catch (error) { notify(error.message); } }); }
marked.use({ extensions: [
  { name: 'blockMath', level: 'block', start: source => source.indexOf('$$'), tokenizer(source) { const match = /^\$\$\n?([\s\S]+?)\n?\$\$(?:\n|$)/.exec(source); if (match) return { type: 'blockMath', raw: match[0], text: match[1] }; }, renderer: token => katex.renderToString(token.text, { displayMode: true, throwOnError: false, trust: false }) },
  { name: 'inlineMath', level: 'inline', start: source => source.indexOf('$'), tokenizer(source) { const match = /^\$([^$\n]+?)\$/.exec(source); if (match) return { type: 'inlineMath', raw: match[0], text: match[1] }; }, renderer: token => katex.renderToString(token.text, { throwOnError: false, trust: false }) }
] });
async function render() {
  const generation = ++rendering;
  const preview = element('preview');
  preview.innerHTML = DOMPurify.sanitize(marked.parse(element('editor').value), { ADD_TAGS: ['video', 'audio', 'source'], ADD_ATTR: ['controls', 'preload'], FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button'], FORBID_ATTR: ['srcset'] });
  for (const media of preview.querySelectorAll('[src],a[href]')) {
    const attribute = media.hasAttribute('src') ? 'src' : 'href';
    const raw = media.getAttribute(attribute);
    if (raw?.startsWith('#')) continue;
    try {
      const url = new URL(raw, location.origin);
      if (!['http:', 'https:'].includes(url.protocol)) { media.removeAttribute(attribute); continue; }
      if (shareToken && url.origin === location.origin && /^\/api\/attachments\/[^/]+$/.test(url.pathname)) url.searchParams.set('share', shareToken);
      media.setAttribute(attribute, url.href);
      if (media.tagName === 'A') { media.rel = 'noopener noreferrer'; media.target = '_blank'; }
    } catch { media.removeAttribute(attribute); }
  }
  const diagrams = [...preview.querySelectorAll('code.language-mermaid')];
  if (!diagrams.length) return;
  try {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', htmlLabels: false, flowchart: { htmlLabels: false }, maxTextSize: 30000, suppressErrorRendering: true });
    for (const [index, block] of diagrams.entries()) {
      if (generation !== rendering) return;
      try {
        const { svg } = await mermaid.render(`diagram-${generation}-${index}`, block.textContent);
        if (generation !== rendering) return;
        const figure = document.createElement('figure');
        figure.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        block.parentElement.replaceWith(figure);
      } catch { block.textContent = '流程图语法错误\n' + block.textContent; }
    }
  } catch { notify('流程图加载失败'); }
}
function descendants(id) { const ids = new Set([id]); let changed = true; while (changed) { changed = false; for (const note of notes) if (ids.has(note.parentId) && !ids.has(note.id)) { ids.add(note.id); changed = true; } } return ids; }
function tree() {
  const container = element('tree'); container.replaceChildren();
  const query = element('search').value.toLowerCase();
  const visit = (parentId, depth = 0) => {
    for (const note of notes.filter(item => item.parentId === parentId)) {
      if (!query || (note.title + note.markdown).toLowerCase().includes(query)) {
        const button = document.createElement('button'); button.textContent = note.title; button.title = note.title; button.style.paddingLeft = `${12 + Math.min(depth, 8) * 14}px`; button.className = note.id === selected?.id ? 'active' : '';
        button.onclick = () => select(note.id); container.append(button);
      }
      visit(note.id, depth + 1);
    }
  };
  visit(null); element('count').textContent = `${notes.length} 篇笔记`;
}
function select(id, force = false) {
  if (busy) return;
  if (!force && dirty && !confirm('放弃未保存的修改？')) return;
  selected = notes.find(note => note.id === id) || null; dirty = false;
  element('document').hidden = !selected; element('empty').hidden = !!selected;
  for (const name of ['save', 'new-child', 'upload', 'share', 'remove']) element(name).disabled = !selected;
  if (selected) {
    element('title').value = selected.title; element('editor').value = selected.markdown;
    element('breadcrumb').textContent = selected.parentId ? notes.find(note => note.id === selected.parentId)?.title || '笔记' : (shareToken ? '只读分享' : '我的笔记');
    element('updated').textContent = new Date(selected.updatedAt).toLocaleString('zh-CN');
    const parent = element('parent'); parent.replaceChildren(new Option('根目录', ''));
    const excluded = descendants(selected.id);
    for (const note of notes) if (!excluded.has(note.id)) parent.add(new Option(note.title, note.id));
    parent.value = selected.parentId || ''; element('status').textContent = shareToken ? '只读' : '已保存';
    void render();
  }
  tree();
}
async function load(preferred) {
  const result = await api(shareToken ? `/api/public/${shareToken}` : '/api/notes'); notes = result.notes;
  element('login').hidden = true; element('workspace').hidden = false;
  element('pin-login').hidden = true;
  select(preferred || result.rootId || notes[0]?.id, true);
}
async function create(parentId) {
  if (dirty && !confirm('放弃未保存的修改？')) return;
  const note = await api('/api/notes', 'POST', { title: '未命名笔记', markdown: '', parentId });
  await load(note.id); element('title').focus(); element('title').select();
}
async function save() {
  if (!selected || busy) return;
  busy = true;
  element('save').disabled = true;
  for (const id of ['title', 'editor', 'parent']) element(id).disabled = true;
  try {
    const note = await api(`/api/notes/${selected.id}`, 'PUT', { title: element('title').value, markdown: element('editor').value, parentId: element('parent').value || null, revision: selected.revision });
    notes = notes.map(item => item.id === note.id ? note : item); selected = note; dirty = false; element('status').textContent = '已保存'; tree();
  } finally { busy = false; element('save').disabled = false; for (const id of ['title', 'editor', 'parent']) element(id).disabled = false; }
}
element('login-form').onsubmit = async event => { event.preventDefault(); try { await api('/api/session', 'POST', { token: element('token').value }); element('token').value = ''; await load(); } catch (error) { element('login-error').textContent = error.message; } };
element('pin-form').onsubmit = async event => { event.preventDefault(); try { await api(`/api/public/${shareToken}/unlock`, 'POST', { pin: element('reader-pin').value }); element('reader-pin').value = ''; await load(); } catch (error) { element('pin-error').textContent = error.message; } };
for (const id of ['title', 'editor', 'parent']) element(id).addEventListener('input', () => { dirty = true; element('status').textContent = '未保存'; if (id === 'editor') { clearTimeout(render.timer); render.timer = setTimeout(render, 350); } });
element('search').oninput = tree;
action('new-root', () => create(null)); action('empty-create', () => create(null)); action('new-child', () => create(selected.id)); action('save', save);
action('remove', async () => { if (selected && confirm(`删除“${selected.title}”及全部子笔记？此操作不可撤销。`)) { await api(`/api/notes/${selected.id}`, 'DELETE', { revision: selected.revision }); dirty = false; await load(); } });
action('logout', async () => { if (dirty && !confirm('放弃未保存的修改并退出？')) return; await api('/api/session', 'DELETE'); dirty = false; location.reload(); });
action('backup', async () => { const state = await api('/api/export'); const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `mdshare-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
async function shareList() {
  const { shares } = await api('/api/shares'); const container = element('share-list'); container.replaceChildren();
  for (const share of shares.filter(item => item.noteId === selected.id)) { const row = document.createElement('div'); row.className = 'share-row'; const label = document.createElement('span'); label.textContent = new Date(share.createdAt).toLocaleString(); const button = document.createElement('button'); button.textContent = '撤销'; button.onclick = async () => { try { await api(`/api/shares/${share.id}`, 'DELETE'); await shareList(); element('new-link').hidden = true; } catch (error) { notify(error.message); } }; row.append(label, button); container.append(row); }
  for (const [index, share] of shares.filter(item => item.noteId === selected.id).entries()) {
    const button = document.createElement('button'); button.textContent = share.pinProtected ? '修改 PIN' : '设置 PIN';
    button.onclick = async () => { const pin = prompt('新的 4 位数字 PIN'); if (pin === null) return; try { await api(`/api/shares/${share.id}`, 'PUT', { pin }); element('new-link').hidden = true; await shareList(); notify('PIN 已更新，访客需要重新解锁'); } catch (error) { notify(error.message); } };
    container.children[index].append(button);
  }
}
action('share', async () => { element('new-link').hidden = true; await shareList(); element('share-dialog').showModal(); });
function shareUrl(value) {
  const raw = String(value || '').trim();
  const path = /^[a-f0-9]{64}$/.test(raw) ? `/s/${raw}` : raw;
  return new URL(path, location.origin).href;
}
action('create-share', async () => { const pin = element('share-pin').value; const result = await api('/api/shares', 'POST', { noteId: selected.id, ...(pin ? { pin } : {}) }); element('share-url').value = shareUrl(result.url || result.token); element('created-pin').textContent = result.pin; element('new-link').hidden = false; await shareList(); });
action('copy-link', async () => {
  const input = element('share-url');
  const value = shareUrl(input.value);
  input.value = value;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else throw new Error('clipboard API unavailable');
    notify('链接已复制');
  } catch {
    const fallback = document.createElement('textarea');
    fallback.value = input.value; fallback.setAttribute('readonly', '');
    fallback.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    element('share-dialog').append(fallback);
    let copied = false;
    try {
      fallback.focus({ preventScroll: true }); fallback.select();
      fallback.setSelectionRange(0, fallback.value.length);
      copied = document.activeElement === fallback && fallback.selectionEnd === fallback.value.length && document.execCommand('copy');
    } catch { copied = false; } finally { fallback.remove(); }
    if (copied) notify('链接已复制');
    else { input.focus(); input.select(); notify('复制失败，请手动复制'); }
  }
});
action('upload', () => element('file').click());
element('file').onchange = async () => {
  const file = element('file').files[0]; element('file').value = ''; if (!file || !selected) return;
  if (file.size > 512 * 1024 * 1024) return notify('附件不能超过 512 MiB');
  const noteId = selected.id;
  try {
    const response = await fetch(`/api/notes/${noteId}/attachments?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file }); const attachment = await response.json(); if (!response.ok) throw new Error(attachment.error);
    if (selected.id !== noteId) return notify('附件已上传，但笔记已切换，未插入正文');
    const source = attachment.url;
    const markup = file.type.startsWith('video/') ? `<video controls src="${source}"></video>` : file.type.startsWith('audio/') ? `<audio controls src="${source}"></audio>` : `${file.type.startsWith('image/') ? '!' : ''}[附件](${source})`;
    element('editor').value += `\n\n${markup}\n`; element('editor').dispatchEvent(new Event('input')); notify('附件已插入，请保存笔记');
  } catch (error) { notify(error.message); }
};
for (const mode of ['edit', 'preview', 'split']) action(`${mode}-tab`, () => { element('panes').className = `${mode}-mode`; for (const tab of ['edit', 'preview', 'split']) element(`${tab}-tab`).setAttribute('aria-pressed', String(mode === tab)); });
const sidebar = visible => { document.body.classList.toggle('sidebar-closed', !visible); element('toggle-sidebar').setAttribute('aria-expanded', String(visible)); };
sidebar(!matchMedia('(max-width: 700px)').matches);
action('toggle-sidebar', () => sidebar(document.body.classList.contains('sidebar-closed')));
element('tree').addEventListener('click', () => { if (matchMedia('(max-width: 700px)').matches) sidebar(false); });
document.addEventListener('click', event => { if (!element('more').contains(event.target)) element('more').open = false; });
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 's' && !shareToken) { event.preventDefault(); save().catch(error => notify(error.message)); } });
if (!shareToken) setupAI({ element, api, notify, icons, getNotes: () => notes, getSelected: () => selected, isDirty: () => dirty, refresh: async note => { if (dirty || busy) { notes.push(note); tree(); } else await load(note.id); } });
if (!shareToken) setupVideo({ api, notify, icons, getSelected: () => selected, getMarkdown: () => element('editor').value, refresh: async id => { if (busy || dirty) throw new Error('请先保存当前笔记'); await load(id); } });
if (shareToken) {
  document.body.classList.add('shared'); element('title').readOnly = true;
  for (const id of ['new-root', 'backup', 'logout', 'empty-create', 'parent-label']) element(id).hidden = true;
}
load().catch(error => { if (shareToken && error.status !== 401) { element('pin-login').hidden = true; element('workspace').hidden = false; element('empty').querySelector('h1').textContent = '分享不存在或已撤销'; } else if (!shareToken && !element('login').hidden) element('login-error').textContent = ''; else if (error.status !== 401) notify(error.message); });