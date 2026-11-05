"""Build and verify the FinanceBuddy Windows x64 resources without target Python."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zipfile import ZipFile


PAYLOAD_MANIFEST = "payload-manifest.json"
LOCK = "requirements-windows.lock"
BOOTSTRAP = "install_packaged.py"
CATALOGUE = "cuby/config/yeebo-public-reports.json"
CPYTHON_URL = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip"
CPYTHON_SHA = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3"
WHEELS = {
    "PyMuPDF==1.28.2": ("https://files.pythonhosted.org/packages/4a/61/d563bbccba262f9dd6d2d35ccb72593648184d886188efb12d9ce8f34dd6/pymupdf-1.28.2-cp310-abi3-win_amd64.whl", 19826532),
    "fonttools==4.68.0": ("https://files.pythonhosted.org/packages/1c/3e/ef786310a3774ae7aacaa288ca6d1e1dfd03c24214137478e4b630b76af0/fonttools-4.68.0-cp312-cp312-win_amd64.whl", 2533508),
    "PyYAML==6.0.3": ("https://files.pythonhosted.org/packages/86/bf/899e81e4cce32febab4fb42bb97dcdf66bc135272882d1987881a4b519e9/pyyaml-6.0.3-cp312-cp312-win_amd64.whl", 154003),
}
PYMUPDF_SOURCE_URL = "https://files.pythonhosted.org/packages/a3/fb/b6761fa2d5266f2cdb24c3b91f4023070ab7848381417678e7a289a1d52a/pymupdf-1.28.2.tar.gz"
PYMUPDF_SOURCE_SHA = "5e0be7908a715aa20333caddd73f1d6f01e4cd0c26e869fa2dd0b7f344da2249"
MUPDF_SOURCE_URL = "https://github.com/ArtifexSoftware/mupdf-downloads/releases/download/1.28.2/mupdf-1.28.2-source.tar.gz"
MUPDF_SOURCE_SHA = "44075a84e329db55b9bef5f342a70fd26d69e48ad1d33cb89d9664581c641156"
MUPDF_RELEASE_ASSET = "/github-production-release-asset/1016115966/1519dc8f-44d2-4e91-b016-ab367974c8d8"
PDF_HOSTS = {"www1.hkexnews.hk", "en-rules.hkex.com.hk"}
REPORT_IDS = {"S12", "S15", "S18", "S19", "S20", "S21", "S23", "S24", "S25", "S26", "S27", "S29"}
SHA256 = re.compile(r"[a-f0-9]{64}")
SECRET = re.compile(rb"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?<![A-Za-z0-9])sk-(?:proj-)?[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{25,}|AKIA[A-Z0-9]{16}")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def safe_parts(relative):
    path = PurePosixPath(relative)
    if (path.is_absolute() or not path.parts or path.as_posix() != relative
            or ".." in path.parts or "\\" in relative or ":" in relative
            or any(part.endswith((".", " ")) for part in path.parts)):
        raise ValueError(f"Unsafe relative path: {relative}")
    return path.parts


def linked(path):
    info = path.lstat()
    return path.is_symlink() or bool(getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def file_tree(root):
    if linked(root) or not root.is_dir():
        raise ValueError("Runtime/payload root must be a regular directory")
    files = {}
    seen = set()
    for directory, children, names in os.walk(root):
        for name in children + names:
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            safe_parts(relative)
            if linked(path) or relative.casefold() in seen:
                raise ValueError(f"Linked or ambiguous path: {relative}")
            seen.add(relative.casefold())
            if name in names:
                if not path.is_file():
                    raise ValueError(f"Unexpected special file: {relative}")
                files[relative] = path
    return files


def valid_origin(url, hosts):
    parts = urlsplit(url)
    signed_release = parts.hostname == "release-assets.githubusercontent.com" and parts.path == MUPDF_RELEASE_ASSET
    if (parts.scheme != "https" or parts.hostname not in hosts or parts.port not in (None, 443)
            or parts.username or parts.password or (parts.query and not signed_release) or parts.fragment):
        raise ValueError("Download origin is outside the permitted HTTPS scope")


def checked_bytes(data, size, digest):
    if (type(size) is not int or size < 1 or not isinstance(digest, str) or not SHA256.fullmatch(digest)
            or len(data) != size or hashlib.sha256(data).hexdigest() != digest):
        raise ValueError("Download/payload length or SHA-256 differs from the lock")
    return data


def download(url, hosts, size, digest):
    valid_origin(url, hosts)

    class ApprovedRedirect(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            valid_origin(newurl, hosts)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    with build_opener(ApprovedRedirect).open(Request(url, headers={"User-Agent": "Cuby-FinanceBuddy-Windows-Packager/1"}), timeout=30) as stream:
        valid_origin(stream.geturl(), hosts)
        return checked_bytes(stream.read(size + 1), size, digest)


def unpack_zip(data, destination):
    with ZipFile(BytesIO(data)) as archive:
        seen = set()
        for item in archive.infolist():
            if item.is_dir():
                continue
            parts = safe_parts(item.filename)
            if (stat.S_ISLNK(item.external_attr >> 16)
                    or item.filename.casefold() in seen):
                raise ValueError("Archive contains a symbolic link or duplicate entry")
            seen.add(item.filename.casefold())
            if "__pycache__" in parts or item.filename.endswith(".pyc"):
                continue
            target = destination.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(item) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)


def requirement_hashes(path):
    records = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"(\S+) --hash=sha256:([a-f0-9]{64})", line)
        if not match or match[1] in records:
            raise ValueError("Invalid wheel hash lock")
        records[match[1]] = match[2]
    if records.keys() != WHEELS.keys():
        raise ValueError("Wheel hash lock and pinned archive list differ")
    return records


def copy_payload(source, destination):
    entries = file_tree(source)
    manifest = read_json(entries[PAYLOAD_MANIFEST])
    listed = manifest["files"]
    if (manifest.get("schema") != 1 or not {BOOTSTRAP, CATALOGUE} <= listed.keys()
            or set(entries) != set(listed) | {PAYLOAD_MANIFEST, LOCK}):
        raise ValueError("FinanceBuddy payload differs from its source manifest")
    for relative, path in entries.items():
        parts = safe_parts(relative)
        lower = relative.lower()
        if (any(part.lower() in {".cuby", "__pycache__", "runtime", "outputs", "secrets", "internal-esg"} for part in parts)
                or parts[-1].lower().startswith(".env") or lower.endswith((".pyc", ".bak", ".pem", ".key", ".xlsx", ".pfx", ".sqlite"))
                or relative.startswith("dataset/reports/")):
            raise ValueError(f"Private or generated file cannot be shipped: {relative}")
        data = path.read_bytes()
        if not lower.endswith(".pdf") and SECRET.search(data):
            raise ValueError(f"Credential-like bytes in payload: {relative}")
        if relative in listed:
            checked_bytes(data, listed[relative]["size"], listed[relative]["sha256"])
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def add_public_pdfs(destination, cache):
    catalogue = read_json(destination / CATALOGUE)
    reports = catalogue["documents"]
    rules = catalogue["rules"]
    if (catalogue.get("schema") != 1 or len(reports) != 12
            or {item["source_id"] for item in reports} != REPORT_IDS or len(rules) not in (1, 2)):
        raise ValueError("Unexpected public Yeebo/HKEX catalogue scope")
    paths = set()
    downloads = []
    bundled = set()
    for folder, entries in (("reports", reports), ("rules", rules)):
        for row in entries:
            relative = row["path"]
            parts = safe_parts(relative)
            url = row["url"]
            size = row["size"]
            digest = row["sha256"]
            if (len(parts) != 3 or parts[:2] != ("dataset", folder) or not relative.lower().endswith(".pdf")
                    or relative.casefold() in paths or type(size) is not int or not 1 <= size <= 30 * 1024 * 1024
                    or not isinstance(digest, str) or not SHA256.fullmatch(digest)
                    or not urlsplit(url).path.lower().endswith(".pdf")):
                raise ValueError(f"Invalid catalogue asset: {relative}")
            if folder == "reports" and (row["entity"] != "yeebo" or row["file_name"] != parts[-1]):
                raise ValueError(f"Public report identity differs: {relative}")
            valid_origin(url, PDF_HOSTS)
            paths.add(relative.casefold())
            if row.get("bundled") is True:
                if folder != "rules":
                    raise ValueError("Only pinned HKEX rule PDFs may be bundled in the source payload")
                data = checked_bytes((destination / relative).read_bytes(), size, digest)
                if not data.startswith(b"%PDF-"):
                    raise ValueError(f"Bundled catalogue asset is not PDF: {relative}")
                bundled.add(relative)
            else:
                downloads.append((relative, url, size, digest))

    supplied = {path for path in file_tree(destination) if path.startswith("dataset/rules/")}
    if supplied != bundled:
        raise ValueError("Bundled HKEX rules differ from the public catalogue")

    def stage_pdf(asset):
        relative, url, size, digest = asset
        cached = cache / f"{digest}.pdf" if cache else None
        data = checked_bytes(cached.read_bytes(), size, digest) if cached and cached.is_file() else download(url, PDF_HOSTS, size, digest)
        if not data.startswith(b"%PDF-"):
            raise ValueError(f"Catalogue asset is not PDF: {relative}")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(stage_pdf, downloads))
    return len(reports), len(rules)


def stage_python(root, hashes):
    site = root / "Lib/site-packages"
    unpack_zip(download(CPYTHON_URL, {"www.python.org"}, 11133606, CPYTHON_SHA), root)
    (root / "python312._pth").write_text(
        "python312.zip\n.\nLib/site-packages\n../payload/scripts\n../payload/cuby/service\n",
        encoding="ascii",
    )
    for requirement, (url, size) in WHEELS.items():
        unpack_zip(download(url, {"files.pythonhosted.org"}, size, hashes[requirement]), site)
    licenses = [
        root / "LICENSE.txt",
        site / "pymupdf-1.28.2.dist-info/COPYING",
        site / "fonttools-4.68.0.dist-info/licenses/LICENSE",
        site / "fonttools-4.68.0.dist-info/licenses/LICENSE.external",
        site / "pyyaml-6.0.3.dist-info/licenses/LICENSE",
    ]
    if not all(path.is_file() and path.stat().st_size > 0 for path in licenses):
        raise ValueError("Required upstream license/notice missing")
    child_env = {key: value for key, value in os.environ.items() if not key.upper().startswith("PYTHON")}
    child_env["PATH"] = str(Path(os.environ["SystemRoot"]) / "System32")
    code = (
        "import struct,sys,pymupdf,fontTools,yaml; "
        "assert sys.version_info[:3]==(3,12,10) and struct.calcsize('P')==8; "
        "assert (pymupdf.__version__,fontTools.__version__,yaml.__version__)==('1.28.2','4.68.0','6.0.3')"
    )
    subprocess.run([str(root / "python.exe"), "-I", "-B", "-X", "utf8", "-c", code],
                   cwd=root, env=child_env, check=True, timeout=35)


def write_notices(destination, hashes):
    lines = [
        "FinanceBuddy Windows x64 bundled runtime", "",
        "CPython 3.12.10: Python Software Foundation license, see python/LICENSE.txt.",
        CPYTHON_URL, f"SHA-256 {CPYTHON_SHA}",
        f"Release/SBOM: {CPYTHON_URL}.spdx.json",
        "Source: https://www.python.org/ftp/python/3.12.10/Python-3.12.10.tar.xz", "",
        "PyMuPDF and MuPDF are offered under GNU AGPL v3 or commercial license.",
        "See python/Lib/site-packages/pymupdf-1.28.2.dist-info/COPYING.",
        f"PyMuPDF upstream source archive: {PYMUPDF_SOURCE_URL}", f"SHA-256 {PYMUPDF_SOURCE_SHA}",
        f"MuPDF upstream source archive: {MUPDF_SOURCE_URL}", f"SHA-256 {MUPDF_SOURCE_SHA}", "",
        "FontTools: MIT, see its dist-info/licenses/LICENSE and LICENSE.external.",
        "PyYAML: MIT, see its dist-info/licenses/LICENSE.", "", "Pinned wheels:",
    ]
    for requirement, (url, _) in WHEELS.items():
        lines.extend([requirement, url, f"SHA-256 {hashes[requirement]}"])
    (destination / "THIRD-PARTY-NOTICES.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def build(payload, output, cache, source_output):
    if os.name != "nt":
        raise ValueError("FinanceBuddy runtime must be built on Windows")
    if output.exists() or output.is_relative_to(payload):
        raise ValueError("Use a fresh runtime staging directory outside the source payload")
    if source_output and (source_output.exists() or source_output.is_relative_to(output)
                          or source_output.is_relative_to(payload)):
        raise ValueError("Use a separate fresh directory for upstream source output")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="financebuddy-stage-", dir=output.parent) as temporary:
        stage = Path(temporary) / "runtime"
        copy_payload(payload, stage / "payload")
        hashes = requirement_hashes(stage / "payload" / LOCK)
        report_count, rule_count = add_public_pdfs(stage / "payload", cache)
        stage_python(stage / "python", hashes)
        write_notices(stage, hashes)
        if source_output:
            pymupdf_source = download(PYMUPDF_SOURCE_URL, {"files.pythonhosted.org"}, 87903557, PYMUPDF_SOURCE_SHA)
            mupdf_source = download(MUPDF_SOURCE_URL, {"github.com", "release-assets.githubusercontent.com"}, 68898646, MUPDF_SOURCE_SHA)
            source_output.mkdir(parents=True, exist_ok=False)
            (source_output / "pymupdf-1.28.2.tar.gz").write_bytes(pymupdf_source)
            (source_output / "mupdf-1.28.2-source.tar.gz").write_bytes(mupdf_source)
            shutil.copyfile(stage / "THIRD-PARTY-NOTICES.txt", source_output / "THIRD-PARTY-NOTICES.txt")
        stage.rename(output)
    print(f"Staged CPython and {len(hashes)} pinned wheels with {report_count} public reports and {rule_count} HKEX rule PDFs.")


def verify_copy(staged, packaged):
    left, right = file_tree(staged), file_tree(packaged)
    if left.keys() != right.keys():
        raise ValueError("Packed FinanceBuddy resources have different file paths")
    for name, source in left.items():
        with source.open("rb") as expected, right[name].open("rb") as observed:
            if hashlib.file_digest(expected, "sha256").digest() != hashlib.file_digest(observed, "sha256").digest():
                raise ValueError(f"Packed FinanceBuddy resource differs: {name}")
    print(f"Verified {len(left)} packaged FinanceBuddy resource files byte-for-byte.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    stage = sub.add_parser("stage")
    stage.add_argument("--payload", type=Path, required=True)
    stage.add_argument("--output", type=Path, required=True)
    stage.add_argument("--pdf-cache", type=Path)
    stage.add_argument("--source-output", type=Path)
    verify = sub.add_parser("verify-copy")
    verify.add_argument("--staged", type=Path, required=True)
    verify.add_argument("--packaged", type=Path, required=True)
    args = parser.parse_args()
    if args.operation == "stage":
        build(args.payload.absolute(), args.output.absolute(), args.pdf_cache,
              args.source_output.absolute() if args.source_output else None)
    else:
        verify_copy(args.staged, args.packaged)


if __name__ == "__main__":
    main()
