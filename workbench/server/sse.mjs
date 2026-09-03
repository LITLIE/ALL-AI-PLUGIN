// server/sse.mjs — SSE channel backed by the active EventBus instance.

export function sseHandler(req, res, bus, { pollIntervalMs = 50, heartbeatMs = 15_000 } = {}) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const parsedSince = Number.parseInt(url.searchParams.get('since') || '0', 10);
  let cursor = Number.isFinite(parsedSince) && parsedSince >= 0 ? parsedSince : 0;
  let closed = false;
  let pumping = false;
  let pumpAgain = false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const pump = async () => {
    if (closed) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }

    pumping = true;
    try {
      do {
        pumpAgain = false;
        const events = await bus.readFrom(cursor + 1);
        for (const event of events) {
          if (closed) return;
          if (event.seq <= cursor) continue;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          cursor = event.seq;
        }
      } while (pumpAgain && !closed);
    } catch (error) {
      if (!closed) res.destroy(error);
    } finally {
      pumping = false;
    }
  };

  const poll = setInterval(pump, pollIntervalMs);
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, heartbeatMs);

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
  };

  req.once('close', close);
  res.once('close', close);
  void pump();
}
