# Security

Please report a vulnerability privately, not in a public issue: use **Report a vulnerability** on the repository's Security tab. The report stays between you and the maintainer until a fix is out.

Useful to include: what you ran, the version (`toyon version`), your platform, and the smallest steps that show the problem.

## What counts

Toyon runs coding agents on your machine and serves your app through a local daemon, so these matter most:

- Reaching the daemon without its token, or from a host or peer it should refuse, locally or through `toyon remote` and `toyon deploy fly`.
- An agent writing outside its own copy of the project, widening its own sandbox, or reading secrets it is meant not to see.
- A page in a preview reaching the shell, the daemon, or another project's preview.
- A client-supplied path reaching outside the project it names.

The limits already written in the README's Trust section, such as the push deny list being a command filter rather than a wall, are known. A way around them that goes further than the README says is still worth a report.

## Versions

Toyon is pre-alpha. Fixes go into the latest release only.
