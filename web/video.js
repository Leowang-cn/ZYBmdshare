export function setupVideo({ api, notify, icons, getSelected, getMarkdown, refresh }) {
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
}