---
name: Published URL handling
description: Durable guidance for public links and generated Replit domains.
---

Shared links should use the current page URL, while production metadata and diagnostics should use the deployment service's verified primary URL. Generated Replit hostnames can change between deployments or artifacts.

**Why:** A stale generated hostname caused the in-app browser button and social preview metadata to point to an unreachable page even though the current deployment was healthy.

**How to apply:** Never construct or reuse a production hostname from memory. Use the current browser URL for share/open actions and query deployment metadata when a verified public URL is needed.