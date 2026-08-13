# Wake support, by client

This is a record of which clients ghantika has actually been observed waking an idle agent on, through what mechanism, under what conditions, and how you can check it yourself. A cell here is `worked`, `did-not-work`, or `not-tested` - never a guess carried over from a different client, even a close one. Where we have not run something, this says so plainly.

**The poll floor always works, on every client, with no setup.** Every one of ghantika's seven tools (`run`, `status`, `list`, `output`, `tail`, `kill`, `follow`) answers over plain polling regardless of anything in this document - a client that never sets a single environment variable still gets correct results from a job it started, it just has to ask. Everything below is about whether, in addition to that, an idle agent can be resumed automatically once a job finishes. Nothing here is required for correctness; where a row says `not-tested` or describes a constraint, the worst case is that you fall back to polling, which is where every client already starts.

## Claude Code

### The client's own background-and-resume for long MCP calls

**Status: `worked`.** This is not ghantika code - it's a behavior Claude Code itself applies to any MCP tool call, on any server, once you configure it. Ghantika reaches it through the `follow` tool, which is built to hold a call open until a job produces new output, finishes, or a timeout elapses - a call short enough to return immediately is never eligible.

**What it needs, and this is a setup condition, not a limit of the mechanism.** Two environment variables, set in the environment the client itself is launched with (not just a shell you later open a terminal in - a GUI app launch on macOS does not inherit your shell's environment) plus a restart of the client:

- `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` - a duration in milliseconds. Set it to a positive value below the client's own MCP call timeout (`MCP_TOOL_TIMEOUT`) - check your installed client for the current default rather than assuming one, since it is not something this document pins a number to. In an **interactive** session this one variable is enough on its own.
- `CLAUDE_AUTO_BACKGROUND_TASKS=1` - required **in addition**, only in a **non-interactive** session (a subagent or background-task turn). Without it there, the wake silently never fires even with the first variable set correctly. If you are not sure which kind of session you are in, set both - a session that does not need the second one simply ignores it.

At stock settings, with neither variable set, this mechanism cannot fire at all - that is the default, not a bug.

**What a successful wake looks like.** A `follow` call that would otherwise still be waiting past the configured threshold returns a message telling you the call moved to the background and that you will be notified when it completes - the wording observed was:

    MCP tool "ghantika/follow" is still running after 1s. It was moved to the
    background as task <id> and keeps running; you'll receive a notification
    with the result when it completes.

Some real time later, a notification carrying the job's terminal state (exit code, timestamps, reason) arrives and resumes the agent with no human input - the same session, no new prompt from you.

**How to reproduce it yourself.** Set both variables in the client's launch environment, restart the client, then in a fresh session call `run` with a command that outputs nothing for longer than your configured threshold (a plain `sleep` past the threshold works), followed immediately by `follow` on that job's id with a `timeout_ms` comfortably longer than the sleep. If the threshold is crossed, the background-and-notify behavior above is what you should see.

**Observed:** 2026-08-12, ~03:51-03:52 UTC, via ghantika's own `follow` tool against a live Claude Code session, with `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=1000` and `CLAUDE_AUTO_BACKGROUND_TASKS=1` both set.

**Open question, disclosed rather than explained away.** The very first `follow` call past the threshold in a fresh session did not background - it returned inline after holding the call open for the full duration, as if no threshold were configured. A same-parameter replication on a session that was no longer making its first call did background correctly. The one difference identified is "first call of the session," which is a real candidate but not confirmed as the cause; nothing here should be read as explaining it. If it turns out to be real, the practical consequence is that the very first long call an agent makes in a session may not get the accelerator even with everything configured correctly - worth knowing since it would be the least visible time to lose it, but the poll floor covers it exactly as it covers everything else.

## Codex

Codex is covered here as **the desktop app, with a session actually open in a window** - the thing this section describes is a resume of an idle session, and a single-shot CLI invocation that exits after one turn has no idle session for anything to resume. If you're driving Codex through its CLI in a non-interactive, single-shot way, this section does not apply to you and the poll floor is what you have; that's a difference in what there is to wake, not a gap in support.

### Ghantika's own app-server wake

**Status: `worked`.** Unlike the Claude Code mechanism above, this one is ghantika's own code: when a job Codex started finishes, ghantika sends a message over the same app-server protocol Codex's own tooling already uses, aimed at the thread that started the job.

**What it needs.** `GHANTIKA_WAKE_TRANSPORT_ENABLED=1` set in the ghantika server's own environment - this is server-side configuration, not something a client sets. Unset by default, so this is inert unless you turn it on.

**What a successful wake looks like.** The thread that started the job receives a new turn whose content names the finished job and points at the tools to read its result:

    ghantika job <id> reached exited - use status/output/tail to read the result

**Durability, and why it matters more here than it would elsewhere.** This route rides Codex's own versioned, published app-server protocol - the same interface Codex's own tooling is built on. It is not expected to break silently on a routine Codex update the way an integration against undocumented internals would.

**How to reproduce it yourself.** Set `GHANTIKA_WAKE_TRANSPORT_ENABLED=1` in the environment ghantika's own server runs in, connect from a live Codex desktop session with a thread open, and call `run` with a command that takes a while (a plain `sleep` is enough) followed by anything else - you don't need to call `follow` or hold a tool call open for this route, since the wake is ghantika telling Codex directly once the job ends. Once the job exits, watch the thread for a new turn shaped like the one above; expect it to take up to a few minutes rather than arriving instantly, per the latency note below.

**Observed:** 2026-08-12, 04:19-04:23 UTC, two separate jobs, each delivered as its own turn into a live Codex desktop session. Terminal-to-turn latency was measured at approximately 64 seconds for the first job and 151.7 seconds for the second - disclosed because a cell reading simply "works" would leave you expecting something closer to instant, and the two and a half minutes on the second run is a real, unexplained result rather than an outlier we've excluded. Neither this record nor anyone who has looked at it has attributed the delay to a specific cause; it could be Codex's own scheduling, this transport, or something else.

### Ghantika's own desktop-IPC wake

**Status: `not-tested`**, through ghantika's own delivery path specifically - the underlying same-machine call this route depends on has been separately demonstrated to reach a live Codex session by other means, but no observed run has exercised it through ghantika's own job-finishes-therefore-wake logic end to end. Marking this `worked` on the strength of the adjacent demonstration would be exactly the cross-context inference this document exists to avoid, so it stays `not-tested` until that specific run happens.

**The constraint, stated because it applies regardless of whether this route has been exercised yet, and because it is not something more setup fixes.** This route can only reach a thread that is currently open in a window. A thread that is backgrounded or closed cannot be reached by it - that is an ownership check enforced by the client itself, and it is the design, not a bug, a missing feature, or something you configure your way past. If you rely on this route and a wake does not happen, check whether the thread was open at the time before treating it as a defect.

**Durability, and this is the asymmetry worth knowing before you depend on either Codex route.** Where the app-server route above rides a versioned, published protocol, this one reaches into the desktop app's own internal, undocumented surface - the kind of integration point that has already moved once across a shipped update in the past. It is not built on anything Codex commits to keeping stable, so treat it as the more fragile of the two, more likely to need attention after a Codex update, and prefer the app-server route where either would do.

## Every other MCP client

Cursor, Cline, Claude Desktop, and any other client that speaks MCP: **`not-tested`**, for any wake mechanism. None of the routes above have been exercised against any of them. The poll floor works identically on all of them regardless - it needs nothing client-specific, which is the whole point of it being the floor rather than one more thing to configure.
