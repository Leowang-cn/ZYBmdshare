import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import { createIcons, Plus, Download, LogOut, FilePlus, Paperclip, Share2, Trash2, Save, NotebookPen, X, PanelLeft, Ellipsis, MessageCircle, ArrowUp, Square, Copy, Video, RefreshCw } from 'lucide';
import { setupAI } from './ai.js';
import { setupVideo } from './video.js';
import { enhanceMindmaps } from './mindmap.js';
import { Autosave, fields, same } from './autosave.js';
import 'katex/dist/katex.min.css';
import './minimal.css';

const element = id => document.getElementById(id);
const shareToken = /^\/s\/([a-f0-9]{64})$/.exec(location.pathname)?.[1];
let notes = [];
let selected = null;
let dirty = false;
let rendering = 0;
let cleanupMindmaps = () => {};
let timer;
let busy = false;
let saver = null;
let saveTimer;
let composing = false;
let storageWarning = false;
const draftPrefix = 'mdshare-draft-v1:';
const draftOwner = crypto.randomUUID();
let draftKey = null;
let restoredDraft = null;
const conflictDialog = document.createElement('dialog');
conflictDialog.setAttribute('aria-label', '解决保存冲突');
document.body.append(conflictDialog);
function persistDraft() {
  if (!saver || shareToken || !draftKey) return;
  try {
    if (saver.dirty) localStorage.setItem(draftKey, JSON.stringify({ base: saver.base, local: saver.local, updatedAt: Date.now() }));
    else {
      localStorage.removeItem(draftKey);
      if (restoredDraft && localStorage.getItem(restoredDraft.key) === restoredDraft.raw) localStorage.removeItem(restoredDraft.key);
      restoredDraft = null;
    }
  } catch {
    if (!storageWarning) notify('本地草稿存储不可用，请保持页面打开并确认云端保存成功');
    storageWarning = true;
  }
}
function syncEditor() {
  selected = saver.base;
  notes = notes.map(note => note.id === selected.id ? selected : note);
  const mapping = { title: 'title', markdown: 'editor', parentId: 'parent' };
  let markdownChanged = false;
  for (const field of fields) {
    const input = element(mapping[field]);
    const value = saver.local[field] ?? '';
    if (input.value !== value) {
      if (field === 'parentId' && value && ![...input.options].some(option => option.value === value)) input.add(new Option(notes.find(note => note.id === value)?.title || '父笔记', value));
      input.value = value;
      if (field === 'markdown') markdownChanged = true;
    }
  }
  dirty = saver.dirty;
  persistDraft();
  resizeTitle();
  element('updated').textContent = new Date(selected.updatedAt).toLocaleString('zh-CN');
  if (markdownChanged) void render();
  tree();
}
function scheduleSave() {
  clearTimeout(saveTimer);
  if (!shareToken && dirty && !composing && !saver?.conflict) saveTimer = setTimeout(() => { save().catch(() => {}); }, 1000);
}
function showConflict() {
  if (!saver?.conflict || conflictDialog.open) return;
  conflictDialog.replaceChildren();
  const heading = document.createElement('h2'); heading.textContent = '笔记存在冲突';
  conflictDialog.append(heading);
  const names = { title: '标题', markdown: '正文', parentId: '父笔记' };
  for (const field of saver.conflict.fields) {
    const heading = document.createElement('h3'); heading.textContent = names[field]; conflictDialog.append(heading);
    for (const [label, value] of [['本地', saver.local[field]], ['服务器', saver.conflict.remote[field]]]) {
      const text = document.createElement('pre'); text.style.cssText = 'white-space:pre-wrap;overflow:auto;max-height:160px;max-width:600px';
      text.textContent = `${label}：${value ?? '根目录'}`; conflictDialog.append(text);
    }
  }
  for (const [label, choice] of [['保留本地冲突字段', 'local'], ['采用服务器冲突字段', 'remote'], ['稍后处理', null]]) {
    const button = document.createElement('button'); button.textContent = label;
    button.onclick = () => {
      conflictDialog.close();
      if (choice) { saver.resolve(choice); syncEditor(); save().catch(() => {}); }
    };
    conflictDialog.append(button);
  }
  conflictDialog.showModal();
}
function restoreDraft() {
  draftKey = `${draftPrefix}${selected.id}:${draftOwner}`;
  restoredDraft = null;
  try {
    const drafts = Object.keys(localStorage).filter(key => key.startsWith(`${draftPrefix}${selected.id}:`)).flatMap(key => {
      try { const raw = localStorage.getItem(key); const value = JSON.parse(raw); return value?.local && value?.base ? [{ key, raw, value }] : []; } catch { return []; }
    }).sort((left, right) => right.value.updatedAt - left.value.updatedAt);
    const draft = drafts.find(item => item.value?.local && !same(item.value.local, selected));
    if (draft && confirm('发现此笔记的本地未保存草稿，是否恢复？')) {
      if (saver.restore(draft.value)) {
        restoredDraft = draft;
        syncEditor();
        element('status').textContent = '草稿已恢复，待保存';
        scheduleSave();
      }
    }
  } catch { notify('无法读取本地草稿'); }
}
const icons = () => createIcons({ icons: { Plus, Download, LogOut, FilePlus, Paperclip, Share2, Trash2, Save, NotebookPen, X, PanelLeft, Ellipsis, MessageCircle, ArrowUp, Square, Copy, Video, RefreshCw } });
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
  cleanupMindmaps();
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
  cleanupMindmaps = enhanceMindmaps(preview);
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
function resizeTitle() {
  const title = element('title');
  if (!title.getClientRects().length) return;
  title.style.height = 'auto';
  title.style.height = `${title.scrollHeight}px`;
}
element('title').addEventListener('input', resizeTitle);
new ResizeObserver(resizeTitle).observe(document.querySelector('.document-heading'));
function tree() {
  const container = element('tree'); container.replaceChildren();
  const query = element('search').value.toLowerCase();
  const visit = (parentId, depth = 0) => {
    for (const note of notes.filter(item => item.parentId === parentId).sort((left, right) => left.title.localeCompare(right.title, 'zh-CN', { numeric: true, sensitivity: 'base' }))) {
      if (!query || (note.title + note.markdown).toLowerCase().includes(query)) {
        const button = document.createElement('button'); button.textContent = note.title; button.title = note.title; button.style.paddingLeft = `${12 + Math.min(depth, 8) * 14}px`; button.className = note.id === selected?.id ? 'active' : '';
        button.onclick = () => select(note.id).catch(error => notify(error.message)); container.append(button);
      }
      visit(note.id, depth + 1);
    }
  };
  visit(null); element('count').textContent = `${notes.length} 篇笔记`;
}
async function select(id, force = false) {
  if (!force && (dirty || busy)) await save();
  clearTimeout(saveTimer);
  selected = notes.find(note => note.id === id) || null; dirty = false;
  element('document').hidden = !selected; element('empty').hidden = !!selected;
  for (const name of ['save', 'new-child', 'upload', 'share', 'remove']) element(name).disabled = !selected;
  if (selected) {
    element('title').value = selected.title; element('editor').value = selected.markdown;
    resizeTitle();
    element('breadcrumb').textContent = selected.parentId ? notes.find(note => note.id === selected.parentId)?.title || '笔记' : (shareToken ? '只读分享' : '我的笔记');
    element('updated').textContent = new Date(selected.updatedAt).toLocaleString('zh-CN');
    const parent = element('parent'); parent.replaceChildren(new Option('根目录', ''));
    const excluded = descendants(selected.id);
    for (const note of notes) if (!excluded.has(note.id)) parent.add(new Option(note.title, note.id));
    parent.value = selected.parentId || ''; element('status').textContent = shareToken ? '只读' : '已保存';
    if (!shareToken) {
      saver = new Autosave({ note: selected, put: (id, value) => api(`/api/notes/${id}`, 'PUT', value), get: id => api(`/api/notes/${id}`), changed: reason => { dirty = saver.dirty; if (reason === 'edit') persistDraft(); else syncEditor(); } });
      restoreDraft();
    }
    void render();
  } else { saver = null; draftKey = null; }
  tree();
}
async function load(preferred) {
  const result = await api(shareToken ? `/api/public/${shareToken}` : '/api/notes'); notes = result.notes;
  element('login').hidden = true; element('workspace').hidden = false;
  element('pin-login').hidden = true;
  await select(preferred || result.rootId || notes[0]?.id, true);
}
async function create(parentId) {
  if (dirty || busy) await save();
  const note = await api('/api/notes', 'POST', { title: '未命名笔记', markdown: '', parentId });
  await load(note.id); element('title').focus(); element('title').select();
}
async function save() {
  if (!selected || shareToken || !saver) return;
  clearTimeout(saveTimer);
  if (busy) return saver.flush();
  busy = true;
  element('save').disabled = true;
  element('status').textContent = '保存中';
  try {
    await saver.flush();
    syncEditor();
    element('status').textContent = '已保存';
  } catch (error) {
    syncEditor();
    element('status').textContent = error.conflict ? '存在冲突' : '保存失败，修改已保留';
    if (error.conflict) showConflict(); else notify(`保存失败：${error.message}。可点击保存重试。`);
    throw error;
  } finally { busy = false; element('save').disabled = false; }
}
element('login-form').onsubmit = async event => { event.preventDefault(); try { await api('/api/session', 'POST', { token: element('token').value }); element('token').value = ''; await load(); } catch (error) { element('login-error').textContent = error.message; } };
element('pin-form').onsubmit = async event => { event.preventDefault(); try { await api(`/api/public/${shareToken}/unlock`, 'POST', { pin: element('reader-pin').value }); element('reader-pin').value = ''; await load(); } catch (error) { element('pin-error').textContent = error.message; } };
for (const id of ['title', 'editor', 'parent']) {
  element(id).addEventListener('input', () => {
    if (shareToken || !saver) return;
    saver.edit({ title: element('title').value, markdown: element('editor').value, parentId: element('parent').value || null });
    element('status').textContent = saver.conflict ? '存在冲突' : busy ? '保存中' : dirty ? '待保存' : '已保存';
    scheduleSave();
    if (id === 'editor') { clearTimeout(render.timer); render.timer = setTimeout(render, 350); }
  });
  element(id).addEventListener('compositionstart', () => { composing = true; clearTimeout(saveTimer); });
  element(id).addEventListener('compositionend', () => { composing = false; scheduleSave(); });
}
window.addEventListener('online', scheduleSave);
element('search').oninput = tree;
action('new-root', () => create(null)); action('empty-create', () => create(null)); action('new-child', () => create(selected.id)); action('save', save);
action('remove', async () => { if (selected && confirm(`删除“${selected.title}”及全部子笔记？此操作不可撤销。`)) { await save(); await api(`/api/notes/${selected.id}`, 'DELETE', { revision: selected.revision }); dirty = false; await load(); } });
action('logout', async () => { if (dirty || busy) await save(); await api('/api/session', 'DELETE'); dirty = false; location.reload(); });
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
const sidebarHandle = document.createElement('div');
sidebarHandle.id = 'sidebar-resizer'; sidebarHandle.tabIndex = 0;
sidebarHandle.setAttribute('role', 'separator'); sidebarHandle.setAttribute('aria-orientation', 'vertical');
sidebarHandle.setAttribute('aria-label', '调整目录宽度'); sidebarHandle.setAttribute('aria-controls', 'tree');
sidebarHandle.title = '调整目录宽度';
document.querySelector('aside').append(sidebarHandle);
let sidebarWidth = 240;
try { sidebarWidth = Number(localStorage.getItem('mdshare-sidebar-width')) || 240; } catch {}
const resizeSidebar = width => {
  const maximum = Math.max(200, Math.min(600, window.innerWidth - 360));
  sidebarWidth = Math.round(Math.max(200, Math.min(maximum, Number.isFinite(width) ? width : 240)));
  element('workspace').style.setProperty('--sidebar-width', `${sidebarWidth}px`);
  sidebarHandle.setAttribute('aria-valuemin', '200'); sidebarHandle.setAttribute('aria-valuemax', String(maximum));
  sidebarHandle.setAttribute('aria-valuenow', String(sidebarWidth));
};
const rememberSidebar = () => { try { localStorage.setItem('mdshare-sidebar-width', String(sidebarWidth)); } catch {} };
let sidebarDrag = null;
sidebarHandle.addEventListener('pointerdown', event => {
  if (event.button !== 0 || matchMedia('(max-width: 700px)').matches) return;
  event.preventDefault();
  sidebarDrag = { pointerId: event.pointerId, startX: event.clientX, width: sidebarWidth };
  sidebarHandle.setPointerCapture(event.pointerId); document.body.classList.add('sidebar-resizing');
});
sidebarHandle.addEventListener('pointermove', event => {
  if (sidebarDrag?.pointerId === event.pointerId) resizeSidebar(sidebarDrag.width + event.clientX - sidebarDrag.startX);
});
const endSidebarDrag = () => { sidebarDrag = null; document.body.classList.remove('sidebar-resizing'); rememberSidebar(); };
sidebarHandle.addEventListener('pointerup', endSidebarDrag);
sidebarHandle.addEventListener('pointercancel', endSidebarDrag);
sidebarHandle.addEventListener('lostpointercapture', endSidebarDrag);
sidebarHandle.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  resizeSidebar(event.key === 'Home' ? 200 : event.key === 'End' ? 600 : sidebarWidth + (event.key === 'ArrowRight' ? 20 : -20));
  rememberSidebar();
});
resizeSidebar(sidebarWidth);
window.addEventListener('resize', () => { if (window.innerWidth > 700) resizeSidebar(sidebarWidth); });
sidebar(!matchMedia('(max-width: 700px)').matches);
action('toggle-sidebar', () => sidebar(document.body.classList.contains('sidebar-closed')));
element('tree').addEventListener('click', () => { if (matchMedia('(max-width: 700px)').matches) sidebar(false); });
document.addEventListener('click', event => { if (!element('more').contains(event.target)) element('more').open = false; });
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 's' && !shareToken) { event.preventDefault(); save().catch(error => notify(error.message)); } });
if (!shareToken) setupAI({ element, api, notify, icons, getNotes: () => notes, getSelected: () => selected, isDirty: () => dirty, refresh: async note => { if (dirty || busy) { notes.push(note); tree(); } else await load(note.id); } });
if (!shareToken) setupVideo({ api, notify, icons, getSelected: () => selected, getMarkdown: () => element('editor').value, hasUnsaved: () => busy || dirty, refresh: async id => { if (busy || dirty) throw new Error('请先保存当前笔记'); await load(id); } });
if (shareToken) {
  document.body.classList.add('shared'); element('title').readOnly = true;
  const download = document.createElement('button');
  download.id = 'download-share'; download.title = '下载 ZIP'; download.setAttribute('aria-label', '下载 ZIP');
  download.innerHTML = '<i data-lucide="download"></i>';
  element('breadcrumb').after(download); icons();
  action('download-share', async () => {
    download.disabled = true;
    try {
      await api(`/api/public/${shareToken}`);
      const anchor = document.createElement('a');
      anchor.href = `/api/public/${shareToken}/download`; anchor.download = '';
      document.body.append(anchor); anchor.click(); anchor.remove();
    } finally { download.disabled = false; }
  });
  for (const id of ['new-root', 'backup', 'logout', 'empty-create', 'parent-label']) element(id).hidden = true;
}
load().catch(error => { if (shareToken && error.status !== 401) { element('pin-login').hidden = true; element('workspace').hidden = false; element('empty').querySelector('h1').textContent = '分享不存在或已撤销'; } else if (!shareToken && !element('login').hidden) element('login-error').textContent = ''; else if (error.status !== 401) notify(error.message); });