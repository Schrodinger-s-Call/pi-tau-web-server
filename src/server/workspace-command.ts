import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { PI_COMMAND } from './config.js';
import { readFrames, workspaceEnv, type Workspace } from './workspaces.js';
import { validateControl } from './workspace-protocol.js';

/** Metadata never substitutes for draining stdout and observing the child close. */
export function workspaceCommand(workspace: Workspace, kind: 'models' | 'export', args: string[]): Promise<{ stdout: string; run: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(PI_COMMAND, args, { cwd: workspace.paths.files, env: workspaceEnv(workspace), stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let started: any;
    let completed: any;
    let failure: Error | undefined;
    let output = '';
    let bytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
      killTimer.unref();
    };
    const startup = setTimeout(() => fail(new Error('Pi command startup timed out')), 130000);
    const total = setTimeout(() => fail(new Error('Pi command timed out')), 260000);
    child.stdin.end();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16 * 1024 * 1024) return fail(new Error('Pi command output is too large'));
      output += chunk;
    });
    child.stderr.resume();
    child.on('error', () => fail(new Error('Pi command could not start')));
    readFrames(child.stdio[3] as Readable, frame => {
      validateControl(frame);
      if (frame.type === 'error') return fail(Object.assign(new Error(frame.message), { code: frame.code }));
      if (frame.workspace_id !== workspace.workspace_id || frame.kind !== kind) return fail(new Error('Pi command metadata does not match'));
      if (frame.type === 'started' && !started) {
        started = frame;
        clearTimeout(startup);
      } else if (frame.type === 'completed' && started && !completed && frame.run_id === started.run_id && JSON.stringify(frame.actual_bundle) === JSON.stringify(started.actual_bundle)) completed = frame;
      else fail(new Error('Unexpected Pi command metadata'));
    }, fail);
    child.on('close', code => {
      clearTimeout(startup); clearTimeout(total); if (killTimer) clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (!started || !completed || code !== completed.exit_code || code !== 0) reject(new Error('Pi command failed or did not report completion'));
      else resolve({ stdout: output, run: { ...started, ...completed } });
    });
  });
}
