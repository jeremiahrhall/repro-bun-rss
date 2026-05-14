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
- Also reproduced on Bun **1.3.14-canary.1+6d0d86b71** (Linux amd64, Ubuntu
  24.04 host, no container) — see [Canary](#canary-1314-canary1) below
- Also reproduced on Bun **1.3.14-canary.1+63035b3e3** — the Rust rewrite
  ([PR #30412](https://github.com/oven-sh/bun/pull/30412)) — see
  [Rust rewrite canary](#rust-rewrite-canary-1314-canary163035b3e3) below
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

## Canary (1.3.14-canary.1)

Re-ran the same `./run-rss-scenarios.sh` sweep against
`bun upgrade --canary` → `1.3.14-canary.1+6d0d86b71` on an Ubuntu 24.04
amd64 host (no container; bun installed via the official install script).
Raw logs in [`results-canary-1.3.14/`](./results-canary-1.3.14/).

Final post-GC samples (last `post-gc` row before the 15s idle / after it):

| scenario                 | rss before idle | rss after 15s idle |
| ------------------------ | --------------: | -----------------: |
| baseline                 |        467.2 MB |            42.1 MB |
| `MIMALLOC_PURGE_DELAY=0` |        517.8 MB |            42.0 MB |
| `MI_VERBOSE=1`           |        536.8 MB |            42.3 MB |
| `MIMALLOC_VERBOSE=1`     |        472.2 MB |            42.1 MB |

JSC heap capacity at every `post-gc` row is ~1 MB, so `overhead` ≈ `rss`.
Same shape as 1.3.13: `Bun.gc(true) + Bun.shrink()` returns the JSC heap to
near zero, RSS stays at 467–537 MB until the mimalloc purge timer fires
during the trailing idle, then collapses to ~42 MB.

### What changed on canary: `MIMALLOC_*` vars ARE honored now

The 1.3.13 negative finding ("standard `MIMALLOC_*` environment variables
are not honored") **does not hold** on `1.3.14-canary.1+6d0d86b71`. The
`MIMALLOC_VERBOSE=1` run dumps the full options table at startup, including
the in-tree mimalloc version:

```
mimalloc: process init: 0x7F95018AA200
v3.3.1, release (built on May  8 2026, 20:47:24)
option 'verbose': 1
option 'purge_delay': 1000
option 'arena_eager_commit': 2
option 'purge_decommits': 1
option 'arena_purge_mult': 1
option 'deprecated_purge_extend_delay': 1
option 'arena_reserve': 1048576 KiB
…
mimalloc: reserved 1048576 KiB memory
```

Cross-checking with `MIMALLOC_VERBOSE=1 MIMALLOC_PURGE_DELAY=0` shows
`option 'purge_delay': 0` in the dump, confirming the env var is parsed
and applied — not just printed. The bundled mimalloc is **v3.3.1** (the
1.3.13 build was on the older series; v3.x renamed several options, hence
the `deprecated_*` rows).

### Why the curve still doesn't budge

Even with `purge_delay=0`, post-GC RSS sits at 516.8 MB. The mechanism is
still:

1. `Bun.gc(true)` → `Global.mimalloc_cleanup(false)` → `mi_collect(false)`.
   The `false` argument is the non-forced variant — it consolidates free
   pages but does not call `madvise(MADV_DONTNEED)`. `purge_delay` only
   gates mimalloc's *own* timer; it does not turn `mi_collect(false)` into
   `mi_collect(true)`.
2. mimalloc's per-segment / per-arena purge happens when a segment becomes
   fully empty AND the delay has elapsed. Under sustained churn, segments
   are reused before they stay empty long enough, so the timer rarely
   fires mid-loop. The 15 s trailing idle is what finally lets segments
   drain and the purge to run — `purge_delay=0` just means "0 ms wait
   *after* it becomes purgeable," not "purge proactively now."
3. Setting `arena_purge_mult=0` alongside `purge_delay=0` was tested in
   addition to the four logged scenarios — both options show up in the
   verbose dump as applied, but post-GC RSS still sits at 494–525 MB and
   only collapses after the 15 s idle. So the gating really is in
   `mi_collect(false)` itself, not in the timer math; no `MIMALLOC_*`
   tuning that's reachable through env vars rescues this case. Raw log:
   [`results-canary-1.3.14/arena-purge-mult-0.log`](./results-canary-1.3.14/arena-purge-mult-0.log).

So the fix shape from the 1.3.13 write-up still applies, but the framing
needs an update: it's no longer "wire env vars through" — that's already
done as of canary `6d0d86b71`. The remaining gap is **(1)** passing
`force=true` from `Bun.gc(true)` down to `mi_collect`, and **(2)** picking
mimalloc v3 defaults (or compile-time options in
[scripts/build/deps/mimalloc.ts](https://github.com/oven-sh/bun/blob/main/scripts/build/deps/mimalloc.ts))
that don't require the user to know about `arena_purge_mult` /
`MI_OPTION_*` to get bounded RSS.

Diff range from 1.3.13 to the canary tested here:
[`bf2e2cecf...6d0d86b71`](https://github.com/oven-sh/bun/compare/bf2e2cecf...6d0d86b71).
1.3.13 was not re-run in this pass, so the original "env vars not honored"
finding is reported as-was for that version.

## Rust rewrite canary (1.3.14-canary.1+63035b3e3)

On 2026-05-14 Bun merged [PR #30412 "Rewrite Bun in Rust"](https://github.com/oven-sh/bun/pull/30412)
(commit `23427db`, +1,009,257 / −4,024, 2,188 files). The canary picked
up by `bun upgrade --canary` after the merge is `1.3.14-canary.1+63035b3e3`,
which is 9 commits ahead of the merge point (3 of them post-rewrite
cleanup PRs: #30708, #30710, #30707, #30715). Re-ran the same
`./run-rss-scenarios.sh` sweep on the same Ubuntu 24.04 amd64 host.
Raw logs in [`results-rust-rewrite/`](./results-rust-rewrite/).

| scenario                 | rss before idle | rss after 15s idle |
| ------------------------ | --------------: | -----------------: |
| baseline                 |        493.0 MB |            40.6 MB |
| `MIMALLOC_PURGE_DELAY=0` |        467.3 MB |            40.4 MB |
| `MI_VERBOSE=1`           |        461.6 MB |            40.7 MB |
| `MIMALLOC_VERBOSE=1`     |        479.7 MB |            40.6 MB |
| `purge_delay=0 + arena_purge_mult=0` | 487.6 MB |        40.6 MB |

**Curve is identical.** Same JSC heap ≈ 1 MB at every `post-gc` row, RSS
overhead 461–509 MB, collapse to ~40 MB only after the 15 s trailing
idle. The mimalloc options dump shows v3.3.1 again, now timestamped
`built on May 14 2026, 17:34:25` — same allocator, freshly rebuilt by
the Rust toolchain.

### Why it didn't change — the bug was faithfully ported

`Global.zig::mimalloc_cleanup` became
[`Global.rs::mimalloc_cleanup`](https://github.com/oven-sh/bun/blob/63035b3e3/src/bun_core/Global.rs)
and was *improved* in one way: the literal `false` in the Zig version is
gone, the function now takes a `force` parameter and forwards it to
`mi_collect`:

```rust
#[inline]
pub fn mimalloc_cleanup(force: bool) {
    if USE_MIMALLOC {
        bun_alloc::mimalloc::mi_collect(force);
    }
}
```

But the *caller* — [`VirtualMachine.rs::garbage_collect`](https://github.com/oven-sh/bun/blob/63035b3e3/src/jsc/VirtualMachine.rs)
— still hardcodes `false`, identical to the Zig original. The `sync`
parameter is forwarded to JSC's `vm.run_gc(sync)` but not to mimalloc:

```rust
#[cold]
pub fn garbage_collect(&self, sync: bool) -> usize {
    bun_core::Global::mimalloc_cleanup(false);  // <-- still false
    let vm = self.global().vm();
    if sync {
        return vm.run_gc(true);
    }
    vm.collect_async();
    vm.heap_size()
}
```

The same `mimalloc_cleanup(false)` call appears at the other two sites
([`ThreadPool.rs:1422`](https://github.com/oven-sh/bun/blob/63035b3e3/src/threading/ThreadPool.rs)
and [`test_command.rs:3083`](https://github.com/oven-sh/bun/blob/63035b3e3/src/runtime/cli/test_command.rs)).
So the one-line fix from the "Possible fixes" section below is now a
zero-line fix — the parameter is already there, it just needs to be
`sync` instead of literal `false` at one call site.

`Bun.shrink()` was ported too — [`BunObject.rs:1142`](https://github.com/oven-sh/bun/blob/63035b3e3/src/runtime/api/BunObject.rs)
still only calls `global_object.vm().shrink_footprint()` (JSC-only),
unchanged in semantics from the Zig version.

Diff range from the prior canary tested here to this one:
[`6d0d86b71...63035b3e3`](https://github.com/oven-sh/bun/compare/6d0d86b71...63035b3e3).

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

Status after the Rust rewrite (canary `63035b3e3`):

1. **Pass `force` through to mimalloc.** Half-done. `mimalloc_cleanup`
   already takes and forwards a `force: bool` parameter
   ([`Global.rs`](https://github.com/oven-sh/bun/blob/63035b3e3/src/bun_core/Global.rs)),
   but `VirtualMachine::garbage_collect`
   ([`VirtualMachine.rs:1117`](https://github.com/oven-sh/bun/blob/63035b3e3/src/jsc/VirtualMachine.rs))
   still passes a literal `false`. Changing that one literal to `sync`
   (the function's existing parameter, set true when `Bun.gc(true)` is
   called) would surface eager purge through the public API. Two
   sibling call sites in `ThreadPool.rs` and `test_command.rs` would
   benefit from the same change.
2. **Env-var wiring is no longer the bottleneck.** As of the
   1.3.14-canary builds, `MIMALLOC_*` vars *are* honored — the verbose
   dump shows `option 'purge_delay': 0` etc. being applied. But none
   of them rescue the curve, because the gate is in `mi_collect(false)`
   itself, not the timer math. Lowering the compile-time `purge_delay`
   default in `scripts/build/deps/mimalloc.ts` would still be a
   defense-in-depth win for users running with `Bun.gc(false)` or no
   explicit GC at all, but it doesn't fix the case in this repro.

Either change would be testable against this repro: the post-GC RSS
overhead should collapse instead of waiting for the timer.

## Files

- [`rss-repro.ts`](./rss-repro.ts) — the repro harness, ~120 lines.
- [`run-rss-scenarios.sh`](./run-rss-scenarios.sh) — runs all four env
  scenarios sequentially and prints a summary.
