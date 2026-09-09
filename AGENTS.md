# Project agent guidance

## Cloudflare access in Amp orbs

- Cloudflare read and deployment access is expected to be available from the project owner's Amp personal secrets.
- The personal token is named `CLOUDFLARE_WORKERS_TOKEN`; Wrangler expects `CLOUDFLARE_API_TOKEN`. `.agents/setup` maps the former to the latter in orb login shells without persisting the value.
- `CLOUDFLARE_ACCOUNT_ID` is also supplied as a personal environment variable.
- Run Wrangler as `.agents/wrangler <arguments>` in orbs. The wrapper performs the token-name mapping even when a shell does not load `.bash_profile`.
- If neither token variable is present, verify configured names with `amp secrets list --user` and run `amp orb restart-processes` to refresh secret injection. Never print secret values.
- Use Wrangler's `--remote` flag only for intentional production reads or changes. Production writes still require explicit user approval.
