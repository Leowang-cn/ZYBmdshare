import { Markmap } from 'markmap-view';
import { createIcons, ZoomIn, ZoomOut, Maximize, ListTree, Expand, Shrink } from 'lucide';
import './mindmap.css';

export function enhanceMindmaps(preview) {
  const cleanups = [];
  const toSeconds = value => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  const format = seconds => new Date(seconds * 1000).toISOString().slice(seconds >= 3600 ? 11 : 14, 19);
  const segments = [...preview.querySelectorAll('p')].flatMap(paragraph => {
    const match = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})-(\d{2}:\d{2}:\d{2}\.\d{3})\]/.exec(paragraph.textContent);
    return match ? [{ start: toSeconds(match[1]), end: toSeconds(match[2]), text: paragraph.textContent }] : [];
  });
  const seekVideo = seconds => {
    const video = preview.querySelector('video');
    if (!video) return;
    const seek = () => { video.currentTime = seconds; video.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
    if (video.readyState) seek();
    else { video.addEventListener('loadedmetadata', seek, { once: true }); video.load(); }
  };
  for (const source of preview.querySelectorAll('.video-mindmap')) {
    const root = source.querySelector(':scope > ul > li');
    if (!root) continue;
    const entries = new Map();
    const parse = (item, number = '') => {
      const label = item.querySelector(':scope > span')?.textContent?.trim();
      if (!label) throw new Error('Invalid mindmap');
      const key = String(entries.size);
      const entry = { item, label };
      entries.set(key, entry);
      const children = [...(item.querySelector(':scope > ul')?.children || [])].map((child, index) => parse(child, number ? `${number}.${index + 1}` : `${index + 1}`));
      const start = Number(item.dataset.start);
      const end = Number(item.dataset.end);
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) entry.range = { start, end, approximate: false };
      if (children.length) {
        const ranges = children.map(child => child.range).filter(Boolean);
        if (ranges.length) entry.range = { start: Math.min(...ranges.map(range => range.start)), end: Math.max(...ranges.map(range => range.end)), approximate: ranges.length !== children.length || ranges.some(range => range.approximate), coverage: true };
      } else if (!entry.range) {
        const timestamp = item.querySelector(':scope > figure > figcaption')?.textContent.trim();
        if (/^\d+:\d{2}:\d{2}$/.test(timestamp || '')) {
          const time = toSeconds(timestamp);
          const segment = segments.find(segment => time >= Math.floor(segment.start) && time <= segment.end);
          entry.range = { start: segment?.start ?? time, end: segment?.end ?? time, approximate: true };
        }
      }
      const text = document.createElement('span');
      text.textContent = `${number ? `${number} ` : ''}${label}`;
      const range = entry.range;
      entry.rangeLabel = range ? `${range.coverage ? '覆盖 ' : ''}${range.approximate ? '约 ' : ''}${format(range.start)}${range.end > range.start ? `–${format(range.end)}` : '（定位点）'}` : '时间范围未知';
      return { content: `<button type="button" data-node="${key}">${text.innerHTML}</button><br><button type="button" class="mindmap-time" data-node="${key}" data-seek="true">${entry.rangeLabel}</button>`, children, range };
    };
    let data;
    try { data = parse(root); } catch { continue; }
    const host = document.createElement('section');
    host.className = 'mindmap-view';
    const toolbar = document.createElement('div');
    toolbar.className = 'mindmap-toolbar';
    const canvas = document.createElement('div');
    canvas.className = 'mindmap-canvas';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-label', '视频思维导图');
    canvas.append(svg);
    const detail = document.createElement('div');
    detail.className = 'mindmap-detail';
    detail.hidden = true;
    host.append(toolbar, canvas, detail);
    source.before(host);
    source.hidden = true;
    const map = Markmap.create(svg, { initialExpandLevel: 2, maxWidth: 240, duration: 200 }, data);
    const button = (name, icon, callback) => {
      const control = document.createElement('button');
      control.type = 'button';
      control.title = name;
      control.setAttribute('aria-label', name);
      control.innerHTML = `<i data-lucide="${icon}"></i>`;
      control.onclick = callback;
      toolbar.append(control);
      return control;
    };
    button('放大', 'zoom-in', () => map.rescale(1.25));
    button('缩小', 'zoom-out', () => map.rescale(0.8));
    button('适应画布', 'maximize', () => map.fit());
    const fold = async value => {
      const visit = node => { node.payload = { ...node.payload, fold: value }; node.children?.forEach(visit); };
      data.children.forEach(visit);
      data.payload = { ...data.payload, fold: 0 };
      await map.setData(data, { initialExpandLevel: -1 });
      await map.fit();
    };
    button('全部展开', 'expand', () => fold(0));
    button('收起分支', 'shrink', () => fold(1));
    const toggle = button('列表视图', 'list-tree', () => {
      source.hidden = !source.hidden;
      canvas.hidden = !source.hidden;
      detail.hidden = true;
      toggle.setAttribute('aria-pressed', String(!source.hidden));
      if (source.hidden) map.fit();
    });
    toggle.setAttribute('aria-pressed', 'false');
    svg.addEventListener('click', event => {
      const target = event.target.closest('[data-node]');
      if (!target) return;
      const entry = entries.get(target.dataset.node);
      if (target.dataset.seek && entry.range) seekVideo(entry.range.start);
      detail.replaceChildren();
      const heading = document.createElement('strong');
      heading.textContent = entry.label;
      detail.append(heading);
      const rangeLabel = document.createElement('p');
      rangeLabel.textContent = entry.rangeLabel;
      detail.append(rangeLabel);
      const figure = entry.item.querySelector(':scope > figure');
      if (figure) detail.append(figure.cloneNode(true));
      const video = preview.querySelector('video');
      if (entry.range) {
        const { start, end } = entry.range;
        const transcript = segments.filter(segment => segment.start <= end && segment.end >= start);
        if (transcript.length) {
          const excerpt = document.createElement('p');
          excerpt.textContent = transcript.map(segment => segment.text).join('\n');
          detail.append(excerpt);
        }
        if (video) {
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.textContent = `跳转到 ${format(start)}`;
        jump.onclick = () => seekVideo(start);
        detail.append(jump);
        }
      }
      detail.hidden = false;
    });
    const observer = new ResizeObserver(() => { if (!canvas.hidden) map.fit(); });
    observer.observe(canvas);
    cleanups.push(() => { observer.disconnect(); map.destroy(); });
  }
  createIcons({ icons: { ZoomIn, ZoomOut, Maximize, ListTree, Expand, Shrink } });
  return () => cleanups.forEach(cleanup => cleanup());
}