import { useEffect, useRef, useState } from "react";
import type { DomainEvent } from "@linkos/protocol";
import { ensureSession, getSessionToken } from "./api";

type SocketPayload = {
  body?: string;
  author?: string;
  clientMsgId?: string;
};

type SocketEvent = DomainEvent<SocketPayload>;

type WorkspaceSocketOptions = {
  onEvent?: (event: SocketEvent) => void;
};

const HEARTBEAT_MS = 25_000;
const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 8_000;

export function useWorkspaceSocket({ onEvent }: WorkspaceSocketOptions = {}) {
  const [connected, setConnected] = useState(false);
  const [lastSeq, setLastSeq] = useState(0);
  const handlerRef = useRef(onEvent);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let heartbeat: number | undefined;
    let reconnectTimer: number | undefined;
    let cancelled = false;
    let attempt = 0;
    const seenEventIds = new Set<string>();
    const seenClientMsgIds = new Set<string>();

    const clearHeartbeat = () => {
      if (heartbeat !== undefined) window.clearInterval(heartbeat);
      heartbeat = undefined;
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== undefined) return;
      const delay = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * 2 ** Math.min(attempt, 4),
      );
      attempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    const connect = async () => {
      if (cancelled) return;
      const token = await ensureSession();
      if (cancelled) return;
      if (!token) {
        setConnected(false);
        scheduleReconnect();
        return;
      }
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const query = new URLSearchParams({ workspace: "demo" });
      query.set("access_token", getSessionToken() ?? token);
      if (lastSeqRef.current > 0)
        query.set("last_event_seq", String(lastSeqRef.current));

      try {
        socket = new WebSocket(
          `${protocol}://${window.location.host}/api/v1/ws?${query.toString()}`,
        );
      } catch {
        setConnected(false);
        scheduleReconnect();
        return;
      }

      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
        clearHeartbeat();
        heartbeat = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
        }, HEARTBEAT_MS);
      };
      socket.onmessage = (raw) => {
        try {
          const event = JSON.parse(raw.data) as SocketEvent;
          if (typeof event.seq === "number" && event.seq > lastSeqRef.current) {
            lastSeqRef.current = event.seq;
            setLastSeq(event.seq);
          }
          if (event.eventId && seenEventIds.has(event.eventId)) return;
          if (event.eventId) {
            seenEventIds.add(event.eventId);
            if (seenEventIds.size > 500) {
              const oldest = seenEventIds.values().next().value;
              if (oldest) seenEventIds.delete(oldest);
            }
          }
          const payload = event.payload as SocketPayload | undefined;
          if (
            event.type === "chat.message.created" &&
            payload?.clientMsgId &&
            seenClientMsgIds.has(payload.clientMsgId)
          )
            return;
          if (event.type === "chat.message.created" && payload?.clientMsgId) {
            seenClientMsgIds.add(payload.clientMsgId);
            if (seenClientMsgIds.size > 500) {
              const oldest = seenClientMsgIds.values().next().value;
              if (oldest) seenClientMsgIds.delete(oldest);
            }
          }
          handlerRef.current?.(event);
        } catch {
          // Ignore malformed events so one bad frame cannot break reconnects.
        }
      };
      socket.onerror = () => setConnected(false);
      socket.onclose = () => {
        clearHeartbeat();
        setConnected(false);
        scheduleReconnect();
      };
    };

    connect();
    return () => {
      cancelled = true;
      clearHeartbeat();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  return { connected, lastSeq };
}

export type { SocketEvent };
