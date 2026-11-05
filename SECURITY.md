# Security

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's **Security** tab, using **Report a vulnerability**. Don't open a public issue. Include the steps to reproduce and what an attacker could do.

## How noax is protected

- **Publishing** happens only on the MCP hostname, behind Cloudflare Access Service Auth. The Worker also verifies the Access JWT's signature, issuer, audience and expiry itself, so a misconfigured Access policy alone doesn't open it.
- **Public routes** are read-only and never dispatch MCP operations.
- **The Worker holds no Cloudflare API token.** The provisioning token is only used from your machine, and can be deleted after setup.
- **Credentials** stay in the ignored `.local/` directory. MCP client configs are generated next to them, so a clone can't send your credentials to a hostname you didn't configure.
- **Post HTML** comes only from the Markdown renderer, with raw HTML and images disabled. Pages ship no JavaScript and use a strict Content Security Policy.
- **Database access** uses prepared statements throughout.

## In scope

Anything that lets someone publish, edit or delete posts without the service token, run script on a public page, or obtain credentials. Exhausting a free-plan quota is a known limit rather than a vulnerability; see [Costs](README.md#costs).
