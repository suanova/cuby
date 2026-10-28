# FinanceBuddy guided workflows and native report reader

When the explicitly enabled `financebuddy_reports` MCP server exposes `list_c2_reviews`, the Cuby home screen displays five finance workflow cards and a **報告工作台** action. Ordinary Cuby installations without that tool retain their existing home screen.

The cards explain the actual supported stage. Source consolidation and report generation wait for source data and access; commitment tracking waits for a dedicated validated workflow. The report review form currently supports the verified Yeebo FY2025/26 English ESG report and a bounded 12-item C2 Scope 1/2 checklist. Users choose same-year review or next-year readiness; the latter retains the original year and explicitly requires current-year confirmation. Peer comparison supports the two configured peers' 2025 official reports and emissions metrics. These limits are visible before starting work.

Forms build canonical requests for the installed skills and submit through the existing Cuby composer/WebSocket path, preserving the user's current model selection, thinking configuration, unsent text and attachments. Attachments already in the composer are not silently included in a button-generated request. Only exact generated requests receive a shorter display summary; additional user instructions are never hidden by prefix matching. Existing quota, model availability, message locks and connection admission still apply.

Setup uses a compact focus-trapped modal with Escape dismissal. Submitting closes setup and leaves the conversation at full width. For a review launched here, the page tracks that exact chat and client request, waits for its task completion, and opens the reader only after the final answer supplies one bounded review.json path and the authorized artifact resolver confirms it. It ignores older turns, narration, other chats and ambiguous result paths; a failure leaves chat usable with a manual artifact fallback. Manual reader/catalog access remains available.

With FinanceBuddy adapter 0.6.0, the review source selector also offers a bounded TEST ONLY negative control. It requests a separately watermarked English same-year PDF; it does not alter the official source or pass an answer key to the model. Synthetic-source receipts display an explicit reader warning. This validates only the selected checks, not all ESG clauses or financial data accuracy. Workflow buttons do not hard-code a model; the user's configured model and reasoning effort remain authoritative.

## Four-category consistency review (adapter 0.8.0)

The fifth guided choice is now report consistency; commitments remain a future workflow. Setup defaults to uploading the current-year ESG Chinese/English and annual report Chinese/English PDFs, with bilingual, cross-report, internal and restatement checks all selected. The existing authenticated multipart upload stages four distinct PDFs inside the gateway media root. The adapter snapshots their hashes; the native reader opens only after a successful build. A local FY2025/26 example option remains available.

For restatement checks the adapter verifies the exact prior fiscal year's four completed WeKnora sources, authorization and identical local-mirror SHA before using them. Current-year uploaded snapshots remain authoritative drafts; a clean current-year KB copy is never an answer key. Supported table mappings cover Yeebo GHG, energy and consolidated income statements, selected internal sums and current comparative versus prior actual columns. Unit dimensions, rounding precision, missing facts and unsupported semantic/boundary checks remain pending. Full-page number inventories are only alignment candidates, hidden by default.

The native dual-source reader offers category filters, source-page navigation, evidence highlights and CSV/JSON downloads. Selected-item follow-up uses the ordinary composer and current model/thinking selection. `read_consistency_issue` returns the item and at most four immutable source pages / 24,000 characters with explicit truncation metadata. No model credentials reach this interface and no original PDF is changed. Suggestions are unapproved drafts, not new verified figures or automatic legal approval.

Three additional fixed UI calls (`build_consistency_review`, `read_consistency_review`, `read_consistency_page`) join the existing two C2 calls. The model registry separately exposes `read_consistency_issue`; upload paths must canonicalize under the gateway media directory. This requires matching core and adapter versions; installing skills alone does not update the desktop UI.

## Reader integration

The reader is a React component inside `HomePage`, with a split conversation/document layout and an expand option. It is not an iframe or external browser wrapper. It shows verified raster pages, exact PDF-coordinate evidence highlights, the 12 findings, reasons, follow-ups, original rule pages, source IDs, reviewer labels and notes. Evidence highlights are not automatically error locations; missing disclosure has no fabricated sentence highlight. Search filters findings, not full PDF text. Original PDFs and checklist findings are not edited.

The catalog opens existing workpapers without a model call. Clicking a relative `outputs/c2-reviews/<run>/review.json` or `review.html` chat attachment invokes the optional typed `AgentArtifactClient.openReview` action before the system file opener. The resolved attachment path is checked against the MCP reader receipt, so another workspace's same-named attachment is not silently replaced. Newly generated reviews can be opened this way without first adding them to the curated catalog.

The reader supports report/rule paging, zoom, findings search/filtering, citation navigation and downloads of checklist, data requests and saved notes. Unsaved drafts survive citation changes, workpaper switches and closing/reopening the panel within the mounted chat page. Refreshing/exiting Cuby can discard unsaved drafts; the footer indicates unsaved work. Saved notes survive reopening. Conflicts return 409 and retain the user's draft for review. Notes are local owner annotations, not verified multi-user signatures, business approval or legal certification.

## Concise findings and revision drafts

With FinanceBuddy adapter 0.7.0, the reader sorts verified document problems (red), unresolved questions (amber), and wording suggestions (blue); existing evidence is hidden by default. A short title, reason and source/rule buttons remain visible. Full reasoning and annotations are disclosed on demand. Classification is separate from the immutable audit status: an absent search result alone never becomes a proven error, and accepting wording never marks a requirement passed. Red page marks are backed by source text or an explicitly verified blank table cell. Reference highlights remain pale yellow. Clicking a problem mark selects its card.

`NativeFinanceReader` consumes optional typed finding metadata from the adapter; old adapters fall back to unresolved/evidence categories without inventing errors. For supported checks the adapter supplies editable disclosure templates, not independently verified new facts or an unrestricted AI rewrite service. Unknown values remain placeholders. Draft adoption requires completed wording and explicit confirmation of its facts. Exact source replacements require one whitespace-normalized match on the cited page; unlocatable missing content uses an insertion. Duplicate, overlapping and stale edits are rejected. No original PDF bytes or finalized review conclusions are overwritten.

The fixed `drafts`, `draft-save` and `draft-export` actions proxy the local renderer's dedicated draft endpoints through the existing authenticated handle. Optimistic revisions, immutable source/review hashes and atomic sidecar writes preserve accepted/undone changes independently of reviewer notes. A separate page-text draft view and TXT/JSON exports show the result and provenance; this does not recreate PDF layout or edit a Word source in place. The adapter package is required alongside this core change.

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

## Original-layout PDF revisions (adapter 0.12.0)

Accepted edits now preview and export as revised PDFs using the uploaded PDF as the layout source. The dual reader shows actual rendered revised pages, with independent zoom and an original-PDF toggle. The export menu offers one PDF or a ZIP of four PDFs plus accepted-change and layout-check records; it no longer rebuilds plain-text Word documents.

The local adapter reuses original fonts and artwork, preserves short corrections in place, and allows a growing uniform paragraph to move simple following text/table rules within the same page at the original font size. It verifies text, vector rules, page geometry and pixels outside the permitted edit regions. Unsupported fonts, overflow or complex layouts stop with the document/page and a concrete reason. Existing original snapshots and human decisions remain unchanged. This does not promise arbitrary scanned-PDF editing or unrestricted page reflow.

The authenticated gateway grants a bounded ten-minute download ID only for the exact current run/revision output inside its configured workspace, verifies the real path, PDF/ZIP signature, size and SHA-256, and rechecks on download. Binary downloads support up to 128MiB without the previous inline 8MiB limit. The renderer never sends a filesystem path. Preview failures and layout-blocked exports remain visible; no partial bundle is offered.

Targeted verification covers PDF preview/export UI, token-refresh download, route authentication, fixed-path and symlink escape refusal, changed-byte rejection, large downloads, CJK fonts, original backgrounds, table movement, unchanged footers and page count, and overflow refusal. Install the matching local Python adapter and its requirements as well as these core changes.
