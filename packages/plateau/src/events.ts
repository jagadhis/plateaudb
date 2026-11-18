// Events for the API's objects: requests, transactions, databases. The browser's EventTarget
// cannot dispatch along IndexedDB's path (request, then transaction, then database), so these
// targets dispatch their own, with capture, target and bubble phases, `on<type>` handlers in
// registration order, and `preventDefault` / `stopPropagation`.

export class PlateauEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly isTrusted = true;
  target: PlateauTarget | null = null;
  currentTarget: PlateauTarget | null = null;
  eventPhase = 0;
  defaultPrevented = false;
  /** @internal */ stopped = false;
  /** @internal */ stoppedNow = false;

  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean } = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.stopped = true;
  }

  stopImmediatePropagation(): void {
    this.stopped = true;
    this.stoppedNow = true;
  }

  get timeStamp(): number {
    return performance.now();
  }

  get cancelBubble(): boolean {
    return this.stopped;
  }

  get returnValue(): boolean {
    return !this.defaultPrevented;
  }
}

export class PlateauVersionChangeEvent extends PlateauEvent {
  readonly oldVersion: number;
  readonly newVersion: number | null;

  constructor(type: string, init: { oldVersion?: number; newVersion?: number | null } = {}) {
    super(type);
    this.oldVersion = init.oldVersion ?? 0;
    this.newVersion = init.newVersion ?? null;
  }
}

type Listener = ((e: any) => unknown) | { handleEvent(e: any): unknown };

interface Entry {
  type: string;
  capture: boolean;
  once: boolean;
  /** A listener, or the name of an `on<type>` slot. */
  fn: Listener | null;
  slot?: string;
  removed?: boolean;
}

/** Outcome of a dispatch: whether a listener threw. */
export interface Dispatched {
  threw: boolean;
}

export class PlateauTarget {
  /** @internal */ private entries: Entry[] | null = null;
  /** @internal */ private slots: Record<string, ((e: any) => unknown) | null> | null = null;

  /** @internal The next target on the bubble path. */
  parentTarget(): PlateauTarget | null {
    return null;
  }

  addEventListener(type: string, fn: Listener | null, opts?: boolean | { capture?: boolean; once?: boolean }): void {
    if (!fn) return;
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    const once = typeof opts === "object" && !!opts?.once;
    this.entries ??= [];
    if (this.entries.some((e) => !e.removed && e.type === type && e.fn === fn && e.capture === capture)) return;
    this.entries.push({ type, capture, once, fn });
  }

  removeEventListener(type: string, fn: Listener | null, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    if (!this.entries) return;
    const i = this.entries.findIndex((e) => !e.removed && e.type === type && e.fn === fn && e.capture === capture);
    if (i >= 0) {
      this.entries[i].removed = true;
      this.entries.splice(i, 1);
    }
  }

  /** @internal Reads an `on<type>` handler. */
  protected getHandler(type: string): ((e: any) => unknown) | null {
    return this.slots?.[type] ?? null;
  }

  /** @internal Sets an `on<type>` handler; the first non-null value takes a place in the listener
   * order, as the DOM's event handler attributes do. */
  protected setHandler(type: string, fn: unknown): void {
    const f = typeof fn === "function" ? (fn as (e: any) => unknown) : null;
    this.entries ??= [];
    this.slots ??= {};
    if (f) {
      let has = false;
      for (const e of this.entries) if (e.slot === type) has = true;
      if (!has) this.entries.push({ type, capture: false, once: false, fn: null, slot: type });
    } else {
      const i = this.entries.findIndex((e) => e.slot === type);
      if (i >= 0) {
        this.entries[i].removed = true;
        this.entries.splice(i, 1);
      }
    }
    this.slots[type] = f;
  }

  /** @internal Whether anything listens here (for any event type). */
  hasListeners(): boolean {
    return this.entries !== null && this.entries.length > 0;
  }

  /** @internal Whether a listener for `type` would run here when an event passes on its way to a
   * descendant: a capture listener, or any listener if the event bubbles. */
  listensOnPath(type: string, bubbles: boolean): boolean {
    const entries = this.entries;
    if (entries === null) return false;
    for (const e of entries) if (e.type === type && (bubbles || e.capture)) return true;
    return false;
  }

  dispatchEvent(e: PlateauEvent): boolean {
    dispatch(this, e);
    return !e.defaultPrevented;
  }

  /** @internal */
  invoke(e: PlateauEvent, phase: "capture" | "target" | "bubble", out: Dispatched): void {
    const entries = this.entries;
    if (entries === null || entries.length === 0) return;
    // One listener for this type (a request's on-handler, typically): call it without a snapshot.
    let only: Entry | null = null;
    let matches = 0;
    for (const x of entries) {
      if (x.type === e.type) {
        matches++;
        only = x;
      }
    }
    if (matches === 0) return;
    if (matches !== 1) only = null;
    if (only !== null && only.slot !== undefined && phase !== "capture") {
      const fn = this.slots![only.slot];
      if (fn) {
        try {
          fn.call(this, e);
        } catch (err) {
          out.threw = true;
          report(err);
        }
      }
      return;
    }
    const list = entries.filter((x) => x.type === e.type && (phase === "target" || x.capture === (phase === "capture")));
    for (const x of list) {
      if (x.removed) continue;
      if (x.once) this.removeEventListener(x.type, x.fn, x.capture);
      const fn = x.slot ? this.slots![x.slot] : x.fn;
      if (!fn) continue;
      try {
        if (typeof fn === "function") fn.call(this, e);
        else fn.handleEvent(e);
      } catch (err) {
        out.threw = true;
        report(err);
      }
      if (e.stoppedNow) break;
    }
  }
}

function report(err: unknown): void {
  const g = globalThis as { reportError?: (e: unknown) => void };
  if (g.reportError) g.reportError(err);
  else setTimeout(() => {
    throw err;
  });
}

/** Dispatches `e` at `target` along its parent path. */
export function dispatch(target: PlateauTarget, e: PlateauEvent): Dispatched {
  const p1 = target.parentTarget();
  const p2 = p1 === null ? null : p1.parentTarget();
  if ((p2 === null || p2.parentTarget() === null) && (p1 === null || !p1.listensOnPath(e.type, e.bubbles)) && (p2 === null || !p2.listensOnPath(e.type, e.bubbles))) {
    // Nothing listens on the path: the target phase only.
    const out: Dispatched = { threw: false };
    e.target = target;
    e.eventPhase = 2;
    e.currentTarget = target;
    target.invoke(e, "target", out);
    e.eventPhase = 0;
    e.currentTarget = null;
    return out;
  }
  const path: PlateauTarget[] = [];
  for (let t: PlateauTarget | null = target.parentTarget(); t; t = t.parentTarget()) path.push(t);
  const out: Dispatched = { threw: false };
  e.target = target;
  e.eventPhase = 1;
  for (let i = path.length - 1; i >= 0 && !e.stopped; i--) {
    e.currentTarget = path[i];
    path[i].invoke(e, "capture", out);
  }
  if (!e.stopped) {
    e.eventPhase = 2;
    e.currentTarget = target;
    target.invoke(e, "target", out);
  }
  if (e.bubbles) {
    e.eventPhase = 3;
    for (let i = 0; i < path.length && !e.stopped; i++) {
      e.currentTarget = path[i];
      path[i].invoke(e, "bubble", out);
    }
  }
  e.eventPhase = 0;
  e.currentTarget = null;
  return out;
}

/** Defines `on<type>` accessors on a target class. */
export function handlers(cls: { prototype: PlateauTarget }, types: string[]): void {
  for (const type of types) {
    Object.defineProperty(cls.prototype, `on${type}`, {
      get(this: PlateauTarget) {
        return (this as unknown as { getHandler(t: string): unknown }).getHandler(type);
      },
      set(this: PlateauTarget, fn: unknown) {
        (this as unknown as { setHandler(t: string, f: unknown): void }).setHandler(type, fn);
      },
      configurable: true,
      enumerable: true,
    });
  }
}
