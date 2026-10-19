import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * `npm run skill:zip`. Builds `dist/anylist-meal-planning-skill.zip` with the `anylist-meal-planning/` folder at the zip root.
 */
const skillDir = fileURLToPath(new URL('.', import.meta.url));
const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const zipPath = join(distDir, 'anylist-meal-planning-skill.zip');

await mkdir(distDir, { recursive: true });
// `zip` adds to an existing archive, so a stale file from an old build would stay in it.
await rm(zipPath, { force: true });
// -X leaves out extra file attributes, so the same files make the same zip.
await execFileAsync('zip', ['-r', '-X', '-q', zipPath, 'anylist-meal-planning'], { cwd: skillDir });
const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath]);
process.stdout.write(`Built ${zipPath}\n${stdout}`);
