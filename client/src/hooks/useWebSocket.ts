import { useEffect, useRef, useCallback, useState } from "react";

type MessageHandler = (data: any) => void;

interface UseWebSocketOptions {
  topics: string[];
  onMessage?: (topic: string, type: string, data: any) => void;
}

export function useWebSocket({ topics, onMessage }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<MessageHandler>>>(new Map());
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMessageRef = useRef(onMessage);
  const topicsRef = useRef(topics);
  onMessageRef.current = onMessage;

  // ── Track topic changes and re-subscribe ───────────────────────────
  const prevTopicsRef = useRef<string[]>([]);

  const connect = useCallback(() => {
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    )
      return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const ws = new WebSocket(`${protocol}//${host}/ws`);

    ws.onopen = () => {
      setConnected(true);
      // Subscribe to current topics
      const currentTopics = topicsRef.current;
      ws.send(JSON.stringify({ type: "subscribe", topics: currentTopics }));
      prevTopicsRef.current = [...currentTopics];
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.topic) {
          onMessageRef.current?.(msg.topic, msg.type, msg.data);
          const handlers = handlersRef.current.get(msg.topic);
          if (handlers) {
            for (const handler of handlers) handler(msg.data);
          }
        }
      } catch {}
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      reconnectTimer.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, []); // no dependencies - stable reference

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on cleanup
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  // ── Update subscriptions when topics array changes ─────────────────
  useEffect(() => {
    topicsRef.current = topics;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const prev = new Set(prevTopicsRef.current);
    const next = new Set(topics);

    // Topics to unsubscribe from
    const toUnsub = [...prev].filter((t) => !next.has(t));
    // Topics to subscribe to
    const toSub = [...next].filter((t) => !prev.has(t));

    if (toUnsub.length > 0) {
      ws.send(JSON.stringify({ type: "unsubscribe", topics: toUnsub }));
    }
    if (toSub.length > 0) {
      ws.send(JSON.stringify({ type: "subscribe", topics: toSub }));
    }
    prevTopicsRef.current = [...topics];
  }, [topics]);

  const subscribe = useCallback((topic: string, handler: MessageHandler) => {
    if (!handlersRef.current.has(topic)) {
      handlersRef.current.set(topic, new Set());
    }
    handlersRef.current.get(topic)!.add(handler);

    return () => {
      handlersRef.current.get(topic)?.delete(handler);
    };
  }, []);

  return { connected, subscribe };
}
