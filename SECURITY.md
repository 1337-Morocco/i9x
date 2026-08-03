# Security policy

## Reporting a vulnerability

Please **do not open a public issue.** Use GitHub's private reporting:

**[Report a vulnerability](https://github.com/1337-Morocco/i9x/security/advisories/new)**

If private reporting is unavailable, email the maintainer listed on the GitHub
profile instead. Expect an acknowledgement within a few days.

Useful to include: the version (`i9x-update --check`), how the panel is exposed,
and what an attacker gains.

## Supported versions

The latest release only. i9x is a single-maintainer project; there are no
backported fixes.

## Threat model

Worth being explicit, because it affects what counts as a vulnerability.

**i9x is a root control panel.** Anyone with a panel login can run arbitrary
commands as the service user, read and write any file it can reach, and start
containers. That is the product, not a flaw. Reports amounting to "an
authenticated admin can run commands" are working as designed.

What *is* in scope:

- Authentication or session bypass — anything reachable without a valid login
- Privilege escalation across the token boundary: API tokens are scoped
  `read`/`write`, stored hashed, and must not be able to open a shell (`/ws`
  requires a session) or mint further tokens
- Cross-tenant leakage between panel accounts
- Injection into generated configs — a domain or app name that escapes into the
  nginx vhost or a container's run arguments
- Path traversal in the filesystem API reaching outside intended roots
- Anything that makes the update channel install an attacker-controlled package

## Deployment notes

The backend binds to `127.0.0.1` by default. `packaging/get.sh` can front it
with nginx over TLS on a public port — that is opt-out (`--no-expose`), and it
prints a warning, because it puts a root control panel on the internet.

If you expose it:

- Use a long, unique admin password
- Restrict by source address:
  `sudo ufw allow from <your.ip> to any port 5633 proto tcp`
- Prefer a real certificate over the generated self-signed one
