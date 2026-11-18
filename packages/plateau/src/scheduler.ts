// Transaction scheduling per database: a transaction starts once every earlier unfinished
// transaction whose scope overlaps it is finished, unless both are readonly. Each tab orders its
// own transactions; the leader tab orders them again with every other tab's (`RemoteTx` in
// runtime.ts), so two tabs never run overlapping readwrite transactions at once.

export interface Schedulable {
  readonly mode: IDBTransactionMode;
  _scope: string[];
  _started: boolean;
  _state: string;
  _start(): void;
}

class Scheduler {
  live: Schedulable[] = [];

  add(tx: Schedulable): void {
    this.live.push(tx);
    this.pump();
  }

  done(tx: Schedulable): void {
    const i = this.live.indexOf(tx);
    if (i >= 0) this.live.splice(i, 1);
    this.pump();
  }

  pump(): void {
    for (let i = 0; i < this.live.length; i++) {
      const tx = this.live[i];
      if (tx._started || tx._state === "finished") continue;
      let ok = true;
      for (let j = 0; j < i && ok; j++) {
        const t = this.live[j];
        if (t._state === "finished") continue;
        const both = t.mode === "readonly" && tx.mode === "readonly";
        if (!both && t._scope.some((s) => tx._scope.includes(s))) ok = false;
      }
      if (ok) tx._start();
    }
  }
}

const schedulers = new Map<string, Scheduler>();

export function scheduler(name: string): Scheduler {
  let s = schedulers.get(name);
  if (!s) schedulers.set(name, (s = new Scheduler()));
  return s;
}
