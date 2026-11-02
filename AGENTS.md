# Done List agent notes

## Working conventions

- Always develop at `http://127.0.0.1:5173/`: `pnpm dev --host 127.0.0.1 --port 5173 --strictPort`. Do not change the hostname or port without the user's request.
- Boolean fields and variables use the `is` prefix. Renames should be complete, without compatibility aliases unless requested.
- Keep this file's changes out of commits unless requested; do not change its tracking, ignore rules, or staging. Keep project-specific deployment notes here, not in README.
- After visible UI changes, embed an updated screenshot in the final reply. Use isolated test data for account previews and remove temporary preview sources afterward.
- Do not clear real browser data, reset sync progress, or alter remote database/Auth/SMTP settings merely to test; obtain separate authorization.
- Do not recreate removed historical cloud migration files unless requested.

## External environment mapping

| Usage | Supabase project | Configuration |
| --- | --- | --- |
| Local development / Vercel Preview | `donelist-dev` (`zkasxskeqpwccbxscnia`) | `.env.development.local` / Vercel Preview variables |
| Local production build / Vercel Production | `donelist` (`zsrhqpaoddajuvomzigp`) | `.env.production.local` / Vercel Production variables |

- Vercel Preview also uses production build mode: select the project through deployment variables, not `import.meta.env.PROD`. Do not put project values in shared `.env.local`.
- Intended Auth callback targets: production `https://donelist.thec.me` only; development `http://127.0.0.1:5173` plus explicitly approved preview domains. Verify the dashboard rather than assuming these targets are configured.
- Last reported email setup: production uses Resend Custom SMTP; development uses Supabase's default sender. Recheck the dashboard before relying on this; do not assume default-mail delivery limits or alias support.
