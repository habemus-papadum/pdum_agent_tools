# Detailed evidence and attempt ledger

All attempts used `/Users/nehal/.local/bin/codex`, `codex-cli 0.162.1`, on macOS,
2026-10-14. Model calls use exactly `gpt-6-luna`, low effort, default service tier,
disposable home/work directory, no synthetic provider. The local source inspected
was clean `6c372fbef45f730b6d8aa727b0ec8332365588db`; its source relationship to
installed release is documented by 025.

| Attempt | Artifact | Result | Input/cached/output/reasoning/cache write |
| --- | --- | --- | --- |
| Data URL red PNG | `run-1792000472274` | Completed, `Red` | 10172 / 8960 / 5 / 0 / 0 |
| Local PNG + incorrect additional context kind | Same | Synchronous `-32600`, invalid `text` kind | No observed usage; inferred no provider call |
| Localhost HTTP URL | Same | Synchronous `-32600`, remote URLs unsupported | No observed usage; inferred no provider call |
| Missing local image | Same | Completed, `Unknown` | 10231 / 8960 / 5 / 0 / 0 |
| Malformed `url:123` | Same | Deserialization rejection | No observed usage; inferred no provider call |
| Local PNG + application context | `run-1792000513897` | Completed, `Red` | 10243 / 8960 / 5 / 0 / 0 |
| Malformed `url:123` | Same | Deserialization rejection | No observed usage; inferred no provider call |
| Malformed PNG `AAAA` | `invalid-1792000576100` | Acknowledged active turn, credential-free, stopped without completion | No provider credentials; no observed usage |
| HTTP URL, credential-free | Same | Synchronous unsupported URL rejection | No observed usage |
| `detail:low`, credential-free | Same | Accepted into same already-active turn, then stopped | Does not prove low-detail support or rejection |
| Browser canvas red PNG, actual Chrome 155 buttons | `browser-check.json` | Completed `Red`, read/resume/reconnect/resume | 12630 / 11008 / 5 / 0 / 0 |

Target allocation was $0.10 for CLI/browser rich checks; CLI estimate $0.0006529; browser estimate $0.00027478; combined $0.00092768.
The original local/application-context typo was corrected in a separately
identified one-case run rather than rerunning the successful data URL case.
There were no provider-response retries or model fallbacks. Native retry settings
were not changed; no retry event was observed. Browser use is included above; orchestration
usage is recorded by the coordinator, not included as zero. Three repeated browser
usage snapshots on resume are the same completed turn and are not new completions.

Each completion had one usage update; no tool item was observed. The estimate uses
`(input-cached)*0.10/1e6 + cached*0.01/1e6 + output*0.50/1e6`; reasoning is a subset
of output and is not added again. Rate source/date is supplied by the coordinator's
033 price table. These token counts are app-server observations, not an independently
captured upstream billing record. No separate warmup billable response was observed.

Native media evidence: the local image's public `userMessage.content` has
`localImage.path`; the native `response_item` has `input_image.image_url` containing
a PNG data URL and adjacent text identifying the original path. Its prepared detail
is `high`. The developer response item has the application fragment
`<probe>This is a controlled image fixture. Respond in one word.</probe>` and
content kind `additional_content.probe`. The public user item omits that fragment.
Only these experiment-owned rollout records were inspected.

Deleting `red.png` before restart did not prevent read/resume/fork. The structured
history in each retained its original path; it did not turn the user item into
inline image content. The data URL case remains directly renderable from its
public user item. A client needs its own asset retention or an appropriate native
attachment API to render local image history once the original path is missing.
No native private-storage reader was added as a client API.

Cleanup evidence is `artifacts/031-codex-rich-inputs/cleanup.json`: browser harness
PID 7218 and native PID 7267 gone, ports 59624/59625/59626 refused connections,
browser temporary base/home removed, and both CLI copied auth.json files removed.
Other experiment-owned CLI rollout data remains available for private diagnosis.
No source/developer authentication file was modified.
