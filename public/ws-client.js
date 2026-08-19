// Thin WebSocket connection wrapper. Owns exactly what the old inline
// useEffect owned: opening the ws(s)://.../ws connection, JSON-parsing
// inbound frames, and JSON-stringifying outbound frames. Message routing /
// business logic stays with the caller via the onMessage callback.
export function createWsClient({ onMessage, onOpen, onClose, onError }) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener("open", () => onOpen?.());
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    onMessage?.(message);
  });
  ws.addEventListener("close", () => onClose?.());
  ws.addEventListener("error", (event) => onError?.(event));
  return {
    send(obj) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    close() {
      ws.close();
    },
    get readyState() {
      return ws.readyState;
    },
  };
}
