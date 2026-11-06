import { bridgeQuery } from './workspaces.js';

export type Identity = { session_id: string; session_file: string };
const same = (a: Identity, b: Identity) => a.session_id === b.session_id && a.session_file === b.session_file;
const pause = (ms: number, unref = false) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); if (unref) timer.unref(); });

/** Only acknowledged updates advance the sequence stored by the runtime. */
export class RunIdentity {
  private sequence = 0;
  private queue: Identity[] = [];
  private sending?: Promise<void>;
  private last?: Identity;
  private stopped = false;
  private failedState = false;
  constructor(readonly runId: string, readonly workspaceId: string, private changed: () => void,
    private failed: (error: Error) => void = () => {}, private validate: (identity: Identity) => void = () => {}) {}
  get pending() { return this.queue.length > 0 || this.failedState; }
  get seq() { return this.sequence; }
  initialize(identity: Identity) { this.last = identity; }
  update(identity: Identity) {
    if (this.stopped || (this.last && same(identity, this.last))) return;
    this.last = identity;
    this.queue.push(identity);
    this.changed();
    void this.flush();
  }
  flush(): Promise<void> {
    if (this.sending) return this.sending;
    if (this.stopped) return Promise.resolve();
    this.sending = this.drain().catch(error => {
      this.failedState = true;
      this.stopped = true;
      this.changed();
      this.failed(error instanceof Error ? error : new Error('Identity synchronization failed'));
    }).finally(() => { this.sending = undefined; });
    return this.sending;
  }
  private async drain() {
    while (this.queue.length && !this.stopped) {
      const next = this.queue[0];
      // New histories may not reach disk until Pi writes its first entry.
      for (;;) {
        if (this.stopped) return;
        try { this.validate(next); break; } catch (error: any) {
          if (error.code !== 'ENOENT') throw error;
          await pause(200, true);
        }
      }
      const seq = this.sequence + 1;
      let acknowledged = false;
      let failure: unknown;
      for (let attempt = 0; attempt < 3 && !this.stopped; attempt++) {
        if (attempt) await pause(attempt === 1 ? 200 : 500);
        try {
          const reply = await bridgeQuery({ type: 'session-update', run_id: this.runId, workspace_id: this.workspaceId, seq, ...next });
          if (reply.run_id !== this.runId || reply.workspace_id !== this.workspaceId || reply.seq !== seq || !same(reply, next)) throw new Error('Invalid identity acknowledgement');
          acknowledged = true;
          break;
        } catch (error: any) {
          failure = error;
          if (error.code && !['QUERY_TIMEOUT', 'SOCKET_UNAVAILABLE'].includes(error.code)) break;
        }
      }
      if (this.stopped) return;
      if (!acknowledged) {
        const { run } = await bridgeQuery({ type: 'run-info', run_id: this.runId });
        if (run.run_id !== this.runId || run.workspace_id !== this.workspaceId || run.seq !== seq || !same(run, next)) throw failure || new Error('Run identity could not be confirmed');
        if (run.state !== 'running' && this.queue.length > 1) throw new Error('Run is no longer active');
      }
      this.sequence = seq;
      this.queue.shift();
      this.changed();
    }
  }
  stop() { this.stopped = true; }
}
