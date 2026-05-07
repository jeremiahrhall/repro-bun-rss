/**
 * RSS retention repro: drive an allocate/free churn workload while sampling
 * RSS vs JSC heap stats, then force Bun.gc(true) + Bun.shrink() periodically
 * to see whether the gap (rss - heap) collapses or stays inflated.
 *
 * Run:
 *   bun ./rss-repro.ts
 *   MIMALLOC_VERBOSE=1 MIMALLOC_PURGE_DELAY=0 bun ./rss-repro.ts
 *   MI_VERBOSE=1 bun ./rss-repro.ts
 *
 * CLI flags:
 *   --iters=N         total churn rounds          (default 4000)
 *   --bytes=N         approx live bytes per round (default 4_000_000)
 *   --sample-every=N  print a sample every N rounds (default 50)
 *   --gc-every=N      Bun.gc(true)+shrink every N (0 disables)  (default 500)
 *   --hold=N          rounds of allocations to keep live        (default 8)
 */

import { heapStats } from 'bun:jsc';

type Args = {
  iters: number;
  bytes: number;
  sampleEvery: number;
  gcEvery: number;
  hold: number;
};

function parseArgs(argv: string[]): Args {
  const get = (name: string, def: number): number => {
    const flag = argv.find((a) => a.startsWith(`--${name}=`));
    if (!flag) return def;
    const n = Number(flag.slice(name.length + 3));
    return Number.isFinite(n) ? n : def;
  };
  return {
    iters: get('iters', 4000),
    bytes: get('bytes', 4_000_000),
    sampleEvery: get('sample-every', 50),
    gcEvery: get('gc-every', 500),
    hold: get('hold', 8)
  };
}

type Sample = {
  t_ms: number;
  round: number;
  phase: 'churn' | 'post-gc';
  rss: number;
  heap_total: number;
  heap_used: number;
  jsc_heap_size: number;
  jsc_heap_capacity: number;
  jsc_extra: number;
  jsc_objects: number;
  external: number;
  array_buffers: number;
  overhead: number;
};

function sample(round: number, phase: Sample['phase'], t0: number): Sample {
  const mem = process.memoryUsage();
  const stats = heapStats();
  const accountedJSC = stats.heapCapacity + stats.extraMemorySize;
  return {
    t_ms: Math.round(performance.now() - t0),
    round,
    phase,
    rss: mem.rss,
    heap_total: mem.heapTotal,
    heap_used: mem.heapUsed,
    jsc_heap_size: stats.heapSize,
    jsc_heap_capacity: stats.heapCapacity,
    jsc_extra: stats.extraMemorySize,
    jsc_objects: stats.objectCount,
    external: mem.external,
    array_buffers: mem.arrayBuffers,
    // Allocator overhead = pages held by the process that JSC doesn't account
    // for. ArrayBuffers + external are counted in mem.* but not in JSC heap.
    overhead: mem.rss - (stats.heapCapacity + stats.extraMemorySize + mem.arrayBuffers)
  };
}

/**
 * One round = a mixed object graph + a typed array, sized to `bytes`.
 * The typed array exercises the buffer arena; the Map+strings exercise
 * mimalloc-backed JSC small-cell allocations. Both die together when
 * the round drops out of the rolling window.
 */
function makeRound(round: number, bytes: number): unknown {
  const ta = new Uint8Array(Math.floor(bytes / 2));
  // Touch pages so the kernel actually maps them (avoid lazy-commit skew).
  for (let i = 0; i < ta.length; i += 4096) ta[i] = round & 0xff;

  const m = new Map<string, string>();
  const stringBudget = Math.floor(bytes / 2);
  const stringSize = 256;
  const count = Math.floor(stringBudget / stringSize);
  for (let i = 0; i < count; i++) {
    // Force unique string contents so JSC can't intern them.
    m.set(`k-${round}-${i}`, `${round}:`.padEnd(stringSize, 'x') + i);
  }
  return { ta, m };
}

function pad(n: number, w: number): string {
  return String(n).padStart(w);
}

function mb(n: number): string {
  return (n / 1024 / 1024).toFixed(1);
}

function emit(s: Sample): void {
  // Two outputs per sample: a JSONL line for machines and a compact human row.
  console.log(JSON.stringify(s));
  console.error(
    `t=${pad(s.t_ms, 6)}ms r=${pad(s.round, 5)} ${pad(s.phase, 8)} ` +
      `rss=${pad(Number(mb(s.rss)), 6)}MB ` +
      `jsc.cap=${pad(Number(mb(s.jsc_heap_capacity)), 6)}MB ` +
      `jsc.size=${pad(Number(mb(s.jsc_heap_size)), 6)}MB ` +
      `extra=${pad(Number(mb(s.jsc_extra)), 5)}MB ` +
      `ab=${pad(Number(mb(s.array_buffers)), 5)}MB ` +
      `overhead=${pad(Number(mb(s.overhead)), 6)}MB`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.error(
    `[rss-repro] bun=${Bun.version} pid=${process.pid} ` +
      `iters=${args.iters} bytes=${args.bytes} hold=${args.hold} ` +
      `sample-every=${args.sampleEvery} gc-every=${args.gcEvery}`
  );
  console.error(
    `[rss-repro] env: MIMALLOC_VERBOSE=${process.env.MIMALLOC_VERBOSE ?? ''} ` +
      `MIMALLOC_PURGE_DELAY=${process.env.MIMALLOC_PURGE_DELAY ?? ''} ` +
      `MI_VERBOSE=${process.env.MI_VERBOSE ?? ''}`
  );

  const t0 = performance.now();
  // Rolling buffer keeps the last `hold` rounds live, then drops the oldest.
  // This mimics a steady-state working set while every other allocation dies.
  const ring: Array<unknown> = new Array(args.hold);

  emit(sample(0, 'churn', t0));

  for (let r = 1; r <= args.iters; r++) {
    ring[r % args.hold] = makeRound(r, args.bytes);

    if (r % args.sampleEvery === 0) {
      emit(sample(r, 'churn', t0));
    }

    if (args.gcEvery > 0 && r % args.gcEvery === 0) {
      // Drop everything to give the collector the easiest possible job.
      for (let i = 0; i < ring.length; i++) ring[i] = undefined;
      Bun.gc(true);
      // Bun.shrink() compacts JSC heap (does not poke mimalloc — see plan).
      // @ts-expect-error - Bun.shrink exists at runtime; types may not surface it.
      if (typeof Bun.shrink === 'function') Bun.shrink();
      emit(sample(r, 'post-gc', t0));
    }
  }

  // Final cleanup pass: should be the absolute floor we can achieve.
  for (let i = 0; i < ring.length; i++) ring[i] = undefined;
  Bun.gc(true);
  // @ts-expect-error - see above
  if (typeof Bun.shrink === 'function') Bun.shrink();
  // Give mimalloc's purge timer a chance to fire if the default delay applies.
  await Bun.sleep(15_000);
  Bun.gc(true);
  emit(sample(args.iters, 'post-gc', t0));
}

void main();
