"""Securely copy every object from the GCS bucket to the R2 media bucket.

Keys are preserved exactly, so the read-time resolver (lib/media-url) maps each
legacy `storage.googleapis.com/<bucket>/<key>` URL onto the same object in R2.

Guarantees:
  - Additive: never deletes from GCS — it stays the cold backup.
  - Idempotent / resumable: an object already in R2 with a matching size is
    skipped, so a re-run after an interruption continues where it left off
    (use --overwrite to force a re-copy).
  - Integrity-checked end to end: bytes downloaded from GCS are MD5-verified
    against GCS's recorded md5Hash; boto3 verifies the upload; then the object's
    size in R2 is confirmed. A mismatch fails that one object (logged + counted)
    without aborting the rest, and the run exits non-zero so CI/you notice.
  - Secure: credentials come only from the environment and are never logged;
    every transfer is HTTPS; GCS is read with an authenticated token, so this
    works even if some objects are not public-read.
  - Streamed: objects download to a temp file and upload via boto3 (multipart
    for large files), so a 500 MB segment never sits whole in memory.

Credentials (the same env the pipeline + app already use):
  source:  GCS_BUCKET, GCS_CLIENT_EMAIL, GCS_PRIVATE_KEY
  dest:    R2_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID,
           R2_SECRET_ACCESS_KEY, R2_MEDIA_BUCKET

Usage (from the repo root, with .env / .env.local providing the above):
  python -m pipeline.migrate_gcs_to_r2 --dry-run         # list + totals, copy nothing
  python -m pipeline.migrate_gcs_to_r2                   # copy everything
  python -m pipeline.migrate_gcs_to_r2 --prefix abc123   # only keys under a prefix
  python -m pipeline.migrate_gcs_to_r2 --overwrite       # re-copy even if present
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

from pipeline import config, gcs

# Long immutable cache so Cloudflare's edge (not the bucket) serves the bytes —
# the same header the live uploaders write. Mirrors lib/r2 MEDIA_CACHE_CONTROL.
CACHE_CONTROL = "public, max-age=31536000, immutable"
_JSON_API = "https://storage.googleapis.com/storage/v1"
_CHUNK = 1024 * 1024  # 1 MiB streaming reads


def _r2_client():
    """A boto3 S3 client pointed at R2. Independent of the gcs.py write gate —
    the migration only needs R2 credentials + the media bucket, NOT the
    R2_MEDIA_WRITE_ENABLED cutover flag (copying data is not the cutover)."""
    import boto3
    from botocore.config import Config as BotoConfig

    account = config.env("R2_ACCOUNT_ID")
    endpoint = (
        config.env("R2_ENDPOINT") or f"https://{account}.r2.cloudflarestorage.com"
    ).rstrip("/")
    access_key = config.env("R2_ACCESS_KEY_ID")
    secret = config.env("R2_SECRET_ACCESS_KEY")
    if not (access_key and secret and (account or config.env("R2_ENDPOINT"))):
        raise SystemExit(
            "R2 not configured: set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and "
            "R2_ACCOUNT_ID or R2_ENDPOINT."
        )
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret,
        region_name="auto",
        config=BotoConfig(
            signature_version="s3v4",
            retries={"max_attempts": 5, "mode": "standard"},
        ),
    )


def _list_gcs_objects(bucket: str, prefix: str | None = None):
    """Yield {name, size, contentType, md5Hash} for every object, paginated.
    Authenticated via the pipeline's existing GCS token flow."""
    page = None
    while True:
        params = {"maxResults": "1000"}
        if prefix:
            params["prefix"] = prefix
        if page:
            params["pageToken"] = page
        url = (
            f"{_JSON_API}/b/{urllib.parse.quote(bucket, safe='')}/o"
            f"?{urllib.parse.urlencode(params)}"
        )
        req = urllib.request.Request(
            url, headers={"Authorization": f"Bearer {gcs._access_token()}"}
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        for item in data.get("items", []):
            yield {
                "name": item["name"],
                "size": int(item.get("size", 0)),
                "contentType": item.get("contentType") or "application/octet-stream",
                "md5Hash": item.get("md5Hash"),  # base64 of the MD5, or None
            }
        page = data.get("nextPageToken")
        if not page:
            return


def _download_gcs_object(bucket: str, key: str, dest: Path) -> str:
    """Authenticated streaming download to `dest`. Returns the hex MD5 of the
    bytes written so the caller can verify integrity."""
    url = (
        f"{_JSON_API}/b/{urllib.parse.quote(bucket, safe='')}"
        f"/o/{urllib.parse.quote(key, safe='')}?alt=media"
    )
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {gcs._access_token()}"}
    )
    md5 = hashlib.md5()
    with urllib.request.urlopen(req, timeout=900) as resp, dest.open("wb") as out:
        while True:
            chunk = resp.read(_CHUNK)
            if not chunk:
                break
            md5.update(chunk)
            out.write(chunk)
    return md5.hexdigest()


def _r2_size(client, bucket: str, key: str) -> int | None:
    """The object's size in R2, or None if it isn't there."""
    try:
        head = client.head_object(Bucket=bucket, Key=key)
        return int(head["ContentLength"])
    except Exception:
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Copy a GCS bucket into the R2 media bucket, keys identical."
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="list + totals only; copy nothing"
    )
    parser.add_argument("--prefix", default=None, help="limit to keys under this prefix")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="re-copy even when the object already exists in R2",
    )
    args = parser.parse_args(argv)

    src_bucket = config.env("GCS_BUCKET")
    if not (
        src_bucket and config.env("GCS_CLIENT_EMAIL") and config.env("GCS_PRIVATE_KEY")
    ):
        print(
            "ERROR: GCS source not configured. Need GCS_BUCKET, GCS_CLIENT_EMAIL, "
            "GCS_PRIVATE_KEY in the environment.",
            file=sys.stderr,
        )
        return 2
    dst_bucket = config.env("R2_MEDIA_BUCKET")
    if not dst_bucket:
        print("ERROR: R2_MEDIA_BUCKET is not set.", file=sys.stderr)
        return 2

    client = None if args.dry_run else _r2_client()

    print(f"Source GCS bucket : {src_bucket}")
    print(f"Dest   R2 bucket  : {dst_bucket}")
    if args.prefix:
        print(f"Prefix            : {args.prefix}")
    print(f"Mode              : {'DRY RUN (no writes)' if args.dry_run else 'COPY'}\n")

    seen = copied = skipped = failed = 0
    total_bytes = copied_bytes = 0

    for obj in _list_gcs_objects(src_bucket, args.prefix):
        seen += 1
        key = obj["name"]
        size = obj["size"]
        total_bytes += size

        if args.dry_run:
            print(f"  would copy  {key}  ({size:,} bytes)")
            continue

        if not args.overwrite:
            existing = _r2_size(client, dst_bucket, key)
            if existing is not None and existing == size:
                skipped += 1
                continue

        tmp = Path(tempfile.mkstemp(prefix="gcs2r2-")[1])
        try:
            got_md5 = _download_gcs_object(src_bucket, key, tmp)
            if obj["md5Hash"]:
                want_md5 = base64.b64decode(obj["md5Hash"]).hex()
                if got_md5 != want_md5:
                    raise RuntimeError(
                        f"download MD5 mismatch (gcs={want_md5} got={got_md5})"
                    )
            client.upload_file(
                str(tmp),
                dst_bucket,
                key,
                ExtraArgs={
                    "ContentType": obj["contentType"],
                    "CacheControl": CACHE_CONTROL,
                },
            )
            landed = _r2_size(client, dst_bucket, key)
            if landed != size:
                raise RuntimeError(
                    f"post-upload size mismatch (gcs={size} r2={landed})"
                )
            copied += 1
            copied_bytes += size
            print(f"  copied  {key}  ({size:,} bytes)")
        except Exception as e:  # one bad object must not abort the whole run
            failed += 1
            print(f"  FAILED  {key}: {e}", file=sys.stderr)
        finally:
            tmp.unlink(missing_ok=True)

    print("\n--- summary ---")
    print(f"objects seen      : {seen}")
    print(f"total bytes       : {total_bytes:,}")
    if args.dry_run:
        gb = total_bytes / (1024**3)
        print(
            f"NOTE: a real copy pulls ~{gb:.2f} GB out of GCS once "
            f"(one-time GCS egress ~${gb * 0.12:,.2f} at $0.12/GB)."
        )
        return 0
    print(f"copied            : {copied} ({copied_bytes:,} bytes)")
    print(f"skipped (present) : {skipped}")
    print(f"failed            : {failed}")
    if failed:
        print("\nRE-RUN to retry the failures (already-copied objects are skipped).")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
