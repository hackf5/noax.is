# Security

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's **Security** tab, using **Report a vulnerability**. Don't open a public issue. Include the steps to reproduce and what an attacker could do.

## How noax is protected

- **Publishing** happens only on the MCP hostname, behind Cloudflare Access Service Auth. The Worker also verifies the Access JWT's signature, issuer, audience and expiry itself, so a misconfigured Access policy alone doesn't open it.
- **Public routes** are read-only and never dispatch MCP operations.
- **Provisioning credentials** stay on the setup machine and can be deleted after setup. Optional analytics uses a dedicated Worker secret with **Zone → Analytics → Read** for the blog's zone. The report runs a fixed query for aggregate counts through the private MCP.
- **Credentials** stay in the ignored `.local/` directory. MCP client configs are generated next to them, so a clone can't send your credentials to a hostname you didn't configure.
- **Post HTML** comes from the Markdown renderer, which escapes raw HTML. Pages use a strict Content Security Policy. HTML allows same-origin scripts and connections and supports a per-response script nonce for Cloudflare's injected script. Files-enabled pages also allow images from the configured R2 media origin.
- **File uploads** require the publishing credential and accept checksum-verified raster images. The optional bucket's media URLs are public from upload and carry immutable cache headers. The file API checks post references and the file version before deletion. Cached copies can remain after deletion. [File setup and use](README.md#choose-file-support)
- **Database access** uses prepared statements throughout.

## In scope

Anything that lets someone publish, edit or delete posts or files without the service token, run script on a public page, or obtain credentials. For quota behavior, see [Costs](README.md#costs).
