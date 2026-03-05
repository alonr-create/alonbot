import { readdirSync, readFileSync } from 'fs';
import { config } from '../utils/config.js';
import { join } from 'path';

export interface Skill {
  name: string;
  description: string;
  content: string;
}

export function loadAllSkills(): Skill[] {
  try {
    const files = readdirSync(config.skillsDir).filter(f => f.endsWith('.md'));
    return files.map(f => {
      const content = readFileSync(join(config.skillsDir, f), 'utf-8');
      const nameMatch = content.match(/^#\s+(.+)/m);
      const descMatch = content.match(/^>\s*(.+)/m) || content.match(/\n\n(.+)/);
      return {
        name: nameMatch?.[1] || f.replace('.md', ''),
        description: descMatch?.[1]?.slice(0, 100) || '',
        content,
      };
    });
  } catch {
    return [];
  }
}
