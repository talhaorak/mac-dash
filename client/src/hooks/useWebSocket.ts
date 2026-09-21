import { useEffect, useRef, useState } from "react";
import { backend } from "@/lib/backend";

interface UseWebSocketOptions {
  topics: string[];
  onMessage?: (topic: string, type: string, data: any) => void;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/** Exponential backoff (1 s, 2 s, 4 s … 30 s cap) with ±25 % jitter. */
function reconnectDelay(attempt: number): number {
  const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  const jittered = exp * (0.75 + Math.random() * 0.5);
  return Math.min(RECONNECT_MAX_MS, Math.round(jittered));
}

export function useWebSocket({ topics, onMessage }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const onMessageRef = useRef(onMessage);
  const topicsRef = useRef(topics);
  // Topics the server currently has for this socket
  const subscribedRef = useRef<string[]>([]);
  onMessageRef.current = onMessage;

  useEffect(() => {
    // The desktop (Tauri) build has no WebSocket server. App.tsx polls instead.
    if (backend.isDesktop()) return;

    let disposed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) return;
      reconnectTimer = null;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        const currentTopics = topicsRef.current;
        ws.send(JSON.stringify({ type: "subscribe", topics: currentTopics }));
        subscribedRef.current = [...currentTopics];
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.topic) onMessageRef.current?.(msg.topic, msg.type, msg.data);
        } catch {
          // Ignore frames that are not valid JSON.
        }
      };

      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        subscribedRef.current = [];
        setConnected(false);
        if (disposed) return;
        reconnectTimer = setTimeout(connect, reconnectDelay(attempt));
        attempt += 1;
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null; // prevent reconnect on cleanup
        ws.close();
      }
    };
  }, []);

  // ── Update subscriptions when topics array changes ─────────────────
  useEffect(() => {
    topicsRef.current = topics;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const prev = new Set(subscribedRef.current);
    const next = new Set(topics);

    const toUnsub = [...prev].filter((t) => !next.has(t));
    const toSub = [...next].filter((t) => !prev.has(t));

    if (toUnsub.length > 0) {
      ws.send(JSON.stringify({ type: "unsubscribe", topics: toUnsub }));
    }
    if (toSub.length > 0) {
      ws.send(JSON.stringify({ type: "subscribe", topics: toSub }));
    }
    subscribedRef.current = [...topics];
  }, [topics]);

  return { connected };
}
