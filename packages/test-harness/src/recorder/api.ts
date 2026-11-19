import { jsonValue, type FixtureSource } from "../fixtures/format.js";
import { findLeaks } from "../fixtures/sanitize.js";
import { boundedJson } from "./http.js";
import { createLimiter } from "./limiter.js";
import { writeFixture } from "./write.js";

export type ApiRoute = { name: string; route: string; path: string; uiModule: string };

export type ApiRecording = {
  source: FixtureSource;
  aztecVersion: string;
  /** The recording stack's explorer-api; loopback only. */
  baseUrl: string;
  routes: ApiRoute[];
  log: (line: string) => void;
};

export const recordApiBodies = async (a: ApiRecording): Promise<void> => {
  const base = new URL(a.baseUrl);
  if (base.hostname !== "127.0.0.1" && base.hostname !== "localhost") {
    throw new Error("API bodies are recorded only from a loopback explorer-api");
  }
  const limiter = createLimiter(a.log);
  for (const r of a.routes) {
    if (findLeaks(r.path).length > 0) {
      throw new Error(`route ${r.name} has a path the fixture guard rejects`);
    }
    const url = new URL(r.path, base);
    if (url.origin !== base.origin) {
      throw new Error(`route ${r.name} leaves the recording API`);
    }
    const { status, json } = await boundedJson(limiter, url.href, { method: "GET" });
    const body = jsonValue.parse(json);
    a.log(
      `wrote ${writeFixture({
        source: a.source,
        kind: "api-body",
        name: r.name,
        aztecVersion: a.aztecVersion,
        origin: `GET ${r.route}`,
        features: Array.isArray(body) && body.length === 0 ? ["empty"] : [],
        data: { route: r.route, path: r.path, status, uiModule: r.uiModule, body },
      })}`,
    );
  }
};
