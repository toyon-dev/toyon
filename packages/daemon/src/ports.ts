// Port allocation: bind port 0 to get a free port from the OS, close, hand it out.
// Small TOCTOU race is acceptable for v0.1; allocations are tracked to avoid
// handing the same port out twice within one daemon lifetime.

const allocated = new Set<number>();

export async function allocatePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = srv.port;
    srv.stop(true);
    if (port && !allocated.has(port)) {
      allocated.add(port);
      return port;
    }
  }
  throw new Error("could not allocate a free port");
}

export function releasePort(port: number) {
  allocated.delete(port);
}
