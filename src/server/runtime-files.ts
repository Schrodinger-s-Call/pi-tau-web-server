import path from 'node:path';
import type { PiRpcSession } from './sessions.js';
import { bridgeQuery, workspaceFiles, type Workspace } from './workspaces.js';

export const RUNTIME_FILES = ['AGENTS.md', 'RUNTIME.json'] as const;
export type RuntimeFileName = typeof RUNTIME_FILES[number];

export function runtimeFileName(workspace: Workspace, input: string): RuntimeFileName | null {
  const relative = path.relative(workspace.paths.files, workspaceFiles(workspace, input, true));
  return RUNTIME_FILES.includes(relative as RuntimeFileName) ? relative as RuntimeFileName : null;
}

export async function readRuntimeFile(session: PiRpcSession | undefined, name: RuntimeFileName) {
  const active = () => session?.workspace && session.run && !session.terminating && session.child?.exitCode === null && !session.child.signalCode;
  if (!active() || !session?.workspace || !session.run) throw new Error('Runtime file unavailable: an active Pi run is required');
  if (session.identityPending) throw new Error('Runtime file unavailable: session identity synchronization is pending');
  const run = session.run;
  const child = session.child;
  const workspace = session.workspace;
  let frame;
  try {
    frame = await bridgeQuery({ type: 'run-file', run_id: run.run_id, workspace_id: workspace.workspace_id, name });
  } catch (error: any) {
    if (error.code === 'PROTOCOL_ERROR') throw new Error('Runtime file unavailable: run_tau does not support run-file or returned an invalid response');
    throw new Error(`Runtime file unavailable: ${error.message}`);
  }
  if (!active() || session.child !== child || session.run !== run || session.workspace !== workspace || session.identityPending) throw new Error('Runtime file unavailable: the Pi run changed or stopped during the read');
  const bundle = frame.actual_bundle;
  if (frame.run_id !== run.run_id || frame.workspace_id !== workspace.workspace_id || frame.name !== name ||
      bundle.name !== run.actual_bundle.name || bundle.sha256 !== run.actual_bundle.sha256 || bundle.commit !== run.actual_bundle.commit) {
    throw new Error('Runtime file unavailable: response does not match the selected Pi run');
  }
  const bytes = Buffer.from(frame.content_base64, 'base64');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { bytes, text, run_id: run.run_id, workspace_id: workspace.workspace_id, runtime_readonly: true, name };
}
