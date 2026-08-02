# Changelog

## 0.3.2 (2026-08-02)

- Refresh the bundled shared client with restartable controller delivery after a terminal wake failure.

## 0.3.1 (2026-08-02)

- Refresh the bundled shared client so eager multi-room bootstrap no longer fails a self-inflicted profile selector conflict.

## 0.3.0 (2026-08-02)

- Adopt the shared alias authority module and delete Pi's duplicated claim, lookup, and session-inventory code.
- Report the alias a session left behind, why peers holding it are stranded, and how to reclaim it (#27).
- Key profile-switch publication off explicit claim authority instead of inferring it from the alias field.
- Publish runtime snapshot schema v2 with rooms[].
- Allow a configured session alias across a live profile switch, with the pre-claim guard, publication barrier, and source retirement rules from the shared client.

## 0.2.2 (2026-08-02)

- Retain one continuous responsive-read fence through queueing and injection, updated from the authoritative response cursor scope, without letting that active read self-block bootstrap recovery.
- Surface committed-but-unavailable alias claims and recover through a fresh preparation cycle.

## 0.2.1 (2026-08-02)

- Retry transient startup bootstrap failures automatically after the server deadline without requiring a tool call.
- Fence responsive reads at request start so exact-session rows cannot cross rollover before entering the pending queue.

## 0.2.0 (2026-08-02)

- Require the 2026-08-01 wire contract and remove alias-at-mint.
- Prepare anonymous candidates, recover alias generations through bounded inventory, claim with an exact fence, and proactively roll sessions before expiry.
- Restart the Pi wake watcher after proactive swaps, drain immediately, and report server-selected cursor scope and exact-session continuity limits.
