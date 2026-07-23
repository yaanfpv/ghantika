# ghantika

> 🚧 **Early days.** This is a young project moving fast. The background command runner and all six tools (run, status, list, output, tail, kill) are real and tested today, driven by polling. The Tasks-extension wake this README also describes is where the project is headed, not something wired in yet (see Roadmap); treat anything else you hit that feels rough as exactly that, not a hidden gap.

**Ghantika runs a command in the background and rings the moment it's done, so your agent can kick off something long and keep working instead of sitting on it.**

[![CI](https://github.com/yaanfpv/ghantika/actions/workflows/ci.yml/badge.svg)](https://github.com/yaanfpv/ghantika/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-6f42c1.svg)](https://modelcontextprotocol.io)

Ask an AI agent to do something that takes a while (a build, a render, a big upload, a training run) and today it does one of two annoying things. It either checks in on the job every few seconds, burning tokens on every single check, or it just blocks and sits there doing nothing else until the command finally exits.

Ghantika fixes that. Hand it a command, and it starts running in the background immediately, no blocking. The agent gets a job id back and is free to do other things. The moment that command produces output or finishes, ghantika rings, and the agent picks the thread back up exactly where it left off.

**Set it up once, use it everywhere.** It's a standard [MCP](https://modelcontextprotocol.io) server over stdio, so every client that speaks MCP can start jobs and read them back with the same six tools, by polling. The ring itself is where this is headed: a host getting woken directly the moment a job changes, via the MCP Tasks extension, instead of asking. Every client reads the same jobs the same way today, and the job runs regardless of whether anything is watching.

---

## What you can do with it

**Kick off a build and keep working.** "Run the test suite in the background, and let me know the second it's done." Your agent starts it, moves on to something else, and comes back the moment ghantika rings, with the exit code and the output already in hand.

**Chain a pipeline that has no business blocking your agent.** Render a scene, encode the output, upload it, wait for processing, publish it. Every long step in that chain is a command ghantika runs and rings on, so the agent never sits idle between them.

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

From there the agent stays in sync with the job today by polling: `status` for the job's current state and exit info, `output` or `tail` for what it's written so far. A direct ring on a Tasks-capable host, the moment the job produces output or exits instead of the agent having to ask, is planned and not wired in yet (see Roadmap). Either way the job itself is real and unaffected: it's running under ghantika's management from the moment `run` returns, whether or not anything is currently watching it.

A job's output is captured as it happens, stdout and stderr tracked separately, so `output` and `tail` read what the process has actually written rather than a snapshot from whenever you happened to ask. Every line, on either stream, gets a number from one counter shared across the whole job, so a merged read of both streams sorts by that number and recovers their real line-materialization order, no guessing at interleave required. Each stream still keeps its own bounded window of retained lines: the most recent 10,000 lines or 1 MiB, whichever it hits first, ordinary resident bytes always staying within that bound. The one exception is a single line that alone exceeds it: that line is kept whole (plus a little overhead for its own continuation marker) rather than being cut down further, so it briefly sits over the nominal cap on its own. The moment any further data starts arriving after that, the old oversized line is evicted to make room, exactly like any other old line - it's never left to coexist with new data that keeps growing on top of it. Once a stream starts dropping its oldest lines to stay inside the window, the response says so: a bounded count of how many of that stream's own lines are gone for good, plus the cursor boundary before which the drop happened, never which specific lines were lost. Reading the merged default discloses this per stream, independently, since the two streams are trimmed on their own schedules. Exact per-line gap disclosure is planned as a follow-up; either way the recent history is real and the old history is honestly reported as gone, never quietly missing.

A job also outlives any single check. Start it, go do something else, ask again on a much later tool call, and `status` still tells you exactly what happened, for as long as the same ghantika server process is up. Closing the MCP session is where that ends: stdin EOF or a shutdown signal reaps every live job before the server exits, and nothing about a job survives a restart, since the store is in memory and deliberately so.

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

Your agent starts the command, keeps working, and picks the result back up the moment it's ready. That's the whole experience.

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

Those `seq` values are the real per-line numbers, and they stay real whether you asked for one stream or left `stream` out for the merged default: every line, on either stream, draws from one counter shared across the whole job, so a merged `seq` is a line's true position in the job's real line-materialization order, not a separate axis. A response that had to drop old history from a stream carries `"truncated": true`, plus `"dropped"` (how many of that stream's own lines are gone for good) and `"droppedBeforeCursor"` (the boundary before which that happened) - never which specific lines were lost. Reading the merged default discloses this per stream: `"dropped": { "stdout": { "dropped": 3, "droppedBeforeCursor": 42 } }`, say, omitting either side that never lost anything. `"truncated": true` also shows up on its own when a call's own `limit` (or `tail`'s `lines`) left more already-available events undisclosed, distinct from a stream genuinely losing history - the two causes are never conflated. Exact per-line gap-range disclosure is planned as a follow-up. Feed `next_cursor` back as `output`'s `after_cursor` to read only what's new since last time.

`kill` stops a job that's still running. The pattern is: start it, do something else, check in by asking whenever it's actually relevant (a direct ring instead of asking is planned, see Roadmap).

</details>

## How it's different from what agents already have

Some agent runtimes ship a plain "run a command" tool. Here's what ghantika adds on top:

- A plain run-command tool blocks the whole turn until the process exits. Ghantika returns a job id immediately and the process keeps running regardless of whether anything is watching it.
- Backgrounding a process without a way to check on it later means the moment it finishes is lost the second your attention moves elsewhere. Ghantika keeps the job's state and output addressable by id for as long as the server is up, so `status`/`output`/`tail` answer correctly whenever you actually ask.
- A fixed sleep-and-recheck loop burns a full round trip on every guess at how long something takes. Ghantika answers on the job's real state, not on a timer you had to estimate up front; a direct ring on that state change, instead of waiting to be asked, is planned (see Roadmap).

The new part isn't running a command in the background, it's never having to choose between blocking on it and losing track of it.

## Configuration

The `run` tool takes:

| Argument  | Type               | Required | Meaning                                                                                                                                                                                                                                                                           |
| --------- | ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command` | string[] \| string | yes      | The command to run. An argv array by default; a shell string requires `shell: true`.                                                                                                                                                                                              |
| `shell`   | boolean            | no       | Run `command` as a shell string instead of an argv array.                                                                                                                                                                                                                         |
| `cwd`     | string             | no       | Working directory for the job. Defaults to ghantika's own.                                                                                                                                                                                                                        |
| `env`     | object             | no       | `{ "mode": "merge" \| "replace", "vars": { ... } }`. `vars` maps variable names to values. `merge` (the default) layers `vars` over a minimal base of `PATH` and `HOME`, or `PATH`, `SystemRoot` and `USERPROFILE` on Windows; `replace` passes `vars` alone with no base at all. |
| `label`   | string             | no       | A short, human-readable name for the job, surfaced in `list`.                                                                                                                                                                                                                     |

Ghantika never hands a job its own full environment. Even in `merge` mode the child starts from that minimal base and nothing else, so anything a command needs, it gets because you passed it.

`status`, `output`, and `tail` all take `job_id`. `tail` also takes an optional `stream` (`stdout`/`stderr`/`both`) and `lines`; `output` takes `stream` plus `after_cursor` and `limit` for paging through a long job incrementally. `kill` takes `job_id`. Every tool's full input schema is advertised over `tools/list`, so an agent (or you) can always ask ghantika directly rather than trusting a doc that's drifted out of date.

## Roadmap

- The wake described above, end to end: the MCP Tasks extension is what makes ghantika ring an agent directly rather than requiring a poll, and wiring it in is next.
- Native Windows process-tree kill via a real Job Object, closing the narrow race window `taskkill` leaves open (see Platform notes below).
- A documented, stable extension point for anything that needs to react to a job the moment it changes, beyond the built-in six tools.

## Contributing

Contributions are welcome. The design is deliberately small, so open an issue before starting anything large and we'll figure out whether it belongs here. A worked recipe for a job people genuinely sit around waiting on is one of the most useful things you can bring.

## License

MIT. See [LICENSE](LICENSE). Built by [@YaanFPV](https://github.com/YaanFPV).

## Platform notes

On POSIX, killing a job sends a real signal to the job's whole process group at once, which is atomic - there's no window where part of the tree could be signaled and part not. On Windows, there's no process-group equivalent, so a kill instead shells out to `taskkill /pid <pid> /t /f`: a real, recursive kill of the whole process tree, but not atomic - a narrow race window exists that a real Windows Job Object would close. This project has no native/FFI dependency today to implement a Job Object correctly, so `taskkill` is the honest fallback rather than a claim of guarantees it doesn't provide; a real Job Object is a tracked future enhancement.

Sending ghantika a line over stdin that isn't valid JSON gets a real JSON-RPC `-32700` Parse error reply (`id: null`), and the connection keeps working normally afterward - the next request is served on its own merits. That's the conventional JSON-RPC behavior, but it isn't automatic here: ghantika adds it on top of its underlying MCP SDK, which on its own silently discards a line that fails to parse rather than replying to it. If you're writing a client and a malformed message you send gets no reply at all, that's a bug on your side, not ghantika staying quiet on purpose.

## Development

Requires Node.js 22 or newer. Every install after cloning goes through `npm ci`, never `npm install`, so everyone gets the exact dependency tree recorded in `package-lock.json`:

    npm ci
    npm run build
    npm test
