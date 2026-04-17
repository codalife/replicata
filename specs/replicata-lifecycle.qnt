// Quint spec modeling the WIRING between physical browser events and
// replicata's runtime machine. Companion to replicata-machine.qnt which
// models the machine in isolation — this one models the machine
// *together with* the nondeterministic physical world (tabs, navigation,
// chrome lifecycle, install promises) so the model checker can catch
// scenarios where machine state drifts from reality.
//
// Faithful to runtime.ts current behavior (2026-04-16):
//   - handleTargetDestroyed: unassign matching tab
//   - handleTargetUrlChanged: unassign real on host change; renderer on
//     leaving localhost
//   - handleChromeDisconnect: send CHROME_DISCONNECTED + clear all refs
//   - install completion: fires REAL_INSTALLED/FAILED (or MY_*) after an
//     async gap during which physical events may have changed the world
//
// Run:
//   quint typecheck specs/replicata-lifecycle.qnt
//   quint run specs/replicata-lifecycle.qnt --invariant=allInvariants \
//        --max-steps=25 --max-samples=5000
//
// Any invariant violation returns a counterexample trace — that trace is
// a real repro script for a wiring drift bug.

module replicataLifecycle {

  // ===== Physical world =====
  //
  // "Tab" abstracts a browser tab; each has a stable id and a current host.
  // Host "gone" marks the tab as destroyed. A tab can navigate to a new
  // host (same-host navigation or cross-host). Only two possible tabs are
  // modeled — one real, one my — to keep the state space tractable.

  type Host =
    | HGone                        // tab destroyed
    | HRealA                       // first real-app host (e.g. chatgpt.com)
    | HRealB                       // second real-app host (e.g. claude.ai)
    | HLocal1                      // localhost:5173
    | HLocal2                      // localhost:3000
    | HOther                       // unrelated host (e.g. navigated away)

  pure def isRealHost(h: Host): bool = h == HRealA or h == HRealB
  pure def isLocalHost(h: Host): bool = h == HLocal1 or h == HLocal2

  // ===== Wiring state (mirror of machine + refs in runtime.ts) =====

  type Wiring =
    | Unwired
    | InstallingReal
    | InstallingMy
    | RealOnly
    | MyOnly
    | InstallingMyAfterReal
    | InstallingRealAfterMy
    | Ready

  type StreamState = | SIdle | SBuffering | SBuffered | SReplaying

  type Global = | Initializing | Connected | Disconnected

  // ===== State =====

  // Physical
  var realTabHost: Host             // HGone if no real tab / destroyed
  var myTabHost: Host               // HGone if no my tab / destroyed
  var chromeAlive: bool

  // Runtime refs (what runtime.ts stores in realAppTargetId / host)
  // "Bound" = runtime has this tab assigned to a role.
  var runtimeBoundReal: bool
  var runtimeBoundMy: bool
  // Host the runtime "thinks" the bound tab is at (its own bookkeeping).
  var runtimeRealHost: Host
  var runtimeMyHost: Host

  // Machine state
  var global: Global
  var wiring: Wiring
  var stream: StreamState

  // Install-in-flight: a real/my install action has been scheduled but not
  // yet committed. Models the async window where physical events can fire
  // between scheduling and commit.
  var installFlightReal: bool
  var installFlightMy: bool

  // Replicata process lifecycle — orthogonal to chrome. Can crash
  // independently; on restart, in-memory state is lost but persisted
  // assignments on disk survive. Used to model cold starts w/ stale
  // assignments.json and restart-after-crash.
  var replicataAlive: bool
  var persistedRealHost: Host       // HGone = no persisted assignment
  var persistedMyHost: Host

  // ===== Init =====

  action init = all {
    realTabHost' = HGone,
    myTabHost' = HGone,
    chromeAlive' = false,
    runtimeBoundReal' = false,
    runtimeBoundMy' = false,
    runtimeRealHost' = HGone,
    runtimeMyHost' = HGone,
    global' = Initializing,
    wiring' = Unwired,
    stream' = SIdle,
    installFlightReal' = false,
    installFlightMy' = false,
    replicataAlive' = false,
    persistedRealHost' = HGone,
    persistedMyHost' = HGone,
  }

  // Bundled keep-helpers
  action _keepPhysical = all {
    realTabHost' = realTabHost,
    myTabHost' = myTabHost,
    chromeAlive' = chromeAlive,
  }
  action _keepRuntime = all {
    runtimeBoundReal' = runtimeBoundReal,
    runtimeBoundMy' = runtimeBoundMy,
    runtimeRealHost' = runtimeRealHost,
    runtimeMyHost' = runtimeMyHost,
  }
  action _keepMachine = all {
    global' = global,
    wiring' = wiring,
    stream' = stream,
  }
  action _keepFlight = all {
    installFlightReal' = installFlightReal,
    installFlightMy' = installFlightMy,
  }
  action _keepReplicata = all {
    replicataAlive' = replicataAlive,
    persistedRealHost' = persistedRealHost,
    persistedMyHost' = persistedMyHost,
  }

  // ===== Physical events (nondet) =====
  //
  // These fire independently of what the machine thinks. They are the
  // source of nondeterminism that the model checker explores.

  action chromeDies: bool = all {
    replicataAlive,
    chromeAlive,
    // In runtime.ts: handleChromeDisconnect clears runtime refs and sends
    // CHROME_DISCONNECTED. Modeled as atomic because the handler runs
    // synchronously when Playwright emits 'disconnected'.
    // Persisted assignments survive — restoreAssignments re-binds on reconnect.
    chromeAlive' = false,
    realTabHost' = HGone,
    myTabHost' = HGone,
    runtimeBoundReal' = false,
    runtimeBoundMy' = false,
    runtimeRealHost' = HGone,
    runtimeMyHost' = HGone,
    global' = Disconnected,
    wiring' = Unwired,
    stream' = SIdle,
    // In-flight installs don't get to commit any result after chrome death.
    installFlightReal' = false,
    installFlightMy' = false,
    replicataAlive' = replicataAlive,
    persistedRealHost' = persistedRealHost,
    persistedMyHost' = persistedMyHost,
  }

  action chromeReconnects: bool = all {
    replicataAlive,
    not(chromeAlive),
    chromeAlive' = true,
    global' = Connected,
    _keepRuntime,
    realTabHost' = realTabHost,
    myTabHost' = myTabHost,
    wiring' = wiring,
    stream' = stream,
    _keepFlight,
    _keepReplicata,
  }

  action tabDestroyReal: bool = all {
    replicataAlive,
    chromeAlive,
    realTabHost != HGone,
    realTabHost' = HGone,
    // Wiring handler: handleTargetDestroyed → unassignReal if bound.
    // NB: if install is in flight, unassignReal drops the flight in the
    // real runtime (we emit UNASSIGN_REAL which resets wiring; the later
    // install resolve is ignored because xstate transitions it away).
    runtimeBoundReal' = if (runtimeBoundReal) false else runtimeBoundReal,
    runtimeRealHost' = if (runtimeBoundReal) HGone else runtimeRealHost,
    wiring' = if (runtimeBoundReal) wiringAfterUnassignReal(wiring) else wiring,
    stream' = if (runtimeBoundReal) SIdle else stream,
    installFlightReal' = false,
    installFlightMy' = installFlightMy,
    myTabHost' = myTabHost,
    chromeAlive' = chromeAlive,
    runtimeBoundMy' = runtimeBoundMy,
    runtimeMyHost' = runtimeMyHost,
    global' = global,
    // tab destruction doesn't unset persisted — user may reopen tab later.
    _keepReplicata,
  }

  action tabDestroyMy: bool = all {
    replicataAlive,
    chromeAlive,
    myTabHost != HGone,
    myTabHost' = HGone,
    runtimeBoundMy' = if (runtimeBoundMy) false else runtimeBoundMy,
    runtimeMyHost' = if (runtimeBoundMy) HGone else runtimeMyHost,
    wiring' = if (runtimeBoundMy) wiringAfterUnassignMy(wiring) else wiring,
    // unassignMy keeps stream unless we were mid-replay — then REPLAY_END
    // fires (runtime.ts unassignRenderer sends it if stream=replaying).
    stream' =
      if (runtimeBoundMy and stream == SReplaying) SIdle
      else stream,
    installFlightMy' = false,
    installFlightReal' = installFlightReal,
    realTabHost' = realTabHost,
    chromeAlive' = chromeAlive,
    runtimeBoundReal' = runtimeBoundReal,
    runtimeRealHost' = runtimeRealHost,
    global' = global,
    _keepReplicata,
  }

  action tabNavigateReal(newHost: Host): bool = all {
    replicataAlive,
    chromeAlive,
    realTabHost != HGone,
    newHost != HGone,
    realTabHost != newHost,                            // actually changing
    realTabHost' = newHost,
    // Wiring handler: unassigns only on cross-host change. Model Hosts are
    // already coarse (one per "host family") so any change = cross-host.
    runtimeBoundReal' = if (runtimeBoundReal) false else runtimeBoundReal,
    runtimeRealHost' = if (runtimeBoundReal) HGone else runtimeRealHost,
    wiring' = if (runtimeBoundReal) wiringAfterUnassignReal(wiring) else wiring,
    stream' = if (runtimeBoundReal) SIdle else stream,
    installFlightReal' = false,
    installFlightMy' = installFlightMy,
    myTabHost' = myTabHost,
    chromeAlive' = chromeAlive,
    runtimeBoundMy' = runtimeBoundMy,
    runtimeMyHost' = runtimeMyHost,
    global' = global,
    _keepReplicata,
  }

  action tabNavigateMy(newHost: Host): bool = all {
    replicataAlive,
    chromeAlive,
    myTabHost != HGone,
    newHost != HGone,
    myTabHost != newHost,
    myTabHost' = newHost,
    // Wiring handler: unassigns when my tab leaves localhost.
    runtimeBoundMy' =
      if (runtimeBoundMy and not(isLocalHost(newHost))) false else runtimeBoundMy,
    runtimeMyHost' =
      if (runtimeBoundMy and not(isLocalHost(newHost))) HGone else runtimeMyHost,
    wiring' =
      if (runtimeBoundMy and not(isLocalHost(newHost))) wiringAfterUnassignMy(wiring)
      else wiring,
    // If my is unassigning and stream was replaying, end the replay.
    stream' =
      if (runtimeBoundMy and not(isLocalHost(newHost)) and stream == SReplaying) SIdle
      else stream,
    installFlightMy' =
      if (runtimeBoundMy and not(isLocalHost(newHost))) false else installFlightMy,
    installFlightReal' = installFlightReal,
    realTabHost' = realTabHost,
    chromeAlive' = chromeAlive,
    runtimeBoundReal' = runtimeBoundReal,
    runtimeRealHost' = runtimeRealHost,
    global' = global,
    _keepReplicata,
  }

  // ===== User / UI actions that kick off a flow =====

  // Spawning a tab (new real or my app opened by user in chrome).
  // Tabs can spawn while replicata is down (Chrome is independent).
  action spawnRealTab(h: Host): bool = all {
    chromeAlive,
    isRealHost(h),
    realTabHost == HGone,
    realTabHost' = h,
    _keepRuntime, _keepMachine, _keepFlight, _keepReplicata,
    myTabHost' = myTabHost,
    chromeAlive' = chromeAlive,
  }
  action spawnMyTab(h: Host): bool = all {
    chromeAlive,
    isLocalHost(h),
    myTabHost == HGone,
    myTabHost' = h,
    _keepRuntime, _keepMachine, _keepFlight, _keepReplicata,
    realTabHost' = realTabHost,
    chromeAlive' = chromeAlive,
  }

  // User assigns a tab via UI. Runtime schedules install; flight flips on.
  // Persisted-to-disk bookkeeping happens on install *success*, not here
  // (matches runtime: saveAssignments() is called after REAL_INSTALLED fires).
  action assignReal: bool = all {
    replicataAlive,
    global == Connected,
    realTabHost != HGone,
    // Matches runtime.ts server-side guard: reject localhost as real.
    not(isLocalHost(realTabHost)),
    not(runtimeBoundReal),
    wiring == Unwired or wiring == MyOnly,
    runtimeBoundReal' = true,
    runtimeRealHost' = realTabHost,
    wiring' = if (wiring == Unwired) InstallingReal else InstallingRealAfterMy,
    installFlightReal' = true,
    _keepPhysical,
    runtimeBoundMy' = runtimeBoundMy,
    runtimeMyHost' = runtimeMyHost,
    global' = global,
    stream' = stream,
    installFlightMy' = installFlightMy,
    _keepReplicata,
  }

  action assignMy: bool = all {
    replicataAlive,
    global == Connected,
    myTabHost != HGone,
    isLocalHost(myTabHost),
    not(runtimeBoundMy),
    wiring == Unwired or wiring == RealOnly,
    runtimeBoundMy' = true,
    runtimeMyHost' = myTabHost,
    wiring' = if (wiring == Unwired) InstallingMy else InstallingMyAfterReal,
    installFlightMy' = true,
    _keepPhysical,
    runtimeBoundReal' = runtimeBoundReal,
    runtimeRealHost' = runtimeRealHost,
    global' = global,
    stream' = stream,
    installFlightReal' = installFlightReal,
    _keepReplicata,
  }

  // Install commit — async callback fires. Success writes persistedHost to
  // simulate saveAssignments() in runtime.ts.
  action commitRealInstallSuccess: bool = all {
    replicataAlive,
    installFlightReal,
    chromeAlive,
    realTabHost != HGone,
    wiring == InstallingReal or wiring == InstallingRealAfterMy,
    wiring' = if (wiring == InstallingReal) RealOnly else Ready,
    installFlightReal' = false,
    _keepPhysical,
    _keepRuntime,
    global' = global,
    stream' = stream,
    installFlightMy' = installFlightMy,
    // saveAssignments(realAppUrl: page.url())
    replicataAlive' = replicataAlive,
    persistedRealHost' = realTabHost,
    persistedMyHost' = persistedMyHost,
  }

  action commitRealInstallFail: bool = all {
    replicataAlive,
    installFlightReal,
    wiring == InstallingReal or wiring == InstallingRealAfterMy,
    wiring' = if (wiring == InstallingReal) Unwired else MyOnly,
    runtimeBoundReal' = false,
    runtimeRealHost' = HGone,
    installFlightReal' = false,
    _keepPhysical,
    runtimeBoundMy' = runtimeBoundMy,
    runtimeMyHost' = runtimeMyHost,
    global' = global,
    stream' = SIdle,
    installFlightMy' = installFlightMy,
    _keepReplicata,
  }

  action commitMyInstallSuccess: bool = all {
    replicataAlive,
    installFlightMy,
    chromeAlive,
    myTabHost != HGone,
    wiring == InstallingMy or wiring == InstallingMyAfterReal,
    wiring' = if (wiring == InstallingMy) MyOnly else Ready,
    installFlightMy' = false,
    _keepPhysical,
    _keepRuntime,
    global' = global,
    stream' = stream,
    installFlightReal' = installFlightReal,
    replicataAlive' = replicataAlive,
    persistedRealHost' = persistedRealHost,
    persistedMyHost' = myTabHost,
  }

  action commitMyInstallFail: bool = all {
    replicataAlive,
    installFlightMy,
    wiring == InstallingMy or wiring == InstallingMyAfterReal,
    wiring' = if (wiring == InstallingMy) Unwired else RealOnly,
    runtimeBoundMy' = false,
    runtimeMyHost' = HGone,
    installFlightMy' = false,
    _keepPhysical,
    runtimeBoundReal' = runtimeBoundReal,
    runtimeRealHost' = runtimeRealHost,
    global' = global,
    stream' = stream,
    installFlightReal' = installFlightReal,
    _keepReplicata,
  }

  // Stream lifecycle.
  action streamStart: bool = all {
    replicataAlive,
    global == Connected,
    wiring == RealOnly or wiring == InstallingMyAfterReal or wiring == Ready,
    stream' = SBuffering,
    _keepPhysical, _keepRuntime,
    global' = global, wiring' = wiring,
    _keepFlight, _keepReplicata,
  }
  action streamEnd: bool = all {
    replicataAlive,
    stream == SBuffering,
    stream' = SBuffered,
    _keepPhysical, _keepRuntime,
    global' = global, wiring' = wiring,
    _keepFlight, _keepReplicata,
  }
  action myPull: bool = all {
    replicataAlive,
    wiring == Ready,
    stream == SBuffered or stream == SBuffering,
    stream' = SReplaying,
    _keepPhysical, _keepRuntime,
    global' = global, wiring' = wiring,
    _keepFlight, _keepReplicata,
  }
  action replayEnd: bool = all {
    replicataAlive,
    stream == SReplaying,
    stream' = SIdle,
    _keepPhysical, _keepRuntime,
    global' = global, wiring' = wiring,
    _keepFlight, _keepReplicata,
  }

  // Initial chrome bootstrap from Initializing.
  action cdpConnected: bool = all {
    replicataAlive,
    chromeAlive,
    global == Initializing,
    global' = Connected,
    _keepPhysical,
    _keepRuntime, _keepFlight, _keepReplicata,
    wiring' = wiring, stream' = stream,
  }

  // ===== Replicata process lifecycle =====
  //
  // Replicata runs as a Node process. It can start cold, crash, be
  // restarted. In-memory state (runtime refs, machine) resets on start;
  // persisted assignments.json survives. On restart, restoreFromDisk
  // tries to re-bind known URLs if their tabs still exist.

  action replicataStart: bool = all {
    not(replicataAlive),
    replicataAlive' = true,
    // Fresh in-memory state.
    global' = Initializing,
    wiring' = Unwired,
    stream' = SIdle,
    runtimeBoundReal' = false,
    runtimeBoundMy' = false,
    runtimeRealHost' = HGone,
    runtimeMyHost' = HGone,
    installFlightReal' = false,
    installFlightMy' = false,
    // Physical world + persisted state untouched.
    _keepPhysical,
    persistedRealHost' = persistedRealHost,
    persistedMyHost' = persistedMyHost,
  }

  action replicataCrash: bool = all {
    replicataAlive,
    replicataAlive' = false,
    // In-memory state evaporates.
    global' = Initializing,
    wiring' = Unwired,
    stream' = SIdle,
    runtimeBoundReal' = false,
    runtimeBoundMy' = false,
    runtimeRealHost' = HGone,
    runtimeMyHost' = HGone,
    installFlightReal' = false,
    installFlightMy' = false,
    // Persisted state stays (already on disk).
    _keepPhysical,
    persistedRealHost' = persistedRealHost,
    persistedMyHost' = persistedMyHost,
  }

  // Post-connect auto-restore: if assignments.json has a real URL and a
  // matching tab exists, attempt to re-assign. Same for my.
  // In runtime.ts this fires as `restoreAssignments()` after CDP connect.
  // Here modeled as a single action that tries one of the two roles.
  action restoreReal: bool = all {
    replicataAlive,
    global == Connected,
    wiring == Unwired or wiring == MyOnly,
    not(runtimeBoundReal),
    persistedRealHost != HGone,
    persistedRealHost == realTabHost,          // matching tab still there
    // Kicks off install — same as assignReal.
    runtimeBoundReal' = true,
    runtimeRealHost' = realTabHost,
    wiring' = if (wiring == Unwired) InstallingReal else InstallingRealAfterMy,
    installFlightReal' = true,
    _keepPhysical,
    runtimeBoundMy' = runtimeBoundMy,
    runtimeMyHost' = runtimeMyHost,
    global' = global,
    stream' = stream,
    installFlightMy' = installFlightMy,
    _keepReplicata,
  }

  action restoreMy: bool = all {
    replicataAlive,
    global == Connected,
    wiring == Unwired or wiring == RealOnly,
    not(runtimeBoundMy),
    persistedMyHost != HGone,
    persistedMyHost == myTabHost,
    isLocalHost(myTabHost),                    // defensive — persisted was local
    runtimeBoundMy' = true,
    runtimeMyHost' = myTabHost,
    wiring' = if (wiring == Unwired) InstallingMy else InstallingMyAfterReal,
    installFlightMy' = true,
    _keepPhysical,
    runtimeBoundReal' = runtimeBoundReal,
    runtimeRealHost' = runtimeRealHost,
    global' = global,
    stream' = stream,
    installFlightReal' = installFlightReal,
    _keepReplicata,
  }

  // Unassign (user clicks × or tab destroyed or cross-host nav). Persisted
  // assignment cleared — user's intent was to drop it.
  action userUnassignReal: bool = all {
    replicataAlive,
    global == Connected,
    runtimeBoundReal,
    wiring' = wiringAfterUnassignReal(wiring),
    runtimeBoundReal' = false,
    runtimeRealHost' = HGone,
    stream' = SIdle,
    installFlightReal' = false,
    _keepPhysical,
    runtimeBoundMy' = runtimeBoundMy,
    runtimeMyHost' = runtimeMyHost,
    global' = global,
    installFlightMy' = installFlightMy,
    replicataAlive' = replicataAlive,
    persistedRealHost' = HGone,
    persistedMyHost' = persistedMyHost,
  }

  action userUnassignMy: bool = all {
    replicataAlive,
    global == Connected,
    runtimeBoundMy,
    wiring' = wiringAfterUnassignMy(wiring),
    runtimeBoundMy' = false,
    runtimeMyHost' = HGone,
    stream' = if (stream == SReplaying) SIdle else stream,
    installFlightMy' = false,
    _keepPhysical,
    runtimeBoundReal' = runtimeBoundReal,
    runtimeRealHost' = runtimeRealHost,
    global' = global,
    installFlightReal' = installFlightReal,
    replicataAlive' = replicataAlive,
    persistedRealHost' = persistedRealHost,
    persistedMyHost' = HGone,
  }

  // ===== Helpers: wiring transitions from unassign (mirrors machine) =====

  pure def wiringAfterUnassignReal(w: Wiring): Wiring =
    if (w == InstallingReal or w == RealOnly) Unwired
    else if (w == InstallingMyAfterReal) InstallingMy
    else if (w == Ready) MyOnly
    else if (w == InstallingRealAfterMy) MyOnly
    else w

  pure def wiringAfterUnassignMy(w: Wiring): Wiring =
    if (w == InstallingMy or w == MyOnly) Unwired
    else if (w == InstallingRealAfterMy) InstallingReal
    else if (w == Ready) RealOnly
    else if (w == InstallingMyAfterReal) RealOnly
    else w

  // ===== Step =====

  action step = any {
    replicataStart,
    replicataCrash,
    cdpConnected,
    chromeDies,
    chromeReconnects,
    nondet h = Set(HRealA, HRealB).oneOf() { spawnRealTab(h) },
    nondet h = Set(HLocal1, HLocal2).oneOf() { spawnMyTab(h) },
    tabDestroyReal,
    tabDestroyMy,
    nondet h = Set(HRealA, HRealB, HOther, HLocal1).oneOf() { tabNavigateReal(h) },
    nondet h = Set(HRealA, HLocal1, HLocal2, HOther).oneOf() { tabNavigateMy(h) },
    assignReal,
    assignMy,
    commitRealInstallSuccess,
    commitRealInstallFail,
    commitMyInstallSuccess,
    commitMyInstallFail,
    restoreReal,
    restoreMy,
    userUnassignReal,
    userUnassignMy,
    streamStart,
    streamEnd,
    myPull,
    replayEnd,
  }

  // ===== Derived predicates =====

  pure def realLive(w: Wiring): bool =
    w == RealOnly or w == InstallingMyAfterReal or w == Ready
  pure def myLive(w: Wiring): bool =
    w == MyOnly or w == InstallingRealAfterMy or w == Ready

  // ===== Invariants (the interesting part) =====

  // I1. Wiring state lives inside Connected.
  val wiredImpliesConnected =
    (wiring != Unwired) implies (global == Connected)

  // I2. If wiring says real is "live" (post-install), the physical real
  //     tab must still exist. A Ready state where the tab got destroyed
  //     without the machine noticing is a drift bug.
  val realLiveImpliesPhysicalAlive =
    realLive(wiring) implies (realTabHost != HGone and chromeAlive)

  // I3. Same for my.
  val myLiveImpliesPhysicalAlive =
    myLive(wiring) implies (myTabHost != HGone and chromeAlive)

  // I4. Ready implies BOTH physical tabs exist + bindings match.
  val readyImpliesPhysical =
    (wiring == Ready) implies all {
      realTabHost != HGone,
      myTabHost != HGone,
      chromeAlive,
      runtimeBoundReal,
      runtimeBoundMy,
    }

  // I5. Bound tabs must still physically exist. (The stored host may
  //     drift from current host within the same family during SPA nav —
  //     that's by design and not a bug.)
  val boundRealExists =
    runtimeBoundReal implies (realTabHost != HGone)
  val boundMyExists =
    runtimeBoundMy implies (myTabHost != HGone)

  // I6. If not bound, runtime should have cleared its host ref.
  val unboundRealHasNoHost =
    not(runtimeBoundReal) implies (runtimeRealHost == HGone)
  val unboundMyHasNoHost =
    not(runtimeBoundMy) implies (runtimeMyHost == HGone)

  // I7. My-app's bound host must be local. Non-local binding = handler gap.
  val myBoundImpliesLocal =
    runtimeBoundMy implies isLocalHost(runtimeMyHost)

  // I8. Stream activity requires real to be live.
  val streamRequiresRealLive =
    (stream != SIdle) implies realLive(wiring)

  // I9. Replaying requires Ready.
  val replayingRequiresReady =
    (stream == SReplaying) implies (wiring == Ready)

  // I10. Disconnected resets runtime + machine state.
  val disconnectedClean =
    (global == Disconnected) implies all {
      wiring == Unwired,
      stream == SIdle,
      not(runtimeBoundReal),
      not(runtimeBoundMy),
      not(installFlightReal),
      not(installFlightMy),
    }

  // I11. In-flight installs match intermediate wiring.
  val flightMatchesWiring =
    all {
      installFlightReal implies
        (wiring == InstallingReal or wiring == InstallingRealAfterMy),
      installFlightMy implies
        (wiring == InstallingMy or wiring == InstallingMyAfterReal),
    }

  // I12. When replicata is dead, all in-memory runtime state is empty.
  //      Persisted state is allowed to contain last-known assignments.
  val deadReplicataHasEmptyRuntime =
    not(replicataAlive) implies all {
      wiring == Unwired,
      stream == SIdle,
      not(runtimeBoundReal),
      not(runtimeBoundMy),
      not(installFlightReal),
      not(installFlightMy),
      runtimeRealHost == HGone,
      runtimeMyHost == HGone,
      global == Initializing,
    }

  // I13. Persisted my-host (if set) must be local. Catches if a crashed
  //      runtime wrote bad data or a later change violated the contract.
  val persistedMyIsLocal =
    (persistedMyHost != HGone) implies isLocalHost(persistedMyHost)

  // I14. Persisted real-host (if set) must NOT be local. Catches cross-role
  //      contamination (e.g. user's localhost persisted as the real app).
  val persistedRealIsNonLocal =
    (persistedRealHost != HGone) implies not(isLocalHost(persistedRealHost))

  val allInvariants = and {
    wiredImpliesConnected,
    realLiveImpliesPhysicalAlive,
    myLiveImpliesPhysicalAlive,
    readyImpliesPhysical,
    boundRealExists,
    boundMyExists,
    unboundRealHasNoHost,
    unboundMyHasNoHost,
    myBoundImpliesLocal,
    streamRequiresRealLive,
    replayingRequiresReady,
    disconnectedClean,
    flightMatchesWiring,
    deadReplicataHasEmptyRuntime,
    persistedMyIsLocal,
    persistedRealIsNonLocal,
  }
}
