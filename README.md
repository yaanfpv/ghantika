# ghantika

> 🚧 **Early days.** This is a young project moving fast. The background command runner and all seven tools (run, status, list, output, tail, kill, follow) are real and tested today, driven by polling - follow adds a bounded wait on top of that same poll floor, never a replacement for it. The Tasks-extension wake this README also describes is real too, not just on the way: a client that declares `io.modelcontextprotocol/tasks` in its `capabilities.extensions` bag gets pushed a notification as a job's output arrives, coalesced into one notification per short window rather than one per arrival, on top of the same poll floor, which stays authoritative either way. A client that declares only the older, SDK-deprecated `capabilities.tasks` shape does not get this notification - the poll floor is what it has. Where that declaration lives depends on which of the two protocol revisions a connection is using: a legacy (pre-2026-07-28) client declares it once, at `initialize` time, and that one declaration governs every request on the connection; the 2026-07-28 revision has no `initialize` exchange at all, so a client on that revision carries its declaration in every request's own envelope, and it is that request alone the declaration governs - not the connection as a whole. That output notification never itself announces a job's completion - it only ever carries new output as it arrives - but a Tasks-capable connection also gets a second status notification on the job's terminal transition, carrying the same complete task snapshot the legacy revision's `tasks/get` returns for that job, so completion is never silent even though the output notification alone would have left it so. That notification's payload matches `tasks/get`'s own projection field for field on either revision - both routes resolve through the same adapter function - but the mechanism still falls short of spec-conformant in one way: the released subscription protocol calls for a client to opt in per task id and a server to honor only the acknowledged subset, while this server instead sends the notification unconditionally to the Tasks-capable connection that minted that task - not broadcast to other connections. This has been driven end to end against the pinned MCP SDK's own client capabilities using that declaration. Whether a real, separately-authored MCP host actually resumes its agent loop on an unsolicited server-initiated notification has been driven and measured, narrowly: against Claude Code, twice, the result was a clean negative - no autonomous wake, and the host's own reply on being asked directly confirmed the notification was never surfaced to it at all. Against Codex CLI the question could not be tested (its single-shot execution model has no persistent idle window to observe). Neither host advertises the extension at handshake in the first place, so both results describe hosts that were never capability-negotiated for this in the way the extension expects; no other host has been tested. Read this as evidence about today's hosts, not about the mechanism - and the extension key itself is the real reserved identity: the Tasks extension (SEP-2663) finalized on 2026-07-28 and defines exactly this name, even though the installed SDK's own exported Task types still predate that release and carry no runtime for it. This is the one wake route in this document with a confirmed negative result against a real host; the other two have the opposite record. Independent of this extension entirely, two other mechanisms have each been driven and observed waking a real, idle agent session on 2026-08-12: Claude Code's own background-and-resume for a held `follow` call (see "The auto-background wake (Claude Code)" below), and ghantika's own app-server-protocol wake on Codex (see "The app-server wake (Codex)" below). Treat anything else you hit that feels rough as exactly that, not a hidden gap.

**Ghantika runs a command in the background so your agent can kick off something long and keep working instead of sitting on it, and rings as its output arrives on a client and configuration that support it.**

[![CI](https://github.com/yaanfpv/ghantika/actions/workflows/ci.yml/badge.svg)](https://github.com/yaanfpv/ghantika/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-6f42c1.svg)](https://modelcontextprotocol.io)

Ask an AI agent to do something that takes a while (a build, a render, a big upload, a training run) and today it does one of two annoying things. It either checks in on the job every few seconds, burning tokens on every single check, or it just blocks and sits there doing nothing else until the command finally exits.

Ghantika fixes that. Hand it a command, and ghantika answers right away, no blocking - the command usually starts running in the background immediately and you get a job id back, and if every concurrency slot is already busy it queues instead, still with a job id, starting on its own the moment one frees up. Only once both the concurrency slots and the queue are full does a command get turned away outright, with no job id at all. Whenever a job does start, the agent is free to do other things immediately. The moment that job produces output, ghantika rings on a client and configuration that support it.

**Set it up once, use it everywhere.** It's a standard [MCP](https://modelcontextprotocol.io) server over stdio, so every client that speaks MCP can start jobs and read them back with the same seven tools, by polling. A client that declares the reserved `io.modelcontextprotocol/tasks` extension key in its `capabilities.extensions` bag gets more than that: ghantika pushes it a notification directly as new output arrives on either stream, stdout or stderr. Declaring only the older, SDK-deprecated `capabilities.tasks` shape does not reach this - polling is what that client has. Every client reads the same jobs the same way, and the job runs regardless of whether anything is watching.

---

## What you can do with it

**Kick off a build and keep working.** "Run the test suite in the background, and let me know the second it's done." Your agent starts it, moves on to something else, and ghantika rings as the test output arrives, on a client and configuration that support it; once the suite exits, a poll picks up the exit code and the rest of the output.

**Chain a pipeline that has no business blocking your agent.** Render a scene, encode the output, upload it, wait for processing, publish it. Every long step in that chain is a command ghantika runs, ringing as each one produces output, on a client and configuration that support it.

And plenty more, across every kind of user:

| Recipe                            | Who it's for         | What it runs in the background                |
| --------------------------------- | -------------------- | --------------------------------------------- |
| A self-running agent team         | agent builders       | each teammate's own wait for the next message |
| ComfyUI render to published video | AI artists, creators | the render, then the upload's processing      |
| Wait for CI to go green           | developers           | a pull request's checks running to completion |
| Wait for a big download or export | everyone             | the download or export itself                 |
| Wait for a training run to finish | ML engineers         | the whole run, hours if it takes hours        |

## How it works

You give ghantika a command, the same way you'd type it in a terminal: an argv array, or a shell string if you need pipes and redirects. Nothing about calling `run` blocks - it always returns synchronously, in one of three shapes. Usually a concurrency slot is free, so the command starts as a real background process immediately and a job id comes back right away, before the command has necessarily produced anything at all. If every slot allowed by `GHANTIKA_MAX_CONCURRENT_JOBS` is already busy but the queue allowed by `GHANTIKA_MAX_QUEUE_DEPTH` has room, no process starts yet - you still get a job id back, but the job sits queued with a `queue_position`, and it starts on its own once an earlier job frees a slot. If both the cap and the queue are full, the call fails outright with `rejected: true` and no job id at all: nothing was created to track.

From there the agent stays in sync with the job by polling: `status` for the job's current state and exit info, `output` or `tail` for what it's written so far. On a Tasks-capable connection, ghantika also rings directly the moment the job produces output - the poll floor sits underneath it unchanged either way (`status`/`output`/`tail` behave identically whether or not a client is watching for either notification, aside from job ids, timestamps, and a handful of fields whose presence depends on timing regardless). That output notification itself stays silent on completion - it only ever carries new output as it arrives - but ghantika also sends a second, separate status notification on the job's terminal transition, carrying the job's own full snapshot at that instant; either way the job itself is real and unaffected: it's running under ghantika's management from the moment `run` returns, whether or not anything is currently watching it, and a client that watches neither notification still learns a job is done the same way it learns anything else, by polling.

There's a third way to stay in sync, besides plain polling and the Tasks-extension notification above: `follow` is a bounded wait on a job's next event. Call it and it returns as soon as new output arrives on the stream(s) you asked about, the job reaches a terminal state, or an explicit bound elapses - whichever happens first. Output arrival means a newly materialized line on the selected stream; a buffered fragment without a terminator does not wake the call on its own, but becomes a partial event when the selected stream finalizes; terminal state can still settle the call. A timeout is a normal, non-error result, never a hang; `status`/`output`/`tail` still report exactly what they always did, before or after calling `follow`, and calling it never changes any of their answers - it's an alternative to writing your own sleep-and-recheck loop, not a new source of truth. Leave its own `timeout_ms` out and it defaults to 45 seconds; pass an explicit value and it's honored up to a one-hour ceiling. `follow` works the same way on every connection, whether or not a client has declared Tasks capability at all - it needs nothing from the connection beyond the job id itself. A caller whose own execution context cannot leave a tool call outstanding for the requested duration - a subagent or background-task turn reclaimed or torn down before this call would return - never gets `follow`'s benefit, the same as any other call that context cannot hold open that long; that is simply how a tool call behaves there, and `status`/`output`/`tail` remain how such a caller checks a job instead.

Cancelling a `follow` call - closing the connection, or a client that sends the standard MCP cancellation notification - tears down that call's subscriptions and its timer immediately, rather than leaving them to run to their own natural bound. Whether the caller actually receives a response after that depends on the cancelled request's id: for an ordinary id the MCP SDK discards it and nothing is sent back, but for the two falsy JSON-RPC ids (`0` and the empty string) a normal cancellation response is still delivered, since the SDK's own response suppression cannot recognize those ids as cancelled either. Because a waiting `follow` call is the one thing this server does that isn't near-instant, it also caps how many may be outstanding (subscribed and waiting) at once, across every connection it serves, at 128. A call made once that cap is already reached is rejected outright with a tool error - never queued, never silently delayed - so hitting it means back off and retry shortly, or fall back to `status`/`output`/`tail` instead. That cap is enforced process-wide, not per connection or per client - this server tracks no connection/client identity today - so one connection's outstanding `follow` calls draw from the same shared budget every other connection does, and a single caller opening many concurrent `follow` calls can still deny the tool to everyone else, though never silently or without bound.

A job's output is captured as it happens, stdout and stderr tracked separately, so `output` and `tail` read what the process has actually written rather than a snapshot from whenever you happened to ask. Every line, on either stream, gets a number from one counter shared across the whole job, so a merged read of both streams sorts by that number and recovers their real line-materialization order, no guessing at interleave required. Each stream still keeps its own bounded window of retained lines: the most recent 10,000 lines or 1 MiB, whichever it hits first, ordinary resident bytes always staying within that bound. The one exception is a single line that alone exceeds it: that line is kept whole (plus a little overhead for its own continuation marker) rather than being cut down further. The append that creates that line can also leave up to almost another full line-cap's worth of not-yet-terminated data sitting alongside it, so resident bytes can genuinely peak near double the nominal cap for the duration of that one append - never indefinitely. The next separate append with no new line completing evicts the old oversized line to make room, exactly like any other old line; it's never left to coexist with new data that keeps growing on top of it across further, separate reads. Once a stream starts dropping its oldest lines to stay inside the window, the response says so: a bounded count of how many discrete loss events that stream has ever suffered (an evicted line, a discarded pending fragment, or a chunk arriving after the job's output was already reclaimed - see "Retention" below), plus the lowest seq still retained, or the stream's highest-ever-assigned seq - possibly 0 if no line was ever materialized - when nothing survives, never which specific lines were lost. That possibly-0 case is real, not a fallback for "nothing happened": a pending fragment discarded on reclaim, or a chunk arriving after reclaim, can be the stream's only loss, and neither one ever materializes a line, so the stream's own retained floor never advances past 0. Reading the merged default discloses this per stream, independently, since the two streams are trimmed on their own schedules. Exact per-line gap disclosure is planned as a follow-up; either way the recent history is real and the old history is honestly reported as gone, never quietly missing.

A job also outlives any single check. Start it, go do something else, ask again on a much later tool call, and `status` still tells you exactly what happened, for as long as the same ghantika server process is up. **That "same server process" qualifier matters if you run more than one ghantika instance at once** - for example Claude Desktop and Claude Code side by side, each launching its own - since a job's id is only ever known to the process that minted it. Asking a different instance about it gets the same not-found response as an id that was never real, because that instance genuinely has no way to distinguish the two; if you're not seeing a job you expect, check which client started it. Two things narrow that independently, on separate clocks, but they don't narrow the same thing: a finished job's _buffered output_ specifically becomes eligible for reclamation on Retention's own clock (see "Retention" below), well before its record does, while `status` keeps answering correctly regardless - retention only ever clears what `output`/`tail` can show, never the record `status` reads. The record itself is untouched by that, but isn't kept forever either: only if something reads the job through the Tasks extension (see "How it's different from what agents already have" below) does its whole record eventually become reclaimable, on that extension's own, much longer clock - and once that happens, `status` on that job id stops finding anything too, since there's no separate record left for it to read. A job never read through the Tasks extension keeps its record, and so keeps answering `status`, for the full server lifetime. Closing the MCP session is where the poll path itself ends: stdin EOF or a shutdown signal reaps every live job before the server exits, and nothing about a job survives a restart, since the store is in memory and deliberately so.

That same rule covers a minted Tasks-extension task, because a task record isn't a second thing kept somewhere else - it's the underlying job record itself, read through the extension's own shape. So a task is exactly as bound to the server process as the job behind it: closing the session reaps it the same way, and it never survives a restart either, since there's no separate durable store for it to persist in.

## Requirements

- **Node.js 22+**

Every direct runtime dependency is pinned to an exact version, no `^`/`~` range that could silently drift, and that pin is checked structurally as part of this project's own CI so a loosened range never ships unnoticed.

## Install

Install it globally with `npm install -g ghantika`, or skip the install and run it straight from npm (`npx -y ghantika`), or clone this repo and point at `dist/index.js`.

## Set it up

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.ghantika]
command = "ghantika"
args = []
```

### Claude Code

```bash
claude mcp add ghantika -- ghantika
```

### Cursor, Cline, Claude Desktop, and friends

These read a JSON config file with an `mcpServers` object in it. Add an entry for ghantika:

```json
{ "mcpServers": { "ghantika": { "command": "ghantika", "args": [] } } }
```

### Any other agent

Point your agent's MCP config at the `ghantika` command (or `node /path/to/dist/index.js`). It's a standard MCP server over stdio, so if your agent speaks MCP, it works.

## Using it

You don't call anything by name. Just tell your agent what to run and that you don't want to be blocked on it:

> Run the build in the background, and tell me the moment it's done.

> Kick off the upload, and let me know once it finishes so I can share the link.

> Start the training run. When it exits, report the final numbers.

Your agent starts the command, keeps working, and ghantika rings as output arrives, on a client and configuration that support it - including one final ring for anything still pending the moment the job finishes. Completion itself, and the exit code, are confirmed by an ordinary poll, same as any other status check. That's the whole experience.

<details>
<summary>Under the hood, for the curious</summary>

Your agent sends a `tools/call` request naming `run`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "run", "arguments": { "command": ["npm", "test"] } }
}
```

and gets the job back before that job has necessarily emitted its spawn event, written a byte, or exited:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "{ \"job_id\": \"a1b2c3d4\", ... }" }],
    "structuredContent": {
      "job_id": "a1b2c3d4",
      "state": "starting",
      "started_at": "2026-03-11T18:42:05.117Z",
      "command_summary": "npm",
      "label": "job a1b2c3d4",
      "counts": { "stdout_lines": 0, "stdout_bytes": 0, "stderr_lines": 0, "stderr_bytes": 0 }
    }
  }
}
```

Every tool answers in that two-part shape: `structuredContent` is the payload to read, and `content` repeats it as pretty-printed text (abbreviated above) for clients that don't take structured output. To keep the rest of this readable, the examples below show the `structuredContent` payload alone, with both the tool-result and the JSON-RPC response envelopes left off.

From there, `status` reports the job's current state and, once it's terminal, its exit code:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": { "name": "status", "arguments": { "job_id": "a1b2c3d4" } }
}
```

```json
{ "job_id": "a1b2c3d4", "state": "exited", "exit_code": 0, "started_at": "...", "ended_at": "..." }
```

trimmed to the interesting fields, since a terminal job still carries the `command_summary`, `label` and `counts` from the first example.

`status` also reports the OS process it tracked for the job, once it ever had a real one: `pid` alongside `birth_identity`, never the pid alone - a pid is reusable the moment its process exits, so pairing it with the same identity `kill` itself checks before ever signaling is what makes a later correlation safe rather than a guess. A terminal job keeps both: the pid it HAD, plus whatever capture state actually holds by then - pending, captured, or unavailable - so a stale-looking pid becomes something you can verify instead of something you have to trust. `birth_identity.state` is one of `pending` (the async capture launched at spawn time hasn't settled yet), `captured` (a real identity is present, under `identity`), or `unavailable` (the capture failed, or - on a job that never got a real process at all, a pre-flight rejection - was never attempted); a job never given a live process carries neither field at all. `identity` is platform-tagged the same way `kill`'s own pre-signal check is (see "Platform notes" below): an exact kernel start-time counter on Linux, a real but PROBABILISTIC `ps`-observed elapsed-time correlation everywhere else on POSIX, and simply `unavailable` on Windows, where this capture isn't attempted at all - never silently backfilled from `spawnedAtMs` (this server's own wall-clock spawn timestamp, a weaker, reusable-adjacent signal this codebase deliberately never treats as identity). Either way, `birth_identity` proves only which process ghantika itself launched for that job - it does not prove a process you separately observe by some other means is that one; confirming that is still on you, the same way it's on `kill` before it ever signals anything.

`output` and `tail` return the lines themselves rather than a job projection, stdout and stderr tracked independently:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "tail",
    "arguments": { "job_id": "a1b2c3d4", "stream": "stdout", "lines": 20 }
  }
}
```

```json
{
  "events": [
    { "seq": 118, "stream": "stdout", "text": "ok 12 - kills the whole process group" },
    { "seq": 119, "stream": "stdout", "text": "# pass 12" }
  ],
  "next_cursor": 119
}
```

Those `seq` values are the real per-line numbers, and they stay real whether you asked for one stream or left `stream` out for the merged default: every line, on either stream, draws from one counter shared across the whole job, so a merged `seq` is a line's true position in the job's real line-materialization order, not a separate axis. A stream that has genuinely lost some of its own output forever - not only an evicted line, but also a reclaimed pending fragment or a chunk arriving after reclaim, neither of which was ever a materialized line - carries `"truncated": true` in the response, plus `"dropped"` (how many discrete loss events that stream has ever suffered - see "Retention" below for what counts as one) and `"droppedBeforeCursor"` (the lowest seq still retained, or the stream's highest-ever-assigned seq - possibly 0 if no line was ever materialized - when nothing survives) - never which specific lines were lost. Reading the merged default discloses this per stream: `"dropped": { "stdout": { "dropped": 3, "droppedBeforeCursor": 42 } }`, say, omitting either side that never lost anything - or `"dropped": { "stderr": { "dropped": 1, "droppedBeforeCursor": 0 } }` for a stream whose only loss was a pending fragment or a post-reclaim arrival that never materialized a line. `"truncated": true` also shows up on its own when a call's own `limit` (or `tail`'s `lines`) left more already-available events undisclosed, distinct from a stream genuinely losing output it can never get back - the two causes are never conflated. Exact per-line gap-range disclosure is planned as a follow-up. Feed `next_cursor` back as `output`'s `after_cursor` to read only what's new since last time - but only when reusing it with the SAME `stream` selection that produced it: a cursor only proves what its own selection disclosed, so reusing a single-stream cursor after switching to a different `stream` value (or to `both`) can skip an already-retained event on the other stream. Start from `after_cursor:0` (or omit it) instead when you change selections.

`kill` stops a job that's still running. The pattern is: start it, do something else, check in by asking whenever it's actually relevant - or, on a Tasks-capable connection, let ghantika ring you directly.

</details>

## How it's different from what agents already have

Some agent runtimes ship a plain "run a command" tool. Here's what ghantika adds on top:

- A plain run-command tool blocks the whole turn until the process exits. Ghantika never blocks: it returns synchronously either way, with a job id for a job that's already running, a job id for one that's queued behind the concurrency cap and starts on its own once a slot frees up, or an outright rejection with no job id at all once the queue is full too. Whichever job actually gets created keeps running regardless of whether anything is watching it.
- Backgrounding a process without a way to check on it later means the moment it finishes is lost the second your attention moves elsewhere. Ghantika keeps a finished job's own record - state, exit code, timestamps - addressable by id for as long as the server is up, so `status`/`list` answer correctly whenever you actually ask; a still-running job is never touched by either narrowing below, at any age. Two things narrow independently once a job finishes: its _buffered output_ becomes eligible for reclamation much sooner, on its own clock (see "Retention" below), and, only if something reads the job through the Tasks extension, its whole _record_ is eventually reclaimed by that extension's own, separate 24-hour TTL - `tasks/update`, `tasks/get`, and `tasks/cancel` all reach that read path, on either protocol revision, regardless of capability. A job you only ever read through `status`/`output`/`tail` is never subject to the second one.
- A fixed sleep-and-recheck loop burns a full round trip on every guess at how long something takes. Ghantika answers on the job's real state, not on a timer you had to estimate up front, and a client declaring the Tasks extension URI (see above) gets rung as new output arrives on either stream.

The new part isn't running a command in the background, it's never having to choose between blocking on it and losing track of it.

## Configuration

The `run` tool takes:

| Argument      | Type               | Required | Meaning                                                                                                                                                                                                                                                                           |
| ------------- | ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`     | string[] \| string | yes      | The command to run. An argv array by default; a shell string requires `shell: true`.                                                                                                                                                                                              |
| `shell`       | boolean            | no       | Run `command` as a shell string instead of an argv array.                                                                                                                                                                                                                         |
| `cwd`         | string             | no       | Working directory for the job. Defaults to ghantika's own.                                                                                                                                                                                                                        |
| `env`         | object             | no       | `{ "mode": "merge" \| "replace", "vars": { ... } }`. `vars` maps variable names to values. `merge` (the default) layers `vars` over a minimal base of `PATH` and `HOME`, or `PATH`, `SystemRoot` and `USERPROFILE` on Windows; `replace` passes `vars` alone with no base at all. |
| `label`       | string             | no       | A short, human-readable name for the job, surfaced in `list`.                                                                                                                                                                                                                     |
| `deadline_ms` | number             | no       | If the job is still running once this many milliseconds have elapsed, it's terminated the same way `kill` would terminate it and its state becomes `failed`. Omitted (the default): no deadline, and the job runs to its own natural completion.                                  |

Ghantika never hands a job its own full environment. Even in `merge` mode the child starts from that minimal base and nothing else, so anything a command needs, it gets because you passed it.

### Concurrency

`run` admits jobs against a concurrency cap, configured via the `GHANTIKA_MAX_CONCURRENT_JOBS` environment variable (default 8). Once that many jobs are running at once, a further job queues instead of starting, up to a queue depth configured via `GHANTIKA_MAX_QUEUE_DEPTH` (default 32); a queued job starts on its own once an earlier job frees a slot, and `status`/`list` expose its `queue_position` while it waits. Once both the cap and the queue are full, `run` rejects the call outright (`isError: true`, `rejected: true`, no job id) rather than creating anything to track. Setting `GHANTIKA_MAX_CONCURRENT_JOBS` to `0` rejects every command immediately; setting `GHANTIKA_MAX_QUEUE_DEPTH` to `0` means nothing is ever queued - once the cap is full, the next job is rejected instead of waiting.

### Retention

A finished job's _buffered output_ - not its record, and not one still holding no output at all - isn't kept forever, for jobs eligible for reclamation. It becomes eligible once `GHANTIKA_JOB_RETENTION_MS` milliseconds have elapsed since the job ended (default one hour), or once the number of eligible finished jobs still holding output exceeds `GHANTIKA_MAX_RETAINED_JOBS` (default 200), whichever happens first; over the cap, the oldest-ended eligible job's output is reclaimed first. Reclamation itself happens either immediately, opportunistically, the next time any job is created - which is often earlier - or, on an otherwise-idle server where no new job ever arrives to trigger that, via a check scheduled every 30 seconds. That 30-second figure is a scheduling interval for an ordinary timer, not a wall-clock guarantee: its callback runs only once the event loop is free to reach it, so a check can be delayed past its scheduled moment by other synchronous work in the process or by host load, the same way any `setInterval` callback can be. For an eligible job on an otherwise-idle server, ordinary reclamation lands close to `GHANTIKA_JOB_RETENTION_MS` plus one scheduled interval; that margin can widen under load, and nothing in this server enforces it as a hard ceiling. A still-running job's output is never reclaimed no matter how long it's been running. A job's output is also held past the usual window for as long as its own process-group reap decision is still being awaited - specifically, the window that begins the instant a reap decision starts being awaited and ends the instant that decision settles, whichever way. That protection is narrower than "cleanup hasn't been confirmed" in general: a job whose record was marked terminal by a different path - the optional per-job deadline timeout, or a live `kill()` call - before its own reap decision starts being awaited is not covered by this window, and its output can be reclaimed in that specific gap. That gap exists independently of retention (the deadline and `kill()` paths have always marked a job terminal before their own cleanup could confirm it); retention is only what makes it reachable, and closing it is tracked as separate, later work. A job whose slot ends up permanently stranded (every automatic reap retry exhausted) is not merely delayed past that bound - its output is intentionally excluded from reclamation entirely, for as long as the server keeps running, since it may be the only remaining trace of what a still-held process group was doing; a manual `kill()` recovery, the server exiting, or the job's record itself being deleted all end that. So the bound above describes the normal, eligible case, not a ceiling on every job's output.

Reclaiming a job's output never touches its record: `status` and `list` keep reporting the job normally, indefinitely (subject only to the separate Tasks-extension TTL described above). `output` and `tail` report the loss the same honest way they already report an ordinary byte/line-cap eviction - `"truncated": true` plus `"dropped"`/`"droppedBeforeCursor"` showing how many loss events a stream has suffered - never a bare "job not found" that would read identically to an id that never existed. `dropped` is ordinarily a count of complete lines, but it widens to count two narrower events too: a not-yet-newline-terminated fragment discarded on reclaim, and a chunk that arrives for a stream after its job is already reclaimed - each counts as one further loss even though neither is a materialized line, so a stream that lost only one of those still reads `truncated: true` with a real, nonzero `dropped` rather than being silently indistinguishable from one that never received anything.

### Command policy

`run` only spawns a command whose fully resolved executable is on an allowlist you configure - by default, with nothing configured, every command is denied. Point the `GHANTIKA_POLICY_FILE` environment variable at a JSON file shaped like:

```json
{ "allow": ["/usr/bin/ls", "node", "sleep"] }
```

Each entry can be a bare name (resolved via ghantika's own `PATH`) or a path; either way, the entry and the command actually being run are both resolved to their real, symlink-free path before comparison, so any way of spelling the same binary reaches the same decision. With `shell: true`, the same check runs against the platform shell binary itself (`/bin/sh` on POSIX), not against the shell command line - and the exact path this check approves is what actually launches: it's passed to the real spawn as a literal executable, never re-derived from your job's own environment, so a shell command only ever runs once you've allowlisted the shell that will actually execute it. A denied command comes back as a failed job with a diagnostic saying so, rather than running or throwing. This is server configuration, not something a tool call can supply or widen: nothing in `command`'s own arguments is ever read as policy, and a missing or malformed policy file denies everything rather than falling open.

Allowlisting an interpreter (a shell, `env`, `node`, and the like) is a real decision, not a convenience default - ghantika ships nothing on the allowlist itself, and once you do add an interpreter, anything it's asked to run is on you the same way it would be if you ran that interpreter directly outside ghantika.

On Windows, that platform shell is resolved from this server's own `ComSpec` (falling back to a PATH search for `cmd.exe` against this server's own trusted `PATH` when unset - never a job's own environment) - this repository's CI has no Windows leg at all right now, so that resolution, and the fact that the resolved path is what actually launches, are verified by reading and by a platform-mocked unit test, not by real execution on a Windows host.

Installing the package itself is a separate mechanism from what that shell resolution covers. On Windows, `npm install -g` launches a package's binary through a generated `.cmd`/`.ps1` shim rather than through the file's own executable mode (the mode this package's build step sets, and the one POSIX installs launch from directly) - this repository's CI has no Windows leg at all right now, so the packaging tests name and skip that shim rather than launch it, and whether it actually starts the installed binary is unverified rather than confirmed.

`status`, `output`, `tail`, and `follow` all take `job_id`. `tail` also takes an optional `stream` (`stdout`/`stderr`/`both`) and `lines`; `output` takes `stream` plus `after_cursor` and `limit` for paging through a long job incrementally; `follow` takes `stream` plus `cursor` and `timeout_ms` for a single bounded wait instead of a page. `kill` takes `job_id`. Every tool's full input schema is advertised over `tools/list`, so an agent (or you) can always ask ghantika directly rather than trusting a doc that's drifted out of date.

### The auto-background wake (Claude Code)

On Claude Code specifically, there's a second wake path, independent of the Tasks-extension notification described in the "Early days" note above: the client itself can auto-background a long-running tool call and later deliver its result as a task notification that resumes an idle agent, with no extension declaration needed on ghantika's side at all.

Set both, in Claude Code's own launch environment:

- `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, a **positive** duration below the client's own MCP tool
  timeout. The threshold has to be strictly greater than zero as well as below the timeout.
- `CLAUDE_AUTO_BACKGROUND_TASKS`, enabled.

Setting both is the configuration this has been observed working under. Whether a session that
does not need the second variable simply ignores it is read from the client's own source, not
something run and observed here; a session that does need it and lacks it is left believing it
configured something that never took effect.

Both variables belong in Claude Code's own launch environment, not ghantika's configuration. There's no install step that can set this for you: macOS starts a GUI client via `launchd`, which does not inherit a shell's environment, so a value exported from your shell profile never reaches it.

**This setting is global to Claude Code, not scoped to ghantika.** A low `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` value changes when MCP tool calls on that client are eligible to background, across every server it talks to that qualifies, not just ghantika's - the client also has its own exclusions (for example, disabling the feature outright, or specific call-path/server/transport conditions) that this document doesn't control. Choose the value knowing that; ghantika has no way to scope it narrower.

The tool this actually interacts with is `follow`: a `run`, `status`, `output`, or `tail` call normally returns quickly and doesn't hold the connection open waiting on your command, so it doesn't get the chance to background - but a `follow` call with a `timeout_ms` above your configured threshold can. Ask your agent to `follow` a job, once both variables are set as your session needs them, and Claude Code can background that wait and deliver the result as a wake.

One gap disclosed rather than explained away: the very first `follow` call past the threshold in a brand-new session was observed not to background - it returned inline as if no threshold were configured, while a same-parameter call later in that same session backgrounded correctly. Nothing here identifies the cause, and it's worth knowing precisely because it would be the least visible time to lose the wake - if a first attempt returns inline, that may be this same gap rather than a broken setup, and the poll floor covers it exactly as it covers everything else. See the wake support matrix for the specific observation.

This wake's reach into a subagent or delegated context is untested rather than excluded: on the one route this has been read against, the current installed Claude Code build skips auto-background entirely whenever the calling context carries an agent id, but that does not establish that every context the client itself calls delegated, child, or subagent reaches the MCP wrapper with `agentId` set. Until that's separately established for your context, don't rely on a subagent's `follow` call to background - use `status`/`output`/`tail` to check a job from a subagent instead.

None of this is required for ghantika to work: `status`, `output`, and `tail` remain the retrieval floor for any job id, retrievable by polling on every client with no configuration needed. `follow` stays available as a client-independent bounded wait on that same floor - the very tool this document tells you to reach for instead of polling - and needs neither variable set to work. `run`, `kill`, and `list` are ordinary request-response operations, never polling endpoints in the first place. This wake is strictly an upgrade on top of that floor, never a replacement for it.

### The inherited-messaging wake (Claude Code)

There's a third Claude Code path. When Claude Code launches ghantika as an MCP server subprocess and that subprocess's environment happens to carry a private messaging socket path and matching credential - the same channel the client itself uses to inject a message into one of its own sessions - ghantika reads that inherited socket and credential and nothing else: never a path it constructs from a process id, never a directory it scans, never a credential belonging to a different session. When the credential is present, this route reaches exactly the session that launched ghantika, by construction, and nothing else - not another session on the same machine, not a session ghantika was never handed a credential for.

The wake only ever fires in response to a job this same session started and that later reached a terminal state - never unconditionally, never on a timer, never for a job it did not start.

**Whether that credential is actually present is not guaranteed by a plain install, and this is a real limit rather than a hedge.** Measured directly, twice, on two different moments: an MCP-server-spawned ghantika process had neither variable in its own environment. Read against the process tree, the reason is structural rather than a timing accident on either occasion - that server had no Claude Code session process anywhere in its own ancestry, so there was nothing for it to have inherited a session-scoped credential from, even in principle. Other live instances on the same machine, spawned differently, sit directly under a session process and could plausibly inherit it; their environments were never read, deliberately, since that isn't ghantika's to check. **Setting the two variables explicitly, in ghantika's own launch environment, is the reliable path** - it works regardless of which shape your particular install produces, asserts nothing about installs it does not cover, and is the same pattern the auto-background wake above already asks you to do:

- `CLAUDE_CODE_MESSAGING_SOCKET` - the socket path Claude Code exports for the session you want ghantika to be able to wake.
- `CLAUDE_CODE_MESSAGING_TOKEN` - the matching credential for that same session.

Both belong in ghantika's own `env` block, not the client's launch environment - the reverse of where the auto-background wake's two variables go. A value copied in this way is tied to the session it was copied from and goes stale the moment that session ends or restarts; this is a manual, session-scoped step, not a persistent configuration.

If you don't want ghantika writing to this channel at all, set `GHANTIKA_DISABLE_CLAUDE_MESSAGING_WAKE=1` in ghantika's own environment.

**Status: `worked`, for the self-targeted route - the child waking the exact session that started it, when the credential is present.** The route is implemented, its authentication is enforced and passes with the real inherited credential, and it sits off the critical path of everything else this project does - job completion is still confirmed by an ordinary poll regardless of whether this wake ever fires, and it falls through cleanly when the channel it depends on is unavailable. On top of that: a message written over this channel has been observed resuming a genuinely idle session, delivered as its own turn with no approval step and nothing else between the job starting and the turn arriving. Waking a _different_ session - the peer path this same channel also carries, gated behind its own approval flow - remains untested. See `docs/wake-support-matrix.md` for the full record, including what was actually measured and the credential-presence finding above.

### The app-server wake (Codex)

Independent of both the Tasks-extension notification described in the "Early days" note above and the Claude Code mechanism above, ghantika also carries its own code that pushes a message directly into a Codex thread once a job it started finishes - not a client-side mechanism, and not gated on any capability negotiation.

Set, in the ghantika server's own environment (not a client's):

- `GHANTIKA_WAKE_TRANSPORT_ENABLED=1`. Unset by default, so this ships inert. This is an experimental opt-in, not a stable configuration surface this project commits to keeping: its name, shape, or existence can change in a future release without the usual deprecation notice.

When a `run` request's own metadata carries a non-empty raw thread ID and that job later reaches a terminal state, ghantika attempts a wake over an ordered pair of transports - the app-server protocol Codex's own tooling uses first, then the desktop app's IPC socket - addressed to whatever that ID names. A refused, unavailable, or thrown attempt on one transport falls through to the next rather than stopping there; only once every configured transport has been tried and none delivered does the final, exhausted outcome get logged. An attempt is not the same as a delivery, and the ID's presence doesn't by itself prove it names the job's own originating thread - only what this codebase's own wake-target design assigns to it.

**Observed:** 2026-08-12, two separate jobs, each delivered as its own turn into a live Codex desktop session, naming the finished job and pointing at the tools to read its result. Terminal-to-turn latency was measured at roughly one to two and a half minutes across the two runs - real and disclosed, not something this route promises to be instant.

The app-server leg of this rides Codex's own versioned, published app-server protocol - the same interface Codex's own tooling is built on, rather than an undocumented internal. Both deliveries above went through it. The desktop-IPC leg reaches into the app's own undocumented socket: the underlying call has been shown to reach a live Codex window by other means, but ghantika's own delivery through it end to end has not; see `docs/wake-support-matrix.md` for the full record of both, including the constraint each one carries and how to reproduce them yourself.

None of this is required: `status`, `output`, and `tail` remain the retrieval floor on Codex exactly as everywhere else, with no configuration needed.

## Roadmap

- Native Windows process-tree kill via a real Job Object, closing the narrow race window `taskkill` leaves open (see Platform notes below).
- A documented, stable extension point for anything that needs to react to a job the moment it changes, beyond the built-in seven tools.

## Contributing

Contributions are welcome. The design is deliberately small, so open an issue before starting anything large and we'll figure out whether it belongs here. A worked recipe for a job people genuinely sit around waiting on is one of the most useful things you can bring.

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and how to run the tests, including a single test.

## License

MIT. See [LICENSE](LICENSE). Built by [@YaanFPV](https://github.com/YaanFPV).

## Platform notes

On POSIX, killing a job signals its whole process group in one group-addressed operation: SIGTERM, then SIGKILL after a grace period if anything is still alive. A caller-supplied signal other than SIGTERM is sent exactly once, with no automatic escalation. That grace period carries its own disclosed, unclosed residual: the group can fully empty during the wait - its ordinary, intended outcome - and have its numeric id recycled by an unrelated later group before the pre-SIGKILL existence check that follows the wait actually runs. That check narrows the window between "still alive" and "about to send SIGKILL" as far as an existence check can, but cannot close it, since existence alone cannot tell a survived original group apart from a coincidentally-reused one; a SIGKILL sent in that narrow window would land on whichever, if anything, has since taken the group's number. This is distinct from the eager-reap gap described next: it only arises on a job actually signaled while still alive, spans up to the whole grace period rather than a single scheduling tick, and is not addressed by the once-per-job reap guard below, which prevents only a later `kill` call from re-signaling, not a reused id hit within this same escalation. A job whose leader already exited on its own (without waiting on children it forked) is reaped automatically the instant that exit is observed, not only when a caller later calls `kill`. While the group still holds a member, the OS cannot recycle its id, so a group with surviving descendants is still provably the one this server spawned at the moment the exit is observed - but that continuity only holds until the last member leaves. Where the leader has no surviving descendants, it IS the last member, so the group empties at exactly the exit being observed, and no continuity carries through to this server's own callback. The residual this leaves is the gap between the group's last member exiting and that callback actually running its existence check: normally very short, but with no fixed upper bound, since it is ordinary event-loop scheduling latency that a busy event loop can stretch well past what "scheduling" suggests - deliberately not stated as a wall-clock tolerance, unlike the pre-signal birth-identity check below (a stated several-second tolerance on macOS, or an exact kernel-counter match with no tolerance concept at all on Linux). At most one signal-capable reap is attempted per job; once that has run, a later `kill` call against that job may still re-check whether the group has since become empty, but never sends another signal, so it can never itself land on a reused id. On Windows, there's no process-group equivalent, so a kill instead shells out to `taskkill /pid <pid> /t /f`: real and recursive, but not atomic - a narrow race window exists that a real Windows Job Object would close. This project has no native/FFI dependency today to implement one, so `taskkill` is the honest fallback; a real Job Object is a tracked future enhancement. **The bounded SIGTERM-then-SIGKILL-after-a-grace-period escalation described above is POSIX-only, not a cross-platform guarantee:** this `taskkill` call runs synchronously with no timeout of its own, so a wedged or slow-to-terminate process tree can hold it open indefinitely, with no fixed bound the way the POSIX grace period provides.

A further identity gate applies specifically to the SIGKILL escalation on POSIX: right before the SIGTERM above is sent, ghantika snapshots the group's original membership - the leader plus every currently-live descendant, each one's pid and real OS-read start time - and, once the grace period has elapsed and the group is still alive, boundedly re-reads only those same recorded members. If any one of them still reports an exactly matching start time, the group is still the one this server spawned and the SIGKILL proceeds; if none matches, escalation is refused and no SIGKILL is ever sent, disclosed via an `escalation_refused_reason` field once the job reaches a terminal state. This narrows the residual described above materially, not completely: the check and the signal remain two separate syscalls, so a member proven alive an instant before the SIGKILL runs can still exit, and an unrelated group receiving the exact same recycled id within the same whole second could still read as a match - narrowed, never closed or eliminated. Any failure while making this observation - a timeout, an unreadable start time, malformed output, or capturing zero usable members at all - refuses escalation rather than defaulting to it; terminating the job is still attempted regardless (the SIGTERM already sent is not held hostage by an observation failure). When identity could not be confirmed at either this layer or the pre-signal check below, the earlier SIGTERM is honestly disclosed as an unconfirmed best-effort send, never as confirmed or guarded. **When that happens, the process group can still be genuinely alive even though the job itself already shows a terminal state** - calling `kill` again with the same job id re-checks whether that group has since become empty and completes the recovery if so, but it never sends another signal: by then this server can no longer confirm the tracked numeric id still names the same group it originally spawned rather than an unrelated one that has since reused it, so a group that still reads alive at that point stays a disclosed, unconfirmed residual instead of being signaled again.

Before signaling on POSIX, `kill` checks that the tracked pid is still genuinely the process this server spawned, against a birth identity captured asynchronously right after the job started - never awaited on `run`'s own response path, so a slow observer can't delay it. That comparison is platform-specific: on Linux it reads `/proc/<pid>/stat`'s own `starttime` field (a raw kernel counter, clock ticks since boot) directly and compares it for exact equality against the value captured at spawn, with no elapsed-time derivation at all - immune to the class of bug where `ps -o etime=`'s own boot-time/uptime conversion can go wrong inside a virtualized guest. On macOS, which has no `/proc` filesystem, the check compares a real, `ps`-observed elapsed lifetime against the captured one instead. Either way, a clear mismatch refuses to signal at all. Best-effort, not a cryptographic guarantee. When identity can't be verified at all, the group is still signaled via a degraded, disclosed path (`identity_confirmed: false`, see below). This check, and the confirmation below, are POSIX-only.

`identity_confirmed` reports only what a real, bounded external check actually observed - never more: whether the pre-signal identity check succeeded. `kill_confirmed` reports the same thing for the ordinary case - `true` once an independent read of the process table finds no processes still assigned to the job's original process group (never a whole-tree or zero-surviving-descendants guarantee), `false` if that couldn't be confirmed in time - plus one further case with no external check at all: a job that never actually spawned a process group in the first place (an invalid cwd, an unresolvable executable, a policy denial, a genuine async spawn failure, being cancelled while still queued, or still being queued when the server shuts down) settles `kill_confirmed` to `true` immediately as part of its own creation or terminal transition, since there is nothing to check; such a job never reads `false`, and this holds on every platform, including Windows. On the default path (no signal, or an explicit SIGTERM) for a job that actually spawned, both fields settle once the corresponding signal attempt has run its course - typically the same moment the job's `killed` state is reported synchronously, since a real signal getting through claims that state right then, but not always: when the group is already gone by the time the server reaches it, no signal is ever sent, and the job's own natural-exit terminal transition races independently against each field's own write. Either way both fields settle to a real, already-known result regardless of which lands first; a default-path job cancelled while still queued is the one exception, settling only `kill_confirmed`, since no process ever existed for `identity_confirmed` to describe. A caller-supplied signal other than SIGTERM is different: a signal with no termination guarantee (SIGSTOP, for instance) only reaches `killed` once confirmation actually lands - the job stays reachable for a follow-up kill until then. A signal that cannot be caught or ignored, like an explicit SIGKILL, is different - though that is not the same as guaranteeing the process actually dies on receipt: a process wedged in uninterruptible sleep does not die on receipt, and a zombie is already unkillable because it is already dead. Ordinarily, though, the real process can also exit on its own the moment the signal lands, independent of confirmation, so the job's `killed` state can legitimately show up before confirmation ever resolves, while `kill_confirmed`/`identity_confirmed` stay simply absent - never `false` - until confirmation actually lands. A terminal record whose leader already exited on its own gets a cleanup reap that sets only `kill_confirmed`, since it never re-runs the identity check.

**Escape boundary:** a descendant that calls setsid() or otherwise moves itself into a different process group is neither signaled by this containment nor observed by its confirmation check; reparenting alone is not such an escape, since reparenting changes a process's parent, never its process group. If your command spawns a process that detaches into its own group or session, you are responsible for tracking and terminating it yourself - this tool will not, and does not claim to.

Sending ghantika a line over stdin that isn't valid JSON gets a real JSON-RPC `-32700` Parse error reply (`id: null`), and the connection keeps working normally afterward - the next request is served on its own merits. That's the conventional JSON-RPC behavior, but it isn't automatic here: ghantika adds it on top of its underlying MCP SDK, which on its own silently discards a line that fails to parse rather than replying to it. If you're writing a client and a malformed message you send gets no reply at all, that's a bug on your side, not ghantika staying quiet on purpose.

## Development

Requires Node.js 22 or newer. Every install after cloning goes through `npm ci`, never `npm install`, so everyone gets the exact dependency tree recorded in `package-lock.json`:

    npm ci
    npm run build
    npm test
