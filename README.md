# ghantika

> 🚧 **Early days.** This is a young project moving fast. The background command runner and all six tools (run, status, list, output, tail, kill) are real and tested today, driven by polling. The Tasks-extension wake this README also describes is real too, not just on the way: a client that declares `io.modelcontextprotocol/tasks` in its `capabilities.extensions` bag gets pushed a notification as a job's output arrives, coalesced into one notification per short window rather than one per arrival, on top of the same poll floor, which stays authoritative either way. A client that declares only the older, SDK-deprecated `capabilities.tasks` shape does not get this notification - the poll floor is what it has. The terminal transition itself fires no notification - a client learns a job is done through the ordinary poll surface, same as any other status change. This has been driven end to end against the pinned MCP SDK's own client capabilities using that declaration; whether a real, separately-authored MCP host resumes automatically on that notification is disclosed as pending, verifiable only once such a host exists to test against. Treat anything else you hit that feels rough as exactly that, not a hidden gap.

**Ghantika runs a command in the background and rings as its output arrives, so your agent can kick off something long and keep working instead of sitting on it.**

[![CI](https://github.com/yaanfpv/ghantika/actions/workflows/ci.yml/badge.svg)](https://github.com/yaanfpv/ghantika/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-6f42c1.svg)](https://modelcontextprotocol.io)

Ask an AI agent to do something that takes a while (a build, a render, a big upload, a training run) and today it does one of two annoying things. It either checks in on the job every few seconds, burning tokens on every single check, or it just blocks and sits there doing nothing else until the command finally exits.

Ghantika fixes that. Hand it a command, and it starts running in the background immediately, no blocking. The agent gets a job id back and is free to do other things. The moment that command produces output, ghantika rings, and the agent picks the thread back up exactly where it left off.

**Set it up once, use it everywhere.** It's a standard [MCP](https://modelcontextprotocol.io) server over stdio, so every client that speaks MCP can start jobs and read them back with the same six tools, by polling. A client that declares `io.modelcontextprotocol/tasks` in its `capabilities.extensions` bag gets more than that: ghantika wakes it directly as new output arrives, instead of it having to ask. Declaring only the older, SDK-deprecated `capabilities.tasks` shape does not reach this - polling is what that client has. Every client reads the same jobs the same way, and the job runs regardless of whether anything is watching.

---

## What you can do with it

**Kick off a build and keep working.** "Run the test suite in the background, and let me know the second it's done." Your agent starts it, moves on to something else, and gets woken as the test output arrives; once the suite exits, a poll picks up the exit code and the rest of the output.

**Chain a pipeline that has no business blocking your agent.** Render a scene, encode the output, upload it, wait for processing, publish it. Every long step in that chain is a command ghantika runs, waking the agent as each one produces output, so it never sits idle between them.

And plenty more, across every kind of user:

| Recipe                            | Who it's for         | What it runs in the background                |
| --------------------------------- | -------------------- | --------------------------------------------- |
| A self-running agent team         | agent builders       | each teammate's own wait for the next message |
| ComfyUI render to published video | AI artists, creators | the render, then the upload's processing      |
| Wait for CI to go green           | developers           | a pull request's checks running to completion |
| Wait for a big download or export | everyone             | the download or export itself                 |
| Wait for a training run to finish | ML engineers         | the whole run, hours if it takes hours        |

## How it works

You give ghantika a command, the same way you'd type it in a terminal: an argv array, or a shell string if you need pipes and redirects. It starts that command as a real background process and hands back a job id right away, before the command has necessarily produced anything at all. Nothing about calling `run` blocks.

From there the agent stays in sync with the job by polling: `status` for the job's current state and exit info, `output` or `tail` for what it's written so far. On a Tasks-capable connection, ghantika also rings directly the moment the job produces output, instead of the agent having to ask - the poll floor sits underneath it unchanged either way (`status`/`output`/`tail` behave identically whether or not a client is watching for the wake, aside from job ids, timestamps, and a handful of fields whose presence depends on timing regardless of the wake). The terminal transition itself fires no notification; a client learns a job is done the same way it learns anything else, by polling. Either way the job itself is real and unaffected: it's running under ghantika's management from the moment `run` returns, whether or not anything is currently watching it.

A job's output is captured as it happens, stdout and stderr tracked separately, so `output` and `tail` read what the process has actually written rather than a snapshot from whenever you happened to ask. Every line, on either stream, gets a number from one counter shared across the whole job, so a merged read of both streams sorts by that number and recovers their real line-materialization order, no guessing at interleave required. Each stream still keeps its own bounded window of retained lines: the most recent 10,000 lines or 1 MiB, whichever it hits first, ordinary resident bytes always staying within that bound. The one exception is a single line that alone exceeds it: that line is kept whole (plus a little overhead for its own continuation marker) rather than being cut down further. The append that creates that line can also leave up to almost another full line-cap's worth of not-yet-terminated data sitting alongside it, so resident bytes can genuinely peak near double the nominal cap for the duration of that one append - never indefinitely. The next separate append with no new line completing evicts the old oversized line to make room, exactly like any other old line; it's never left to coexist with new data that keeps growing on top of it across further, separate reads. Once a stream starts dropping its oldest lines to stay inside the window, the response says so: a bounded count of how many of that stream's own lines are gone for good, plus the cursor boundary before which the drop happened, never which specific lines were lost. Reading the merged default discloses this per stream, independently, since the two streams are trimmed on their own schedules. Exact per-line gap disclosure is planned as a follow-up; either way the recent history is real and the old history is honestly reported as gone, never quietly missing.

A job also outlives any single check. Start it, go do something else, ask again on a much later tool call, and `status` still tells you exactly what happened, for as long as the same ghantika server process is up. Closing the MCP session is where that ends: stdin EOF or a shutdown signal reaps every live job before the server exits, and nothing about a job survives a restart, since the store is in memory and deliberately so.

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

Your agent starts the command, keeps working, and gets woken as output arrives - including one final wake for anything still pending the moment the job finishes. Completion itself, and the exit code, are confirmed by an ordinary poll, same as any other status check. That's the whole experience.

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

Those `seq` values are the real per-line numbers, and they stay real whether you asked for one stream or left `stream` out for the merged default: every line, on either stream, draws from one counter shared across the whole job, so a merged `seq` is a line's true position in the job's real line-materialization order, not a separate axis. A response that had to drop old history from a stream carries `"truncated": true`, plus `"dropped"` (how many of that stream's own lines are gone for good) and `"droppedBeforeCursor"` (the boundary before which that happened) - never which specific lines were lost. Reading the merged default discloses this per stream: `"dropped": { "stdout": { "dropped": 3, "droppedBeforeCursor": 42 } }`, say, omitting either side that never lost anything. `"truncated": true` also shows up on its own when a call's own `limit` (or `tail`'s `lines`) left more already-available events undisclosed, distinct from a stream genuinely losing history - the two causes are never conflated. Exact per-line gap-range disclosure is planned as a follow-up. Feed `next_cursor` back as `output`'s `after_cursor` to read only what's new since last time - but only when reusing it with the SAME `stream` selection that produced it: a cursor only proves what its own selection disclosed, so reusing a single-stream cursor after switching to a different `stream` value (or to `both`) can skip an already-retained event on the other stream. Start from `after_cursor:0` (or omit it) instead when you change selections.

`kill` stops a job that's still running. The pattern is: start it, do something else, check in by asking whenever it's actually relevant - or, on a Tasks-capable connection, let ghantika ring you directly instead of asking at all.

</details>

## How it's different from what agents already have

Some agent runtimes ship a plain "run a command" tool. Here's what ghantika adds on top:

- A plain run-command tool blocks the whole turn until the process exits. Ghantika returns a job id immediately and the process keeps running regardless of whether anything is watching it.
- Backgrounding a process without a way to check on it later means the moment it finishes is lost the second your attention moves elsewhere. Ghantika keeps the job's state and output addressable by id for as long as the server is up, so `status`/`output`/`tail` answer correctly whenever you actually ask.
- A fixed sleep-and-recheck loop burns a full round trip on every guess at how long something takes. Ghantika answers on the job's real state, not on a timer you had to estimate up front, and a client declaring the Tasks extension URI (see above) gets rung as new output arrives instead of having to ask.

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

`status`, `output`, and `tail` all take `job_id`. `tail` also takes an optional `stream` (`stdout`/`stderr`/`both`) and `lines`; `output` takes `stream` plus `after_cursor` and `limit` for paging through a long job incrementally. `kill` takes `job_id`. Every tool's full input schema is advertised over `tools/list`, so an agent (or you) can always ask ghantika directly rather than trusting a doc that's drifted out of date.

## Roadmap

- Native Windows process-tree kill via a real Job Object, closing the narrow race window `taskkill` leaves open (see Platform notes below).
- A documented, stable extension point for anything that needs to react to a job the moment it changes, beyond the built-in six tools.

## Contributing

Contributions are welcome. The design is deliberately small, so open an issue before starting anything large and we'll figure out whether it belongs here. A worked recipe for a job people genuinely sit around waiting on is one of the most useful things you can bring.

## License

MIT. See [LICENSE](LICENSE). Built by [@YaanFPV](https://github.com/YaanFPV).

## Platform notes

On POSIX, killing a job signals its whole process group in one group-addressed operation: SIGTERM, then SIGKILL after a grace period if anything is still alive. A caller-supplied signal other than SIGTERM is sent exactly once, with no automatic escalation. That grace period carries its own disclosed, unclosed residual: the group can fully empty during the wait - its ordinary, intended outcome - and have its numeric id recycled by an unrelated later group before the pre-SIGKILL existence check that follows the wait actually runs. That check narrows the window between "still alive" and "about to send SIGKILL" as far as an existence check can, but cannot close it, since existence alone cannot tell a survived original group apart from a coincidentally-reused one; a SIGKILL sent in that narrow window would land on whichever, if anything, has since taken the group's number. This is distinct from the eager-reap gap described next: it only arises on a job actually signaled while still alive, spans up to the whole grace period rather than a single scheduling tick, and is not addressed by the once-per-job reap guard below, which prevents only a later `kill` call from re-signaling, not a reused id hit within this same escalation. A job whose leader already exited on its own (without waiting on children it forked) is reaped automatically the instant that exit is observed, not only when a caller later calls `kill`. While the group still holds a member, the OS cannot recycle its id, so a group with surviving descendants is still provably the one this server spawned at the moment the exit is observed - but that continuity only holds until the last member leaves. Where the leader has no surviving descendants, it IS the last member, so the group empties at exactly the exit being observed, and no continuity carries through to this server's own callback. The residual this leaves is the gap between the group's last member exiting and that callback actually running its existence check: normally very short, but with no fixed upper bound, since it is ordinary event-loop scheduling latency that a busy event loop can stretch well past what "scheduling" suggests - deliberately not stated as a wall-clock tolerance, unlike the several-second birth-identity window above. A reap is attempted at most once per job; once it has run, a later `kill` call against that job sends no further signal, so it can never itself land on a reused id. On Windows, there's no process-group equivalent, so a kill instead shells out to `taskkill /pid <pid> /t /f`: real and recursive, but not atomic - a narrow race window exists that a real Windows Job Object would close. This project has no native/FFI dependency today to implement one, so `taskkill` is the honest fallback; a real Job Object is a tracked future enhancement.

A further identity gate applies specifically to the SIGKILL escalation on POSIX: right before the SIGTERM above is sent, ghantika snapshots the group's original membership - the leader plus every currently-live descendant, each one's pid and real OS-read start time - and, once the grace period has elapsed and the group is still alive, boundedly re-reads only those same recorded members. If any one of them still reports an exactly matching start time, the group is still the one this server spawned and the SIGKILL proceeds; if none matches, escalation is refused and no SIGKILL is ever sent, disclosed via an `escalation_refused_reason` field once the job reaches a terminal state. This narrows the residual described above materially, not completely: the check and the signal remain two separate syscalls, so a member proven alive an instant before the SIGKILL runs can still exit, and an unrelated group receiving the exact same recycled id within the same whole second could still read as a match - narrowed, never closed or eliminated. Any failure while making this observation - a timeout, an unreadable start time, malformed output, or capturing zero usable members at all - refuses escalation rather than defaulting to it; terminating the job is still attempted regardless (the SIGTERM already sent is not held hostage by an observation failure). When identity could not be confirmed at either this layer or the pre-signal check below, the earlier SIGTERM is honestly disclosed as an unconfirmed best-effort send, never as confirmed or guarded. **When that happens, the process group can still be genuinely alive even though the job itself already shows a terminal state** - calling `kill` again with the same job id is the real recovery path, since it runs a fresh identity check against that same group and can genuinely signal or reap it, rather than finding nothing left to retry.

Before signaling on POSIX, `kill` checks that the tracked pid is still genuinely the process this server spawned, comparing its real elapsed lifetime against a birth identity captured asynchronously right after the job started - never awaited on `run`'s own response path, so a slow `ps` can't delay it. A clear mismatch refuses to signal at all. Best-effort, not a cryptographic guarantee. When identity can't be verified at all, the group is still signaled via a degraded, disclosed path (`identity_confirmed: false`, see below). This check, and the confirmation below, are POSIX-only.

`kill_confirmed` and `identity_confirmed` report only what a real, bounded external check actually observed - never more. `kill_confirmed`: `true` once an independent read of the process table finds no processes still assigned to the job's original process group - never a whole-tree or zero-surviving-descendants guarantee; `false` if that couldn't be confirmed in time. `identity_confirmed`: whether the pre-signal identity check succeeded. On the default path (no signal, or an explicit SIGTERM), the job's `killed` state is reported synchronously, and both fields are set once the job reaches that terminal state. A caller-supplied signal other than SIGTERM is different: a signal with no termination guarantee (SIGSTOP, for instance) only reaches `killed` once confirmation actually lands - the job stays reachable for a follow-up kill until then. A signal that cannot be caught or ignored, like an explicit SIGKILL, is different - though that is not the same as guaranteeing the process actually dies on receipt: a process wedged in uninterruptible sleep does not die on receipt, and a zombie is already unkillable because it is already dead. Ordinarily, though, the real process can also exit on its own the moment the signal lands, independent of confirmation, so the job's `killed` state can legitimately show up before confirmation ever resolves, while `kill_confirmed`/`identity_confirmed` stay simply absent - never `false` - until confirmation actually lands. A terminal record whose leader already exited on its own gets a cleanup reap that sets only `kill_confirmed`, since it never re-runs the identity check.

**Escape boundary:** a descendant that calls setsid() or otherwise moves itself into a different process group is neither signaled by this containment nor observed by its confirmation check; reparenting alone is not such an escape, since reparenting changes a process's parent, never its process group. If your command spawns a process that detaches into its own group or session, you are responsible for tracking and terminating it yourself - this tool will not, and does not claim to.

Sending ghantika a line over stdin that isn't valid JSON gets a real JSON-RPC `-32700` Parse error reply (`id: null`), and the connection keeps working normally afterward - the next request is served on its own merits. That's the conventional JSON-RPC behavior, but it isn't automatic here: ghantika adds it on top of its underlying MCP SDK, which on its own silently discards a line that fails to parse rather than replying to it. If you're writing a client and a malformed message you send gets no reply at all, that's a bug on your side, not ghantika staying quiet on purpose.

## Development

Requires Node.js 22 or newer. Every install after cloning goes through `npm ci`, never `npm install`, so everyone gets the exact dependency tree recorded in `package-lock.json`:

    npm ci
    npm run build
    npm test
