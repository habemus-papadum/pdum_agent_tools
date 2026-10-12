type Message = Record<string, unknown>;

export class RpcClient {
  readonly events: Message[] = [];
  readonly transcript: { direction: string; message: Message }[] = [];
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: Message) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<() => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as Message;
        this.transcript.push({ direction: "server", message });
        if (message.method && message.id !== undefined) {
          this.send({ id: message.id, error: { code: -32601, message: "Fixture declines unexpected interactive requests" } });
        } else if (typeof message.id === "number") {
          const request = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
          else request?.resolve(message.result as Message);
        } else {
          this.events.push(message);
          for (const listener of this.listeners) listener();
        }
      } catch (error) {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener("error", () => this.rejectAll(new Error("WebSocket transport failed")));
    socket.addEventListener("close", () => this.rejectAll(new Error("WebSocket transport closed")));
  }

  static async connect(url: string): Promise<RpcClient> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const socket = new WebSocket(url);
      const opened = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { socket.close(); resolve(false); }, 1_000);
        socket.addEventListener("open", () => { clearTimeout(timer); resolve(true); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); resolve(false); }, { once: true });
      });
      if (opened) return new RpcClient(socket);
      socket.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("App-server did not accept a WebSocket connection within 20 seconds");
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  send(message: Message): void {
    this.transcript.push({ direction: "client", message });
    this.socket.send(JSON.stringify(message));
  }

  async request<Result = Message>(method: string, params: Message = {}): Promise<Result> {
    const id = ++this.sequence;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<Message>((resolve, reject) => {
        timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 30_000);
        this.pending.set(id, { resolve, reject });
        this.send({ id, method, params });
      }) as Result;
    } finally {
      clearTimeout(timer);
    }
  }

  async waitFor(predicate: (event: Message) => boolean): Promise<Message> {
    const existing = this.events.find(predicate);
    if (existing) return existing;
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error("Notification timed out")); }, 30_000);
      const check = () => {
        const result = this.events.find(predicate);
        if (result) {
          clearTimeout(timer);
          this.listeners.delete(check);
          resolve(result);
        }
      };
      this.listeners.add(check);
    });
  }

  close(): void {
    this.socket.close();
  }
}
