# Bun RSS Retention Repro

A self-contained, single-file reproduction of Bun's RSS-retention behavior
under sustained allocation churn: **after `Bun.gc(true) + Bun.shrink()` the
JSC heap drops to ~3 MB but the process keeps ~485 MB of RSS until mimalloc's
internal purge timer fires (~15 s later).**

Bun ships mimalloc with no exposed runtime API to trigger eager page
decommit, and standard `MIMALLOC_*` environment variables are not honored,
so the only way out within Bun's defaults is to wait. For long-running
services with continuous churn, the wait window never opens (segments never
become fully purgeable), and RSS climbs monotonically toward the OOM
ceiling.

## Versions tested

- Bun 1.3.13 on Linux (amd64)
- Container image: `oven/bun:1-debian` (the official Bun image, Debian base)
- Should reproduce on any 1.3.x; pre-1.3 not validated

The harness was executed directly inside an `oven/bun:1-debian` container, so
the numbers below reflect Bun's stock build of mimalloc with no host-side
glibc / jemalloc interaction.

## Run it

```sh
# Single baseline run
bun ./rss-repro.ts

# Full sweep of env-var scenarios, output goes to ./results/
./run-rss-scenarios.sh
```

`rss-repro.ts` accepts `--iters=N --bytes=N --sample-every=N --gc-every=N
--hold=N`. See the file header for defaults. Per-iteration JSONL goes to
stdout; a compact human-readable row goes to stderr.

## What it shows (baseline, 1500 churn rounds, GC every 500)

```
t=     1ms r=    0    churn rss=  33.1MB jsc.cap=   2.5MB jsc.size=   0.2MB extra=    0MB ab=    0MB overhead=  30.6MB
t=   522ms r=  250    churn rss= 614.1MB jsc.cap= 195.6MB jsc.size= 122.5MB extra= 81.4MB ab=    0MB overhead= 337.1MB
t=   964ms r=  500  post-gc rss= 488.6MB jsc.cap=   2.8MB jsc.size=   0.4MB extra=  0.1MB ab=    0MB overhead= 485.8MB
t=  1762ms r= 1000  post-gc rss= 512.0MB jsc.cap=   2.9MB jsc.size=   0.4MB extra=  0.1MB ab=    0MB overhead= 509.0MB
t=  2537ms r= 1500  post-gc rss= 491.5MB jsc.cap=   2.9MB jsc.size=   0.4MB extra=  0.1MB ab=    0MB overhead= 488.5MB
t= 17542ms r= 1500  post-gc rss=  42.9MB jsc.cap=   2.1MB jsc.size=   0.2MB extra=    0MB ab=    0MB overhead=  40.8MB
```

Read the `post-gc` rows: at every checkpoint, JSC heap capacity is back to
~3 MB but RSS sits 480–510 MB above it. The last row is after a 15 s idle
sleep with no further allocations — only then does RSS fall close to
baseline.

`overhead = rss − jsc.heapCapacity − jsc.extraMemorySize − arrayBuffers`.
That's the slice of RSS that JSC accounting cannot explain — i.e. pages
held by the allocator below JSC.

## Mechanism (citing Bun source)

References use [oven-sh/bun](https://github.com/oven-sh/bun) at 1.3.13.

1. `Bun.gc(force)` lowers into [`VirtualMachine.garbageCollect`](https://github.com/oven-sh/bun/blob/v1.3.13/src/jsc/VirtualMachine.zig)
   which calls `Global.mimalloc_cleanup(false)` →
   [`mi_collect(false)`](https://github.com/oven-sh/bun/blob/v1.3.13/src/bun_core/Global.zig).
2. `mi_collect(false)` is the **non-forced** variant. It consolidates free
   pages but does not call `madvise(MADV_DONTNEED)` — the kernel still sees
   the pages as resident.
3. Decommit is gated by mimalloc's per-segment purge timer (default ~10 s
   after a segment becomes fully empty). Under sustained churn, segments
   rarely stay fully empty long enough for the timer to fire, so RSS
   ratchets toward the peak working set.
4. [`Bun.shrink()`](https://github.com/oven-sh/bun/blob/v1.3.13/src/runtime/api/BunObject.zig)
   compacts the JSC heap (`vm.shrinkFootprint()`) — it does not touch
   mimalloc.
5. There is no Bun API in 1.3.13 that calls `mi_collect(true)` (the forced
   variant) or sets mimalloc options at runtime.

## Negative findings

These do **not** change the curve in this repro:

- `MIMALLOC_PURGE_DELAY=0` — Bun statically links mimalloc with no env-var
  glue at startup ([scripts/build/deps/mimalloc.ts](https://github.com/oven-sh/bun/blob/v1.3.13/scripts/build/deps/mimalloc.ts)), so standard
  `MIMALLOC_*` variables are not honored.
- `MIMALLOC_VERBOSE=1` — same reason, no allocator stats emitted.
- `MI_VERBOSE=1` — Bun reads this var
  ([src/bun_core/env_var.zig](https://github.com/oven-sh/bun/blob/v1.3.13/src/bun_core/env_var.zig))
  but in 1.3.13 does not appear to call `mi_stats_print()` on shutdown.

The `run-rss-scenarios.sh` script runs all four (baseline + the three
above) so you can see them line up.

## Why the metric definitions matter

`process.memoryUsage().rss` reads RSS from `/proc/self/stat` directly
([src/jsc/bindings/BunProcess.cpp](https://github.com/oven-sh/bun/blob/v1.3.13/src/jsc/bindings/BunProcess.cpp)).
The `heapTotal/heapUsed/external/arrayBuffers` fields come from JSC's
internal accounting. So in production, **`rss` is the metric that predicts
OOM**; `heapUsed` will look healthy while RSS climbs.

## Related Bun issues

The most-cited open issue is **[#21560 — Memory (RSS) in Bun Spawned Child
Process Grows Slowly, Even When Idle](https://github.com/oven-sh/bun/issues/21560)**.
That issue is about `Bun.spawn`'d *child* processes growing RSS while
*idle*, which is a different presentation than this repro (single process,
busy churn). They likely share an underlying cause in the allocator, but
the triggers differ.

The closer scenario match is **[#27514 — Severe Memory Retention (RSS) /
OOMKilled in Next.js SSR with Bun, despite low JS Heap](https://github.com/oven-sh/bun/issues/27514)**.
Same shape as this repro: single process, sustained load, JSC heap bounded,
RSS climbs. It was closed as a duplicate of #21560 by automation; the
duplicate-link is defensible from a "same root cause" angle but not from
"same scenario," which is why this repro is filed against the underlying
mechanism rather than either presentation.

A community workaround in [Kilo-Org/kilocode@81173e3](https://github.com/Kilo-Org/kilocode/commit/81173e3e803af01ac5d0e72bb6081b4c734c72c7)
sets `MIMALLOC_PURGE_DELAY=0` on a spawned child for stdio buffer growth.
That env var did **not** affect RSS in this single-process repro on Bun
1.3.13/Linux — see the negative findings above.

## Possible fixes (notes for upstream)

Both small upstream changes:

1. **Pass `force` through to mimalloc.** `Global.mimalloc_cleanup(force)` →
   `mi_collect(force)`. Then `Bun.gc(true)` would actually request eager
   purge.
2. **Bake `MI_OPTION_PURGE_DELAY` (or expose it).** Either lower the
   compile-time default in `scripts/build/deps/mimalloc.ts`, or wire
   `MIMALLOC_*` envs to `mi_option_set_*` at startup so users can tune
   without rebuilding Bun.

Either change would be testable against this repro: the post-GC RSS
overhead should collapse instead of waiting for the timer.

## Files

- [`rss-repro.ts`](./rss-repro.ts) — the repro harness, ~120 lines.
- [`run-rss-scenarios.sh`](./run-rss-scenarios.sh) — runs all four env
  scenarios sequentially and prints a summary.
