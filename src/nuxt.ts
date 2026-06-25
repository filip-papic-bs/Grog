// Minimal Nuxt 3 / "devalue" payload hydrator.
//
// Nuxt embeds page data in <script id="__NUXT_DATA__"> as a devalue-encoded flat
// array: every distinct value lives at an array index and is referenced by that
// integer index elsewhere (enabling dedup/cycles, and Vue wrappers encoded as
// ["Ref", idx] / ["Reactive", idx] / etc.). To read it we resolve those index
// references back into the real object graph. We deliberately treat every array
// uniformly — string tags like "Ref"/"Reactive" pass straight through, numeric
// elements resolve as indices — which is enough to reach the data without
// modelling each wrapper type (the wrapper just becomes ["Ref", <hydrated>]).

export function parseNuxtData(html: string): unknown {
  const m = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no __NUXT_DATA__ blob in page");
  const values = JSON.parse(m[1]) as unknown[];
  const hydrated = new Array<unknown>(values.length);
  const seen = new Array<boolean>(values.length).fill(false);

  const hy = (ref: unknown): unknown => {
    if (typeof ref !== "number") return ref; // string tag or literal — pass through
    if (ref < 0) return undefined; // -1 hole, -3 NaN, … (we don't need these)
    if (seen[ref]) return hydrated[ref];
    const v = values[ref];
    if (v === null || typeof v !== "object") {
      seen[ref] = true;
      hydrated[ref] = v;
      return v;
    }
    if (Array.isArray(v)) {
      const a: unknown[] = [];
      seen[ref] = true;
      hydrated[ref] = a;
      for (const x of v) a.push(hy(x));
      return a;
    }
    const o: Record<string, unknown> = {};
    seen[ref] = true;
    hydrated[ref] = o;
    for (const k in v as Record<string, unknown>) o[k] = hy((v as Record<string, unknown>)[k]);
    return o;
  };
  return hy(0);
}

/** Walk a hydrated graph and collect every plain object matching `pred`
 * (deduped by reference, cycle-safe). */
export function collectObjects(
  root: unknown,
  pred: (o: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== "object" || seen.has(o)) continue;
    seen.add(o);
    if (Array.isArray(o)) {
      for (const x of o) stack.push(x);
    } else {
      if (pred(o as Record<string, unknown>)) out.push(o as Record<string, unknown>);
      for (const k in o as Record<string, unknown>) stack.push((o as Record<string, unknown>)[k]);
    }
  }
  return out;
}
