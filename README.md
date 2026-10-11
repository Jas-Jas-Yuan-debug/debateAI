# Debate AI Chamber

[![Tests](https://github.com/Jas-Jas-Yuan-debug/debateAI/actions/workflows/test.yml/badge.svg)](https://github.com/Jas-Jas-Yuan-debug/debateAI/actions/workflows/test.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

A local British Parliamentary debate using models from your configured API, with five independent AI judges. The chief judge chooses the motion. Follow the speeches, points of information, and individual ballots in the browser, then download the transcript. GPT‑6.1 Sol and GPT‑6 Astra are the initial selections.

## Run

Requires Node.js 22 or later. No project dependencies need to be installed.

```sh
git clone https://github.com/Jas-Jas-Yuan-debug/debateAI.git
cd debateAI
cp .env.example .env
```

Edit `.env` to set `BASE_URL` to your OpenAI-compatible gateway. Supply `API_KEY` in the server's environment, or set `API_KEY_FILE` to an owner-only file outside this checkout containing just the key. On macOS, an appropriate location is `~/Library/Application Support/debateAI/gateway-key`: keep its directory mode `0700` and the file mode `0600`. Do not put the key in `.env`; older configurations must move it to external storage. Environment credentials take precedence over `API_KEY_FILE`. The example defaults to a gateway at `http://127.0.0.1:8317/v1`; start that gateway separately. This repository does not include a gateway, API credentials, model weights or model access.

```sh
npm start
```

On macOS, double-click `Start Debate.command` to start the server and unlock your browser. With `npm start`, open the private `operator-login.html` file whose path the server prints. It supplies a random per-server owner access code through a POST body; the public website and readiness endpoint never disclose it. The unlocked app uses [127.0.0.1:3417](http://127.0.0.1:3417), the exact loopback address the server binds. The localhost homepage redirects there. Choose **Start debate**. Saved rounds stay in the local `data/` directory.

Every API read, export, event subscription and round action requires owner authentication, in addition to Host and browser-origin checks. The private access files are in an owner-only `.runtime/` directory and change each time the server starts. The browser keeps its access code in memory and optional session storage for this origin, using Authorization headers for requests, streams and downloads. It is never put in a URL or a cross-port localhost cookie. Refresh preserves access in the same tab; open the private access file again for a new browser session or after a server restart. The gateway key stays on the server. Local processes running as the same OS account and able to read owner-only files are trusted.

The gateway must support `GET /models` and `POST /chat/completions`. Selected models must return text and follow the requested JSON schemas. Streaming uses Chat Completions SSE; an ordinary JSON response is also accepted. Default model names refer to the original gateway setup; choose the model IDs available from your own gateway. Higher reasoning effort is available only when the selected gateway and model support it.

The setup form loads model choices from the gateway's `/models` endpoint using that server-side key. Choose a model for each of the four teams and five judge seats, then select which judge is chief. **Refresh models** reloads the list. Known image and other non-chat model families are omitted. A listed model still needs to support chat completions and the structured responses used by this app.

Model settings apply to a new round. A running or resumed round retains its saved assignments. The viewed round separately shows its actual chief, language, team models and judge models, so changing the next-round settings does not relabel an existing debate.

Set **Target words per speech** to choose a length from 100 to 3,000 words for English. Chinese uses **Target characters per speech**, from 200 to 6,000 non-whitespace characters. These are approximate generation targets; each speech shows its actual count alongside the saved target. Standard presets are 950 English words or 1,800 Chinese characters; quick presets are 470 words or 950 characters. A custom target is saved with the round and retained on resume.

Set **Reasoning effort** for each team and judge, or use **Apply effort to all** to set every seat together. Auto leaves the API parameter unset and uses the service default. Other selections send the chosen `reasoning_effort` value with every call for that seat, including preparation, speeches, POIs, motion selection, ballot generation, retries and JSON repairs. The chief's motion uses the chief judge's effort; a POI uses the offering team's effort. The gateway and selected model determine which levels they support.

Effort settings apply to a new round and remain fixed when it resumes. Current-round cards and exports show the saved settings; older rounds that did not specify effort display Auto. The AI participants receive anonymous debate text without other seats' effort or identity metadata.

## The chamber

| Team | Initial model | Speakers |
| --- | --- | --- |
| Opening Government (OG) | GPT‑6.1 Sol | Prime Minister, Deputy Prime Minister |
| Opening Opposition (OO) | GPT‑6 Astra | Leader of Opposition, Deputy Leader of Opposition |
| Closing Government (CG) | GPT‑6 Astra | Member of Government, Government Whip |
| Closing Opposition (CO) | GPT‑6.1 Sol | Member of Opposition, Opposition Whip |

Speech order is **PM → LO → DPM → DLO → MG → MO → GW → OW**. Each team's two speakers use its selected model. The initial setup gives each of the two models one opening team, one closing team, and a place on both benches. You can change every team independently. Explicit selections are saved exactly and retained when resuming.

The initial panel contains three GPT‑6.1 Sol judges and two GPT‑6 Astra judges. You can change each judge's model. J4 is the default chief; any of the five judge seats can be selected. The chief chooses a balanced motion and an information slide when needed. An optional topic hint guides this choice.

## Mandatory participant double blinding

Debaters receive their BP role, their own private preparation, the motion, and public speeches. Their contexts contain no judge identities, model assignments, or ballots. Judges receive the motion and the same anonymous public transcript; their contexts contain no debater model identities, private preparation, or other judges' ballots. Requests are independent, without a shared conversation history across roles.

Available and selected model identifiers in topic hints or generated text are masked before passing that text into participant contexts. The application keeps transport routing on the server. As the human operator, you can see every seat's model and the chief throughout the round, including in APIs, live updates and exports. This operator view is never passed to the AI participants. Their contexts remain anonymous during preparation, speeches, POIs and judging.

## Format and AI timing

The format follows the [WUDC Debating and Judging Manual, revised November 2024](https://debate.ethz.ch/wp-content/uploads/2024/11/WUDC-Debating-Judging-Manual-Revised-November-2024-.pdf): four teams of two, alternating speeches, closing-team extensions, and comparative judging. Whips are instructed to weigh and summarize the existing debate without introducing new substantive arguments. This is a pinned rules edition, not a claim to track every later tournament amendment.

This is an **accelerated text simulation**. Standard mode initially targets the length of a seven-minute speech and uses protected opening and closing sections. It does not wait fifteen minutes for preparation or seven real minutes for delivery. Quick mode supplies a shorter preset. You can override either preset with a custom speech target. AI-generated section lengths are estimates, not certified spoken timings.

Teams prepare separately. An opposing-bench speaker offers a short point of information during the middle section, and the speaker chooses whether to accept it and responds if accepted. The opening and closing sections are protected. The interface preserves the actual question, acceptance decision, and response.

Speeches run in BP order, so the next speaker waits for the current speech's opening, POI, middle and closing to finish. The page shows the current phase and each API request's elapsed time, attempt number, timeout and latest error. Recent activity records retries and stopped rounds. A failed or cancelled round is labelled paused or cancelled throughout the speech panel; saved text remains visible and **Resume round** continues from completed steps.

Text streams from the gateway as it arrives, including the POI decision and reply before the rest of the middle section finishes. Draft updates are coalesced on the server to at most ten per second before parsing and masking. Each response has a finite preview-work budget and bounded public preview fields; final validated output is preserved in full. Incomplete text is shown as a live draft and checkpointed separately; only a finished, validated section advances the round or enters another participant's context. Reloading recovers the current draft. Private team preparation and model identities remain hidden from the AI participants.

Successful gateway JSON bodies are limited to 1 MiB of actual bytes. Streams allow 16 MiB of wire data, 512 KiB per pending event, 2,048 lines per event, 200,000 events/reads, and 1 MiB of decoded answer bytes. These budgets include metadata and unknown fields, regardless of Content-Length. Model catalogs allow 512 entries with IDs up to 256 characters, including excluded IDs. Identity masking uses one substitution pass and preserves sealed placeholders, so aliases cannot amplify their own replacements. Quota failures cancel the body and pause the unfinished step without automatic replay. SSE viewers have a global limit of 16 and a per-round limit of eight; each has an 8 MiB output budget, a 4 MiB frame limit and a 15-second drain deadline. Slow viewers retain only current pending state/drafts or disconnect; reconnecting receives the current round and does not affect generation. Large saved states use a small refresh notice and a separate authenticated snapshot fetch, coalesced to one request at a time with a 64 MiB byte limit; live deltas continue during that fetch.

Completion requests allow 30 minutes for the first answer text, including gateways that buffer the full response. Receiving headers, reasoning events or keep-alives does not shorten this allowance. After answer text begins, the five-minute inactivity limit resets whenever more stream data arrives. Each attempt also has a 45-minute absolute ceiling. A deadline pauses the unfinished step once with a specific reason; it does **not** automatically start the same long generation again. Saved work and the selected models, effort and speech targets remain intact, and **Resume round** retries only unfinished work.

The gateway transport uses Node's HTTP/HTTPS client with no implicit header or body timeout, so a separate five-minute native-fetch deadline cannot preempt these limits. `FIRST_TEXT_TIMEOUT_MS` sets the initial allowance (default 1,800,000; range 1,000–3,600,000 milliseconds). `REQUEST_TIMEOUT_MS` sets stream inactivity after text begins (default 300,000; range 1,000–1,800,000). `REQUEST_MAX_DURATION_MS` sets the absolute ceiling (default 2,700,000; at least the first-text allowance and at most 7,200,000). Model discovery uses a shorter response deadline, at most 12 seconds.

Temporary gateway failures such as HTTP 429/503 still wait 30 then 60 seconds before retrying, honouring a longer `Retry-After` up to five minutes; the page shows the retry countdown. Long output targets and higher reasoning effort can delay the first text; streaming cannot display text before the gateway sends it. Gateways returning an ordinary JSON response remain supported, but cannot provide live deltas. The BP minute labels describe the simulated speech format, rather than an API time limit.

CLIProxyAPI can send connection keep-alives with `requests.streaming.keepalive-seconds: 15`. Keep-alives contain no speech text and do not extend the first-text or absolute deadline. If the gateway sends the entire answer as one content chunk, the app displays it immediately but cannot reconstruct when individual tokens were generated. See the [gateway streaming configuration](https://help.router-for.me/configuration/options).

## Judging and the five-vote rule

All five judges receive the same anonymous debate transcript, with model labels removed. They do not see private team preparation or each other's ballots. Each independently ranks **all four teams**, best to worst, and gives reasons grounded in the debate. The human operator can see assignments immediately; the winner requires all five valid ballots.

The requested five-vote result uses a declared house rule:

1. Every judge's first-ranked team receives one vote.
2. The team with the most first-place votes wins.
3. If first-place votes tie, compare the tied teams' total ranking points across all five ballots: 3 for first, 2 for second, 1 for third, and 0 for fourth.
4. If those totals still tie, use the chief judge's ordering of only the tied teams.

Four teams can split five votes without a majority. The interface distinguishes votes from ranking points and records any tiebreak. This independent-ballot aggregation is a customization requested for this app; standard BP panels ordinarily deliberate to produce one agreed ranking. The chief has one ordinary ballot and cannot replace the other judges' votes.

A winner is published only after **five valid complete ballots**. Partial or failed rounds remain available to resume. Cancelling aborts the current calls and preserves completed work. A server restart leaves interrupted rounds resumable. Run files are stored locally in `data/`, and Markdown and JSON exports contain the public debate and ballots.

## Verification

```sh
npm test
```

The suite uses local mocks and temporary directories; it needs no API key or live model service. It covers BP roles, independent ballots and tiebreaks, exact model routing, participant anonymity, configurable length and effort, streamed drafts, request deadlines, cancellation, persistence and restart recovery. Security regressions also exercise gateway byte/catalog/event quotas, preview amplification, backpressure, viewer quotas, owner bootstrap/authentication, streamed reconnection, exports and protected configuration. GitHub Actions runs it on Node.js 22, 24 and 26. A passing test suite does not establish connectivity to your selected gateway or support for every reasoning level.

Optional `npm run probe:streaming` and `npm run probe:responses` make short real gateway calls and print timing/count diagnostics. Both use the same bounded production readers and protected configuration. Responses diagnostics additionally cap event types and retained delta records. They do not copy gateway configurations or save credentials/answer text in diagnostic files.

Generated arguments and judge decisions are AI outputs. The judges evaluate the arguments delivered in the round; their ballots are not an external fact check.

## Contributing

Bug reports and pull requests are welcome. Include reproduction steps and the affected model/gateway behavior, using synthetic examples when possible. Run `npm test` before submitting a change. Do not include API keys, `.env` files, private team preparation, saved rounds or personal transcripts in reports or commits. Contributions are provided under the project's AGPL-3.0-only license.

Share source from Git, for example with `git archive --format=tar.gz HEAD`, rather than archiving the whole working folder. `.gitignore` and `.gitattributes` exclude local configuration, `.runtime/` (including owner access files), saved rounds and exports. Inspect the archive inventory before distributing it. Never retain credential-bearing gateway backups. If an operational key was exposed in a shared snapshot, revoke it using the gateway operator's rotation workflow and update any authorized consumers; removing a copy does not revoke an existing key.

## License

Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.

This project is licensed under the **GNU Affero General Public License version 3 only** (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full terms, including the network source-availability provision. The software is provided without warranty. Gateways and models are separate services governed by their own terms; this license applies to the code in this repository.
