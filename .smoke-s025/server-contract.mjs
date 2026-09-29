const BASE = "http://127.0.0.1:8787";

async function login() {
  const res = await fetch(`${BASE}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo",
      displayName: "冒烟员",
      accessType: "login",
    }),
  });
  if (!res.ok) throw new Error(`login failed ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.accessToken;
}

async function postMessage(token, body, clientMsgId) {
  const res = await fetch(`${BASE}/api/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ body, channelId: "engineering", clientMsgId }),
  });
  if (!res.ok) throw new Error(`message failed ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const token = await login();
  console.log("check1: login ok, token issued");

  // Probe a single message to confirm channel + permissions before the bulk push.
  const probe = await postMessage(token, "probe", "");
  if (typeof probe.seq !== "number") throw new Error("probe returned no seq");
  console.log(`check2: first message accepted seq=${probe.seq}`);

  // Push enough events that the retention window (1000) drops seq 1..N-1000.
  const TARGET = 1005;
  let last = probe;
  for (let i = 0; i < TARGET; i++) {
    last = await postMessage(token, `bulk ${i}`, "");
  }
  console.log(`check3: pushed ${TARGET} messages, lastSeq=${last.seq}`);
  if (last.seq <= 1000) throw new Error(`seq ${last.seq} not beyond retention window`);

  // Open a raw WS with a stale cursor (0) — the server must demand a snapshot.
  const ws = new WebSocket(
    `${BASE.replace("http", "ws")}/api/v1/ws?workspace=demo&access_token=${encodeURIComponent(token)}&last_event_seq=0`,
  );
  const frames = [];
  const snapshotRequired = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for frames")), 8000);
    ws.onmessage = (ev) => {
      let parsed;
      try { parsed = JSON.parse(ev.data); } catch { return; }
      frames.push(parsed);
      if (parsed.type === "workspace.snapshot.required") {
        clearTimeout(timer);
        resolve(parsed);
      }
      // Bail if the server instead replayed history (would mean the window was not exceeded).
      if (frames.length > 5 && !frames.some((f) => f.type === "workspace.snapshot.required")) {
        clearTimeout(timer);
        reject(new Error(`no snapshot.required; got types: ${frames.map((f) => f.type).join(",")}`));
      }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error("ws error")); };
  });
  ws.close();

  const ready = frames.find((f) => f.type === "workspace.ready");
  if (!ready) throw new Error("workspace.ready not received");
  console.log(`check4: workspace.ready replayable=${ready.payload?.replayable} seq=${ready.seq}`);
  if (ready.payload?.replayable !== false) throw new Error("expected replayable=false for out-of-window cursor");

  const cursor = snapshotRequired.payload?.currentEventSeq;
  if (typeof cursor !== "number" || cursor <= 1000) {
    throw new Error(`snapshot.required currentEventSeq invalid: ${cursor}`);
  }
  console.log(`check5: workspace.snapshot.required currentEventSeq=${cursor} lastEventSeq=${snapshotRequired.payload?.lastEventSeq}`);

  // The snapshot endpoint the client must call to recover.
  const snapRes = await fetch(`${BASE}/api/v1/workspaces/demo/snapshot`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!snapRes.ok) throw new Error(`snapshot fetch failed ${snapRes.status}`);
  const snap = await snapRes.json();
  if (!snap.workspace || snap.workspace.id !== "demo") throw new Error("snapshot missing workspace");
  console.log(`check6: GET /snapshot ok workspace=${snap.workspace.id} resources=${snap.resources?.length ?? 0} activity=${snap.activity?.length ?? 0}`);

  console.log("ALL CHECKS PASSED");
}

main().then(() => process.exit(0)).catch((e) => { console.error("SMOKE FAILED:", e.message); process.exit(1); });
