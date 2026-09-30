export function setupVideo({ api, notify, icons, getSelected, getMarkdown, refresh, hasUnsaved }) {
  const button = document.createElement('button');
  button.title = '视频任务';
  button.setAttribute('aria-label', '视频任务');
  button.innerHTML = '<i data-lucide="video"></i>';
  document.querySelector('.actions').prepend(button);
  const dialog = document.createElement('dialog');
  dialog.innerHTML = '<form method="dialog"><header><h2>视频任务</h2><button aria-label="关闭">关闭</button></header></form><label>视频 URL<textarea rows="5" aria-label="视频 URL"></textarea></label><button class="primary" data-submit>开始处理</button><p role="status"></p><div data-jobs></div>';
  document.body.append(dialog);
  icons();
  const input = dialog.querySelector('textarea');
  input.style.cssText = 'width:100%;resize:vertical';
  const submit = dialog.querySelector('[data-submit]');
  let parentId;
  let timer;
  const labels = { queued: '排队中', downloading: '下载中', checking: '校验中', transcribing: '转写中', summarizing: '总结中', capturing: '截图中', saving: '保存中', completed: '已完成', failed: '失败' };
  const update = async () => {
    clearTimeout(timer);
    const { jobs } = await api(`/api/notes/${parentId}/videos`);
    const container = dialog.querySelector('[data-jobs]');
    container.replaceChildren();
    for (const job of jobs) {
      const row = document.createElement('section');
      row.style.cssText = 'border-top:1px solid #ddd;padding:12px 0;overflow-wrap:anywhere';
      const url = document.createElement('p'); url.textContent = job.url;
      const status = document.createElement('p'); status.textContent = `${labels[job.status] || job.status} · ${job.progress || 0}%`;
      row.append(url, status);
      if (job.error) { const error = document.createElement('p'); error.textContent = job.error; row.append(error); }
      const open = document.createElement('button'); open.textContent = '打开子笔记';
      open.onclick = async () => { try { await refresh(job.noteId); dialog.close(); } catch (error) { notify(error.message); } };
      row.append(open);
      if (job.status === 'failed') {
        const retry = document.createElement('button'); retry.textContent = '重试';
        retry.onclick = async () => { retry.disabled = true; try { await api(`/api/notes/${parentId}/videos/${job.id}/retry`, 'POST'); await update(); } catch (error) { notify(error.message); retry.disabled = false; } };
        row.append(retry);
      }
      container.append(row);
    }
    if (dialog.open) timer = setTimeout(() => update().catch(error => notify(error.message)), 3000);
  };
  button.onclick = async () => {
    const note = getSelected();
    if (!note) return notify('请先选择一篇笔记');
    parentId = note.id;
    input.value = [...new Set([...getMarkdown().matchAll(/https?:\/\/[^\s<>"'`()\[\]]+/g)].map(match => match[0]))].join('\n');
    dialog.showModal();
    try { await update(); } catch (error) { notify(error.message); }
  };
  submit.onclick = async () => {
    submit.disabled = true;
    try {
      const urls = input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      await api(`/api/notes/${parentId}/videos`, 'POST', { urls });
      input.value = ''; await update();
    } catch (error) { notify(error.message); }
    finally { submit.disabled = false; }
  };
  dialog.addEventListener('close', () => clearTimeout(timer));
  const regenerate = document.createElement('button');
  regenerate.title = '重新生成'; regenerate.setAttribute('aria-label', '重新生成');
  regenerate.innerHTML = '<i data-lucide="refresh-cw"></i>';
  document.querySelector('.actions').prepend(regenerate);
  const batch = document.createElement('dialog');
  batch.className = 'video-regenerate';
  batch.innerHTML = '<form method="dialog"><header><h2>重新生成视频笔记</h2><button aria-label="关闭"><i data-lucide="x"></i></button></header></form><input type="search" aria-label="搜索视频笔记" placeholder="搜索视频笔记"><label><input type="checkbox" data-all>全选当前结果</label><div data-list></div><p role="status"></p><button class="primary" data-regenerate>重新生成</button>';
  document.body.append(batch); icons();
  const selection = new Set();
  const search = batch.querySelector('[type="search"]');
  const selectAll = batch.querySelector('[data-all]');
  const apply = batch.querySelector('[data-regenerate]');
  let jobs = [];
  let batchTimer;
  const available = job => ['completed', 'failed'].includes(job.status);
  const visibleJobs = () => jobs.filter(job => (job.title + job.url).toLowerCase().includes(search.value.toLowerCase()));
  const draw = () => {
    const list = batch.querySelector('[data-list]'); list.replaceChildren();
    for (const job of visibleJobs()) {
      const row = document.createElement('label'); row.className = 'video-regenerate-row';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selection.has(job.noteId); checkbox.disabled = !available(job);
      checkbox.onchange = () => { if (checkbox.checked) selection.add(job.noteId); else selection.delete(job.noteId); draw(); };
      const content = document.createElement('span');
      const title = document.createElement('strong'); title.textContent = job.title;
      const status = document.createElement('small'); status.textContent = `${labels[job.status] || job.status} · ${job.progress || 0}%${job.error ? ` · ${job.error}` : ''}`;
      const url = document.createElement('small'); url.textContent = job.url;
      const open = document.createElement('button'); open.type = 'button'; open.textContent = '打开';
      open.onclick = async event => { event.preventDefault(); try { await refresh(job.noteId); batch.close(); } catch (error) { notify(error.message); } };
      content.append(title, status, url); row.append(checkbox, content, open); list.append(row);
    }
    const candidates = visibleJobs().filter(available);
    selectAll.checked = candidates.length > 0 && candidates.every(job => selection.has(job.noteId));
    selectAll.indeterminate = !selectAll.checked && candidates.some(job => selection.has(job.noteId));
    apply.disabled = selection.size === 0 || selection.size > 30;
    batch.querySelector('[role="status"]').textContent = jobs.length ? `已选 ${selection.size} 篇（每批最多 30 篇）` : '暂无视频解析笔记';
  };
  const poll = async () => {
    clearTimeout(batchTimer);
    try {
      jobs = (await api('/api/videos')).jobs;
      for (const id of selection) if (!jobs.some(job => job.noteId === id && available(job))) selection.delete(id);
      draw();
    } catch (error) { notify(error.message); }
    if (batch.open) batchTimer = setTimeout(poll, 3000);
  };
  regenerate.onclick = async () => {
    if (hasUnsaved()) return notify('请先保存当前笔记');
    selection.clear(); search.value = ''; batch.showModal(); await poll();
  };
  search.oninput = draw;
  selectAll.onchange = () => { for (const job of visibleJobs().filter(available)) { if (selectAll.checked) selection.add(job.noteId); else selection.delete(job.noteId); } draw(); };
  apply.onclick = async () => {
    if (hasUnsaved()) return notify('请先保存当前笔记');
    if (!selection.size || selection.size > 30 || !confirm(`重新生成选中的 ${selection.size} 篇视频笔记？成功后将替换原正文，标题不变；原正文中的手动修改也会被替换。`)) return;
    apply.disabled = true;
    try { await api('/api/videos/regenerate', 'POST', { noteIds: [...selection] }); selection.clear(); notify('已加入重新生成队列'); await poll(); }
    catch (error) { notify(error.message); draw(); }
  };
  batch.addEventListener('close', () => clearTimeout(batchTimer));
}