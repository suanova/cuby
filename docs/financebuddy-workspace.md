# FinanceBuddy guided workflows and native report reader

When the explicitly enabled `financebuddy_reports` MCP server exposes `list_c2_reviews`, the Cuby home screen displays five finance workflow cards and a **報告工作台** action. Ordinary Cuby installations without that tool retain their existing home screen.

The cards explain the actual supported stage. Source consolidation and report generation wait for source data and access; commitment tracking waits for a dedicated validated workflow. The report review form currently supports the verified Yeebo FY2025/26 English ESG report and a bounded 12-item C2 Scope 1/2 checklist. Users choose same-year review or next-year readiness; the latter retains the original year and explicitly requires current-year confirmation. Peer comparison supports the two configured peers' 2025 official reports and emissions metrics. These limits are visible before starting work.

Forms build canonical requests for the installed skills and submit through the existing Cuby composer/WebSocket path, preserving the user's current model selection, thinking configuration, unsent text and attachments. Attachments already in the composer are not silently included in a button-generated request. Only exact generated requests receive a shorter display summary; additional user instructions are never hidden by prefix matching. Existing quota, model availability, message locks and connection admission still apply.

Setup uses a compact focus-trapped modal with Escape dismissal. Submitting closes setup and leaves the conversation at full width. For a review launched here, the page tracks that exact chat and client request, waits for its task completion, and opens the reader only after the final answer supplies one bounded review.json path and the authorized artifact resolver confirms it. It ignores older turns, narration, other chats and ambiguous result paths; a failure leaves chat usable with a manual artifact fallback. Manual reader/catalog access remains available.

With FinanceBuddy adapter 0.6.0, the review source selector also offers a bounded TEST ONLY negative control. It requests a separately watermarked English same-year PDF; it does not alter the official source or pass an answer key to the model. Synthetic-source receipts display an explicit reader warning. This validates only the selected checks, not all ESG clauses or financial data accuracy. Workflow buttons do not hard-code a model; the user's configured model and reasoning effort remain authoritative.

## Reader integration

The reader is a React component inside `HomePage`, with a split conversation/document layout and an expand option. It is not an iframe or external browser wrapper. It shows verified raster pages, exact PDF-coordinate evidence highlights, the 12 findings, reasons, follow-ups, original rule pages, source IDs, reviewer labels and notes. Evidence highlights are not automatically error locations; missing disclosure has no fabricated sentence highlight. Search filters findings, not full PDF text. Original PDFs and checklist findings are not edited.

The catalog opens existing workpapers without a model call. Clicking a relative `outputs/c2-reviews/<run>/review.json` or `review.html` chat attachment invokes the optional typed `AgentArtifactClient.openReview` action before the system file opener. The resolved attachment path is checked against the MCP reader receipt, so another workspace's same-named attachment is not silently replaced. Newly generated reviews can be opened this way without first adding them to the curated catalog.

The reader supports report/rule paging, zoom, findings search/filtering, citation navigation and downloads of checklist, data requests and saved notes. Unsaved drafts survive citation changes, workpaper switches and closing/reopening the panel within the mounted chat page. Refreshing/exiting Cuby can discard unsaved drafts; the footer indicates unsaved work. Saved notes survive reopening. Conflicts return 409 and retain the user's draft for review. Notes are local owner annotations, not verified multi-user signatures, business approval or legal certification.

## Local API and trust boundary

The existing gateway bearer authentication protects both routes:

- `GET /api/webui/finance/catalog`
- `POST /api/webui/finance/request`

`FinanceReaderApi` can invoke only the two explicitly enabled tools `mcp_financebuddy_reports_list_c2_reviews` and `mcp_financebuddy_reports_open_c2_reader`. Its tool callback is wired to the live registry, so disabled tools cannot be invoked through the UI. The separately installed FinanceBuddy adapter verifies finalized review manifests and original PDF hashes, freezes the original bytes and starts/reuses its loopback renderer. The gateway validates the renderer identity and review/notes revisions before issuing an opaque eight-hour handle. The browser receives authenticated JSON/data images, not the renderer URL or model/WeKnora credentials.

The proxy accepts fixed resource names and bounded page numbers, has bounded request/response sizes and timeouts, rejects redirects and non-protocol loopback URLs, and validates PNG bytes. It cannot fetch an arbitrary renderer-supplied URL or path. Note writes preserve optimistic revision checks. The Python renderer's same-origin/Host protections remain enabled; there is no CORS or framing relaxation.

Shared DTOs, request validation and canonical workflow builders live in `@memmy/local-api-contracts`. `FinanceReaderApi` owns the server adapter. `finance-workspace.tsx` owns the view; `AgentArtifactClient.openReview` is the explicit chat attachment boundary.

## Install and verify

This Cuby core change requires the separate FinanceBuddy workspace adapter 0.5.0 or later, with its original authorized PDFs and finalized workpapers. Run that workspace's `scripts/install_cuby.py`, which enables the tenth local tool and copies its curated `reader-catalog.json`. The catalog contains business reviews only; technical acceptance runs are excluded. Neither dataset files nor API keys belong in this Cuby repository. A fresh install without prepared reviews should show the missing catalog entries rather than invent workpapers.

Build the frontend and agent using the repository scripts. Focused verification covers guided choices, generated requests, shared display summaries, delayed reader opening, the native adapter's fixed routing/revision/PNG checks, malicious addresses and paths, attachment workspace mismatch, and existing composer/gateway behavior. Live acceptance additionally needs a configured FinanceBuddy workspace: read its catalog and original pages, save notes on a separate technical review, verify stale-write 409, start a review from the default button, and verify its finalized result automatically opens the panel. Do not label these technical checks full legal or all-five-workflow acceptance.

The installed Cuby desktop must be rebuilt/updated to display these core UI changes. Installing a skill/MCP package alone cannot update its React interface. The FinanceBuddy project also includes a local source-development launcher for review before a desktop release.

The development launcher uses a separate gateway session store via the optional programmatic `gateway({ sessionDir })` argument, while retaining the authorized workspace for report artifacts. No existing installed-app history is shared for writes. Initial-message retries are coalesced before existing-session retarget rejection: a binding may have been persisted while the first user-message acknowledgment is still pending. Equal request IDs/digests remain one inbound request; unrelated requests still cannot retarget an existing chat. A focused regression covers this ordering.
