export interface Order {
  id: number;
  version: number;
  updatedAt: number;
  editedAt: number;
  total: number;
  status: number;
  title: string;
  customer: string;
}

export interface View {
  count: number;
  rows: Order[];
}

export const TOP = 50;

/** What the page exposes to the measurement script. */
export interface AppProbe {
  mode: "plateau" | "rest";
  /** performance.now() at the first render that showed orders. */
  firstRender: number | null;
  /** performance.now() when the stream first said `ready`, and for a first visit the bulk load behind it finished. */
  caughtUp: number | null;
  /** Epoch ms of the DOM update that first showed each order version, by `id:version`. */
  seen: Map<string, number>;
  /** The leader's stages per `id:version`: event read, order fetched, committed to plateau. */
  stages: Map<string, { event: number; fetched: number; committed: number }>;
  role(): string;
  streamState(): string;
  /** The order count this tab's source reports. */
  stored(): Promise<number>;
  /** Resolves when `id` at `version` or later has been rendered; resolves false at `timeoutMs`. */
  rendered(id: number, version: number, timeoutMs: number): Promise<boolean>;
  /** The versions (id to version) of `ids`, or of every order, in this tab's source: plateau's store. */
  versionsOf(ids: number[] | null): Promise<Record<number, number>>;
  /** Epoch ms each time the stream said `ready`. */
  readies: number[];
  reconnects: number;
  /** Epoch ms each time the stream opened. */
  opened: number[];
  /** Epoch ms each time a stream closed or failed. */
  closed: number[];
}

declare global {
  interface Window {
    app: AppProbe;
  }
}
