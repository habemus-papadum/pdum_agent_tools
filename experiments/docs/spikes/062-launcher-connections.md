# 062 — Real launcher connections

**24 October 2026; working disposable application, ready for interaction review.**
The `/connections/` page now shows actual local profiles and reads existing
provider management endpoints. It uses dense Solid/AIUI presentation and real
library calls rather than populated fictional hosts.

The useful result is a clear distinction between **this machine's profile
inventory**, **a Codex home's observed processes**, and **one connected manager's
profiles/workers**. Those are not interchangeable agent counts. Claude's ordinary
profile metadata cannot provide a machine-wide list of workers. A future unified
coordinator still has to compose the existing owners.

The page can filter local profiles, inspect a Codex home, open its profile in 063,
and connect to actual Codex/Claude HTTP management URLs. It distinguishes HTTP
response from recognized provider data. An unavailable manager leaves failed
observation evidence; after a prior success its last snapshot remains explicitly
stale. Forgetting a connection sends no shutdown action. RC-01/02/07/08 guide those
semantics.

Qualification used the actual ordinary Codex home read-only (12 process rows in
the selected observation), the existing dedicated Claude profile, two profiles
created in the isolated lab, and a real worker-free Claude FastAPI manager on
loopback. The latter returned one registered profile and zero workers. No provider
turn, login, or worker was started. Real connection failure and recovery were
exercised by stopping and restarting that test manager. Remote-network behavior
and a live Codex HTTP management adapter were not qualified in this round.

Two focused backend integration tests passed, including actual profile operations
and rejecting an unrelated HTTP-200 JSON server. Desktop and phone browser
journeys were checked, with no final browser warnings/errors or page horizontal
overflow. The app remains intentionally small: no coordinator daemon, automatic
reconnection, subscription, remote edit or permanent connection registry.

Open the [page](http://localhost:56044/connections/) and read the
[runbook / operation map](../../spikes/062-launcher-connections/README.md).
The real worker-free test endpoint is `http://127.0.0.1:63929` while its recorded
local process remains alive. PID ownership and cleanup are in the runbook.

**New provider inference spend: USD 0.** Raw configuration/process observations
stay local. No ordinary profile was changed; no production package was modified.
