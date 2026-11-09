# Panorama for Windows — local starter

One dashboard for Claude Code and Codex sessions in VS Code, plus an experimental automatic monitor for ordinary Claude desktop chats, and manual tracking for other supported app windows.

This is a source-code starter, not a signed installer. The live event bridge and dashboard have been tested here. Windows-specific focus, capture and notification code still needs testing on your computer.

## Start

1. Install a current Node.js LTS release from https://nodejs.org/ if you do not already have it. Node.js 20 or newer is required. No npm packages or API keys are needed.
2. Extract this entire folder somewhere you plan to keep it, for example `C:\Tools\Panorama`. Do not run it from inside the ZIP.
3. Double-click **start.cmd**. It starts a local server and opens `http://127.0.0.1:4317`. Keep that terminal open.
4. Double-click **setup.cmd** once. This adds observer hooks to Claude Code and Codex settings, preserving existing settings and making timestamped backups. Restart both agents in VS Code. In Codex, review and trust the hooks in Hooks settings or `/hooks`, where available. You can inspect the generated hook commands first.
5. Send each agent a harmless prompt that reads a local file. Sessions should appear under **Overview** when the hooks fire. Open a session card, select its VS Code window, and click **Link window**.

Use **Test Windows pop-up** to check notification delivery. For an actual integration check, observe a genuine permission request in each agent; confirm that the corresponding card changes and clears once tool activity resumes. Do not assume a successful test pop-up proves the agent hooks are installed.

Use current agent versions with lifecycle-hook support. The setup targets the native Windows host. WSL, SSH, containers and remote agents require an additional bridge in the environment where the hooks execute. Organization-managed restrictions can prevent hooks from running; this starter does not change them.

## Automatic Claude desktop monitoring (new in 0.2)

Start Panorama and keep an ordinary Claude chat window open. Claude windows are discovered and linked automatically; no agent hook setup or manual status changes are required for this monitor. Under **Connect agents → Windows preferences**, the **Automatically monitor Claude desktop windows** switch enables or disables it. It starts enabled each time the server runs.

The monitor samples Windows UI Automation information locally, approximately every five seconds plus inspection time. It only inspects Claude process windows. It never clicks controls, sends a reply, invokes a tool, reads editor values, or accesses Claude's account/API.

- A visible, enabled **Stop response / Stop generating** button indicates Working.
- A recognized current input-status control indicates Input needed.
- Approval and denial buttons in the same recognized dialog indicate Permission needed.
- A question at the end of the latest semantically identified assistant response generates an amber **Possible reply needed** alert after two consistent samples. This is a heuristic and can misclassify rhetorical questions. Old/sidebar text and user messages are not searched for questions.
- A previously observed generation control disappearing, followed by two readable composer samples, indicates that a response appears Ready.
- Missing/unreadable controls, minimized windows, incomplete trees, or a recognized history-scroll view produce Unknown. They do not produce a guessed completion or an input alert.

Only the chat exposed in each app window is monitored. Other conversations hidden behind tabs or the sidebar cannot be observed. Keep the conversation at the latest message. Some app versions expose no useful message labels, in which case generation detection may work while question detection remains unavailable.

**Important:** the adapter and its detector logic have been implemented and tested against synthetic accessibility trees and a mocked Windows adapter. They have not been tested against a real Claude desktop accessibility tree on Windows here. Compatibility with your installed Claude version is therefore unverified. If a card stays Unknown, use **Download monitoring diagnostics** in that card to inspect the control labels. It exports locally, never automatically uploads. Review labels before sharing. `claude-profile.json` contains editable control names and message identifier prefixes; restart the server after changes. No hidden debug port, app launch flags, or approval policies are changed.

Raw accessibility samples stay in memory. Only short detected status/question summaries can appear in recent activity. The monitor does not save the whole chat, screenshots, or complete accessibility trees to disk. There are no API calls, tokens or usage charges.

## Everyday use

- **Overview:** sessions grouped by project, search and status filters, latest event excerpts, optional linked-window snapshots.
- **Needs you:** structured input requests and approval checks. Snooze for five minutes or mark reviewed. Replies and approvals stay in the original app.
- **App windows:** discover VS Code, Claude, ChatGPT, Codex and Windows Terminal windows. Claude app windows are monitored automatically. Other desktop chats can be tracked manually when they have no integration.
- **Open window:** bring the linked window forward. Windows may prevent foreground activation; in that case its taskbar button flashes. Select the conversation tab inside the app yourself.
- **Refresh preview:** capture a best-effort snapshot of the linked window. Optional automatic refresh runs every 15 seconds while this page is open. Minimized windows must be restored; GPU-rendered windows may return a blank frame. No OCR is performed. Images remain in memory on this computer, and are not saved to disk or sent to a model.
- **Native pop-ups:** input and approval alerts can appear while the dashboard page is closed, provided its server is running. Windows notification settings or Do not disturb may suppress them. A notification click opens the linked window, or the dashboard if no window is linked. Completion-only events do not trigger pop-ups.

## Honest status semantics

| Status | Evidence |
| --- | --- |
| Working | A prompt or tool activity was observed. This is not a continuous heartbeat. |
| No recent signal | A previously working session has emitted no event for over ten minutes. It is not automatically classified as stuck or waiting. |
| Input needed | A recognized structured question tool was called, or a supported Claude input notification arrived. |
| Approval requested | A PermissionRequest hook fired. Another hook or policy can still resolve the request automatically. The notification is delayed briefly, and later tool activity clears it. |
| Permission needed | Claude's delayed permission notification indicates that its prompt is waiting. |
| Ready | A response ended. The overall task may still be unfinished; a question written only in final prose is shown here, rather than classified by an LLM. |
| Possible reply needed | A heuristic question detector matched the latest readable Claude app assistant response. |
| Unknown | No reliable event or readable app controls, or a manually tracked window. |

Distinct hook session IDs are kept separate even when agents share a project folder. The dashboard does not retroactively discover every old conversation, reconstruct transcripts, select exact conversation tabs, or monitor chats hidden behind tabs. Claude app detection depends on exposed accessibility controls; ChatGPT desktop input detection is not implemented. A window snapshot is a view of the application, not a separate snapshot for every chat tab.

## Settings and data

The server listens only on `127.0.0.1`, not your network interface. Local API calls use separate random keys for hooks and dashboard access, plus Host/Origin checks. No cloud service, external fonts, analytics or API key is used.

Local metadata is kept under `%USERPROFILE%\.panorama`:

- `state.json`: session summaries, truncated prompt/response excerpts and recent activity. Full transcript files are not read, and raw tool commands are not retained.
- `bridge.json`: a locally generated hook authentication key and port. Do not share this file. It is regenerated when the server starts.

Bindings to window handles are deliberately cleared after a server restart. Old hook statuses become Unknown until a new event arrives. Notification and Claude-monitor preferences apply to the current run. Automatic Claude app cards are rediscovered on restart.

Hooks are merged into `%USERPROFILE%\.claude\settings.json` and `%USERPROFILE%\.codex\hooks.json`. Backups sit beside those files with `.panorama-backup-<timestamp>` suffixes. Existing hooks and approval settings are preserved. The observer always returns `{}` and exits successfully; it does not approve, deny, or rewrite any agent tool call. Reporter calls are capped at about 1.2 seconds when the helper is unavailable.

To remove only Panorama's observer hooks, run `node setup-hooks.cjs --remove`, then restart your agents. Close the terminal to stop Panorama. Nothing is installed as a service or enabled at Windows startup. Keep the folder in place while hooks reference it; rerun setup after moving it.

If port 4317 is already occupied, set a different port before starting, for example in PowerShell: `$env:PANORAMA_PORT=4318; node server.cjs`. The reporter reads the actual port from the local bridge file.

## Validation and limitations

Run `node --test test/*.test.cjs`. Tests cover session identity, explicit-question detection, completion versus attention, approval auto-resolution, snooze deduplication, event ordering, stale state, restarts, idempotent hook merges, API authentication and cross-origin checks, the actual reporter-to-server path, and native-window binding validation with a mocked Windows adapter.

The browser layout, session detail panel and search were also checked using fixed local QA fixtures. The live reporter-to-server path was verified by the automated integration tests. Additional tests cover automatic Claude window discovery, explicit controls, tentative questions, history exclusion, ambiguous states, snooze deduplication and monitoring preferences. These automated tests do not execute Windows APIs. The Windows helper is unverified on Windows in this build; preview quality and app-specific hook coverage must be checked on your PC. A successful UI or event test does not establish native capture or notification delivery. Test and restart the VS Code extensions after installing the hooks. Older clients may lack the required hook events or exec-form support; check their current documentation and update before using this configuration.

## Sources checked 5 November 2026

- Claude Code hook reference: https://code.claude.com/docs/en/hooks
- Claude Code settings scopes: https://code.claude.com/docs/en/settings
- Official OpenAI lifecycle hooks: https://learn.chatgpt.com/docs/hooks
- Official OpenAI notification behavior: https://learn.chatgpt.com/docs/notifications

## Files

`server.cjs` runs the local server. `lib/state.cjs` maps hook events into session state. `hooks/report.cjs` forwards events. `setup-hooks.cjs` merges or removes observer hooks. `native/windows.ps1` supplies window discovery, focus, capture and notification code. `ui/index.html` is the dashboard.

Windows UI Automation reference: https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/obtaining-ui-automation-elements
