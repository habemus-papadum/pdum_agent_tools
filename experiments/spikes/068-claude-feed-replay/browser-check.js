// Load into a Chrome page at the spike server's /sessions URL using DevTools.
// This client sends native controls only; it never submits model input.
// Call create(), attach(id), control(name), detach(), status(), stop(), reap().
(() => {
  const study = {
    events: [],
    frames: [],
    output: [],
    pendingText: '',
    descriptor: null,
    async request(path, method = 'GET', body) {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    async waitFor(predicate) {
      const deadline = performance.now() + 15000;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error('Browser check timed out');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
    async create() {
      this.descriptor = await this.request('/sessions', 'POST', { max_budget: 0.03, max_turns: 1 });
      return this.descriptor;
    },
    async attach(id) {
      this.descriptor = await this.request(`/sessions/${id}`);
      this.events = []; this.frames = []; this.output = []; this.pendingText = '';
      this.decoder = new TextDecoder();
      const url = new URL(`/sessions/${id}/feed`, location.href);
      url.protocol = 'ws:';
      this.socket = new WebSocket(url);
      this.socket.onmessage = message => {
        const event = JSON.parse(message.data);
        this.events.push(event);
        if (event.kind !== 'output') return;
        const data = Uint8Array.from(atob(event.data), c => c.charCodeAt(0));
        this.output.push(data);
        this.pendingText += this.decoder.decode(data, { stream: true });
        for (;;) {
          const newline = this.pendingText.indexOf('\n');
          if (newline < 0) break;
          const line = this.pendingText.slice(0, newline);
          this.pendingText = this.pendingText.slice(newline + 1);
          if (line) this.frames.push(JSON.parse(line));
        }
      };
      await this.waitFor(() => this.events.some(event => event.kind === 'replay-end'));
      return this.summary();
    },
    async control(subtype) {
      const id = crypto.randomUUID();
      this.socket.send(JSON.stringify({
        type: 'control_request', request_id: id,
        request: { subtype, ...(subtype === 'initialize' ? { hooks: {}, sdkMcpServers: [] } : {}) },
      }) + '\n');
      await this.waitFor(() => this.frames.some(frame => frame.type === 'control_response' && frame.response?.request_id === id));
      const frame = this.frames.find(frame => frame.type === 'control_response' && frame.response?.request_id === id);
      return { id, subtype: frame.response.subtype, error: frame.response.error ?? null };
    },
    async detach() {
      if (this.socket.readyState !== WebSocket.CLOSED) {
        await new Promise(resolve => { this.socket.onclose = resolve; this.socket.close(); });
      }
      return this.summary();
    },
    status() { return this.request(`/sessions/${this.descriptor.id}`); },
    stop() { return this.request(`/sessions/${this.descriptor.id}/stop`, 'POST'); },
    reap() { return this.request(`/sessions/${this.descriptor.id}/reap`, 'POST'); },
    summary() {
      const output = this.events.filter(event => event.kind === 'output');
      const sequences = output.map(event => event.seq);
      const end = this.events.findIndex(event => event.kind === 'replay-end');
      const start = this.events.find(event => event.kind === 'replay-start');
      const replay = this.events.slice(0, end).filter(event => event.kind === 'output');
      return {
        id: this.descriptor?.id,
        frames: this.frames.length,
        responses: this.frames.filter(frame => frame.type === 'control_response').map(frame => ({
          id: frame.response.request_id, subtype: frame.response.subtype,
        })),
        bytes: output.reduce((sum, event) => sum + event.bytes, 0),
        uniqueOrdered: sequences.every((value, index) => index === 0 || value > sequences[index - 1]),
        replayComplete: end >= 0 && replay.length === start.outputChunks && replay.reduce((sum, event) => sum + event.bytes, 0) === start.outputBytes,
        replayBytes: start?.outputBytes,
        liveChunks: this.events.slice(end + 1).filter(event => event.kind === 'output').length,
        exitCount: this.events.filter(event => event.kind === 'process-exit').length,
      };
    },
  };
  window.feedStudy068 = study;
  return { ready: true, origin: location.origin, modelInputs: 0 };
})()
