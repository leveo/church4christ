/** A local form preview. Only text nodes are created; nothing is fetched or saved. */
export function initContentPreviews() {
  for (const preview of document.querySelectorAll<HTMLElement>('[data-content-preview]')) {
    const form = preview.closest('form');
    const output = preview.querySelector<HTMLElement>('[data-preview-output]');
    if (!form || !output) continue;
    const labels = JSON.parse(preview.dataset.previewLabels ?? '{}') as Record<string, string>;
    const kind = preview.dataset.contentPreview;
    const update = () => {
      const fd = new FormData(form);
      const value = (name: string) => String(fd.get(name) ?? '').trim();
      const values = (name: string) => fd.getAll(name).map(v => String(v).trim());
      const fragment = document.createDocumentFragment();
      const add = (tag: string, text: string, parent: Node = fragment) => {
        if (!text) return;
        const element = document.createElement(tag);
        element.textContent = text;
        parent.appendChild(element);
        return element;
      };
      const rows = (title: string, fields: string[]) => {
        const columns = fields.map(values);
        const content = columns[0].map((_, i) => columns.map(c => c[i] ?? '').filter(Boolean).join(' · ')).filter(Boolean);
        if (!content.length) return;
        add('h4', title);
        const list = document.createElement('ul');
        content.forEach(text => add('li', text, list));
        fragment.appendChild(list);
      };
      const service = form.querySelector('[name="service_type_id"]') as unknown as HTMLSelectElement | null;
      if (kind === 'bulletin') {
        add('p', service?.selectedOptions[0]?.text ?? '');
        add('h3', value('bulletin_date'));
        add('p', value('service_time_label'));
        rows(labels.program, ['program_item', 'program_content', 'program_person']);
        if (value('memory_verse')) { add('h4', labels.memory); add('blockquote', value('memory_verse')); }
        rows(labels.announcements, ['ann_title', 'ann_body', 'ann_label', 'ann_url']);
        rows(labels.offering, ['offering_label', 'offering_amount']);
        rows(labels.attendance, ['attendance_label', 'attendance_count']);
        if (value('flowers')) { add('h4', labels.flowers); add('p', value('flowers')); }
      } else if (kind === 'prayer') {
        add('h3', value('sheet_date'));
        const items = values('section_items');
        values('section_heading').forEach((heading, i) => {
          add('h4', heading);
          const list = document.createElement('ul');
          (items[i] ?? '').split('\n').map(s => s.trim()).filter(Boolean).forEach(text => add('li', text, list));
          if (list.childNodes.length) fragment.appendChild(list);
        });
      } else {
        add('p', value('series'));
        add('h3', value('title'));
        add('p', [value('speaker'), value('scripture')].filter(Boolean).join(' · '));
        add('p', [value('sermon_date'), service?.selectedOptions[0]?.text].filter(Boolean).join(' · '));
        add('p', value('youtube'));
      }
      if (!fragment.childNodes.length) add('p', labels.empty);
      output.replaceChildren(fragment);
      output.hidden = false;
    };
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    for (const box of form.querySelectorAll('[data-repeat]')) new MutationObserver(update).observe(box, { childList: true });
    update();
  }
}
