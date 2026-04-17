import { setup, assign } from 'xstate';

// Replicata runtime state machine. Mirrors specs/replicata-machine.qnt.
//
// Top-level: initializing → connected ↔ disconnected ↔ fatal
//
// Inside `connected`, two regions in parallel:
//   - wiring (sequential, 8 states) — captures the assignment progression.
//     `Ready` is the "fully wired, both apps live" state.
//   - stream (sequential, 4 states) — buffer + replay lifecycle. Independent
//     of my-app status (buffer fills whenever real is live).
//
// Guards mirror the spec:
//   - streamStart only fires when real is "live" (post-install).
//   - myPull only fires when wiring == Ready.
//   - assignReal only enabled in Unwired or MyOnly.
//   - assignMy only enabled in Unwired or RealOnly.
//
// Failure semantics:
//   - realFailed resets stream (no source).
//   - unassignReal resets stream.
//   - unassignMy keeps stream (buffer is still valid).
//   - chromeDisconnected resets everything (xstate parent-state exit).

export interface ReplicataContext {
  realAppTargetId: string | null;
  realAppUrl: string | null;
  myAppTargetId: string | null;
  myAppUrl: string | null;
  lastError: string | null;
}

export type ReplicataEvent =
  | { type: 'CDP_CONNECTED' }
  | { type: 'CDP_FATAL'; reason: string }
  | { type: 'CHROME_DISCONNECTED' }
  | { type: 'CHROME_RECONNECTED' }
  | { type: 'ASSIGN_REAL'; targetId: string }
  | { type: 'REAL_INSTALLED'; url: string }
  | { type: 'REAL_FAILED'; reason: string }
  | { type: 'UNASSIGN_REAL'; reason?: string }
  | { type: 'ASSIGN_MY'; targetId: string }
  | { type: 'MY_INSTALLED'; url: string }
  | { type: 'MY_FAILED'; reason: string }
  | { type: 'UNASSIGN_MY'; reason?: string }
  | { type: 'REAL_STREAM_START' }
  | { type: 'REAL_STREAM_END' }
  | { type: 'MY_PULL' }
  | { type: 'REPLAY_END' };

export const replicataMachine = setup({
  types: {
    context: {} as ReplicataContext,
    events: {} as ReplicataEvent,
  },
  actions: {
    captureRealTarget: assign({
      realAppTargetId: ({ event }) => (event as any).targetId ?? null,
      lastError: null,
    }),
    captureRealUrl: assign({
      realAppUrl: ({ event }) => (event as any).url ?? null,
    }),
    clearRealApp: assign({ realAppTargetId: null, realAppUrl: null }),
    captureMyTarget: assign({
      myAppTargetId: ({ event }) => (event as any).targetId ?? null,
      lastError: null,
    }),
    captureMyUrl: assign({
      myAppUrl: ({ event }) => (event as any).url ?? null,
    }),
    clearMyApp: assign({ myAppTargetId: null, myAppUrl: null }),
    setError: assign({ lastError: ({ event }) => (event as any).reason ?? null }),
    clearError: assign({ lastError: null }),
  },
}).createMachine({
  id: 'replicata',
  initial: 'initializing',
  context: {
    realAppTargetId: null,
    realAppUrl: null,
    myAppTargetId: null,
    myAppUrl: null,
    lastError: null,
  },
  states: {
    initializing: {
      on: {
        CDP_CONNECTED: { target: 'connected' },
        CDP_FATAL: { target: 'fatal', actions: 'setError' },
      },
    },

    connected: {
      type: 'parallel',
      on: {
        CHROME_DISCONNECTED: {
          target: 'disconnected',
          actions: ['clearRealApp', 'clearMyApp'],
        },
      },
      states: {
        wiring: {
          initial: 'unwired',
          states: {
            unwired: {
              on: {
                ASSIGN_REAL: { target: 'installingReal', actions: 'captureRealTarget' },
                ASSIGN_MY: { target: 'installingMy', actions: 'captureMyTarget' },
              },
            },
            installingReal: {
              on: {
                REAL_INSTALLED: { target: 'realOnly', actions: 'captureRealUrl' },
                REAL_FAILED: { target: 'unwired', actions: ['clearRealApp', 'setError'] },
                UNASSIGN_REAL: { target: 'unwired', actions: 'clearRealApp' },
              },
            },
            installingMy: {
              on: {
                MY_INSTALLED: { target: 'myOnly', actions: 'captureMyUrl' },
                MY_FAILED: { target: 'unwired', actions: ['clearMyApp', 'setError'] },
                UNASSIGN_MY: { target: 'unwired', actions: 'clearMyApp' },
              },
            },
            realOnly: {
              on: {
                ASSIGN_MY: { target: 'installingMyAfterReal', actions: 'captureMyTarget' },
                UNASSIGN_REAL: { target: 'unwired', actions: 'clearRealApp' },
              },
            },
            myOnly: {
              on: {
                ASSIGN_REAL: { target: 'installingRealAfterMy', actions: 'captureRealTarget' },
                UNASSIGN_MY: { target: 'unwired', actions: 'clearMyApp' },
              },
            },
            installingMyAfterReal: {
              on: {
                MY_INSTALLED: { target: 'ready', actions: 'captureMyUrl' },
                MY_FAILED: { target: 'realOnly', actions: ['clearMyApp', 'setError'] },
                UNASSIGN_MY: { target: 'realOnly', actions: 'clearMyApp' },
                UNASSIGN_REAL: { target: 'installingMy', actions: 'clearRealApp' },
              },
            },
            installingRealAfterMy: {
              on: {
                REAL_INSTALLED: { target: 'ready', actions: 'captureRealUrl' },
                REAL_FAILED: { target: 'myOnly', actions: ['clearRealApp', 'setError'] },
                UNASSIGN_REAL: { target: 'myOnly', actions: 'clearRealApp' },
                UNASSIGN_MY: { target: 'installingReal', actions: 'clearMyApp' },
              },
            },
            ready: {
              on: {
                UNASSIGN_REAL: { target: 'myOnly', actions: 'clearRealApp' },
                UNASSIGN_MY: { target: 'realOnly', actions: 'clearMyApp' },
              },
            },
          },
        },

        stream: {
          initial: 'idle',
          // Cross-region invariants (streamStart only when realLive,
          // myPull only when Ready) are enforced upstream by the runtime
          // — events are only sent from sources that already require those
          // conditions. The Quint spec (specs/replicata-machine.qnt) proves the
          // safety; this region trusts the source.
          on: {
            REAL_FAILED: { target: '.idle' },
            UNASSIGN_REAL: { target: '.idle' },
          },
          states: {
            idle: {
              on: { REAL_STREAM_START: 'buffering' },
            },
            buffering: {
              on: {
                REAL_STREAM_END: 'buffered',
                MY_PULL: 'replaying',
              },
            },
            buffered: {
              on: {
                MY_PULL: 'replaying',
                REAL_STREAM_START: 'buffering',
              },
            },
            replaying: {
              on: {
                REPLAY_END: 'idle',
                REAL_STREAM_START: 'buffering',
              },
            },
          },
        },
      },
    },

    disconnected: {
      on: {
        CHROME_RECONNECTED: { target: 'connected' },
        CDP_FATAL: { target: 'fatal', actions: 'setError' },
      },
    },

    fatal: {
      on: {
        CHROME_RECONNECTED: { target: 'connected', actions: 'clearError' },
      },
    },
  },
});

// ===== Snapshot helpers =====

export type Wiring =
  | 'unwired'
  | 'installingReal'
  | 'installingMy'
  | 'realOnly'
  | 'myOnly'
  | 'installingMyAfterReal'
  | 'installingRealAfterMy'
  | 'ready';

export type Stream = 'idle' | 'buffering' | 'buffered' | 'replaying';

export interface ReplicataStateSnapshot {
  global: 'initializing' | 'connected' | 'disconnected' | 'fatal';
  wiring: Wiring | null;
  stream: Stream | null;
  ready: boolean;
  context: ReplicataContext;
}

const REAL_LIVE: Wiring[] = ['realOnly', 'installingMyAfterReal', 'ready'];

export function snapshotValue(value: unknown, context: ReplicataContext): ReplicataStateSnapshot {
  if (typeof value === 'string') {
    return {
      global: value as ReplicataStateSnapshot['global'],
      wiring: null,
      stream: null,
      ready: false,
      context,
    };
  }
  if (value && typeof value === 'object' && 'connected' in (value as any)) {
    const inner = (value as any).connected as { wiring: Wiring; stream: Stream };
    return {
      global: 'connected',
      wiring: inner.wiring,
      stream: inner.stream,
      ready: inner.wiring === 'ready',
      context,
    };
  }
  return {
    global: 'initializing',
    wiring: null,
    stream: null,
    ready: false,
    context,
  };
}

