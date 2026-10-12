# Agentic copilot: design goals and experiments

Both Anthropic and OpenAI have CLI tools for agentic coding: Claude Code and Codex CLI. They also have agentic frameworks that, as I understand them, let you create your own agents without necessarily using the same tools or capabilities as their CLI applications. Below that, they have direct APIs, such as response-style APIs, that provide the lowest level of control.

I'm trying to create tools with an agentic copilot. My starting assumption is that the CLI tools have significant engineering effort behind them that makes them substantially more effective at the problems I want to solve, which tend to be mathematical and scientific, than a raw agentic loop would be. On the other hand, those tools aren't necessarily designed to be controlled easily outside a terminal.

They also differ in the features they offer. Claude Code seems to have a better SDK for controlling the CLI. Codex CLI doesn't seem to offer the same level of SDK control, but it is open source, so creating our own wrapper is an option.

This agentic copilot is critical to my work. It's worth considering difficult options if they provide enough benefit: I'm trying to find something close to the best solution in terms of effectiveness. Some of the approaches I might propose wouldn't necessarily make sense for a product serving tens of thousands of people. This is a tool for my own use, and I want to make it as powerful as possible.

I want to start by describing the high-level design goals and the system I'm trying to build. Then I'll describe the spikes I want to run. By spikes, I mean small experiments that verify functionality or help us understand the constraints of existing systems.

At a high level, I envision a system where I'm controlling and interacting with a large number of agents. These agents are generally solving technical and scientific problems, whether concrete problems or design problems, or maintaining infrastructure.

At the highest level, there are two types of agents: pets and cattle. Pets have specific names and individual identities. Cattle represent swarms of agents that may collaborate to solve a hard task, but there are too many of them to interact with or understand individually.

The main idea behind a pet is that the human and the agent are looking at a single shared state. In my mind, that state is visualized for the human as a website. The agent might be Claude Code, Codex, or a custom agent. What matters is that it has tools organized around manipulating that shared state.

For example, we might be looking at a website where we're designing analog circuits. The user could interact with the pet by drawing symbols on the screen instead of typing text, and those interactions would be made available to the agent.

The agent would also understand that it has tools for communicating with the user or presenting information outside its normal text-based flow. There might be a specific notification tool, for example.

A pet might help us design an analog circuit or set up the objective for an RL training run. It might also work with us on a piece of shared infrastructure, answering questions about it and explaining where particular costs are coming from.

Cattle, on the other hand, typically work as a swarm to solve a hard problem. They might be proving a mathematical theorem in Lean or writing a piece of code. Usually, they're working toward a concrete artifact that we can inspect at the end, such as code or a proof.

In all of these cases, we're trying to do cutting-edge work. We want debuggability and visibility into the systems, along with controllability. We also want to benefit from the engineering knowledge that the foundation labs have put into their tools.

There are several features of the CLI applications that I want to retain when accessing them remotely, through something like an SDK. These include control over context compaction, the ability to use subagents or workflows, and the ability to launch long-running background tasks that the agent continues to monitor. The CLI tools are well tuned to tools for manipulating filesystems and other resources. They can work with images and run tasks in loops. They are also steerable: once a turn has started, the user can give feedback during the turn, and the agent can integrate that feedback into its ongoing work.

There are also useful capabilities at a higher level. One is putting an agent into a quiescent state. When an agent has no remaining background tasks, subagents, or other ongoing work, it should be possible to pause the compute behind it. It should then rematerialize cleanly when the user asks for something or an external stimulus wakes it up. Being able to sleep and wake an agent would be useful.

Another useful capability is the ability to fork or rewind an agent's session.

These systems will become expensive, so understanding cost matters. That includes more than token totals: I want to understand how many input tokens were cached and how much cache reuse is happening.

There are several failure modes I want to watch for:

- If we're not using cached tokens, that's problematic.
- If the context becomes very large, that's problematic.
- If many tool calls are failing, that's problematic.
- If the agent keeps hitting sandbox problems, that's problematic.
- Raw cost is also important and may be one of the simplest things to monitor.

Ideally, we would instrument both the code and the agents as thoroughly as possible. For example, we would push traces of what an agent did into Logfire.

I think of the CLI tools as having two levels of tracing. There is the surface level: the messages, tool interactions, and other visible events. Then there are the raw API calls, the actual system messages, and the rest of what gets sent to the model. We typically don't see that second level, but ideally we would be able to inspect it too.

The problem, as I see it, spans three layers:

1. The raw responses or chat API layer.
2. An agentic framework. There are two kinds here: locally installed frameworks that run and call the underlying API, and hosted versions. I'm not sure I want to pursue hosted versions very much right now.
3. The CLI tools, which I currently regard as the strongest options for performance on the work I care about.

Unfortunately, the CLI tools have different limitations. It's also never clear for long whether Codex or Claude Code is the better option. They seem to leapfrog each other every few months, so I want to support at least both of them.

My impression is that the Claude Code SDK is quite good on the TypeScript side. It allows steering and seems to provide a substantial amount of control. There are still things I'm unsure about. In the normal CLI, for example, you can manage MCP servers or ask a side question using the "by the way" feature. These are features designed for human interaction with the CLI, and I don't know how they are exposed in an SDK-based application.

There are also times when Claude Code asks the user questions. Depending on whether an agent is operating as cattle or as a pet, that may or may not be appropriate. I don't yet know how we should handle those interactions.

I'm fairly sure that the Claude Code SDK launches the Claude Code executable. I don't know how easy it is to isolate that executable from the configuration used by the developer's normal Claude Code installation. On a developer machine, I want to understand how to isolate the SDK-driven instance from the developer's instance, including its defaults and configuration.

I also don't think it's straightforward to instrument Claude Code completely.

Codex presents a different set of issues. Its CLI is open source, which is useful because we can inspect its internals, including the system prompt. It's written in Rust. I can imagine maintaining our own fork of Codex and instrumenting it to provide the behaviors we want.

One issue I've encountered with Codex is that, over a sufficiently long run, sandbox protections seem able to become re-enabled. I want to be able to disable those protections completely in my own code. I don't want sandbox protections in that setup, and a custom fork might be one way to achieve that.

I could also imagine adding an API layer that exposes Codex's capabilities in a rich way to TypeScript or Python. These projects move quickly, so maintaining a fork and keeping it current could be a burden. Even so, I think it's worth exploring.

Authentication is another area to investigate. During development, can I use my subscription authentication to log in? On my developer machine, I want to isolate the agent system I'm experimenting with from the agentic tools I normally use for work. At the same time, I want them to share authentication, or at least use the same authentication mechanism. I want to understand what is possible there.

The work will proceed from these high-level ideas into individual spikes. For each spike, I'll lay out a question, and we'll try to answer it. This is the backdrop: we'll run a series of small fact-finding experiments, understand the state of the available systems, and decide how to proceed from there.
