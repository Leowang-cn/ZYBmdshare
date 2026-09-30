export const fields = ['title', 'markdown', 'parentId'];
export const values = note => Object.fromEntries(fields.map(field => [field, note[field]]));
export const same = (left, right) => fields.every(field => left[field] === right[field]);

export function mergeChanges(base, local, remote) {
  const conflicts = fields.filter(field => local[field] !== base[field] && remote[field] !== base[field] && local[field] !== remote[field]);
  const merged = Object.fromEntries(fields.map(field => [field, local[field] !== base[field] ? local[field] : remote[field]]));
  return { merged, conflicts };
}

export class Autosave {
  constructor({ note, put, get, changed = () => {} }) {
    this.base = structuredClone(note);
    this.local = values(note);
    this.put = put;
    this.get = get;
    this.changed = changed;
    this.pending = null;
    this.conflict = null;
  }
  get dirty() { return !same(this.local, this.base); }
  edit(value) { this.local = { ...value }; this.changed('edit'); }
  restore(draft) {
    if (draft.base?.id !== this.base.id || !Number.isInteger(draft.base.revision) ||
      ![draft.base, draft.local].every(note => note && typeof note.title === 'string' && typeof note.markdown === 'string' && (note.parentId === null || typeof note.parentId === 'string'))) return false;
    if (same(draft.local, this.base)) return false;
    this.base = draft.base;
    this.local = values(draft.local);
    return true;
  }
  resolve(choice) {
    if (!this.conflict) return;
    const { remote } = this.conflict;
    const { merged, conflicts } = mergeChanges(this.base, this.local, remote);
    if (choice === 'remote') for (const field of conflicts) merged[field] = remote[field];
    this.base = remote;
    this.local = merged;
    this.conflict = null;
    this.changed();
  }
  flush() {
    if (this.pending) return this.pending;
    this.pending = this.run().finally(() => { this.pending = null; });
    return this.pending;
  }
  async run() {
    let retries = 0;
    while (this.dirty) {
      if (this.conflict) throw Object.assign(new Error('存在冲突，请先选择要保留的修改'), { conflict: true });
      const sent = { ...this.local };
      let saved;
      try {
        saved = await this.put(this.base.id, { ...sent, revision: this.base.revision });
      } catch (error) {
        if (error.status !== 409 || retries++ >= 3) throw error;
        const remote = await this.get(this.base.id);
        const { merged, conflicts } = mergeChanges(this.base, this.local, remote);
        if (conflicts.length) {
          this.conflict = { remote, fields: conflicts };
          this.changed();
          throw Object.assign(new Error('存在冲突，请先选择要保留的修改'), { conflict: true });
        }
        this.base = remote;
        this.local = merged;
        this.changed();
        continue;
      }
      for (const field of fields) if (this.local[field] === sent[field]) this.local[field] = saved[field];
      this.base = saved;
      this.changed();
    }
    return this.base;
  }
}