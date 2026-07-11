# Security policy

## Scope

This project is a local desktop tool — it binds only to `127.0.0.1` by default and is not designed to be exposed to the internet. The primary security concern is protection of MT5 credentials stored in settings.

## Supported versions

Only the latest release tag is supported.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Send a brief description to **ghafarijalal624@gmail.com** with:
- What the vulnerability is and how to reproduce it
- Which version you found it on
- Whether you have a proposed fix

You should receive a response within a few days. If the issue is confirmed, a fix will be released and you'll be credited in the release notes (unless you prefer otherwise).

## Known limitations

- The web server binds to `127.0.0.1:8420` with no authentication. Do not expose it through a reverse proxy or firewall rule without adding auth.
- MT5 account credentials are stored in `settings.json` under the app data directory. Keep that directory private.
