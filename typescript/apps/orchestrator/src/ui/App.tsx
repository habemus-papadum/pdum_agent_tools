import type { ProviderId } from "@habemus-papadum/agent-core";
import { CellView, ControlSelect } from "@habemus-papadum/aiui-viz";
import { For, Show } from "solid-js";
import { graph } from "../model/graph.ts";
import {
  draft,
  modelOverride,
  preparationError,
  prepare,
  provider,
  refresh,
  resetOverrides,
  workspaceOverride,
} from "../model/store.ts";

export function App() {
  return (
    <main class="orchestrator-app">
      <header class="app-header">
        <div class="app-brand">
          Agent tools <span>Orchestrator</span>
        </div>
        <span class="stage-label">Foundation · S0</span>
      </header>

      <CellView of={graph().connection} label="Reading coordinator">
        {(connection) => (
          <>
            <section class="connection-strip" aria-label="Coordinator connection">
              <div class={`connection-state state-${connection().phase}`}>
                <span class="state-light" />
                <strong>
                  {connection().phase === "ready"
                    ? "Connected"
                    : connection().phase === "loading"
                      ? "Refreshing"
                      : "Unavailable"}
                </strong>
              </div>
              <span class="host-name">{connection().status?.hostId ?? "Local coordinator"}</span>
              <span class="instance-tag" title={connection().status?.instanceId}>
                instance {connection().status?.instanceId.slice(0, 8) ?? "—"}
              </span>
              <button type="button" class="btn btn-outline refresh" onClick={() => refresh.run({})}>
                ↻ Refresh
              </button>
            </section>

            <Show when={connection().error}>
              <div class="connection-error" role="status">
                <strong>Coordinator unavailable.</strong> {connection().error}
                <Show when={connection().observedAt}>
                  <span>
                    {" "}
                    Showing the last observation from {connection().observedAt}; this does not mean
                    the host stopped.
                  </span>
                </Show>
              </div>
            </Show>

            <div class="workspace-grid">
              <section class="inventory-panel" aria-label="Agent inventory">
                <div class="panel-title">
                  <h1>Agents</h1>
                  <span class="count">{connection().runs?.runs.length ?? "—"}</span>
                </div>
                <p class="section-note">
                  {connection().phase === "ready"
                    ? "Owned by this development instance"
                    : "Last known inventory"}
                </p>
                <Show
                  when={connection().runs}
                  fallback={<p class="empty-small">Connect to read this instance's inventory.</p>}
                >
                  <Show
                    when={connection().runs?.runs.length}
                    fallback={
                      <div class="empty-inventory">
                        <span class="empty-mark" aria-hidden="true">
                          ◇
                        </span>
                        <h2>
                          {connection().phase === "ready"
                            ? "No agents launched"
                            : "No agents in last observation"}
                        </h2>
                        <p>Live launch and conversation control arrive in the next slice.</p>
                      </div>
                    }
                  >
                    <pre class="raw-inventory">{JSON.stringify(connection().runs, null, 2)}</pre>
                  </Show>
                </Show>

                <Show when={connection().status}>
                  {(status) => (
                    <details class="instance-details">
                      <summary>
                        Instance details <span class="instance-pid">{status().pid}</span>
                      </summary>
                      <dl>
                        <dt>Workspace</dt>
                        <dd>{status().workspaceDirectory}</dd>
                        <dt>State</dt>
                        <dd>{status().stateDirectory}</dd>
                        <dt>Started</dt>
                        <dd>{status().startedAt}</dd>
                        <dt>Capabilities</dt>
                        <dd>{status().capabilities.join(", ") || "None advertised"}</dd>
                      </dl>
                      <div class="profile-roots">
                        <For each={Object.keys(status().profileRoots) as ProviderId[]}>
                          {(name) => (
                            <p>
                              <span class={`provider-dot provider-${name}`} />{" "}
                              <strong>{name}</strong>
                              <code>{status().profileRoots[name]}</code>
                            </p>
                          )}
                        </For>
                      </div>
                      <p class="section-note">
                        These are isolated profile locations, not signed-in profiles.
                      </p>
                    </details>
                  )}
                </Show>
              </section>

              <section class="composer-panel" aria-label="Prompt preparation">
                <div class="panel-title">
                  <h2>Prepare a prompt</h2>
                  <span class="preview-label">Preview only</span>
                </div>
                <p class="section-note">
                  Create structured content before connecting it to a live conversation.
                </p>
                <div class="compose-controls">
                  <ControlSelect of={provider} label="Destination" />
                  <label>
                    Working model override
                    <input
                      id="orchestrator-model"
                      name={modelOverride.name}
                      data-control={modelOverride.name}
                      value={modelOverride.get()}
                      onInput={(event) => modelOverride.set(event.currentTarget.value)}
                      placeholder="Provider default"
                    />
                  </label>
                </div>
                <label class="workspace-field">
                  Working directory
                  <input
                    id="orchestrator-workspace"
                    name={workspaceOverride.name}
                    data-control={workspaceOverride.name}
                    value={workspaceOverride.get()}
                    onInput={(event) => workspaceOverride.set(event.currentTarget.value)}
                    placeholder={connection().status?.workspaceDirectory ?? "Coordinator workspace"}
                  />
                </label>
                <CellView of={graph().target} fallback={<span />}>
                  {(target) => (
                    <Show when={target()}>
                      {(resolved) => (
                        <p class="target-line">
                          <span>{resolved().hostId}</span>
                          <code>{resolved().cwd}</code>
                          <small>{resolved().cwdSource}</small>
                        </p>
                      )}
                    </Show>
                  )}
                </CellView>
                <label class="draft-field">
                  <span>Prompt text</span>
                  <textarea
                    id="orchestrator-draft"
                    name={draft.name}
                    data-control={draft.name}
                    value={draft.get()}
                    onInput={(event) => draft.set(event.currentTarget.value)}
                    placeholder="What would you like the agent to do?"
                    rows={8}
                  />
                </label>
                <div class="compose-actions">
                  <button type="button" class="btn" onClick={() => prepare.run({})}>
                    Prepare preview <span aria-hidden="true">↗</span>
                  </button>
                  <button type="button" class="text-action" onClick={() => resetOverrides.run({})}>
                    Reset overrides
                  </button>
                  <span class="compose-notice">No request will be sent</span>
                </div>
                <p class="scope-note">
                  Working overrides remain selected for your next preparation. Saved defaults are
                  unchanged.
                </p>
                <Show when={preparationError.get()}>
                  <p class="preparation-error" role="status">
                    {preparationError.get()}
                  </p>
                </Show>

                <CellView of={graph().preview} fallback={<span />}>
                  {(preview) => (
                    <Show when={preview().value}>
                      {(value) => (
                        <div class="prepared-panel">
                          <div class="prepared-heading">
                            <strong>Prepared · not sent</strong>
                            <span class="prepared-status">
                              {preview().current
                                ? "Matches draft"
                                : "Draft changed — prepare again"}
                            </span>
                          </div>
                          <pre class="prepared-text">
                            {value()
                              .rendered.parts.map((part) =>
                                part.type === "text" ? part.text : "[image]",
                              )
                              .join("")}
                          </pre>
                          <div class="prepared-meta">
                            <span>{value().target.provider}</span>
                            <code>{value().target.model ?? "provider default"}</code>
                            <span>{value().record.fingerprint.slice(0, 16)}</span>
                          </div>
                          <details>
                            <summary>Native input preview</summary>
                            <pre>{JSON.stringify(value().nativeInput, null, 2)}</pre>
                          </details>
                          <details>
                            <summary>Structured prompt record</summary>
                            <pre>{JSON.stringify(value().record, null, 2)}</pre>
                          </details>
                        </div>
                      )}
                    </Show>
                  )}
                </CellView>
              </section>
            </div>

            <footer class="app-footer">
              <span>Real coordinator · isolated development state</span>
              <span>Native agent execution is not connected in S0</span>
            </footer>
          </>
        )}
      </CellView>
    </main>
  );
}
