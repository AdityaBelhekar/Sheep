/**
 * Runs the acceptance run: a real research question, end to end, on the model
 * connections saved in this copy of Sheep.
 *
 *   npm run acceptance -- --question "Does X hold?" [--cap 2] [--models a,b,c] [--out dir]
 *   npm run acceptance -- --question "Does X hold?" --dry-run
 *
 * A real run calls real models and spends real money, up to the cap. A dry
 * run chooses the roster, prints the plan and stops.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import electronBinary from 'electron';

const flags = process.argv.slice(2);
const value = (name) => {
  const index = flags.indexOf(`--${name}`);
  return index === -1 ? undefined : flags[index + 1];
};

const env = { ...process.env, SHEEP_ACCEPTANCE: '1' };
const set = (key, text) => {
  if (text !== undefined) env[key] = text;
};
set('SHEEP_ACCEPTANCE_QUESTION', value('question'));
set('SHEEP_ACCEPTANCE_CAP', value('cap'));
set('SHEEP_ACCEPTANCE_MODELS', value('models'));
set('SHEEP_ACCEPTANCE_OUT', value('out'));
if (flags.includes('--dry-run')) env.SHEEP_ACCEPTANCE_DRY_RUN = '1';

const child = spawn(electronBinary, ['.'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (chunk) => process.stdout.write(chunk));
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
