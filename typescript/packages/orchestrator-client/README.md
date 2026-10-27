# Orchestrator management client

`OrchestratorClient` works in browser and Node with injected or native fetch.
S0 exposes actual coordinator status, its currently empty run registry, and
identity-targeted stop. Provider launch, profile operations and conversation
clients follow in later slices; this package does not fabricate those capabilities.

Pass the coordinator origin as `baseUrl` in Node, or use the application's
same-origin `/api` proxy in a browser. Importing/constructing a client is inert.
Requests are not retried automatically; a connection failure can leave a mutation's
outcome unknown. Stop names an instance for hygiene, not as an authorization token.
