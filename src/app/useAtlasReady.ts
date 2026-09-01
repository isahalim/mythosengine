/**
 * Gates a shard surface on the atlas sprite having actually decoded.
 *
 * One request lands close to atomically, so waiting for it means the glass
 * appears ready in one beat instead of trickling in fragment by fragment.
 * The preloader resolves on a 2.5s timeout as well as on decode, so a slow
 * network still renders something rather than hanging on a blank stage.
 */
import { useEffect, useState } from "react";
import type { SetKey } from "./glass/geometry.ts";

export function useAtlasReady(setKey: SetKey, preload: (k: SetKey) => Promise<void>): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void preload(setKey).then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [setKey, preload]);

  return ready;
}
