# FinanceBuddy Windows pilot

The installer stages FinanceBuddy as a separate local MCP process with a private Python interpreter. Cuby registers the process for the active local workspace before starting its gateway. The add-on's code and reference documents stay in the application resources, while user projects and review outputs stay in the selected workspace.

The public report library contains 12 immutable public HKEX filings from FY2023/24 to FY2025/26. The build downloads only the listed official documents and verifies the exact published SHA-256 for each. The pinned English C2 source preserves the version used for the mapped checks. The app labels the historical source as a bundled snapshot. It requires no SSH or live WeKnora entitlement. It contains no tenant configuration, passwords or private knowledge data.

The public branch provides the exact Cuby and FinanceBuddy source for the pilot. The Windows workflow retains the pinned PyMuPDF source distribution and third-party notices alongside the installer. See the bundled Python packages for their respective licenses.
