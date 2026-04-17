import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export type GroupColor = 'grey' | 'red' | 'yellow' | 'green' | 'blue' | 'purple';
export const GROUP_COLORS: GroupColor[] = ['grey', 'red', 'yellow', 'green', 'blue', 'purple'];

export interface DiscoveryGroup {
  id: string;
  name: string;
  color: GroupColor;
  collapsed: boolean;
  createdAt: number;
}

interface PersistedGroups {
  domain: string;
  schemaVersion: 1;
  groups: DiscoveryGroup[];
  memberships: Record<string, string>;  // candidate key -> group id
}

export interface DiscoveryGroupStoreOptions {
  domain: string;
  persistPath: string;
}

export class DiscoveryGroupStore {
  private groups: DiscoveryGroup[] = [];
  private memberships = new Map<string, string>();
  private domain: string;
  private persistPath: string;
  private idCounter = 0;

  constructor(opts: DiscoveryGroupStoreOptions) {
    this.domain = opts.domain;
    this.persistPath = opts.persistPath;
  }

  load(): void {
    if (!existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as PersistedGroups;
      if (data.schemaVersion !== 1) return;
      this.groups = data.groups || [];
      this.memberships = new Map(Object.entries(data.memberships || {}));
      for (const g of this.groups) {
        const n = parseInt(g.id.replace(/^grp_/, ''), 10);
        if (!isNaN(n) && n > this.idCounter) this.idCounter = n;
      }
    } catch {}
  }

  private save(): void {
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const data: PersistedGroups = {
      domain: this.domain,
      schemaVersion: 1,
      groups: this.groups,
      memberships: Object.fromEntries(this.memberships),
    };
    writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  listGroups(): DiscoveryGroup[] {
    return [...this.groups].sort((a, b) => a.createdAt - b.createdAt);
  }

  createGroup(name: string, color: GroupColor): DiscoveryGroup {
    const g: DiscoveryGroup = {
      id: 'grp_' + (++this.idCounter),
      name: name.trim() || 'Group',
      color,
      collapsed: false,
      createdAt: Date.now(),
    };
    this.groups.push(g);
    this.save();
    return g;
  }

  updateGroup(id: string, patch: Partial<Pick<DiscoveryGroup, 'name' | 'color' | 'collapsed'>>): DiscoveryGroup | null {
    const g = this.groups.find((x) => x.id === id);
    if (!g) return null;
    if (patch.name !== undefined) g.name = patch.name.trim() || g.name;
    if (patch.color !== undefined) g.color = patch.color;
    if (patch.collapsed !== undefined) g.collapsed = patch.collapsed;
    this.save();
    return g;
  }

  deleteGroup(id: string): boolean {
    const before = this.groups.length;
    this.groups = this.groups.filter((g) => g.id !== id);
    if (this.groups.length === before) return false;
    for (const [key, gid] of this.memberships) {
      if (gid === id) this.memberships.delete(key);
    }
    this.save();
    return true;
  }

  assignMember(key: string, groupId: string | null): void {
    if (groupId === null) this.memberships.delete(key);
    else if (this.groups.some((g) => g.id === groupId)) this.memberships.set(key, groupId);
    this.save();
  }

  groupOf(key: string): string | null {
    return this.memberships.get(key) ?? null;
  }

  forgetMember(key: string): void {
    if (this.memberships.delete(key)) this.save();
  }
}
