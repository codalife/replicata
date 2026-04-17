// Quint specification of replicata's runtime state machine.
//
// Sequential `wiring` state inside `connected`: encodes the assignment
// progression as named states (Unwired → InstallingReal → RealOnly →
// InstallingMyAfterReal → Ready, plus mirror branches for my-first
// ordering). `stream` runs in parallel inside `connected`, since the
// real app can stream into the buffer regardless of my-app's status.
//
// `Ready` is a real state — corresponds to "both regions live and the
// user can practice end-to-end."
//
// Run:
//   quint typecheck specs/replicata-machine.qnt
//   quint test      specs/replicata-machine.qnt
//   quint run       specs/replicata-machine.qnt --invariant=allInvariants --max-steps=30 --max-samples=500

module replicataMachine {

  // ===== Types =====

  type GlobalState =
    | Initializing
    | Connected
    | Disconnected
    | Fatal

  // Wiring lives inside Connected. Sequential.
  type Wiring =
    | Unwired
    | InstallingReal               // real assigned, my unassigned, real install in flight
    | InstallingMy                 // my assigned, real unassigned, my install in flight
    | RealOnly                     // real live, my unassigned
    | MyOnly                       // my live, real unassigned
    | InstallingMyAfterReal        // real live, my install in flight
    | InstallingRealAfterMy        // my live, real install in flight
    | Ready                        // both live — user can practice

  type StreamState =
    | StreamIdle
    | Buffering
    | Buffered
    | Replaying

  type OptStr =
    | Some(str)
    | None

  // ===== State =====

  var global: GlobalState
  var wiring: Wiring
  var stream: StreamState

  var realTargetId: OptStr
  var realUrl: OptStr
  var myTargetId: OptStr
  var myUrl: OptStr
  var lastError: OptStr

  pure val TARGET_IDS = Set("t-real", "t-my", "t-other")
  pure val URLS = Set("https://chatgpt.com/c/abc", "http://localhost:5173")
  pure val ERRORS = Set("tab not found", "not a local url", "install failed")

  // ===== Derived predicates (handy for tests + invariants) =====

  pure def realLive(w: Wiring): bool =
    w == RealOnly or w == InstallingMyAfterReal or w == Ready

  pure def myLive(w: Wiring): bool =
    w == MyOnly or w == InstallingRealAfterMy or w == Ready

  pure def realPresent(w: Wiring): bool =
    realLive(w) or w == InstallingReal or w == InstallingRealAfterMy

  pure def myPresent(w: Wiring): bool =
    myLive(w) or w == InstallingMy or w == InstallingMyAfterReal

  // ===== Init =====

  action init = all {
    global' = Initializing,
    wiring' = Unwired,
    stream' = StreamIdle,
    realTargetId' = None,
    realUrl' = None,
    myTargetId' = None,
    myUrl' = None,
    lastError' = None,
  }

  // Bundled "keep this group unchanged" helpers
  action _keepReal = all {
    realTargetId' = realTargetId,
    realUrl' = realUrl,
  }
  action _keepMy = all {
    myTargetId' = myTargetId,
    myUrl' = myUrl,
  }
  action _keepStream = stream' = stream
  action _keepError = lastError' = lastError
  action _keepGlobal = global' = global
  action _keepWiring = wiring' = wiring

  // ===== Top-level transitions =====

  action cdpConnected: bool = all {
    global == Initializing or global == Disconnected or global == Fatal,
    global' = Connected,
    _keepWiring,
    _keepStream,
    _keepReal,
    _keepMy,
    lastError' = None,
  }

  action cdpFatal(reason: str): bool = all {
    global == Initializing or global == Disconnected,
    global' = Fatal,
    _keepWiring,
    _keepStream,
    _keepReal,
    _keepMy,
    lastError' = Some(reason),
  }

  action chromeDisconnected: bool = all {
    global == Connected,
    global' = Disconnected,
    // Leaving Connected resets all sub-state (XState parallel/compound exit).
    wiring' = Unwired,
    stream' = StreamIdle,
    realTargetId' = None,
    realUrl' = None,
    myTargetId' = None,
    myUrl' = None,
    _keepError,
  }

  // ===== Real-app assignment =====

  action assignReal(id: str): bool = all {
    global == Connected,
    wiring == Unwired or wiring == MyOnly,
    wiring' = if (wiring == Unwired) InstallingReal else InstallingRealAfterMy,
    realTargetId' = Some(id),
    realUrl' = None,
    _keepGlobal,
    _keepStream,
    _keepMy,
    lastError' = None,
  }

  action realInstalled(url: str): bool = all {
    global == Connected,
    wiring == InstallingReal or wiring == InstallingRealAfterMy,
    wiring' = if (wiring == InstallingReal) RealOnly else Ready,
    realUrl' = Some(url),
    realTargetId' = realTargetId,
    _keepGlobal,
    _keepStream,
    _keepMy,
    _keepError,
  }

  action realFailed(reason: str): bool = all {
    global == Connected,
    wiring == InstallingReal or wiring == InstallingRealAfterMy,
    wiring' = if (wiring == InstallingReal) Unwired else MyOnly,
    realTargetId' = None,
    realUrl' = None,
    _keepGlobal,
    // If realInstall fails mid-stream, stream stops (no source).
    stream' = StreamIdle,
    _keepMy,
    lastError' = Some(reason),
  }

  action unassignReal: bool = all {
    global == Connected,
    realPresent(wiring),
    wiring' = if (wiring == InstallingReal or wiring == RealOnly) Unwired
              else if (wiring == InstallingMyAfterReal) InstallingMy
              else if (wiring == Ready) MyOnly
              else if (wiring == InstallingRealAfterMy) MyOnly
              else wiring,
    realTargetId' = None,
    realUrl' = None,
    // Removing real source resets stream.
    stream' = StreamIdle,
    _keepGlobal,
    _keepMy,
    _keepError,
  }

  // ===== My-app assignment =====

  action assignMy(id: str): bool = all {
    global == Connected,
    wiring == Unwired or wiring == RealOnly,
    wiring' = if (wiring == Unwired) InstallingMy else InstallingMyAfterReal,
    myTargetId' = Some(id),
    myUrl' = None,
    _keepGlobal,
    _keepStream,
    _keepReal,
    lastError' = None,
  }

  action myInstalled(url: str): bool = all {
    global == Connected,
    wiring == InstallingMy or wiring == InstallingMyAfterReal,
    wiring' = if (wiring == InstallingMy) MyOnly else Ready,
    myUrl' = Some(url),
    myTargetId' = myTargetId,
    _keepGlobal,
    _keepStream,
    _keepReal,
    _keepError,
  }

  action myFailed(reason: str): bool = all {
    global == Connected,
    wiring == InstallingMy or wiring == InstallingMyAfterReal,
    wiring' = if (wiring == InstallingMy) Unwired else RealOnly,
    myTargetId' = None,
    myUrl' = None,
    _keepGlobal,
    _keepStream,
    _keepReal,
    lastError' = Some(reason),
  }

  action unassignMy: bool = all {
    global == Connected,
    myPresent(wiring),
    wiring' = if (wiring == InstallingMy or wiring == MyOnly) Unwired
              else if (wiring == InstallingRealAfterMy) InstallingReal
              else if (wiring == Ready) RealOnly
              else if (wiring == InstallingMyAfterReal) RealOnly
              else wiring,
    myTargetId' = None,
    myUrl' = None,
    _keepGlobal,
    // Removing my-app does NOT reset stream — buffer can still fill.
    _keepStream,
    _keepReal,
    _keepError,
  }

  // ===== Stream =====

  // Real app can stream the moment its tap is live — i.e. whenever realLive(wiring).
  // Buffer fills regardless of my-app status.
  action streamStart: bool = all {
    global == Connected,
    realLive(wiring),
    stream' = Buffering,
    _keepGlobal,
    _keepWiring,
    _keepReal,
    _keepMy,
    _keepError,
  }

  action streamEnd: bool = all {
    global == Connected,
    stream == Buffering,
    stream' = Buffered,
    _keepGlobal,
    _keepWiring,
    _keepReal,
    _keepMy,
    _keepError,
  }

  // Pulling requires my-app to be live (renderer-redirect is installed).
  action myPull: bool = all {
    global == Connected,
    wiring == Ready,
    stream == Buffered or stream == Buffering,
    stream' = Replaying,
    _keepGlobal,
    _keepWiring,
    _keepReal,
    _keepMy,
    _keepError,
  }

  action replayEnd: bool = all {
    global == Connected,
    stream == Replaying,
    stream' = StreamIdle,
    _keepGlobal,
    _keepWiring,
    _keepReal,
    _keepMy,
    _keepError,
  }

  // ===== Step (nondet) =====

  action step = any {
    cdpConnected,
    nondet r = ERRORS.oneOf() { cdpFatal(r) },
    chromeDisconnected,
    nondet i = TARGET_IDS.oneOf() { assignReal(i) },
    nondet u = URLS.oneOf() { realInstalled(u) },
    nondet r = ERRORS.oneOf() { realFailed(r) },
    unassignReal,
    nondet i = TARGET_IDS.oneOf() { assignMy(i) },
    nondet u = URLS.oneOf() { myInstalled(u) },
    nondet r = ERRORS.oneOf() { myFailed(r) },
    unassignMy,
    streamStart,
    streamEnd,
    myPull,
    replayEnd,
  }

  // ===== Invariants =====

  // L1: any non-Unwired wiring requires Connected
  val wiredImpliesConnected =
    (wiring != Unwired) implies (global == Connected)

  // L2: Ready requires both URLs and target IDs
  val readyHasBothEndpoints =
    (wiring == Ready) implies all {
      realTargetId != None,
      realUrl != None,
      myTargetId != None,
      myUrl != None,
    }

  // L3: realLive ⇒ realTargetId/Url present; realPresent ⇒ realTargetId
  val realLiveHasUrl =
    realLive(wiring) implies (realUrl != None and realTargetId != None)
  val realPresentHasTarget =
    realPresent(wiring) implies (realTargetId != None)

  // L4: myLive ⇒ myTargetId/Url present
  val myLiveHasUrl =
    myLive(wiring) implies (myUrl != None and myTargetId != None)
  val myPresentHasTarget =
    myPresent(wiring) implies (myTargetId != None)

  // L5: when real is absent, no real target/url linger
  val realAbsentClean =
    not(realPresent(wiring)) implies (realTargetId == None and realUrl == None)
  val myAbsentClean =
    not(myPresent(wiring)) implies (myTargetId == None and myUrl == None)

  // L6: stream activity requires real to be live (tap is the source)
  val streamRequiresRealLive =
    (stream != StreamIdle) implies realLive(wiring)

  // L7: replaying requires my-app live (renderer-redirect injected)
  val replayingRequiresReady =
    (stream == Replaying) implies (wiring == Ready)

  // L8: fatal has an error and no live regions
  val fatalHasError =
    (global == Fatal) implies (lastError != None)
  val fatalNoWiring =
    (global == Fatal) implies (wiring == Unwired and stream == StreamIdle)

  // L9: disconnected resets everything
  val disconnectedClean =
    (global == Disconnected) implies all {
      wiring == Unwired,
      stream == StreamIdle,
      realTargetId == None,
      myTargetId == None,
    }

  val allInvariants = and {
    wiredImpliesConnected,
    readyHasBothEndpoints,
    realLiveHasUrl,
    realPresentHasTarget,
    myLiveHasUrl,
    myPresentHasTarget,
    realAbsentClean,
    myAbsentClean,
    streamRequiresRealLive,
    replayingRequiresReady,
    fatalHasError,
    fatalNoWiring,
    disconnectedClean,
  }

  // ===== Tests =====

  // -- Happy paths --

  run happyPath_realFirst =
    init
      .then(cdpConnected)
      .then(assignReal("t-real"))
      .expect(wiring == InstallingReal)
      .then(realInstalled("https://chatgpt.com/c/abc"))
      .expect(wiring == RealOnly)
      .then(assignMy("t-my"))
      .expect(wiring == InstallingMyAfterReal)
      .then(myInstalled("http://localhost:5173"))
      .expect(wiring == Ready)
      .then(streamStart)
      .then(streamEnd)
      .then(myPull)
      .then(replayEnd)
      .expect(all {
        wiring == Ready,
        stream == StreamIdle,
        realUrl == Some("https://chatgpt.com/c/abc"),
        myUrl == Some("http://localhost:5173"),
      })

  run happyPath_myFirst =
    // Order independence — assigning my-app first reaches Ready too.
    init
      .then(cdpConnected)
      .then(assignMy("t-my"))
      .expect(wiring == InstallingMy)
      .then(myInstalled("http://localhost:5173"))
      .expect(wiring == MyOnly)
      .then(assignReal("t-real"))
      .expect(wiring == InstallingRealAfterMy)
      .then(realInstalled("https://chatgpt.com/c/abc"))
      .expect(wiring == Ready)

  // -- Failure recovery --

  run installFailRecovers =
    init
      .then(cdpConnected)
      .then(assignReal("t-real"))
      .then(realFailed("tab not found"))
      .expect(all {
        wiring == Unwired,
        realTargetId == None,
        realUrl == None,
        lastError == Some("tab not found"),
      })
      .then(assignReal("t-real"))
      .expect(wiring == InstallingReal)

  run myFailFromAfterReal =
    init
      .then(cdpConnected)
      .then(assignReal("t-real"))
      .then(realInstalled("https://chatgpt.com/c/abc"))
      .then(assignMy("t-my"))
      .then(myFailed("not a local url"))
      .expect(all {
        wiring == RealOnly,         // we land back in RealOnly, not Unwired
        realUrl == Some("https://chatgpt.com/c/abc"),
        myTargetId == None,
        lastError == Some("not a local url"),
      })

  // -- Disconnect / reconnect --

  run reconnectClearsEverything =
    init
      .then(cdpConnected)
      .then(assignReal("t-real"))
      .then(realInstalled("https://chatgpt.com/c/abc"))
      .then(assignMy("t-my"))
      .then(myInstalled("http://localhost:5173"))
      .then(streamStart)
      .then(chromeDisconnected)
      .expect(all {
        global == Disconnected,
        wiring == Unwired,
        stream == StreamIdle,
        realTargetId == None,
        myTargetId == None,
      })
      .then(cdpConnected)
      .expect(global == Connected and wiring == Unwired)

  // -- Unassign mid-Ready returns to single-region states --

  run unassignRealFromReady =
    init
      .then(cdpConnected)
      .then(assignReal("t-real")).then(realInstalled("https://chatgpt.com/c/abc"))
      .then(assignMy("t-my")).then(myInstalled("http://localhost:5173"))
      .then(streamStart).then(streamEnd)
      .then(unassignReal)
      .expect(all {
        wiring == MyOnly,             // my-app stays
        myUrl == Some("http://localhost:5173"),
        realTargetId == None,
        stream == StreamIdle,         // stream resets, no source
      })

  run unassignMyFromReady =
    init
      .then(cdpConnected)
      .then(assignReal("t-real")).then(realInstalled("https://chatgpt.com/c/abc"))
      .then(assignMy("t-my")).then(myInstalled("http://localhost:5173"))
      .then(streamStart).then(streamEnd)
      .then(unassignMy)
      .expect(all {
        wiring == RealOnly,
        myTargetId == None,
        stream == Buffered,           // stream KEEPS — buffer is still valid
      })

  // -- Negative tests: actions disabled when guards fail --

  run streamCannotStartWhileUnwired =
    init
      .then(cdpConnected)
      .expect(wiring == Unwired)
      // streamStart's guard requires realLive → fails when Unwired
      .then(streamStart)
      .fail()

  run streamCannotStartWhileInstallingReal =
    init
      .then(cdpConnected)
      .then(assignReal("t-real"))
      .expect(wiring == InstallingReal)
      // realLive is false during install — stream cannot start
      .then(streamStart)
      .fail()

  run myPullRequiresReady =
    init
      .then(cdpConnected)
      .then(assignReal("t-real")).then(realInstalled("https://chatgpt.com/c/abc"))
      .expect(wiring == RealOnly)
      .then(streamStart)
      .then(streamEnd)
      // myPull's guard requires wiring == Ready → fails in RealOnly
      .then(myPull)
      .fail()

  run cannotAssignRealWhileInstalling =
    init
      .then(cdpConnected)
      .then(assignReal("t-real"))
      .then(assignReal("t-other"))     // already InstallingReal — guard fails
      .fail()

  run cannotAssignMyWhileMyOnly =
    init
      .then(cdpConnected)
      .then(assignMy("t-my")).then(myInstalled("http://localhost:5173"))
      .then(assignMy("t-other"))       // already MyOnly — guard fails
      .fail()

  run streamCannotProgressWhenDisconnected =
    init
      .then(cdpConnected)
      .then(assignReal("t-real")).then(realInstalled("https://chatgpt.com/c/abc"))
      .then(streamStart)
      .then(chromeDisconnected)
      .expect(stream == StreamIdle)
      .then(streamStart)               // disconnected — fails
      .fail()

  // -- Buffer survives my-app cycle --

  run streamBuffersBeforeMyArrives =
    init
      .then(cdpConnected)
      .then(assignReal("t-real")).then(realInstalled("https://chatgpt.com/c/abc"))
      .then(streamStart).then(streamEnd)
      .expect(stream == Buffered and wiring == RealOnly)
      .then(assignMy("t-my")).then(myInstalled("http://localhost:5173"))
      .expect(wiring == Ready and stream == Buffered)
      .then(myPull).then(replayEnd)
      .expect(stream == StreamIdle)

  // -- Stream re-cycles after replay --

  run streamReplayCycle =
    init
      .then(cdpConnected)
      .then(assignReal("t-real")).then(realInstalled("https://chatgpt.com/c/abc"))
      .then(assignMy("t-my")).then(myInstalled("http://localhost:5173"))
      .then(streamStart).then(streamEnd).then(myPull).then(replayEnd)
      .then(streamStart)
      .expect(stream == Buffering and wiring == Ready)
}
