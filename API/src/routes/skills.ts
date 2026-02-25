import { Router } from 'express';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const router = Router();
interface SkillListing {
  name: string;
  type: 'pre-installed' | 'custom';
  characterCount: number;
}

function readSkillLength(filePath: string): number {
  if (!existsSync(filePath)) {
    return 0;
  }

  const content = readFileSync(filePath, 'utf-8');
  return content.length;
}

function getCustomSkillsDir(): string {
  const dir = join(homedir(), '.steroids', 'skills');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getPreinstalledSkillsDir(): string {
  // Relative to API running from either root or dist
  let currentDir = process.cwd();
  let rootDir = currentDir;
  while (currentDir !== '/') {
    if (existsSync(join(currentDir, 'WebUI', 'src', 'assets', 'skills'))) {
      rootDir = currentDir;
      break;
    }
    currentDir = join(currentDir, '..');
  }
  return join(rootDir, 'WebUI', 'src', 'assets', 'skills');
}

router.get('/skills', (req, res) => {
  const skills: SkillListing[] = [];

  try {
    const customDir = getCustomSkillsDir();
    if (existsSync(customDir)) {
      for (const file of readdirSync(customDir)) {
        if (file.endsWith('.md')) {
          const name = file.replace('.md', '');
          skills.push({ name, type: 'custom', characterCount: readSkillLength(join(customDir, file)) });
        }
      }
    }

    const preinstalledDir = getPreinstalledSkillsDir();
    if (existsSync(preinstalledDir)) {
      for (const file of readdirSync(preinstalledDir)) {
        if (file.endsWith('.md')) {
          const name = file.replace('.md', '');
          if (!skills.find(s => s.name === name)) {
            skills.push({ name, type: 'pre-installed', characterCount: readSkillLength(join(preinstalledDir, file)) });
          }
        }
      }
    }
    res.json({ success: true, data: skills });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/skills/:name', (req, res) => {
  const name = req.params.name;
  
  try {
    const customFile = join(getCustomSkillsDir(), `${name}.md`);
    if (existsSync(customFile)) {
      return res.json({ success: true, data: { name, content: readFileSync(customFile, 'utf-8'), type: 'custom' } });
    }

    const preinstalledFile = join(getPreinstalledSkillsDir(), `${name}.md`);
    if (existsSync(preinstalledFile)) {
      return res.json({ success: true, data: { name, content: readFileSync(preinstalledFile, 'utf-8'), type: 'pre-installed' } });
    }

    res.status(404).json({ success: false, error: 'Skill not found' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/skills/:name', (req, res) => {
  const name = req.params.name;
  const { content } = req.body;
  
  if (!content) {
    return res.status(400).json({ success: false, error: 'Content is required' });
  }

  try {
    const filePath = join(getCustomSkillsDir(), `${name.replace('.md', '')}.md`);
    writeFileSync(filePath, content, 'utf-8');
    res.json({ success: true, message: 'Skill created/updated successfully' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
