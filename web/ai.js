import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './ai.css';

export function setupAI({ element, api, notify, getNotes, getSelected, isDirty, refresh, icons }) {
  document.querySelector('.actions').insertAdjacentHTML('afterbegin', '<button id="ai-open" title="AI 问答" aria-label="AI 问答"><i data-lucide="message-circle"></i></button>');
  element('workspace').insertAdjacentHTML('beforeend', `<section id="ai-panel" hidden aria-label="AI 问答">
    <header><strong>AI 问答</strong><button id="ai-reset" title="新建对话" aria-label="新建对话"><i data-lucide="plus"></i></button><button id="ai-close" title="关闭问答" aria-label="关闭问答"><i data-lucide="x"></i></button></header>
    <details id="ai-context" open><summary>参考笔记 <span id="ai-count"></span></summary><div id="ai-notes"></div><label><input id="ai-images" type="checkbox" checked>包含本地图片</label></details>
    <div id="ai-history" aria-label="对话记录"></div><p id="ai-state" role="status">尚未开始对话</p>
    <form id="ai-form"><textarea id="ai-question" aria-label="问题" placeholder="向所选笔记提问" maxlength="8000" required></textarea><div><button id="ai-stop" type="button" hidden title="停止" aria-label="停止"><i data-lucide="square"></i></button><button id="ai-send" type="submit" title="发送问题" aria-label="发送问题"><i data-lucide="arrow-up"></i></button></div></form>
  </section>`);
  document.body.insertAdjacentHTML('beforeend', `<dialog id="ai-note-dialog"><form id="ai-note-form"><header><h2>回答转笔记</h2><button id="ai-note-close" type="button" title="关闭" aria-label="关闭"><i data-lucide="x"></i></button></header><label>标题<input id="ai-note-title" maxlength="200" required></label><label>所属目录<select id="ai-note-parent"></select></label><label>正文<textarea id="ai-note-body" required></textarea></label><button id="ai-note-save" type="submit">创建笔记</button></form></dialog>`);
  icons();
  let history = [];
  let controller;
  let locked = false;
  const state = message => { element('ai-state').textContent = message; };
  const chosen = () => [...element('ai-notes').querySelectorAll('input:checked')].map(input => input.value);
  const lock = value => { for (const input of element('ai-context').querySelectorAll('input')) input.disabled = value; };
  const populate = () => {
    element('ai-notes').replaceChildren();
    for (const note of getNotes()) {
      const label = document.createElement('label'); const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.value = note.id; checkbox.checked = note.id === getSelected()?.id;
      checkbox.onchange = () => { element('ai-count').textContent = `(${chosen().length}/10)`; };
      label.append(checkbox, document.createTextNode(note.title)); element('ai-notes').append(label);
    }
    element('ai-count').textContent = `(${chosen().length}/10)`;
  };
  element('ai-open').onclick = () => { element('ai-panel').hidden = false; if (!locked && !controller) populate(); };
  element('ai-close').onclick = () => { element('ai-panel').hidden = true; };
  element('ai-reset').onclick = () => {
    if (controller || (history.length && !confirm('清空当前对话？尚未存为笔记的回答将丢失。'))) return;
    history = []; locked = false; element('ai-history').replaceChildren(); populate(); lock(false); state('尚未开始对话');
  };
  const draft = (text, question, sources) => {
    const parent = element('ai-note-parent'); parent.replaceChildren(new Option('根目录', ''));
    for (const note of getNotes()) parent.add(new Option(note.title, note.id));
    parent.value = getSelected()?.id || '';
    element('ai-note-title').value = question.slice(0, 100);
    element('ai-note-body').value = `${text}\n\n---\n\n原问题：${question}\n\n参考笔记：\n${sources.map(source => `- ${source.title}（ID：${source.id}，版本 ${source.revision}）`).join('\n')}`;
    element('ai-note-dialog').showModal();
  };
  const addMessage = (role, text, question, sources) => {
    const article = document.createElement('article'); article.className = `ai-message ${role}`;
    const label = document.createElement('strong'); label.textContent = role === 'user' ? '你' : 'AI';
    const body = document.createElement('div'); body.className = 'markdown';
    body.innerHTML = DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ['img', 'video', 'audio', 'source', 'iframe', 'style', 'form', 'input', 'button'], FORBID_ATTR: ['style'] });
    for (const anchor of body.querySelectorAll('a')) { anchor.rel = 'noopener noreferrer'; anchor.target = '_blank'; }
    article.append(label, body);
    if (role === 'assistant') {
      const whole = document.createElement('button'); whole.textContent = '整条存为笔记'; whole.onclick = () => draft(text, question, sources);
      const part = document.createElement('button'); part.textContent = '选中内容存为笔记'; part.disabled = true;
      let selectedText = '';
      const capture = () => { const selection = window.getSelection(); selectedText = selection && body.contains(selection.anchorNode) && body.contains(selection.focusNode) ? selection.toString() : ''; part.disabled = !selectedText.trim(); };
      body.addEventListener('mouseup', capture); body.addEventListener('keyup', capture); body.addEventListener('touchend', capture);
      part.onpointerdown = event => event.preventDefault(); part.onclick = () => draft(selectedText, question, sources);
      article.append(whole, part);
    }
    element('ai-history').append(article); article.scrollIntoView({ block: 'nearest' });
  };
  element('ai-stop').onclick = () => controller?.abort();
  element('ai-form').onsubmit = async event => {
    event.preventDefault(); if (controller) return;
    if (isDirty()) { state('当前笔记有未保存的修改，请先保存再提问。'); return; }
    const noteIds = chosen(); const question = element('ai-question').value.trim();
    if (!noteIds.length || noteIds.length > 10 || !question) { state('请选择 1-10 篇笔记并填写问题。'); return; }
    controller = new AbortController(); lock(true); element('ai-send').disabled = true; element('ai-reset').disabled = true; element('ai-stop').hidden = false;
    state('正在请求 AI…');
    try {
      const response = await fetch('/api/ai/chat', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteIds, question, history, includeImages: element('ai-images').checked }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败');
      locked = true;
      addMessage('user', question); addMessage('assistant', result.answer, question, result.sources);
      history.push({ role: 'user', content: question }, { role: 'assistant', content: result.answer });
      element('ai-question').value = ''; element('ai-context').open = false;
      state(`${result.model} · ${result.sources.length} 篇笔记 · ${result.imageCount} 张图片。${result.warnings.join(' ')}`);
    } catch (error) { state(error.name === 'AbortError' ? '已停止，可修改问题后重试。' : error.message); }
    finally { controller = undefined; lock(locked); element('ai-send').disabled = false; element('ai-reset').disabled = false; element('ai-stop').hidden = true; }
  };
  element('ai-note-close').onclick = () => element('ai-note-dialog').close();
  element('ai-note-form').onsubmit = async event => {
    event.preventDefault(); element('ai-note-save').disabled = true;
    try {
      const note = await api('/api/notes', 'POST', { title: element('ai-note-title').value, markdown: element('ai-note-body').value, parentId: element('ai-note-parent').value || null });
      element('ai-note-dialog').close(); await refresh(note); notify('已创建笔记');
    } catch (error) { notify(error.message); }
    finally { element('ai-note-save').disabled = false; }
  };
}