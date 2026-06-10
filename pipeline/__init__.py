"""LoreWire content pipeline.

Stages: scrape -> idea -> research (anti-fabrication) -> article -> store.
Logic is adapted from Amir's reference scripts (kept local in /from-amir);
the plumbing is rebuilt: secrets come from the environment, output goes to a
storage layer (SQLite locally, Cloud SQL Postgres in production).

Run a dry run (no keys, offline, uses fixtures):
    python -m pipeline.run --dry-run
"""
